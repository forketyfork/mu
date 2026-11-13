import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, copyFile, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeHome } from '../src/home.mjs';
import { ROOT } from '../src/server.mjs';

// Agent sockets live in the data directory and a Unix socket path holds about 100 bytes, so a test
// data directory must not depend on how deep the checkout is. The system temporary directory is short.
export async function shortTempDir(t, prefix) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `mu-${prefix}-`)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function temporaryHome(t, prefix = 'home') {
  const directory = await shortTempDir(t, prefix);
  await chmod(directory, 0o700);
  return directory;
}

export async function temporaryMuHome(t, root = ROOT) {
  const home = await temporaryHome(t, 'home');
  if (root !== ROOT) {
    const configExample = join(root, 'mu.config.example.json');
    try {
      await lstat(configExample);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
      await copyFile(join(ROOT, 'mu.config.example.json'), configExample);
    }
  }
  await initializeHome({ home, root });
  return home;
}

// createApp derives its URL from the port, so it cannot take port 0; ask the system for a free one.
// Overlapping test runs get different ports because the system hands out each port only after the
// previous holder released it.
export async function freePort() {
  const server = createServer();
  const port = await listenLocal(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Listens on a free loopback port and returns it.
export async function listenLocal(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return /** @type {import('node:net').AddressInfo} */ (server.address()).port;
}

// Whether this run is inside another sandbox, such as a Codex worker's turn. macOS refuses to apply a sandbox
// inside another one, and such a run cannot reach the Docker daemon either.
function insideSandbox() {
  if (process.platform !== 'darwin') return false;
  const probe = spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8' });
  if (probe.error) throw probe.error;
  if (probe.status === 0) return false;
  if (/sandbox_apply: Operation not permitted/.test(probe.stderr)) return true;
  throw new Error(`sandbox-exec failed (exit ${probe.status}): ${probe.stderr.trim()}`);
}
export const sandboxedRun = insideSandbox();

// The reason to skip a test that starts a Seatbelt sandbox, or false.
function seatbeltUnavailable() {
  if (process.platform !== 'darwin') return 'Seatbelt exists only on macOS';
  return sandboxedRun ? 'this run is inside a sandbox, and Seatbelt cannot apply a sandbox inside another' : false;
}
export const seatbeltSkip = seatbeltUnavailable();

// Stands in for privateUserPaths() in tests that are not about that list. The real list resolves the
// user's home directory, whose agent CLI state a sandboxed run, such as a Codex worker's, may not read.
export const FAKE_PRIVATE_PATHS = ['/nonexistent-home/.claude', '/nonexistent-home/.codex'];

// Stands in for the Mu home in sandbox tests that are not about the home: a path that holds nothing.
export const FAKE_MU_HOME = '/nonexistent-mu-home';
