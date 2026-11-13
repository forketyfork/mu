// node_modules is untracked, so a fresh clone or git worktree has none; install on demand.
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const installed = join(root, 'node_modules', '.package-lock.json');
const lock = join(root, 'package-lock.json');

const stale = !existsSync(installed) || statSync(installed).mtimeMs < statSync(lock).mtimeMs;
if (stale) {
  console.error('Dependencies missing or outdated; running npm ci');
  const result = spawnSync('npm', ['ci'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
