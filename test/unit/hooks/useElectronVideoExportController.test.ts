import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useElectronVideoExportController } from '@/hooks/useElectronVideoExportController';

// test/unit/hooks/useElectronVideoExportController.test.ts
// Exercise recording, finalization and cancellation through the real chunk writer.
const state = vi.hoisted(() => ({
    statuses: [] as any[], current: {} as any, cleanup: [] as Array<() => void>,
}));
vi.mock('react', () => ({
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    useState: (initial: unknown) => {
        state.current = initial;
        return [initial, (next: any) => {
            state.current = typeof next === 'function' ? next(state.current) : next;
            state.statuses.push(state.current);
        }];
    },
    useEffect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) state.cleanup.push(cleanup); },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/usePlaybackStore', () => ({
    usePlaybackStore: (select: (value: any) => unknown) => select({ currentSong: { id: 1, name: 'Song' }, duration: 120 }),
}));
vi.mock('@/stores/useAppChromeStore', () => ({
    useAppChromeStore: (select: (value: any) => unknown) => select({ setIsPlayerChromeHidden: vi.fn() }),
}));
vi.mock('@/stores/useAppViewStore', () => ({ setIsPanelOpen: vi.fn() }));
vi.mock('@/stores/motionSignals', () => ({ currentTime: { set: vi.fn() } }));
vi.mock('@/services/electronVideoExport', () => ({
    buildDefaultVideoExportFileName: () => 'movie.webm',
    createCroppedVideoStream: (stream: unknown) => ({ stream, cleanup: vi.fn() }),
    getAudioElementCaptureStream: () => ({ getAudioTracks: () => [{ stop: vi.fn() }] }),
    getMainWindowVideoCaptureStream: async () => ({ getVideoTracks: () => [{ stop: vi.fn() }] }),
    getVideoExportRecorderOptions: () => ({}),
    getSupportedVideoExportFormat: () => ({ mimeType: 'video/webm', extension: 'webm', displayName: 'WebM' }),
    installVideoExportCursorGuard: () => vi.fn(),
    stopMediaStream: vi.fn(),
    wait: async () => {},
}));

describe('video export controller streaming', () => {
    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
        state = 'inactive';
        ondataavailable: ((event: { data: Blob }) => void) | null = null;
        onerror: (() => void) | null = null;
        onstop: (() => void) | null = null;
        constructor() { recorders.push(this); }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['end']) }); this.onstop?.(); }
        chunk(data = 'chunk') { this.ondataavailable?.({ data: new Blob([data]) }); }
    }
    const makeElectron = () => ({
        chooseVideoExportPath: vi.fn(async () => ({ canceled: false, filePath: 'movie.webm' })),
        getMainWindowCaptureSource: vi.fn(),
        prepareVideoExportWindow: vi.fn(async () => ({ success: true, dpr: 1 })),
        restoreVideoExportWindow: vi.fn(async () => true),
        writeVideoExportFile: vi.fn(),
        beginVideoExportFile: vi.fn(async () => 'session'),
        appendVideoExportChunk: vi.fn(async (_id: string, _data: ArrayBuffer) => true),
        finishVideoExportFile: vi.fn(async () => true),
        abortVideoExportFile: vi.fn(async () => true),
    });
    let electron: ReturnType<typeof makeElectron>;
    let audio: HTMLAudioElement;
    beforeEach(() => {
        state.statuses = [];
        state.cleanup = [];
        recorders.length = 0;
        electron = makeElectron();
        audio = { paused: true, loop: true, currentTime: 20, duration: 120, pause: vi.fn(),
            addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLAudioElement;
        vi.stubGlobal('window', { electron, setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout });
        vi.stubGlobal('MediaRecorder', FakeRecorder);
        vi.stubGlobal('MediaStream', class { constructor(_tracks: unknown[]) {} });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    const setup = (resumePlayback = vi.fn(async () => {})) => {
        const controller = useElectronVideoExportController({
            isElectronWindow: true, audioRef: { current: audio }, navigateToPlayer: vi.fn(),
            pausePlayback: vi.fn(), resumePlayback,
        });
        const command = (type: 'cancel-export' | 'stop-export') => controller.handleExportCommand({ type });
        controller.handleExportCommand({ type: 'start-export', preset: {
            id: 'test', width: 640, height: 480, label: 'Test', aspectRatio: '4:3',
        } as any, startMode: 'from-start' });
        return { controller, command };
    };

    it('writes data during recording and commits the final chunk without whole-file IPC', async () => {
        setup();
        await vi.waitFor(() => expect(recorders[0]?.state).toBe('recording'));
        recorders[0].chunk('first');
        await vi.waitFor(() => expect(electron.appendVideoExportChunk).toHaveBeenCalledTimes(1));
        expect(state.current.status).toBe('recording');
        recorders[0].stop();
        await vi.waitFor(() => expect(state.current.status).toBe('done'));
        expect(electron.appendVideoExportChunk).toHaveBeenCalledTimes(2);
        expect(electron.finishVideoExportFile).toHaveBeenCalledWith('session');
        expect(electron.writeVideoExportFile).not.toHaveBeenCalled();
        expect(electron.abortVideoExportFile).not.toHaveBeenCalled();
        expect(audio.currentTime).toBe(20);
    });

    it('cancels during finalization and drops queued chunks instead of committing', async () => {
        let release!: (success: boolean) => void;
        electron.appendVideoExportChunk.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const { command } = setup();
        await vi.waitFor(() => expect(recorders[0]?.state).toBe('recording'));
        recorders[0].chunk();
        await vi.waitFor(() => expect(electron.appendVideoExportChunk).toHaveBeenCalledTimes(1));
        command('stop-export');
        await vi.waitFor(() => expect(state.current.status).toBe('finalizing'));
        command('cancel-export');
        expect(electron.abortVideoExportFile).toHaveBeenCalledTimes(1);
        release(true);
        await vi.waitFor(() => expect(state.current.status).toBe('idle'));
        expect(electron.appendVideoExportChunk).toHaveBeenCalledTimes(1);
        expect(electron.finishVideoExportFile).not.toHaveBeenCalled();
        expect(electron.restoreVideoExportWindow).toHaveBeenCalled();
    });

    it('cleans up an already created recorder and file if playback startup fails', async () => {
        setup(vi.fn(async () => { throw new Error('play failed'); }));
        await vi.waitFor(() => expect(electron.abortVideoExportFile).toHaveBeenCalledTimes(1));
        expect(state.current.status).toBe('error');
        expect(recorders[0].state).toBe('inactive');
        expect(recorders[0].ondataavailable).toBeNull();
        expect(electron.finishVideoExportFile).not.toHaveBeenCalled();
    });

    it('stops recording and aborts output when a data event exceeds the backlog limit', async () => {
        setup();
        await vi.waitFor(() => expect(recorders[0]?.state).toBe('recording'));
        recorders[0].ondataavailable?.({ data: new Blob([new Uint8Array(64 * 1024 * 1024 + 1)]) });
        await vi.waitFor(() => expect(electron.abortVideoExportFile).toHaveBeenCalledTimes(1));
        expect(state.current.status).toBe('error');
        expect(state.current.error).toBe('export.writeBufferExceeded');
        expect(recorders[0].state).toBe('inactive');
        expect(electron.appendVideoExportChunk).not.toHaveBeenCalled();
        expect(electron.finishVideoExportFile).not.toHaveBeenCalled();
    });

    it('aborts an active export when the hook unmounts', async () => {
        setup();
        await vi.waitFor(() => expect(recorders[0]?.state).toBe('recording'));
        state.cleanup.at(-1)!();
        await vi.waitFor(() => expect(electron.restoreVideoExportWindow).toHaveBeenCalled());
        expect(electron.abortVideoExportFile).toHaveBeenCalledTimes(1);
        expect(electron.finishVideoExportFile).not.toHaveBeenCalled();
    });
});
