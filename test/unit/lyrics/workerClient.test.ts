import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/lyrics/workerClient.test.ts

describe('lyrics worker client', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    // Keep old handlers callable to simulate events already queued before termination.
    const setupWorker = async () => {
        vi.useFakeTimers();
        const workers: FakeWorker[] = [];
        class FakeWorker extends EventTarget {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: (() => void) | null = null;
            onmessageerror: (() => void) | null = null;
            terminate = vi.fn();
            postMessage = vi.fn();
            constructor() { super(); workers.push(this); }
            reply(index = 0, type = 'result') {
                this.onmessage?.({ data: { type, data: { lines: [] },
                    requestId: this.postMessage.mock.calls[index][0].requestId } } as MessageEvent);
            }
        }
        vi.stubGlobal('Worker', FakeWorker);
        return { workers, ...await import('@/utils/lyrics/workerClient') };
    };

    it('clears timers on success and parser error without discarding a healthy worker', async () => {
        const { workers, parseLyricsAsync } = await setupWorker();
        const a = parseLyricsAsync('lrc', 'a');
        const b = parseLyricsAsync('lrc', 'b');
        expect(vi.getTimerCount()).toBe(2);
        workers[0].reply();
        workers[0].reply(1, 'error');
        await expect(a).resolves.toEqual({ lines: [] });
        await expect(b).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        expect(workers[0].terminate).not.toHaveBeenCalled();
    });

    it.each(['onerror', 'onmessageerror', 'timeout', 'postMessage'] as const)(
        'settles all requests on %s and ignores old worker events after rebuilding', async fault => {
            const { workers, parseLyricsAsync } = await setupWorker();
            const a = parseLyricsAsync('lrc', 'a');
            const old = workers[0];
            const lateReply = old.onmessage!;
            const lateError = old.onerror;
            if (fault === 'postMessage') old.postMessage.mockImplementationOnce(() => { throw new Error('clone'); });
            const b = parseLyricsAsync('lrc', 'b');
            if (fault === 'timeout') await vi.advanceTimersByTimeAsync(30_000);
            else if (fault === 'onmessageerror') old.dispatchEvent(new Event('messageerror'));
            else if (fault !== 'postMessage') old[fault]?.();
            const settled = vi.fn();
            void Promise.all([a, b]).then(settled);
            await Promise.resolve();
            await Promise.resolve();
            expect(settled).toHaveBeenCalledWith([null, null]);
            expect(old.terminate).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
            const next = parseLyricsAsync('lrc', 'new');
            expect(workers).toHaveLength(2);
            const nextId = workers[1].postMessage.mock.calls[0][0].requestId;
            lateReply({ data: { type: 'result', requestId: nextId, data: { wrong: true } } } as MessageEvent);
            lateError?.();
            expect(vi.getTimerCount()).toBe(1);
            workers[1].reply();
            await expect(next).resolves.toEqual({ lines: [] });
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('returns null when Worker construction fails and allows retry', async () => {
        const { parseLyricsAsync, workers } = await setupWorker();
        const healthy = globalThis.Worker;
        vi.stubGlobal('Worker', class { constructor() { throw new Error('unavailable'); } });
        await expect(parseLyricsAsync('lrc', 'a')).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        vi.stubGlobal('Worker', healthy);
        const next = parseLyricsAsync('lrc', 'b');
        workers[0].reply();
        await expect(next).resolves.toEqual({ lines: [] });
    });

    it('does not post provider callbacks or song identity to the parser worker', async () => {
        const messages: Array<Record<string, unknown>> = [];

        class FakeWorker extends EventTarget {
            onmessage: ((event: MessageEvent) => void) | null = null;

            postMessage(message: Record<string, unknown>) {
                messages.push(message);
                structuredClone(message);
                this.onmessage?.({
                    data: {
                        type: 'result',
                        data: { lines: [] },
                        requestId: message.requestId,
                    },
                } as MessageEvent);
            }
        }

        vi.stubGlobal('Worker', FakeWorker);
        const { parseLyricsAsync } = await import('@/utils/lyrics/workerClient');
        const fetchChorusRanges = vi.fn(async () => []);

        await expect(parseLyricsAsync('lrc', '[00:00.00]Line', '', {
            includeInterludes: false,
            filterPattern: '^metadata$',
            songId: 123,
            fetchChorusRanges,
        }, '[00:00.00]Roma')).resolves.toEqual({ lines: [] });

        expect(messages[0]?.options).toEqual({
            includeInterludes: false,
            filterPattern: '^metadata$',
        });
        expect(messages[0]?.romanization).toBe('[00:00.00]Roma');
        expect(fetchChorusRanges).not.toHaveBeenCalled();
    });
});
