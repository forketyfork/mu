import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const BRAG_FILE_LIMIT = 64 * 1024;
export const BRAG_FILE_COUNT_LIMIT = 5000;

/** @type {[string, RegExp][]} */
const KINDS = [
  ['day', /^\d{4}-\d{2}-\d{2}$/],
  ['week', /^\d{4}-W\d{2}$/],
  ['month', /^\d{4}-\d{2}$/],
];

// ISO years have 52 weeks, or 53 when they start on a Thursday, or on a Wednesday in a leap year.
const weeksInYear = (year) => {
  const weekday = (y) => new Date(Date.UTC(y, 0, 1)).getUTCDay();
  const leap = new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1;
  return weekday(year) === 4 || (leap && weekday(year) === 3) ? 53 : 52;
};

const validDate = (name) => {
  const date = new Date(`${name}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(name);
};

// Reads the brag directory: `YYYY-MM-DD.md` day files, and optional `YYYY-Www.md` and `YYYY-MM.md` highlights.
// Other names, oversized files and impossible dates are returned in `skipped` with the reason, not hidden: the
// dreams write these files by hand, and a typo in a name must be visible to the person who wrote it.
// A missing directory is an empty brag doc; any other read failure propagates. A symbolic link in place of the
// directory is refused, and so is one in place of a file: agents can write here, and a link must not lead the
// service to a file that they cannot read.
export async function readBrag(directory) {
  const result = { days: [], weeks: [], months: [], skipped: [] };
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }
  if (!info.isDirectory()) throw new Error('The brag directory is not a directory; symbolic links are not followed');
  const names = (await readdir(directory)).sort();
  for (const file of names.slice(BRAG_FILE_COUNT_LIMIT))
    result.skipped.push({ file, reason: `beyond the first ${BRAG_FILE_COUNT_LIMIT} files` });
  for (const file of names.slice(0, BRAG_FILE_COUNT_LIMIT)) {
    const match = file.match(/^(.+)\.md$/);
    const kind = match && KINDS.find(([, pattern]) => pattern.test(match[1]))?.[0];
    if (!kind) {
      result.skipped.push({ file, reason: 'not a YYYY-MM-DD.md, YYYY-Www.md or YYYY-MM.md file' });
      continue;
    }
    const key = match[1];
    if (kind === 'day' && !validDate(key)) {
      result.skipped.push({ file, reason: 'not a calendar date' });
      continue;
    }
    if (kind === 'week' && (Number(key.slice(6)) < 1 || Number(key.slice(6)) > weeksInYear(Number(key.slice(0, 4))))) {
      result.skipped.push({ file, reason: 'not an ISO week of that year' });
      continue;
    }
    if (kind === 'month' && (Number(key.slice(5)) < 1 || Number(key.slice(5)) > 12)) {
      result.skipped.push({ file, reason: 'not a month' });
      continue;
    }
    const entry = await lstat(join(directory, file));
    if (entry.isSymbolicLink()) {
      result.skipped.push({ file, reason: 'a symbolic link; links are not followed' });
      continue;
    }
    if (!entry.isFile()) {
      result.skipped.push({ file, reason: 'not a regular file' });
      continue;
    }
    let handle;
    try {
      handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code !== 'ELOOP' && error.code !== 'EMLINK') throw error;
      result.skipped.push({ file, reason: 'a symbolic link; links are not followed' });
      continue;
    }
    try {
      if (!(await handle.stat()).isFile()) {
        result.skipped.push({ file, reason: 'not a regular file' });
        continue;
      }
      const buffer = Buffer.alloc(BRAG_FILE_LIMIT + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > BRAG_FILE_LIMIT) {
        result.skipped.push({ file, reason: `larger than ${BRAG_FILE_LIMIT / 1024} KiB` });
        continue;
      }
      result[`${kind}s`].push({ key, source: buffer.toString('utf8', 0, bytesRead) });
    } finally {
      await handle.close();
    }
  }
  return result;
}
