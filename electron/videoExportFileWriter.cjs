const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

// electron/videoExportFileWriter.cjs
// Owns bounded chunk writes and commits a temporary recording only after it closes.
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

function createVideoExportFileWriter({ fileSystem = fs } = {}) {
  const sessions = new Map();
  const getSession = (owner, id) => {
    const session = sessions.get(owner);
    if (!session || session.id !== id) throw new Error('Unknown video export session.');
    return session;
  };
  const closeHandle = async session => {
    const handle = session.handle;
    session.handle = null;
    if (handle) await handle.close();
  };

  // Serialize closing with the active write; cancellation cannot publish a partial recording.
  const finalize = (session, commit) => {
    if (session.finalPromise) return session.finalPromise;
    session.closing = true;
    session.finalPromise = (async () => {
      try {
        await session.ready;
        await session.writing;
        if (commit && session.error) throw session.error;
        if (commit && session.cancelled) throw new Error('Video export cancelled.');
      } finally {
        await closeHandle(session);
      }
      if (commit) {
        if (session.cancelled) throw new Error('Video export cancelled.');
        await fileSystem.rename(session.tempPath, session.filePath);
        session.committed = true;
      }
    })().finally(async () => {
      if (!session.committed && session.opened) {
        await fileSystem.unlink(session.tempPath).catch(error => {
          if (error.code !== 'ENOENT') console.warn('[VideoExport] Could not remove temporary output:', error);
        });
      }
      session.detach();
      if (sessions.get(session.owner) === session) sessions.delete(session.owner);
    });
    return session.finalPromise;
  };

  const abort = async (owner, id) => {
    const session = sessions.get(owner);
    if (!session || session.id !== id) return false;
    session.cancelled = true;
    await finalize(session, false).catch(() => undefined);
    return true;
  };
  const abortOwner = async owner => {
    const session = sessions.get(owner);
    if (session) await abort(owner, session.id);
  };

  return {
    async begin(owner, filePath) {
      if (typeof filePath !== 'string' || !filePath) throw new Error('Missing video export path.');
      if (sessions.has(owner)) throw new Error('A video export is already open.');
      const id = randomUUID();
      const session = {
        owner, id, filePath, tempPath: filePath + '.' + id + '.part',
        handle: null, writing: null, finalPromise: null, error: null,
        opened: false, closing: false, cancelled: false, committed: false, detach: () => {},
      };
      sessions.set(owner, session);
      session.ready = fileSystem.open(session.tempPath, 'wx').then(handle => {
        session.handle = handle;
        session.opened = true;
      });
      const onExit = () => { void abortOwner(owner); };
      const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) onExit();
      };
      owner.once?.('destroyed', onExit);
      owner.once?.('render-process-gone', onExit);
      owner.on?.('did-start-navigation', onNavigation);
      session.detach = () => {
        owner.removeListener?.('destroyed', onExit);
        owner.removeListener?.('render-process-gone', onExit);
        owner.removeListener?.('did-start-navigation', onNavigation);
      };
      try {
        await session.ready;
        if (session.cancelled) throw new Error('Video export cancelled.');
        return id;
      } catch (error) {
        await abort(owner, id);
        throw error;
      }
    },

    async write(owner, id, data) {
      const session = getSession(owner, id);
      if (session.closing || session.writing || session.error) throw new Error('Video export writer is unavailable.');
      if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_CHUNK_BYTES) throw new Error('Invalid video export chunk.');
      const buffer = Buffer.from(data);
      const writing = (async () => {
        await session.ready;
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await session.handle.write(buffer, offset, buffer.length - offset);
          if (bytesWritten <= 0) throw new Error('Could not write video export chunk.');
          offset += bytesWritten;
        }
      })();
      session.writing = writing;
      try {
        await writing;
        return true;
      } catch (error) {
        session.error = error;
        throw error;
      } finally {
        session.writing = null;
      }
    },

    async finish(owner, id) {
      const session = getSession(owner, id);
      if (session.closing) throw new Error('Video export is already closing.');
      await finalize(session, true);
      return true;
    },
    abort,
    abortOwner,
  };
}

module.exports = { createVideoExportFileWriter };
