import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { sanitizeMarkdown } from '../public/markdown-core.js';
import { createApp, ROOT } from '../src/server.mjs';
import { main } from '../src/cli.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, listenLocal, temporaryMuHome } from './isolation.mjs';
import { createdAt, fixture, initialState } from './ui-fixture.mjs';

class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
  }
  async start() {}
  async connect() {}
  close() {}
  async syncConversation() {}
  async send(from, text, conversationId) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId);
  }
}

async function team(t, port) {
  const dataDir = await shortTempDir(t, 'waiting');
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir,
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
    platform: 'darwin',
  });
  await app.start();
  t.after(() => app.close());
  const as = (headers) => async (method, path, data) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const user = as(userHeaders(app));
  const made = await user('POST', '/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(
    (
      await user('POST', '/api/conversations', {
        kind: 'room',
        id: 'work',
        name: 'Work',
        from: 'lead',
        members: [],
        sourceConversationId: 'dm-lead',
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await user('POST', '/api/agents', {
        id: 'worker',
        role: 'worker',
        adapter: 'claude',
        cwd: ROOT,
        task: '',
        conversationId: 'work',
        from: 'lead',
      })
    ).status,
    201,
  );
  app.store.updateAgent('worker', { status: 'stopped' });
  const task = (
    await user('POST', '/api/tasks', {
      title: 'Fix the release issue',
      conversationId: 'work',
      agentIds: ['worker'],
      from: 'lead',
    })
  ).body;
  const turn = (id) => as({ 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue(id)}` });
  return { app, user, task, lead: turn('lead'), worker: turn('worker') };
}

test('only the lead changes the waiting list; the user and workers can read it', async (t) => {
  const { app, user, lead, worker, task } = await team(t, await freePort());
  const card = await lead('POST', '/api/waiting', {
    text: 'Release 1.2 waiting for your approval to push',
    taskId: task.id,
  });
  assert.equal(card.status, 201);
  assert.match(card.body.id, /^wait-[a-f0-9]{8}$/);

  assert.equal((await worker('POST', '/api/waiting', { text: 'Worker adds a card', taskId: task.id })).status, 403);
  assert.equal((await worker('DELETE', `/api/waiting/${card.body.id}`, {})).status, 403);
  assert.equal((await user('POST', '/api/waiting', { text: 'User adds a card', taskId: task.id })).status, 403);
  assert.equal((await user('DELETE', `/api/waiting/${card.body.id}`, {})).status, 403);
  assert.equal(
    (await user('POST', '/api/waiting', { text: 'User acts as the managed worker', taskId: task.id, from: 'worker' }))
      .status,
    403,
  );
  assert.deepEqual(
    app.waiting.list().map((item) => item.text),
    ['Release 1.2 waiting for your approval to push'],
  );

  for (const read of [user, worker])
    assert.deepEqual(
      (await read('GET', '/api/waiting')).body.map((item) => item.text),
      [card.body.text],
    );
  assert.deepEqual(
    (await user('GET', '/api/state')).body.waiting.map((item) => item.id),
    [card.body.id],
  );

  assert.equal((await lead('DELETE', `/api/waiting/${card.body.id}`, {})).status, 200);
  assert.equal((await lead('DELETE', `/api/waiting/${card.body.id}`, {})).status, 404);
  assert.deepEqual(app.waiting.list(), []);
});

test('a card may link a task, which must exist and not be verified, and shows its task in the state', async (t) => {
  const { app, user, lead, task } = await team(t, await freePort());
  const text = 'Release waiting for your go-ahead';
  assert.equal((await lead('POST', '/api/waiting', { text, taskId: 'no-such-task' })).status, 404);
  assert.equal((await lead('POST', '/api/waiting', { text, taskId: 7 })).status, 400);
  const card = await lead('POST', '/api/waiting', { text, taskId: task.id });
  assert.equal(card.body.taskId, task.id);
  assert.deepEqual(
    (await user('GET', '/api/state')).body.waiting.map((item) => item.taskId),
    [task.id],
  );
  assert.equal(
    (await lead('PATCH', `/api/tasks/${task.id}`, { status: 'ready', result: 'Done', from: 'lead' })).status,
    200,
  );
  assert.equal((await user('POST', `/api/tasks/${task.id}/verify`, {})).status, 200);
  assert.equal((await lead('POST', '/api/waiting', { text, taskId: task.id })).status, 409);
  assert.equal(app.waiting.list().length, 1);
  const unlinked = await lead('POST', '/api/waiting', { text: 'Naming of the project waiting for your choice' });
  assert.equal(unlinked.status, 201);
  assert.equal(unlinked.body.taskId, null);
  assert.equal((await lead('POST', '/api/waiting', { text, taskId: null })).body.taskId, null);
});

test('a card stored before tasks were linked keeps working after the column is added', async (t) => {
  const { app } = await team(t, await freePort());
  app.store.db.exec('DROP TABLE waiting');
  app.store.db.exec('CREATE TABLE waiting (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt TEXT NOT NULL)');
  app.store.db.prepare("INSERT INTO waiting VALUES ('wait-00000000', 'Old card', '2026-11-06T10:00:00Z')").run();
  const { createWaiting } = await import('../src/waiting.mjs');
  assert.deepEqual(
    createWaiting({ store: app.store, tasks: app.tasks })
      .list()
      .map((row) => ({ ...row })),
    [{ id: 'wait-00000000', text: 'Old card', taskId: null, createdAt: '2026-11-06T10:00:00Z' }],
  );
});

test('card text must be one plain sentence without PR numbers, links, or task IDs', async (t) => {
  const { app, lead, task } = await team(t, await freePort());
  const rejected = [
    'Waiting for approval of PR #123',
    'Approve https://github.com/org/repo/pull/9',
    `Waiting for approval to push ${task.id}`,
    `Waiting for approval to push ${task.id.toUpperCase()}`,
    'Two\nlines',
    '   ',
    'x'.repeat(201),
  ];
  for (const text of rejected)
    assert.equal((await lead('POST', '/api/waiting', { text, taskId: task.id })).status, 400, text);
  assert.equal((await lead('POST', '/api/waiting', {})).status, 400);
  assert.deepEqual(app.waiting.list(), []);
  assert.equal(
    (await lead('POST', '/api/waiting', { text: '  Release 1.2 waiting for your approval to push  ', taskId: task.id }))
      .body.text,
    'Release 1.2 waiting for your approval to push',
  );
});

test('the CLI sends waiting commands as the calling agent', async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const port = await listenLocal(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { MU_URL: `http://127.0.0.1:${port}`, MU_AGENT_ID: 'lead', MU_TOKEN: 'a'.repeat(64) };
  await main(['waiting', 'add', '--task-id', 'task-42', '--text', 'Release waiting for your go-ahead'], env);
  await main(['waiting', 'add', '--text', 'No task'], env);
  await main(['waiting', 'list'], env);
  await main(['waiting', 'remove', '--id', 'wait-1a2b3c4d'], env);
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/api/waiting',
      body: { text: 'Release waiting for your go-ahead', taskId: 'task-42', from: 'lead' },
    },
    { method: 'POST', path: '/api/waiting', body: { text: 'No task', from: 'lead' } },
    { method: 'GET', path: '/api/waiting', body: undefined },
    { method: 'DELETE', path: '/api/waiting/wait-1a2b3c4d', body: { from: 'lead' } },
  ]);
});

const withCards = (cards) => ({
  ...initialState(),
  waiting: cards.map((text, index) => ({ id: `wait-0000000${index}`, text, taskId: 'task-a', createdAt })),
});

test('the dashboard lists cards above the metrics and hides the section when none are waiting', async (t) => {
  const empty = await fixture(t);
  assert.equal(empty.$('#waiting-section').hidden, true);
  const ui = await fixture(t, {
    initial: withCards(['Release 1.2 waiting for your approval to push', 'Release waiting for your go-ahead']),
  });
  assert.equal(ui.$('#waiting-section').hidden, false);
  assert.equal(ui.$('#waiting-count').textContent, '2');
  assert.deepEqual(
    [...ui.window.document.querySelectorAll('.waiting-text')].map((card) => card.textContent),
    ['Release 1.2 waiting for your approval to push', 'Release waiting for your go-ahead'],
  );
  assert.ok(
    ui.$('#waiting-section').compareDocumentPosition(ui.$('.metrics')) & ui.window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  ui.update(withCards([]));
  assert.equal(ui.$('#waiting-section').hidden, true);
});

test('clicking a card opens the lead chat with a quote line and the cursor on the next line', async (t) => {
  const ui = await fixture(t, { initial: withCards(['Release 1.2 waiting for your approval to push']) });
  ui.click('[data-conversation="room-a"]');
  ui.click('[data-view="workspace"]');
  ui.click('.waiting-text');
  const input = ui.$('#message-input');
  assert.equal(ui.$('#team-chat').hidden, false);
  assert.equal(ui.$('#chat-title').textContent.includes('lead'), true);
  assert.equal(input.value, '> Re: Release 1.2 waiting for your approval to push\n\n');
  assert.equal(input.selectionStart, input.value.length);
  assert.equal(input.selectionEnd, input.value.length);
  assert.equal(ui.window.document.activeElement, input);
});

test('a card keeps the draft already typed in the lead chat above its quote', async (t) => {
  const ui = await fixture(t, { initial: withCards(['Release waiting for your go-ahead']) });
  ui.click('[data-view="chat"]');
  ui.click('[data-conversation="dm-lead"]');
  ui.$('#message-input').value = 'Half-typed note';
  ui.click('[data-view="workspace"]');
  ui.click('.waiting-text');
  assert.equal(ui.$('#message-input').value, 'Half-typed note\n\n> Re: Release waiting for your go-ahead\n\n');
});

test('each card has a task icon that names the task on hover and reveals the task on click', async (t) => {
  const ui = await fixture(t, { initial: withCards(['Release waiting for your go-ahead']) });
  const icon = ui.$('.waiting-task');
  assert.equal(icon.title, 'Review changes');
  assert.equal(icon.getAttribute('aria-label'), 'Open task: Review changes');
  ui.click('[data-view="chat"]');
  icon.click();
  assert.equal(ui.$('#workspace').hidden, false);
  assert.equal(ui.$('.task-card.revealed').dataset.task, 'task-a');
});

test('a card without a known task shows no icon but still replies', async (t) => {
  const state = withCards(['Old card']);
  state.waiting[0].taskId = null;
  const ui = await fixture(t, { initial: state });
  assert.equal(ui.$('.waiting-task'), null);
  assert.ok(ui.$('.waiting-text'));
});

test('a reply typed after the prefill renders outside the quote, which a single newline would not', async (t) => {
  const ui = await fixture(t, { initial: withCards(['Release 1.2 waiting for your approval to push']) });
  ui.click('.waiting-text');
  const prefill = ui.$('#message-input').value;
  const render = (source) => {
    const window = new JSDOM('').window;
    const container = window.document.createElement('div');
    container.innerHTML = sanitizeMarkdown(source, { parse: marked.parse, sanitize: createDOMPurify(window).sanitize });
    return container;
  };
  const sent = render(`${prefill}Yes, push it.`);
  assert.equal(
    sent.querySelector('blockquote').textContent.trim(),
    'Re: Release 1.2 waiting for your approval to push',
  );
  assert.equal(sent.querySelector('blockquote').textContent.includes('Yes, push it.'), false);
  assert.equal(sent.querySelector('blockquote + p').textContent, 'Yes, push it.');
  const lazy = render(`${prefill.trimEnd()}\nYes, push it.`);
  assert.equal(
    lazy.querySelector('blockquote').textContent.includes('Yes, push it.'),
    true,
    'one newline folds the reply into the quote',
  );
});
