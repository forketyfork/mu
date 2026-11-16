import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../src/server.mjs';
import { main } from '../src/cli.mjs';
import {
  CODE_LANGUAGES,
  LIMITS,
  documentSource,
  parseBlocks,
  parseDocument,
  validateSection,
} from '../src/visual-format.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { team } from './visuals-fixture.mjs';

const PLAN = `# Storage plan

Why we move.

## Overview {#overview}

Text with \`code\`.

## Flow

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

## Steps {#steps}

1. One
`;

test('a document splits into a title and sections with stable IDs', () => {
  const { title, sections } = parseDocument(PLAN);
  assert.equal(title, 'Storage plan');
  assert.deepEqual(
    sections.map(({ id, title: heading }) => [id, heading]),
    [
      ['intro', ''],
      ['overview', 'Overview'],
      ['flow', 'Flow'],
      ['steps', 'Steps'],
    ],
  );
  assert.equal(sections[0].body, 'Why we move.');
  assert.equal(sections[1].body, 'Text with `code`.');
  // What the author reads back parses to the same sections, so a section keeps its ID through an edit.
  assert.deepEqual(parseDocument(documentSource(title, sections)), { title, sections });
});

test('section IDs come from the heading, are unique, and a heading inside a fence starts nothing', () => {
  const { sections } = parseDocument(
    [
      '## Setup',
      '```sh',
      '## not a heading',
      '```',
      '## Setup',
      '~~~~',
      '```',
      '## still code',
      '~~~~',
      '## 1. Числа',
      '## Closed ##',
      '### Deeper stays inside',
    ].join('\n'),
  );
  assert.deepEqual(
    sections.map((section) => section.id),
    ['setup', 'setup-2', 's-1', 'closed'],
  );
  assert.match(sections[0].body, /## not a heading/);
  assert.match(sections[1].body, /## still code/);
  assert.equal(sections[3].title, 'Closed');
  assert.equal(sections[3].body, '### Deeper stays inside');
  assert.throws(() => parseDocument('## A {#same}\n## B {#same}'), /Line 2: section ID \{#same\} is used twice/);
  assert.throws(() => parseDocument('## A {#Bad_Id}'), /Line 1: section ID/);
  assert.throws(() => parseDocument('lead text\n## Lead {#intro}'), /used twice/);
});

test('a closing run of # ends a heading only after white space, and an ID is the last word of a heading', () => {
  const titleOf = (line) => parseDocument(`${line}\n\ntext`).title;
  assert.equal(titleOf('# C#'), 'C#');
  assert.equal(titleOf('#  Plan ##  '), 'Plan');
  assert.equal(titleOf('#\tPlan\t#'), 'Plan');
  assert.equal(titleOf('# Plan #1'), 'Plan #1');
  assert.equal(titleOf('#Plan'), null);
  assert.equal(titleOf('# \t '), null);
  const heading = (line) => {
    const [{ id, title }] = parseDocument(line).sections;
    return [id, title];
  };
  assert.deepEqual(heading('## C# {#c-sharp}'), ['c-sharp', 'C#']);
  assert.deepEqual(heading('##   Steps   {#steps} ##'), ['steps', 'Steps']);
  assert.deepEqual(heading('## {#only}'), ['only', '']);
  assert.deepEqual(heading('## Use {#a} here'), ['use-a-here', 'Use {#a} here']);
  assert.deepEqual(heading('## Map {#a b}'), ['map-a-b', 'Map {#a b}']);
  assert.deepEqual(heading('## Set {#a}}'), ['set-a', 'Set {#a}}']);
  assert.deepEqual(heading('## A {#x}{#y}'), ['y', 'A {#x}']);
  assert.deepEqual(parseDocument('##\n## \n##x').sections, [{ id: 'intro', title: '', body: '##\n## \n##x' }]);
});

test('a long heading line is read in time proportional to its length', () => {
  // Each of these lines kept a pattern with adjacent optional runs busy for seconds.
  const sources = [
    `# a${' '.repeat(4000)}b\n\ntext`,
    `## a${' \t'.repeat(30_000)}b`,
    `## a #${' '.repeat(60_000)}#b`,
    `## a ${'{#'.repeat(30_000)} }`,
    `## a${' '.repeat(60_000)}{#b}x`,
  ];
  const start = performance.now();
  for (const source of sources) parseDocument(source);
  const took = performance.now() - start;
  assert.ok(took < 1000, `parsing took ${Math.round(took)} ms`);
});

test('an unclosed fence is refused, because it would swallow the sections after it', () => {
  assert.throws(
    () => parseDocument('## A\n```js\nlet a\n## B\ntext'),
    /Line 2: the fenced block opened here is never closed/,
  );
});

test('a section splits into Markdown and rich blocks; other fences stay code', () => {
  const blocks = parseBlocks(
    [
      'Before',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
      '```mermaid title',
      'flowchart LR',
      '  A --> B',
      '```',
      'After',
    ].join('\n'),
  );
  assert.deepEqual(blocks, [
    { type: 'markdown', text: 'Before\n\n```js\nconst a = 1;\n```', info: '' },
    { type: 'mermaid', text: 'flowchart LR\n  A --> B', info: 'title' },
    { type: 'markdown', text: 'After', info: '' },
  ]);
  // An indented fence belongs to a list item or a quote, so it is not a block of its own.
  assert.deepEqual(
    parseBlocks('- item\n\n      ```mermaid\n      x\n      ```').map((block) => block.type),
    ['markdown'],
  );
  assert.deepEqual(parseBlocks('`inline ```mermaid` text'), [
    { type: 'markdown', text: '`inline ```mermaid` text', info: '' },
  ]);
  assert.throws(
    () => validateSection({ id: 'flow', title: 'Flow', body: '```mermaid\n\n```' }),
    /Section flow: A mermaid block needs/,
  );
  assert.throws(
    () => validateSection({ id: 'big', title: '', body: 'x'.repeat(128 * 1024 + 1) }),
    /Section big: the body is larger than 128 KiB/,
  );
});

test('an agent writes a visual in its turn conversation, linked to its task and session', async (t) => {
  const { app, user, worker, outsider, task, startTurn } = await team(t);
  app.store.updateAgent('worker', { sessionIds: { work: 'session-1' } });
  startTurn('worker');
  const { status, body: visual } = await worker('POST', '/api/visuals', { source: PLAN });
  assert.equal(status, 201);
  assert.match(visual.id, /^vis-[0-9a-f]{8}$/);
  assert.deepEqual(
    [visual.title, visual.agentId, visual.conversationId, visual.sessionId, visual.taskId, visual.version],
    ['Storage plan', 'worker', 'work', 'session-1', task.id, 1],
  );
  assert.deepEqual(
    visual.sections.map((section) => section.id),
    ['intro', 'overview', 'flow', 'steps'],
  );

  // The user comments and answers; an agent writes.
  assert.equal((await user('POST', '/api/visuals', { source: PLAN })).status, 403);
  assert.equal((await worker('POST', '/api/visuals', { source: PLAN, from: 'lead' })).status, 403);
  assert.equal((await outsider('POST', '/api/visuals', { source: PLAN, conversationId: 'work' })).status, 403);
  assert.equal(
    (await outsider('POST', '/api/visuals', { source: '# T\n## A\n```js\nopen', conversationId: 'work' })).status,
    403,
    'who asks is checked before the source is parsed',
  );
  assert.match(
    (await worker('POST', '/api/visuals', { source: '## Only {#x}\ntext' })).body.error,
    /title must contain/,
  );
  for (const title of ['Plan\u{E0049}', 'Pl\u200Ban', 'Plan\u202E'])
    assert.match(
      (await worker('POST', '/api/visuals', { source: PLAN, title })).body.error,
      /^A visual's title holds a character that is not shown \(U\+(E0049|200B|202E)\)$/,
    );
  assert.match((await worker('POST', '/api/visuals', { source: '# Empty' })).body.error, /at least one section/);
  assert.match(
    (await worker('POST', '/api/visuals', { source: '# T\n## A\n```js\nopen' })).body.error,
    /Invalid visual source: Line 3: the fenced block/,
  );

  // Members of the conversation read it; others do not learn that it exists in a list.
  assert.equal((await outsider('GET', `/api/visuals/${visual.id}`)).status, 403);
  assert.deepEqual((await outsider('GET', '/api/visuals')).body, []);
  assert.equal((await user('GET', `/api/visuals?task=${task.id}`)).body.length, 1);
  assert.equal((await user('GET', '/api/visuals?task=task-other')).body.length, 0);
  const read = (await user('GET', `/api/visuals/${visual.id}`)).body;
  assert.equal(read.shown.sections[1].body, 'Text with `code`.');
  assert.deepEqual(
    read.versions.map((version) => version.number),
    [1],
  );
  assert.equal((await user('GET', '/api/visuals/vis-missing')).status, 404);
  assert.equal((await user('GET', `/api/visuals/${visual.id}?version=7`)).status, 404);
});

test('a new visual never takes the ID of another one', async (t) => {
  const { app, user } = await team(t);
  const randomUUID = t.mock.method(nodeCrypto, 'randomUUID', () => '0a1b2c3d-0000-4000-8000-000000000000');
  syncBuiltinESMExports();
  t.after(() => {
    randomUUID.mock.restore();
    syncBuiltinESMExports();
  });
  const first = app.visuals.create({ source: PLAN }, 'worker');
  assert.equal(first.id, 'vis-0a1b2c3d');
  assert.throws(() => app.visuals.create({ source: '# Other\n\nOther text.' }, 'worker'), /UNIQUE constraint failed/);
  const read = (await user('GET', `/api/visuals/${first.id}`)).body;
  assert.deepEqual([read.title, read.version, read.shown.sections.length], ['Storage plan', 1, 4]);
  assert.equal(read.shown.sections[0].body, 'Why we move.');
});

test('all sections of a version together have a size limit', async (t) => {
  const { worker } = await team(t);
  const big = (ids) => ids.map((id) => `## ${id} {#${id}}\n\n${'x'.repeat(120 * 1024)}`).join('\n\n');
  const { body: visual } = await worker('POST', '/api/visuals', { source: `# Big\n\n${big(['a', 'b', 'c', 'd'])}` });
  assert.equal(visual.version, 1);
  assert.equal((await worker('PATCH', `/api/visuals/${visual.id}`, { source: big(['e', 'f', 'g', 'h']) })).status, 200);
  const over = await worker('PATCH', `/api/visuals/${visual.id}`, { source: big(['i']) });
  assert.equal(over.status, 400);
  assert.equal(
    over.body.error,
    `A visual holds at most ${LIMITS.documentBytes / 1024} KiB of text in all its sections; this one would hold 1081 KiB`,
  );
  assert.equal((await worker('GET', `/api/visuals/${visual.id}`)).body.sectionCount, 8);
  // Replacing a section with a smaller one makes room.
  assert.equal(
    (await worker('PATCH', `/api/visuals/${visual.id}`, { source: '## a {#a}\n\nShort.\n\n## i {#i}\n\nAlso short.' }))
      .status,
    200,
  );
});

test('the changes of one turn make one version; the next turn makes the next', async (t) => {
  const { app, user, worker, lead, startTurn } = await team(t);
  startTurn('worker');
  const { body: visual } = await worker('POST', '/api/visuals', { source: PLAN });
  const path = `/api/visuals/${visual.id}`;
  const patch = async (body, by = worker) => (await by('PATCH', path, body)).body;

  // Still the turn that created it: the change goes into version 1.
  assert.deepEqual(await patch({ source: '## Overview {#overview}\n\nRewritten.' }), {
    id: visual.id,
    title: 'Storage plan',
    version: 1,
    changed: ['overview'],
    added: [],
    removed: [],
    newVersion: false,
  });

  startTurn('worker');
  // A new section goes after the section sent before it; a known one is replaced where it is.
  const second = await patch({
    source: '## Flow {#flow}\n\n```mermaid\nflowchart TD\n  A --> C\n```\n\n## Risks {#risks}\n\nNone yet.',
  });
  assert.deepEqual([second.version, second.newVersion, second.changed, second.added], [2, true, ['flow'], ['risks']]);
  assert.equal((await patch({ remove: ['intro'] })).version, 2, 'the same turn keeps its version');
  assert.equal((await patch({ move: 'steps', first: true })).version, 2);
  assert.equal(
    app.visuals.find(visual.id).revision,
    5,
    'every stored change moves the counter that the viewer follows',
  );

  const now = (await user('GET', path)).body;
  assert.deepEqual(
    now.shown.sections.map((section) => section.id),
    ['steps', 'overview', 'flow', 'risks'],
  );
  assert.deepEqual([now.shown.changed, now.shown.added, now.shown.removed], [['flow'], ['risks'], ['intro']]);
  const first = (await user('GET', `${path}?version=1`)).body.shown;
  assert.deepEqual(
    first.sections.map((section) => section.id),
    ['intro', 'overview', 'flow', 'steps'],
  );
  assert.equal(first.sections[1].body, 'Rewritten.');
  assert.deepEqual(
    now.versions.map((version) => version.number),
    [1, 2],
  );

  // The whole document again changes only what differs, and nothing at all makes no version.
  startTurn('worker');
  const whole = (await worker('GET', path)).body.shown;
  const source = documentSource(whole.title, whole.sections);
  assert.deepEqual(await patch({ source, replace: true }), {
    id: visual.id,
    title: 'Storage plan',
    version: 2,
    changed: [],
    added: [],
    removed: [],
    unchanged: true,
  });
  const third = await patch({ source: source.replace('None yet.', 'One.'), replace: true, title: 'Plan B' });
  assert.deepEqual([third.version, third.changed, third.title], [3, ['risks'], 'Plan B']);
  const stored = app.store.db.prepare('SELECT COUNT(*) AS n FROM visual_sections WHERE visual_id=?').get(visual.id);
  assert.equal(stored.n, 8, 'a section is stored once per distinct content, not once per version');

  // Only the author changes it, and a mistake names what exists.
  assert.equal((await lead('PATCH', path, { title: 'Mine' })).status, 403);
  assert.equal((await user('PATCH', path, { title: 'Mine' })).status, 403);
  assert.match(
    (await patch({ remove: ['nope'] })).error,
    /no section nope\. Its sections: steps, overview, flow, risks/,
  );
  assert.match((await patch({ source: '## X\ntext', after: 'nope' })).error, /after: this visual has no section nope/);
  assert.match((await patch({ move: 'steps' })).error, /Say where the section moves/);
  assert.match((await patch({ remove: ['steps', 'overview', 'flow', 'risks'] })).error, /at least one section/);
  assert.match((await patch({ amend: true, title: 'T' })).error, /A managed turn needs no amend/);
  assert.match((await patch({ html: '<b>' })).error, /Unknown visual field html/);
  assert.equal(app.visuals.find(visual.id).version, 3, 'a refused change stores nothing');
});

test('without a managed turn every change is a version, unless the agent amends', async (t) => {
  const { user, app } = await team(t);
  // The user credential acts for a manual agent, whose CLI the user runs.
  const { body: visual } = await user('POST', '/api/visuals', { from: 'lead', source: PLAN, conversationId: 'work' });
  const patch = async (body) => (await user('PATCH', `/api/visuals/${visual.id}`, { from: 'lead', ...body })).body;
  assert.equal((await patch({ source: '## New\n\nA.', first: true })).version, 2);
  assert.equal((await patch({ source: '## New\n\nB.' })).version, 3);
  const amended = await patch({ source: '## New\n\nC.', amend: true });
  assert.deepEqual([amended.version, amended.newVersion], [3, false]);
  assert.equal(app.visuals.read(visual.id, 'user').shown.sections[0].body, 'C.');
});

test('the dashboard stream carries the record of a visual, never its content', async (t) => {
  const { app, url, worker, startTurn } = await team(t);
  const stream = await fetch(`${url}/api/events?token=${app.identity.token}`);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel());
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async () => {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!/^data: /m.test(frame)) continue;
        return { event: /^event: (\S+)$/m.exec(frame)[1], data: JSON.parse(/^data: (.*)$/m.exec(frame)[1]) };
      }
      buffer += decoder.decode((await reader.read()).value, { stream: true });
    }
  };
  const snapshot = await next();
  assert.deepEqual([snapshot.event, snapshot.data.visuals], ['snapshot', []]);
  startTurn('worker');
  const { body: visual } = await worker('POST', '/api/visuals', { source: PLAN });
  const created = (await next()).data.changes.find((change) => change.kind === 'visuals');
  assert.equal(created.id, visual.id);
  assert.deepEqual([created.value.version, created.value.revision, created.value.sectionCount], [1, 1, 4]);
  assert.doesNotMatch(JSON.stringify(created), /Why we move|flowchart/);
  await worker('PATCH', `/api/visuals/${visual.id}`, { source: '## Overview {#overview}\n\nAgain.' });
  const changed = (await next()).data.changes.find((change) => change.kind === 'visuals');
  assert.deepEqual([changed.value.version, changed.value.revision], [1, 2]);
});

test('the frame page is sandboxed without network, and only its own files answer cross-site requests', async (t) => {
  const { url, app } = await team(t);
  // What a browser sends for a request from the frame's opaque origin.
  const crossSite = { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' };
  const page = await fetch(`${url}/visual/frame.html`, { headers: crossSite });
  assert.equal(page.status, 200);
  // The whole policy, word for word: it is what stops a handler that gets past the sanitizers, so a source added to
  // any directive has to be a decision that changes this test.
  assert.equal(
    page.headers.get('content-security-policy'),
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts",
  );
  // The frame's files answer at their listed paths only; no other spelling serves the page under another policy.
  for (const path of ['/visual//frame.html', '//visual/frame.html', '/VISUAL/frame.html', '/visual//frame.js'])
    assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  const html = await page.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'the policy allows no inline script');
  for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const response = await fetch(`${url}${asset}`, { headers: crossSite });
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', asset);
  }
  for (const asset of ['/visual/format.js', '/vendor/marked.js', '/vendor/purify.js'])
    assert.equal((await fetch(`${url}${asset}`, { headers: crossSite })).status, 200, asset);

  // The dashboard may embed only Mu's own pages, which also limits where a frame can navigate itself.
  const dashboard = await fetch(`${url}/`);
  assert.match(dashboard.headers.get('content-security-policy'), /frame-src 'self'/);
  assert.equal(dashboard.headers.get('access-control-allow-origin'), null);
  // Nothing else is opened to other origins: not the dashboard's files, and not the API, even with the credential.
  assert.equal((await fetch(`${url}/app.js`, { headers: crossSite })).status, 403);
  assert.equal((await fetch(`${url}/api/visuals`, { headers: { ...userHeaders(app), ...crossSite } })).status, 403);
  assert.equal(
    (await fetch(`${url}/visual/frame.html`, { method: 'POST', headers: crossSite, body: '{}' })).status,
    403,
    'only a GET of a frame file skips the origin check',
  );
});

test('the frame gets every file its code imports, as a module, and no other file of the libraries', async (t) => {
  const { url } = await team(t);
  const crossSite = { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' };
  /** @type {(path: string, headers?: Record<string, string>) => Promise<Response>} */
  const get = (path, headers = crossSite) => fetch(`${url}${path}`, { headers });
  const imported = new Set();
  for (const file of ['public/visual/frame.js', 'public/visual/render.js', 'src/visual-format.mjs']) {
    const source = await readFile(join(ROOT, file), 'utf8');
    for (const [, path] of source.matchAll(/(?:from |import\()['"`](\/[^'"`]+)['"`]/g)) imported.add(path);
  }
  // eslint-disable-next-line no-template-curly-in-string -- the literal text of the import in frame.js
  assert.ok(imported.delete('/vendor/highlight/${language}.js'), 'the frame imports a grammar by its language');
  for (const language of CODE_LANGUAGES) imported.add(`/vendor/highlight/${language}.js`);
  assert.ok(imported.has('/vendor/mermaid/mermaid.esm.min.mjs') && imported.has('/vendor/highlight/core.js'));
  for (const path of imported) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /^text\/javascript/, path);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', path);
  }

  // highlight.js publishes its core as CommonJS; Mu serves it as a module that a browser can import.
  const asModule = async (path) =>
    import(`data:text/javascript;base64,${Buffer.from(await (await get(path)).arrayBuffer()).toString('base64')}`);
  const hljs = (await asModule('/vendor/highlight/core.js')).default;
  hljs.registerLanguage('json', (await asModule('/vendor/highlight/json.js')).default);
  assert.match(hljs.highlight('{"a": 1}', { language: 'json' }).value, /<span class="hljs-attr">&quot;a&quot;<\/span>/);

  // Mermaid names the files of its diagram types itself; all of them are served, and nothing beside them.
  const chunks = (await readdir(join(ROOT, 'node_modules/mermaid/dist/chunks/mermaid.esm.min'))).filter((name) =>
    name.endsWith('.mjs'),
  );
  assert.ok(chunks.length > 50);
  for (const name of chunks) {
    const response = await get(`/vendor/mermaid/chunks/mermaid.esm.min/${name}`);
    assert.equal(response.status, 200, name);
    await response.arrayBuffer();
  }
  for (const path of [
    '/vendor/mermaid/mermaid.esm.min.mjs.map',
    '/vendor/mermaid/mermaid.js',
    '/vendor/mermaid/package.json',
    '/vendor/mermaid/chunks/mermaid.esm/chunk-NYALJP3A.mjs',
    '/vendor/mermaid/chunks/mermaid.esm.min/%2e%2e/%2e%2e/mermaid.js',
    '/vendor/highlight/lib/core.js',
    '/vendor/highlight/zig.js',
    '/vendor/anime.js',
  ]) {
    assert.equal((await get(path)).status, 403, `${path} from the frame`);
    assert.notEqual((await get(path, {})).status, 200, `${path} from the dashboard`);
  }
});

test('the CLI prints the visuals skill without a service, and the role files point to it', async () => {
  const guide = await main(['visual', 'guide'], { MU_URL: 'http://127.0.0.1:1' });
  assert.match(guide, /^# Visuals\n/, 'the skill text without its front matter');
  // The guide names the commands and options that exist.
  for (const [, command] of guide.matchAll(/node "\$MU_CLI" (visual \w+)/g))
    assert.ok(String(await main(['--help'], {})).includes(`  ${command} `), command);
  const skill = await readFile(join(ROOT, 'skills/visuals/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: visuals\ndescription: .+\n---\n/);
  for (const role of ['worker', 'team-lead'])
    assert.match(await readFile(join(ROOT, `skills/${role}/SKILL.md`), 'utf8'), /visual guide/, role);
});

test('the CLI writes, changes and reads back a visual as Markdown', async (t) => {
  const { app, url } = await team(t);
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.tmp/visual-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = async (name, text) => {
    await writeFile(join(directory, name), text);
    return join(directory, name);
  };
  const env = { MU_URL: url, MU_AGENT_ID: 'lead', MU_TOKEN: app.identity.token, MU_CONVERSATION_ID: 'work' };
  const visual = await main(['visual', 'create', '--file', await file('plan.md', PLAN)], env);
  assert.equal(visual.conversationId, 'work');
  const patched = await main(
    [
      'visual',
      'patch',
      '--id',
      visual.id,
      '--file',
      await file('risks.md', '## Risks {#risks}\n\nTwo.'),
      '--after',
      'overview',
      '--remove',
      'steps,flow',
    ],
    env,
  );
  assert.deepEqual([patched.version, patched.added, patched.removed], [2, ['risks'], ['flow', 'steps']]);
  assert.equal(
    await main(['visual', 'show', '--id', visual.id, '--section', 'risks'], env),
    '## Risks {#risks}\n\nTwo.\n',
  );
  assert.equal(
    await main(['visual', 'show', '--id', visual.id, '--source'], env),
    '# Storage plan\n\nWhy we move.\n\n## Overview {#overview}\n\nText with `code`.\n\n## Risks {#risks}\n\nTwo.\n',
  );
  assert.match(await main(['visual', 'show', '--id', visual.id, '--source', '--version', '1'], env), /```mermaid/);
  const outline = await main(['visual', 'show', '--id', visual.id, '--version', '1'], env);
  assert.deepEqual(outline.shown.sections[2], { id: 'flow', title: 'Flow', bytes: 37, blocks: ['mermaid'] });
  assert.equal(JSON.stringify(outline).includes('flowchart'), false, 'the outline holds no content');
  await assert.rejects(
    main(['visual', 'show', '--id', visual.id, '--section', 'flow'], env),
    /has no section flow\. Its sections: intro, overview, risks/,
  );
  await assert.rejects(
    main(['visual', 'patch', '--id', visual.id], env),
    /Provide --file, --remove, --move, --title or --resolves/,
  );
  assert.deepEqual(
    (await main(['visual', 'list', '--conversation', 'work'], env)).map((item) => item.id),
    [visual.id],
  );
});
