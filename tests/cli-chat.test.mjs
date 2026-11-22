import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createApp, ROOT } from '../src/server.mjs';
import { main } from '../src/cli.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';

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
    return this.options.onMessage(randomUUID(), from, text, conversationId);
  }
}

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// A running service with a lead, every request it gets, and a terminal whose keyboard and screen the test holds.
async function session(t) {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'cli-chat'),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  app.store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  const requests = [];
  app.server.on('request', (request) => requests.push(`${request.method} ${request.url}`));
  const keyboard = new PassThrough();
  const output = new PassThrough();
  let screen = '';
  output.setEncoding('utf8').on('data', (chunk) => {
    screen += chunk;
  });
  return {
    app,
    requests,
    keyboard,
    screen: () => screen,
    shows: (text) => until(() => screen.includes(text)),
    say: (from, text, conversationId = 'dm-lead') => app.store.addMessage(randomUUID(), from, text, conversationId),
    chat: (...args) =>
      main(
        ['chat', ...args],
        { MU_URL: `http://127.0.0.1:${port}`, MU_TOKEN: app.identity.token },
        { terminal: { input: keyboard, output, pollMs: 5 } },
      ),
  };
}

test('chat shows the latest messages of its conversation and then only what follows the last one shown', async (t) => {
  const { app, requests, keyboard, screen, shows, say, chat } = await session(t);
  say('user', '@lead elsewhere before', 'common');
  for (let index = 1; index <= 25; index++) say(index % 2 ? 'user' : 'lead', `backlog ${index}.`);
  const last = app.store.messages(1, 'dm-lead')[0].id;
  const done = chat('--to', 'lead');
  await shows('@lead (dm-lead). Messages are delivered directly; no mention is needed. Type /quit to leave.');
  assert.deepEqual(
    screen().match(/backlog \d+\./g),
    Array.from({ length: 20 }, (_, index) => `backlog ${index + 6}.`),
  );
  // Polls with nothing new carry the same cursor and print nothing.
  await until(() => requests.filter((request) => request.includes('after=')).length >= 3);
  keyboard.write('Ship it\n');
  await shows('user: Ship it\n');
  say('user', '@lead elsewhere meanwhile', 'common');
  const reply = say('lead', 'On it');
  await shows('lead: On it\n');
  await until(() => requests.at(-1) === `GET /api/conversations/dm-lead/messages?after=${reply.id}`);
  keyboard.write('/quit\n');
  assert.equal(await done, undefined);

  assert.equal(app.store.messages(2, 'dm-lead')[0].text, 'Ship it');
  assert.doesNotMatch(screen(), /elsewhere/);
  assert.equal(screen().match(/user: Ship it\n/g).length, 1);
  assert.equal(screen().match(/lead: On it\n/g).length, 1);
  // The whole state holds the latest messages of every conversation; a chat reads its own conversation only.
  assert.deepEqual(requests.slice(0, 3), [
    'GET /api/conversations',
    'GET /api/conversations/dm-lead/messages?limit=20',
    `GET /api/conversations/dm-lead/messages?after=${last}`,
  ]);
  assert.deepEqual([...new Set(requests.slice(2).map((request) => request.replace(/after=\d+$/, 'after=N')))].sort(), [
    'GET /api/conversations/dm-lead/messages?after=N',
    'POST /api/messages',
  ]);
  const cursors = requests.flatMap((request) => (/after=(\d+)$/.exec(request) ?? []).slice(1).map(Number));
  assert.deepEqual(
    cursors,
    cursors.toSorted((a, b) => a - b),
  );
  assert.deepEqual([...new Set(cursors)], [last, last + 1, reply.id]);
});

test('chat prints more new messages than one page holds, in order and without a gap', async (t) => {
  const { requests, keyboard, screen, shows, say, chat } = await session(t);
  const done = chat('--conversation', 'dm-lead');
  await shows('Type /quit to leave.');
  for (let index = 1; index <= 650; index++) say('lead', `burst ${index}.`);
  await shows('lead: burst 650.\n');
  keyboard.write('/quit\n');
  await done;
  assert.deepEqual(
    screen().match(/burst \d+\./g),
    Array.from({ length: 650 }, (_, index) => `burst ${index + 1}.`),
  );
  assert.ok(!requests.includes('GET /api/state'));
});

test('chat refuses a conversation that does not exist before it reads any message', async (t) => {
  const { requests, chat } = await session(t);
  await assert.rejects(chat('--conversation', 'missing'), /Unknown conversation: missing\. Use room list/);
  assert.deepEqual(requests, ['GET /api/conversations']);
});
