import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/utils/localMetadataWorkerClient.test.ts

describe('metadata worker client', () => {
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
                this.onmessage?.({ data: { type, data: { title: "Parsed" },
                    requestId: this.postMessage.mock.calls[index][0].requestId } } as MessageEvent);
            }
        }
        vi.stubGlobal('Worker', FakeWorker);
        return { workers, ...await import('@/utils/localMetadataWorkerClient') };
    };

    it('clears timers on success and parser error without discarding a healthy worker', async () => {
        const { workers, parseEmbeddedMetadataAsync } = await setupWorker();
        const a = parseEmbeddedMetadataAsync(new File(['a'], 'a.mp3'), true);
        const b = parseEmbeddedMetadataAsync(new File(['b'], 'b.mp3'));
        expect(vi.getTimerCount()).toBe(2);
        workers[0].reply();
        workers[0].reply(1, 'error');
        await expect(a).resolves.toEqual({ title: "Parsed" });
        await expect(b).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        expect(workers[0].terminate).not.toHaveBeenCalled();
    });

    it.each(['onerror', 'onmessageerror', 'timeout', 'postMessage'] as const)(
        'settles all requests on %s and ignores old worker events after rebuilding', async fault => {
            const { workers, parseEmbeddedMetadataAsync } = await setupWorker();
            const a = parseEmbeddedMetadataAsync(new File(['a'], 'a.mp3'), true);
            const old = workers[0];
            const lateReply = old.onmessage!;
            const lateError = old.onerror;
            if (fault === 'postMessage') old.postMessage.mockImplementationOnce(() => { throw new Error('clone'); });
            const b = parseEmbeddedMetadataAsync(new File(['b'], 'b.mp3'));
            if (fault === 'timeout') await vi.advanceTimersByTimeAsync(120_000);
            else if (fault === 'onmessageerror') old.dispatchEvent(new Event('messageerror'));
            else if (fault !== 'postMessage') old[fault]?.();
            const settled = vi.fn();
            void Promise.all([a, b]).then(settled);
            await Promise.resolve();
            await Promise.resolve();
            expect(settled).toHaveBeenCalledWith([null, null]);
            expect(old.terminate).toHaveBeenCalledTimes(1);
            expect(vi.getTimerCount()).toBe(0);
            const next = parseEmbeddedMetadataAsync(new File(['new'], 'new.mp3'));
            expect(workers).toHaveLength(2);
            const nextId = workers[1].postMessage.mock.calls[0][0].requestId;
            lateReply({ data: { type: 'result', requestId: nextId, data: { wrong: true } } } as MessageEvent);
            lateError?.();
            expect(vi.getTimerCount()).toBe(1);
            workers[1].reply();
            await expect(next).resolves.toEqual({ title: "Parsed" });
            expect(vi.getTimerCount()).toBe(0);
        },
    );

    it('returns null when Worker construction fails and allows retry', async () => {
        const { parseEmbeddedMetadataAsync, workers } = await setupWorker();
        const healthy = globalThis.Worker;
        vi.stubGlobal('Worker', class { constructor() { throw new Error('unavailable'); } });
        await expect(parseEmbeddedMetadataAsync(new File(['a'], 'a.mp3'), true)).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
        vi.stubGlobal('Worker', healthy);
        const next = parseEmbeddedMetadataAsync(new File(['b'], 'b.mp3'));
        workers[0].reply();
        await expect(next).resolves.toEqual({ title: "Parsed" });
    });


    it('settles cover hashing with the same failure lifecycle', async () => {
        const { workers, hashLocalCoverBlobAsync } = await setupWorker();
        const pending = hashLocalCoverBlobAsync(new Blob(['cover'], { type: 'image/png' }));
        expect(workers[0].postMessage.mock.calls[0][0].type).toBe('hash-cover');
        workers[0].dispatchEvent(new Event('messageerror'));
        await expect(pending).resolves.toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
});
