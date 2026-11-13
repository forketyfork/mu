import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, ROOT } from '../src/server.mjs';
import { main } from '../src/cli.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';
import { RESTART_EXIT_CODE, RESTART_FILE, codeDigest, codeState, launchdJob, startCheck } from '../src/service.mjs';
import { testIdentity } from './identity-fixture.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, listenLocal } from './isolation.mjs';
import { initializeHome } from '../src/home.mjs';

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

async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

// The lead asks for a restart when a message says RESTART-NOW, records each message it handles, and ends its
// turn only once the test releases it. The worker runs until a shutdown interrupts it, then finishes on its resumed turn.
async function adapters(directory, { editFile = null } = {}) {
  const runs = join(directory, 'runs.txt'),
    release = join(directory, 'release'),
    results = join(directory, 'results.txt');
  const lead = join(directory, 'lead.mjs'),
    worker = join(directory, 'worker.mjs');
  await writeFile(
    lead,
    `import {appendFileSync, existsSync} from 'node:fs';
import {main} from ${JSON.stringify(join(ROOT, 'src/cli.mjs'))};
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(runs)}, process.env.MU_MESSAGE_ID + '\\n');
if (!prompt.includes('RESTART-NOW')) { console.log('NO_REPLY'); process.exit(0); }
let result; try { result = await main(['restart']); } catch (error) { result = {error: error.message}; }
appendFileSync(${JSON.stringify(results)}, JSON.stringify(result) + '\\n');
${editFile ? `appendFileSync(${JSON.stringify(editFile)}, '\\n// changed\\n');` : ''}
while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20));
console.log('@user Restarting Mu.');
`,
  );
  await writeFile(
    worker,
    `let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (!prompt.includes('Mu service shut down while you were handling message #' + process.env.MU_MESSAGE_ID)) await new Promise(resolve => setTimeout(resolve, 60000));
console.log('@lead resumed ' + process.env.MU_MESSAGE_ID);
`,
  );
  return {
    runs,
    release,
    results,
    custom: {
      restarter: { command: process.execPath, args: [lead] },
      sleeper: { command: process.execPath, args: [worker] },
    },
  };
}

// One hook per test closes its apps and runners first and removes its directories after them, even when a close fails:
// a directory removed under a running app fails, and a failed after-hook skips the hooks registered after it.
// Directories are short temporary paths, because data directories hold Unix sockets.
function cleanup(t) {
  const closes = [],
    directories = [];
  t.after(async () => {
    try {
      for (const close of closes.reverse()) await close();
    } finally {
      for (const directory of directories) await rm(directory, { recursive: true, force: true });
    }
  });
  return {
    close: (close) => closes.push(close),
    dir: async (prefix) => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), `mu-${prefix}-`)));
      directories.push(directory);
      return directory;
    },
    home: async (root = ROOT) => {
      if (root !== ROOT) {
        await cp(join(ROOT, 'skills'), join(root, 'skills'), { recursive: true, force: true });
        await cp(join(ROOT, 'mu.config.example.json'), join(root, 'mu.config.example.json'), { force: false });
      }
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'mu-home-')));
      directories.push(directory);
      await initializeHome({ home: directory, root });
      return directory;
    },
  };
}

async function service(
  clean,
  { dataDir, root = ROOT, custom = {}, launchd = { label: 'test.mu' }, env = process.env, restartWaitMs = undefined },
) {
  const port = await freePort(),
    exits = /** @type {number[]} */ ([]);
  const app = await createApp({
    root,
    home: await clean.home(root),
    port,
    dataDir,
    custom,
    launchd,
    env,
    ...(restartWaitMs ? { restartWaitMs } : {}),
    exit: (code) => exits.push(code),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  clean.close(() => app.close());
  await app.start();
  const call = async (method, path, data, headers = userHeaders(app)) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, exits, call };
}

test('launchdJob takes a process for the job only when launchd started it under that label', () => {
  assert.equal(launchdJob({}, 4242), null);
  assert.deepEqual(
    launchdJob({ MU_LAUNCHD_LABEL: 'local.mu', XPC_SERVICE_NAME: 'local.mu', MU_LAUNCHD_LOG: '/logs/mu.log' }, 1),
    { label: 'local.mu', log: '/logs/mu.log' },
  );
  assert.throws(
    () => launchdJob({ MU_LAUNCHD_LABEL: 'local.mu', XPC_SERVICE_NAME: 'local.mu' }, 4242),
    /did not start this process/,
  );
  assert.throws(
    () => launchdJob({ MU_LAUNCHD_LABEL: 'local.mu', XPC_SERVICE_NAME: 'com.apple.Terminal' }, 1),
    /XPC_SERVICE_NAME=com.apple.Terminal/,
  );
});

test("restart is refused for a worker's credential, a manual worker that names itself, and an instance launchd did not start", async (t) => {
  const clean = cleanup(t);
  const manual = await service(clean, { dataDir: await clean.dir('restart'), launchd: null });
  assert.equal(
    (await manual.call('POST', '/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' }))
      .status,
    201,
  );
  const unsupervised = await manual.call('POST', '/api/service/restart', {});
  assert.equal(unsupervised.status, 409);
  assert.match(unsupervised.body.error, /not started by launchd/);

  const { app, exits, call } = await service(clean, { dataDir: await clean.dir('restart') });
  for (const id of ['lead', 'worker'])
    assert.equal(
      (
        await call('POST', '/api/agents', {
          id,
          role: id === 'lead' ? 'lead' : 'worker',
          adapter: 'manual',
          cwd: ROOT,
          task: '',
        })
      ).status,
      201,
    );
  const asManualWorker = await call('POST', '/api/service/restart', { from: 'worker' });
  assert.equal(asManualWorker.status, 403);
  assert.match(asManualWorker.body.error, /workers never restart/);
  const workerToken = app.identity.issue('worker');
  const asWorker = await call(
    'POST',
    '/api/service/restart',
    {},
    { 'Content-Type': 'application/json', Authorization: `Bearer ${workerToken}` },
  );
  assert.equal(asWorker.status, 403);
  assert.deepEqual(exits, []);
  assert.equal((await call('GET', '/api/service')).body.restart, null);
});

test('the restart command reports an unreachable service and restarts nothing', async () => {
  await assert.rejects(
    main(['restart'], { MU_URL: `http://127.0.0.1:${await freePort()}`, MU_TOKEN: 'x' }),
    /Cannot reach Mu.*Nothing was restarted.*launchctl kickstart -k/s,
  );
});

test('a lead restart waits for the requesting turn, acknowledges it, and the next start reports without running it again', async (t) => {
  const clean = cleanup(t);
  const dataDir = await clean.dir('restart'),
    directory = await clean.dir('adapters');
  const { runs, release, results, custom } = await adapters(directory);
  const first = await service(clean, { dataDir, custom });
  assert.equal(
    (await first.call('POST', '/api/agents', { id: 'lead', role: 'lead', adapter: 'restarter', cwd: ROOT, task: '' }))
      .status,
    201,
  );
  assert.equal(
    (await first.call('POST', '/api/agents', { id: 'worker', role: 'worker', adapter: 'sleeper', cwd: ROOT, task: '' }))
      .status,
    201,
  );
  assert.equal(
    (
      await first.call('POST', '/api/conversations', {
        kind: 'room',
        id: 'ops',
        name: 'Ops',
        members: ['lead', 'worker'],
      })
    ).status,
    201,
  );
  const busy = await first.call('POST', '/api/messages', { conversationId: 'ops', text: '@worker long task' });
  await until(() => first.app.runner.active.get('worker')?.child);
  const request = await first.call('POST', '/api/messages', { conversationId: 'dm-lead', text: 'RESTART-NOW' });

  await until(async () => (await readFile(results, 'utf8').catch(() => '')).trim());
  const [scheduled] = (await readFile(results, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(scheduled, {
    scheduled: true,
    waitingFor: 'the current turn of @lead',
    interrupts: ['worker'],
    conversationId: 'dm-lead',
  });
  // Until the requesting turn ends, the old process keeps running, starts no new turn, and refuses a second restart.
  const pending = await first.call('GET', '/api/service');
  assert.equal(pending.body.pid, process.pid);
  assert.equal(pending.body.restart.requestedBy, 'lead');
  assert.equal(first.app.runner.paused, true);
  const queued = await first.call('POST', '/api/messages', {
    conversationId: 'ops',
    text: '@lead queued while the restart waits',
  });
  assert.equal((await first.call('POST', '/api/service/restart', {})).status, 409);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual((await readFile(runs, 'utf8')).trim().split('\n'), [String(request.body.id)]);
  assert.deepEqual(first.exits, []);

  await writeFile(release, '');
  await until(() => first.exits.length);
  assert.deepEqual(first.exits, [RESTART_EXIT_CODE]);
  await first.app.close();
  const record = JSON.parse(await readFile(join(dataDir, RESTART_FILE), 'utf8'));
  assert.equal(record.requestedBy, 'lead');
  assert.equal(record.conversationId, 'dm-lead');

  const second = await service(clean, { dataDir, custom });
  const store = second.app.store;
  const posted = store.messages(300, 'dm-lead');
  assert.deepEqual(
    posted.map((message) => message.from),
    ['user', 'lead', 'system'],
  );
  assert.equal(posted[1].text, '@user Restarting Mu.');
  assert.match(posted[2].text, /^@lead Mu restarted as requested at .* It runs again as process \d+/);
  assert.equal(await exists(join(dataDir, RESTART_FILE)), false);
  await until(() => !store.inbox('lead').length && !store.inbox('worker').length);
  // The busy worker was interrupted by the shutdown and resumed its message after the start.
  const resumed = store.messages(300, 'ops').find((message) => message.from === 'worker');
  assert.equal(resumed.text, `@lead resumed ${busy.body.id}`);
  // The request ran once; after the start the lead handles the queued message, the restart notice and the worker's report.
  assert.deepEqual((await readFile(runs, 'utf8')).trim().split('\n').map(Number), [
    request.body.id,
    queued.body.id,
    posted[2].id,
    resumed.id,
  ]);
  assert.equal((await readFile(results, 'utf8')).trim().split('\n').length, 1);
  assert.equal(store.agent('worker').interruptedMessageId, null);
  assert.equal(store.agent('lead').status, 'idle');
  assert.deepEqual(second.exits, []);
});

test('a failing start check refuses the restart, and Mu keeps running turns', async (t) => {
  const clean = cleanup(t);
  const root = await clean.dir('broken');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/server.mjs'), "console.error('broken main: cannot start'); process.exit(3);\n");
  const { exits, call, app } = await service(clean, { dataDir: await clean.dir('restart'), root });
  const refused = await call('POST', '/api/service/restart', {});
  assert.equal(refused.status, 409);
  assert.match(
    refused.body.error,
    /^Restart refused: The start check .* failed while starting: it exited 3 before it announced readiness; Mu keeps running the code of its last start\.\nOutput of the checked process:\nbroken main: cannot start$/,
  );
  assert.deepEqual(exits, []);
  assert.equal(app.runner.paused, false);
  assert.equal((await call('GET', '/api/service')).body.restart, null);
});

test('a code change after the start check cancels the restart and resumes turns', async (t) => {
  const clean = cleanup(t);
  // A copy of the checkout, so that the lead's turn can change its code.
  const root = await clean.dir('checkout');
  for (const entry of ['src', 'skills', 'public', 'package.json', 'package-lock.json'])
    await cp(join(ROOT, entry), join(root, entry), { recursive: true });
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'));
  const directory = await clean.dir('adapters');
  const { release, results, custom } = await adapters(directory, { editFile: join(root, 'src/files.mjs') });
  await writeFile(release, '');
  const { exits, call, app } = await service(clean, { dataDir: await clean.dir('restart'), root, custom });
  assert.equal(
    (await call('POST', '/api/agents', { id: 'lead', role: 'lead', adapter: 'restarter', cwd: ROOT, task: '' })).status,
    201,
  );
  await call('POST', '/api/messages', { conversationId: 'dm-lead', text: 'RESTART-NOW' });
  await until(() => app.store.messages(300, 'dm-lead').some((message) => message.from === 'system'));
  const notice = app.store.messages(300, 'dm-lead').find((message) => message.from === 'system');
  assert.match(
    notice.text,
    /^@lead Mu did not restart: its code or configuration changed after the start check passed\./,
  );
  assert.equal(JSON.parse((await readFile(results, 'utf8')).trim()).scheduled, true);
  assert.deepEqual(exits, []);
  assert.equal(app.runner.paused, false);
  assert.equal((await call('GET', '/api/service')).body.restart, null);
  // Turns run again: the lead handles the cancellation notice.
  await until(() => !app.store.inbox('lead').length);
});

test('the restart command says that nothing restarted only when no service took the request', async (t) => {
  const clean = cleanup(t);
  const silent = createHttpServer(() => {});
  const port = await listenLocal(silent);
  clean.close(() => {
    silent.closeAllConnections();
    silent.close();
  });
  const error = await main(
    ['restart'],
    { MU_URL: `http://127.0.0.1:${port}`, MU_TOKEN: 'x' },
    { restartTimeoutMs: 200 },
  ).catch((caught) => caught);
  assert.match(
    error.message,
    /^Mu did not answer the restart request within 0.2 seconds, so its outcome is unknown: Mu may still restart\./,
  );
  assert.doesNotMatch(error.message, /Nothing was restarted/);
});

test('a requesting turn that outlives the wait limit cancels the restart and resumes turns', async (t) => {
  const clean = cleanup(t);
  const directory = await clean.dir('adapters');
  const { custom } = await adapters(directory);
  const { app, exits, call } = await service(clean, {
    dataDir: await clean.dir('restart'),
    custom,
    restartWaitMs: 300,
  });
  assert.equal(
    (await call('POST', '/api/agents', { id: 'lead', role: 'lead', adapter: 'restarter', cwd: ROOT, task: '' })).status,
    201,
  );
  await call('POST', '/api/messages', { conversationId: 'dm-lead', text: 'RESTART-NOW' });
  await until(() => app.store.messages(300, 'dm-lead').some((message) => message.from === 'system'));
  assert.match(
    app.store.messages(300, 'dm-lead').find((message) => message.from === 'system').text,
    /^@lead Mu did not restart: the requesting turn did not end within 0.3 seconds\./,
  );
  assert.deepEqual(exits, []);
  assert.equal(app.runner.paused, false);
  assert.equal((await call('GET', '/api/service')).body.restart, null);
  // The requesting turn ends once released, and the lead then handles the cancellation notice in a turn of its own.
  await writeFile(join(directory, 'release'), '');
  await until(
    () =>
      !app.runner.active.has('lead') && !app.store.inbox('lead').length && app.store.agent('lead').status === 'idle',
  );
  assert.deepEqual(exits, []);
});

test('the start check runs on its own port, data directory and broker-less IRC port, without job or turn variables', async (t) => {
  const clean = cleanup(t);
  // A stand-in for the checkout's server: it records its environment and passes the check.
  const root = await clean.dir('recorder'),
    record = join(root, 'env.json');
  await mkdir(join(root, 'src'));
  await writeFile(
    join(root, 'src/server.mjs'),
    `import http from 'node:http';
import {existsSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
writeFileSync(${JSON.stringify(record)}, JSON.stringify({env: process.env, snapshot: existsSync(join(process.env.MU_DATA_DIR, 'mu.sqlite'))}));
writeFileSync(join(process.env.MU_DATA_DIR, 'user-token'), 'checked\\n');
const server = http.createServer((request, response) => response.end(JSON.stringify({pid: process.pid})));
server.listen(Number(process.env.MU_PORT), '127.0.0.1', () => console.log('Mu dashboard: checked'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`,
  );
  const dataDir = await clean.dir('live'),
    store = new Store(join(dataDir, 'mu.sqlite'));
  clean.close(() => store.close());
  const live = {
    MU_PORT: '4310',
    MU_DATA_DIR: dataDir,
    MU_IRC_HOST: '10.0.0.1',
    MU_IRC_PORT: '6667',
    MU_CONFIG: '/etc/mu.json',
    HOME: '/Users/me',
    PATH: process.env.PATH,
    MU_LAUNCHD_LABEL: 'local.mu',
    MU_LAUNCHD_LOG: '/logs/mu.log',
    MU_REQUIRE_IRC: '1',
    XPC_SERVICE_NAME: 'local.mu',
    MU_TOKEN: 'secret',
    MU_TOKEN_FILE: '/credentials/lead',
    MU_URL: 'http://127.0.0.1:4310',
    MU_AGENT_ID: 'lead',
    MU_LEAD_ID: 'lead',
    MU_ROLE: 'lead',
    MU_CLI: '/mu/src/cli.mjs',
    MU_CONVERSATION_ID: 'dm-lead',
    MU_MESSAGE_ID: '7',
    MU_SESSION_ID: 's',
    MU_PROMPT: 'p',
  };
  await startCheck({ root, home: '/Users/me/.mu', store, dataDir, env: live });
  const { env, snapshot } = JSON.parse(await readFile(record, 'utf8'));
  assert.notEqual(env.MU_PORT, '4310');
  assert.notEqual(env.MU_DATA_DIR, dataDir);
  assert.equal(env.MU_HOME, '/Users/me/.mu');
  assert.ok(snapshot, 'the check started on a snapshot of the database');
  assert.equal(await exists(env.MU_DATA_DIR), false, 'the temporary data directory is removed');
  assert.equal(env.MU_IRC_HOST, '127.0.0.1');
  assert.notEqual(env.MU_IRC_PORT, '6667');
  const refused = await new Promise((resolve) =>
    connect({ host: '127.0.0.1', port: Number(env.MU_IRC_PORT) })
      .once('connect', () => resolve(false))
      .once('error', (/** @type {NodeJS.ErrnoException} */ error) => resolve(error.code === 'ECONNREFUSED')),
  );
  assert.ok(refused, 'no broker listens on the IRC port of the check');
  for (const name of [
    'MU_LAUNCHD_LABEL',
    'MU_LAUNCHD_LOG',
    'MU_REQUIRE_IRC',
    'XPC_SERVICE_NAME',
    'MU_TOKEN',
    'MU_TOKEN_FILE',
    'MU_URL',
    'MU_AGENT_ID',
    'MU_LEAD_ID',
    'MU_ROLE',
    'MU_CLI',
    'MU_CONVERSATION_ID',
    'MU_MESSAGE_ID',
    'MU_SESSION_ID',
    'MU_PROMPT',
  ])
    assert.equal(env[name], undefined, name);
  assert.equal(env.MU_CONFIG, '/etc/mu.json');
  assert.equal(env.HOME, '/Users/me');
});

test('agent turns do not inherit the launchd job variables of the service', async (t) => {
  const clean = cleanup(t);
  const directory = await clean.dir('turn-env'),
    record = join(directory, 'env.json'),
    script = join(directory, 'agent.mjs');
  await writeFile(
    script,
    `import {writeFileSync} from 'node:fs';\nfor await (const chunk of process.stdin) {}\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify(process.env));\nconsole.log('NO_REPLY');\n`,
  );
  const job = {
    MU_LAUNCHD_LABEL: 'local.mu',
    MU_LAUNCHD_LOG: '/logs/mu.log',
    MU_REQUIRE_IRC: '1',
    XPC_SERVICE_NAME: 'local.mu',
  };
  const saved = Object.fromEntries(Object.keys(job).map((name) => [name, process.env[name]]));
  Object.assign(process.env, job);
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const store = new Store();
  store.createAgent({ id: 'worker', role: 'worker', adapter: 'recorder', cwd: ROOT, task: '' });
  store.addMessage('incoming', 'user', '@worker run');
  const runner = new Runner({
    home: ROOT,
    identity: testIdentity(t),
    store,
    chat: { state: { connected: true }, async send() {} },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom: { recorder: { command: process.execPath, args: [script] } },
  });
  clean.close(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  runner.kick();
  await until(() => !store.inbox('worker').length);
  const env = JSON.parse(await readFile(record, 'utf8'));
  for (const name of Object.keys(job)) assert.equal(env[name], undefined, name);
  assert.equal(env.MU_AGENT_ID, 'worker');
});

test('a broker lost after the start is reconnected in the process; only a broker missing at the start ends it', async (t) => {
  const clean = cleanup(t);
  class DownChat extends FakeChat {
    async start() {
      throw new Error('connect ECONNREFUSED');
    }
  }
  const down = await createApp({
    home: await clean.home(),
    port: await freePort(),
    dataDir: await clean.dir('irc'),
    requireIrc: true,
    launchd: { label: 'test.mu' },
    exit: () => {},
    chatFactory: (options) => new DownChat(options),
    pricing: offlinePricing(),
  });
  clean.close(() => down.close());
  await assert.rejects(
    down.start(),
    /IRC unavailable at 127.0.0.1:6667: connect ECONNREFUSED\. Mu exits so that launchd starts it again/,
  );

  let starts = 0;
  class FlakyChat extends FakeChat {
    async start() {
      starts += 1;
      if (starts === 2) {
        this.change({ connected: false, error: 'connect ECONNREFUSED' });
        throw new Error('connect ECONNREFUSED');
      }
      this.change({ connected: true, error: null });
    }
    change(patch) {
      Object.assign(this.state, patch);
      this.emit('change');
    }
  }
  const exits = /** @type {number[]} */ ([]);
  const app = await createApp({
    home: await clean.home(),
    port: await freePort(),
    dataDir: await clean.dir('irc'),
    requireIrc: true,
    launchd: { label: 'test.mu' },
    reconnectDelayMs: 20,
    exit: (code) => exits.push(code),
    chatFactory: (options) => new FlakyChat(options),
    pricing: offlinePricing(),
  });
  clean.close(() => app.close());
  await app.start();
  app.chat.change({
    connected: false,
    error: 'IRC connection for mu-observer closed; Mu reconnects when the broker answers',
  });
  await until(() => app.chat.state.connected);
  assert.equal(starts, 3, 'one failed attempt, then a successful one');
  assert.deepEqual(exits, []);
});

test('the code digest covers the source, the manifests and the configuration file', async (t) => {
  const clean = cleanup(t);
  const root = await clean.dir('digest');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/server.mjs'), '1');
  const configFile = join(root, 'custom.json');
  const before = await codeDigest(root, { configFile });
  await writeFile(configFile, '{}');
  const configured = await codeDigest(root, { configFile });
  assert.notEqual(configured, before);
  await writeFile(join(root, 'package.json'), '{}');
  assert.notEqual(await codeDigest(root, { configFile }), configured);
});

test('the code state is decided by the digest, and the git HEAD only places the difference', () => {
  const at = (digest, head, extra = {}) => ({ digest, head, ...extra });
  assert.equal(
    codeState(at('a', '1'.repeat(40)), at('a', '2'.repeat(40))).state,
    'current',
    'a commit that changes no loaded file leaves Mu current',
  );
  const moved = codeState(at('a', '1'.repeat(40)), at('b', '2'.repeat(40)));
  assert.equal(moved.state, 'stale');
  assert.match(moved.message, /loaded 111111111; the checkout is at 222222222/);
  const edited = codeState(at('a', '1'.repeat(40)), at('b', '1'.repeat(40)));
  assert.match(edited.message, /still at 111111111, so uncommitted changes or the configuration file differ/);
  const noGit = codeState(
    at('a', null, { headError: 'Cannot read the git HEAD of /r: not a git repository' }),
    at('b', null, { headError: 'Cannot read the git HEAD of /r: not a git repository' }),
  );
  assert.equal(noGit.state, 'stale');
  assert.match(
    noGit.message,
    /git HEAD is not known.*at start: Cannot read the git HEAD.*now: Cannot read the git HEAD/s,
  );
  const unreadable = codeState(at('a', '1'), at(null, '1', { digestError: 'Cannot read the code of /r: EACCES' }));
  assert.equal(unreadable.state, 'unknown');
  assert.match(unreadable.message, /cannot be told.*now: Cannot read the code of \/r: EACCES/);
});

test('the service reports whether the checkout still holds the code that it loaded', async (t) => {
  const clean = cleanup(t);
  const root = await clean.dir('stale');
  const git = (...args) =>
    execFileSync(
      'git',
      ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      { encoding: 'utf8' },
    ).trim();
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/server.mjs'), 'one');
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  const first = git('rev-parse', 'HEAD');
  const { call } = await service(clean, {
    dataDir: await clean.dir('stale-data'),
    root,
    env: { ...process.env, MU_CONFIG: join(root, 'absent.json') },
  });
  const code = async () => (await call('GET', '/api/service')).body.code;

  const current = await code();
  assert.equal(current.state, 'current');
  assert.equal(current.loaded.head, first);
  await writeFile(join(root, 'src/server.mjs'), 'two');
  const edited = await code();
  assert.equal(edited.state, 'stale');
  assert.match(edited.message, new RegExp(`still at ${first.slice(0, 9)}, so uncommitted changes`));
  git('commit', '-q', '-am', 'two');
  const committed = await code();
  assert.equal(committed.state, 'stale');
  assert.match(
    committed.message,
    new RegExp(`loaded ${first.slice(0, 9)}; the checkout is at ${git('rev-parse', 'HEAD').slice(0, 9)}`),
  );
  await writeFile(join(root, 'src/server.mjs'), 'one');
  assert.equal((await code()).state, 'current', 'the same content is the same code, whatever the history');
  await rm(join(root, 'src'), { recursive: true });
  const missing = await code();
  assert.equal(missing.state, 'unknown');
  assert.match(missing.message, /now: Cannot read the code of .*ENOENT/);
});

test('a checkout without git state is reported, and the digest still decides', async (t) => {
  const clean = cleanup(t);
  const root = await clean.dir('no-git');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/server.mjs'), 'one');
  const { call } = await service(clean, {
    dataDir: await clean.dir('no-git-data'),
    root,
    env: { ...process.env, MU_CONFIG: join(root, 'absent.json') },
  });
  const before = (await call('GET', '/api/service')).body.code;
  assert.equal(before.state, 'current');
  assert.equal(before.loaded.head, null);
  assert.match(before.message, /Cannot read the git HEAD of .*not a git repository/);
  await writeFile(join(root, 'src/server.mjs'), 'two');
  const after = (await call('GET', '/api/service')).body.code;
  assert.equal(after.state, 'stale');
  assert.match(after.message, /git HEAD is not known/);
});

test('a shutdown for another reason while the restart waits writes no restart record', async (t) => {
  const clean = cleanup(t);
  const directory = await clean.dir('adapters'),
    dataDir = await clean.dir('restart');
  const { results, custom } = await adapters(directory);
  const { app, exits, call } = await service(clean, { dataDir, custom });
  assert.equal(
    (await call('POST', '/api/agents', { id: 'lead', role: 'lead', adapter: 'restarter', cwd: ROOT, task: '' })).status,
    201,
  );
  await call('POST', '/api/messages', { conversationId: 'dm-lead', text: 'RESTART-NOW' });
  await until(async () => (await readFile(results, 'utf8').catch(() => '')).trim());
  // A signal arrives while Mu waits for the requesting turn; the shutdown ends that turn.
  await app.shutdown(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(exits, [0]);
  assert.equal(await exists(join(dataDir, RESTART_FILE)), false);
});

test('signalling a turn whose process has exited but is not yet reaped does not throw', async (t) => {
  const runner = new Runner({
    home: ROOT,
    identity: testIdentity(t),
    store: new Store(),
    chat: { state: { connected: false } },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
  });
  const child = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  // Probing synchronously keeps the event loop from reaping the child, so its group stays in the state that refuses signals.
  let refusal = null;
  for (const end = Date.now() + 10000; Date.now() < end && !refusal;) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      refusal = error.code;
    }
  }
  assert.equal(refusal, 'EPERM', 'macOS refuses a signal to the group of an exited, unreaped leader');
  assert.equal(child.exitCode, null);
  assert.doesNotThrow(() => runner.signal({ child }, 'SIGTERM'));
  await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
});

test('closing the runner terminates every turn and marks each for resumption even when one signal fails', (t) => {
  const runner = new Runner({
    home: ROOT,
    identity: testIdentity(t),
    store: new Store(),
    chat: { state: { connected: false } },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
  });
  const signalled = [];
  runner.signal = (entry, signal) => {
    signalled.push([entry.id, signal]);
    if (entry.id === 'first') throw new Error('refused');
  };
  runner.active.set('first', { id: 'first' });
  runner.active.set('second', { id: 'second' });
  assert.throws(() => runner.close(), /Could not terminate the turn of @first: refused/);
  assert.deepEqual(signalled, [
    ['first', 'SIGTERM'],
    ['second', 'SIGTERM'],
  ]);
  for (const entry of runner.active.values()) {
    assert.equal(entry.shutdown, true);
    clearTimeout(entry.killTimer);
  }
});
