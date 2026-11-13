import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { codexPermissions, commandFor, readTurn } from '../src/adapters.mjs';
import { initializeHome } from '../src/home.mjs';
import { Runner } from '../src/runner.mjs';
import { codexAccess, homeAccess, sandboxPi } from '../src/sandbox.mjs';
import { createApp, ROOT } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { codexInstalled, mockModel, mockProvider } from './codex-mock.mjs';
import { testIdentity, userHeaders } from './identity-fixture.mjs';
import { freePort, seatbeltSkip, shortTempDir } from './isolation.mjs';
import { offlinePricing } from './offline-pricing.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const execFileAsync = promisify(execFile);

// A workspace that holds an initialized Mu home two levels down, so that a renamed directory on the way
// could put another home at its path, with lead memory, a memory of another role, and a stand-in data
// directory with the agent's socket and credential. A worker's working directory is the workspace.
async function lab(t) {
  const work = await shortTempDir(t, 'home-box');
  const home = join(work, 'nest', 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await initializeHome({ home, root: ROOT, env: {} });
  await writeFile(join(home, 'memory/lead/fact.md'), 'lead fact\n');
  await mkdir(join(home, 'memory/other'));
  await writeFile(join(home, 'memory/other/note.md'), 'other note\n');
  const dataDir = join(work, 'data');
  for (const directory of ['credentials', 'sockets']) await mkdir(join(dataDir, directory), { recursive: true });
  const socket = join(dataDir, 'sockets', 'agent.sock'),
    credentialFile = join(dataDir, 'credentials', 'agent');
  await writeFile(socket, '');
  await writeFile(credentialFile, 'own');
  const privatePath = join(work, 'private');
  await mkdir(privatePath);
  return { work, home, dataDir, socket, credentialFile, privatePath };
}

test('the home rules: instructions read-only for every role, memory closed to workers, lead memory open to the lead', async (t) => {
  const { work, home } = await lab(t);
  assert.deepEqual(homeAccess(home, 'worker'), {
    home,
    readOnly: [home],
    unreadable: [join(home, 'memory')],
    writable: [],
  });
  assert.deepEqual(homeAccess(home, 'lead').writable, [join(home, 'memory/lead')]);
  assert.throws(() => homeAccess(home, 'reviewer'), /Unknown role reviewer/);
  // Seatbelt and Codex match real paths, also for a home whose path goes through a symbolic link.
  assert.equal(homeAccess(join(work, 'nest', '..', 'nest', 'home'), 'worker').home, home);
});

test('the Codex profile reads the home, denies memory, and writes lead memory only for the lead', async (t) => {
  const { work, home, dataDir, credentialFile, privatePath } = await lab(t);
  const profile = (role) => {
    const access = codexAccess({ cwd: work, dataDir, home, role, privatePaths: [privatePath] });
    return {
      access,
      filesystem: codexPermissions({ dataDir, credentialFile, privatePaths: [privatePath], ...access })[3],
    };
  };
  const entry = (path, mode) => `${JSON.stringify(path)}="${mode}"`;
  const worker = profile('worker');
  assert.ok(worker.filesystem.includes(entry(home, 'read')), 'an explicit entry, not the workspace grant');
  assert.ok(worker.filesystem.includes(entry(join(home, 'memory'), 'deny')));
  assert.ok(
    worker.filesystem.includes(entry(join(work, 'nest'), 'read')),
    'the directory between the workspace and the home',
  );
  assert.ok(!worker.filesystem.includes(join(home, 'memory/lead')));
  assert.ok(!worker.access.writable.some((path) => path.startsWith(home)));
  const lead = profile('lead');
  assert.ok(lead.filesystem.includes(entry(home, 'read')));
  assert.ok(lead.filesystem.includes(entry(join(home, 'memory'), 'deny')));
  assert.ok(lead.filesystem.includes(entry(join(home, 'memory/lead'), 'write')));
  // The home's own parent is the workspace here; nothing between them needs an entry.
  const flat = await shortTempDir(t, 'home-flat');
  await mkdir(join(flat, 'home'), { mode: 0o700 });
  await initializeHome({ home: join(flat, 'home'), root: ROOT, env: {} });
  const access = codexAccess({ cwd: flat, dataDir, home: join(flat, 'home'), role: 'worker', privatePaths: [] });
  assert.deepEqual(
    access.readOnly.filter((path) => path.startsWith(flat) && !/\/\.(git|pi|claude|codex|agents)$/.test(path)),
    [join(flat, 'home')],
  );
});

test('a symbolic link in the workspace on the way to the home stays in place for Codex', async (t) => {
  const { work, dataDir } = await lab(t);
  const outside = await shortTempDir(t, 'home-box-outside');
  await mkdir(join(outside, 'home'), { mode: 0o700 });
  await initializeHome({ home: join(outside, 'home'), root: ROOT, env: {} });
  await symlink(outside, join(work, 'link'));
  const access = codexAccess({ cwd: work, dataDir, home: join(work, 'link/home'), role: 'worker', privatePaths: [] });
  assert.ok(access.readOnly.includes(join(work, 'link')), 'the runner reads the home through the link');
  assert.ok(access.readOnly.includes(join(outside, 'home')));
  assert.ok(!access.readOnly.includes(outside), 'the link target lies outside every writable directory');
});

test('the pi profile keeps the home read-only, memory unreadable, and reopens lead memory for the lead', async (t) => {
  const { work, home, dataDir, socket, credentialFile, privatePath } = await lab(t);
  const profile = (role) =>
    sandboxPi({
      agent: { id: 'agent', role, cwd: work },
      args: [],
      root: ROOT,
      home,
      dataDir,
      localPorts: [],
      socket,
      credentialFile,
      platform: 'darwin',
      privatePaths: [privatePath],
    }).args[1];
  const worker = profile('worker');
  const memory = join(home, 'memory'),
    leadMemory = join(home, 'memory/lead');
  assert.ok(worker.includes(`(deny file-write* (subpath "${home}"))`));
  assert.ok(worker.includes(`(deny file-read* (subpath "${memory}"))`));
  assert.ok(!worker.includes(leadMemory));
  assert.ok(worker.includes(`  (literal "${join(work, 'nest')}")`), 'the entries on the way to the home are fixed');
  const lead = profile('lead');
  const order = [
    `(deny file-read* (subpath "${memory}"))`,
    `(allow file-read* (subpath "${leadMemory}"))`,
    `(deny file-write* (subpath "${home}"))`,
    `(allow file-write* (subpath "${leadMemory}"))`,
  ].map((rule) => lead.indexOf(rule));
  assert.ok(
    order.every((position, index) => position > (order[index - 1] ?? -1)),
    'the later rule wins in Seatbelt, so each reopening comes after its closing rule',
  );
});

test('a working directory inside the home, or a writable root inside or around it, is refused', async (t) => {
  const { work, home, dataDir, socket, credentialFile } = await lab(t);
  const codex = (cwd, writableRoots = []) =>
    codexAccess({ cwd, writableRoots, dataDir, home, role: 'worker', privatePaths: [] });
  assert.throws(() => codex(join(home, 'skills')), /Codex working directory .*\/skills is inside the Mu home/);
  assert.throws(() => codex(work, [join(home, 'memory')]), /Codex writable root .*\/memory is inside the Mu home/);
  assert.throws(() => codex(join(work, 'data'), [work]), /Codex writable root .* contains the Mu home/);
  assert.doesNotThrow(() => codex(work), 'a working directory around the home keeps the home read-only');
  const pi = (cwd, writableRoots = []) =>
    sandboxPi({
      agent: { id: 'agent', role: 'worker', cwd },
      args: [],
      root: ROOT,
      home,
      dataDir,
      localPorts: [],
      socket,
      credentialFile,
      writableRoots,
      platform: 'darwin',
      privatePaths: [],
    });
  assert.throws(() => pi(home), /pi working directory .* is inside the Mu home/);
  assert.throws(() => pi(work, [join(home, 'skills')]), /pi writable root .* is inside the Mu home/);
  assert.throws(() => pi(dataDir, [join(work, 'nest')]), /pi writable root .* contains the Mu home/);

  const start = (options) =>
    createApp({
      home,
      port: 1,
      dataDir,
      chatFactory: () => new FakeChat(),
      pricing: offlinePricing(),
      ...options,
    });
  await assert.rejects(
    start({ codexSandbox: { writableRoots: [work] } }),
    /codexSandbox\.writableRoots entry .* contains the Mu home/,
  );
  await assert.rejects(
    start({ piSandbox: { writableRoots: [join(home, 'skills')] } }),
    /piSandbox\.writableRoots entry .* is inside the Mu home/,
  );
});

// On macOS one directory has other names: another case on a case-insensitive volume, and the path through the
// /System/Volumes/Data firmlink. realpath keeps both, so each refusal has to compare identities.
function homeAliases(work, home) {
  const caseAlias = (path) => join(dirname(path), basename(path).toUpperCase());
  const firmlink = (path) => `/System/Volumes/Data${path}`;
  const kinds = [
    { kind: 'case', home: join(caseAlias(join(work, 'nest')), 'Home'), work: caseAlias(work) },
    { kind: 'firmlink', home: firmlink(home), work: firmlink(work) },
  ];
  return kinds.filter((alias) => process.platform === 'darwin' && existsSync(alias.home) && existsSync(alias.work));
}

test('an alias of the home, by case or through the data volume firmlink, is refused as well', async (t) => {
  const { work, home, dataDir, socket, credentialFile } = await lab(t);
  const aliases = homeAliases(work, home);
  if (!aliases.length) return t.skip('the home has no alias on this volume');
  const codex = (cwd, writableRoots = []) =>
    codexAccess({ cwd, writableRoots, dataDir, home, role: 'worker', privatePaths: [] });
  const pi = (cwd, writableRoots = []) =>
    sandboxPi({
      agent: { id: 'agent', role: 'worker', cwd },
      args: [],
      root: ROOT,
      home,
      dataDir,
      localPorts: [],
      socket,
      credentialFile,
      writableRoots,
      platform: 'darwin',
      privatePaths: [],
    });
  for (const alias of aliases) {
    const message = `${alias.kind} alias`;
    assert.throws(() => codex(join(alias.home, 'skills')), /Codex working directory .* is inside the Mu home/, message);
    assert.throws(
      () => codex(work, [join(alias.home, 'memory')]),
      /Codex writable root .* is inside the Mu home/,
      message,
    );
    assert.throws(() => codex(dataDir, [alias.work]), /Codex writable root .* contains the Mu home/, message);
    assert.throws(() => pi(join(alias.home, 'skills')), /pi working directory .* is inside the Mu home/, message);
    assert.throws(() => pi(work, [join(alias.home, 'skills')]), /pi writable root .* is inside the Mu home/, message);
    assert.throws(() => pi(dataDir, [alias.work]), /pi writable root .* contains the Mu home/, message);
    // The directory between an aliased workspace and the home still gets its explicit entry.
    assert.ok(codex(alias.work).readOnly.includes(join(work, 'nest')), message);
    await assert.rejects(
      createApp({
        home,
        port: 1,
        dataDir,
        chatFactory: () => new FakeChat(),
        pricing: offlinePricing(),
        codexSandbox: { writableRoots: [join(alias.home, 'skills')] },
      }),
      /codexSandbox\.writableRoots entry .* is inside the Mu home/,
      message,
    );
  }
});

// Only the lead's memory may be writable in the home, whichever path would make more of it writable.
test('the Codex profile refuses to make anything else in the home writable', async (t) => {
  const { home, dataDir } = await lab(t);
  await execFileAsync('git', ['init', '-q', home], { env });
  const outside = await shortTempDir(t, 'home-box-tree');
  await execFileAsync('git', ['-C', home, 'worktree', 'add', '-q', '--orphan', '-b', 'tree', join(outside, 'tree')], {
    env,
  });
  assert.throws(
    () => codexAccess({ cwd: join(outside, 'tree'), dataDir, home, role: 'lead', privatePaths: [] }),
    /The Codex sandbox would make .*\/\.git\/.* writable, which is inside the Mu home/,
  );
});

class FakeChat extends EventEmitter {
  state = { connected: true };
  async start() {}
  async connect() {}
  async syncConversation() {}
  async send() {}
  close() {}
}

test('the service refuses a sandboxed agent whose working directory is inside the home', async (t) => {
  const { work, home } = await lab(t);
  const port = await freePort();
  const app = await createApp({
    home,
    port,
    dataDir: await shortTempDir(t, 'home-box-data'),
    chatFactory: () => new FakeChat(),
    pricing: offlinePricing(),
    platform: 'darwin',
  });
  await app.start();
  t.after(() => app.close());
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: userHeaders(app),
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const agent = (id, adapter, cwd) => ({ id, role: 'worker', adapter, cwd, task: '', model: 'provider/model' });
  for (const adapter of ['codex', 'pi']) {
    const refused = await call('POST', '/api/agents', agent(`in-${adapter}`, adapter, join(home, 'skills')));
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, new RegExp(`The ${adapter} agent's cwd .* is inside the Mu home`));
  }
  for (const alias of homeAliases(work, home)) {
    const refused = await call(
      'POST',
      '/api/agents',
      agent(`alias-${alias.kind}`, 'codex', join(alias.home, 'skills')),
    );
    assert.equal(refused.status, 400, `${alias.kind} alias`);
    assert.match(refused.body.error, /The codex agent's cwd .* is inside the Mu home/);
  }
  const claude = await call('POST', '/api/agents', { ...agent('in-claude', 'claude', home), model: undefined });
  assert.equal(claude.status, 201, 'Claude Code has no sandbox; the worker skill is the boundary');
  const outside = await call('POST', '/api/agents', agent('outside', 'codex', work));
  assert.equal(outside.status, 201);
  app.store.updateAgent('outside', { status: 'stopped' });
  const moved = await call('PATCH', '/api/agents/outside', { cwd: join(home, 'memory') });
  assert.equal(moved.status, 400);
  assert.match(moved.body.error, /The codex agent's cwd .* is inside the Mu home/);
  app.store.updateAgent('in-claude', { status: 'stopped' });
  const sandboxed = await call('PATCH', '/api/agents/in-claude', { adapter: 'codex' });
  assert.equal(sandboxed.status, 400);
  assert.match(sandboxed.body.error, /The codex agent's cwd .* is inside the Mu home/);
});

// Runs the probe inside the profile Mu builds for a pi agent, so the test fails if macOS stops enforcing it.
async function piProbe(paths, role, script = undefined) {
  const { work, home, dataDir, socket, credentialFile, privatePath } = paths;
  const command = sandboxPi({
    agent: { id: 'agent', role, cwd: work },
    args: [],
    root: ROOT,
    home,
    dataDir,
    localPorts: [],
    socket,
    credentialFile,
    privatePaths: [privatePath],
  });
  const probe =
    script ??
    `
    const fs = require('node:fs');
    const [work, home] = process.argv.slice(1);
    const attempt = (name, action) => { try { action(); return [name, 'allowed']; } catch (error) { return [name, error.code]; } };
    console.log(JSON.stringify(Object.fromEntries([
      attempt('read skill', () => fs.readFileSync(home + '/skills/worker/SKILL.md')),
      attempt('read projects', () => fs.readFileSync(home + '/projects.md')),
      attempt('write skill', () => fs.appendFileSync(home + '/skills/worker/SKILL.md', 'planted')),
      attempt('write projects', () => fs.appendFileSync(home + '/projects.md', 'planted')),
      attempt('create in home', () => fs.writeFileSync(home + '/planted', 'x')),
      attempt('read lead memory', () => fs.readFileSync(home + '/memory/lead/fact.md')),
      attempt('list memory', () => fs.readdirSync(home + '/memory')),
      attempt('read other memory', () => fs.readFileSync(home + '/memory/other/note.md')),
      attempt('write lead memory', () => fs.writeFileSync(home + '/memory/lead/new.md', 'fact')),
      attempt('move lead memory', () => fs.renameSync(home + '/memory/lead', home + '/memory/moved')),
      attempt('move home aside', () => fs.renameSync(work + '/nest', work + '/moved')),
      attempt('workspace', () => fs.writeFileSync(work + '/file', 'x')),
    ])));`;
  const { stdout } = await execFileAsync('sandbox-exec', [
    '-p',
    command.args[1],
    process.execPath,
    '-e',
    probe,
    work,
    home,
  ]);
  return JSON.parse(stdout);
}

test(
  'under Seatbelt a pi worker reads the instructions, writes nothing in the home and cannot read memory',
  { skip: seatbeltSkip },
  async (t) => {
    const paths = await lab(t);
    const skill = await readFile(join(paths.home, 'skills/worker/SKILL.md'), 'utf8');
    assert.deepEqual(await piProbe(paths, 'worker'), {
      'read skill': 'allowed',
      'read projects': 'allowed',
      'write skill': 'EPERM',
      'write projects': 'EPERM',
      'create in home': 'EPERM',
      'read lead memory': 'EPERM',
      'list memory': 'EPERM',
      'read other memory': 'EPERM',
      'write lead memory': 'EPERM',
      'move lead memory': 'EPERM',
      'move home aside': 'EPERM',
      workspace: 'allowed',
    });
    assert.equal(await readFile(join(paths.home, 'skills/worker/SKILL.md'), 'utf8'), skill);
  },
);

test(
  'under Seatbelt a pi lead reads and writes its own memory and nothing else in the home',
  { skip: seatbeltSkip },
  async (t) => {
    const paths = await lab(t);
    assert.deepEqual(await piProbe(paths, 'lead'), {
      'read skill': 'allowed',
      'read projects': 'allowed',
      'write skill': 'EPERM',
      'write projects': 'EPERM',
      'create in home': 'EPERM',
      'read lead memory': 'allowed',
      'list memory': 'EPERM',
      'read other memory': 'EPERM',
      'write lead memory': 'allowed',
      'move lead memory': 'EPERM',
      'move home aside': 'EPERM',
      workspace: 'allowed',
    });
    assert.equal(await readFile(join(paths.home, 'memory/lead/new.md'), 'utf8'), 'fact');
  },
);

test(
  'under Seatbelt a pi worker cannot swap a symbolic link on the way to the home',
  { skip: seatbeltSkip },
  async (t) => {
    const paths = await lab(t);
    const outside = await shortTempDir(t, 'home-box-outside');
    await mkdir(join(outside, 'home'), { mode: 0o700 });
    await initializeHome({ home: join(outside, 'home'), root: ROOT, env: {} });
    const link = join(paths.work, 'link'),
      fake = join(paths.work, 'fake');
    await symlink(outside, link);
    await mkdir(join(fake, 'home/skills/worker'), { recursive: true });
    await writeFile(join(fake, 'home/skills/worker/SKILL.md'), 'FAKE INSTRUCTIONS\n');
    const script = `
    const fs = require('node:fs');
    const [work] = process.argv.slice(1);
    const attempt = (name, action) => { try { action(); return [name, 'allowed']; } catch (error) { return [name, error.code]; } };
    console.log(JSON.stringify(Object.fromEntries([
      attempt('unlink', () => fs.unlinkSync(work + '/link')),
      attempt('rename', () => fs.renameSync(work + '/link', work + '/moved')),
    ])));`;
    const results = await piProbe({ ...paths, home: join(link, 'home') }, 'worker', script);
    assert.deepEqual(results, { unlink: 'EPERM', rename: 'EPERM' });
    assert.equal(await realpath(link), await realpath(outside));
  },
);

// One real Codex turn with the profile Mu builds for the role, pointed at a scripted model that runs the probe.
/** @param {{paths?: Awaited<ReturnType<typeof lab>>, script?: string}} [probe] */
async function codexProbe(t, role, call = {}, probe = {}) {
  const paths = probe.paths ?? (await lab(t));
  const { work, home, dataDir, credentialFile, privatePath } = paths;
  const codexHome = await shortTempDir(t, 'home-box-codex');
  const script =
    probe.script ??
    [
      `cat ${home}/skills/worker/SKILL.md >/dev/null 2>&1; echo readSkill=$?`,
      `cat ${home}/projects.md >/dev/null 2>&1; echo readProjects=$?`,
      `printf planted >> ${home}/skills/worker/SKILL.md 2>/dev/null; echo writeSkill=$?`,
      `touch ${home}/planted 2>/dev/null; echo createInHome=$?`,
      `cat ${home}/memory/lead/fact.md >/dev/null 2>&1; echo readLeadMemory=$?`,
      `cat ${home}/memory/other/note.md >/dev/null 2>&1; echo readOtherMemory=$?`,
      `printf fact > ${home}/memory/lead/codex.md 2>/dev/null; echo writeLeadMemory=$?`,
      `touch ${work}/file 2>/dev/null; echo workspace=$?`,
      `mv ${work}/nest ${work}/moved 2>/dev/null; echo moveHome=$?`,
    ].join('; ');
  const model = await mockModel(t, { cmd: script, ...call });
  const options = {
    dataDir,
    credentialFile,
    privatePaths: [privatePath],
    ...codexAccess({ cwd: work, dataDir, home, role, privatePaths: [privatePath] }),
  };
  const { args } = commandFor(
    { id: 'agent', role, adapter: 'codex', cwd: work, model: 'mock-model' },
    ROOT,
    {},
    {},
    { codex: options },
  );
  const exec = args.indexOf('exec');
  const child = spawn('codex', [...args.slice(0, exec), ...mockProvider(model.port), ...args.slice(exec)], {
    cwd: work,
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
  return { results, reviews: model.seen.reviews, paths };
}

const codexSkip = seatbeltSkip || (!codexInstalled && 'codex is not installed');

test('a real Codex lead turn writes lead memory and nothing else in the home', { skip: codexSkip }, async (t) => {
  const { results, paths } = await codexProbe(t, 'lead');
  assert.deepEqual(results, {
    readSkill: 'ok',
    readProjects: 'ok',
    writeSkill: 'denied',
    createInHome: 'denied',
    readLeadMemory: 'ok',
    readOtherMemory: 'denied',
    writeLeadMemory: 'ok',
    workspace: 'ok',
    moveHome: 'denied',
  });
  assert.equal(await readFile(join(paths.home, 'memory/lead/codex.md'), 'utf8'), 'fact');
});

test(
  'a real Codex worker turn reads the instructions but cannot read memory or write the home',
  { skip: codexSkip },
  async (t) => {
    const { results, paths } = await codexProbe(t, 'worker');
    assert.deepEqual(results, {
      readSkill: 'ok',
      readProjects: 'ok',
      writeSkill: 'denied',
      createInHome: 'denied',
      readLeadMemory: 'denied',
      readOtherMemory: 'denied',
      writeLeadMemory: 'denied',
      workspace: 'ok',
      moveHome: 'denied',
    });
    assert.ok(!existsSync(join(paths.home, 'memory/lead/codex.md')));
  },
);

// The reviewer is the boundary for the instructions: an approved command keeps only the deny entries. Those
// also keep the directories around the denied memory in place: moving the home aside stays denied (observed).
test(
  "a Codex worker's approved escalation still cannot read or write memory, but can write the instructions",
  { skip: codexSkip },
  async (t) => {
    const { results, reviews } = await codexProbe(t, 'worker', {
      sandbox_permissions: 'require_escalated',
      justification: 'Run the check outside the sandbox.',
    });
    assert.equal(reviews, 1);
    assert.deepEqual(results, {
      readSkill: 'ok',
      readProjects: 'ok',
      writeSkill: 'ok',
      createInHome: 'ok',
      readLeadMemory: 'denied',
      readOtherMemory: 'denied',
      writeLeadMemory: 'denied',
      workspace: 'ok',
      moveHome: 'denied',
    });
  },
);

// An approved command keeps only the deny entries, so the lead's write entry for its memory is gone with the rest.
test("a Codex lead's approved escalation loses its own memory", { skip: codexSkip }, async (t) => {
  const { results, reviews, paths } = await codexProbe(t, 'lead', {
    sandbox_permissions: 'require_escalated',
    justification: 'Run the check outside the sandbox.',
  });
  assert.equal(reviews, 1);
  assert.deepEqual([results.readLeadMemory, results.writeLeadMemory, results.writeSkill], ['denied', 'denied', 'ok']);
  assert.ok(!existsSync(join(paths.home, 'memory/lead/codex.md')));
});

test('a real Codex worker turn cannot swap a symbolic link on the way to the home', { skip: codexSkip }, async (t) => {
  const paths = await lab(t);
  const outside = await shortTempDir(t, 'home-box-outside');
  await mkdir(join(outside, 'home'), { mode: 0o700 });
  await initializeHome({ home: join(outside, 'home'), root: ROOT, env: {} });
  const link = join(paths.work, 'link'),
    fake = join(paths.work, 'fake');
  await symlink(outside, link);
  await mkdir(join(fake, 'home/skills/worker'), { recursive: true });
  await writeFile(join(fake, 'home/skills/worker/SKILL.md'), 'FAKE INSTRUCTIONS\n');
  const script = [`rm ${link} 2>/dev/null; echo unlink=$?`, `ln -sfn ${fake} ${link} 2>/dev/null; echo relink=$?`].join(
    '; ',
  );
  const { results } = await codexProbe(t, 'worker', {}, { paths: { ...paths, home: join(link, 'home') }, script });
  assert.deepEqual(results, { unlink: 'denied', relink: 'denied' });
  assert.equal(await realpath(link), await realpath(outside));
});

// The lab with the data directory where Mu keeps it by default, inside the home: the database, the user credential,
// the agent's own credential and socket, and another agent's credential.
async function labWithData(t) {
  const paths = await lab(t);
  const dataDir = join(paths.home, 'data');
  for (const directory of ['credentials', 'sockets']) await mkdir(join(dataDir, directory), { recursive: true });
  await writeFile(join(dataDir, 'mu.sqlite'), 'database');
  await writeFile(join(dataDir, 'user-token'), 'user credential');
  await writeFile(join(dataDir, 'credentials/other'), 'other credential');
  const socket = join(dataDir, 'sockets/agent.sock'),
    credentialFile = join(dataDir, 'credentials/agent');
  await writeFile(socket, '');
  await writeFile(credentialFile, 'own');
  return { ...paths, dataDir, socket, credentialFile };
}

test('with the data directory in the home, the Codex profile reads the home but denies the data directory', async (t) => {
  const { work, home, dataDir, credentialFile, privatePath } = await labWithData(t);
  const entry = (path, mode) => `${JSON.stringify(path)}="${mode}"`;
  for (const role of ['worker', 'lead']) {
    const access = codexAccess({ cwd: work, dataDir, home, role, privatePaths: [privatePath] });
    const filesystem = codexPermissions({ dataDir, credentialFile, privatePaths: [privatePath], ...access })[3];
    assert.ok(filesystem.includes(entry(home, 'read')), role);
    assert.ok(filesystem.includes(entry(dataDir, 'deny')), `${role}: the more specific deny wins over the home's read`);
    assert.ok(filesystem.includes(entry(credentialFile, 'read')), `${role}: only its own credential is reopened`);
    assert.deepEqual(
      access.writable.filter((path) => path.startsWith(home)),
      role === 'lead' ? [join(home, 'memory/lead')] : [],
    );
  }
});

test("with the data directory in the home, the pi profile keeps it unreadable apart from the agent's own files", async (t) => {
  const { work, home, dataDir, socket, credentialFile, privatePath } = await labWithData(t);
  const profile = sandboxPi({
    agent: { id: 'agent', role: 'worker', cwd: work },
    args: [],
    root: ROOT,
    home,
    dataDir,
    localPorts: [],
    socket,
    credentialFile,
    platform: 'darwin',
    privatePaths: [privatePath],
  }).args[1];
  const order = [
    `(deny file-read* (subpath "${dataDir}"))`,
    `(allow file-read* (subpath "${join(dataDir, 'pi/agent')}"))`,
    `(allow file-read* (subpath "${credentialFile}"))`,
    `(deny file-write* (subpath "${home}"))`,
    `(deny file-write* (subpath "${dataDir}"))`,
    `(allow file-write* (subpath "${join(dataDir, 'pi/agent')}"))`,
  ].map((rule) => profile.indexOf(rule));
  assert.ok(
    order.every((position, index) => position > (order[index - 1] ?? -1)),
    `each reopening comes after its closing rule: ${order}`,
  );
});

const dataProbe = `
    const fs = require('node:fs');
    const [work, home] = process.argv.slice(1);
    const data = home + '/data';
    const attempt = (name, action) => { try { action(); return [name, 'allowed']; } catch (error) { return [name, error.code]; } };
    console.log(JSON.stringify(Object.fromEntries([
      attempt('read skill', () => fs.readFileSync(home + '/skills/worker/SKILL.md')),
      attempt('read database', () => fs.readFileSync(data + '/mu.sqlite')),
      attempt('read user credential', () => fs.readFileSync(data + '/user-token')),
      attempt('read other credential', () => fs.readFileSync(data + '/credentials/other')),
      attempt('list data', () => fs.readdirSync(data)),
      attempt('read own credential', () => fs.readFileSync(data + '/credentials/agent')),
      attempt('write own pi home', () => fs.writeFileSync(data + '/pi/agent/note', 'x')),
      attempt('write data', () => fs.writeFileSync(data + '/planted', 'x')),
      attempt('move data aside', () => fs.renameSync(data, home + '/moved')),
    ])));`;

for (const role of ['worker', 'lead'])
  test(
    `under Seatbelt a pi ${role} reads no part of the data directory in the home but its own files`,
    { skip: seatbeltSkip },
    async (t) => {
      assert.deepEqual(await piProbe(await labWithData(t), role, dataProbe), {
        'read skill': 'allowed',
        'read database': 'EPERM',
        'read user credential': 'EPERM',
        'read other credential': 'EPERM',
        'list data': 'EPERM',
        'read own credential': 'allowed',
        'write own pi home': 'allowed',
        'write data': 'EPERM',
        'move data aside': 'EPERM',
      });
    },
  );

const codexDataProbe = (home) =>
  [
    `cat ${home}/skills/worker/SKILL.md >/dev/null 2>&1; echo readSkill=$?`,
    `cat ${home}/data/mu.sqlite >/dev/null 2>&1; echo readDatabase=$?`,
    `cat ${home}/data/user-token >/dev/null 2>&1; echo readUserCredential=$?`,
    `cat ${home}/data/credentials/other >/dev/null 2>&1; echo readOtherCredential=$?`,
    `ls ${home}/data >/dev/null 2>&1; echo listData=$?`,
    `cat ${home}/data/credentials/agent >/dev/null 2>&1; echo readOwnCredential=$?`,
    `touch ${home}/data/planted 2>/dev/null; echo writeData=$?`,
  ].join('; ');

for (const role of ['worker', 'lead'])
  test(
    `a real Codex ${role} turn reads no part of the data directory in the home but its own credential`,
    { skip: codexSkip },
    async (t) => {
      const paths = await labWithData(t);
      const { results } = await codexProbe(t, role, {}, { paths, script: codexDataProbe(paths.home) });
      assert.deepEqual(results, {
        readSkill: 'ok',
        readDatabase: 'denied',
        readUserCredential: 'denied',
        readOtherCredential: 'denied',
        listData: 'denied',
        readOwnCredential: 'ok',
        writeData: 'denied',
      });
    },
  );

// An approved command keeps only the deny entries, so the data directory stays closed, the agent's own credential too.
test(
  "a Codex worker's approved escalation still reads no part of the data directory in the home",
  { skip: codexSkip },
  async (t) => {
    const paths = await labWithData(t);
    const { results, reviews } = await codexProbe(
      t,
      'worker',
      { sandbox_permissions: 'require_escalated', justification: 'Run the check outside the sandbox.' },
      { paths, script: codexDataProbe(paths.home) },
    );
    assert.equal(reviews, 1);
    assert.deepEqual(results, {
      readSkill: 'ok',
      readDatabase: 'denied',
      readUserCredential: 'denied',
      readOtherCredential: 'denied',
      listData: 'denied',
      readOwnCredential: 'denied',
      writeData: 'denied',
    });
  },
);

// A runner whose chat stores what it sends, so that the test sees whom a notice would wake. Each runner
// stands for one service process; a database file shared by two of them stands for a restart.
/** @param {{home?: string, database?: string}} [options] */
async function noticeSetup(t, options = {}) {
  const { database } = options;
  const failures = { remaining: 0 };
  const home = options.home ?? (await lab(t)).home;
  const store = new Store(database);
  for (const role of ['lead', 'worker'])
    if (!store.agent(role)) store.createAgent({ id: role, role, adapter: 'demo', cwd: ROOT, task: '' });
  const runner = new Runner({
    home,
    identity: testIdentity(t),
    store,
    chat: {
      state: { connected: true },
      async send(from, text, conversationId) {
        if (failures.remaining > 0) {
          failures.remaining -= 1;
          throw new Error('The chat broker is away');
        }
        return store.addMessage(randomUUID(), from, text, conversationId);
      },
    },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    pricing: offlinePricing(),
  });
  runner.execute = async (command) => readTurn(command.format, 'NO_REPLY\n');
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    runner.close();
    store.close();
  };
  t.after(close);
  const turn = async (agent = 'worker') => {
    store.addMessage(randomUUID(), 'user', 'Report', `dm-${agent}`);
    runner.kick();
    const end = Date.now() + 5000;
    while (runner.active.size || store.inbox(agent).length) {
      if (Date.now() > end) throw new Error('The turn did not finish');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(store.agent(agent).status, 'idle', store.agent(agent).lastError);
  };
  const notices = () => store.messages(300, 'common').filter((message) => message.from === 'system');
  return { home, store, turn, notices, close, failures };
}

test('a changed role file gets one notice for the user that wakes no agent', async (t) => {
  const { home, store, turn, notices } = await noticeSetup(t);
  await turn();
  await turn();
  assert.equal(notices().length, 0, 'the first sight of a file is no change');
  const skill = join(home, 'skills/worker/SKILL.md');
  await writeFile(skill, `${await readFile(skill, 'utf8')}\nPlanted line.\n`);
  const modified = new Date('2026-11-13T10:00:00.000Z');
  await utimes(skill, modified, modified);
  await turn();
  await turn();
  const [notice, ...more] = notices();
  assert.deepEqual(more, [], 'once per change, not once per turn');
  assert.equal(
    notice.text,
    `@user Mu runtime: the worker role file ${skill} changed; it was last modified at 2026-11-13T10:00:00.000Z. Agents with that role follow the new text from their next turn. If neither you nor init changed it, inspect the file.`,
  );
  assert.deepEqual(notice.mentions, ['user']);
  assert.deepEqual([store.inbox('lead'), store.inbox('worker')], [[], []]);
  await writeFile(skill, `${await readFile(skill, 'utf8')}\nA second change.\n`);
  await turn('lead');
  assert.equal(notices().length, 1, "the lead's turn reads only the team-lead file");
  await turn();
  assert.equal(notices().length, 2);
});

test('a notice that could not be posted is posted on the next turn', async (t) => {
  const { home, turn, notices, failures } = await noticeSetup(t);
  await turn();
  const skill = join(home, 'skills/worker/SKILL.md');
  await writeFile(skill, `${await readFile(skill, 'utf8')}\nPlanted line.\n`);
  failures.remaining = 1;
  const logged = t.mock.method(console, 'error', () => {});
  await turn();
  assert.equal(notices().length, 0);
  assert.match(logged.mock.calls[0].arguments[0], /Could not post the role file notice .* the next turn tries again/);
  await turn();
  await turn();
  assert.equal(notices().length, 1, 'posted once, when the chat came back');
});

test('the service remembers the role files it saw across a restart', async (t) => {
  const { home } = await lab(t);
  const database = join(await shortTempDir(t, 'role-files'), 'mu.sqlite');
  const before = await noticeSetup(t, { home, database });
  await before.turn();
  before.close();
  const unchanged = await noticeSetup(t, { home, database });
  await unchanged.turn();
  assert.equal(unchanged.notices().length, 0, 'a restart alone is no change');
  unchanged.close();
  await writeFile(join(home, 'skills/worker/SKILL.md'), 'Changed while the service was stopped.\n');
  const after = await noticeSetup(t, { home, database });
  await after.turn();
  assert.equal(after.notices().length, 1, 'a change made while the service was stopped');
});
