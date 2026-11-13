import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createApp, ROOT } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { createDashboardStream } from '../src/dashboard.mjs';
import { applyChanges, conversationActivity } from '../public/model.js';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';

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
  async send(from, text, conversationId) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId);
  }
}

const agent = (id) => ({ id, role: id === 'lead' ? 'lead' : 'worker', adapter: 'manual', cwd: ROOT, task: '' });

async function start(t, options = {}) {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'stream'),
    chatFactory: (chatOptions) => new FakeChat(chatOptions),
    pricing: offlinePricing(),
    ...options,
  });
  await app.start();
  t.after(() => app.close());
  return { app, url: `http://127.0.0.1:${port}` };
}

// An event stream client that keeps every event with its ID, name and parsed data.
function open(t, app, url, lastEventId) {
  const events = [];
  const waiters = [];
  let bytes = 0;
  let buffer = '';
  const settle = () => {
    for (const waiter of [...waiters])
      if (events.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(events.slice(0, waiter.count));
      }
  };
  const request = http.get(`${url}/api/events`, {
    headers: { ...userHeaders(app), ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
  });
  const ready = new Promise((resolve, reject) => {
    request.on('error', reject);
    request.on('response', (response) => {
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'], /^text\/event-stream/);
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const fields = Object.fromEntries(
            block
              .split('\n')
              .filter((line) => line && !line.startsWith(':'))
              .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
          );
          if (fields.event) events.push({ id: fields.id, event: fields.event, data: JSON.parse(fields.data) });
        }
        settle();
      });
      resolve();
    });
  });
  t.after(() => request.destroy());
  return {
    ready,
    events,
    get bytes() {
      return bytes;
    },
    close: () => request.destroy(),
    // Resolves with the first event that matches.
    find(predicate) {
      return new Promise((resolve, reject) => {
        const check = () => events.find(predicate);
        const timer = setInterval(() => {
          if (!check()) return;
          clearInterval(timer);
          clearTimeout(limit);
          resolve(check());
        }, 10);
        const limit = setTimeout(() => {
          clearInterval(timer);
          reject(new Error(`Timed out after ${events.length} events`));
        }, 10000);
      });
    },
    // Resolves with the first `count` events once that many arrived.
    until(count) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out at ${events.length} of ${count} events`)), 5000);
        waiters.push({
          count,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
        });
        settle();
      });
    },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a dashboard starts with a snapshot that holds no message history, only where each conversation ends', async (t) => {
  const { app, url } = await start(t);
  app.store.createAgent(agent('lead'));
  app.store.addMessage('m1', 'user', 'first', 'dm-lead');
  app.store.addMessage('m2', 'lead', 'second', 'dm-lead');
  app.store.addMessage('m3', 'user', 'in common', 'common');
  await tick();
  const stream = open(t, app, url);
  const [snapshot] = await stream.until(1);
  assert.equal(snapshot.event, 'snapshot');
  assert.equal(snapshot.id, `${app.dashboard.epoch}:${app.dashboard.seq}`);
  assert.equal(snapshot.data.messages, undefined, 'no message is sent before a conversation is opened');
  assert.deepEqual(snapshot.data.lastMessageIds, { common: 3, 'dm-lead': 2 });
  assert.deepEqual(
    snapshot.data.agents.map((item) => [item.id, item.pending]),
    [['lead', 1]],
  );
  assert.deepEqual(
    snapshot.data.conversations.map((conversation) => conversation.id),
    ['common', 'dm-lead'],
  );
  assert.deepEqual(snapshot.data.transport, { connected: true });
  assert.ok(snapshot.data.adapters.includes('manual'));
});

test('dashboard state and live updates identify the conversation of each running turn', async (t) => {
  const { app, url } = await start(t);
  app.store.createAgent(agent('lead'));
  app.store.createConversation({ id: 'room-a', kind: 'room', name: 'Room A', members: ['lead'] });
  await tick();
  const stream = open(t, app, url);
  const [snapshot] = await stream.until(1);
  assert.equal(snapshot.data.agents[0].activeConversationId, null);

  app.runner.active.set('lead', { child: { pid: 12345 }, conversationId: 'room-a' });
  app.store.changed(['agents', 'lead']);
  const started = await stream.find(
    (event) =>
      event.event === 'changes' &&
      event.data.changes.some((change) => change.kind === 'agents' && change.id === 'lead'),
  );
  assert.equal(started.data.changes.find((change) => change.id === 'lead').value.activeConversationId, 'room-a');
  assert.equal(started.data.changes.find((change) => change.id === 'lead').value.pid, 12345);
  const stateResponse = await fetch(`${url}/api/state`, { headers: userHeaders(app) });
  const state = await stateResponse.json();
  assert.equal(state.agents[0].activeConversationId, 'room-a');

  app.runner.active.delete('lead');
  app.store.changed(['agents', 'lead']);
  const ended = await stream.find(
    (event) =>
      event.event === 'changes' &&
      event.data.changes.some(
        (change) => change.kind === 'agents' && change.id === 'lead' && change.value?.activeConversationId === null,
      ),
  );
  assert.equal(ended.data.changes.find((change) => change.id === 'lead').value.activeConversationId, null);
});

test('a failing managed turn keeps its room verb steady and stops the ticker when failure is recorded', async (t) => {
  const directory = await shortTempDir(t, 'ticker-failure');
  const readyFile = `${directory}/ready`;
  const failFile = `${directory}/fail`;
  const script = `${directory}/adapter.mjs`;
  await writeFile(
    script,
    `import { existsSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(readyFile)}, 'ready');\nprocess.stdin.resume();\nconst poll = setInterval(() => { if (existsSync(${JSON.stringify(failFile)})) { clearInterval(poll); process.exit(1); } }, 10);\n`,
  );
  const { app, url } = await start(t, {
    custom: { controlled: { command: process.execPath, args: [script] } },
  });
  app.store.createAgent({ ...agent('worker'), adapter: 'controlled', conversationId: 'room-a' });
  const room = app.store.createConversation({ id: 'room-a', kind: 'room', name: 'Room A', members: ['worker'] });
  await tick();
  const stream = open(t, app, url);
  await stream.until(1);

  /** @type {() => void} */
  let releaseNotice = () => {};
  let noticeStarted;
  const noticeStartedPromise = new Promise((resolve) => {
    noticeStarted = resolve;
  });
  const noticeGate = new Promise((resolve) => {
    releaseNotice = () => resolve();
  });
  const close = app.close.bind(app);
  app.close = () => {
    releaseNotice();
    return close();
  };
  const send = app.chat.send.bind(app.chat);
  app.chat.send = async (from, text, conversationId, options) => {
    if (from === 'system' && text.includes('agent worker could not complete')) {
      noticeStarted();
      await noticeGate;
    }
    return send(from, text, conversationId, options);
  };

  await app.chat.send('user', '@worker Investigate', 'room-a');
  const started = await stream.find(
    (event) =>
      event.event === 'changes' &&
      event.data.changes.some(
        (change) =>
          change.kind === 'agents' &&
          change.id === 'worker' &&
          change.value?.activeConversationId === 'room-a' &&
          change.value.activeMessageId,
      ),
  );
  const initialAgent = started.data.changes.find((change) => change.id === 'worker').value;
  assert.equal(app.runner.active.get('worker')?.conversationId, 'room-a');
  const initialActivity = conversationActivity([initialAgent], room);
  assert.equal(initialActivity.length, 1);

  await until(() => existsSync(readyFile));
  await app.chat.send('user', '@worker Follow-up', 'dm-worker');
  const stillRunning = await stream.find(
    (event) =>
      event.event === 'changes' &&
      event.data.changes.some(
        (change) =>
          change.kind === 'agents' &&
          change.id === 'worker' &&
          change.value?.pending === 2 &&
          change.value.activeMessageId === initialAgent.activeMessageId,
      ),
  );
  const activeAgent = stillRunning.data.changes.find((change) => change.id === 'worker').value;
  assert.equal(
    conversationActivity([activeAgent], room)[0].verb,
    initialActivity[0].verb,
    'the same active message keeps its verb through an unrelated state update',
  );

  await writeFile(failFile, 'fail');
  await noticeStartedPromise;
  const failed = await stream.find(
    (event) =>
      event.event === 'changes' &&
      event.data.changes.some(
        (change) =>
          change.kind === 'agents' &&
          change.id === 'worker' &&
          change.value?.status === 'error' &&
          change.value.activeMessageId === null,
      ),
  );
  const failedAgent = failed.data.changes.find((change) => change.id === 'worker').value;
  assert.equal(failedAgent.activeConversationId, 'room-a', 'the failed turn is still unwinding its runner entry');
  assert.deepEqual(conversationActivity([failedAgent], room), []);
  releaseNotice();
  await until(() => !app.runner.active.size);
});

test('a stopped managed turn disappears from the ticker before its process exits', async (t) => {
  const directory = await shortTempDir(t, 'ticker-stop');
  const readyFile = `${directory}/ready`;
  const script = `${directory}/adapter.mjs`;
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';\nprocess.on('SIGTERM', () => {});\nwriteFileSync(${JSON.stringify(readyFile)}, 'ready');\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
  );
  const { app, url } = await start(t, {
    custom: { stubborn: { command: process.execPath, args: [script] } },
  });
  app.store.createAgent({ ...agent('worker'), adapter: 'stubborn', conversationId: 'room-a' });
  const room = app.store.createConversation({ id: 'room-a', kind: 'room', name: 'Room A', members: ['worker'] });
  await tick();
  const stream = open(t, app, url);
  await stream.until(1);
  await app.chat.send('user', '@worker Investigate', 'room-a');
  await stream.find(
    (event) =>
      event.event === 'changes' &&
      event.data.changes.some(
        (change) =>
          change.kind === 'agents' &&
          change.id === 'worker' &&
          change.value?.activeConversationId === 'room-a' &&
          change.value.activeMessageId,
      ),
  );
  await until(() => existsSync(readyFile));

  app.runner.stop('worker');
  const stopped = await stream.find(
    (event) =>
      event.event === 'changes' &&
      event.data.changes.some(
        (change) =>
          change.kind === 'agents' &&
          change.id === 'worker' &&
          change.value?.status === 'stopped' &&
          change.value.activeMessageId === null,
      ),
  );
  const stoppedAgent = stopped.data.changes.find((change) => change.id === 'worker').value;
  assert.equal(app.runner.active.has('worker'), true, 'the ignored SIGTERM leaves the runner entry alive');
  assert.equal(stoppedAgent.activeConversationId, 'room-a');
  assert.deepEqual(conversationActivity([stoppedAgent], room), []);
});

test('a change sends only the records it changed, in one numbered batch per turn of the event loop', async (t) => {
  const { app, url } = await start(t);
  app.store.createAgent(agent('lead'));
  app.store.createAgent(agent('dev'));
  await tick();
  const stream = open(t, app, url);
  const [snapshot] = await stream.until(1);
  const seq = snapshot.data.seq;

  app.store.updateAgent('dev', { status: 'working' });
  app.store.updateAgent('dev', { status: 'blocked' });
  const [, first] = await stream.until(2);
  assert.equal(first.event, 'changes');
  assert.equal(first.data.seq, seq + 1);
  assert.equal(first.id, `${app.dashboard.epoch}:${seq + 1}`);
  assert.deepEqual(
    first.data.changes.map((change) => [change.kind, change.id, change.value.status]),
    [['agents', 'dev', 'blocked']],
    'two updates in one turn leave as one change with the latest record',
  );

  const message = await app.chat.send('user', 'hello', 'dm-lead');
  const [, , second] = await stream.until(3);
  assert.equal(second.data.seq, seq + 2);
  assert.deepEqual(
    second.data.changes.map((change) => [change.kind, change.id]),
    [
      ['agents', 'lead'],
      ['messages', String(message.id)],
    ],
    "the message, and the queue count of its recipient; the other agent's record is not sent",
  );
  assert.equal(second.data.changes[0].value.pending, 1);
  assert.deepEqual(second.data.changes[1].value, message);

  const card = app.waiting.add({ text: 'Decide the release' }, 'lead');
  const [, , , added] = await stream.until(4);
  assert.deepEqual(
    added.data.changes.map((change) => [change.kind, change.id, change.value.text]),
    [['waiting', card.id, 'Decide the release']],
  );

  // A change that leaves a record as it was sends nothing, and neither does a card that comes and goes in one turn.
  app.store.ack('lead', message.id);
  app.store.changed(['agents', 'dev'], ['activities', null]);
  app.waiting.remove(card.id, 'lead');
  const brief = app.waiting.add({ text: 'Gone at once' }, 'lead');
  app.waiting.remove(brief.id, 'lead');
  app.chat.state.connected = false;
  app.chat.emit('change');
  const [, , , , last] = await stream.until(5);
  assert.equal(last.data.seq, seq + 4);
  assert.deepEqual(
    last.data.changes.map((change) => [change.kind, change.id ?? null, change.value]),
    [
      ['agents', 'lead', app.dashboard.snapshot().agents[0]],
      ['waiting', card.id, null],
      ['transport', null, { connected: false }],
    ],
    'only the acknowledgement changed an agent; dev and the activities stayed as they were',
  );
  assert.equal(last.data.changes[0].value.pending, 0);
});

test('a dashboard that reconnects with the last event ID receives only the batches it missed, in order', async (t) => {
  const { app, url } = await start(t);
  app.store.createAgent(agent('lead'));
  await tick();
  const first = open(t, app, url);
  const [snapshot] = await first.until(1);
  app.store.updateAgent('lead', { status: 'working' });
  const [, seen] = await first.until(2);
  first.close();
  await tick();
  for (const status of ['blocked', 'done', 'idle']) {
    app.store.updateAgent('lead', { status });
    await tick();
  }
  assert.equal(app.dashboard.seq, snapshot.data.seq + 4);

  const again = open(t, app, url, seen.id);
  const replayed = await again.until(3);
  assert.deepEqual(
    replayed.map((event) => [event.event, event.data.seq, event.data.changes[0].value.status]),
    [
      ['changes', snapshot.data.seq + 2, 'blocked'],
      ['changes', snapshot.data.seq + 3, 'done'],
      ['changes', snapshot.data.seq + 4, 'idle'],
    ],
  );
  app.store.updateAgent('lead', { status: 'working' });
  const [, , , live] = await again.until(4);
  assert.equal(live.data.seq, snapshot.data.seq + 5, 'live batches continue the sequence');

  const current = open(t, app, url, live.id);
  const opened = Date.now();
  await current.ready;
  assert.ok(Date.now() - opened < 1000, 'a stream with nothing to replay opens at once');
  app.store.updateAgent('lead', { status: 'blocked' });
  const [next] = await current.until(1);
  assert.equal(next.event, 'changes', 'a dashboard that missed nothing gets no snapshot');
  assert.equal(next.data.seq, snapshot.data.seq + 6);
});

test('a reconnect that names another process, a future batch or one no longer held starts over with a snapshot', async (t) => {
  const { app, url } = await start(t, {});
  app.store.createAgent(agent('lead'));
  await tick();
  // The replay holds the latest batches only, so the first ones are gone after a burst.
  for (let index = 0; index < 1005; index += 1) {
    app.store.updateAgent('lead', { task: `step ${index}` });
    await tick();
  }
  const { epoch, seq } = app.dashboard;
  for (const lastEventId of ['0badbeef:3', `${epoch}:${seq + 1}`, `${epoch}:1`, 'garbage']) {
    const stream = open(t, app, url, lastEventId);
    const [event] = await stream.until(1);
    assert.equal(event.event, 'snapshot', lastEventId);
    assert.equal(event.data.seq, seq, lastEventId);
    stream.close();
  }
  const held = open(t, app, url, `${epoch}:${seq - 999}`);
  const replayed = await held.until(999);
  assert.equal(replayed[0].data.seq, seq - 998);
  assert.equal(replayed.at(-1).data.seq, seq);
});

test('every open dashboard receives the same batches', async (t) => {
  const { app, url } = await start(t);
  app.store.createAgent(agent('lead'));
  await tick();
  const tabs = [open(t, app, url), open(t, app, url)];
  await Promise.all(tabs.map((tab) => tab.until(1)));
  const message = await app.chat.send('user', 'to both tabs', 'dm-lead');
  const batches = await Promise.all(tabs.map(async (tab) => (await tab.until(2))[1]));
  assert.deepEqual(batches[0], batches[1]);
  assert.ok(batches[0].data.changes.some((change) => change.kind === 'messages' && change.value.id === message.id));
  assert.equal(app.dashboard.streams.size, 2);
  tabs[0].close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(app.dashboard.streams.size, 1, 'a closed tab is forgotten');
});

test('a message batch is a fraction of the size of the whole workspace', async (t) => {
  const { app, url } = await start(t);
  app.store.createAgent(agent('lead'));
  for (let index = 0; index < 40; index += 1) {
    app.store.createConversation({ id: `room-${index}`, kind: 'room', name: `Room ${index}`, members: ['lead'] });
    for (let message = 0; message < 20; message += 1)
      app.store.addMessage(`${index}-${message}`, 'lead', `Message ${message} ${'x'.repeat(200)}`, `room-${index}`);
  }
  await tick();
  const stream = open(t, app, url);
  await stream.until(1);
  const before = stream.bytes;
  await app.chat.send('user', '@lead one more', 'room-0');
  await stream.until(2);
  const batch = stream.bytes - before;
  const whole = Buffer.byteLength(JSON.stringify(app.state()));
  assert.ok(batch < 2000, `a batch of one message is ${batch} bytes`);
  assert.ok(whole > 100 * batch, `the whole workspace is ${whole} bytes`);
});

test('the history of a conversation is read in pages before or after a message, and a message by its ID', async (t) => {
  const { app, url } = await start(t);
  app.store.createAgent(agent('lead'));
  app.store.createAgent(agent('dev'));
  app.store.createConversation({ id: 'room', kind: 'room', name: 'Room', members: ['lead'] });
  for (let index = 1; index <= 5; index += 1) app.store.addMessage(`r${index}`, 'lead', `room ${index}`, 'room');
  const get = async (path, headers = userHeaders(app)) => {
    const response = await fetch(url + path, { headers });
    return { status: response.status, body: await response.json() };
  };
  const texts = (body) => body.messages.map((message) => message.text);
  assert.deepEqual(texts((await get('/api/conversations/room/messages?after=2&limit=2')).body), ['room 3', 'room 4']);
  assert.deepEqual(texts((await get('/api/conversations/room/messages?after=0')).body).length, 5);
  assert.deepEqual(texts((await get('/api/conversations/room/messages?before=3')).body), ['room 1', 'room 2']);
  for (const query of ['after=-1', 'after=x', 'after=1&before=4'])
    assert.equal((await get(`/api/conversations/room/messages?${query}`)).status, 400, query);
  assert.deepEqual((await get('/api/messages/3')).body, app.store.message(3));
  assert.equal((await get('/api/messages/99')).status, 404);
  const devHeaders = { Authorization: `Bearer ${app.identity.issue('dev')}` };
  assert.equal((await get('/api/messages/3', devHeaders)).status, 404, 'a non-member cannot tell the message exists');
  const leadHeaders = { Authorization: `Bearer ${app.identity.issue('lead')}` };
  assert.equal((await get('/api/messages/3', leadHeaders)).body.text, 'room 3');
});

test('a store change must say what it changed, so that the dashboard cannot miss it', () => {
  const store = new Store();
  assert.throws(() => store.emit('change'), /lists what changed/);
  assert.throws(() => store.emit('change', [['secrets', null]]), /lists what changed/);
  assert.throws(() => store.emit('change', [['agents', 7]]), /lists what changed/);
  const seen = [];
  store.on('change', (changes) => seen.push(changes));
  store.createAgent(agent('lead'));
  store.transaction(() => {
    store.updateAgent('lead', { status: 'working' });
    store.createConversation({ id: 'room', kind: 'room', name: 'Room', members: ['lead'] });
  });
  assert.deepEqual(seen, [
    [['conversations', 'dm-lead']],
    [
      ['agents', 'lead'],
      ['conversations', 'common'],
    ],
    [
      ['agents', 'lead'],
      ['conversations', 'room'],
    ],
  ]);
  store.close();
});

test("a managed turn's process ID reaches the dashboard when the process starts, and goes when the turn ends", async (t) => {
  const { app, url } = await start(t, {
    custom: {
      slow: {
        command: process.execPath,
        args: [
          '-e',
          "process.stdin.resume(); setTimeout(() => { process.stdout.write('finished'); process.exit(0); }, 300)",
        ],
      },
    },
  });
  app.store.createAgent(agent('lead'));
  app.store.createAgent({ ...agent('worker'), adapter: 'slow' });
  await tick();
  const stream = open(t, app, url);
  await stream.until(1);
  const worker = (event) =>
    event.event === 'changes'
      ? event.data.changes.find((change) => change.kind === 'agents' && change.id === 'worker')
      : undefined;
  await app.chat.send('user', 'start', 'dm-worker');
  const running = await stream.find((event) => worker(event)?.value.pid);
  assert.equal(worker(running).value.status, 'working');
  const ended = await stream.find((event) => event.data.seq > running.data.seq && worker(event)?.value.pid === null);
  assert.ok(ended);
  await stream.find(() => !app.runner.active.size);
});

test("a stopped turn's process ID leaves the dashboard", async (t) => {
  const { app, url } = await start(t, {
    custom: {
      hang: { command: process.execPath, args: ['-e', 'process.stdin.resume(); setTimeout(() => {}, 60000)'] },
    },
  });
  app.store.createAgent(agent('lead'));
  app.store.createAgent({ ...agent('worker'), adapter: 'hang' });
  await tick();
  const stream = open(t, app, url);
  const [snapshot] = await stream.until(1);
  await app.chat.send('user', 'start', 'dm-worker');
  await stream.find(
    (event) =>
      event.event === 'changes' &&
      event.data.changes.some((change) => change.kind === 'agents' && change.id === 'worker' && change.value.pid),
  );
  const stopped = await fetch(`${url}/api/agents/worker/stop`, {
    method: 'POST',
    headers: userHeaders(app),
    body: '{}',
  });
  assert.equal(stopped.status, 200);
  while (app.runner.active.size) await new Promise((resolve) => setTimeout(resolve, 10));
  await tick();
  await stream.until(1 + app.dashboard.seq - snapshot.data.seq);
  const shown = fold(stream.events).agents.find((item) => item.id === 'worker');
  assert.deepEqual([shown.status, shown.pid], ['stopped', null]);
});

// A stream over in-memory sources, with a response that keeps what it is sent.
function memoryStream(records) {
  let reads = 0;
  const source = (kind) => ({
    list: () => {
      reads += 1;
      return Object.values(records[kind]);
    },
    get: (id) => {
      reads += 1;
      return records[kind][id] ?? null;
    },
  });
  const dashboard = createDashboardStream({
    sources: Object.fromEntries(
      ['agents', 'tasks', 'waiting', 'activities', 'conversations'].map((kind) => [kind, source(kind)]),
    ),
    lastMessageIds: () => ({}),
    transport: () => ({ connected: true }),
    adapters: [],
  });
  const response = () => {
    const events = [];
    return {
      events,
      writeHead() {},
      flushHeaders() {},
      write(text) {
        const event = /^event: (\S+)$/m.exec(text)?.[1];
        if (event) events.push({ event, data: JSON.parse(/^data: (.*)$/m.exec(text)[1]) });
      },
      on() {},
      end() {},
    };
  };
  return { dashboard, response, reads: () => reads };
}

// The state a dashboard holds after the snapshot and the batches that followed it.
function fold(events) {
  const [first, ...rest] = events;
  assert.equal(first.event, 'snapshot');
  let state = { ...first.data, messages: [], lastMessageId: 0 };
  let seq = first.data.seq;
  for (const { event, data } of rest) {
    assert.equal(event, 'changes');
    assert.equal(data.seq, seq + 1, 'batches follow each other');
    seq = data.seq;
    state = applyChanges(state, data.changes).state;
  }
  return state;
}

test('a dashboard that connects between two changes of one record in one turn still ends with the current record', async () => {
  const records = { agents: { a: { id: 'a', pending: 0 } }, tasks: {}, waiting: {}, activities: {}, conversations: {} };
  const { dashboard, response } = memoryStream(records);
  const early = response();
  dashboard.connect(/** @type {any} */ (early), undefined);
  records.agents.a = { id: 'a', pending: 1 };
  dashboard.change([['agents', 'a']]);
  records.waiting.w = { id: 'w', text: 'Decide' };
  dashboard.change([['waiting', 'w']]);
  const late = response();
  dashboard.connect(/** @type {any} */ (late), undefined);
  records.agents.a = { id: 'a', pending: 0 };
  dashboard.change([['agents', 'a']]);
  delete records.waiting.w;
  dashboard.change([['waiting', 'w']]);
  await tick();
  for (const stream of [early, late]) {
    const state = fold(stream.events);
    assert.deepEqual(state.agents, [{ id: 'a', pending: 0 }]);
    assert.deepEqual(state.waiting, []);
  }
  assert.equal(late.events[0].data.agents[0].pending, 1, 'the snapshot holds the record between the changes');
  dashboard.close();
});

test('a change named after the stream closed reads no source', async () => {
  const records = { agents: { a: { id: 'a' } }, tasks: {}, waiting: {}, activities: {}, conversations: {} };
  const { dashboard, reads } = memoryStream(records);
  const before = reads();
  dashboard.close();
  dashboard.change([['agents', 'a']]);
  dashboard.message({ id: 1, conversationId: 'common' });
  dashboard.transportChanged();
  await tick();
  assert.equal(reads(), before);
});

test('the snapshot and every batch after it add up to the current workspace, step by step', async (t) => {
  const { app, url } = await start(t, {
    custom: {
      quick: {
        command: process.execPath,
        args: [
          '-e',
          "process.stdin.resume(); setTimeout(() => { process.stdout.write('done'); process.exit(0); }, 50)",
        ],
      },
    },
  });
  const stream = open(t, app, url);
  await stream.until(1);
  const call = async (method, path, body = {}, headers = userHeaders(app)) => {
    const response = await fetch(url + path, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  // The records and transport; the sequence, the epoch and the message bookkeeping are compared apart.
  const record = (state) =>
    Object.fromEntries(
      ['agents', 'tasks', 'waiting', 'activities', 'conversations', 'transport', 'adapters'].map((key) => [
        key,
        state[key],
      ]),
    );
  const converged = async (step) => {
    while (app.runner.active.size) await new Promise((resolve) => setTimeout(resolve, 10));
    await tick();
    // As sent on the wire: rows that SQLite returns have no prototype.
    const expected = JSON.parse(JSON.stringify(app.dashboard.snapshot()));
    await stream.until(1 + expected.seq - stream.events[0].data.seq);
    const state = fold(stream.events);
    assert.deepEqual(record(state), record(expected), step);
    assert.deepEqual(state.lastMessageIds, expected.lastMessageIds, step);
  };
  const lead = () => ({ ...userHeaders(app), Authorization: `Bearer ${app.identity.issue('lead')}` });

  await call('POST', '/api/agents', {
    id: 'lead',
    role: 'lead',
    adapter: 'manual',
    cwd: ROOT,
    conversationId: 'dm-lead',
  });
  await converged('lead created');
  await call('POST', '/api/conversations', { kind: 'room', id: 'room-a', name: 'Room A', members: ['lead'] });
  await converged('room created');
  const dev = await call('POST', '/api/agents', {
    id: 'dev',
    role: 'worker',
    adapter: 'manual',
    cwd: ROOT,
    conversationId: 'room-a',
    taskTitle: 'Build it',
    task: 'Build the thing',
  });
  await converged('worker with a task');
  await call('POST', '/api/agents', { id: 'auto', role: 'worker', adapter: 'quick', cwd: ROOT });
  await call('POST', '/api/messages', { conversationId: 'dm-auto', text: 'hello' });
  await converged('managed turn');
  await call('POST', '/api/conversations/room-a/members', { members: ['auto'] });
  const question = await call('POST', '/api/messages', { conversationId: 'room-a', text: '@dev status?' });
  await converged('member added and message queued');
  await call('POST', '/api/agents/dev/ack', { id: question.id });
  await call('POST', '/api/agents/dev/ack', { id: app.store.inbox('dev')[0].id });
  await converged('acknowledged');
  await call('PATCH', '/api/agents/dev', { status: 'working' });
  await converged('working');
  const card = await call('POST', '/api/waiting', { text: 'Decide the release', taskId: dev.taskId }, lead());
  await converged('waiting card');
  await call('DELETE', `/api/waiting/${card.id}`, {}, lead());
  await converged('waiting card removed');
  const first = await call('POST', '/api/activities', { text: 'First', lane: 'focus' });
  const second = await call('POST', '/api/activities', { text: 'Second', lane: 'focus' });
  await call('PATCH', `/api/activities/${second.id}`, { lane: 'control', position: 1 });
  await converged('activities added and moved');
  await call('PATCH', `/api/activities/${first.id}`, { checked: true });
  await call('PATCH', `/api/activities/${first.id}`, { checked: false });
  await call('POST', `/api/activities/${first.id}/tasks`, { taskId: dev.taskId });
  await converged('activity checked, unchecked and linked');
  await call('DELETE', `/api/activities/${first.id}/tasks/${dev.taskId}`);
  await call('DELETE', `/api/activities/${second.id}`);
  await converged('activity unlinked and deleted');
  await call('PATCH', `/api/tasks/${dev.taskId}`, { result: 'Built', status: 'ready' }, lead());
  await converged('task ready');
  await call('PATCH', '/api/agents/dev', { status: 'done' });
  await call('POST', `/api/tasks/${dev.taskId}/verify`);
  await converged('task verified and workers retired');
  app.chat.state.connected = false;
  app.chat.emit('change');
  await converged('chat disconnected');
  app.chat.state.connected = true;
  app.chat.emit('change');
  await converged('chat reconnected');
  assert.ok(stream.events.length > 15);
});
