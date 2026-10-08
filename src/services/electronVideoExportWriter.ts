// src/services/electronVideoExportWriter.ts
// Streams ordered recording chunks with a bounded Blob backlog and one IPC write at a time.
type VideoExportBridge = Pick<NonNullable<Window['electron']>,
    'beginVideoExportFile' | 'appendVideoExportChunk' | 'finishVideoExportFile' | 'abortVideoExportFile'>;

const MAX_PENDING_BYTES = 64 * 1024 * 1024;
const IPC_CHUNK_BYTES = 4 * 1024 * 1024;

export const createVideoExportChunkWriter = async (
    electron: VideoExportBridge,
    filePath: string,
    options: { onError: (error: Error) => void; maxPendingBytes?: number; overflowMessage?: string },
) => {
    const sessionId = await electron.beginVideoExportFile(filePath);
    const queue: Blob[] = [];
    let pendingBytes = 0;
    let draining: Promise<void> | null = null;
    let accepting = true;
    let cancelled = false;
    let committed = false;
    let failure: Error | null = null;
    let aborting: Promise<void> | null = null;

    const fail = (error: unknown) => {
        if (failure || cancelled) return;
        failure = error instanceof Error ? error : new Error(String(error));
        accepting = false;
        queue.length = 0;
        pendingBytes = 0;
        options.onError(failure);
    };

    // Slice only the current Blob; conversion and IPC copies never span the whole recording.
    const drain = async () => {
        while (queue.length > 0 && !cancelled && !failure) {
            const blob = queue.shift()!;
            try {
                for (let offset = 0; offset < blob.size; offset += IPC_CHUNK_BYTES) {
                    if (cancelled || failure) break;
                    const data = await blob.slice(offset, offset + IPC_CHUNK_BYTES).arrayBuffer();
                    if (cancelled || failure) break;
                    if (!await electron.appendVideoExportChunk(sessionId, data)) {
                        throw new Error('Could not write video export chunk.');
                    }
                }
            } catch (error) {
                fail(error);
            } finally {
                pendingBytes = Math.max(0, pendingBytes - blob.size);
            }
        }
        draining = null;
    };

    return {
        enqueue(blob: Blob) {
            if (!accepting || cancelled || blob.size === 0) return;
            if (pendingBytes + blob.size > (options.maxPendingBytes ?? MAX_PENDING_BYTES)) {
                fail(new Error(options.overflowMessage ?? 'Video export storage is too slow.'));
                return;
            }
            pendingBytes += blob.size;
            queue.push(blob);
            if (!draining) draining = drain();
        },
        async finish() {
            accepting = false;
            await draining;
            if (failure) throw failure;
            if (cancelled) throw new Error('Video export cancelled.');
            try {
                if (!await electron.finishVideoExportFile(sessionId)) throw new Error('Could not finish video export.');
                committed = true;
            } catch (error) {
                fail(error);
                throw error;
            }
        },
        abort(): Promise<void> {
            if (committed) return Promise.resolve();
            if (aborting) return aborting;
            cancelled = true;
            accepting = false;
            queue.length = 0;
            pendingBytes = 0;
            aborting = electron.abortVideoExportFile(sessionId).then(() => undefined);
            return aborting;
        },
    };
};
