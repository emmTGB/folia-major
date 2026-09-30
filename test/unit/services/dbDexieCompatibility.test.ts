import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    appDatabase,
    LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY,
    LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY,
} from '../../../src/services/appDatabase';
import {
    clearCache,
    getCacheEntriesByPrefix,
    getCacheKeysByPrefix,
    getFromCache,
    removeCacheEntriesByPrefix,
    removeFromCache,
    saveToCache,
} from '../../../src/services/db';
import { getPlaybackQueueCacheRevision, writePlaybackQueueCache } from '../../../src/services/repositories/cacheRepository';
import { persistPlaybackCache } from '../../../src/components/app/playback/persistPlaybackCache';
import type { SongResult } from '../../../src/types';

// test/unit/services/dbDexieCompatibility.test.ts
// Verifies cache routing, legacy fallback migration, prefix APIs, and selective cleanup through Dexie.

describe('db Dexie compatibility facade', () => {
    it('restores an unchanged playback queue after removal, clearing, or an external overwrite', async () => {
        const queue: SongResult[] = [{
            id: 1, name: 'One', artists: [], album: { id: 1, name: 'Album' }, durationMs: 1000,
            sourceRef: { kind: 'online', providerId: 'netease', mediaId: '1' },
        }];
        await persistPlaybackCache(queue[0], queue);
        const savedRevision = getPlaybackQueueCacheRevision();
        await persistPlaybackCache(queue[0], queue);
        expect(getPlaybackQueueCacheRevision()).toBe(savedRevision);
        await clearCache(['last_queue']);
        expect(getPlaybackQueueCacheRevision()).toBe(savedRevision);
        for (const invalidate of [
            () => removeFromCache('last_queue'),
            () => clearCache(),
            () => saveToCache('last_queue', []),
            () => removeCacheEntriesByPrefix(['last_']),
        ]) {
            await invalidate();
            await persistPlaybackCache(queue[0], queue);
            expect(await getFromCache('last_queue')).toEqual(queue);
        }
        const receipt = await writePlaybackQueueCache(queue);
        expect(receipt).toBe(getPlaybackQueueCacheRevision());
        expect((await appDatabase.api_cache.get('last_queue'))?.timestamp).toBeGreaterThan(0);
    });

    beforeEach(async () => {
        await appDatabase.delete();
        await appDatabase.open();
    });

    afterEach(async () => {
        await appDatabase.delete();
    });

    it('routes cache values and migrates legacy user entries atomically', async () => {
        await appDatabase.api_cache.put({ key: 'user_profile', data: { userId: 9 }, timestamp: 1 });
        await expect(getFromCache('user_profile')).resolves.toEqual({ userId: 9 });
        expect(await appDatabase.user_cache.get('user_profile')).toMatchObject({ data: { userId: 9 } });
        expect(await appDatabase.api_cache.get('user_profile')).toBeUndefined();
    });

    it('scans and removes multiple prefixes across routed tables', async () => {
        await saveToCache('playlist_tracks_1', [1]);
        await saveToCache('playlist_detail_1', { id: 1 });
        await saveToCache('cover_1', new Blob(['cover']));

        expect(await getCacheKeysByPrefix(['playlist_tracks_', 'playlist_detail_'])).toEqual(expect.arrayContaining([
            'playlist_tracks_1',
            'playlist_detail_1',
        ]));
        expect(await getCacheEntriesByPrefix('playlist_')).toHaveLength(2);

        await removeCacheEntriesByPrefix(['playlist_tracks_', 'playlist_detail_']);
        expect(await getCacheKeysByPrefix(['playlist_'])).toEqual([]);
        expect(await getFromCache('cover_1')).toBeInstanceOf(Blob);
    });

    it('preserves requested keys during a full cache cleanup', async () => {
        await saveToCache('last_song', { id: 1 });
        await saveToCache('theme_1', { name: 'theme' });
        await appDatabase.api_cache.put({
            key: LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY,
            data: { completedAt: 1 },
            timestamp: 1,
        });
        await appDatabase.api_cache.put({
            key: LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY,
            data: { completedAt: 1 },
            timestamp: 1,
        });
        await clearCache(['last_song']);
        expect(await getFromCache('last_song')).toEqual({ id: 1 });
        expect(await getFromCache('theme_1')).toBeNull();
        expect(await appDatabase.api_cache.get(LOCAL_LIBRARY_BOOTSTRAP_MARKER_KEY)).toBeTruthy();
        expect(await appDatabase.api_cache.get(LOCAL_LIBRARY_ARTIST_SPLIT_MARKER_KEY)).toBeTruthy();
    });
});
