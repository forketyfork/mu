// Installs and removes Mu as a launchd user agent; see "Run Mu as a launchd agent" in README.md and
// "Running under launchd" in docs/architecture.md.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { leftoverError, resolveConfigFile, resolveDataDir, resolveHome } from './home.mjs';
import { ROOT, loadConfig } from './server.mjs';
import { LAUNCHD_VARIABLES, TURN_VARIABLES } from './service.mjs';

export const DEFAULT_LABEL = 'local.mu';
// Mu's own settings, then what the harnesses need to find their state: transcripts and Codex pricing read
// CLAUDE_CONFIG_DIR and CODEX_HOME. launchd passes none of the login shell's environment.
const SERVICE_VARIABLES = [
  'MU_PORT',
  'MU_HOME',
  'MU_DATA_DIR',
  'MU_CONFIG',
  'MU_IRC_HOST',
  'MU_IRC_PORT',
  'MU_IRC_CHANNEL',
];
const PATH_VARIABLES = new Set(['MU_HOME', 'MU_DATA_DIR', 'MU_CONFIG', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']);
const HARNESS_VARIABLES = ['HOME', 'LANG', 'LC_ALL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
// Variables of an agent turn or of the job itself never come from the installing shell.
const REFUSED_VARIABLES = new Set([...TURN_VARIABLES, ...LAUNCHD_VARIABLES]);
// launchd sets these for a job itself, or they describe the installing terminal or npm run; they are not worth listing.
const SESSION_VARIABLES = new Set([
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  '__CF_USER_TEXT_ENCODING',
  'XPC_FLAGS',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_',
  'INIT_CWD',
  'NODE',
  'COLOR',
  'EDITOR',
  'COLORTERM',
  'COMMAND_MODE',
]);
export const BUILT_IN_COMMANDS = ['claude', 'codex', 'pi'];
const READY_TIMEOUT_MS = 30_000;

const usage = `Usage: npm run service:install -- [--label LABEL] [--env NAME,...] [--allow-missing COMMAND,...]
       npm run service:uninstall -- [--label LABEL]

install    writes ~/Library/LaunchAgents/LABEL.plist for this checkout, starts it, and waits until it answers.
           It records node, PATH, HOME and the Mu variables of this shell; --env adds more variable names.
           The job keeps its data in MU_DATA_DIR and reads MU_CONFIG, by default data and config.json in
           MU_HOME (~/.mu). It refuses when claude, codex, pi or a custom adapter command is not on PATH,
           unless --allow-missing names it, when the Mu port is taken, when the IRC broker does not
           answer, or when the checkout still holds the database or the configuration that Mu has moved
           into the home.
uninstall  stops the agent (a clean shutdown) and removes its plist.
Default label: ${DEFAULT_LABEL}. The log is ~/Library/Logs/Mu/LABEL.log.`;

const list = (value) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (character) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[character]};`,
  );

/** @returns {Record<string, string>} */
export function serviceEnvironment(env, { label, log, extra = [], cwd = process.cwd() }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label))
    throw new Error(`Invalid launchd label ${label}: use letters, digits, dots, hyphens and underscores`);
  if (!env.PATH)
    throw new Error(
      'PATH is not set in this shell; install from the login shell whose PATH finds node and the agent CLIs',
    );
  for (const name of extra) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid variable name ${name}`);
    if (REFUSED_VARIABLES.has(name))
      throw new Error(`${name} belongs to an agent turn or to the launchd job; it cannot be recorded`);
    if (env[name] === undefined) throw new Error(`--env names ${name}, which is not set in this shell`);
  }
  // npm run puts each ancestor's node_modules/.bin and its own helpers first on PATH; they belong to that run, not to the service.
  const captured = {
    PATH: env.PATH.split(delimiter)
      .filter((entry) => entry && !/\/node_modules\/\.bin\/?$/.test(entry) && !entry.includes('/@npmcli/run-script/'))
      .join(delimiter),
  };
  for (const name of [...HARNESS_VARIABLES, ...SERVICE_VARIABLES, ...extra]) {
    if (env[name] === undefined) continue;
    // launchd starts the job in the checkout, so a relative path from this shell would point elsewhere.
    captured[name] = PATH_VARIABLES.has(name) ? resolve(cwd, env[name]) : env[name];
  }
  return { ...captured, MU_LAUNCHD_LABEL: label, MU_LAUNCHD_LOG: log, MU_REQUIRE_IRC: '1' };
}

// The names of the installing shell's variables that the job will not have, so the user can decide on --env for each.
export function leftOutVariables(env, environment) {
  return Object.keys(env)
    .filter(
      (name) =>
        !(name in environment) &&
        !REFUSED_VARIABLES.has(name) &&
        !SESSION_VARIABLES.has(name) &&
        !/^(npm_|TERM)/.test(name),
    )
    .sort();
}

export function plist({ label, node, root, environment, log }) {
  const string = (value) => `<string>${escape(value)}</string>`;
  const variables = Object.entries(environment)
    .map(([name, value]) => `      <key>${escape(name)}</key>${string(value)}`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>${string(label)}
    <key>ProgramArguments</key>
    <array>${string(node)}${string(join(root, 'src/server.mjs'))}</array>
    <key>WorkingDirectory</key>${string(root)}
    <key>EnvironmentVariables</key>
    <dict>
${variables}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>ExitTimeOut</key><integer>30</integer>
    <key>StandardOutPath</key>${string(log)}
    <key>StandardErrorPath</key>${string(log)}
  </dict>
</plist>
`;
}

export function findCommand(command, path) {
  const candidates = isAbsolute(command)
    ? [command]
    : path
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Not in this directory. */
    }
  }
  return null;
}

// Every adapter the service may launch must be found on the recorded PATH, unless the user explicitly accepts its absence.
export function missingCommands(config, path, allowMissing = []) {
  const commands = [...BUILT_IN_COMMANDS, ...Object.values(config.adapters || {}).map((adapter) => adapter.command)];
  const unknown = allowMissing.filter((name) => !commands.includes(name));
  if (unknown.length)
    throw new Error(
      `--allow-missing names ${unknown.join(', ')}, which is not an adapter command (${commands.join(', ')})`,
    );
  return [...new Set(commands)].filter((command) => !allowMissing.includes(command) && !findCommand(command, path));
}

// Codex runs each agent command in the user's login shell (`shell -lc`), whose startup files may reset PATH
// and hide programs needed by the agents. Returns the entries of the recorded PATH that such a shell drops.
export function droppedPathEntries(environment, { shell = userInfo().shell, home = homedir() } = {}) {
  const result = spawnSync(shell, ['-lc', 'printf %s "$PATH"'], {
    env: environment,
    cwd: home,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  if (result.error) throw new Error(`Cannot start the login shell ${shell} to check PATH: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`The login shell ${shell} failed to print PATH (exit ${result.status}): ${result.stderr.trim()}`);
  const kept = new Set(result.stdout.split(delimiter));
  return [...new Set(environment.PATH.split(delimiter))].filter((entry) => !kept.has(entry));
}

const reachable = (host, port) =>
  new Promise((resolveReachable) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolveReachable(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolveReachable(false);
    });
    socket.once('error', () => resolveReachable(false));
  });

const launchctl = (...args) => {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}`.trim() };
};

async function logTail(log) {
  try {
    return (await readFile(log, 'utf8')).split('\n').slice(-40).join('\n');
  } catch (error) {
    return `(log unreadable: ${error.message})`;
  }
}

// Versioned package-manager directories can disappear on upgrade. Prefer the stable opt path when it resolves
// to the same executable that runs the installer.
export function stableNodePath(execPath) {
  const parts = execPath.split(sep);
  const cellar = parts.lastIndexOf('Cellar');
  if (cellar < 1 || parts.length !== cellar + 5 || parts[cellar + 3] !== 'bin') return execPath;
  const stable = [...parts.slice(0, cellar), 'opt', parts[cellar + 1], 'bin', parts[cellar + 4]].join(sep);
  try {
    return realpathSync(stable) === realpathSync(execPath) ? stable : execPath;
  } catch {
    return execPath;
  }
}

export function paths({ label, home = homedir(), uid = process.getuid() }) {
  return {
    plistFile: join(home, 'Library/LaunchAgents', `${label}.plist`),
    log: join(home, 'Library/Logs/Mu', `${label}.log`),
    domain: `gui/${uid}`,
    target: `gui/${uid}/${label}`,
  };
}

export async function install({
  label = DEFAULT_LABEL,
  extra = [],
  allowMissing = [],
  env = process.env,
  root = ROOT,
  node = stableNodePath(process.execPath),
  run = launchctl,
  home = undefined,
  uid = undefined,
  shell = userInfo().shell,
} = {}) {
  if (process.platform !== 'darwin') throw new Error('launchd agents exist only on macOS');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) throw new Error(`Mu needs Node.js 24 or newer; ${node} is ${process.versions.node}`);
  const { plistFile, log, domain, target } = paths({ label, home, uid });
  const environment = serviceEnvironment(env, { label, log, extra });
  // The job resolves its places from the recorded environment, so the installer does the same.
  const muHome = resolveHome(environment, home ?? homedir());
  const leftover = await leftoverError({ root, env: environment, home: muHome });
  if (leftover) throw new Error(leftover);
  const config = await loadConfig(resolveConfigFile(environment, muHome), {
    required: environment.MU_CONFIG !== undefined,
  });
  const missing = missingCommands(config, environment.PATH, allowMissing);
  if (missing.length)
    throw new Error(
      `Not found on PATH: ${missing.join(', ')}. Install them, extend PATH, or pass --allow-missing ${missing.join(',')} to install without them; agents of that adapter then fail to start.`,
    );
  const dropped = droppedPathEntries(environment, { shell, home: home ?? homedir() });
  if (dropped.length)
    throw new Error(
      `Your login shell ${shell}, started with the environment to record, drops these PATH entries: ${dropped.join(delimiter)}. Codex runs agent commands in that shell, so they would not find the programs there, such as node for the Mu helper. Record a startup variable that preserves the environment with --env, or change the startup file so that it extends PATH instead of replacing it.`,
    );
  if (run('print', target).code === 0)
    throw new Error(
      `launchd already has ${target}; run npm run service:uninstall${label === DEFAULT_LABEL ? '' : ` -- --label ${label}`} first`,
    );
  const port = Number(environment.MU_PORT || 4310),
    ircHost = environment.MU_IRC_HOST || '127.0.0.1',
    ircPort = Number(environment.MU_IRC_PORT || 6667);
  if (await reachable('127.0.0.1', port))
    throw new Error(`Port ${port} is taken, probably by a Mu instance started by hand; stop it first, or set MU_PORT`);
  if (!(await reachable(ircHost, ircPort)))
    throw new Error(`No IRC broker answers on ${ircHost}:${ircPort}; start it with npm run chat:up`);
  // The log holds the service's output, so only the user reads it.
  await mkdir(join(log, '..'), { recursive: true, mode: 0o700 });
  await (await open(log, 'a', 0o600)).close();
  await chmod(log, 0o600);
  await mkdir(join(plistFile, '..'), { recursive: true });
  await writeFile(plistFile, plist({ label, node, root, environment, log }), { mode: 0o600 });
  await chmod(plistFile, 0o600);
  const loaded = run('bootstrap', domain, plistFile);
  if (loaded.code !== 0)
    throw new Error(`launchctl bootstrap ${domain} ${plistFile} failed (${loaded.code}): ${loaded.output}`);
  const dataDir = resolveDataDir(environment, muHome);
  const end = Date.now() + READY_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < end) {
    try {
      const token = (await readFile(join(dataDir, 'user-token'), 'utf8')).trim();
      const response = await fetch(`http://127.0.0.1:${port}/api/service`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      const service = await response.json();
      if (response.ok && service.launchd?.label === label)
        return { label, plistFile, log, environment, service, extra, leftOut: leftOutVariables(env, environment) };
      lastError = `HTTP ${response.status}: ${JSON.stringify(service).slice(0, 300)}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(
    `${target} is installed, but Mu did not answer as that job on port ${port} within ${READY_TIMEOUT_MS / 1000} seconds (${lastError}). launchd keeps restarting it; remove it with npm run service:uninstall. End of ${log}:\n${await logTail(log)}`,
  );
}

export async function uninstall({ label = DEFAULT_LABEL, run = launchctl, home = undefined, uid = undefined } = {}) {
  if (process.platform !== 'darwin') throw new Error('launchd agents exist only on macOS');
  const { plistFile, target } = paths({ label, home, uid });
  const loaded = run('print', target).code === 0;
  const present = await stat(plistFile).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  if (!loaded && !present)
    throw new Error(`${target} is not installed: launchd does not know it and ${plistFile} does not exist`);
  if (loaded) {
    const removed = run('bootout', target);
    if (removed.code !== 0) throw new Error(`launchctl bootout ${target} failed (${removed.code}): ${removed.output}`);
  }
  if (present) await rm(plistFile);
  return { label, plistFile, stopped: loaded };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const { values } = parseArgs({
      args,
      options: {
        label: { type: 'string' },
        env: { type: 'string' },
        'allow-missing': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help || !['install', 'uninstall'].includes(command)) {
      console.log(usage);
      process.exit(values.help ? 0 : 1);
    }
    if (command === 'install') {
      const result = await install({
        label: values.label,
        extra: list(values.env),
        allowMissing: list(values['allow-missing']),
      });
      // Values named with --env may be secrets, so only their names are shown.
      const recorded = Object.entries(result.environment)
        .map(([name, value]) => `  ${name}${result.extra.includes(name) ? ' (value not shown)' : `=${value}`}`)
        .join('\n');
      console.log(
        `Mu runs as launchd agent ${result.label}, process ${result.service.pid}.\nPlist: ${result.plistFile}\nLog: ${result.log}\nRecorded environment:\n${recorded}\nNot recorded from this shell; the agent CLIs get none of them unless you install again with --env NAME,...:\n  ${result.leftOut.join(', ') || '(none)'}\nPrint the dashboard sign-in link with: node src/cli.mjs dashboard`,
      );
    } else {
      if (values.env || values['allow-missing']) throw new Error('uninstall takes only --label');
      const result = await uninstall({ label: values.label });
      console.log(
        `Removed launchd agent ${result.label}${result.stopped ? ' after a clean shutdown' : ''}. Start Mu by hand with npm start, or install the agent again.`,
      );
    }
  } catch (error) {
    console.error(`mu service: ${error.message}`);
    process.exit(1);
  }
}
