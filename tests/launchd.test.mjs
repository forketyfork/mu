import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  droppedPathEntries,
  install,
  leftOutVariables,
  missingCommands,
  plist,
  serviceEnvironment,
  stableNodePath,
  uninstall,
} from '../src/launchd.mjs';
import { freePort, shortTempDir } from './isolation.mjs';
import { once } from 'node:events';

async function commands(t, names) {
  const directory = await shortTempDir(t, 'bin');
  for (const name of names) {
    await writeFile(join(directory, name), '#!/bin/sh\n');
    await chmod(join(directory, name), 0o755);
  }
  return directory;
}
const notLoaded = () => ({ code: 113, output: 'Could not find service' });

// A login shell stand-in: it ignores its arguments and prints PATH as its startup files would leave it.
async function loginShell(t, script) {
  const file = join(await shortTempDir(t, 'shell'), 'shell');
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return file;
}
// Some login shells set PATH from scratch unless a marker variable says the environment is already set.
const resettingShell = (t) => loginShell(t, '[ -n "$ENV_DONE" ] || PATH=/usr/bin:/bin\nprintf %s "$PATH"');

test('the recorded environment holds PATH, HOME, the Mu variables as absolute paths and the job variables, but no turn variables', () => {
  const env = {
    PATH: '/work/mu/node_modules/.bin:/work/node_modules/.bin:/toolchain/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin:/opt/bin:/usr/bin',
    HOME: '/Users/me',
    CODEX_HOME: 'codex-home',
    MU_HOME: 'Mu home',
    MU_DATA_DIR: 'state',
    MU_CONFIG: '/etc/mu.json',
    MU_PORT: '4400',
    MU_AGENT_ID: 'lead',
    MU_TOKEN_FILE: '/x/credentials/lead',
    MU_CONVERSATION_ID: 'dm-lead',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000',
    SECRET: 'not-asked-for',
  };
  const environment = serviceEnvironment(env, {
    label: 'local.mu',
    log: '/Users/me/Library/Logs/Mu/local.mu.log',
    extra: ['ANTHROPIC_BASE_URL'],
    cwd: '/work/mu',
  });
  assert.deepEqual(environment, {
    PATH: '/opt/bin:/usr/bin',
    HOME: '/Users/me',
    CODEX_HOME: '/work/mu/codex-home',
    MU_HOME: '/work/mu/Mu home',
    MU_PORT: '4400',
    MU_DATA_DIR: '/work/mu/state',
    MU_CONFIG: '/etc/mu.json',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000',
    MU_LAUNCHD_LABEL: 'local.mu',
    MU_LAUNCHD_LOG: '/Users/me/Library/Logs/Mu/local.mu.log',
    MU_REQUIRE_IRC: '1',
  });
  assert.throws(
    () => serviceEnvironment(env, { label: 'local.mu', log: '/l', extra: ['MU_TOKEN_FILE'] }),
    /belongs to an agent turn/,
  );
  assert.throws(
    () => serviceEnvironment(env, { label: 'local.mu', log: '/l', extra: ['UNSET_VARIABLE'] }),
    /not set in this shell/,
  );
  assert.throws(() => serviceEnvironment({ HOME: '/Users/me' }, { label: 'local.mu', log: '/l' }), /PATH is not set/);
  assert.throws(() => serviceEnvironment(env, { label: 'local mu</string>', log: '/l' }), /Invalid launchd label/);
});

test('the plist restarts Mu after an unsuccessful exit only, sends both streams to the log and escapes its values', () => {
  const text = plist({
    label: 'local.mu',
    node: '/opt/node/bin/node',
    root: '/work/R&D mu',
    environment: { PATH: '/a:/b', MU_IRC_CHANNEL: '#mu<test>' },
    log: '/logs/mu.log',
  });
  assert.match(text, /<key>KeepAlive<\/key>\s*<dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(
    text,
    /<array><string>\/opt\/node\/bin\/node<\/string><string>\/work\/R&amp;D mu\/src\/server.mjs<\/string><\/array>/,
  );
  assert.match(text, /<key>MU_IRC_CHANNEL<\/key><string>#mu&lt;test&gt;<\/string>/);
  assert.match(
    text,
    /<key>StandardOutPath<\/key><string>\/logs\/mu.log<\/string>\s*<key>StandardErrorPath<\/key><string>\/logs\/mu.log<\/string>/,
  );
});

test('every adapter command must be on the recorded PATH unless it is explicitly allowed to be missing', async (t) => {
  const bin = await commands(t, ['claude', 'codex', 'my-wrapper']);
  const config = {
    adapters: { wrapped: { command: 'my-wrapper', args: [] }, absolute: { command: '/nonexistent/tool', args: [] } },
  };
  assert.deepEqual(missingCommands(config, bin), ['pi', '/nonexistent/tool']);
  assert.deepEqual(missingCommands(config, bin, ['pi', '/nonexistent/tool']), []);
  assert.throws(() => missingCommands(config, bin, ['gemini']), /gemini, which is not an adapter command/);
});

test('install refuses, before it writes anything, when a CLI is missing, the port is taken, the broker is down or the job exists', async (t) => {
  const home = await shortTempDir(t, 'home'),
    root = await shortTempDir(t, 'root');
  const PATH = await commands(t, ['claude', 'codex', 'pi']);
  const [port, ircPort] = [await freePort(), await freePort()];
  const options = {
    label: 'test.mu.install',
    root,
    home,
    uid: 501,
    run: notLoaded,
    shell: await loginShell(t, 'printf %s "$PATH"'),
  };
  const env = {
    PATH,
    HOME: home,
    MU_PORT: String(port),
    MU_IRC_PORT: String(ircPort),
    MU_DATA_DIR: join(home, 'data'),
  };

  await assert.rejects(
    install({ ...options, env: { ...env, PATH: await commands(t, ['claude']) } }),
    /Not found on PATH: codex, pi\. .*--allow-missing codex,pi/,
  );
  await assert.rejects(
    install({ ...options, env, shell: await resettingShell(t) }),
    new RegExp(
      `drops these PATH entries: ${PATH}\\. Codex runs agent commands in that shell.*Record a startup variable that preserves the environment with --env`,
    ),
  );
  await assert.rejects(
    install({ ...options, env }),
    new RegExp(`No IRC broker answers on 127.0.0.1:${ircPort}; start it with npm run chat:up`),
  );
  const taken = createServer().listen(port, '127.0.0.1');
  await new Promise((resolve) => taken.once('listening', resolve));
  t.after(() => taken.close());
  await assert.rejects(install({ ...options, env }), new RegExp(`Port ${port} is taken`));
  await assert.rejects(
    install({ ...options, env, run: () => ({ code: 0, output: '' }) }),
    /launchd already has gui\/501\/test.mu.install; run npm run service:uninstall -- --label test.mu.install first/,
  );
  assert.deepEqual(await readdir(home), [], 'no plist or log was written');
});

// A home directory whose Mu home is initialized, as the user's is, and the shell variables of an install from it.
async function installFixture(t) {
  const home = await shortTempDir(t, 'home'),
    root = await shortTempDir(t, 'root');
  await mkdir(join(home, '.mu'), { mode: 0o700 });
  const PATH = await commands(t, ['claude', 'codex', 'pi']);
  const [port, ircPort] = [await freePort(), await freePort()];
  const options = {
    label: 'test.mu.defaults',
    root,
    home,
    uid: 501,
    run: notLoaded,
    shell: await loginShell(t, 'printf %s "$PATH"'),
  };
  return {
    home,
    root,
    port,
    ircPort,
    options,
    env: { PATH, HOME: home, MU_PORT: String(port), MU_IRC_PORT: String(ircPort) },
  };
}

test('install refuses, before it writes anything, while the checkout still holds the database or the configuration', async (t) => {
  const { home, root, options, env } = await installFixture(t);
  await mkdir(join(root, '.mu'));
  await writeFile(join(root, '.mu/mu.sqlite'), '');
  await writeFile(join(root, 'mu.config.json'), '{}');
  await assert.rejects(
    install({ ...options, env }),
    new RegExp(
      `^Error: Mu keeps its data directory in ${join(home, '.mu/data')} and its configuration in ${join(home, '.mu/config.json')}, but the checkout still holds the database .* and the configuration .*\\. Move them with Mu stopped: npm run service:uninstall, then mv `,
    ),
  );
  assert.deepEqual(await readdir(home), ['.mu'], 'no plist or log was written');
  assert.deepEqual(await readdir(join(home, '.mu')), []);
});

test(
  'install reads the configuration in the home and waits for the credential in its data directory',
  { skip: process.platform !== 'darwin' && 'launchd exists only on macOS' },
  async (t) => {
    const { home, root, port, ircPort, options, env } = await installFixture(t);
    // A configuration left in the checkout is not read once the home holds one.
    await writeFile(
      join(root, 'mu.config.json'),
      JSON.stringify({ adapters: { old: { command: 'old-wrapper', args: [] } } }),
    );
    await writeFile(
      join(home, '.mu/config.json'),
      JSON.stringify({ adapters: { wrapped: { command: 'my-wrapper', args: [] } } }),
    );
    await assert.rejects(install({ ...options, env }), /^Error: Not found on PATH: my-wrapper\./);
    const broker = createServer().listen(ircPort, '127.0.0.1');
    await once(broker, 'listening');
    t.after(() => broker.close());
    // launchd stand-in: bootstrapping the job starts a service that creates its credential in the default data directory.
    const token = 'c'.repeat(64);
    const service = createHttpServer((request, response) => {
      response.writeHead(request.headers.authorization === `Bearer ${token}` ? 200 : 401, {
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ pid: 4242, launchd: { label: options.label } }));
    });
    t.after(() => service.close());
    const calls = [];
    const run = (...args) => {
      calls.push(args[0]);
      if (args[0] === 'print') return notLoaded();
      void mkdir(join(home, '.mu/data'), { recursive: true }).then(() =>
        writeFile(join(home, '.mu/data/user-token'), `${token}\n`).then(() => service.listen(port, '127.0.0.1')),
      );
      return { code: 0, output: '' };
    };
    const result = await install({ ...options, run, allowMissing: ['my-wrapper'], env });
    assert.deepEqual(calls, ['print', 'bootstrap']);
    assert.equal(result.service.pid, 4242);
    assert.equal(result.environment.MU_DATA_DIR, undefined, 'the job takes the default, which the installer used too');
    assert.equal(result.environment.MU_CONFIG, undefined);
    const recorded = await readFile(result.plistFile, 'utf8');
    assert.doesNotMatch(recorded, /MU_DATA_DIR|MU_CONFIG/);
  },
);

test('the login-shell check reports the PATH entries that the startup files drop, and nothing once the marker is recorded', async (t) => {
  const shell = await resettingShell(t);
  const PATH = '/toolchain/bin:/usr/bin:/toolchain/bin:/bin';
  assert.deepEqual(droppedPathEntries({ PATH }, { shell }), ['/toolchain/bin']);
  assert.deepEqual(droppedPathEntries({ PATH, ENV_DONE: '1' }, { shell }), []);
  const broken = await loginShell(t, 'echo broken >&2; exit 3');
  assert.throws(() => droppedPathEntries({ PATH }, { shell: broken }), /failed to print PATH \(exit 3\): broken/);
  assert.throws(
    () => droppedPathEntries({ PATH }, { shell: '/nonexistent/shell' }),
    /Cannot start the login shell \/nonexistent\/shell/,
  );
});

test('uninstall boots out a loaded job, removes its plist, and reports a job that is not installed', async (t) => {
  const home = await shortTempDir(t, 'home'),
    calls = [];
  await assert.rejects(
    uninstall({ label: 'test.mu', home, uid: 501, run: notLoaded }),
    /gui\/501\/test.mu is not installed/,
  );
  await mkdir(join(home, 'Library/LaunchAgents'), { recursive: true });
  await writeFile(join(home, 'Library/LaunchAgents/test.mu.plist'), '<plist/>');
  const run = (...args) => {
    calls.push(args);
    return { code: 0, output: '' };
  };
  assert.deepEqual(await uninstall({ label: 'test.mu', home, uid: 501, run }), {
    label: 'test.mu',
    plistFile: join(home, 'Library/LaunchAgents/test.mu.plist'),
    stopped: true,
  });
  assert.deepEqual(calls, [
    ['print', 'gui/501/test.mu'],
    ['bootout', 'gui/501/test.mu'],
  ]);
  assert.deepEqual(await readdir(join(home, 'Library/LaunchAgents')), []);
});

test('the installer names the shell variables it leaves out, without turn, job, session or npm variables', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/Users/me',
    ISSUE_TRACKER_TOKEN: 'secret',
    JAVA_HOME: '/jdk',
    MU_TOKEN_FILE: '/c/lead',
    XPC_SERVICE_NAME: 'x',
    SHLVL: '2',
    TERM_PROGRAM: 'iTerm',
    npm_lifecycle_event: 'service:install',
  };
  const environment = serviceEnvironment(env, { label: 'local.mu', log: '/l' });
  assert.deepEqual(leftOutVariables(env, environment), ['ISSUE_TRACKER_TOKEN', 'JAVA_HOME']);
});

test('stableNodePath names the stable opt link for a versioned package install', async (t) => {
  const prefix = await shortTempDir(t, 'versioned-package');
  const cellarNode = join(prefix, 'Cellar/node/26.13.1/bin/node');
  await mkdir(join(prefix, 'Cellar/node/26.13.1/bin'), { recursive: true });
  await mkdir(join(prefix, 'opt'), { recursive: true });
  await writeFile(cellarNode, '#!/bin/sh\n');
  await symlink(join(prefix, 'Cellar/node/26.13.1'), join(prefix, 'opt/node'));
  assert.equal(stableNodePath(cellarNode), join(prefix, 'opt/node/bin/node'));
});

test('stableNodePath keeps a path outside the versioned package layout, or whose opt link names another binary', async (t) => {
  assert.equal(stableNodePath('/opt/node/bin/node'), '/opt/node/bin/node');
  const prefix = await shortTempDir(t, 'versioned-package');
  const cellarNode = join(prefix, 'Cellar/node/26.13.1/bin/node');
  await mkdir(join(prefix, 'Cellar/node/26.13.1/bin'), { recursive: true });
  await mkdir(join(prefix, 'Cellar/node/27.0.0/bin'), { recursive: true });
  await mkdir(join(prefix, 'opt'), { recursive: true });
  await writeFile(cellarNode, '#!/bin/sh\n');
  await writeFile(join(prefix, 'Cellar/node/27.0.0/bin/node'), '#!/bin/sh\n');
  await symlink(join(prefix, 'Cellar/node/27.0.0'), join(prefix, 'opt/node'));
  assert.equal(stableNodePath(cellarNode), cellarNode);
});
