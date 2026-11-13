import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { temporaryMuHome } from './isolation.mjs';
import { Runner } from '../src/runner.mjs';
import { readTurn } from '../src/adapters.mjs';
import { CodexRollouts } from '../src/codex-rollout.mjs';
import { Store } from '../src/store.mjs';
import { ROOT, loadConfig } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { testIdentity } from './identity-fixture.mjs';

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runTurns(t, { cliArgs, roleCliArgs }) {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT, task: 'Coordinate' });
  store.createAgent({ id: 'worker', role: 'worker', adapter: 'claude', cwd: ROOT, task: 'Work' });
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: { state: { connected: true }, async send() {} },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    codexRollouts: new CodexRollouts(join(ROOT, '.tmp/no-codex-home')),
    pricing: offlinePricing(),
    cliArgs,
    roleCliArgs,
  });
  const runs = {};
  runner.execute = async (command, agent, message, prompt) => {
    runs[agent.id] = { args: command.args, prompt };
    return readTurn(command.format, '');
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  for (const id of ['lead', 'worker']) {
    store.addMessage(`to-${id}`, 'user', 'Go', `dm-${id}`);
    runner.kick();
    await until(() => runs[id]);
  }
  return runs;
}

test('role arguments apply to that role only and follow the adapter-wide arguments', async (t) => {
  const runs = await runTurns(t, {
    cliArgs: { claude: ['--permission-mode', 'auto'] },
    roleCliArgs: { lead: { claude: ['--settings', '{"autoCompactWindow":250000}'], codex: ['-c', 'x=1'] } },
  });
  const lead = runs.lead.args,
    worker = runs.worker.args;
  assert.deepEqual(JSON.parse(lead[lead.indexOf('--settings') + 1]), {
    autoCompactWindow: 250000,
    autoMemoryEnabled: false,
  });
  assert.ok(lead.indexOf('--permission-mode') < lead.indexOf('--settings'));
  assert.ok(!worker.includes('--settings'));
  assert.equal(worker[worker.indexOf('--permission-mode') + 1], 'auto');
});

test('turn prompts point to task list instead of carrying task records', async (t) => {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT, task: 'Coordinate' });
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: { state: { connected: true }, async send() {} },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    codexRollouts: new CodexRollouts(join(ROOT, '.tmp/no-codex-home')),
    pricing: offlinePricing(),
  });
  let prompt;
  runner.execute = async (command, agent, message, text) => {
    prompt = text;
    return readTurn(command.format, '');
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  store.addMessage('m', 'user', 'Go', 'dm-lead');
  runner.kick();
  await until(() => prompt);
  assert.doesNotMatch(prompt, /Authoritative task records/);
  assert.match(prompt, /task list/);
});

test('roleCliArgs is validated', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mu-role-args-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  const load = async (config) => {
    await writeFile(file, JSON.stringify(config));
    return loadConfig(file);
  };
  assert.deepEqual((await load({ roleCliArgs: { lead: { claude: ['--settings', '{}'] } } })).roleCliArgs.lead.claude, [
    '--settings',
    '{}',
  ]);
  await assert.rejects(load({ roleCliArgs: { admin: { claude: [] } } }), /role must be lead or worker/);
  await assert.rejects(load({ roleCliArgs: { lead: { gemini: [] } } }), /roleCliArgs\.lead\.gemini/);
  await assert.rejects(load({ roleCliArgs: { lead: { claude: '--settings' } } }), /expected an array/);
});
