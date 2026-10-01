import { LyricData } from '../../types';
import type { LyricParseFormat } from './parserCore';
import type { LyricProcessingOptions } from './types';

// src/utils/lyrics/workerClient.ts
// 10k-line LRC/YRC samples parse and transfer in < 0.2s locally; allow ample slow-device/queue headroom.
const LYRICS_WORKER_TIMEOUT_MS = 30_000;
let lyricsWorker: Worker | null = null;
let lyricsWorkerFailureListener: (() => void) | null = null;
let workerRequestId = 0;
const workerCallbacks = new Map<string, {
    resolve: (data: LyricData | null) => void;
    timer: ReturnType<typeof setTimeout>;
}>();

const settleRequest = (requestId: string, data: LyricData | null) => {
    const pending = workerCallbacks.get(requestId);
    if (!pending) return;
    workerCallbacks.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(data);
};

// A failed or stuck worker invalidates its entire queue; the next request creates a fresh worker.
const retireWorker = (worker: Worker) => {
    if (lyricsWorker !== worker) return;
    lyricsWorker = null;
    if (lyricsWorkerFailureListener) {
        worker.removeEventListener('messageerror', lyricsWorkerFailureListener);
        lyricsWorkerFailureListener = null;
    }
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    for (const requestId of workerCallbacks.keys()) settleRequest(requestId, null);
};

type WorkerLyricProcessingOptions = Pick<LyricProcessingOptions, 'includeInterludes' | 'filterPattern'>;

// Keeps orchestration-only values such as provider callbacks outside the structured-clone boundary.
export const toWorkerLyricProcessingOptions = (
    options?: LyricProcessingOptions,
): WorkerLyricProcessingOptions | undefined => {
    if (!options) return undefined;
    return {
        ...(options.includeInterludes !== undefined ? { includeInterludes: options.includeInterludes } : {}),
        ...(options.filterPattern !== undefined ? { filterPattern: options.filterPattern } : {}),
    };
};

export const initLyricsWorker = (): Worker => {
    if (!lyricsWorker) {
        // Need to use correct relative path or alias
        lyricsWorker = new Worker(
            new URL('../../workers/lyricsParser.worker.ts', import.meta.url),
            { type: 'module' }
        );
        const worker = lyricsWorker;
        lyricsWorkerFailureListener = () => retireWorker(worker);
        worker.onerror = lyricsWorkerFailureListener;
        // Chromium Worker does not expose onmessageerror; use the event listener API.
        worker.addEventListener('messageerror', lyricsWorkerFailureListener);
        worker.onmessage = (e) => {
            if (lyricsWorker !== worker) return;
            const { type, data, requestId, message } = e.data ?? {};
            if (workerCallbacks.has(requestId)) {
                if (type === 'result') {
                    settleRequest(requestId, data ?? null);
                } else {
                    console.warn('[LyricsWorker] parsing error:', message);
                    settleRequest(requestId, null);
                }
            }
        };
    }
    return lyricsWorker;
};

export const parseLyricsAsync = (
    format: LyricParseFormat,
    content: string,
    translation?: string,
    options?: LyricProcessingOptions,
    romanization?: string
): Promise<LyricData | null> => {
    return new Promise((resolve) => {
        let worker: Worker;
        try {
            worker = initLyricsWorker();
        } catch {
            resolve(null);
            return;
        }
        const requestId = `req_${++workerRequestId}`;
        const timer = setTimeout(() => retireWorker(worker), LYRICS_WORKER_TIMEOUT_MS);
        workerCallbacks.set(requestId, { resolve, timer });
        try {
            worker.postMessage({
                type: 'parse',
                format,
                content,
                translation,
                romanization,
                options: toWorkerLyricProcessingOptions(options),
                requestId,
            });
        } catch {
            retireWorker(worker);
        }
    });
};
