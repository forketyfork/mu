import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commandFor } from '../src/adapters.mjs';
import { ROOT } from '../src/server.mjs';
import { codexAccess } from '../src/sandbox.mjs';
import { seatbeltSkip, FAKE_MU_HOME } from './isolation.mjs';
import { codexInstalled, mockModel, mockProvider } from './codex-mock.mjs';

const run = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const skip = seatbeltSkip || (!codexInstalled && 'codex is not installed');

// A repository outside every place the profile makes writable, a stand-in data directory with the
// agent's credential, a stand-in private path, and a directory outside them all.
async function lab(t) {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const directory = await realpath(await mkdtemp(join(ROOT, '.tmp/codex-escalation-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [repo, dataDir, privatePath, outside, codexHome] = ['repo', 'data', 'private', 'outside', 'codex-home'].map(
    (name) => join(directory, name),
  );
  for (const path of [repo, join(dataDir, 'credentials'), privatePath, outside, codexHome])
    await mkdir(path, { recursive: true });
  await run('git', ['init', '-q', repo], { env });
  const credentialFile = join(dataDir, 'credentials', 'worker');
  await writeFile(credentialFile, 'own');
  return { repo, dataDir, privatePath, outside, codexHome, credentialFile };
}

// One managed Codex turn with the arguments Mu builds, pointed at the mock model and a throwaway CODEX_HOME.
async function turn(t, call, cliArgs = []) {
  const paths = await lab(t);
  const { repo, dataDir, privatePath, outside, codexHome, credentialFile } = paths;
  const script = [
    `touch ${outside}/planted; echo outside=$?`,
    `ls ${dataDir} >/dev/null 2>&1; echo readData=$?`,
    `touch ${dataDir}/planted 2>/dev/null; echo writeData=$?`,
    `ls ${privatePath} >/dev/null 2>&1; echo readPrivate=$?`,
    `touch ${privatePath}/planted 2>/dev/null; echo writePrivate=$?`,
    `cat ${credentialFile} >/dev/null 2>&1; echo ownCredential=$?`,
    `printf x > .git/hooks/pre-commit 2>/dev/null; echo ownHooks=$?`,
  ].join('; ');
  const model = await mockModel(t, { cmd: script, ...call });
  const options = {
    dataDir,
    credentialFile,
    privatePaths: [privatePath],
    ...codexAccess({ cwd: repo, dataDir, home: FAKE_MU_HOME, role: 'worker', privatePaths: [privatePath] }),
  };
  const { args } = commandFor(
    { id: 'worker', role: 'worker', adapter: 'codex', cwd: repo, model: 'mock-model' },
    ROOT,
    {},
    { codex: cliArgs },
    { codex: options },
  );
  const provider = mockProvider(model.port);
  const exec = args.indexOf('exec');
  const child = spawn('codex', [...args.slice(0, exec), ...provider, ...args.slice(exec)], {
    cwd: repo,
    env: { ...env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  child.stdin.end('Run the check.');
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, stderr.slice(-2000));
  const results = Object.fromEntries(
    [...(model.seen.output || '').matchAll(/^(\w+)=(\d+)$/gm)].map(([, name, value]) => [
      name,
      value === '0' ? 'ok' : 'denied',
    ]),
  );
  return {
    reviews: model.seen.reviews,
    output: model.seen.output,
    results,
    plantedOutside: existsSync(join(outside, 'planted')),
    plantedData: existsSync(join(dataDir, 'planted')),
  };
}

const escalated = { sandbox_permissions: 'require_escalated', justification: 'Run the check outside the sandbox.' };

// Mu's documentation of Codex agents rests on these: an approved command can write anywhere, its
// repository's hooks included, but the profile's deny entries hold, and the agent's own credential,
// a read exception inside the denied data directory, does not survive the approval.
test(
  "an escalation that Codex's reviewer approves keeps Mu's deny entries and drops everything else, the own credential included",
  { skip },
  async (t) => {
    const { reviews, results, plantedOutside, plantedData } = await turn(t, escalated);
    assert.equal(reviews, 1, "Mu's approval settings send the escalation to the reviewer");
    assert.deepEqual(results, {
      outside: 'ok',
      readData: 'denied',
      writeData: 'denied',
      readPrivate: 'denied',
      writePrivate: 'denied',
      ownCredential: 'denied',
      ownHooks: 'ok',
    });
    assert.ok(plantedOutside && !plantedData);
  },
);

test("without an escalation the command stays in Mu's profile", { skip }, async (t) => {
  const { reviews, results, plantedOutside } = await turn(t, {});
  assert.equal(reviews, 0);
  assert.deepEqual(results, {
    outside: 'denied',
    readData: 'denied',
    writeData: 'denied',
    readPrivate: 'denied',
    writePrivate: 'denied',
    ownCredential: 'ok',
    ownHooks: 'denied',
  });
  assert.ok(!plantedOutside);
});

test('approval_policy="never" in cliArgs.codex turns escalation off', { skip }, async (t) => {
  const { reviews, output, plantedOutside } = await turn(t, escalated, ['-c', 'approval_policy="never"']);
  assert.equal(reviews, 0);
  assert.match(output, /approval policy is Never; reject command/);
  assert.ok(!plantedOutside);
});
