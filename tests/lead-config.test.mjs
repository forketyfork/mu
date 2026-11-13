import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { readTurn } from '../src/adapters.mjs';
import { CodexRollouts } from '../src/codex-rollout.mjs';
import { Runner } from '../src/runner.mjs';
import { Store } from '../src/store.mjs';
import { createApp, ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { testIdentity, userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, listenLocal, temporaryMuHome } from './isolation.mjs';

const valueAfter = (args, flag) => args[args.lastIndexOf(flag) + 1];

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('configure sends the model, its removal and a request for a new session', async (t) => {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const port = await listenLocal(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { MU_URL: `http://127.0.0.1:${port}`, MU_TOKEN: 'a'.repeat(64) };
  await main(['configure', '--id', 'lead', '--model', 'claude-opus-5-5', '--effort', 'medium'], env);
  await main(['configure', '--id', 'lead', '--model', 'default'], env);
  await main(['configure', '--id', 'lead', '--new-session'], env);
  assert.deepEqual(calls, [
    { from: 'user', model: 'claude-opus-5-5', effort: 'medium' },
    { from: 'user', model: null },
    { from: 'user', newSession: true },
  ]);
});

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

async function service(t) {
  const dataDir = await shortTempDir(t, 'lead-config');
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir,
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const call = async (method, path, data, headers = userHeaders(app)) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

test("the user changes a stopped agent's model and starts it on a new session", async (t) => {
  const { app, call } = await service(t);
  assert.equal(
    (await call('POST', '/api/agents', { id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT })).status,
    201,
  );
  const leadHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue('lead')}` };
  assert.equal(
    (await call('PATCH', '/api/agents/lead', { model: 'haiku' }, leadHeaders)).status,
    403,
    'an agent cannot choose its own model',
  );
  assert.equal(
    (await call('PATCH', '/api/agents/lead', { model: 'haiku' })).status,
    409,
    'the agent must be stopped first',
  );
  await call('POST', '/api/agents/lead/stop', {});
  app.store.updateAgent('lead', {
    sessionId: 'dm-session',
    sessionIds: { 'dm-lead': 'dm-session', room: 'room-session' },
  });

  assert.equal((await call('PATCH', '/api/agents/lead', { model: 'claude-opus-5-5' })).status, 200);
  assert.deepEqual(
    [app.store.agent('lead').model, app.store.agent('lead').sessionIds],
    ['claude-opus-5-5', { 'dm-lead': 'dm-session', room: 'room-session' }],
    'a new model keeps the native sessions',
  );
  assert.equal((await call('GET', '/api/agents')).body.find((agent) => agent.id === 'lead').model, 'claude-opus-5-5');

  assert.equal((await call('PATCH', '/api/agents/lead', { newSession: false })).status, 400);
  assert.equal(app.store.agent('lead').sessionId, 'dm-session', 'a refused request changes nothing');
  assert.equal((await call('PATCH', '/api/agents/lead', { newSession: true })).status, 200);
  assert.deepEqual(
    [app.store.agent('lead').sessionId, app.store.agent('lead').sessionIds, app.store.agent('lead').model],
    [null, {}, 'claude-opus-5-5'],
    "a new session forgets every conversation's session and keeps the model",
  );

  assert.equal((await call('PATCH', '/api/agents/lead', { model: null })).status, 200);
  assert.equal(app.store.agent('lead').model, null);
  const odd = await call('PATCH', '/api/agents/lead', { model: 'not a model' });
  assert.equal(odd.status, 400);
  assert.match(odd.body.error, /^Model must be/);
  const manual = await call('PATCH', '/api/agents/lead', { adapter: 'manual', model: 'haiku' });
  assert.equal(manual.status, 400);
  assert.match(manual.body.error, /manual adapter does not take a model/);
  assert.equal(app.store.agent('lead').adapter, 'claude');
});

test('a pi agent keeps a model, and an agent switching to pi needs one', async (t) => {
  const { app, call } = await service(t);
  assert.equal(
    (await call('POST', '/api/agents', { id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT })).status,
    201,
  );
  await call('POST', '/api/agents/lead/stop', {});
  const toPi = await call('PATCH', '/api/agents/lead', { adapter: 'pi' });
  assert.equal(toPi.status, 400);
  assert.match(toPi.body.error, /pi adapter needs a model/);
  assert.equal(app.store.agent('lead').adapter, 'claude');
  assert.equal(
    (await call('PATCH', '/api/agents/lead', { adapter: 'pi', model: 'anthropic/claude-haiku-5-5' })).status,
    200,
  );
  const clear = await call('PATCH', '/api/agents/lead', { model: null });
  assert.equal(clear.status, 400);
  assert.match(clear.body.error, /pi adapter needs a model/);
  assert.equal(app.store.agent('lead').model, 'anthropic/claude-haiku-5-5');
});

test("a lead's own model beats roleCliArgs, and a new session drops --resume", async (t) => {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT, task: 'Coordinate' });
  store.updateAgent('lead', { sessionIds: { 'dm-lead': 'existing-session' } });
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: { state: { connected: true }, async send() {} },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    codexRollouts: new CodexRollouts(join(ROOT, '.tmp/no-codex-home')),
    pricing: offlinePricing(),
    roleCliArgs: { lead: { claude: ['--model', 'claude-opus-5-5', '--effort', 'medium'] } },
  });
  const runs = [];
  runner.execute = async (command) => {
    runs.push(command.args);
    return readTurn(command.format, '{"type":"result","result":"NO_REPLY"}');
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  const turn = async (id) => {
    store.addMessage(id, 'user', 'Go', 'dm-lead');
    runner.kick();
    await until(() => runs.length === Number(id.slice(1)));
    await until(() => !runner.active.size);
    return runs.at(-1);
  };

  const configured = await turn('m1');
  assert.equal(
    valueAfter(configured, '--model'),
    'claude-opus-5-5',
    'without an agent model, the configuration selects it',
  );
  assert.equal(valueAfter(configured, '--resume'), 'existing-session');
  store.updateAgent('lead', { model: 'claude-sonnet-5-5' });
  const pinned = await turn('m2');
  assert.equal(
    valueAfter(pinned, '--model'),
    'claude-sonnet-5-5',
    'the agent model comes last and wins over the configured one',
  );
  assert.equal(valueAfter(pinned, '--resume'), 'existing-session', 'the model is passed to a resumed session too');
  store.updateAgent('lead', { model: null, sessionId: null, sessionIds: {} });
  const fresh = await turn('m3');
  assert.equal(valueAfter(fresh, '--model'), 'claude-opus-5-5');
  assert.ok(!fresh.includes('--resume'));
});
