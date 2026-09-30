// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoverObjectUrlOwner, createCoverSnapshotRef, discardCoverObjectUrl, registerCoverObjectUrl } from '@/services/coverObjectUrls';
import { usePlaybackStore } from '@/stores/usePlaybackStore';

// test/unit/playback/coverObjectUrls.test.ts
// 验证封面随最后一个使用者释放，而不是随某次 setter 调用释放。

const flush = () => Promise.resolve();
describe('cover object URL ownership', () => {
    const revoke = vi.fn();
    beforeEach(() => {
        vi.stubGlobal('URL', class extends URL { static revokeObjectURL = revoke; });
        revoke.mockClear();
    });
    afterEach(async () => {
        usePlaybackStore.setState({ cachedCoverUrl: null, transitionDisplay: null });
        await flush();
        vi.unstubAllGlobals();
    });
    it('releases previous covers across 100 normal playback replacements', async () => {
        for (let i = 0; i < 100; i++) {
            usePlaybackStore.getState().setCachedCoverUrl(registerCoverObjectUrl(`blob:cover-${i}`));
            await flush();
        }
        expect(revoke).toHaveBeenCalledTimes(99);
        expect(revoke).not.toHaveBeenCalledWith('blob:cover-99');
        usePlaybackStore.getState().setCachedCoverUrl(null);
        await flush();
        expect(revoke).toHaveBeenCalledTimes(100);
    });
    it('keeps the outgoing cover until the frozen display is cleared', async () => {
        const old = registerCoverObjectUrl('blob:outgoing');
        usePlaybackStore.setState({ cachedCoverUrl: old });
        usePlaybackStore.setState({ transitionDisplay: { song: null, lyrics: null, coverUrl: old, duration: 0 } });
        usePlaybackStore.setState({ cachedCoverUrl: registerCoverObjectUrl('blob:incoming') });
        await flush();
        expect(revoke).not.toHaveBeenCalledWith(old);
        usePlaybackStore.setState({ transitionDisplay: null });
        await flush();
        expect(revoke).toHaveBeenCalledWith(old);
    });
    it('supports cancelling a transition and restoring its cover synchronously', async () => {
        const old = registerCoverObjectUrl('blob:cancel');
        usePlaybackStore.setState({ transitionDisplay: { song: null, lyrics: null, coverUrl: old, duration: 0 } });
        usePlaybackStore.setState({ transitionDisplay: null });
        usePlaybackStore.setState({ cachedCoverUrl: old });
        await flush();
        expect(revoke).not.toHaveBeenCalledWith(old);
    });
    it('protects Stage and handoff snapshots even when playback changes', async () => {
        const ref = createCoverSnapshotRef<{ cachedCoverUrl: string | null }>();
        const url = registerCoverObjectUrl('blob:snapshot');
        usePlaybackStore.setState({ cachedCoverUrl: url });
        ref.current = { cachedCoverUrl: url };
        usePlaybackStore.setState({ cachedCoverUrl: null });
        await flush();
        expect(revoke).not.toHaveBeenCalled();
        ref.current = null;
        await flush();
        expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
    });
    it('discards late results once, without revoking resources already adopted elsewhere', async () => {
        const url = registerCoverObjectUrl('blob:late');
        discardCoverObjectUrl(url);
        discardCoverObjectUrl(url);
        expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
        const active = registerCoverObjectUrl('blob:active');
        const owner = createCoverObjectUrlOwner();
        owner([active, active]);
        discardCoverObjectUrl(active);
        expect(revoke).not.toHaveBeenCalledWith(active);
        owner([]);
        owner([]);
        await flush();
        expect(revoke).toHaveBeenCalledTimes(2);
    });
    it('never revokes HTTP, data or foreign renderer blob URLs', async () => {
        const owner = createCoverObjectUrlOwner();
        owner(['https://example.com/cover', 'data:image/png;base64,x', 'blob:another-renderer']);
        owner([]);
        discardCoverObjectUrl('blob:another-renderer');
        await flush();
        expect(revoke).not.toHaveBeenCalled();
    });
});
