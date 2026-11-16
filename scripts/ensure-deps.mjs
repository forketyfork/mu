// node_modules is untracked, so a fresh clone or git worktree has none, and a merge can change the lockfile under an
// existing one; install on demand.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependencyError } from '../src/dependencies.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (await dependencyError(root, { dev: true })) {
  console.error('Dependencies missing or outdated; running npm ci');
  const result = spawnSync('npm', ['ci'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
