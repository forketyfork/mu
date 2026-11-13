import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOLDER_FILE, LOCK_FILE, lockDataDir } from '../src/lock.mjs';
import { createApp, ROOT } from '../src/server.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';
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

async function app(t, home, dataDir) {
  const port = await freePort();
  const created = await createApp({
    home,
    port,
    dataDir,
    chatFactory: () => new FakeChat(),
    pricing: offlinePricing(),
  });
  t.after(() => created.close());
  return { app: created, port };
}

// The entry point as launchd would start it, on the given data directory; resolves with its exit and output.
async function entryPoint(t, home, dataDir) {
  const config = join(await shortTempDir(t, 'config'), 'config.json');
  await writeFile(config, '{}');
  const child = spawn(process.execPath, [join(ROOT, 'src/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MU_HOME: home,
      MU_DATA_DIR: dataDir,
      // An explicit file, so that a configuration in the checkout does not decide the start.
      MU_CONFIG: config,
      MU_PORT: String(await freePort()),
      MU_IRC_PORT: String(await freePort()),
    },
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
  return { child, ready, exited, output: () => output };
}

test('a second app on one data directory is refused with its holder named, until the first one closes', async (t) => {
  const home = await temporaryMuHome(t);
  const dataDir = await shortTempDir(t, 'lock');
  const first = await app(t, home, dataDir);
  const holder = JSON.parse(await readFile(join(dataDir, HOLDER_FILE), 'utf8'));
  assert.deepEqual(
    { ...holder, startedAt: typeof holder.startedAt },
    {
      pid: process.pid,
      root: ROOT,
      port: first.port,
      startedAt: 'string',
    },
  );
  await assert.rejects(
    createApp({ home, port: await freePort(), dataDir, chatFactory: () => new FakeChat(), pricing: offlinePricing() }),
    {
      expected: true,
      message: `Another Mu service uses the data directory ${dataDir}: process ${process.pid} from ${ROOT}, port ${first.port}, started at ${holder.startedAt}. Stop it first, or give this service its own MU_DATA_DIR.`,
    },
  );
  await first.app.close();
  const second = await app(t, home, dataDir);
  assert.ok(second.app.identity.token, 'the lock passes to the next app once the first one has closed');
});

// The lock decides before anything else is opened: a refused service must not run migrations on the holder's database
// or write a credential next to it.
test('a refused app opens neither the database nor the credential of the data directory it found locked', async (t) => {
  const home = await temporaryMuHome(t);
  const dataDir = await shortTempDir(t, 'lock');
  const lock = lockDataDir(dataDir, { pid: process.pid, root: ROOT, port: 1, startedAt: new Date().toISOString() });
  t.after(() => lock.release());
  await assert.rejects(
    createApp({ home, port: await freePort(), dataDir, chatFactory: () => new FakeChat(), pricing: offlinePricing() }),
    { expected: true, message: /^Another Mu service uses the data directory/ },
  );
  // Only the lock's own files: the lock file, SQLite's journal for it, and the holder record.
  assert.deepEqual(
    (await readdir(dataDir)).filter((entry) => !entry.startsWith(LOCK_FILE)),
    [],
    'no database, credential or socket was created',
  );
});

test('a second service process on one data directory exits with one dated line that names the holder', async (t) => {
  const home = await temporaryMuHome(t);
  const dataDir = await shortTempDir(t, 'lock');
  const { port } = await app(t, home, dataDir);
  const second = await entryPoint(t, home, dataDir);
  const ended = await Promise.race([second.ready, second.exited]);
  assert.notEqual(ended, 'ready', 'the second service must not start');
  assert.deepEqual(ended, { code: 1, signal: null });
  assert.match(
    second.output(),
    new RegExp(
      `^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z Another Mu service uses the data directory ${dataDir}: process ${process.pid} from ${ROOT}, port ${port}, started at \\S+\\. Stop it first, or give this service its own MU_DATA_DIR\\.\\n$`,
    ),
  );
});

test('a service that was killed leaves no lock behind', async (t) => {
  const home = await temporaryMuHome(t);
  const dataDir = await shortTempDir(t, 'lock');
  const killed = await entryPoint(t, home, dataDir);
  assert.equal(await Promise.race([killed.ready, killed.exited]), 'ready', killed.output());
  killed.child.kill('SIGKILL');
  await killed.exited;
  const holder = JSON.parse(await readFile(join(dataDir, HOLDER_FILE), 'utf8'));
  assert.equal(holder.pid, killed.child.pid, 'the record still names the killed process');
  const next = await app(t, home, dataDir);
  assert.ok(next.app.identity.token);
});

test('an app that fails to open its data directory releases the lock', async (t) => {
  const home = await temporaryMuHome(t);
  const dataDir = await shortTempDir(t, 'lock');
  await writeFile(join(dataDir, 'user-token'), 'not a credential\n', { mode: 0o600 });
  await assert.rejects(
    createApp({ home, port: await freePort(), dataDir, chatFactory: () => new FakeChat(), pricing: offlinePricing() }),
    /user credential .* is malformed/,
  );
  await writeFile(join(dataDir, 'user-token'), `${'a'.repeat(64)}\n`);
  const next = await app(t, home, dataDir);
  assert.equal(next.app.identity.token, 'a'.repeat(64));
});
