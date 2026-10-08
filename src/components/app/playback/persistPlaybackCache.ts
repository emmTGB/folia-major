import { saveToCache } from '../../../services/db';
import { getPlaybackQueueCacheRevision, writePlaybackQueueCache } from '../../../services/repositories/cacheRepository';
import type { SongResult, UnifiedSong } from '../../../types';
import { isStagePlaybackSong, normalizePlaybackSongSource } from '../../../utils/appPlaybackGuards';

// src/components/app/playback/persistPlaybackCache.ts

const sanitizePlaybackSong = (song: SongResult): SongResult => {
    const unified = normalizePlaybackSongSource(song) as UnifiedSong & { localData?: { id?: string } };
    const localSongId = unified.localRef?.songId || unified.localData?.id;
    if (!localSongId) return unified;
    const { localData: _legacyLocalData, ...snapshot } = unified;
    return { ...snapshot, isLocal: true, localRef: { songId: localSongId } } as UnifiedSong;
};

type QueueWrite = {
    queue: WeakRef<SongResult[]>;
    source: SongResult[] | null;
    pending: boolean;
    revision: number;
    completion: Promise<void>;
    resolve: () => void;
};
let queueWriteInFlight = false;
let pendingQueueWrite: QueueWrite | null = null;
let latestQueueWrite: QueueWrite | null = null;

// Only the active snapshot and the latest pending queue survive slow storage.
const drainQueueWrites = async (): Promise<void> => {
    queueWriteInFlight = true;
    try {
        while (pendingQueueWrite) {
            const write = pendingQueueWrite;
            pendingQueueWrite = null;
            try {
                const sanitizedQueue = write.source!.filter(song => !isStagePlaybackSong(song)).map(sanitizePlaybackSong);
                write.source = null;
                write.revision = await writePlaybackQueueCache(sanitizedQueue);
            } catch (error) {
                if (latestQueueWrite === write) latestQueueWrite = null;
                console.error('Cache save failed:', error);
            } finally {
                write.source = null;
                write.pending = false;
                write.resolve();
            }
        }
    } finally {
        queueWriteInFlight = false;
    }
};

// 合并同一队列的保存并串行写入新队列；弱引用避免清空播放后继续持有整个队列。
const persistQueue = (queue: SongResult[]): Promise<void> => {
    if (latestQueueWrite?.queue.deref() === queue && (
        latestQueueWrite.pending || latestQueueWrite.revision === getPlaybackQueueCacheRevision()
    )) return latestQueueWrite.completion;

    if (pendingQueueWrite) {
        pendingQueueWrite.queue = new WeakRef(queue);
        pendingQueueWrite.source = queue;
        latestQueueWrite = pendingQueueWrite;
    } else {
        let resolve!: () => void;
        const completion = new Promise<void>(done => { resolve = done; });
        pendingQueueWrite = { queue: new WeakRef(queue), source: queue, pending: true, revision: -1, completion, resolve };
        latestQueueWrite = pendingQueueWrite;
    }
    const completion = latestQueueWrite.completion;
    if (!queueWriteInFlight) void drainQueueWrites();
    return completion;
};

// Persists local playback as a lightweight songId reference while excluding Stage snapshots.
export const persistPlaybackCache = (song: SongResult | null, queue: SongResult[]): Promise<void> => {
    if (!song || isStagePlaybackSong(song)) {
        return Promise.resolve();
    }

    const sanitizedSong = sanitizePlaybackSong(song);
    return Promise.all([
        saveToCache('last_song', sanitizedSong),
        persistQueue(queue),
    ]).then(() => undefined);
};
