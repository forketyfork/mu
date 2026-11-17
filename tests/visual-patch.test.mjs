import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PATCH_LIMITS, parsePatch, patchLine } from '../src/visual-patch.mjs';
import {
  RICH_BLOCKS,
  checkPatches,
  codeLanguage,
  parseBlocks,
  validateSection,
  visibleParts,
} from '../src/visual-format.mjs';
import { lineRow, quoteOf, textIndex } from '../public/visual/anchor.js';
import { createPatches } from '../public/visual/patch.js';
import { createRenderer } from '../public/visual/render.js';

const lines = (...rows) => rows.join('\n');

// What `git diff -M` prints for a change, a new file, a deleted one, a rename with a change, a mode change and a
// binary file.
const GIT_DIFF = lines(
  'diff --git a/src/store.mjs b/src/store.mjs',
  'index 3b18e51..a9c4d2f 100644',
  '--- a/src/store.mjs',
  '+++ b/src/store.mjs',
  '@@ -10,4 +10,5 @@ export function open(path) {',
  '   const db = new Database(path);',
  '-  db.exec(SCHEMA);',
  '+  db.exec(SCHEMA_V2);',
  '+  migrate(db);',
  ' ',
  '   return db;',
  '@@ -40,2 +41,2 @@ function close(db) {',
  '-  db.close()',
  '+  db.close();',
  '   }',
  'diff --git a/docs/new.md b/docs/new.md',
  'new file mode 100644',
  'index 0000000..e69de29',
  '--- /dev/null',
  '+++ b/docs/new.md',
  '@@ -0,0 +1,2 @@',
  '+# New',
  '+text',
  '\\ No newline at end of file',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index e69de29..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/lib/a.js b/lib/b.js',
  'similarity index 90%',
  'rename from lib/a.js',
  'rename to lib/b.js',
  'index 1111111..2222222 100644',
  '--- a/lib/a.js',
  '+++ b/lib/b.js',
  '@@ -3 +3 @@',
  '-export const name = "a";',
  '+export const name = "b";',
  'diff --git a/run.sh b/run.sh',
  'old mode 100644',
  'new mode 100755',
  'diff --git a/logo.png b/logo.png',
  'index 1234567..89abcde 100644',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git a/moved.txt b/renamed.txt',
  'similarity index 100%',
  'rename from moved.txt',
  'rename to renamed.txt',
);

test('a patch block reads git diff output into files, hunks and numbered lines', () => {
  const { files } = parsePatch(GIT_DIFF);
  assert.deepEqual(
    files.map(({ path, oldPath, newPath, status }) => ({ path, oldPath, newPath, status })),
    [
      { path: 'src/store.mjs', oldPath: 'src/store.mjs', newPath: 'src/store.mjs', status: 'modified' },
      { path: 'docs/new.md', oldPath: null, newPath: 'docs/new.md', status: 'added' },
      { path: 'old.txt', oldPath: 'old.txt', newPath: null, status: 'deleted' },
      { path: 'lib/b.js', oldPath: 'lib/a.js', newPath: 'lib/b.js', status: 'renamed' },
      { path: 'run.sh', oldPath: 'run.sh', newPath: 'run.sh', status: 'modified' },
      { path: 'logo.png', oldPath: 'logo.png', newPath: 'logo.png', status: 'modified' },
      { path: 'renamed.txt', oldPath: 'moved.txt', newPath: 'renamed.txt', status: 'renamed' },
    ],
  );
  const [store, added] = files;
  assert.deepEqual(
    store.hunks.map(({ oldStart, oldCount, newStart, newCount, heading }) => [
      oldStart,
      oldCount,
      newStart,
      newCount,
      heading,
    ]),
    [
      [10, 4, 10, 5, 'export function open(path) {'],
      [40, 2, 41, 2, 'function close(db) {'],
    ],
  );
  assert.deepEqual(store.hunks[0].lines, [
    { kind: 'context', text: '  const db = new Database(path);', old: 10, new: 10 },
    { kind: 'delete', text: '  db.exec(SCHEMA);', old: 11, new: null },
    { kind: 'add', text: '  db.exec(SCHEMA_V2);', old: null, new: 11 },
    { kind: 'add', text: '  migrate(db);', old: null, new: 12 },
    { kind: 'context', text: '', old: 12, new: 13 },
    { kind: 'context', text: '  return db;', old: 13, new: 14 },
  ]);
  assert.deepEqual(added.hunks[0].lines.at(-1), { kind: 'add', text: 'text', old: null, new: 2, noNewline: true });
  assert.deepEqual([files[4].oldMode, files[4].newMode], ['100644', '100755']);
  assert.equal(files[5].binary, true);
  assert.equal(files[6].hunks.length, 0);
});

test('a patch block also reads diff -u output, CRLF line ends and a blank context line without its space', () => {
  const { files } = parsePatch(
    lines(
      '--- a.txt\t2026-11-17 01:00:00.000000000 +0100',
      '+++ b.txt\t2026-11-17 01:05:00.000000000 +0100',
      '@@ -1,3 +1,3 @@',
      ' one',
      '',
      '-three',
      '+THREE',
      '--- c.txt',
      '+++ c.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ).replaceAll('\n', '\r\n'),
  );
  assert.deepEqual(
    files.map((file) => [file.oldPath, file.newPath]),
    [
      ['a.txt', 'b.txt'],
      ['c.txt', 'c.txt'],
    ],
  );
  assert.deepEqual(files[0].hunks[0].lines[1], { kind: 'context', text: '', old: 2, new: 2 });
});

test('a comment names a line by its path, side and number', () => {
  const patch = parsePatch(GIT_DIFF);
  assert.equal(patchLine(patch, { path: 'src/store.mjs', side: 'new', number: 12 }).text, '  migrate(db);');
  assert.equal(patchLine(patch, { path: 'src/store.mjs', side: 'old', number: 11 }).text, '  db.exec(SCHEMA);');
  // A line of context has a number on both sides.
  assert.equal(patchLine(patch, { path: 'src/store.mjs', side: 'old', number: 13 }).text, '  return db;');
  assert.equal(patchLine(patch, { path: 'src/store.mjs', side: 'new', number: 14 }).text, '  return db;');
  assert.equal(patchLine(patch, { path: 'src/store.mjs', side: 'new', number: 30 }), null);
  assert.equal(patchLine(patch, { path: 'src/store.mjs', side: 'old', number: 12.5 }), null);
  assert.equal(patchLine(patch, { path: 'lib/a.js', side: 'old', number: 3 }), null, 'a file is named by its new path');
  assert.equal(patchLine(patch, { path: 'old.txt', side: 'old', number: 1 }).text, 'gone');
  assert.equal(patchLine(patch, { path: 'constructor', side: 'old', number: 1 }), null);
});

test('a patch that is not git diff output is refused with the line that does not fit', () => {
  const refused = (text, pattern) => assert.throws(() => parsePatch(text), pattern);
  refused('', /has no file/);
  refused('   \n', /has no file/);
  // The kind of snippet an author writes into a ```diff block of highlighted code.
  refused(lines('+function a() {', '+}', '...'), /^Error: Patch line 1: this is not a line of `git diff` output/);
  refused(lines('commit 1234', 'Author: x', '', 'diff --git a/a b/a'), /Patch line 1: this is not a line/);
  refused(lines('--- a', '@@ -1 +1 @@'), /Patch line 2: a `---` line is followed by a `\+\+\+` line/);
  refused(lines('--- a', '+++ b', '@@ -1 +1 @'), /Patch line 3: a hunk starts with a line like/);
  refused(lines('diff --git a/a b/a', '@@ -1 +1 @@', '-x', '+y'), /Patch line 2: a hunk follows the `---`/);
  refused(lines('--- a', '+++ a', '@@ -1,2 +1,2 @@', ' x', '+y'), /Patch line 5: the hunk of line 3 ends 1 old and 0/);
  refused(lines('--- a', '+++ a', '@@ -1 +1 @@', ' x', ' y'), /Patch line 5: this is not a line/);
  refused(
    lines('--- a', '+++ a', '@@ -1,2 +1 @@', '-x', '+y', '+z'),
    /Patch line 6: the hunk of line 3 expects 1 more old and 0/,
  );
  refused(lines('--- a', '+++ a', '@@ -1 +1 @@', '*x'), /Patch line 4: the hunk of line 3 expects/);
  refused(lines('--- a', '+++ a', '@@ -0,1 +1 @@', '-x', '+y'), /starts at line 1 or later/);
  refused(lines('--- a', '+++ a', '@@ -1,0 +1,0 @@'), /at least one line/);
  refused(lines('--- a', '+++ a', '@@ -1 +1 @@', '-x', '+y', '\\ No newline', '\\ No newline'), /a `\\` line follows/);
  refused(lines('--- a', '+++ a', '\\ No newline'), /a `\\` line follows/);
  refused(lines('--- a', '+++ a', '@@ -1 +1 @@', '\\ No newline', '-x', '+y'), /Patch line 4: a `\\` line follows/);
  refused(
    lines('--- a', '+++ a', '@@ -1 +1 @@', '-x', '\\ No newline', '\\ No newline', '+y'),
    /Patch line 6: a `\\` line follows/,
  );
  refused(
    lines('--- a', '+++ a', '@@ -0,0 +1,2 @@', '+a', ' b'),
    /Patch line 5: the hunk of line 3 expects 0 more old/,
  );
  refused(
    lines('--- a', '+++ a', '@@ -1,2 +0,0 @@', '-a', ' b'),
    /Patch line 5: the hunk of line 3 expects 1 more old/,
  );
  refused(lines('--- a', '+++ a', '@@ -1 +1 @@', '-x', '+y', '', '\\ No newline'), /Patch line 7: a `\\` line follows/);
  refused(
    lines('--- a', '+++ a', '@@ -5 +5 @@', '-x', '+y', '@@ -4 +6 @@', '-x', '+y'),
    /Patch line 6: the hunk starts before/,
  );
  refused(lines('--- a', '+++ a', '@@ -1,2 +1,2 @@', '-x', '-y', '+x', '+y', '@@ -2 +3 @@', '-x', '+y'), /before/);
  refused(
    lines('--- a', '+++ a', '@@ -1 +1 @@', '-x', '+y', '--- a', '+++ a', '@@ -3 +3 @@', '-x', '+y'),
    /Patch line 6: the file a is in this patch twice/,
  );
  refused(lines('diff --git a/a b/a', 'index 1..2 100644'), /Patch line 1: the file a has no change/);
  refused(lines('diff --cc a', 'index 1,2..3'), /combined diff of a merge/);
  refused(lines('diff --git a/a b/a', 'index 1..2', 'GIT binary patch', 'literal 1'), /binary patch is not shown/);
  refused(lines('--- a', '+++ /dev/null‮', '@@ -1 +0,0 @@', '-x'), /not shown \(U\+202E\)/);
  refused(lines(`--- ${'p'.repeat(401)}`, '+++ /dev/null', '@@ -1 +0,0 @@', '-x'), /longer than 400 characters/);
  refused(lines('--- a', '+++ a', `@@ -1 +1 @@ ${'h'.repeat(201)}`, '-x', '+y'), /longer than 200 characters/);
  refused(lines('--- a', '+++ a', '@@ -1000000001 +1 @@', '-x', '+y'), /at most 1000000000/);
  // Hunks that overlap on the new side only.
  refused(
    lines('--- a', '+++ a', '@@ -1,1 +1,1 @@', '-a', '+first', '@@ -5,1 +1,1 @@', '-b', '+second'),
    /Patch line 6: the hunk starts before/,
  );
  // The old path of a rename or a copy names a file in the head, so it is checked like the new one.
  for (const kind of ['rename', 'copy'])
    refused(
      lines('diff --git a/a b/b', 'similarity index 90%', `${kind} from a‮`, `${kind} to b`),
      /Patch line 1: the old path holds a character that is not shown \(U\+202E\)/,
    );
});

test('a mode line holds a git file mode and nothing else, since the head of the file shows it', () => {
  const modes = (...heads) =>
    parsePatch(
      lines('diff --git a/run.sh b/run.sh', ...heads, '--- a/run.sh', '+++ b/run.sh', '@@ -1 +1 @@', '-x', '+y'),
    ).files[0];
  const { oldMode, newMode } = modes('old mode 100644', 'new mode 100755');
  assert.deepEqual([oldMode, newMode], ['100644', '100755']);
  assert.equal(
    parsePatch(lines('diff --git a/a b/a', 'new file mode 120000', '--- /dev/null', '+++ b/a', '@@ -0,0 +1 @@', '+x'))
      .files[0].status,
    'added',
  );
  assert.equal(
    parsePatch(
      lines('diff --git a/a b/a', 'deleted file mode 160000', '--- a/a', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'),
    ).files[0].status,
    'deleted',
  );
  for (const line of ['old mode', 'new mode', 'new file mode', 'deleted file mode'])
    for (const value of ['100644‮', '100644 and the file is now run by hand', '10064', '100648', ' 100644'])
      assert.throws(
        () => parsePatch(lines('diff --git a/a b/a', `${line} ${value}`)),
        new RegExp(`^Error: Patch line 2: \`${line}\` is followed by a mode of six octal digits, like 100644$`),
        `${line} ${value}`,
      );
});

test('a patch takes exactly as many files and lines as its limits say', () => {
  const file = (index, rows) => [
    `--- f${index}`,
    `+++ f${index}`,
    `@@ -1,${rows} +1,${rows} @@`,
    ...Array(rows).fill(' x'),
  ];
  const files = (count, rows) =>
    Array.from({ length: count }, (_, index) => file(index, rows))
      .flat()
      .join('\n');
  assert.equal(parsePatch(files(PATCH_LIMITS.files, 1)).files.length, PATCH_LIMITS.files);
  assert.throws(() => parsePatch(files(PATCH_LIMITS.files + 1, 1)), /at most 100 files/);
  assert.equal(parsePatch(files(2, PATCH_LIMITS.lines / 2)).files.length, 2);
  assert.throws(
    () => parsePatch(files(2, PATCH_LIMITS.lines / 2) + '\n' + file(9, 1).join('\n')),
    /at most 5000 lines/,
  );
  const longest = 'p'.repeat(PATCH_LIMITS.pathChars);
  assert.equal(parsePatch(lines(`--- ${longest}`, '+++ /dev/null', '@@ -1 +0,0 @@', '-x')).files[0].path, longest);
  const heading = 'h'.repeat(PATCH_LIMITS.headingChars);
  assert.equal(
    parsePatch(lines('--- a', '+++ a', `@@ -1 +1 @@ ${heading}`, '-x', '+y')).files[0].hunks[0].heading,
    heading,
  );
});

test('the patch blocks of one version take exactly as many lines together as the frame draws in a moment', () => {
  const section = (id, rows) => ({
    id,
    title: id,
    body: lines('Text.', '```patch', '--- a', '+++ a', `@@ -1,${rows} +1,${rows} @@`, ...Array(rows).fill(' x'), '```'),
  });
  const full = Array.from({ length: PATCH_LIMITS.visualLines / PATCH_LIMITS.lines }, (_, index) =>
    section(`s${index}`, PATCH_LIMITS.lines),
  );
  checkPatches([...full, { id: 'prose', title: 'Prose', body: 'No patch here.' }]);
  assert.throws(
    () => checkPatches([...full, section('more', 1)]),
    /^Error: A visual shows at most 20000 lines of code changes in all its patch blocks; section more goes past that/,
  );
});

test('a patch is read in time proportional to its length', () => {
  // A hunk header of a long run of digits and spaces, and a long line, must not make the pattern backtrack.
  const started = performance.now();
  for (const text of [
    `--- a\n+++ a\n@@ -${'1'.repeat(100_000)}`,
    `--- a\n+++ a\n@@ -1 +1 @@${' '.repeat(100_000)}x`,
    `--- a\n+++ a\n@@ -1 +1 @@\n-${'x'.repeat(100_000)}\n+y`,
  ])
    try {
      parsePatch(text);
    } catch {
      // Refused or not, it must be quick.
    }
  assert.ok(performance.now() - started < 200);
});

test('a character that a reader does not see is cut out of a line as its code point, and a tab or emoji stays', () => {
  assert.deepEqual(visibleParts('a‮b​'), [
    { text: 'a', unseen: false },
    { text: 'U+202E', unseen: true },
    { text: 'b', unseen: false },
    { text: 'U+200B', unseen: true },
  ]);
  assert.deepEqual(visibleParts('\tx = "👩‍💻 ⚠️"'), [{ text: '\tx = "👩‍💻 ⚠️"', unseen: false }]);
  assert.deepEqual(visibleParts('\u{E0041}'), [{ text: 'U+E0041', unseen: true }]);
  assert.deepEqual(visibleParts(''), []);
  // A joiner that joins no pictographs is shown.
  assert.deepEqual(
    visibleParts('a‍b').map((part) => part.text),
    ['a', 'U+200D', 'b'],
  );
});

test('a ```patch fence is a patch block, checked when a visual is written, and a ```diff fence stays highlighted code', () => {
  assert.ok(Object.hasOwn(RICH_BLOCKS, 'patch'));
  const body = lines(
    '```diff',
    '+snippet',
    '...',
    '```',
    '',
    '```patch',
    '--- a',
    '+++ a',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '```',
  );
  assert.deepEqual(
    parseBlocks(body).map((block) => block.type),
    ['markdown', 'patch'],
  );
  assert.equal(codeLanguage('diff'), 'diff');
  assert.equal(codeLanguage('patch'), null);
  validateSection({ id: 'review', title: 'Review', body });
  assert.throws(
    () => validateSection({ id: 'review', title: 'Review', body: lines('```patch', '+snippet', '```') }),
    /^Error: Section review: Patch line 1: this is not a line of `git diff` output/,
  );
});

const HOSTILE = '<img src=x onerror="window.injected = true">';

function drawn(t, text) {
  const { window } = new JSDOM('<!doctype html><main id="document"></main>');
  t.after(() => window.close());
  const { document } = window;
  const patches = createPatches({ document, parsePatch, visibleParts });
  const renderer = createRenderer({
    document,
    parseBlocks,
    markdownHtml: (source) => `<p>${source}</p>`,
    richBlocks: { patch: patches.render },
  });
  const container = document.getElementById('document');
  renderer.render(container, {
    sections: [{ id: 'review', title: 'Review', rev: 'r1', body: `\`\`\`patch\n${text}\n\`\`\`` }],
  });
  return { window, document, figure: container.querySelector('.visual-patch') };
}

test('a patch is drawn as text, row by row, with its numbers and signs outside the text of the block', async (t) => {
  const { window, document, figure } = drawn(
    t,
    lines(
      `diff --git a/${HOSTILE} b/${HOSTILE}`,
      `--- a/${HOSTILE}`,
      `+++ b/${HOSTILE}`,
      `@@ -1,2 +1,2 @@ ${HOSTILE} \u202Eend`,
      ` ${HOSTILE}`,
      '-if (admin‮) {',
      '+if (admin) {',
      '\\ No newline at end of file',
      GIT_DIFF,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(figure.classList.contains('failed'), false);
  assert.equal(window.injected, undefined);
  assert.equal(figure.querySelector('img'), null);
  const [first, ...others] = figure.querySelectorAll('.patch-file');
  assert.equal(first.querySelector('.patch-path').textContent, HOSTILE);
  assert.deepEqual(
    [...first.querySelectorAll('tr')].map((row) => [row.className, row.textContent]),
    [
      ['patch-hunk-head', `@@ -1,2 +1,2 @@ ${HOSTILE} U+202Eend`],
      ['patch-line context', `${HOSTILE}\n`],
      ['patch-line delete', 'if (adminU+202E) {\n'],
      ['patch-line add', 'if (admin) {\n'],
    ],
  );
  // The override is shown, not obeyed: no element holds it.
  assert.equal(figure.textContent.includes('‮'), false);
  assert.deepEqual(
    [...first.querySelectorAll('.patch-unseen')].map((badge) => [badge.closest('td').className, badge.textContent]),
    [
      ['', 'U+202E'],
      ['patch-code', 'U+202E'],
    ],
  );
  assert.ok(first.querySelector('.patch-line.add .patch-code').classList.contains('no-newline'));
  const signs = [...first.querySelectorAll('.patch-code')].map((code) => code.dataset.sign);
  assert.deepEqual(signs, [' ', '-', '+']);
  // Each number is a button that names its line; the number is drawn from the attribute.
  const gutters = [...first.querySelectorAll('.patch-line')].map((row) =>
    [...row.querySelectorAll('.patch-gutter')].map((button) => [
      button.dataset.side,
      button.dataset.number,
      button.textContent,
      button.getAttribute('type'),
    ]),
  );
  assert.deepEqual(gutters, [
    [
      ['old', '1', '', 'button'],
      ['new', '1', '', 'button'],
    ],
    [['old', '2', '', 'button']],
    [['new', '2', '', 'button']],
  ]);
  assert.equal(
    first.querySelector('.patch-line.delete .patch-gutter').getAttribute('aria-label'),
    `Comment on old line 2 of ${HOSTILE}`,
  );

  // The other files: their heads say what happened to them.
  assert.deepEqual(
    others.map((file) => [...file.querySelectorAll('.patch-file-head > span')].map((span) => span.textContent)),
    [
      ['src/store.mjs'],
      ['docs/new.md', 'new file'],
      ['old.txt', 'deleted'],
      ['lib/b.js', 'renamed from lib/a.js'],
      ['run.sh', 'mode 100644 → 100755'],
      ['logo.png', 'binary, not shown'],
      ['renamed.txt', 'renamed from moved.txt'],
    ],
  );
  assert.equal(others[4].querySelector('table'), null);

  // A comment finds its row by the attributes; a quote of selected rows holds only their code, line by line.
  const row = lineRow(figure, { path: 'src/store.mjs', side: 'new', number: 12 });
  assert.equal(row.textContent, '  migrate(db);\n');
  assert.equal(lineRow(figure, { path: 'src/store.mjs', side: 'old', number: 12 }).textContent, '\n');
  assert.equal(lineRow(figure, { path: 'src/store.mjs', side: 'new', number: 99 }), null);
  // Each file has its own line 1.
  assert.equal(lineRow(figure, { path: 'docs/new.md', side: 'new', number: 1 }).textContent, '# New\n');
  assert.equal(lineRow(figure, { path: 'src/store.mjs', side: /** @type {any} */ ('__proto__'), number: 1 }), null);
  const range = document.createRange();
  range.setStart(row.previousElementSibling.querySelector('.patch-code').firstChild, 0);
  range.setEnd(row.querySelector('.patch-code').firstChild, 14);
  assert.deepEqual(quoteOf(figure, range, { quoteChars: 600, contextChars: 8 }), {
    text: 'db.exec(SCHEMA_V2);\n  migrate(db);',
    prefix: 'EMA);\n  ',
    suffix: '\n\n  retu',
  });
  assert.equal(/\d+\s*\d+\s*[-+]/.test(textIndex(row).text), false);
});

test('a patch that cannot be read is shown as a block that could not be drawn, with its text as text', async (t) => {
  const { figure } = drawn(t, `--- a\n+++ a\n${HOSTILE}`);
  await new Promise((resolve) => setTimeout(resolve));
  assert.ok(figure.classList.contains('failed'));
  assert.equal(figure.querySelector('img'), null);
  assert.match(figure.textContent, /Patch line 3/);
});
