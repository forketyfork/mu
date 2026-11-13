import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LOCK_FILE = 'service.lock';
// Who took the lock last. It is written after the lock is taken, so while the lock is held it names the holder.
export const HOLDER_FILE = 'service.lock.json';
const SQLITE_BUSY = 5;
// Node closes a database that is no longer referenced when it collects it, which would drop the lock unseen, so each
// held lock stays referenced here until it is released.
const held = new Set();

/**
 * Takes the data directory for one service process. A second service on the same directory would run its migrations
 * on the live database, issue credentials for the same agents and take their sockets. The lock is SQLite's exclusive
 * lock on a file of its own: an fcntl lock, which the kernel releases when the process ends, also after a crash, so
 * no stale lock is left to judge. SQLite keeps the locks of one process apart as well, so a second app in the same
 * process is refused too.
 * @param {string} dataDir
 * @param {{pid: number, root: string, port: number, startedAt: string}} holder
 */
export function lockDataDir(dataDir, holder) {
  const file = join(dataDir, LOCK_FILE);
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE');
  } catch (error) {
    db.close();
    if (/** @type {{errcode?: number}} */ (error).errcode !== SQLITE_BUSY)
      throw new Error(`Cannot lock the data directory ${dataDir} through ${file}: ${error.message}`, { cause: error });
    throw Object.assign(
      new Error(
        `Another Mu service uses the data directory ${dataDir}${describeHolder(dataDir)}. Stop it first, or give this service its own MU_DATA_DIR.`,
      ),
      { expected: true },
    );
  }
  try {
    writeFileSync(join(dataDir, HOLDER_FILE), `${JSON.stringify(holder)}\n`, { mode: 0o600 });
  } catch (error) {
    db.close();
    throw error;
  }
  held.add(db);
  return {
    release() {
      if (!held.delete(db)) return;
      db.close();
    },
  };
}

function describeHolder(dataDir) {
  const file = join(dataDir, HOLDER_FILE);
  let holder;
  try {
    holder = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return ` (its holder is not known: ${file} cannot be read: ${error.message})`;
  }
  return `: process ${holder.pid} from ${holder.root}, port ${holder.port}, started at ${holder.startedAt}`;
}
