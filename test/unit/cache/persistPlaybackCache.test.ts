import { beforeEach, describe, expect, it, vi } from 'vitest';
import { persistPlaybackCache } from '@/components/app/playback/persistPlaybackCache';
import { saveToCache } from '@/services/db';
import { getPlaybackQueueCacheRevision, writePlaybackQueueCache } from '@/services/repositories/cacheRepository';
import type { SongResult } from '@/types';

// test/unit/cache/persistPlaybackCache.test.ts

vi.mock('@/services/db', () => ({
    saveToCache: vi.fn(),
}));
const cache = vi.hoisted(() => ({ revision: 0 }));
vi.mock('@/services/repositories/cacheRepository', () => ({
    getPlaybackQueueCacheRevision: vi.fn(() => cache.revision),
    writePlaybackQueueCache: vi.fn(async () => ++cache.revision),
}));

const song = (id: number, name: string, patch: Partial<SongResult> = {}): SongResult => ({
    id,
    name,
    artists: [],
    album: { id: 1, name: 'Album' },
    durationMs: 1000,
    ...patch,
});

describe('persistPlaybackCache', () => {
    beforeEach(() => {
        vi.mocked(saveToCache).mockReset();
        vi.mocked(saveToCache).mockResolvedValue(undefined);
        vi.mocked(writePlaybackQueueCache).mockReset();
        vi.mocked(writePlaybackQueueCache).mockImplementation(async () => ++cache.revision);
    });

    it('persists a mixed-source queue without discarding local or Navidrome entries', async () => {
        const netease = song(1, 'NetEase');
        const local = song(-1, 'Local', {
            isLocal: true,
            localRef: { songId: 'local-1' },
        } as Partial<SongResult>);
        const navidrome = song(-1, 'Navidrome', {
            isNavidrome: true,
            navidromeData: {
                id: 'navi-1',
                streamUrl: 'https://example.com/navi-1',
                albumId: 'album-1',
                artistId: 'artist-1',
                path: 'navi-1.flac',
                suffix: 'flac',
            },
        } as Partial<SongResult>);

        await persistPlaybackCache(local, [netease, local, navidrome]);

        expect(writePlaybackQueueCache).toHaveBeenCalledWith([
            expect.objectContaining(netease),
            expect.objectContaining({
                isLocal: true,
                localRef: { songId: 'local-1' },
            }),
            expect.objectContaining(navidrome),
        ]);
    });

    it('saves an unchanged 10,000-song queue once while updating the current song on every jump', async () => {
        const queue = Array.from({ length: 10_000 }, (_, index) => song(index, `Song ${index}`));
        await persistPlaybackCache(queue[0], queue);
        await persistPlaybackCache(queue[9999], queue);
        expect(writePlaybackQueueCache).toHaveBeenCalledTimes(1);
        expect(saveToCache).toHaveBeenCalledTimes(2);
        expect(saveToCache).toHaveBeenLastCalledWith('last_song', expect.objectContaining(queue[9999]));
    });

    it('writes reordered or updated queues and retries after external cache invalidation', async () => {
        const queue = [song(1, 'One'), song(2, 'Two')];
        await persistPlaybackCache(queue[0], queue);
        const reordered = [...queue].reverse();
        await persistPlaybackCache(reordered[0], reordered);
        const updated = [{ ...reordered[0], name: 'New title' }, reordered[1]];
        await persistPlaybackCache(updated[0], updated);
        cache.revision += 1;
        await persistPlaybackCache(updated[1], updated);
        expect(writePlaybackQueueCache).toHaveBeenCalledTimes(4);
        expect(getPlaybackQueueCacheRevision).toHaveBeenCalled();
    });

    it('coalesces an in-flight queue write and serializes a newer order behind it', async () => {
        let finish!: (revision: number) => void;
        vi.mocked(writePlaybackQueueCache).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const queue = [song(1, 'One'), song(2, 'Two')];
        const first = persistPlaybackCache(queue[0], queue);
        const repeated = persistPlaybackCache(queue[1], queue);
        const next = persistPlaybackCache(queue[1], [...queue].reverse());
        await vi.waitFor(() => expect(writePlaybackQueueCache).toHaveBeenCalledTimes(1));
        finish(++cache.revision);
        await Promise.all([first, repeated, next]);
        expect(writePlaybackQueueCache).toHaveBeenCalledTimes(2);
        expect((vi.mocked(writePlaybackQueueCache).mock.calls[1][0] as SongResult[]).map(item => item.id)).toEqual([2, 1]);
    });

    it('retries a failed write without blocking later writes', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(writePlaybackQueueCache).mockRejectedValueOnce(new Error('disk full'));
        const queue = [song(1, 'One')];
        await persistPlaybackCache(queue[0], queue);
        await persistPlaybackCache(queue[0], queue);
        expect(writePlaybackQueueCache).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });

    it('keeps a newer queued write coalesced when the older write fails', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        let fail!: (error: Error) => void;
        vi.mocked(writePlaybackQueueCache).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
        const firstQueue = [song(1, 'One')];
        const newerQueue = [song(2, 'Two')];
        const first = persistPlaybackCache(firstQueue[0], firstQueue);
        const newer = persistPlaybackCache(newerQueue[0], newerQueue);
        await vi.waitFor(() => expect(writePlaybackQueueCache).toHaveBeenCalledTimes(1));
        fail(new Error('old write failed'));
        const repeated = persistPlaybackCache(newerQueue[0], newerQueue);
        await Promise.all([first, newer, repeated]);
        expect(writePlaybackQueueCache).toHaveBeenCalledTimes(2);
        await persistPlaybackCache(newerQueue[0], newerQueue);
        expect(writePlaybackQueueCache).toHaveBeenCalledTimes(2);
        log.mockRestore();
    });
    it('retains only the latest pending snapshot during 100 changes of a 10,000-song queue', async () => {
        let release!: (revision: number) => void;
        vi.mocked(writePlaybackQueueCache).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const queue = Array.from({ length: 10_000 }, (_, index) => song(index, 'Song ' + index));
        const first = persistPlaybackCache(queue[0], queue);
        await vi.waitFor(() => expect(writePlaybackQueueCache).toHaveBeenCalledTimes(1));
        const pending: Promise<void>[] = [];
        let latest = queue;
        for (let i = 0; i < 100; i++) {
            latest = [...queue.slice(i + 1), ...queue.slice(0, i + 1)];
            pending.push(persistPlaybackCache(latest[0], latest));
        }
        let lastSettled = false;
        void pending[pending.length - 1].then(() => { lastSettled = true; });
        await Promise.resolve();
        expect(lastSettled).toBe(false);
        release(++cache.revision);
        await Promise.all([first, ...pending]);
        expect(writePlaybackQueueCache).toHaveBeenCalledTimes(2);
        expect((vi.mocked(writePlaybackQueueCache).mock.calls[1][0] as SongResult[])[0].id).toBe(latest[0].id);
    });

});
