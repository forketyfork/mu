import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// launchd restarts the job after an unsuccessful exit (KeepAlive.SuccessfulExit = false), so a restart is a clean
// shutdown that exits with this code. 75 is EX_TEMPFAIL.
export const RESTART_EXIT_CODE = 75;
// Written by the instance that restarts, read and removed by the next one, which reports the restart in chat.
export const RESTART_FILE = 'restart.json';
// The whole start check, from the snapshot to the clean exit, fits in this limit, and the restart command waits longer.
export const START_CHECK_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_CHARS = 4000;
// The variables that make a process the launchd job. Only the service itself may have them: a turn's own Mu instance
// or test run would otherwise refuse to start, or exit without a broker.
export const LAUNCHD_VARIABLES = ['MU_LAUNCHD_LABEL', 'MU_LAUNCHD_LOG', 'MU_REQUIRE_IRC', 'XPC_SERVICE_NAME'];
// A start check also runs without the variables of an agent turn, which would make it act as that agent.
export const TURN_VARIABLES = [
  'MU_TOKEN',
  'MU_TOKEN_FILE',
  'MU_URL',
  'MU_AGENT_ID',
  'MU_LEAD_ID',
  'MU_ROLE',
  'MU_CLI',
  'MU_CONVERSATION_ID',
  'MU_MESSAGE_ID',
  'MU_SESSION_ID',
  'MU_PROMPT',
];
export const withoutVariables = (env, names) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));

// The plist names the job in MU_LAUNCHD_LABEL. launchd itself names the job it started in XPC_SERVICE_NAME and is
// its parent, so a process that merely inherited the variable is not taken for the job: exiting it would not start it again.
export function launchdJob(env = process.env, parentPid = process.ppid) {
  const label = env.MU_LAUNCHD_LABEL;
  if (!label) return null;
  if (env.XPC_SERVICE_NAME !== label || parentPid !== 1)
    throw new Error(
      `MU_LAUNCHD_LABEL is ${label}, but launchd did not start this process as that job (XPC_SERVICE_NAME=${env.XPC_SERVICE_NAME ?? 'unset'}, parent ${parentPid}). Unset MU_LAUNCHD_LABEL to run Mu by hand.`,
    );
  return { label, log: env.MU_LAUNCHD_LOG || null };
}

// What a new start reads: the service source, the dependency manifests and the configuration file. Skills and public
// files are read on use, so they are not part of it.
/** @param {string} root @param {{configFile: string}} options */
export async function codeDigest(root, { configFile }) {
  if (!configFile) throw new Error('The code digest needs the configuration file that the service loads');
  const hash = createHash('sha256');
  const files = async (directory) =>
    (await readdir(join(root, directory), { withFileTypes: true, recursive: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1));
  for (const file of [
    ...(await files('src')).sort().map((file) => join(root, file)),
    join(root, 'package.json'),
    join(root, 'package-lock.json'),
    configFile,
  ]) {
    hash.update(`${file}\0`);
    try {
      hash.update(await readFile(file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('\0missing');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

// What the service reports about its code: the digest and the git HEAD of the checkout, taken at start and taken again
// on request. A problem reading either is part of the snapshot, so that nothing is silently assumed.
/** @param {string} root @param {{configFile: string}} options */
export async function codeSnapshot(root, { configFile }) {
  const snapshot = { digest: null, head: null };
  try {
    snapshot.digest = await codeDigest(root, { configFile });
  } catch (error) {
    snapshot.digestError = `Cannot read the code of ${root}: ${error.message}`;
  }
  try {
    snapshot.head = (await promisify(execFile)('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim();
  } catch (error) {
    snapshot.headError = `Cannot read the git HEAD of ${root}: ${(error.stderr || error.message).trim()}`;
  }
  return snapshot;
}

const short = (head) => head?.slice(0, 9) ?? 'unknown';

// The digest decides: it is what a start would read, so uncommitted edits and a changed configuration count, and a
// commit that changes no loaded file does not. The HEAD only tells the reader which commits are involved.
export function codeState(loaded, checkout) {
  const problems = [
    loaded.digestError && `at start: ${loaded.digestError}`,
    checkout.digestError && `now: ${checkout.digestError}`,
  ].filter(Boolean);
  const heads = [
    loaded.headError && `at start: ${loaded.headError}`,
    checkout.headError && `now: ${checkout.headError}`,
  ].filter(Boolean);
  let state, message;
  if (problems.length)
    [state, message] = ['unknown', `Whether Mu runs the checkout's code cannot be told. ${problems.join(' ')}`];
  else if (loaded.digest === checkout.digest)
    [state, message] = ['current', 'Mu runs the code that the checkout holds now.'];
  else {
    state = 'stale';
    const detail =
      loaded.head && checkout.head
        ? loaded.head === checkout.head
          ? `The checkout is still at ${short(loaded.head)}, so uncommitted changes or the configuration file differ from what Mu loaded.`
          : `Mu loaded ${short(loaded.head)}; the checkout is at ${short(checkout.head)}.`
        : 'The git HEAD is not known, so the difference cannot be placed.';
    message = `Mu runs old code: the source, the dependency manifests or the configuration file changed since it started. ${detail} Restart Mu to load the checkout.`;
  }
  if (heads.length) message += ` ${heads.join(' ')}`;
  return { state, message, loaded, checkout };
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const tail = (text) => (text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text);

// Starts the checkout's code on its own port, with a snapshot of the database in a temporary data directory and an
// IRC port where no broker listens, so it starts no agent turn and takes no nickname of the live service. It passes
// when the new process announces readiness, answers an authenticated request as itself, and shuts down cleanly.
export async function startCheck({
  root,
  home,
  store,
  dataDir,
  env = process.env,
  timeoutMs = START_CHECK_TIMEOUT_MS,
}) {
  if (!home) throw new Error('The start check needs the initialized Mu home');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mu-check-')));
  const end = Date.now() + timeoutMs;
  const remaining = () => Math.max(end - Date.now(), 0);
  let child = null,
    output = '';
  const fail = (stage) =>
    new Error(
      `The start check of ${root} failed while ${stage}; Mu keeps running the code of its last start.${output.trim() ? `\nOutput of the checked process:\n${tail(output.trim())}` : ''}`,
    );
  try {
    // VACUUM INTO writes a consistent copy while the service keeps the database open; startup migrations run on it.
    store.db.exec(`VACUUM INTO '${join(directory, 'mu.sqlite').replaceAll("'", "''")}'`);
    try {
      await copyFile(join(dataDir, 'litellm-prices.json'), join(directory, 'litellm-prices.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const [port, ircPort] = [await freePort(), await freePort()];
    const childEnv = {
      ...withoutVariables(env, [...LAUNCHD_VARIABLES, ...TURN_VARIABLES]),
      MU_HOME: home,
      MU_PORT: String(port),
      MU_DATA_DIR: directory,
      MU_IRC_HOST: '127.0.0.1',
      MU_IRC_PORT: String(ircPort),
    };
    child = spawn(process.execPath, [join(root, 'src/server.mjs')], {
      cwd: root,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let announced;
    const ready = new Promise((resolve) => {
      announced = resolve;
    });
    child.stdout.on('data', (data) => {
      output = (output + data).slice(-64 * 1024);
      if (output.includes('Mu dashboard:')) announced();
    });
    child.stderr.on('data', (data) => {
      output = (output + data).slice(-64 * 1024);
    });
    const deadline = (ms) => new Promise((resolve) => setTimeout(resolve, ms, 'timeout').unref());
    const started = await Promise.race([ready.then(() => 'ready'), exited.then(() => 'exited'), deadline(remaining())]);
    if (started === 'exited') {
      const { code, signal } = await exited;
      throw fail(`starting: it exited ${code ?? signal} before it announced readiness`);
    }
    if (started === 'timeout')
      throw fail(`starting: it announced no readiness within the ${timeoutMs / 1000}-second limit of the check`);
    const token = (await readFile(join(directory, 'user-token'), 'utf8')).trim();
    let answer;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/service`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.max(Math.min(5000, remaining()), 1)),
      });
      answer = { status: response.status, body: await response.json() };
    } catch (error) {
      throw fail(`requesting its service state: ${error.message}`);
    }
    if (answer.status !== 200 || answer.body.pid !== child.pid)
      throw fail(`requesting its service state: HTTP ${answer.status} ${JSON.stringify(answer.body).slice(0, 500)}`);
    child.kill('SIGTERM');
    const stopped = await Promise.race([exited, deadline(remaining())]);
    if (stopped === 'timeout')
      throw fail(
        `shutting down: it did not exit after SIGTERM within the ${timeoutMs / 1000}-second limit of the check`,
      );
    if (stopped.code !== 0) throw fail(`shutting down: it exited ${stopped.code ?? stopped.signal} after SIGTERM`);
    child = null;
    return { checkedAt: new Date().toISOString() };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}

export async function readRestartRecord(dataDir) {
  try {
    return JSON.parse(await readFile(join(dataDir, RESTART_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read the restart record ${join(dataDir, RESTART_FILE)}: ${error.message}`, {
      cause: error,
    });
  }
}
export const writeRestartRecord = (dataDir, record) =>
  writeFile(join(dataDir, RESTART_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
export const removeRestartRecord = (dataDir) => unlink(join(dataDir, RESTART_FILE));
