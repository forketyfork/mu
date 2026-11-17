// The format of a patch block: the output of `git diff`, unchanged, parsed into files, hunks and lines with their old
// and new numbers. The service checks a patch when a visual is written, the frame draws the parsed lines, and a
// comment names a line by its file, side and number. Pure text functions, served to the visual frame with the other
// formats. See "Code reviews" in docs/architecture.md.
import { unseen } from './visual-spec.mjs';

export const PATCH_LIMITS = Object.freeze({
  files: 100,
  // The lines of all hunks of one block: what the frame draws as rows.
  lines: 5000,
  pathChars: 400,
  headingChars: 200,
  lineNumber: 1_000_000_000,
});

/**
 * @typedef {{ kind: 'context' | 'add' | 'delete', text: string, old: number | null, new: number | null, noNewline?: boolean }} PatchLine
 * @typedef {{ oldStart: number, oldCount: number, newStart: number, newCount: number, heading: string, lines: PatchLine[] }} PatchHunk
 * @typedef {{
 *   path: string, oldPath: string | null, newPath: string | null,
 *   status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied',
 *   oldMode?: string, newMode?: string, binary?: boolean, hunks: PatchHunk[],
 * }} PatchFile
 * @typedef {{ files: PatchFile[] }} Patch
 */

// The lines git writes between `diff --git` and the first hunk, and what each one says.
const EXTENDED = [
  'index ',
  'old mode ',
  'new mode ',
  'deleted file mode ',
  'new file mode ',
  'similarity index ',
  'dissimilarity index ',
  'rename from ',
  'rename to ',
  'copy from ',
  'copy to ',
  'Binary files ',
];
// Digits and fixed text only, so the pattern cannot backtrack on a long line.
const HUNK = /^@@ -(\d{1,10})(?:,(\d{1,10}))? \+(\d{1,10})(?:,(\d{1,10}))? @@(.*)$/;
const NULL_PATH = '/dev/null';

// A path as git writes it after `---`, `+++`, `rename from` and the like: maybe in quotes, maybe with the `a/` or `b/`
// of its side, and after `---` of `diff -u` maybe followed by a tab and a time.
function pathOf(raw, prefix) {
  let path = raw.split('\t')[0];
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (path === NULL_PATH) return null;
  return prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// The two paths of `diff --git a/x b/y`, for a file that has no `---` and `+++` lines: a change of its mode only, or a
// binary file. When the two paths are the same, the line is the path twice.
function gitPaths(rest) {
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ' && rest.slice(0, half).slice(2) === rest.slice(half + 1).slice(2))
    return [pathOf(rest.slice(0, half), 'a/'), pathOf(rest.slice(half + 1), 'b/')];
  const at = rest.indexOf(' b/');
  return at === -1 ? [rest, rest] : [pathOf(rest.slice(0, at), 'a/'), pathOf(rest.slice(at + 1), 'b/')];
}

/**
 * The files, hunks and lines of `git diff` output. Throws with the line of the patch that does not fit.
 * @param {string} text
 * @returns {Patch}
 */
export function parsePatch(text) {
  const rows = text.replace(/\r\n?/g, '\n').split('\n');
  /** @type {PatchFile[]} */
  const files = [];
  /** @type {any} The file that is read, with what its headers said so far. */
  let file = null;
  /** @type {(PatchHunk & { old: number, new: number, line: number }) | null} The hunk that still expects lines. */
  let hunk = null;
  let lines = 0;
  // The row that closed the last hunk: a `\` row can follow it.
  let closedAt = -1;
  const fail = (at, message) => {
    throw new Error(`Patch line ${at + 1}: ${message}`);
  };

  const finish = (at) => {
    if (!file) return;
    if (file.minus !== undefined && file.plus === undefined) fail(at, 'a `---` line is followed by a `+++` line');
    const oldPath = file.minus !== undefined ? file.minus : (file.renameFrom ?? file.copyFrom ?? file.gitOld);
    const newPath = file.plus !== undefined ? file.plus : (file.renameTo ?? file.copyTo ?? file.gitNew);
    const status =
      oldPath === null || file.newMode !== undefined
        ? 'added'
        : newPath === null || file.deletedMode !== undefined
          ? 'deleted'
          : file.renameFrom !== undefined
            ? 'renamed'
            : file.copyFrom !== undefined
              ? 'copied'
              : 'modified';
    const path = newPath ?? oldPath;
    if (!path) fail(file.line, 'the file has no path');
    for (const [name, value] of [
      ['path', path],
      ['old path', oldPath],
    ]) {
      if (value === null) continue;
      if ([...value].length > PATCH_LIMITS.pathChars)
        fail(file.line, `the ${name} is longer than ${PATCH_LIMITS.pathChars} characters`);
      // A path names the file in the chat message that carries a comment on one of its lines.
      const hidden = unseen(value);
      if (hidden) fail(file.line, `the ${name} holds a character that is not shown (${hidden})`);
    }
    // A comment names a line by its path, so one path is one file.
    if (files.some((other) => other.path === path)) fail(file.line, `the file ${path} is in this patch twice`);
    if (!file.hunks.length && !file.binary && file.oldMode === undefined && status === 'modified')
      fail(file.line, `the file ${path} has no change`);
    files.push({
      path,
      oldPath,
      newPath,
      status,
      ...(file.oldMode !== undefined ? { oldMode: file.oldMode, newMode: file.changedMode } : {}),
      ...(file.newMode !== undefined ? { newMode: file.newMode } : {}),
      ...(file.binary ? { binary: true } : {}),
      hunks: file.hunks,
    });
    if (files.length > PATCH_LIMITS.files) fail(file.line, `a patch block holds at most ${PATCH_LIMITS.files} files`);
    file = null;
  };
  const start = (at, fields = {}) => {
    finish(at);
    file = { line: at, hunks: [], ...fields };
  };

  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at];
    if (hunk) {
      const kind = row === '' || row[0] === ' ' ? 'context' : row[0] === '+' ? 'add' : row[0] === '-' ? 'delete' : null;
      if (row[0] === '\\') {
        const last = hunk.lines.at(-1);
        if (!last || last.noNewline) fail(at, 'a `\\` line follows a line of a hunk');
        last.noNewline = true;
        continue;
      }
      if (kind === null || (kind !== 'add' && hunk.old === 0) || (kind !== 'delete' && hunk.new === 0))
        fail(
          at,
          `the hunk of line ${hunk.line + 1} expects ${hunk.old} more old and ${hunk.new} more new lines, and this line is not one of them`,
        );
      lines += 1;
      if (lines > PATCH_LIMITS.lines) fail(at, `a patch block holds at most ${PATCH_LIMITS.lines} lines of hunks`);
      const oldNumber = kind === 'add' ? null : hunk.oldStart + hunk.oldCount - hunk.old;
      const newNumber = kind === 'delete' ? null : hunk.newStart + hunk.newCount - hunk.new;
      if (kind !== 'add') hunk.old -= 1;
      if (kind !== 'delete') hunk.new -= 1;
      hunk.lines.push({ kind, text: row.slice(1), old: oldNumber, new: newNumber });
      if (!hunk.old && !hunk.new) {
        const { oldStart, oldCount, newStart, newCount, heading, lines: rowsOfHunk } = hunk;
        file.hunks.push({ oldStart, oldCount, newStart, newCount, heading, lines: rowsOfHunk });
        hunk = null;
        closedAt = at;
      }
      continue;
    }
    // A `\` line can follow the last line of a hunk, which has closed it.
    if (row[0] === '\\') {
      if (closedAt !== at - 1) fail(at, 'a `\\` line follows a line of a hunk');
      file.hunks.at(-1).lines.at(-1).noNewline = true;
      continue;
    }
    if (!row.trim()) continue;
    if (row.startsWith('diff --cc ') || row.startsWith('diff --combined '))
      fail(at, 'the combined diff of a merge is not shown; give the diff against one parent');
    if (row.startsWith('diff --git ')) {
      const [gitOld, gitNew] = gitPaths(row.slice('diff --git '.length));
      start(at, { git: true, gitOld, gitNew });
      continue;
    }
    if (row === 'GIT binary patch') fail(at, 'a binary patch is not shown; give the diff without --binary');
    const extended =
      file?.git && !file.hunks.length && file.minus === undefined && EXTENDED.find((head) => row.startsWith(head));
    if (extended) {
      const value = row.slice(extended.length);
      if (extended === 'old mode ') file.oldMode = value;
      else if (extended === 'new mode ') file.changedMode = value;
      else if (extended === 'new file mode ') file.newMode = value;
      else if (extended === 'deleted file mode ') file.deletedMode = value;
      else if (extended === 'rename from ') file.renameFrom = pathOf(value, '');
      else if (extended === 'rename to ') file.renameTo = pathOf(value, '');
      else if (extended === 'copy from ') file.copyFrom = pathOf(value, '');
      else if (extended === 'copy to ') file.copyTo = pathOf(value, '');
      else if (extended === 'Binary files ') file.binary = true;
      continue;
    }
    if (row.startsWith('--- ')) {
      // `diff -u` starts a file with `---`; after `diff --git` it belongs to the file that line started.
      if (!file || file.hunks.length || file.minus !== undefined) start(at);
      file.minus = pathOf(row.slice(4), 'a/');
      const next = rows[at + 1] ?? '';
      if (!next.startsWith('+++ ')) fail(at + 1, 'a `---` line is followed by a `+++` line');
      file.plus = pathOf(next.slice(4), 'b/');
      at += 1;
      continue;
    }
    if (row.startsWith('@@')) {
      const match = HUNK.exec(row);
      if (!match) fail(at, 'a hunk starts with a line like `@@ -12,7 +12,9 @@`');
      if (!file || file.plus === undefined) fail(at, 'a hunk follows the `---` and `+++` lines of its file');
      const [oldStart, oldCount, newStart, newCount] = [match[1], match[2] ?? '1', match[3], match[4] ?? '1'].map(
        Number,
      );
      if ([oldStart, oldCount, newStart, newCount].some((number) => number > PATCH_LIMITS.lineNumber))
        fail(at, `line numbers and counts are at most ${PATCH_LIMITS.lineNumber}`);
      if ((oldCount && !oldStart) || (newCount && !newStart)) fail(at, 'a hunk with lines starts at line 1 or later');
      if (!oldCount && !newCount) fail(at, 'a hunk has at least one line');
      // Each line of a file has one number on each side, so the hunks of a file follow each other.
      const previous = file.hunks.at(-1);
      const first = (begin, count) => (count ? begin : begin + 1);
      if (
        previous &&
        (first(oldStart, oldCount) < first(previous.oldStart, previous.oldCount) + previous.oldCount ||
          first(newStart, newCount) < first(previous.newStart, previous.newCount) + previous.newCount)
      )
        fail(at, 'the hunk starts before the hunk above it ends');
      const heading = match[5].trim();
      if ([...heading].length > PATCH_LIMITS.headingChars)
        fail(at, `the text after \`@@\` is longer than ${PATCH_LIMITS.headingChars} characters`);
      hunk = { oldStart, oldCount, newStart, newCount, heading, lines: [], old: oldCount, new: newCount, line: at };
      continue;
    }
    fail(at, 'this is not a line of `git diff` output; a file starts with `diff --git` or `---`, a hunk with `@@`');
  }
  if (hunk)
    fail(rows.length - 1, `the hunk of line ${hunk.line + 1} ends ${hunk.old} old and ${hunk.new} new lines early`);
  finish(rows.length - 1);
  if (!files.length) throw new Error('A patch block holds the output of `git diff`, and this one has no file');
  return { files };
}

/**
 * The line of a patch that a comment names, or null.
 * @param {Patch} patch
 * @param {{ path: string, side: 'old' | 'new', number: number }} line
 * @returns {PatchLine | null}
 */
export function patchLine(patch, { path, side, number }) {
  const file = patch.files.find((item) => item.path === path);
  if (!file) return null;
  for (const hunk of file.hunks) for (const line of hunk.lines) if (line[side] === number) return line;
  return null;
}
