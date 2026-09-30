import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appDatabase } from '@/services/appDatabase';
import * as storage from '@/services/db';
import type { LocalSong } from '@/types';

// test/unit/localLibrary/localSongLyricsStorage.test.ts
// 歌词来源修改只操作指定歌曲，保留元数据、实体分配和待迁移封面。

const song = (id: string): LocalSong => ({
    id, fileName: `${id}.flac`, filePath: `Music/${id}.flac`, title: id,
    titleOrigin: 'import', importedMetadata: { title: id, titleSource: 'filename', artistNames: [] },
    duration: 1000, fileSize: 1, mimeType: 'audio/flac', addedAt: 1,
});

describe('single-song lyric storage', () => {
    beforeEach(async () => { await appDatabase.delete(); await appDatabase.open(); });
    afterEach(async () => { vi.restoreAllMocks(); await appDatabase.delete(); });

    it('changes only the selected source without scanning or rewriting library assignments', async () => {
        const original = { ...song('one'), embeddedCover: new Blob(['legacy-cover']) };
        await appDatabase.local_music.bulkPut([original, song('two')]);
        const assignments = await appDatabase.local_library_assignments.toArray();
        const readAll = vi.spyOn(appDatabase.local_music, 'toArray');
        const writeAssignments = vi.spyOn(appDatabase.local_library_assignments, 'bulkPut');

        const updated = await storage.saveLocalSongLyricsSource('one', 'embedded');

        expect(updated?.lyricsSource).toBe('embedded');
        expect(updated).not.toHaveProperty('embeddedCover');
        expect(await appDatabase.local_music.get('one')).toEqual({ ...original, lyricsSource: 'embedded' });
        expect(await appDatabase.local_music.get('two')).toEqual(song('two'));
        expect(await appDatabase.local_library_assignments.toArray()).toEqual(assignments);
        expect(readAll).not.toHaveBeenCalled();
        expect(writeAssignments).not.toHaveBeenCalled();
    });

    it('normalizes a single legacy record and persists lyric render hints', async () => {
        await appDatabase.local_music.put({
            ...song('legacy'), embeddedCover: { broken: true },
            matchedLyrics: { isWordByWord: false, lines: [{
                fullText: 'Line', startTime: 0, endTime: 2, words: [{ text: 'Line', startTime: 0, endTime: 2 }],
            }] },
        } as LocalSong);
        const readAll = vi.spyOn(appDatabase.local_music, 'toArray');

        const loaded = await storage.getLocalSong('legacy');

        expect(loaded).not.toHaveProperty('embeddedCover');
        expect(loaded?.matchedLyrics?.lines[0].renderHints).toEqual(expect.objectContaining({
            timingClass: 'normal', lineTransitionMode: 'normal',
        }));
        const persisted = await appDatabase.local_music.get('legacy');
        expect(persisted).not.toHaveProperty('embeddedCover');
        expect(persisted?.matchedLyrics).toEqual(loaded?.matchedLyrics);
        expect(readAll).not.toHaveBeenCalled();
    });

    it('persists simultaneous source changes in invocation order', async () => {
        await appDatabase.local_music.put(song('one'));
        await Promise.all([
            storage.saveLocalSongLyricsSource('one', 'local'),
            storage.saveLocalSongLyricsSource('one', 'online'),
            storage.saveLocalSongLyricsSource('one', 'embedded'),
        ]);
        expect((await storage.getLocalSong('one'))?.lyricsSource).toBe('embedded');
    });

    it('does not recreate a deleted song when changing its source', async () => {
        await expect(storage.saveLocalSongLyricsSource('missing', 'local')).resolves.toBeUndefined();
        expect(await appDatabase.local_music.count()).toBe(0);
    });
});
