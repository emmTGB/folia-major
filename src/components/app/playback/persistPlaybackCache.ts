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

let queueWrite: Promise<void> = Promise.resolve();
let latestQueueWrite: {
    queue: WeakRef<SongResult[]>;
    pending: boolean;
    revision: number;
    completion: Promise<void>;
} | null = null;

// 合并同一队列的保存并串行写入新队列；弱引用避免清空播放后继续持有整个队列。
const persistQueue = (queue: SongResult[]): Promise<void> => {
    if (latestQueueWrite?.queue.deref() === queue && (
        latestQueueWrite.pending || latestQueueWrite.revision === getPlaybackQueueCacheRevision()
    )) return latestQueueWrite.completion;

    const sanitizedQueue = queue.filter(queuedSong => !isStagePlaybackSong(queuedSong)).map(sanitizePlaybackSong);
    const write = {
        queue: new WeakRef(queue), pending: true, revision: -1, completion: Promise.resolve(),
    };
    latestQueueWrite = write;
    write.completion = queueWrite.then(async () => {
        try {
            write.revision = await writePlaybackQueueCache(sanitizedQueue);
        } catch (error) {
            if (latestQueueWrite === write) latestQueueWrite = null;
            console.error('Cache save failed:', error);
        } finally {
            write.pending = false;
        }
    });
    queueWrite = write.completion;
    return write.completion;
};

// Persists local playback as a lightweight songId reference while excluding Stage snapshots.
export const persistPlaybackCache = async (song: SongResult | null, queue: SongResult[]) => {
    if (!song || isStagePlaybackSong(song)) {
        return;
    }

    const sanitizedSong = sanitizePlaybackSong(song);
    await Promise.all([
        saveToCache('last_song', sanitizedSong),
        persistQueue(queue),
    ]);
};
