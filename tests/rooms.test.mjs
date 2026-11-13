import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Chat, MAX_MESSAGE_BYTES, chunks, confirmationTimeout } from '../src/chat.mjs';
import { createApp, ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';

const agent = (id) => ({ id, role: id === 'lead' ? 'lead' : 'worker', adapter: 'manual', cwd: ROOT, task: '' });
const temp = (t) => shortTempDir(t, 'rooms');

test('legacy migration preserves message IDs, acknowledgements and history in Common', async (t) => {
  const filename = join(await temp(t), 'legacy.sqlite');
  const old = new DatabaseSync(filename);
  old.exec(
    'CREATE TABLE agents (id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,transport_id TEXT UNIQUE NOT NULL,data TEXT NOT NULL); CREATE TABLE inbox (agent_id TEXT NOT NULL,message_id INTEGER NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(agent_id,message_id));',
  );
  old
    .prepare('INSERT INTO agents VALUES (?,?)')
    .run('lead', JSON.stringify({ ...agent('lead'), status: 'idle', sessionId: 'legacy-session' }));
  old.prepare('INSERT INTO messages VALUES (?,?,?)').run(
    42,
    'original-transport',
    JSON.stringify({
      from: 'user',
      text: '@lead Original issue',
      mentions: ['lead'],
      createdAt: '2026-01-01T00:00:00Z',
    }),
  );
  old.exec("INSERT INTO inbox VALUES ('lead',42,0)");
  old.close();
  let store = new Store(filename);
  assert.equal(store.messages()[0].id, 42);
  assert.equal(store.messages()[0].text, '@lead Original issue');
  assert.equal(store.messages()[0].conversationId, 'common');
  assert.equal(store.agent('lead').sessionId, 'legacy-session');
  assert.deepEqual(store.agent('lead').sessionIds, { common: 'legacy-session' });
  assert.deepEqual(store.conversation('dm-lead').members, ['user', 'lead']);
  store.ack('lead', 42);
  store.close();
  store = new Store(filename);
  assert.equal(store.inbox('lead').length, 0);
  assert.equal(store.messages().length, 1);
  assert.equal(store.conversations().length, 2);
  store.close();
});

test('reopening a direct-only agent never reassigns its native session to Common', async (t) => {
  const filename = join(await temp(t), 'scoped.sqlite');
  let store = new Store(filename);
  store.createAgent(agent('worker'));
  store.updateAgent('worker', {
    conversationId: 'dm-worker',
    sessionId: 'direct-session',
    sessionIds: { 'dm-worker': 'direct-session' },
  });
  store.close();
  store = new Store(filename);
  assert.deepEqual(store.agent('worker').sessionIds, { 'dm-worker': 'direct-session' });
  store.close();
});

test('turn completion acknowledges and clears durable result atomically', () => {
  const store = new Store();
  store.createAgent(agent('worker'));
  const message = store.addMessage('turn', 'user', '@worker work');
  store.updateAgent('worker', {
    pendingResult: { messageIds: [message.id], text: 'result' },
    activeMessageId: message.id,
  });
  /** @type {{agent: Record<string, any>, inbox: object[]} | undefined} */
  let observed;
  store.once('change', () => {
    observed = { agent: store.agent('worker'), inbox: store.inbox('worker') };
  });
  store.completeTurn('worker', [message.id], { pendingResult: null, activeMessageId: null, status: 'idle' });
  assert.equal(observed.agent.pendingResult, null);
  assert.equal(observed.agent.activeMessageId, null);
  assert.equal(observed.inbox.length, 0);
  assert.throws(() => store.completeTurn('worker', [999], { status: 'done' }), /not pending/);
  assert.equal(store.agent('worker').status, 'idle');
  store.close();
});

test('direct chats route without mentions and broadcasts stay inside task membership', () => {
  const store = new Store();
  for (const id of ['lead', 'worker', 'reviewer']) store.createAgent(agent(id));
  store.createConversation({
    id: 'task-one',
    kind: 'room',
    name: 'Task one',
    members: ['lead', 'worker'],
    createdBy: 'lead',
    sourceConversationId: 'dm-lead',
  });
  const direct = store.addMessage('dm-1', 'user', 'Please investigate', 'dm-worker');
  assert.deepEqual(
    store.inbox('worker').map((message) => message.id),
    [direct.id],
  );
  assert.equal(store.inbox('lead').length, 0);
  store.addMessage('dm-2', 'worker', 'Here is the report', 'dm-worker');
  store.addMessage('system-dm', 'system', '@user Delivery failed', 'dm-worker');
  assert.equal(store.inbox('worker').length, 1);
  const broadcast = store.addMessage('task-1', 'worker', '@all Please review', 'task-one');
  assert.deepEqual(
    store.inbox('lead').map((message) => message.id),
    [broadcast.id],
  );
  assert.equal(store.inbox('reviewer').length, 0);
  assert.equal(store.messages(300, 'common').length, 0);
  assert.throws(() => store.addMessage('bad', 'reviewer', '@lead intrude', 'task-one'), /not a member/);
  store.addMembers('task-one', ['reviewer']);
  store.addMessage('task-2', 'lead', '@reviewer Review this', 'task-one');
  assert.equal(store.inbox('reviewer').length, 1);
  assert.equal(store.conversation('task-one').sourceConversationId, 'dm-lead');
  assert.throws(() => store.addMembers('dm-worker', ['lead']), /Only task rooms/);
  assert.deepEqual(
    store.messages(1, 'task-one', broadcast.id + 1).map((message) => message.id),
    [broadcast.id],
  );
  store.close();
});

test('maximum supported messages retain text and use a fragment-scaled confirmation deadline', async () => {
  const delivered = [];
  const chat = new Chat({ onMessage: (_id, _from, text, conversationId) => ({ text, conversationId }) });
  chat.state.connected = true;
  chat.syncConversation = async () => {};
  chat.connect = async () => ({
    say: (target, text, tags) => {
      delivered.push(text);
      queueMicrotask(() => chat.receive({ target, nick: 'user', message: text, tags }));
    },
  });
  const text = '\n'.repeat(MAX_MESSAGE_BYTES);
  assert.equal((await chat.send('user', text)).text, text);
  assert.ok(delivered.every((part) => Buffer.byteLength(part) <= 300));
  assert.equal(delivered.length, chunks(text.replace(/\n/g, '↵')).length);
  assert.ok(confirmationTimeout(delivered.length) > confirmationTimeout(1));
  await assert.rejects(chat.send('user', text + 'x'), /UTF-8 bytes/);
});

class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
    this.synced = [];
  }
  async start() {}
  async connect() {}
  close() {}
  async syncConversation(conversation) {
    this.synced.push(conversation);
  }
  async send(from, text, conversationId) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId);
  }
}

test('HTTP rooms enforce membership, private assignment defaults, provenance and explicit routing', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await temp(t),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${port}`;
  const post = async (path, data) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { ...userHeaders(app) },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post('/api/agents', agent('lead'))).status, 201);
  const staleBrowser = await fetch(url + '/api/messages', {
    method: 'POST',
    headers: { ...userHeaders(app), Origin: url },
    body: JSON.stringify({ text: 'Do not misroute' }),
  });
  assert.equal(staleBrowser.status, 400);
  const staleLaunch = await fetch(url + '/api/agents', {
    method: 'POST',
    headers: { ...userHeaders(app), Origin: url },
    body: JSON.stringify(agent('stale')),
  });
  assert.equal(staleLaunch.status, 400);
  assert.equal(app.store.agent('stale'), null);
  const initial = await post('/api/agents', agent('worker'));
  assert.equal(initial.status, 201);
  assert.equal(initial.body.conversationId, 'dm-worker');
  await post('/api/messages', { text: 'Private request', conversationId: 'dm-worker' });
  assert.equal(app.store.inbox('worker')[0].conversationId, 'dm-worker');
  assert.equal(app.store.messages(300, 'common').length, 0);
  const room = await post('/api/conversations', {
    kind: 'room',
    id: 'issue-42',
    name: 'Issue 42',
    from: 'lead',
    members: [],
    sourceConversationId: 'dm-lead',
  });
  assert.equal(room.status, 201);
  assert.deepEqual(room.body.members, ['user', 'lead']);
  const assigned = await post('/api/agents', {
    ...agent('investigator'),
    from: 'lead',
    task: 'Investigate privately with lead',
    taskTitle: 'Investigation',
    conversationId: 'issue-42',
  });
  assert.equal(assigned.status, 201);
  assert.ok(app.store.conversation('issue-42').members.includes('investigator'));
  assert.equal(app.store.inbox('investigator')[0].conversationId, 'issue-42');
  assert.equal(
    (await post('/api/messages', { from: 'worker', text: '@lead hello', conversationId: 'issue-42' })).status,
    403,
  );
  assert.equal(
    (await post('/api/messages', { from: 'lead', text: '@worker hello', conversationId: 'issue-42' })).status,
    400,
  );
  assert.equal((await post('/api/messages', { text: 'hello', conversationId: 'missing' })).status, 404);
  assert.equal((await post('/api/conversations/issue-42/members', { from: 'lead', members: ['worker'] })).status, 200);
  assert.equal(
    (await post('/api/messages', { from: 'lead', text: '@worker hello', conversationId: 'issue-42' })).status,
    201,
  );
  assert.equal((await post('/api/conversations/dm-lead/members', { members: ['worker'] })).status, 400);
  assert.equal((await post('/api/messages', { from: 'system', text: 'spoof', conversationId: 'dm-lead' })).status, 400);
  assert.equal(
    (await post('/api/messages', { text: 'Long report ' + 'x'.repeat(3000), conversationId: 'dm-worker' })).status,
    201,
  );
  const unicode = '日本語🙂 exact report';
  const payload = Buffer.from(JSON.stringify({ text: unicode, conversationId: 'dm-worker' }));
  const split = payload.indexOf(Buffer.from('日')) + 1;
  const splitResponse = await new Promise((resolve, reject) => {
    const request = http.request(
      url + '/api/messages',
      { method: 'POST', headers: { ...userHeaders(app) } },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (part) => {
          raw += part;
        });
        response.on('end', () => resolve(JSON.parse(raw)));
      },
    );
    request.on('error', reject);
    request.write(payload.subarray(0, split));
    setTimeout(() => request.end(payload.subarray(split)), 10);
  });
  assert.equal(splitResponse.text, unicode);
  const state = await (await fetch(url + '/api/state', { headers: userHeaders(app) })).json();
  assert.equal(state.conversations.length, 5);
  assert.ok(state.messages.every((message) => message.conversationId));
  const history = await (
    await fetch(url + '/api/conversations/issue-42/messages?limit=1', { headers: userHeaders(app) })
  ).json();
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].conversationId, 'issue-42');
  await post('/api/agents/worker/stop', {});
  app.store.updateAgent('worker', {
    pendingResult: { messageIds: [1], text: 'saved report' },
    sessionIds: { common: 'old' },
  });
  const operational = await (await fetch(url + '/api/agents', { headers: userHeaders(app) })).json();
  assert.equal(operational.find((item) => item.id === 'worker').pendingResult, undefined);
  assert.equal(operational.find((item) => item.id === 'worker').hasPendingResult, true);
  assert.equal((await post('/api/agents/worker/ack', { id: 1 })).status, 409);
  const configure = await fetch(url + '/api/agents/worker', {
    method: 'PATCH',
    headers: { ...userHeaders(app) },
    body: JSON.stringify({ adapter: 'demo' }),
  });
  assert.equal(configure.status, 409);
});

test('browser assignment records its task before delivery and lead retirement requires user verification', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await temp(t),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${port}`;
  const request = async (path, data, { method = 'POST', browser = false } = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: { ...userHeaders(app), ...(browser ? { Origin: url } : {}) },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  await request('/api/agents', agent('lead'));
  await request('/api/conversations', {
    kind: 'room',
    id: 'tracked-room',
    name: 'Tracked work',
    members: ['lead'],
    sourceConversationId: 'dm-lead',
  });
  const send = app.chat.send.bind(app.chat);
  let observedTaskBeforeDelivery = false;
  app.chat.send = async (from, text, conversationId) => {
    if (text === '@worker\n\nInitial work')
      observedTaskBeforeDelivery = app.tasks.list().some((task) => task.agentIds.includes('worker'));
    return send(from, text, conversationId);
  };
  const rejected = await request(
    '/api/agents',
    { ...agent('untracked'), task: 'Initial work', conversationId: 'tracked-room' },
    { browser: true },
  );
  assert.equal(rejected.status, 400);
  assert.equal(app.store.agent('untracked'), null);
  const untrackedCli = await request('/api/agents', {
    ...agent('untracked-cli'),
    task: 'Initial work',
    conversationId: 'tracked-room',
  });
  assert.equal(untrackedCli.status, 400);
  assert.equal(app.store.agent('untracked-cli'), null);
  const launch = await request(
    '/api/agents',
    { ...agent('worker'), task: 'Initial work', taskTitle: 'Tracked task', conversationId: 'tracked-room' },
    { browser: true },
  );
  assert.equal(launch.status, 201);
  assert.ok(observedTaskBeforeDelivery);
  assert.equal(app.store.inbox('worker')[0].text, '@worker\n\nInitial work');
  const taskId = launch.body.taskId;
  assert.equal(app.tasks.get(taskId).status, 'active');
  await request('/api/conversations', {
    kind: 'room',
    id: 'invalid-source',
    name: 'Invalid task source',
    members: ['lead'],
    sourceConversationId: 'dm-worker',
  });
  const rolledBack = await request(
    '/api/agents',
    {
      ...agent('invalid-worker'),
      task: 'Must not start',
      taskTitle: 'Invalid source',
      conversationId: 'invalid-source',
    },
    { browser: true },
  );
  assert.equal(rolledBack.status, 400);
  assert.equal(app.store.agent('invalid-worker'), null);
  assert.equal(app.store.conversation('dm-invalid-worker'), null);
  assert.ok(!app.store.conversation('invalid-source').members.includes('invalid-worker'));
  assert.equal(app.tasks.list().length, 1);
  assert.equal((await request('/api/agents/worker/stop', { from: 'lead' })).status, 409);
  assert.equal(
    (await request('/api/agents/worker', { from: 'lead', status: 'stopped' }, { method: 'PATCH' })).status,
    409,
  );
  const registry = await (await fetch(url + '/api/agents', { headers: userHeaders(app) })).json();
  assert.ok(Array.isArray(registry));
  assert.deepEqual(
    registry.map((item) => item.id),
    ['lead', 'worker'],
  );
  await request(
    `/api/tasks/${taskId}`,
    { from: 'lead', status: 'ready', result: '## Result\nVerified by automated checks.' },
    { method: 'PATCH' },
  );
  assert.equal((await request(`/api/tasks/${taskId}/verify`, { from: 'lead' })).status, 403);
  const verified = await request(`/api/tasks/${taskId}/verify`, {}, { browser: true });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.status, 'verified');
  assert.equal(verified.body.verificationNotice.state, 'sent');
  const pending = app.store.inbox('worker')[0];
  await request('/api/agents/worker/ack', { id: pending.id });
  const retired = await request(`/api/tasks/${taskId}/retire`, { from: 'lead' });
  assert.deepEqual(retired.body.retiredAgentIds, ['worker']);
  assert.equal(app.store.agent('worker').status, 'stopped');
  assert.notEqual(app.store.agent('lead').status, 'stopped');
  assert.equal((await (await fetch(url + '/api/state', { headers: userHeaders(app) })).json()).tasks.length, 1);
  assert.equal((await fetch(url + '/vendor/marked.js')).status, 200);
  assert.equal((await fetch(url + '/vendor/purify.js')).status, 200);
});

test('an agent message that mentions a stopped agent is rejected, while the user may still mention one', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await temp(t),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${port}`;
  const post = async (path, data) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { ...userHeaders(app) },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  for (const id of ['lead', 'worker', 'retired']) await post('/api/agents', agent(id));
  await post('/api/conversations', {
    kind: 'room',
    id: 'guard-room',
    name: 'Guard',
    from: 'lead',
    members: ['worker', 'retired'],
  });
  app.store.updateAgent('retired', { status: 'stopped' });
  for (const status of ['error', 'idle']) {
    app.store.updateAgent('retired', { status });
    assert.equal(
      (await post('/api/messages', { from: 'worker', conversationId: 'guard-room', text: `@retired fyi (${status})` }))
        .status,
      201,
    );
  }
  app.store.updateAgent('retired', { status: 'stopped' });
  const rejected = await post('/api/messages', {
    from: 'worker',
    conversationId: 'guard-room',
    text: 'Report done, cc @retired',
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /@retired is stopped/);
  assert.equal(
    app.store.messages(50, 'guard-room').some((message) => message.text.includes('cc @retired')),
    false,
  );
  assert.equal(
    (await post('/api/messages', { conversationId: 'guard-room', text: '@retired are you there?' })).status,
    201,
  );
});

test('HTTP chat sends return 503 with the reconnect message when IRC is unavailable', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await temp(t),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${port}`;
  const reconnectMessage = 'IRC connection for mu-observer closed; Mu reconnects when the broker answers';
  app.chat.state.connected = false;
  app.chat.state.error = reconnectMessage;
  let sendCalls = 0;
  app.chat.send = async () => {
    sendCalls += 1;
    throw new Error(reconnectMessage);
  };

  const unavailable = await fetch(url + '/api/messages', {
    method: 'POST',
    headers: { ...userHeaders(app) },
    body: JSON.stringify({ conversationId: 'common', text: 'while the broker is down' }),
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: reconnectMessage });
  assert.equal(sendCalls, 0);

  app.chat.state.connected = true;
  app.chat.send = async () => {
    app.chat.state.connected = false;
    throw new Error(reconnectMessage);
  };
  const disconnectedDuringSend = await fetch(url + '/api/messages', {
    method: 'POST',
    headers: { ...userHeaders(app) },
    body: JSON.stringify({ conversationId: 'common', text: 'during the disconnect' }),
  });
  assert.equal(disconnectedDuringSend.status, 503);
  assert.deepEqual(await disconnectedDuringSend.json(), { error: reconnectMessage });
});

test('agent assignment returns 503 when IRC disconnects during member connection', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await temp(t),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${port}`;
  const payload = agent('worker');
  const reconnectMessage = 'IRC connection for mu-observer closed; Mu reconnects when the broker answers';
  app.chat.connect = async () => {
    app.chat.state.connected = false;
    app.chat.state.error = reconnectMessage;
    throw new Error('connection failed');
  };

  const disconnected = await fetch(url + '/api/agents', {
    method: 'POST',
    headers: { ...userHeaders(app) },
    body: JSON.stringify(payload),
  });
  assert.equal(disconnected.status, 503);
  assert.deepEqual(await disconnected.json(), { error: reconnectMessage });
  assert.equal(app.store.agent('worker'), null);

  app.chat.state.connected = true;
  app.chat.connect = async () => {
    throw new Error('registration failed for an unrelated reason');
  };
  const unrelatedFailure = await fetch(url + '/api/agents', {
    method: 'POST',
    headers: { ...userHeaders(app) },
    body: JSON.stringify(payload),
  });
  assert.equal(unrelatedFailure.status, 500);
  assert.deepEqual(await unrelatedFailure.json(), { error: 'registration failed for an unrelated reason' });
  assert.equal(app.store.agent('worker'), null);
});
