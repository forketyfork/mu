// The move of the data directory and the configuration from the checkout into the home, rehearsed on a copy of the
// checkout: what a start and a restart do before the move, and that the moved state serves the same service after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { cp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initializeHome } from '../src/home.mjs';
import { createApp, ROOT } from '../src/server.mjs';
import { LAUNCHD_VARIABLES, TURN_VARIABLES, withoutVariables } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, temporaryHome } from './isolation.mjs';
import { offlinePricing } from './offline-pricing.mjs';

class FakeChat extends EventEmitter {
  constructor() {
    super();
    this.state = { connected: true };
  }
  async start() {}
  async syncConversation() {}
  close() {}
}

// The variables that choose Mu's places; the tests decide them, not the shell that runs the tests.
const cleanEnv = () =>
  withoutVariables(process.env, [
    ...LAUNCHD_VARIABLES,
    ...TURN_VARIABLES,
    'MU_HOME',
    'MU_DATA_DIR',
    'MU_CONFIG',
    'MU_PORT',
    'MU_IRC_PORT',
  ]);

// A copy of the checkout as it is before the move: its data directory holds a database with one agent and the user
// credential, and it holds the configuration. The home is initialized and holds neither.
async function beforeMove(t) {
  const root = await shortTempDir(t, 'checkout');
  for (const entry of ['src', 'skills', 'public', 'package.json', 'package-lock.json', 'mu.config.example.json'])
    await cp(join(ROOT, entry), join(root, entry), { recursive: true });
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'));
  await mkdir(join(root, '.mu'), { mode: 0o755 });
  const store = new Store(join(root, '.mu/mu.sqlite'));
  store.createAgent({ id: 'moved-worker', role: 'worker', adapter: 'manual', cwd: root, task: 'kept across the move' });
  store.close();
  const token = 'b'.repeat(64);
  await writeFile(join(root, '.mu/user-token'), `${token}\n`, { mode: 0o600 });
  await writeFile(join(root, 'mu.config.json'), JSON.stringify({ cliArgs: { claude: ['--from-config'] } }));
  const home = await temporaryHome(t);
  await initializeHome({ home, root, env: {} });
  return { root, home, token };
}

// The checkout's entry point, started the way launchd starts it: no MU_DATA_DIR and no MU_CONFIG.
async function start(t, root, env) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, 'src/server.mjs')], {
    cwd: root,
    env: { ...cleanEnv(), MU_PORT: String(port), MU_IRC_PORT: String(await freePort()), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const ready = new Promise((resolve) =>
    child.stdout.on('data', (data) => {
      output += data;
      if (output.includes('Mu dashboard:')) resolve('ready');
    }),
  );
  child.stderr.on('data', (data) => {
    output += data;
  });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
  const started = await Promise.race([ready, exited]);
  return { child, port, started, exited, output: () => output };
}

test('before the move, a start refuses with one dated line naming the steps, and creates nothing in the home', async (t) => {
  const { root, home } = await beforeMove(t);
  const homeEntries = (await readdir(home)).sort();
  const service = await start(t, root, { MU_HOME: home });
  assert.deepEqual(service.started, { code: 1, signal: null });
  assert.match(
    service.output(),
    new RegExp(
      `^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z Mu keeps its data directory in ${join(home, 'data')} and its configuration in ${join(home, 'config.json')}, but the checkout still holds the database ${join(root, '.mu/mu.sqlite')} and the configuration ${join(root, 'mu.config.json')}\\. Move them with Mu stopped: npm run service:uninstall, then mv .* then npm run service:install\\.\\n$`,
    ),
  );
  assert.deepEqual((await readdir(home)).sort(), homeEntries, 'no data directory was created');
});

test('after the move, the same start serves the moved database, credential and configuration', async (t) => {
  const { root, home, token } = await beforeMove(t);
  await rename(join(root, '.mu'), join(home, 'data'));
  await rename(join(root, 'mu.config.json'), join(home, 'config.json'));
  const service = await start(t, root, { MU_HOME: home });
  assert.equal(service.started, 'ready', service.output());
  const get = async (path) =>
    (await fetch(`http://127.0.0.1:${service.port}${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
  // The dashboard's credential moved with the directory, so it stays signed in.
  const state = await get('/api/state');
  assert.equal(state.agents.find((agent) => agent.id === 'moved-worker')?.task, 'kept across the move');
  const answer = await get('/api/service');
  assert.equal(answer.pid, service.child.pid);
  assert.equal(answer.code.state, 'current', 'the moved configuration is the file the service watches');
  service.child.kill('SIGTERM');
  assert.deepEqual(await service.exited, { code: 0, signal: null });
});

test('rolling back: the moved-back files start again when MU_DATA_DIR and MU_CONFIG name the checkout', async (t) => {
  const { root, home, token } = await beforeMove(t);
  await rename(join(root, '.mu'), join(home, 'data'));
  await rename(join(root, 'mu.config.json'), join(home, 'config.json'));
  await rename(join(home, 'data'), join(root, '.mu'));
  await rename(join(home, 'config.json'), join(root, 'mu.config.json'));
  const service = await start(t, root, {
    MU_HOME: home,
    MU_DATA_DIR: join(root, '.mu'),
    MU_CONFIG: join(root, 'mu.config.json'),
  });
  assert.equal(service.started, 'ready', service.output());
  const response = await fetch(`http://127.0.0.1:${service.port}/api/service`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  // Stopped here, not in a hook: the checkout's removal is an earlier hook and would race the running service.
  service.child.kill('SIGTERM');
  assert.deepEqual(await service.exited, { code: 0, signal: null });
});

// The running service checks the merged code before it restarts. Before the move that check must refuse, so that the
// service keeps running instead of exiting into a start that launchd would repeat without success.
test('before the move, a restart of the running service is refused by its start check, and it keeps running', async (t) => {
  const { root, home } = await beforeMove(t);
  const liveData = await shortTempDir(t, 'live');
  const port = await freePort();
  const exits = [];
  const app = await createApp({
    root,
    home,
    port,
    dataDir: liveData,
    configFile: join(root, 'mu.config.json'),
    launchd: { label: 'test.mu.move' },
    env: cleanEnv(),
    exit: (code) => exits.push(code),
    chatFactory: () => new FakeChat(),
    pricing: offlinePricing(),
  });
  t.after(() => app.close());
  await app.start();
  const restart = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/service/restart`, {
      method: 'POST',
      headers: userHeaders(app),
      body: '{}',
    });
    return { status: response.status, body: await response.json() };
  };
  const refused = await restart();
  assert.equal(refused.status, 409);
  assert.match(
    refused.body.error,
    /^Restart refused: The start check .* failed while starting: it exited 1 before it announced readiness; Mu keeps running the code of its last start\.\nOutput of the checked process:\n.*but the checkout still holds the configuration .*mu\.config\.json\. Move them with Mu stopped/s,
  );
  assert.deepEqual(exits, []);
  assert.equal(app.runner.paused, false);
  // The check copies the live database, so only the configuration tells it that the move is due.
  assert.doesNotMatch(refused.body.error, /still holds the database/);
  assert.equal(
    await readFile(join(root, 'mu.config.json'), 'utf8'),
    JSON.stringify({ cliArgs: { claude: ['--from-config'] } }),
  );
});
