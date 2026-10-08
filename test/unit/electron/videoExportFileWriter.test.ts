import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// test/unit/electron/videoExportFileWriter.test.ts
const { createVideoExportFileWriter } = createRequire(import.meta.url)('../../../electron/videoExportFileWriter.cjs');

describe('video export file writer', () => {
    let directory: string;
    let owner: EventEmitter;
    let writer: ReturnType<typeof createVideoExportFileWriter>;
    beforeEach(async () => {
        directory = await fs.mkdtemp(join(tmpdir(), 'folia-video-export-'));
        owner = new EventEmitter();
        writer = createVideoExportFileWriter();
    });
    afterEach(async () => {
        await writer.abortOwner(owner);
        await fs.rm(directory, { recursive: true, force: true });
    });

    it('writes ordered chunks and replaces the target only after finish', async () => {
        const path = join(directory, 'movie.webm');
        await fs.writeFile(path, 'original');
        const id = await writer.begin(owner, path);
        await writer.write(owner, id, new Uint8Array([1, 2]).buffer);
        await writer.write(owner, id, new Uint8Array([3, 4]).buffer);
        expect(await fs.readFile(path, 'utf8')).toBe('original');
        await writer.finish(owner, id);
        expect([...await fs.readFile(path)]).toEqual([1, 2, 3, 4]);
        expect(await fs.readdir(directory)).toEqual(['movie.webm']);
        expect(owner.listenerCount('destroyed')).toBe(0);
    });

    it('preserves an existing target and deletes temporary output on cancel or owner crash', async () => {
        const path = join(directory, 'movie.mp4');
        await fs.writeFile(path, 'original');
        let id = await writer.begin(owner, path);
        await writer.write(owner, id, new Uint8Array([5]).buffer);
        await writer.abort(owner, id);
        expect(await fs.readFile(path, 'utf8')).toBe('original');
        id = await writer.begin(owner, path);
        await writer.write(owner, id, new Uint8Array([6]).buffer);
        owner.emit('render-process-gone');
        await writer.abortOwner(owner);
        expect(await fs.readdir(directory)).toEqual(['movie.mp4']);
        await expect(writer.finish(owner, id)).rejects.toThrow();
    });

    it('rejects foreign sessions, overlapping exports and oversized chunks', async () => {
        const path = join(directory, 'movie.webm');
        const id = await writer.begin(owner, path);
        await expect(writer.write(new EventEmitter(), id, new Uint8Array([1]).buffer)).rejects.toThrow();
        await expect(writer.begin(owner, path)).rejects.toThrow();
        await expect(writer.write(owner, id, new ArrayBuffer(8 * 1024 * 1024 + 1))).rejects.toThrow();
        await writer.abort(owner, id);
        expect(await fs.readdir(directory)).toEqual([]);
    });

    it('finishes partial writes without dropping bytes', async () => {
        const handle = { write: vi.fn(async (buffer: Buffer, offset: number, length: number) => ({ bytesWritten: Math.min(length, 2) })), close: vi.fn() };
        writer = createVideoExportFileWriter({ fileSystem: { ...fs, open: vi.fn(async () => handle), unlink: vi.fn(async () => {}), rename: vi.fn(async () => {}) } });
        const id = await writer.begin(owner, join(directory, 'partial.webm'));
        await writer.write(owner, id, new Uint8Array([1, 2, 3, 4, 5]).buffer);
        expect(handle.write.mock.calls.map((call: any[]) => call[1])).toEqual([0, 2, 4]);
        await writer.finish(owner, id);
        expect(handle.close).toHaveBeenCalledTimes(1);
    });

    it('waits for the active write on abort and refuses to queue another chunk', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const handle = { write: vi.fn(async (_buffer: Buffer, _offset: number, length: number) => { await gate; return { bytesWritten: length }; }), close: vi.fn() };
        const fileSystem = { ...fs, open: vi.fn(async () => handle), unlink: vi.fn(async () => {}), rename: vi.fn(async () => {}) };
        writer = createVideoExportFileWriter({ fileSystem });
        const id = await writer.begin(owner, join(directory, 'blocked.webm'));
        const writing = writer.write(owner, id, new Uint8Array([1]).buffer);
        await vi.waitFor(() => expect(handle.write).toHaveBeenCalled());
        await expect(writer.write(owner, id, new Uint8Array([2]).buffer)).rejects.toThrow();
        const abort = writer.abort(owner, id);
        expect(handle.close).not.toHaveBeenCalled();
        release();
        await Promise.all([writing, abort]);
        expect(handle.close).toHaveBeenCalledTimes(1);
        expect(fileSystem.unlink).toHaveBeenCalled();
        expect(fileSystem.rename).not.toHaveBeenCalled();
    });

    it('cleans up a failed write or rename without replacing the original', async () => {
        const handle = { write: vi.fn(async () => { throw new Error('disk full'); }), close: vi.fn() };
        const fileSystem = { ...fs, open: vi.fn(async () => handle), unlink: vi.fn(async () => {}), rename: vi.fn(async () => {}) };
        writer = createVideoExportFileWriter({ fileSystem });
        const id = await writer.begin(owner, join(directory, 'failed.webm'));
        await expect(writer.write(owner, id, new Uint8Array([1]).buffer)).rejects.toThrow('disk full');
        await writer.abort(owner, id);
        expect(fileSystem.unlink).toHaveBeenCalledTimes(1);
        expect(fileSystem.rename).not.toHaveBeenCalled();
    });
    it('cancels a finish that is waiting for the active disk write', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const handle = { write: vi.fn(async (_buffer: Buffer, _offset: number, length: number) => { await gate; return { bytesWritten: length }; }), close: vi.fn() };
        const fileSystem = { ...fs, open: vi.fn(async () => handle), unlink: vi.fn(async () => {}), rename: vi.fn(async () => {}) };
        writer = createVideoExportFileWriter({ fileSystem });
        const id = await writer.begin(owner, join(directory, 'cancel-finish.webm'));
        const writing = writer.write(owner, id, new Uint8Array([1]).buffer);
        await vi.waitFor(() => expect(handle.write).toHaveBeenCalled());
        const finishing = writer.finish(owner, id);
        const rejected = expect(finishing).rejects.toThrow('cancelled');
        const abort = writer.abort(owner, id);
        release();
        await Promise.all([writing, rejected, abort]);
        expect(fileSystem.rename).not.toHaveBeenCalled();
        expect(handle.close).toHaveBeenCalledTimes(1);
        expect(fileSystem.unlink).toHaveBeenCalledTimes(1);
    });

    it('removes temporary output when renaming fails and leaves the target unchanged', async () => {
        const path = join(directory, 'rename-failed.webm');
        await fs.writeFile(path, 'original');
        writer = createVideoExportFileWriter({ fileSystem: { ...fs, rename: vi.fn(async () => { throw new Error('rename denied'); }) } });
        const id = await writer.begin(owner, path);
        await writer.write(owner, id, new Uint8Array([1]).buffer);
        await expect(writer.finish(owner, id)).rejects.toThrow('rename denied');
        expect(await fs.readFile(path, 'utf8')).toBe('original');
        expect(await fs.readdir(directory)).toEqual(['rename-failed.webm']);
        expect(owner.listenerCount('destroyed')).toBe(0);
    });

});
