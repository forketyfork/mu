import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createApp, loadConfig, pricingEnabledFromConfig, ROOT } from '../src/server.mjs';
import { listenLocal, shortTempDir, temporaryMuHome } from './isolation.mjs';

async function unusedPort() {
  const server = createServer();
  const port = await listenLocal(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('loadConfig accepts and validates the pricing fetch setting', async (t) => {
  const temporary = join(ROOT, '.tmp');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(join(temporary, 'config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'config.json');

  await writeFile(filename, JSON.stringify({ pricing: { enabled: false } }));
  assert.deepEqual(await loadConfig(filename), { pricing: { enabled: false } });
  await writeFile(filename, JSON.stringify({ pricing: { enabled: 'false' } }));
  await assert.rejects(loadConfig(filename), /Invalid pricing\.enabled: expected a boolean/);
  await writeFile(filename, JSON.stringify({ pricing: { endpoint: 'https://example.test' } }));
  await assert.rejects(loadConfig(filename), /Invalid pricing: unknown keys endpoint/);
});

test('createApp passes a disabled pricing setting to the catalog without fetching', async (t) => {
  const configDirectory = await shortTempDir(t, 'pricing-config');
  const configFile = join(configDirectory, 'config.json');
  await writeFile(configFile, JSON.stringify({ pricing: { enabled: false } }));
  const config = await loadConfig(configFile);
  const home = await temporaryMuHome(t);
  let requests = 0;
  const app = await createApp({
    home,
    dataDir: await shortTempDir(t, 'pricing-data'),
    pricingEnabled: pricingEnabledFromConfig(config),
    pricingFetch: async () => {
      requests += 1;
      throw new Error('disabled pricing must not fetch');
    },
  });
  t.after(() => app.close());

  assert.equal(app.pricing.enabled, false);
  await app.pricing.start();
  assert.equal(requests, 0);
});

// Closing the terminal sends SIGHUP; without a handler Node exits before stopping its detached agent process groups.
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
  test(`${signal} shuts the service down cleanly`, async (t) => {
    const dataDir = await shortTempDir(t, 'server');
    const home = await temporaryMuHome(t);
    // An explicit configuration, so that one left in the checkout does not refuse the start.
    const config = join(dataDir, 'config.json');
    await writeFile(config, '{}');
    const env = {
      ...process.env,
      MU_HOME: home,
      MU_DATA_DIR: dataDir,
      MU_CONFIG: config,
      MU_PORT: String(await unusedPort()),
      MU_IRC_PORT: String(await unusedPort()),
    };
    const child = spawn(process.execPath, [join(ROOT, 'src/server.mjs')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        stdout += data;
        if (stdout.includes('Mu dashboard:')) resolve();
      });
      child.once('exit', (code, exitSignal) =>
        reject(new Error(`Server exited before startup: ${code ?? exitSignal}`)),
      );
    });
    child.kill(signal);
    const [code, exitSignal] = await once(child, 'exit');
    assert.deepEqual({ code, exitSignal }, { code: 0, exitSignal: null });
  });
}
