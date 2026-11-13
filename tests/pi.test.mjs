import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commandFor, parseOutput, parseUsage, readTurn } from '../src/adapters.mjs';
import { gitProtectedPaths, privateUserPaths, sandboxPi, seatbeltProfile } from '../src/sandbox.mjs';
import { Runner } from '../src/runner.mjs';
import { Store } from '../src/store.mjs';
import { createApp, loadConfig, ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { AgentSockets } from '../src/identity.mjs';
import { testIdentity, userHeaders } from './identity-fixture.mjs';
import {
  freePort,
  seatbeltSkip,
  shortTempDir,
  FAKE_PRIVATE_PATHS,
  FAKE_MU_HOME,
  temporaryMuHome,
} from './isolation.mjs';

const lines = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const usage = (input, output, total) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total, totalFromProvider: false },
});
const assistant = (text, tokens, extra = {}) => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'google-vertex',
    model: 'gemini-3.5-flash-lite',
    usage: tokens,
    stopReason: 'stop',
    ...extra,
  },
});
// Event shapes recorded from pi 1.5.0 `-p --mode json`; progress events are omitted.
const piTurn = ({
  session = 'pi-session',
  calls = [assistant('Working.', usage(1094, 69, 0.0005)), assistant('@lead Done', usage(1200, 31, 0.0004))],
} = {}) =>
  lines([
    { type: 'session', version: 3, id: session, timestamp: '2026-11-05T05:20:11.428Z', cwd: ROOT },
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'prompt' }] } },
    ...calls,
    { type: 'agent_end', messages: [] },
  ]);

const piAgent = (extra) => ({
  id: 'cheap',
  role: 'worker',
  adapter: 'pi',
  model: 'google-vertex/gemini-3.5-flash-lite',
  cwd: ROOT,
  task: '',
  ...extra,
});

const piHome = async (t) => {
  const dataDir = await shortTempDir(t, 'pi');
  return dataDir;
};

// A stand-in socket, credential files and database: the profile needs their real paths, not a listener.
const accessPaths = async (dataDir) => {
  await mkdir(join(dataDir, 'sockets'), { recursive: true });
  await mkdir(join(dataDir, 'credentials'), { recursive: true });
  const socket = join(dataDir, 'sockets', 'cheap.sock'),
    credentialFile = join(dataDir, 'credentials', 'cheap');
  await writeFile(socket, '');
  await writeFile(credentialFile, 'own');
  await writeFile(join(dataDir, 'credentials', 'lead'), 'lead');
  await writeFile(join(dataDir, 'user-token'), 'secret');
  return { socket, credentialFile };
};

test('pi runs in JSON print mode with its model and a Mu-chosen session that later turns reuse', async (t) => {
  const dataDir = await piHome(t);
  const options = {
    pi: {
      dataDir,
      home: FAKE_MU_HOME,
      localPorts: [],
      privatePaths: FAKE_PRIVATE_PATHS,
      ...(await accessPaths(dataDir)),
    },
  };
  const fresh = commandFor(piAgent({ sessionId: null }), ROOT, {}, { pi: ['--no-mcp'] }, options);
  assert.equal(fresh.format, 'pi');
  const pi = fresh.args.slice(fresh.args.indexOf('pi') + 1);
  assert.deepEqual(pi.slice(0, 6), [
    '--no-mcp',
    '-p',
    '--mode',
    'json',
    '--model',
    'google-vertex/gemini-3.5-flash-lite',
  ]);
  assert.match(pi.at(-1), /^[0-9a-f-]{36}$/);
  assert.equal(pi.at(-2), '--session-id');
  assert.equal(commandFor(piAgent({ sessionId: 'existing' }), ROOT, {}, {}, options).args.at(-1), 'existing');
});

test('pi runs inside a Seatbelt profile that confines writes to the workspace and its own pi home, and network to listed loopback ports', async (t) => {
  const dataDir = await piHome(t);
  const extra = await mkdtemp(join(dataDir, 'extra-'));
  const access = await accessPaths(dataDir);
  // The real list for a stand-in home and user ID, which a sandboxed test run can resolve.
  const privatePaths = privateUserPaths(await mkdtemp(join(dataDir, 'home-')), 999999);
  const command = commandFor(
    piAgent(),
    ROOT,
    {},
    {},
    { pi: { dataDir, home: FAKE_MU_HOME, localPorts: [19516], writableRoots: [extra], privatePaths, ...access } },
  );
  assert.equal(command.command, 'sandbox-exec');
  assert.equal(command.args[0], '-p');
  assert.equal(command.args[2], 'pi');
  const profile = command.args[1];
  const home = await realpath(join(dataDir, 'pi', 'cheap'));
  const workspace = await realpath(ROOT);
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  for (const root of [workspace, home, await realpath(extra)]) assert.ok(profile.includes(`(subpath "${root}")`), root);
  // The checkout's own configuration sets core.hooksPath = .githooks, which is in the work tree.
  assert.ok(
    profile.includes(`(deny file-write* (literal "${join(workspace, '.githooks')}")`),
    'hooks chosen by core.hooksPath',
  );
  assert.ok(
    profile.includes(
      '(deny file-write* (regex #"/\\.([gG][iI][tT]|[pP][iI]|[cC][lL][aA][uU][dD][eE]|[cC][oO][dD][eE][xX])(/|$)"))',
    ),
    'protected entries at any depth',
  );
  const order = [
    `(deny file-write* (subpath "${workspace}"))`,
    `(allow file-write* (subpath "${home}"))`,
    '(deny file-write* (regex',
  ].map((rule) => profile.indexOf(rule));
  assert.ok(
    order.every((position, index) => position > (order[index - 1] ?? 0)),
    'the Mu checkout is read-only, then the pi home is writable, then protected entries are read-only again',
  );
  assert.deepEqual(
    [...profile.matchAll(/network-outbound \(remote ip "([^"]+)"\)/g)].map((match) => match[1]),
    ['localhost:19516'],
    'no TCP port of Mu',
  );
  assert.deepEqual(
    [...profile.matchAll(/network-outbound \(remote unix-socket \(path-literal "([^"]+)"\)\)/g)].map(
      (match) => match[1],
    ),
    [await realpath(access.socket)],
    'only its own socket',
  );
  const reads = [
    `(allow file-read*)`,
    `(deny file-read* (subpath "${await realpath(dataDir)}"))`,
    `(allow file-read* (subpath "${await realpath(access.credentialFile)}"))`,
  ].map((rule) => profile.indexOf(rule));
  assert.ok(
    reads.every((position, index) => position > (reads[index - 1] ?? -1)),
    "the data directory is unreadable, apart from the agent's own files",
  );
  for (const path of privatePaths) assert.ok(profile.includes(`(deny file-read* (subpath "${path}"))`), path);
  assert.ok(
    ['/.codex', '/.claude.json', '/.pi/agent/sessions', '/Library/Application Support/Google'].every((suffix) =>
      privatePaths.some((path) => path.endsWith(suffix)),
    ),
    'agent CLI state and browser profiles',
  );
  assert.deepEqual(command.env, {
    PI_CODING_AGENT_DIR: home,
    TMPDIR: join(home, 'tmp'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
  });
  assert.throws(
    () =>
      commandFor(
        piAgent(),
        ROOT,
        {},
        {},
        { pi: { dataDir, home: FAKE_MU_HOME, localPorts: [], platform: 'linux', privatePaths, ...access } },
      ),
    /Seatbelt sandbox, which is not available on linux/,
  );
  assert.throws(
    () => commandFor(piAgent(), ROOT, {}, {}, { pi: { dataDir, home: FAKE_MU_HOME, localPorts: [], privatePaths } }),
    /needs the agent socket and its credential file/,
  );
  assert.throws(
    () => seatbeltProfile({ writableRoots: ['/a\nb'], protectedPaths: [], localPorts: [] }),
    /control characters/,
  );
  assert.match(
    seatbeltProfile({ writableRoots: ['/a "b"\\c'], protectedPaths: [], localPorts: [] }),
    /\(subpath "\/a \\"b\\"\\\\c"\)/,
  );
});

// Runs a probe under the generated profile itself, so the test fails if macOS stops enforcing it.
test(
  'the Seatbelt profile blocks writes outside the workspace, protected workspace entries, and unlisted ports',
  { skip: seatbeltSkip },
  async (t) => {
    const dataDir = await realpath(await piHome(t));
    const workspace = join(dataDir, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    const listen = () =>
      new Promise((resolve) => {
        const server = createServer((request, response) => response.end('ok')).listen(0, '127.0.0.1', () =>
          resolve(server),
        );
      });
    const [allowed, denied] = [await listen(), await listen()];
    t.after(() => {
      allowed.close();
      denied.close();
    });
    const profile = seatbeltProfile({
      writableRoots: [workspace],
      protectedPaths: [join(workspace, '.git')],
      localPorts: [allowed.address().port],
    });
    const probe = `
    const fs = require('node:fs');
    const attempt = async (name, action) => { try { await action(); return name + ': allowed'; } catch (error) { return name + ': ' + (error.code || error.cause?.code || error.message); } };
    (async () => console.log(JSON.stringify([
      await attempt('workspace', () => fs.writeFileSync(process.argv[1] + '/file', 'x')),
      await attempt('outside', () => fs.writeFileSync(process.argv[2] + '/outside', 'x')),
      await attempt('git hook', () => fs.writeFileSync(process.argv[1] + '/.git/hook', 'x')),
      await attempt('listed port', () => fetch('http://127.0.0.1:' + process.argv[3])),
      await attempt('unlisted port', () => fetch('http://127.0.0.1:' + process.argv[4])),
    ])))();`;
    const { stdout } = await promisify(execFile)('sandbox-exec', [
      '-p',
      profile,
      process.execPath,
      '-e',
      probe,
      workspace,
      dataDir,
      String(allowed.address().port),
      String(denied.address().port),
    ]);
    assert.deepEqual(JSON.parse(stdout), [
      'workspace: allowed',
      'outside: EPERM',
      'git hook: EPERM',
      'listed port: allowed',
      'unlisted port: EPERM',
    ]);
    assert.equal(await readFile(join(workspace, 'file'), 'utf8'), 'x');
  },
);

// Each denied write here is code or state that a process outside the sandbox later runs or trusts.
test(
  'the pi profile keeps configured git hooks, nested repositories, and the Mu checkout and data read-only',
  { skip: seatbeltSkip },
  async (t) => {
    const lab = await realpath(await piHome(t));
    const workspace = join(lab, 'workspace'),
      root = join(workspace, 'mu'),
      dataDir = join(root, '.mu');
    await mkdir(join(dataDir, 'pi', 'other'), { recursive: true });
    await writeFile(join(dataDir, 'mu.sqlite'), 'db');
    const scratchEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const git = (...args) => promisify(execFile)('git', ['-C', workspace, ...args], { env: scratchEnv });
    await git('init', '-q');
    await git('config', 'core.hooksPath', '.githooks');
    await git('config', 'include.path', '../shared.gitconfig');
    await writeFile(join(workspace, 'shared.gitconfig'), '');
    const command = sandboxPi({
      agent: { id: 'cheap', role: 'worker', cwd: workspace },
      args: [],
      root,
      home: FAKE_MU_HOME,
      dataDir,
      localPorts: [],
      ...(await accessPaths(dataDir)),
    });
    const home = command.env.PI_CODING_AGENT_DIR;
    const probe = `
    const fs = require('node:fs');
    const [workspace, home] = process.argv.slice(1);
    const attempt = (name, action) => { try { action(); return name + ': allowed'; } catch (error) { return name + ': ' + error.code; } };
    console.log(JSON.stringify([
      attempt('workspace', () => fs.writeFileSync(workspace + '/file', 'x')),
      attempt('similar names', () => { fs.writeFileSync(workspace + '/.gitignore', 'x'); fs.mkdirSync(workspace + '/.github'); }),
      attempt('pi home', () => fs.writeFileSync(home + '/file', 'x')),
      attempt('hooks path', () => fs.mkdirSync(workspace + '/.githooks')),
      attempt('included git config', () => fs.appendFileSync(workspace + '/shared.gitconfig', '[core]\\n\\tfsmonitor = touch /tmp/x\\n')),
      attempt('nested repository', () => fs.mkdirSync(workspace + '/sub/.git', {recursive: true})),
      attempt('nested agent settings', () => fs.mkdirSync(workspace + '/sub/.claude', {recursive: true})),
      attempt('Mu checkout', () => fs.writeFileSync(workspace + '/mu/cli.mjs', 'x')),
      attempt('Mu database', () => fs.appendFileSync(workspace + '/mu/.mu/mu.sqlite', 'x')),
      attempt('other pi home', () => fs.renameSync(workspace + '/mu/.mu/pi/other', workspace + '/mu/.mu/pi/moved')),
      attempt('own credential', () => fs.readFileSync(workspace + '/mu/.mu/credentials/cheap')),
      attempt('pi home read', () => fs.readdirSync(home)),
      attempt('another agent credential', () => fs.readFileSync(workspace + '/mu/.mu/credentials/lead')),
      attempt('Mu database read', () => fs.readFileSync(workspace + '/mu/.mu/mu.sqlite')),
      attempt('other pi home read', () => fs.readdirSync(workspace + '/mu/.mu/pi/other')),
      attempt('user credential', () => fs.readFileSync(workspace + '/mu/.mu/user-token')),
      attempt('user credential through a link', () => { fs.symlinkSync(workspace + '/mu/.mu/user-token', workspace + '/token-link'); fs.readFileSync(workspace + '/token-link'); }),
      attempt('user credential through a hard link', () => { fs.linkSync(workspace + '/mu/.mu/user-token', workspace + '/token-hard'); fs.readFileSync(workspace + '/token-hard'); }),
      attempt('replaced socket', () => fs.unlinkSync(workspace + '/mu/.mu/sockets/cheap.sock')),
    ]));`;
    const { stdout } = await promisify(execFile)('sandbox-exec', [
      '-p',
      command.args[1],
      process.execPath,
      '-e',
      probe,
      workspace,
      home,
    ]);
    assert.deepEqual(JSON.parse(stdout), [
      'workspace: allowed',
      'similar names: allowed',
      'pi home: allowed',
      'hooks path: EPERM',
      'included git config: EPERM',
      'nested repository: EPERM',
      'nested agent settings: EPERM',
      'Mu checkout: EPERM',
      'Mu database: EPERM',
      'other pi home: EPERM',
      'own credential: allowed',
      'pi home read: allowed',
      'another agent credential: EPERM',
      'Mu database read: EPERM',
      'other pi home read: EPERM',
      'user credential: EPERM',
      'user credential through a link: EPERM',
      'user credential through a hard link: EPERM',
      'replaced socket: EPERM',
    ]);
    assert.deepEqual(
      gitProtectedPaths(root),
      gitProtectedPaths(workspace),
      'a subdirectory gets the repository protections',
    );
    assert.ok(gitProtectedPaths(workspace).includes(join(workspace, 'shared.gitconfig')));
    // A git hook exports GIT_DIR; Mu must still describe the workspace, not the repository of the hook.
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = join(lab, 'elsewhere.git');
    try {
      assert.ok(gitProtectedPaths(workspace).includes(join(workspace, 'shared.gitconfig')));
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
    // The Mu checkout itself is a repository, so a directory outside any repository comes from the system.
    const plain = await mkdtemp(join(tmpdir(), 'mu-plain-'));
    t.after(() => rm(plain, { recursive: true, force: true }));
    assert.deepEqual(gitProtectedPaths(plain), []);
    assert.throws(
      () => gitProtectedPaths(join(lab, 'missing')),
      /Cannot determine the git hooks and configuration to protect/,
    );
  },
);

// Each grant is a path that Mu resolves at the next launch, so replacing any directory entry on the way
// to it, such as the granted directory, an ancestor or a symbolic link, would redirect the grant.
test(
  'a pi agent cannot remove, move or replace the directories its sandbox grants or protects',
  { skip: seatbeltSkip },
  async (t) => {
    const lab = await realpath(await piHome(t));
    // The lab has its own Mu checkout, so the read-only checkout rule does not depend on where the lab is.
    const root = join(lab, 'mu'),
      dataDir = join(lab, 'data'),
      extra = join(lab, 'extra'),
      repo = join(lab, 'repo'),
      outside = join(lab, 'outside');
    await mkdir(join(extra, 'real', 'workspace'), { recursive: true });
    for (const dir of [root, dataDir, repo, outside]) await mkdir(dir);
    await symlink(join(extra, 'real'), join(extra, 'link'));
    const workspace = join(extra, 'link', 'workspace');
    const scratchEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const git = (...args) => promisify(execFile)('git', ['-C', repo, ...args], { env: scratchEnv });
    await git('init', '-q');
    await git('config', 'core.hooksPath', 'tools/hooks');
    const access = await accessPaths(dataDir);
    const launch = () =>
      sandboxPi({
        agent: { id: 'cheap', role: 'worker', cwd: workspace },
        args: [],
        root,
        home: FAKE_MU_HOME,
        dataDir,
        localPorts: [],
        writableRoots: [extra, repo],
        ...access,
      });
    const command = launch();
    const home = command.env.PI_CODING_AGENT_DIR;
    const probe = `
    const fs = require('node:fs');
    const [home, extra, repo, outside] = process.argv.slice(1);
    const workspace = extra + '/real/workspace';
    const attempt = (name, action) => { try { action(); return name + ': allowed'; } catch (error) { return name + ': ' + error.code; } };
    const replace = path => { fs.rmSync(path, {recursive: true, force: true}); fs.symlinkSync(outside, path); };
    console.log(JSON.stringify([
      attempt('work inside the grants', () => { for (const dir of [home, home + '/tmp', workspace, extra]) { fs.mkdirSync(dir + '/d'); fs.writeFileSync(dir + '/d/f', 'x'); fs.renameSync(dir + '/d', dir + '/e'); fs.rmSync(dir + '/e', {recursive: true}); } }),
      attempt('replace pi home', () => replace(home)),
      attempt('replace temporary directory', () => replace(home + '/tmp')),
      attempt('replace workspace', () => replace(workspace)),
      attempt('move workspace parent', () => fs.renameSync(extra + '/real', extra + '/moved')),
      attempt('retarget link to workspace', () => replace(extra + '/link')),
      attempt('replace writable root', () => replace(extra)),
      attempt('plant hooks directory through a link', () => fs.symlinkSync(outside, repo + '/tools')),
    ]));`;
    const { stdout } = await promisify(execFile)('sandbox-exec', [
      '-p',
      command.args[1],
      process.execPath,
      '-e',
      probe,
      home,
      extra,
      repo,
      outside,
    ]);
    assert.deepEqual(JSON.parse(stdout), [
      'work inside the grants: allowed',
      'replace pi home: EPERM',
      'replace temporary directory: EPERM',
      'replace workspace: EPERM',
      'move workspace parent: EPERM',
      'retarget link to workspace: EPERM',
      'replace writable root: EPERM',
      'plant hooks directory through a link: EPERM',
    ]);
    assert.ok(!launch().args[1].includes(`"${outside}`), 'the next launch grants nothing outside the sandbox');
  },
);

test('Mu refuses a pi home that an earlier turn replaced with a symbolic link', async (t) => {
  const dataDir = await realpath(await piHome(t));
  const outside = join(dataDir, 'outside');
  const access = await accessPaths(dataDir);
  const launch = () =>
    sandboxPi({
      agent: { id: 'cheap', role: 'worker', cwd: dataDir },
      args: [],
      root: ROOT,
      home: FAKE_MU_HOME,
      dataDir,
      localPorts: [],
      platform: 'darwin',
      privatePaths: FAKE_PRIVATE_PATHS,
      ...access,
    });
  await mkdir(join(dataDir, 'pi'));
  await symlink(dataDir, join(dataDir, 'pi', 'cheap'));
  assert.throws(launch, /pi sandbox directory .*\/pi\/cheap is not a plain directory/);
  await rm(join(dataDir, 'pi'), { recursive: true });
  await mkdir(join(outside, 'cheap', 'tmp'), { recursive: true });
  await symlink(outside, join(dataDir, 'pi'));
  assert.throws(launch, /pi sandbox directory .*\/pi is not a plain directory/);
});

test('Mu refuses a pi temporary directory that an earlier turn replaced with a symbolic link', async (t) => {
  const dataDir = await realpath(await piHome(t));
  const home = join(dataDir, 'pi', 'cheap');
  await mkdir(home, { recursive: true });
  await symlink(join(dataDir, 'elsewhere'), join(home, 'tmp'));
  const access = await accessPaths(dataDir);
  assert.throws(
    () =>
      sandboxPi({
        agent: { id: 'cheap', role: 'worker', cwd: dataDir },
        args: [],
        root: ROOT,
        home: FAKE_MU_HOME,
        dataDir,
        localPorts: [],
        platform: 'darwin',
        privatePaths: FAKE_PRIVATE_PATHS,
        ...access,
      }),
    /pi sandbox directory .*tmp is not a plain directory/,
  );
  await assert.rejects(stat(join(dataDir, 'elsewhere')), { code: 'ENOENT' });
});

test('pi output yields the last assistant text, the session, the model, the context and the summed turn cost', () => {
  assert.deepEqual(parseOutput('pi', piTurn()), { text: '@lead Done', sessionId: 'pi-session' });
  const turn = parseUsage('pi', piTurn());
  assert.equal(turn.sessionId, 'pi-session');
  assert.equal(turn.model, 'gemini-3.5-flash-lite');
  assert.equal(turn.contextTokens, 1231);
  assert.ok(Math.abs(turn.costUsd - 0.0009) < 1e-12);
  assert.equal(turn.totalTokens, 2394);
  assert.throws(
    () =>
      parseOutput(
        'pi',
        piTurn({
          calls: [
            assistant('', usage(10, 0, 0), {
              stopReason: 'error',
              errorMessage: 'No API key found for google-vertex.',
            }),
          ],
        }),
      ),
    /No API key found/,
  );
});

test('a resumed pi session adds each turn cost and keeps its session', async (t) => {
  const dataDir = await piHome(t);
  const store = new Store();
  store.createAgent(piAgent({ task: 'Measure' }));
  const sockets = new AgentSockets({ dataDir, handler: (request, response) => response.end() });
  t.after(() => sockets.close());
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    sockets,
    store,
    chat: { state: { connected: true }, async send() {} },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    pricing: offlinePricing(),
    dataDir,
    piSandbox: { localPorts: [19516] },
    privatePaths: FAKE_PRIVATE_PATHS,
  });
  const outputs = [
    piTurn({ session: 'chosen' }),
    piTurn({ session: 'chosen', calls: [assistant('@lead Again', usage(1500, 20, 0.0003))] }),
  ];
  const sessions = [];
  const commands = [];
  runner.execute = async (command, agent) => {
    sessions.push(agent.sessionId);
    commands.push({ ...command, token: await readFile(command.env.MU_TOKEN_FILE, 'utf8') });
    return readTurn(command.format, outputs.shift());
  };
  t.after(() => {
    runner.close();
    store.close();
  });
  for (const id of [1, 2]) {
    store.addMessage(`pi-${id}`, 'user', 'Report', 'dm-cheap');
    runner.kick();
    await new Promise((resolve) => {
      const check = () => (runner.active.size ? setTimeout(check, 5) : resolve());
      check();
    });
  }
  assert.deepEqual(sessions, [null, 'chosen']);
  const socket = await realpath(join(dataDir, 'sockets', 'cheap.sock'));
  assert.ok(
    commands.every(
      (command) =>
        command.command === 'sandbox-exec' &&
        !command.args[1].includes('localhost:4310') &&
        command.args[1].includes(`(remote unix-socket (path-literal "${socket}"))`) &&
        command.args[1].includes('(remote ip "localhost:19516")'),
    ),
    'every turn runs sandboxed and reaches Mu only through its socket, plus the configured port',
  );
  assert.ok(
    commands.every(
      (command) =>
        command.env.MU_URL === `unix:${join(dataDir, 'sockets', 'cheap.sock')}` &&
        /^[0-9a-f]{64}\n$/.test(command.token) &&
        !('MU_TOKEN' in command.env) &&
        !('MU_PROMPT' in command.env),
    ),
    'the CLI inside the sandbox uses the socket and a credential file, and the environment holds no secret',
  );
  assert.notEqual(commands[0].token, commands[1].token, 'each turn has its own credential');
  assert.equal(runner.identity.agentTokens.size, 0, 'credentials are revoked when their turn ends');
  await assert.rejects(stat(commands[0].env.MU_TOKEN_FILE), { code: 'ENOENT' }, 'and their files are removed');
  const recorded = store.agent('cheap').usage['dm-cheap'];
  assert.equal(recorded.model, 'gemini-3.5-flash-lite');
  assert.equal(recorded.contextTokens, 1520);
  assert.ok(Math.abs(recorded.sessions.chosen.costUsd - 0.0012) < 1e-12);
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

test('the service offers pi and requires a model for it', async (t) => {
  const dataDir = await shortTempDir(t, 'pi');
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
  const missing = await post({ id: 'cheap', role: 'worker', adapter: 'pi', cwd: ROOT });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /pi adapter needs a model/);
  assert.equal(
    (
      await post({
        id: 'cheap',
        role: 'worker',
        adapter: 'pi',
        model: 'google-vertex/gemini-3.5-flash-lite',
        cwd: ROOT,
      })
    ).status,
    201,
  );
  assert.ok(
    (await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: userHeaders(app) })).json()).adapters.includes(
      'pi',
    ),
  );
});

test('the service refuses a pi agent where the Seatbelt sandbox is unavailable', async (t) => {
  const dataDir = await piHome(t);
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir,
    platform: 'linux',
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const response = await fetch(`http://127.0.0.1:${port}/api/agents`, {
    method: 'POST',
    headers: userHeaders(app),
    body: JSON.stringify({
      id: 'cheap',
      role: 'worker',
      adapter: 'pi',
      model: 'google-vertex/gemini-3.5-flash-lite',
      cwd: ROOT,
    }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /needs the macOS Seatbelt sandbox, which is not available on linux/);
});

test('the configuration accepts pi arguments and sandbox settings and rejects invalid ones', async (t) => {
  const dataDir = await piHome(t);
  const filename = join(dataDir, 'mu.config.json');
  const load = async (config) => {
    await writeFile(filename, JSON.stringify(config));
    return loadConfig(filename);
  };
  const valid = {
    cliArgs: { pi: ['--no-extensions'] },
    piSandbox: { localPorts: [19516], writableRoots: ['/tmp/shared'] },
  };
  assert.deepEqual(await load(valid), valid);
  await assert.rejects(load({ piSandbox: { localPorts: ['19516'] } }), /piSandbox.localPorts/);
  await assert.rejects(load({ piSandbox: { localPorts: [70000] } }), /piSandbox.localPorts/);
  await assert.rejects(load({ piSandbox: { writableRoots: ['relative'] } }), /piSandbox.writableRoots/);
  await assert.rejects(load({ piSandbox: { network: true } }), /unknown keys network/);
  await assert.rejects(load({ adapters: { pi: { command: 'pi', args: [] } } }), /Invalid custom adapter pi/);
});
