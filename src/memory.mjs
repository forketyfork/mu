import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

// The lead's memory is plain files in the Mu home. The runner reads only the index, MEMORY.md, and puts it into the
// lead's turn prompt; the lead opens a fact's file itself. The index is a prompt, and the lead's own profile may write it,
// so each read refuses what would let the lead make Mu read something else: a symbolic link, a second hard link, or
// a file that another user can write.
export const MAX_MEMORY_INDEX_BYTES = 16 * 1024;
const NEWLINE = 0x0a;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** @typedef {{path: string, text: string, hash: string, cut: boolean, empty: boolean}} MemoryIndex */

function errorCode(error) {
  return /** @type {NodeJS.ErrnoException} */ (error).code;
}

async function checkDirectory(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new Error(
      errorCode(error) === 'ENOENT'
        ? `The lead's memory directory ${path} is missing; run node src/cli.mjs init from the user’s shell`
        : `Cannot inspect the lead's memory directory ${path}: ${/** @type {Error} */ (error).message}`,
      { cause: error },
    );
  }
  if (info.isSymbolicLink()) throw new Error(`The lead's memory directory ${path} must not be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`The lead's memory path ${path} is not a directory`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    throw new Error(`The lead's memory directory ${path} is not owned by the current user`);
  if ((info.mode & 0o022) !== 0) throw new Error(`The lead's memory directory ${path} is writable by another user`);
}

// The bytes are the first limit-plus-one bytes of the file. The delivered text ends at a line boundary, so a cut never leaves half of a fact's line; one long line without
// a newline is cut at a character boundary instead.
function cutText(bytes) {
  let end = bytes.lastIndexOf(NEWLINE);
  if (end <= 0) {
    end = MAX_MEMORY_INDEX_BYTES;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  }
  return UTF8.decode(bytes.subarray(0, end));
}

/** @returns {Promise<MemoryIndex>} */
export async function readLeadMemoryIndex(home) {
  await checkDirectory(join(home, 'memory'));
  await checkDirectory(join(home, 'memory/lead'));
  const path = join(home, 'memory/lead/MEMORY.md');
  let handle;
  try {
    // O_NOFOLLOW fails the open of a link at the index itself, even one planted after the directory checks. O_NONBLOCK keeps the
    // open of a FIFO without a writer from waiting forever; a regular file ignores it, and the check below refuses the FIFO.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === 'ENOENT')
      throw new Error(`The lead's memory index ${path} is missing; create it or run node src/cli.mjs init`, {
        cause: error,
      });
    if (errorCode(error) === 'ELOOP')
      throw new Error(`The lead's memory index ${path} must not be a symbolic link`, { cause: error });
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`The lead's memory index ${path} is not a regular file`);
    if (info.nlink > 1) throw new Error(`The lead's memory index ${path} has multiple hard links`);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid())
      throw new Error(`The lead's memory index ${path} is not owned by the current user`);
    if ((info.mode & 0o022) !== 0) throw new Error(`The lead's memory index ${path} is writable by another user`);
    // One byte more than the limit tells a file of exactly the limit from a longer one, without reading all of it.
    const buffer = Buffer.alloc(MAX_MEMORY_INDEX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const cut = length > MAX_MEMORY_INDEX_BYTES;
    let text;
    try {
      text = cut ? cutText(buffer) : UTF8.decode(buffer.subarray(0, length));
    } catch (error) {
      throw new Error(`The lead's memory index ${path} is not valid UTF-8 text`, { cause: error });
    }
    // A change after the cut is invisible to the lead, so it must not count as a change of what was delivered.
    const hash = createHash('sha256').update(`${cut}\n${text}`).digest('hex');
    return { path, text, hash, cut, empty: !text.trim() };
  } finally {
    await handle.close();
  }
}

// What the lead's turn prompt says about its memory. A session that already holds this index gets one line that names the file.
export function memoryPrompt(index, { known }) {
  if (known)
    return `Your memory index is unchanged since an earlier turn of this session gave you its text; it is in ${index.path}.\n`;
  const header = `Your memory index, from ${index.path}: one line per fact. Open a fact's file in the same directory when its line applies, and save new facts as your skill's "Remember as you go" says.\n`;
  if (index.empty) return `${header}The index is empty.\n`;
  const cutNote = index.cut
    ? `\nThe index is longer than ${MAX_MEMORY_INDEX_BYTES / 1024} KiB, and Mu cut it here. Prune it: merge or delete facts that no longer matter.\n`
    : '\n';
  return `${header}\n${index.text.trimEnd()}\n${cutNote}End of the memory index.\n`;
}
