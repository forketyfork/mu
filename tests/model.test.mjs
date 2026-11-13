import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { commandFor } from '../src/adapters.mjs';
import { main } from '../src/cli.mjs';
import { createApp, ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, FAKE_PRIVATE_PATHS, listenLocal, temporaryMuHome } from './isolation.mjs';

const codexOptions = {
  codex: { dataDir: '/data', credentialFile: '/data/credentials/worker', privatePaths: FAKE_PRIVATE_PATHS },
};
const worker = (adapter, extra = {}) => ({ id: 'worker', role: 'worker', adapter, cwd: ROOT, task: '', ...extra });

test('a per-agent model reaches the Claude and Codex command lines and overrides the adapter-wide model', () => {
  const cliArgs = { claude: ['--permission-mode', 'auto', '--model', 'opus'], codex: ['--profile', 'mu'] };
  for (const sessionId of [null, 'existing']) {
    const claude = commandFor(worker('claude', { model: 'haiku', sessionId }), ROOT, {}, cliArgs).args;
    assert.ok(
      claude.lastIndexOf('--model') > claude.indexOf('--model'),
      'the agent model comes after the adapter-wide one',
    );
    assert.equal(claude[claude.lastIndexOf('--model') + 1], 'haiku');
    const codex = commandFor(worker('codex', { model: 'gpt-6-luna', sessionId }), ROOT, {}, cliArgs, codexOptions).args;
    assert.ok(codex.indexOf('-m') > codex.indexOf('exec'), 'codex takes the model as an exec option');
    assert.equal(codex[codex.indexOf('-m') + 1], 'gpt-6-luna');
    assert.equal(codex.includes('existing'), Boolean(sessionId));
  }
  assert.ok(!commandFor(worker('claude'), ROOT).args.includes('--model'));
  assert.ok(!commandFor(worker('codex'), ROOT, {}, {}, codexOptions).args.includes('-m'));
});

test('spawn passes --model to the service', async (t) => {
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
  await main(
    [
      'spawn',
      '--id',
      'cheap',
      '--adapter',
      'claude',
      '--model',
      'haiku',
      '--cwd',
      '.',
      '--task',
      'Rebase',
      '--conversation',
      'room',
      '--task-id',
      'task-1',
    ],
    { MU_URL: `http://127.0.0.1:${port}`, MU_AGENT_ID: 'lead', MU_TOKEN: 'a'.repeat(64) },
  );
  assert.equal(calls[0].model, 'haiku');
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

test('the service stores and reports a valid model and rejects models it cannot pass on', async (t) => {
  const dataDir = await shortTempDir(t, 'model');
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
  const post = async (data) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/agents`, {
      method: 'POST',
      headers: userHeaders(app),
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await post({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT })).status, 201);
  assert.equal(
    (await post({ id: 'cheap', role: 'worker', adapter: 'claude', model: 'claude-haiku-5-5', cwd: ROOT })).status,
    201,
  );
  assert.equal(app.store.agent('cheap').model, 'claude-haiku-5-5');
  const registry = await (await fetch(`http://127.0.0.1:${port}/api/agents`, { headers: userHeaders(app) })).json();
  assert.equal(registry.find((agent) => agent.id === 'cheap').model, 'claude-haiku-5-5');
  assert.equal(registry.find((agent) => agent.id === 'lead').model, null);
  const manual = await post({ id: 'manual-one', role: 'worker', adapter: 'manual', model: 'haiku', cwd: ROOT });
  assert.equal(manual.status, 400);
  assert.match(manual.body.error, /manual adapter does not take a model/);
  assert.equal(
    (await post({ id: 'odd', role: 'worker', adapter: 'claude', model: '--dangerously-skip-permissions', cwd: ROOT }))
      .status,
    400,
  );
  assert.equal((await post({ id: 'odd-two', role: 'worker', adapter: 'claude', model: 'a b', cwd: ROOT })).status, 400);
  assert.equal(app.store.agent('odd'), null);
});
