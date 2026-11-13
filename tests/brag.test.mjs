import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAG_FILE_COUNT_LIMIT, BRAG_FILE_LIMIT, readBrag } from '../src/brag.mjs';
import { createApp } from '../src/server.mjs';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { bragSections } from '../public/brag-view.js';
import { decorateMarkdown, sanitizeMarkdown } from '../public/markdown-core.js';
import { groupBrag, periodLabel } from '../public/brag.js';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';

class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
  }
  async start() {}
  async connect() {}
  async syncConversation() {}
  close() {}
}

test('a missing brag directory is an empty brag doc', async (t) => {
  const directory = await shortTempDir(t, 'brag');
  assert.deepEqual(await readBrag(join(directory, 'brag')), { days: [], weeks: [], months: [], skipped: [] });
});

test('readBrag sorts files by kind and reports every file it ignores with a reason', async (t) => {
  const directory = await shortTempDir(t, 'brag');
  await writeFile(join(directory, '2026-11-05.md'), '- a\n');
  await writeFile(join(directory, '2026-11-04.md'), '- b\n');
  await writeFile(join(directory, '2026-W45.md'), '- week\n');
  await writeFile(join(directory, '2026-11.md'), '- month\n');
  await writeFile(join(directory, '2026-02-30.md'), '- impossible\n');
  await writeFile(join(directory, '2026-W54.md'), '- impossible\n');
  await writeFile(join(directory, '2025-W53.md'), '- impossible\n');
  await writeFile(join(directory, '2026-W53.md'), '- a long year\n');
  await writeFile(join(directory, '2026-13.md'), '- impossible\n');
  await writeFile(join(directory, 'notes.md'), '- stray\n');
  await writeFile(join(directory, '2026-11-03.md'), 'x'.repeat(BRAG_FILE_LIMIT + 1));
  await mkdir(join(directory, '2026-11-02.md'));
  await writeFile(join(directory, 'target.txt'), '- secret\n');
  await symlink(join(directory, 'target.txt'), join(directory, '2026-11-01.md'));
  const brag = await readBrag(directory);
  assert.deepEqual(
    brag.days.map(({ key }) => key),
    ['2026-11-04', '2026-11-05'],
  );
  assert.deepEqual(brag.weeks, [
    { key: '2026-W45', source: '- week\n' },
    { key: '2026-W53', source: '- a long year\n' },
  ]);
  assert.deepEqual(brag.months, [{ key: '2026-11', source: '- month\n' }]);
  assert.deepEqual(brag.skipped.map(({ file }) => file).sort(), [
    '2025-W53.md',
    '2026-02-30.md',
    '2026-11-01.md',
    '2026-11-02.md',
    '2026-11-03.md',
    '2026-13.md',
    '2026-W54.md',
    'notes.md',
    'target.txt',
  ]);
});

test('GET /api/brag serves the brag directory to the user only', async (t) => {
  const directory = await shortTempDir(t, 'brag'),
    port = await freePort();
  await mkdir(join(directory, 'brag'));
  await writeFile(join(directory, 'brag', '2026-11-06.md'), '- **Shipped** it\n');
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: directory,
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${port}`;
  const response = await fetch(`${url}/api/brag`, { headers: userHeaders(app) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).days, [{ key: '2026-11-06', source: '- **Shipped** it\n' }]);
  assert.equal((await fetch(`${url}/api/brag`)).status, 401);
  const agent = await fetch(`${url}/api/brag`, {
    headers: { Authorization: `Bearer ${app.identity.issue('worker')}` },
  });
  assert.equal(agent.status, 403);
});

test('groupBrag lists written pages of each scale newest first and drops empty files', () => {
  const grouped = groupBrag({
    days: [
      { key: '2026-11-04', source: 'a' },
      { key: '2026-11-06', source: 'b' },
      { key: '2026-11-05', source: '  \n' },
    ],
    weeks: [
      { key: '2026-W44', source: 'w' },
      { key: '2026-W45', source: 'x' },
    ],
  });
  assert.deepEqual(
    grouped.day.map(({ key }) => key),
    ['2026-11-06', '2026-11-04'],
  );
  assert.deepEqual(
    grouped.week.map(({ key }) => key),
    ['2026-W45', '2026-W44'],
  );
  assert.deepEqual(grouped.month, []);
});

test('a week or month page exists only when its file was written', () => {
  const grouped = groupBrag({ days: [{ key: '2026-11-06', source: 'Shipped things.' }] });
  assert.equal(grouped.week.length, 0);
  assert.equal(grouped.month.length, 0);
});

test('period labels name the day, ISO week and month', () => {
  assert.equal(periodLabel('month', '2026-11'), 'November 2026');
  assert.equal(periodLabel('week', '2026-W05'), 'Week 5, 2026');
  assert.match(periodLabel('day', '2026-11-06'), /Friday.*6 November 2026/);
});

test('readBrag refuses a symbolic link in place of the directory and caps the number of files', async (t) => {
  const directory = await shortTempDir(t, 'brag');
  await mkdir(join(directory, 'real'));
  await symlink(join(directory, 'real'), join(directory, 'linked'));
  await assert.rejects(readBrag(join(directory, 'linked')), /not a directory/);
  const many = join(directory, 'many');
  await mkdir(many);
  for (let i = 0; i < BRAG_FILE_COUNT_LIMIT + 3; i++)
    await writeFile(join(many, `n${String(i).padStart(5, '0')}.txt`), '');
  const brag = await readBrag(many);
  assert.equal(brag.skipped.length, BRAG_FILE_COUNT_LIMIT + 3);
  assert.equal(brag.skipped.filter(({ reason }) => /beyond the first/.test(reason)).length, 3);
});

function dom() {
  const window = new JSDOM('').window;
  const purifier = createDOMPurify(window);
  const pageElement = (source) => {
    const element = window.document.createElement('div');
    element.innerHTML = sanitizeMarkdown(source, {
      parse: marked.parse,
      sanitize: purifier.sanitize,
      forbidTags: ['img'],
    });
    decorateMarkdown(element, {
      resolveCode: (text) => {
        if (text !== 'task-1a2b3c4d') return null;
        const link = window.document.createElement('a');
        link.textContent = 'task link';
        return link;
      },
    });
    return element;
  };
  return { window, pageElement };
}

test('brag pages render nothing without workspace state and build task links once it exists', () => {
  const { window, pageElement } = dom();
  const data = groupBrag({
    days: [{ key: '2026-11-06', source: 'The team shipped the view, `task-1a2b3c4d`.\n\nSecond paragraph.' }],
  });
  const args = { document: window.document, data, scale: 'day', pageElement };
  assert.equal(bragSections({ ...args, state: null }), null);
  assert.equal(bragSections({ ...args, state: {}, data: null }), null);
  const [section] = bragSections({ ...args, state: {} });
  assert.equal(section.querySelectorAll('a').length, 1);
  assert.equal(section.querySelectorAll('p').length, 2);
  assert.match(section.querySelector('h3').textContent, /6 November 2026/);
  assert.deepEqual(bragSections({ ...args, state: {}, scale: 'week' }), []);
});

test('brag pages are inert: no images, raw HTML, script URLs or event handlers', () => {
  const { window, pageElement } = dom();
  const element = pageElement(
    '![pixel](https://evil.example/x.png) <img src=https://evil.example/y.png onerror=alert(1)> <script>alert(1)</script> <b onclick=alert(1)>raw</b> [js](javascript:alert(1)) [data](data:text/html,x) [ok](https://example.com/a)',
  );
  try {
    assert.equal(element.querySelectorAll('img, script, b').length, 0);
    assert.equal(element.querySelector('[onclick], [onerror]'), null);
    assert.deepEqual([...element.querySelectorAll('a')].map((link) => link.getAttribute('href')).filter(Boolean), [
      'https://example.com/a',
    ]);
  } finally {
    window.close();
  }
});
