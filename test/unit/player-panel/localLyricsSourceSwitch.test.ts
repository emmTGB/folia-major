// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useLibraryPlaybackController } from '@/hooks/useLibraryPlaybackController';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import LocalTab from '@/components/panelTab/LocalTab';
import { resolveLocalSongLyrics, type ResolvedLocalSongLyrics } from '@/utils/lyrics/localSongLyrics';
import type { LocalSong, SongResult } from '@/types';
import { loadCachedOrFetchCover } from '@/services/coverCache';
import { registerCoverObjectUrl } from '@/services/coverObjectUrls';

// test/unit/player-panel/localLyricsSourceSwitch.test.ts
// 面板切换不刷新整库，并在解析乱序或切歌后忽略旧结果。

const env = vi.hoisted(() => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => { entries.set(key, String(value)); },
            removeItem: (key: string) => { entries.delete(key); },
        },
    });
    return { songs: [] as LocalSong[], getAll: vi.fn(), saveAll: vi.fn() };
});

vi.mock('@/services/db', () => ({
    getFromCache: async () => null, getFromCacheWithMigration: async () => null,
    saveToCache: async () => {}, removeFromCache: async () => {},
    getCacheEntriesByPrefix: async () => [], getSessionData: async () => ({}),
    getLocalSongs: async () => { env.getAll(); return env.songs; },
    getLocalSong: async (id: string) => env.songs.find(song => song.id === id),
    saveLocalSong: async (song: LocalSong) => {
        env.saveAll(); env.songs = env.songs.map(previous => previous.id === song.id ? song : previous);
    },
    saveLocalSongLyricsSource: async (id: string, source: LocalSong['lyricsSource']) => {
        env.songs = env.songs.map(song => song.id === id ? { ...song, lyricsSource: source } : song);
        return env.songs.find(song => song.id === id);
    },
}));
vi.mock('@/services/coverCache', () => ({ loadCachedOrFetchCover: vi.fn(), getCachedCoverUrl: async () => null }));
vi.mock('@/utils/lyrics/localSongLyrics', () => ({ resolveLocalSongLyrics: vi.fn() }));
vi.mock('@/services/localMusicService', () => ({
    getAudioFromLocalSong: async () => 'blob:local-test',
    ensureLocalSongCoverAsset: async (song: LocalSong) => song,
}));
vi.mock('@/services/localLibraryEntityRepository', () => ({
    getLocalLibraryCatalogSnapshot: async () => ({ entities: [], assignments: [] }),
}));

const record: LocalSong = {
    id: 'one', fileName: 'one.flac', filePath: 'Music/one.flac', title: 'One', titleOrigin: 'import',
    importedMetadata: { title: 'One', titleSource: 'filename', artistNames: [] },
    duration: 1000, fileSize: 1, mimeType: 'audio/flac', addedAt: 1,
    noAutoMatch: true,
};
const playing = (id = 'one'): SongResult => ({
    id, name: id, artists: [], album: { id: 0, name: '' }, durationMs: 1000,
    isLocal: true, localRef: { songId: id },
} as SongResult);

describe('local lyric source switching', () => {
    let root: Root;
    let controller: ReturnType<typeof useLibraryPlaybackController>;
    const setLyrics = vi.fn();

    beforeEach(async () => {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        vi.clearAllMocks();
        env.songs = [record];
        usePlaybackStore.setState({ currentSong: playing(), activeLocalLyricsSource: null });
        vi.mocked(resolveLocalSongLyrics).mockReset().mockImplementation(async song => ({
            lyrics: { lines: [], isWordByWord: false }, source: song.lyricsSource ?? null,
        }));
        const Probe = () => {
            const blob = useRef<string | null>(null);
            const autoplay = useRef(false);
            const songKey = useRef<string | number | null>('local:one');
            const fetchedAt = useRef<number | null>(null);
            controller = useLibraryPlaybackController({
                likedSongIds: new Set(), setLyrics, setIsLyricsLoading: () => {}, setLikedSongIds: () => {},
                navigateToPlaybackView: () => {}, persistLastPlaybackCache: async () => {},
                restoreCachedThemeForSong: async () => {}, interruptStagePlaybackForMainTransition: () => null,
                blobUrlRef: blob, shouldAutoPlayRef: autoplay, currentSongRef: songKey,
                currentOnlineAudioUrlFetchedAtRef: fetchedAt,
            });
            return React.createElement(LocalTab, {
                currentSong: usePlaybackStore.getState().currentSong as React.ComponentProps<typeof LocalTab>['currentSong'],
                onMatchOnline: () => {}, onUpdateLocalLyrics: () => {},
                onChangeLyricsSource: controller.handleChangeLyricsSource,
                replayGainMode: 'off', onChangeReplayGainMode: () => {},
                lyricTimelineOffsetMs: 0, onLyricTimelineOffsetChange: () => {}, isDaylight: false,
            });
        };
        root = createRoot(document.createElement('div'));
        await act(async () => { root.render(React.createElement(Probe)); });
        await act(async () => { await controller.loadLocalSongs(); });
        env.getAll.mockClear();
    });
    afterEach(async () => { await act(async () => { root.unmount(); }); });

    it('updates the source without reloading the library or reassigning metadata', async () => {
        const library = controller.localSongs;
        await act(async () => { await controller.handleChangeLyricsSource('embedded'); });

        expect(env.songs[0].lyricsSource).toBe('embedded');
        expect(usePlaybackStore.getState().activeLocalLyricsSource).toBe('embedded');
        expect(controller.localSongs).toBe(library);
        expect(env.getAll).not.toHaveBeenCalled();
        expect(env.saveAll).not.toHaveBeenCalled();
    });

    it('keeps the last selection when an earlier parse finishes later', async () => {
        let finishFirst!: (value: ResolvedLocalSongLyrics) => void;
        vi.mocked(resolveLocalSongLyrics).mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
        let first!: Promise<void>;
        await act(async () => { first = controller.handleChangeLyricsSource('local'); });
        expect(resolveLocalSongLyrics).toHaveBeenCalledTimes(1);
        await act(async () => { await controller.handleChangeLyricsSource('embedded'); });
        setLyrics.mockClear();
        await act(async () => { finishFirst({ lyrics: null, source: 'local' }); await first; });

        expect(env.songs[0].lyricsSource).toBe('embedded');
        expect(usePlaybackStore.getState().activeLocalLyricsSource).toBe('embedded');
        expect(setLyrics).not.toHaveBeenCalled();
    });

    it('discards a parse after switching away and back to the same song', async () => {
        let finish!: (value: ResolvedLocalSongLyrics) => void;
        vi.mocked(resolveLocalSongLyrics).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        let pending!: Promise<void>;
        await act(async () => { pending = controller.handleChangeLyricsSource('local'); });
        await act(async () => {
            usePlaybackStore.getState().setCurrentSong(playing('two'));
            usePlaybackStore.getState().setCurrentSong(playing());
        });
        setLyrics.mockClear();
        await act(async () => { finish({ lyrics: null, source: 'local' }); await pending; });

        expect(setLyrics).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().activeLocalLyricsSource).toBeNull();
    });

    it('uses the saved source when replaying a song from the unchanged library snapshot', async () => {
        const cachedSong = controller.localSongs[0];
        await act(async () => { await controller.handleChangeLyricsSource('embedded'); });
        vi.mocked(resolveLocalSongLyrics).mockClear();
        await act(async () => { await controller.onPlayLocalSong(cachedSong); });

        expect(resolveLocalSongLyrics).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'one', lyricsSource: 'embedded' }), expect.any(String),
        );
        expect(usePlaybackStore.getState().activeLocalLyricsSource).toBe('embedded');
    });

    it('uses the saved source for lyric previews without refreshing the library', async () => {
        await act(async () => { await controller.handleChangeLyricsSource('embedded'); });
        vi.mocked(resolveLocalSongLyrics).mockClear();
        await controller.loadCurrentSongLyricPreview();

        expect(resolveLocalSongLyrics).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'one', lyricsSource: 'embedded' }), expect.any(String),
        );
        expect(env.getAll).not.toHaveBeenCalled();
    });

    it('keeps a manual selection when the playback background parse finishes later', async () => {
        let finish!: (value: ResolvedLocalSongLyrics) => void;
        vi.mocked(resolveLocalSongLyrics)
            .mockResolvedValueOnce({ lyrics: null, source: 'local' })
            .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await act(async () => { await controller.onPlayLocalSong(controller.localSongs[0]); });
        expect(resolveLocalSongLyrics).toHaveBeenCalledTimes(2);
        await act(async () => { await controller.handleChangeLyricsSource('embedded'); });
        setLyrics.mockClear();
        await act(async () => { finish({ lyrics: null, source: 'local' }); });

        expect(setLyrics).not.toHaveBeenCalled();
        expect(usePlaybackStore.getState().activeLocalLyricsSource).toBe('embedded');
    });
    it.each(['switch away and back', 'unmount'])('releases a late local cover after %s', async scenario => {
        let finish!: (url: string) => void;
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.mocked(loadCachedOrFetchCover).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const covered = { ...record, useOnlineCover: true, onlineMetadata: { coverUrl: 'https://example.com/cover' } } as LocalSong;
        env.songs = [covered];
        await act(async () => { await controller.onPlayLocalSong(covered); });
        expect(loadCachedOrFetchCover).toHaveBeenCalled();
        if (scenario === 'unmount') {
            await act(async () => { root.unmount(); });
        } else {
            await act(async () => {
                usePlaybackStore.getState().setCurrentSong(playing('two'));
                usePlaybackStore.getState().setCurrentSong(playing());
            });
        }
        const url = registerCoverObjectUrl(`blob:late-local-${scenario}`)!;
        await act(async () => { finish(url); });
        expect(usePlaybackStore.getState().cachedCoverUrl).not.toBe(url);
        expect(revoke).toHaveBeenCalledWith(url);
        revoke.mockRestore();
    });

});
