import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp, ROOT } from '../src/server.mjs';
import { main } from '../src/cli.mjs';
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
  async send() {}
  close() {}
}

async function appFor(t, home, { launchd = null } = {}) {
  const port = await freePort();
  const app = await createApp({
    root: ROOT,
    home,
    port,
    dataDir: await shortTempDir(t, 'home-service-data'),
    launchd,
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
    exit: () => {},
  });
  await app.start();
  t.after(() => app.close());
  return { app, url: `http://127.0.0.1:${port}` };
}

test('service reports an outdated home default and init is available to the user and lead only', async (t) => {
  const home = await temporaryMuHome(t);
  const path = 'skills/team-lead/SKILL.md';
  const shipped = await readFile(join(ROOT, path), 'utf8');
  const stale = `${shipped}\nAn older local copy.\n`;
  await writeFile(join(home, path), stale);
  await writeFile(join(home, '.install/base', path), stale);
  const manifestPath = join(home, '.install/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files[path] = createHash('sha256').update(stale).digest('hex');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  const { app, url } = await appFor(t, home);
  app.store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  app.store.createAgent({ id: 'worker', role: 'worker', adapter: 'manual', cwd: ROOT, task: '' });
  const service = await main(['service'], { MU_URL: url, MU_TOKEN: app.identity.token });
  assert.equal(service.home.defaults.find((item) => item.path === path).state, 'outdated');

  const leadToken = app.identity.issue('lead');
  const initializedByLead = await main(['init', '--dry-run'], {
    MU_URL: url,
    MU_TOKEN: leadToken,
    MU_AGENT_ID: 'lead',
  });
  assert.ok(initializedByLead.actions.some((item) => item.path === path && item.action === 'replace'));

  await assert.rejects(
    main(['init', '--adopt'], { MU_URL: url, MU_TOKEN: leadToken, MU_AGENT_ID: 'lead' }),
    /Only the user may use --accept or --adopt/,
  );
  await assert.rejects(
    main(['init', '--accept', path], { MU_URL: url, MU_TOKEN: leadToken, MU_AGENT_ID: 'lead' }),
    /Only the user may use --accept or --adopt/,
  );

  await assert.rejects(
    main(['init', '--dry-run'], {
      MU_URL: url,
      MU_TOKEN: app.identity.issue('worker'),
      MU_AGENT_ID: 'worker',
    }),
    /workers are refused/,
  );

  const initializedByUser = await main(['init', '--dry-run'], { MU_URL: url, MU_TOKEN: app.identity.token });
  assert.ok(initializedByUser.actions.some((item) => item.path === path && item.action === 'replace'));
  const adoptedByUser = await main(['init', '--dry-run', '--adopt'], { MU_URL: url, MU_TOKEN: app.identity.token });
  assert.equal(adoptedByUser.dryRun, true);
  const acceptedByUser = await main(['init', '--dry-run', '--accept', path], {
    MU_URL: url,
    MU_TOKEN: app.identity.token,
  });
  assert.ok(acceptedByUser.actions.some((item) => item.path === path && item.action === 'accept-current-edit'));

  await writeFile(manifestPath, '{invalid json');
  const serviceWithBrokenHome = await main(['service'], { MU_URL: url, MU_TOKEN: app.identity.token });
  assert.equal(serviceWithBrokenHome.pid, process.pid);
  assert.match(serviceWithBrokenHome.home.error, /manifest .* is not valid JSON/);
});

test('startup and the restart check refuse a home with a missing role file', async (t) => {
  await assert.rejects(createApp({}), /createApp needs the initialized Mu home/);
  const home = await temporaryMuHome(t);
  const roleFile = join(home, 'skills/worker/SKILL.md');
  const roleText = await readFile(roleFile, 'utf8');
  await rm(roleFile);
  const dataDir = join(await shortTempDir(t, 'home-invalid-start'), 'data');

  await assert.rejects(
    createApp({ home, dataDir, pricing: offlinePricing() }),
    /Missing required role files: skills\/worker\/SKILL\.md.*run node src\/cli\.mjs init/i,
  );
  await assert.rejects(lstat(dataDir), { code: 'ENOENT' });

  await writeFile(roleFile, roleText, { mode: 0o600 });
  const { app, url } = await appFor(t, home, { launchd: { label: 'test.mu' } });
  await rm(roleFile);
  const response = await fetch(`${url}/api/service/restart`, {
    method: 'POST',
    headers: userHeaders(app),
    body: '{}',
  });
  const result = await response.json();
  assert.equal(response.status, 409);
  assert.match(result.error, /Restart refused/);
  assert.match(result.error, /Missing required role files: skills\/worker\/SKILL\.md/);
});
