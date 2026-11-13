import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sandboxedRun } from './isolation.mjs';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_PORT = 6667;

// The reason to skip a test that needs a broker, or false. Only a run inside another sandbox is excused: it
// cannot reach the Docker daemon. Anywhere else a missing daemon is an error, so that the integration suite
// cannot pass without having run.
function brokerUnavailable() {
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) return false;
  if (sandboxedRun)
    return 'this run is inside a sandbox, which cannot reach the Docker daemon that hosts the throwaway IRC broker';
  throw new Error(
    `The integration tests start a throwaway IRC broker and need a running Docker daemon: ${probe.error?.message || probe.stderr.trim()}`,
  );
}
export const brokerSkip = brokerUnavailable();

// Starts a throwaway Ergo with the image and configuration overrides of compose.yaml, with fresh state and
// on a host port that Docker picks, so it never touches the live broker on 6667, which serves the running
// Mu service. The container is removed when the test ends. Returns the host port.
export async function startBroker(t) {
  const config = JSON.parse((await exec('docker', ['compose', 'config', '--format', 'json'], { cwd: ROOT })).stdout)
    .services.irc;
  const environment = Object.entries(config.environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const id = (
    await exec('docker', ['run', '--rm', '-d', '-p', '127.0.0.1::6667', ...environment, config.image])
  ).stdout.trim();
  t.after(() => exec('docker', ['rm', '-f', id]));
  const port = Number((await exec('docker', ['port', id, '6667/tcp'])).stdout.trim().split('\n')[0].split(':').at(-1));
  assert.ok(port > 0 && port !== LIVE_PORT, `the throwaway broker must not use the live broker's port, got ${port}`);
  const end = Date.now() + 15000;
  for (;;) {
    try {
      await exec('docker', ['exec', id, 'nc', '-z', '127.0.0.1', '6667']);
      const logs = await exec('docker', ['logs', id]);
      const overrideErrors = (logs.stdout + logs.stderr)
        .split('\n')
        .filter((line) => line.includes("Couldn't apply config override"));
      assert.deepEqual(overrideErrors, [], 'Ergo must accept every deployed configuration override');
      return port;
    } catch (error) {
      if (error.code !== 1) throw error;
    }
    if (Date.now() > end) throw new Error('Isolated Ergo did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
