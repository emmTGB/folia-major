import { describe, expect, it, vi } from 'vitest';
import { createVideoExportChunkWriter } from '@/services/electronVideoExportWriter';

// test/unit/services/electronVideoExportWriter.test.ts
const bridge = () => ({
    beginVideoExportFile: vi.fn(async () => 'session'),
    appendVideoExportChunk: vi.fn(async (_id: string, _data: ArrayBuffer) => true),
    finishVideoExportFile: vi.fn(async () => true),
    abortVideoExportFile: vi.fn(async () => true),
});

describe('video export chunk writer', () => {
    it('writes pieces in order with one IPC call active and commits after draining', async () => {
        const electron = bridge();
        let active = 0;
        let peak = 0;
        const chunks: ArrayBuffer[] = [];
        electron.appendVideoExportChunk.mockImplementation(async (_id, data) => {
            active++;
            peak = Math.max(peak, active);
            chunks.push(data);
            await Promise.resolve();
            active--;
            return true;
        });
        const writer = await createVideoExportChunkWriter(electron, 'movie.webm', { onError: vi.fn() });
        writer.enqueue(new Blob([new Uint8Array(9 * 1024 * 1024).fill(1)]));
        writer.enqueue(new Blob([new Uint8Array([2, 3])]));
        await writer.finish();
        expect(peak).toBe(1);
        expect(chunks.every(chunk => chunk.byteLength <= 4 * 1024 * 1024)).toBe(true);
        expect(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(9 * 1024 * 1024 + 2);
        expect([...new Uint8Array(chunks.at(-1)!)]).toEqual([2, 3]);
        expect(electron.finishVideoExportFile).toHaveBeenCalledWith('session');
        await writer.abort();
        expect(electron.abortVideoExportFile).not.toHaveBeenCalled();
    });

    it('bounds pending blobs and reports overflow once instead of accumulating the full recording', async () => {
        const electron = bridge();
        let release!: () => void;
        electron.appendVideoExportChunk.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(true); }));
        const onError = vi.fn();
        const writer = await createVideoExportChunkWriter(electron, 'movie.webm', { onError, maxPendingBytes: 4096, overflowMessage: 'too slow' });
        writer.enqueue(new Blob([new Uint8Array(2048)]));
        await vi.waitFor(() => expect(electron.appendVideoExportChunk).toHaveBeenCalledTimes(1));
        writer.enqueue(new Blob([new Uint8Array(2048)]));
        for (let i = 0; i < 100; i++) writer.enqueue(new Blob([new Uint8Array(2048)]));
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].message).toBe('too slow');
        release();
        await expect(writer.finish()).rejects.toThrow('too slow');
        await writer.abort();
        expect(electron.appendVideoExportChunk).toHaveBeenCalledTimes(1);
        expect(electron.finishVideoExportFile).not.toHaveBeenCalled();
        expect(electron.abortVideoExportFile).toHaveBeenCalledTimes(1);
    });

    it('discards queued blobs on cancellation, including a blob currently converting to ArrayBuffer', async () => {
        const electron = bridge();
        let release!: (data: ArrayBuffer) => void;
        const blob = new Blob(['a']);
        vi.spyOn(blob, 'slice').mockReturnValue({ arrayBuffer: () => new Promise(resolve => { release = resolve; }) } as Blob);
        const writer = await createVideoExportChunkWriter(electron, 'movie.webm', { onError: vi.fn() });
        writer.enqueue(blob);
        writer.enqueue(new Blob(['b']));
        await writer.abort();
        release(new ArrayBuffer(1));
        await Promise.resolve();
        expect(electron.appendVideoExportChunk).not.toHaveBeenCalled();
        expect(electron.abortVideoExportFile).toHaveBeenCalledTimes(1);
    });

    it('propagates IPC failure, drops queued blobs and allows abort cleanup', async () => {
        const electron = bridge();
        electron.appendVideoExportChunk.mockRejectedValue(new Error('disk full'));
        const onError = vi.fn();
        const writer = await createVideoExportChunkWriter(electron, 'movie.webm', { onError });
        writer.enqueue(new Blob(['a']));
        writer.enqueue(new Blob(['b']));
        await expect(writer.finish()).rejects.toThrow('disk full');
        expect(onError).toHaveBeenCalledTimes(1);
        expect(electron.appendVideoExportChunk).toHaveBeenCalledTimes(1);
        await writer.abort();
    });
});
