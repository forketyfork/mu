// Points git at the tracked .githooks directory. The setting lives in the repository's shared
// config, so it covers every worktree; a relative path resolves against each worktree's root.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, '.git'))) process.exit(0); // not a checkout, e.g. installed as a package

// A sandboxed agent may not write the git configuration, and in a worktree of a configured repository it need not.
const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
if (current.error) throw current.error;
if (current.status === 0 && current.stdout.trim() === '.githooks') process.exit(0);
if (current.status !== 0 && current.status !== 1) {
  process.stderr.write(current.stderr);
  process.exit(current.status ?? 1);
}
const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
