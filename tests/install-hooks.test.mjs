import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from '../src/server.mjs';
import { shortTempDir } from './isolation.mjs';

const run = promisify(execFile);
// A test may run inside a git hook, whose GIT_DIR and GIT_INDEX_FILE would point git at Mu's own repository.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

// Runs the hook installer in a scratch repository through a git wrapper that logs every call.
async function installHooks(t, { configured }) {
  const repo = await shortTempDir(t, 'hooks');
  await run('git', ['init', '-q', repo], { env });
  if (configured) await run('git', ['-C', repo, 'config', 'core.hooksPath', '.githooks'], { env });
  await mkdir(join(repo, 'scripts'));
  await copyFile(join(ROOT, 'scripts/install-hooks.mjs'), join(repo, 'scripts/install-hooks.mjs'));
  const bin = await shortTempDir(t, 'hooks-bin'),
    log = join(bin, 'calls');
  const { stdout: realGit } = await run('/usr/bin/which', ['git'], { env });
  await writeFile(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit.trim()}' "$@"\n`);
  await chmod(join(bin, 'git'), 0o755);
  await writeFile(log, '');
  await run(process.execPath, [join(repo, 'scripts/install-hooks.mjs')], {
    env: { ...env, PATH: `${bin}:${env.PATH}` },
  });
  return {
    calls: (await readFile(log, 'utf8')).trim().split('\n'),
    hooksPath: (await run('git', ['-C', repo, 'config', '--get', 'core.hooksPath'], { env })).stdout.trim(),
  };
}

// A sandboxed agent cannot write the git configuration, so npm ci failed in its worktree.
test('the hook installer writes core.hooksPath only when it is not already .githooks', async (t) => {
  assert.deepEqual(await installHooks(t, { configured: true }), {
    calls: ['config --get core.hooksPath'],
    hooksPath: '.githooks',
  });
  assert.deepEqual(await installHooks(t, { configured: false }), {
    calls: ['config --get core.hooksPath', 'config core.hooksPath .githooks'],
    hooksPath: '.githooks',
  });
});
