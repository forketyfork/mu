import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp, ROOT } from '../src/server.mjs';
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
  close() {}
  async syncConversation() {}
  async send(from, text, conversationId) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId);
  }
}

const agent = (id) => ({ id, role: id === 'lead' ? 'lead' : 'worker', adapter: 'manual', cwd: ROOT, task: '' });

async function startApp(t, port) {
  const dataDir = await shortTempDir(t, 'notice');
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir,
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const post = async (path, data) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: userHeaders(app),
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  await post('/api/agents', agent('lead'));
  await post('/api/agents', agent('worker'));
  await post('/api/conversations', {
    kind: 'room',
    id: 'issue-7',
    name: 'Issue 7',
    from: 'lead',
    members: ['worker'],
    sourceConversationId: 'dm-lead',
  });
  const notices = () => app.store.messages(300, 'issue-7').filter((message) => message.from === 'system');
  return { app, post, notices };
}

test('a user room message without a member mention gets a notice that wakes nobody', async (t) => {
  const { app, post, notices } = await startApp(t, await freePort());
  const sent = await post('/api/messages', { text: 'Is the build green?', conversationId: 'issue-7' });
  assert.equal(sent.status, 201);
  assert.equal(notices().length, 1);
  assert.match(notices()[0].text, new RegExp(`^@user Message #${sent.body.id} reached no agent`));
  assert.deepEqual(notices()[0].mentions, ['user']);
  assert.equal(app.store.inbox('lead').length, 0);
  assert.equal(app.store.inbox('worker').length, 0);

  await post('/api/messages', { text: '@worker Is the build green?', conversationId: 'issue-7' });
  await post('/api/messages', { text: '@all Status, please.', conversationId: 'issue-7' });
  assert.equal(notices().length, 1, 'delivered messages need no notice');
});

test('a user message to a stopped agent says it is queued but not processed', async (t) => {
  const { app, post, notices } = await startApp(t, await freePort());
  await post('/api/agents/worker/stop', {});
  const sent = await post('/api/messages', {
    text: '@worker the build failed, could you check?',
    conversationId: 'issue-7',
  });
  assert.equal(sent.status, 201);
  assert.equal(app.store.inbox('worker')[0].id, sent.body.id, 'the message stays queued for a later resume');
  assert.match(notices()[0].text, /^@user Message #\d+ is queued, but nobody will process it now: worker \(stopped\)/);
  assert.deepEqual(notices()[0].mentions, ['user']);
  assert.equal(app.store.inbox('lead').length, 0);

  await post('/api/messages', { text: 'are you there?', conversationId: 'dm-worker' });
  const direct = app.store.messages(300, 'dm-worker').filter((message) => message.from === 'system');
  assert.equal(direct.length, 1);
  assert.match(direct[0].text, /worker \(stopped\)/);
});

test('agent messages that mention stopped agents are rejected without a notice', async (t) => {
  const { app, post, notices } = await startApp(t, await freePort());
  await post('/api/agents/worker/stop', {});
  assert.equal(
    (
      await post('/api/messages', {
        from: 'lead',
        text: 'Retired @worker; its history is kept.',
        conversationId: 'issue-7',
      })
    ).status,
    400,
  );
  assert.equal(
    (await post('/api/messages', { from: 'lead', text: 'Summary without a mention.', conversationId: 'issue-7' }))
      .status,
    201,
  );
  assert.equal(notices().length, 0);
  assert.equal(app.store.messages(300, 'issue-7').length, 1);
});
