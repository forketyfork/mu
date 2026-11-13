import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandFor } from '../src/adapters.mjs';
import { main } from '../src/cli.mjs';
import { createApp, ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import {
  freePort,
  shortTempDir,
  FAKE_PRIVATE_PATHS,
  FAKE_MU_HOME,
  listenLocal,
  temporaryMuHome,
} from './isolation.mjs';

const codexOptions = {
  codex: { dataDir: '/data', credentialFile: '/data/credentials/worker', privatePaths: FAKE_PRIVATE_PATHS },
};
const worker = (adapter, extra = {}) => ({ id: 'worker', role: 'worker', adapter, cwd: ROOT, task: '', ...extra });
const valueAfter = (args, flag) => args[args.lastIndexOf(flag) + 1];

test('an agent effort reaches each CLI in the form it accepts and overrides an adapter-wide one', async (t) => {
  for (const sessionId of [null, 'existing']) {
    const claude = commandFor(
      worker('claude', { effort: 'xhigh', sessionId }),
      ROOT,
      {},
      { claude: ['--effort', 'low'] },
    ).args;
    assert.ok(
      claude.lastIndexOf('--effort') > claude.indexOf('--effort'),
      'the agent effort comes after the adapter-wide one',
    );
    assert.equal(valueAfter(claude, '--effort'), 'xhigh');
    const codex = commandFor(
      worker('codex', { effort: 'high', sessionId }),
      ROOT,
      {},
      { codex: ['-c', 'model_reasoning_effort=low'] },
      codexOptions,
    ).args;
    assert.ok(
      codex.lastIndexOf('model_reasoning_effort=high') < codex.indexOf('exec'),
      'codex takes config overrides before exec',
    );
    assert.ok(codex.lastIndexOf('model_reasoning_effort=high') > codex.indexOf('model_reasoning_effort=low'));
    assert.equal(codex[codex.indexOf('model_reasoning_effort=high') - 1], '-c');
  }
  const dataDir = await shortTempDir(t, 'effort-pi');
  await mkdir(join(dataDir, 'sockets'), { recursive: true });
  await mkdir(join(dataDir, 'credentials'), { recursive: true });
  const socket = join(dataDir, 'sockets', 'worker.sock'),
    credentialFile = join(dataDir, 'credentials', 'worker');
  await writeFile(socket, '');
  await writeFile(credentialFile, 'own');
  const pi = commandFor(
    worker('pi', { model: 'anthropic/claude-haiku-5-5', effort: 'medium' }),
    ROOT,
    {},
    { pi: ['--thinking', 'off'] },
    {
      pi: {
        dataDir,
        home: FAKE_MU_HOME,
        localPorts: [],
        socket,
        credentialFile,
        platform: 'darwin',
        privatePaths: FAKE_PRIVATE_PATHS,
      },
    },
  ).args;
  assert.ok(pi.lastIndexOf('--thinking') > pi.indexOf('--thinking'));
  assert.equal(valueAfter(pi, '--thinking'), 'medium');

  assert.ok(!commandFor(worker('claude'), ROOT).args.includes('--effort'));
  assert.ok(
    !commandFor(worker('codex'), ROOT, {}, {}, codexOptions).args.some((arg) =>
      arg.startsWith('model_reasoning_effort'),
    ),
  );
});

test('spawn passes --effort, and configure clears it with default', async (t) => {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, body: JSON.parse(body) });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const port = await listenLocal(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { MU_URL: `http://127.0.0.1:${port}`, MU_AGENT_ID: 'lead', MU_TOKEN: 'a'.repeat(64) };
  await main(
    [
      'spawn',
      '--id',
      'regular',
      '--adapter',
      'codex',
      '--model',
      'gpt-6-luna',
      '--effort',
      'high',
      '--cwd',
      '.',
      '--task',
      'Fix',
      '--conversation',
      'room',
      '--task-id',
      'task-1',
    ],
    env,
  );
  await main(['configure', '--id', 'regular', '--effort', 'xhigh'], env);
  await main(['configure', '--id', 'regular', '--effort', 'default'], env);
  await assert.rejects(
    main(['configure', '--id', 'regular'], env),
    /--adapter, --model, --cwd, --effort or --new-session/,
  );
  assert.equal(calls[0].body.effort, 'high');
  assert.deepEqual(
    calls.slice(1).map((call) => [call.method, call.body]),
    [
      ['PATCH', { from: 'lead', effort: 'xhigh' }],
      ['PATCH', { from: 'lead', effort: null }],
    ],
  );
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
  const dataDir = await shortTempDir(t, 'effort');
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

test('the service stores and reports a valid effort and rejects one the adapter cannot take', async (t) => {
  const { app, call } = await service(t);
  const spawn = (data) => call('POST', '/api/agents', { role: 'worker', cwd: ROOT, ...data });
  assert.equal((await spawn({ id: 'lead', role: 'lead', adapter: 'manual' })).status, 201);
  assert.equal((await spawn({ id: 'regular', adapter: 'codex', model: 'gpt-6-luna', effort: 'high' })).status, 201);
  assert.equal((await spawn({ id: 'plain', adapter: 'claude' })).status, 201);
  const registry = (await call('GET', '/api/agents')).body;
  assert.equal(registry.find((agent) => agent.id === 'regular').effort, 'high');
  assert.equal(registry.find((agent) => agent.id === 'plain').effort, null);

  /** @type {[object, RegExp][]} */
  const rejected = [
    [
      { adapter: 'claude', effort: 'none' },
      /claude adapter takes a reasoning effort of low, medium, high, xhigh, max; got "none"/,
    ],
    [{ adapter: 'codex', effort: 'off' }, /codex adapter takes a reasoning effort of none, minimal/],
    [{ adapter: 'claude', effort: 7 }, /got 7/],
    [{ adapter: 'manual', effort: 'high' }, /manual adapter does not take a reasoning effort/],
  ];
  for (const [index, [data, error]] of rejected.entries()) {
    const response = await spawn({ id: `odd-${index}`, ...data });
    assert.equal(response.status, 400, JSON.stringify(data));
    assert.match(response.body.error, error);
    assert.equal(app.store.agent(`odd-${index}`), null);
  }
});

test("the user changes a stopped agent's effort, and a kept effort must suit a new adapter", async (t) => {
  const { app, call } = await service(t);
  assert.equal(
    (await call('POST', '/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT })).status,
    201,
  );
  assert.equal(
    (
      await call('POST', '/api/agents', {
        id: 'regular',
        role: 'worker',
        adapter: 'codex',
        model: 'gpt-6-luna',
        effort: 'none',
        cwd: ROOT,
      })
    ).status,
    201,
  );
  const lead = { 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue('lead')}` };
  assert.equal((await call('PATCH', '/api/agents/regular', { effort: 'max' }, lead)).status, 403);
  assert.equal(
    (await call('PATCH', '/api/agents/regular', { effort: 'max' })).status,
    409,
    'the agent must be stopped first',
  );
  await call('POST', '/api/agents/regular/stop', {});
  app.store.updateAgent('regular', { sessionId: 'thread' });

  const toClaude = await call('PATCH', '/api/agents/regular', { adapter: 'claude' });
  assert.equal(toClaude.status, 400);
  assert.match(
    toClaude.body.error,
    /claude adapter takes a reasoning effort of .*; got "none"; pass an effort for the new adapter, or clear it/,
  );
  assert.equal(app.store.agent('regular').adapter, 'codex');

  assert.equal((await call('PATCH', '/api/agents/regular', { effort: 'xhigh' })).status, 200);
  assert.deepEqual(
    [app.store.agent('regular').effort, app.store.agent('regular').sessionId],
    ['xhigh', 'thread'],
    'a new effort keeps the session',
  );
  assert.equal(
    (await call('PATCH', '/api/agents/regular', { adapter: 'claude' })).status,
    200,
    'xhigh suits claude as well',
  );
  assert.equal((await call('PATCH', '/api/agents/regular', { adapter: 'demo', effort: null })).status, 200);
  assert.deepEqual([app.store.agent('regular').adapter, app.store.agent('regular').effort], ['demo', null]);
  assert.equal((await call('PATCH', '/api/agents/regular', { effort: 'high' })).status, 400);
});
