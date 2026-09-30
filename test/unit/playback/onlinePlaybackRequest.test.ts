// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePlaybackQueueController } from '@/hooks/usePlaybackQueueController';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import type { SongResult } from '@/types';
import { retireBlobUrl } from '@/services/playbackBlobUrls';
import { registerCoverObjectUrl } from '@/services/coverObjectUrls';

// test/unit/playback/onlinePlaybackRequest.test.ts
// 控制异步加载顺序，验证过期请求释放临时 URL，并保留新请求已接管的资源。

const env = vi.hoisted(() => ({
    audio: vi.fn(), cover: vi.fn(), state: vi.fn(), lyrics: vi.fn(),
    beforePlay: vi.fn(), hasBeforePlay: vi.fn(), prefetch: vi.fn(),
}));
vi.mock('@/services/onlinePlayback', () => ({
    loadOnlineSongAudioSource: env.audio, loadOnlineSongLyrics: env.lyrics,
    applyOnlineAudioSourceMetadata: (song: SongResult) => song,
}));
vi.mock('@/services/onlineMusic/resourceCache', () => ({
    getCachedSongCoverUrl: async (...args: unknown[]) => registerCoverObjectUrl(await env.cover(...args)), hasCachedSongAudio: async () => true,
}));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: { canPlaySong: () => true } }));
vi.mock('@/services/onlineMusic/songAvailability', () => ({
    isSongUnavailable: () => false, getSongReplacement: async () => null,
}));
vi.mock('@/services/prefetchService', () => ({
    getPrefetchedData: () => null, prefetchNearbySongs: env.prefetch, invalidateAndRefetch: vi.fn(),
}));
vi.mock('@/utils/onlineLyricsState', () => ({ loadOnlineLyricsState: env.state }));
vi.mock('@/services/hostExtensionHooks', () => ({
    hasBeforePlayHook: env.hasBeforePlay, runBeforePlayHook: env.beforePlay,
}));
vi.mock('react-i18next', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react-i18next')>()),
    useTranslation: () => ({ t: (key: string) => key }),
}));

const song = (id: string): SongResult => ({
    id, name: id, artists: [], album: { id: 0, name: '' }, durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: id },
});
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    return { promise, resolve, reject };
};

describe('online playback request resources', () => {
    let root: Root;
    let controller: ReturnType<typeof usePlaybackQueueController>;
    let params: Parameters<typeof usePlaybackQueueController>[0];
    const revoke = vi.fn();
    let audioSequence: number;
    let coverSequence: number;

    beforeEach(async () => {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        vi.resetAllMocks();
        vi.stubGlobal('URL', class extends URL { static revokeObjectURL = revoke; });
        retireBlobUrl(null);
        revoke.mockClear();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        audioSequence = 0;
        coverSequence = 0;
        env.audio.mockImplementation(async () => {
            const url = `blob:audio-${++audioSequence}`;
            return { kind: 'ok', audioSrc: url, blobUrl: url };
        });
        env.cover.mockImplementation(async () => `blob:cover-${++coverSequence}`);
        env.state.mockResolvedValue(null);
        env.lyrics.mockResolvedValue(undefined);
        env.hasBeforePlay.mockReturnValue(false);
        usePlaybackStore.setState({ currentSong: null, audioSrc: null, cachedCoverUrl: null, playQueue: [], isFmMode: false });
        params = {
            isNowPlayingStageActive: false, shouldNavigateToPlayerOnTrackChange: false,
            localSongs: [], localLibraryCatalog: { entities: [], assignments: [] },
            setLyrics: vi.fn(), setIsLyricsLoading: vi.fn(), navigateToPlaybackView: vi.fn(),
            navigateToSearch: vi.fn(), persistLastPlaybackCache: vi.fn(async () => {}),
            restoreCachedThemeForSong: vi.fn(async () => {}), interruptStagePlaybackForMainTransition: vi.fn(),
            onPlayLocalSong: vi.fn(async () => {}), onPlayNavidromeSong: vi.fn(async () => {}),
            onAddLocalSongToQueue: vi.fn(), onAddNavidromeSongsToQueue: vi.fn(),
            searchDeps: { submitSearch: vi.fn(async () => true), loadMoreSearchResults: vi.fn(async () => {}) },
            audioRef: { current: null }, blobUrlRef: { current: null }, shouldAutoPlayRef: { current: false },
            currentSongRef: { current: null }, mainPlaybackSnapshotRef: { current: null },
            playbackAutoSkipCountRef: { current: 0 }, pendingResumeTimeRef: { current: null },
            currentOnlineAudioUrlFetchedAtRef: { current: null }, lastAudioRecoverySourceRef: { current: null },
        };
        const Probe = () => { controller = usePlaybackQueueController(params); return null; };
        root = createRoot(document.createElement('div'));
        await act(async () => { root.render(React.createElement(Probe)); });
    });
    afterEach(async () => {
        await act(async () => { root.unmount(); });
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('releases unclaimed audio and cover when an older cover request finishes after a new song', async () => {
        const cover = deferred<string>();
        env.cover.mockReturnValueOnce(cover.promise);
        let first!: Promise<void>;
        await act(async () => { first = controller.playSong(song('A')); });
        expect(env.cover).toHaveBeenCalledTimes(1);
        await act(async () => { await controller.playSong(song('B')); });
        expect(revoke).toHaveBeenCalledWith('blob:audio-1');
        await act(async () => { cover.resolve('blob:stale-cover'); await first; });

        expect(revoke.mock.calls.filter(([url]) => url === 'blob:audio-1')).toHaveLength(1);
        expect(revoke.mock.calls.filter(([url]) => url === 'blob:stale-cover')).toHaveLength(1);
        expect(revoke).not.toHaveBeenCalledWith('blob:audio-2');
        expect(usePlaybackStore.getState().audioSrc).toBe('blob:audio-2');
        expect(params.blobUrlRef.current).toBe('blob:audio-2');
    });

    it('does not reset the new song when an older lyric-state read finishes later', async () => {
        const state = deferred<null>();
        env.state.mockReturnValueOnce(state.promise);
        let first!: Promise<void>;
        await act(async () => { first = controller.playSong(song('A')); });
        await act(async () => { await controller.playSong(song('B')); });
        await act(async () => { state.resolve(null); await first; });

        expect(usePlaybackStore.getState().currentSong?.id).toBe('B');
        expect(usePlaybackStore.getState().audioSrc).toBe('blob:audio-2');
        expect(params.currentSongRef.current).toBe('online:netease:B');
        expect(revoke.mock.calls.filter(([url]) => url === 'blob:audio-1')).toHaveLength(1);
        expect(env.cover).toHaveBeenCalledTimes(1);
    });

    it('rejects an old cover result after A to B to A rather than comparing only song identity', async () => {
        const cover = deferred<string>();
        env.cover.mockReturnValueOnce(cover.promise);
        let first!: Promise<void>;
        await act(async () => { first = controller.playSong(song('A')); });
        await act(async () => { await controller.playSong(song('B')); });
        await act(async () => { await controller.playSong(song('A')); });
        await act(async () => { cover.resolve('blob:first-A-cover'); await first; });

        expect(usePlaybackStore.getState().audioSrc).toBe('blob:audio-3');
        expect(usePlaybackStore.getState().cachedCoverUrl).toBe('blob:cover-2');
        expect(revoke).toHaveBeenCalledWith('blob:audio-1');
        expect(revoke).toHaveBeenCalledWith('blob:first-A-cover');
        expect(revoke).not.toHaveBeenCalledWith('blob:audio-3');
    });

    it('releases temporary resources when the controller unmounts during cover loading', async () => {
        const cover = deferred<string>();
        env.cover.mockReturnValueOnce(cover.promise);
        let first!: Promise<void>;
        await act(async () => { first = controller.playSong(song('A')); });
        await act(async () => { root.unmount(); });
        expect(revoke).toHaveBeenCalledWith('blob:audio-1');
        await act(async () => { cover.resolve('blob:unmounted-cover'); await first; });

        expect(revoke).toHaveBeenCalledWith('blob:audio-1');
        expect(revoke).toHaveBeenCalledWith('blob:unmounted-cover');
        expect(params.blobUrlRef.current).toBeNull();
        expect(usePlaybackStore.getState().audioSrc).toBeNull();
    });

    it('keeps current audio and cover URLs after a successful handover', async () => {
        await act(async () => { await controller.playSong(song('A')); });

        expect(revoke).not.toHaveBeenCalledWith('blob:audio-1');
        expect(revoke).not.toHaveBeenCalledWith('blob:cover-1');
        expect(usePlaybackStore.getState().cachedCoverUrl).toBe('blob:cover-1');
        expect(params.blobUrlRef.current).toBe('blob:audio-1');
    });

    it('preserves the latest cleanup registration when an older request finishes', async () => {
        const firstCover = deferred<string>();
        const secondCover = deferred<string>();
        env.cover.mockReturnValueOnce(firstCover.promise).mockReturnValueOnce(secondCover.promise);
        let first!: Promise<void>;
        let second!: Promise<void>;
        await act(async () => { first = controller.playSong(song('A')); });
        await act(async () => { second = controller.playSong(song('B')); });
        await act(async () => { firstCover.resolve('blob:first-cover'); await first; });
        await act(async () => { await controller.playSong(song('C')); });

        expect(revoke.mock.calls.filter(([url]) => url === 'blob:audio-2')).toHaveLength(1);
        await act(async () => { secondCover.resolve('blob:second-cover'); await second; });
        expect(revoke.mock.calls.filter(([url]) => url === 'blob:audio-2')).toHaveLength(1);
        expect(revoke).toHaveBeenCalledWith('blob:second-cover');
        expect(params.blobUrlRef.current).toBe('blob:audio-3');
        expect(revoke).not.toHaveBeenCalledWith('blob:audio-3');
    });

    it.each(['state', 'cover'] as const)('releases temporary audio when the %s read fails', async phase => {
        env[phase].mockRejectedValueOnce(new Error('forced cache failure'));
        await act(async () => { await controller.playSong(song('A')); });

        expect(revoke.mock.calls.filter(([url]) => url === 'blob:audio-1')).toHaveLength(1);
        expect(params.blobUrlRef.current).toBeNull();
        expect(params.setIsLyricsLoading).toHaveBeenLastCalledWith(false);
    });

    it('releases audio arriving after a newer request has already completed', async () => {
        const audio = deferred<{ kind: 'ok'; audioSrc: string; blobUrl: string }>();
        env.audio.mockReturnValueOnce(audio.promise);
        let first!: Promise<void>;
        await act(async () => { first = controller.playSong(song('A')); });
        await act(async () => { await controller.playSong(song('B')); });
        await act(async () => {
            audio.resolve({ kind: 'ok', audioSrc: 'blob:late-audio', blobUrl: 'blob:late-audio' });
            await first;
        });

        expect(revoke.mock.calls.filter(([url]) => url === 'blob:late-audio')).toHaveLength(1);
        expect(usePlaybackStore.getState().currentSong?.id).toBe('B');
        expect(params.blobUrlRef.current).toBe('blob:audio-1');
        expect(revoke).not.toHaveBeenCalledWith('blob:audio-1');
    });

    it('does not revoke remote URLs returned for a discarded cover', async () => {
        const cover = deferred<string>();
        env.cover.mockReturnValueOnce(cover.promise);
        let first!: Promise<void>;
        await act(async () => { first = controller.playSong(song('A')); });
        await act(async () => { await controller.playSong(song('B')); });
        await act(async () => { cover.resolve('https://images.test/A.jpg'); await first; });

        expect(revoke).not.toHaveBeenCalledWith('https://images.test/A.jpg');
        expect(usePlaybackStore.getState().cachedCoverUrl).toBe('blob:cover-1');
    });

    it('does not adopt old resources while a newer before-play decision is pending or cancelled', async () => {
        const cover = deferred<string>();
        env.cover.mockReturnValueOnce(cover.promise);
        let first!: Promise<void>;
        await act(async () => { first = controller.playSong(song('A')); });
        const decision = deferred<SongResult | null>();
        env.hasBeforePlay.mockReturnValue(true);
        env.beforePlay.mockReturnValueOnce(decision.promise);
        let second!: Promise<void>;
        await act(async () => { second = controller.playSong(song('B')); });
        expect(revoke).toHaveBeenCalledWith('blob:audio-1');
        await act(async () => { cover.resolve('blob:cancelled-cover'); await first; });
        await act(async () => { decision.resolve(null); await second; });

        expect(revoke).toHaveBeenCalledWith('blob:cancelled-cover');
        expect(params.blobUrlRef.current).toBeNull();
        expect(usePlaybackStore.getState().audioSrc).toBeNull();
    });

    it('keeps handed-over audio when lyric loading fails', async () => {
        env.lyrics.mockRejectedValueOnce(new Error('forced lyric failure'));
        await act(async () => { await controller.playSong(song('A')); });

        expect(params.blobUrlRef.current).toBe('blob:audio-1');
        expect(revoke).not.toHaveBeenCalledWith('blob:audio-1');
        expect(usePlaybackStore.getState().audioSrc).toBe('blob:audio-1');
    });

    it('does not clear new lyrics or loading state after an old lyric request fails', async () => {
        const lyrics = deferred<void>();
        env.lyrics.mockReturnValueOnce(lyrics.promise);
        let first!: Promise<void>;
        await act(async () => { first = controller.playSong(song('A')); });
        const firstCallbacks = env.lyrics.mock.calls[0][3];
        await act(async () => { await controller.playSong(song('B')); });
        vi.mocked(params.setLyrics).mockClear();
        vi.mocked(params.setIsLyricsLoading).mockClear();
        await act(async () => { lyrics.reject(new Error('late lyric failure')); await first; });

        expect(firstCallbacks.isCurrent()).toBe(false);
        expect(params.setLyrics).not.toHaveBeenCalled();
        expect(params.setIsLyricsLoading).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalledWith('blob:audio-2');
    });
});
