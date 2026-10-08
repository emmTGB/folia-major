export interface EmbeddedMetadataResult {
    title?: string;
    artist?: string;
    artists?: string[];
    album?: string;
    trackNumber?: number;
    discNumber?: number;
    cover?: Blob;
    coverAssetId?: string;
    bitrate?: number;
    lyrics?: string;
    translationLyrics?: string;
    replayGain?: number;
    replayGainTrackGain?: number;
    replayGainTrackPeak?: number;
    replayGainAlbumGain?: number;
    replayGainAlbumPeak?: number;
    duration?: number;
}

export interface HashedLocalCoverResult {
    cover: Blob;
    coverAssetId: string;
}

// src/utils/localMetadataWorkerClient.ts
// Allow slow local/NAS file reads, while bounding a failed worker's callback lifetime.
const METADATA_WORKER_TIMEOUT_MS = 120_000;
let metadataWorker: Worker | null = null;
let workerFailureListener: (() => void) | null = null;
let workerRequestId = 0;
const workerCallbacks = new Map<string, {
    resolve: (result: unknown | null) => void;
    timer: ReturnType<typeof setTimeout>;
}>();

const settleRequest = (requestId: string, result: unknown | null) => {
    const pending = workerCallbacks.get(requestId);
    if (!pending) return;
    workerCallbacks.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(result);
};

// Retire the failed queue together; subsequent calls can construct a healthy worker.
const retireWorker = (worker: Worker) => {
    if (metadataWorker !== worker) return;
    metadataWorker = null;
    if (workerFailureListener) worker.removeEventListener('messageerror', workerFailureListener);
    workerFailureListener = null;
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    for (const requestId of workerCallbacks.keys()) settleRequest(requestId, null);
};

export const initMetadataWorker = (): Worker => {
    if (!metadataWorker) {
        metadataWorker = new Worker(
            new URL('../workers/metadataParser.worker.ts', import.meta.url),
            { type: 'module' }
        );
        const worker = metadataWorker;
        workerFailureListener = () => retireWorker(worker);
        worker.onerror = workerFailureListener;
        worker.addEventListener('messageerror', workerFailureListener);
        worker.onmessage = (e) => {
            if (metadataWorker !== worker) return;
            const { type, data, requestId, message } = e.data ?? {};
            if (!workerCallbacks.has(requestId)) return;
            if (type !== 'result') console.warn('[MetadataWorker] parsing error:', message);
            settleRequest(requestId, type === 'result' ? data ?? null : null);
        };
    }
    return metadataWorker;
};

const requestMetadataWorker = <T>(message: Record<string, unknown>): Promise<T | null> => (
    new Promise(resolve => {
        let worker: Worker;
        try {
            worker = initMetadataWorker();
        } catch {
            resolve(null);
            return;
        }
        const requestId = `meta_req_${++workerRequestId}`;
        const timer = setTimeout(() => retireWorker(worker), METADATA_WORKER_TIMEOUT_MS);
        workerCallbacks.set(requestId, { resolve: result => resolve(result as T | null), timer });
        try {
            worker.postMessage({ ...message, requestId });
        } catch {
            retireWorker(worker);
        }
    })
);

export const parseEmbeddedMetadataAsync = (
    file: File,
    includeCover = false
): Promise<EmbeddedMetadataResult | null> => (
    requestMetadataWorker({ type: 'parse-metadata', file, includeCover })
);

export const hashLocalCoverBlobAsync = (cover: Blob): Promise<HashedLocalCoverResult | null> => (
    requestMetadataWorker({ type: 'hash-cover', cover })
);
