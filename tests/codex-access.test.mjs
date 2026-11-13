import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { codexPermissions } from '../src/adapters.mjs';
import { AgentSockets } from '../src/identity.mjs';
import { Runner } from '../src/runner.mjs';
import { ROOT, loadConfig } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { testIdentity } from './identity-fixture.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { GIT_COMMON_WRITABLE, codexAccess } from '../src/sandbox.mjs';
import { seatbeltSkip, shortTempDir, FAKE_PRIVATE_PATHS, FAKE_MU_HOME, temporaryMuHome } from './isolation.mjs';

const run = promisify(execFile);
// A test may run inside a git hook, whose GIT_DIR and GIT_INDEX_FILE would point git at Mu's own repository.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
// The lab never signs: the user's global configuration signs commits with a key that only an unlocked agent holds, and
// these tests check what the sandbox lets git write, not whether a signing agent answers.
const git = (cwd, ...args) =>
  run(
    'git',
    ['-c', 'user.name=Mu Test', '-c', 'user.email=mu@example.test', '-c', 'commit.gpgsign=false', '-C', cwd, ...args],
    { env },
  );

// A main checkout with a remote, a linked worktree in a writable root and one outside it, and a clone
// and nested repositories in the root.
// The lab lies outside the temporary directories, which Codex opens to writes anyway, so a write that
// succeeds in a sandboxed step shows that the profile grants it.
async function lab(t) {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.tmp/codex-access-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [origin, repo, root, dataDir] = ['origin.git', 'repo', 'worktrees', 'data'].map((name) =>
    join(directory, name),
  );
  await git(directory, 'init', '-q', '--bare', '-b', 'main', origin);
  await git(directory, 'clone', '-q', origin, repo);
  // The sandboxed steps run plain git in this repository and its linked worktrees, which share this configuration.
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(repo, 'push', '-q', 'origin', 'HEAD:main');
  await mkdir(root);
  await git(repo, 'worktree', 'add', '-q', '--no-track', '-b', 'existing', join(root, 'existing'), 'origin/main');
  await git(
    repo,
    'worktree',
    'add',
    '-q',
    '--no-track',
    '-b',
    'elsewhere',
    join(directory, 'elsewhere'),
    'origin/main',
  );
  await git(directory, 'clone', '-q', origin, join(root, 'clone'));
  for (const nested of [join(root, 'parent/nested'), join(root, 'a/b/c/deep'), join(repo, 'vendor/inner')]) {
    await mkdir(nested, { recursive: true });
    await git(nested, 'init', '-q');
  }
  await mkdir(join(dataDir, 'credentials'), { recursive: true });
  await writeFile(join(dataDir, 'credentials', 'worker'), 'own');
  return { directory, origin, repo, root, dataDir, credentialFile: join(dataDir, 'credentials', 'worker') };
}

test('a later Codex entry for the same path replaces an earlier one, so deny and the own credential win', () => {
  const [, , , profile] = codexPermissions({
    dataDir: '/data',
    credentialFile: '/data/credentials/worker',
    privatePaths: ['/home/.codex'],
    writable: ['/work', '/data', '/home/.codex'],
    readOnly: ['/work/.git/config', '/data/credentials/worker'],
  });
  assert.equal(
    profile,
    'permissions.mu-agent={extends=":workspace", filesystem={"/work"="write", "/data"="deny", "/home/.codex"="deny", "/work/.git/config"="read", "/data/credentials/worker"="read"}, network={enabled=true}}',
  );
});

test('the repository of a Codex agent gets the git entries for fetching, worktrees and linked commits, but not its hooks, configuration or the pointers of worktrees outside the writable roots', async (t) => {
  const { directory, repo, root, dataDir } = await lab(t);
  const access = codexAccess({
    cwd: repo,
    writableRoots: [root],
    dataDir,
    home: FAKE_MU_HOME,
    role: 'worker',
    privatePaths: [],
  });
  const common = join(repo, '.git');
  assert.deepEqual(access.writable, [root, ...GIT_COMMON_WRITABLE.map((name) => join(common, name))]);
  for (const path of [
    join(common, 'hooks'),
    join(common, 'config'),
    join(common, 'modules'),
    join(common, 'worktrees/elsewhere/commondir'),
    join(common, 'worktrees/elsewhere/config.worktree'),
    join(common, 'worktrees/elsewhere/gitdir'),
    join(repo, '.claude'),
    join(repo, '.git'),
    join(root, '.git'),
    join(root, '.claude'),
    join(repo, 'vendor/inner/.git'),
  ])
    assert.ok(access.readOnly.includes(path), path);
  // A worktree inside a writable root is writable, its .git file included, so its pointers are not listed either.
  for (const path of [
    join(common, 'worktrees/existing/commondir'),
    join(root, 'existing/.git'),
    join(root, 'existing/.claude'),
    join(root, 'clone/.git'),
    join(root, 'parent/nested/.git'),
  ])
    assert.ok(!access.readOnly.includes(path), path);
  assert.ok(
    !access.writable.includes(common) && !access.writable.includes(join(common, 'index')),
    'the git directory entry and the main index stay read-only',
  );
  assert.ok(
    !access.readOnly.includes(join(directory, 'elsewhere/.git')) &&
      !access.writable.some((path) => path.startsWith(join(directory, 'elsewhere'))),
    'a worktree outside the roots is neither listed nor granted',
  );

  await mkdir(join(root, 'existing', 'sub'));
  const linked = codexAccess({
    cwd: join(root, 'existing', 'sub'),
    writableRoots: [root],
    dataDir,
    home: FAKE_MU_HOME,
    role: 'worker',
    privatePaths: [],
  });
  assert.ok(
    linked.writable.includes(join(common, 'worktrees/existing')),
    'a linked worktree writes its own git directory',
  );
  for (const path of [
    join(common, 'worktrees/existing/commondir'),
    join(common, 'worktrees/existing/gitdir'),
    join(root, 'existing/.git'),
    join(root, 'existing/.claude'),
  ])
    assert.ok(linked.readOnly.includes(path), `its own pointers and its top level's entries stay read-only: ${path}`);

  const plain = await shortTempDir(t, 'codex-plain');
  assert.deepEqual(
    codexAccess({ cwd: plain, dataDir, home: FAKE_MU_HOME, role: 'worker', privatePaths: [] }).writable,
    [],
    'outside a repository, nothing beyond the workspace',
  );
  assert.throws(
    () =>
      codexAccess({
        cwd: repo,
        writableRoots: [join(dataDir, 'credentials')],
        dataDir,
        home: FAKE_MU_HOME,
        role: 'worker',
        privatePaths: [],
      }),
    /writable root .* is inside .*data, which agents may not read/,
  );
  assert.throws(
    () =>
      codexAccess({
        cwd: repo,
        writableRoots: [root],
        dataDir: '/nonexistent-data',
        home: FAKE_MU_HOME,
        role: 'worker',
        privatePaths: [root],
      }),
    /is inside/,
  );
  assert.throws(
    () =>
      codexAccess({
        cwd: repo,
        writableRoots: [join(root, 'missing')],
        dataDir,
        home: FAKE_MU_HOME,
        role: 'worker',
        privatePaths: [],
      }),
    /ENOENT/,
  );
  assert.throws(
    () =>
      codexAccess({
        cwd: repo,
        writableRoots: [root],
        dataDir,
        home: FAKE_MU_HOME,
        role: 'worker',
        privatePaths: [join(root, 'clone/.pi')],
      }),
    /writable root .* contains .*clone\/\.pi; choose a narrower directory/,
  );
});

// Codex builds each command's sandbox in time that grows faster than the number of listed paths: about
// 800 paths, one per worktree directory and pointer, made every command of a worker take 14 s.
test('the profile does not grow with what a writable root holds', async (t) => {
  const { repo, root, dataDir } = await lab(t);
  const before = codexAccess({
    cwd: repo,
    writableRoots: [root],
    dataDir,
    home: FAKE_MU_HOME,
    role: 'worker',
    privatePaths: [],
  });
  for (let index = 0; index < 20; index++) {
    await git(
      repo,
      'worktree',
      'add',
      '-q',
      '--no-track',
      '-b',
      `more-${index}`,
      join(root, `more-${index}`),
      'origin/main',
    );
    await mkdir(join(root, `checkout-${index}/inner`), { recursive: true });
    await git(join(root, `checkout-${index}/inner`), 'init', '-q');
  }
  const after = codexAccess({
    cwd: repo,
    writableRoots: [root],
    dataDir,
    home: FAKE_MU_HOME,
    role: 'worker',
    privatePaths: [],
  });
  assert.deepEqual(after.readOnly, before.readOnly);
  assert.deepEqual(after.writable, before.writable);
});

const codexInstalled = await run('codex', ['--version']).then(
  () => true,
  () => false,
);
const codexSkip = seatbeltSkip || (!codexInstalled && 'codex is not installed');

// Runs each step under the generated profile itself, so the test fails if Codex stops enforcing it.
test(
  "inside the Codex sandbox an agent fetches, creates a worktree in a writable root and commits there, but cannot change its repository's hooks or configuration",
  { skip: codexSkip },
  async (t) => {
    const { directory, repo, root, dataDir, credentialFile } = await lab(t);
    const sandbox = (cwd) => {
      const permissions = codexPermissions({
        dataDir,
        credentialFile,
        privatePaths: [],
        ...codexAccess({ cwd, writableRoots: [root], dataDir, home: FAKE_MU_HOME, role: 'worker', privatePaths: [] }),
      });
      return (script) =>
        run(
          'codex',
          [
            'sandbox',
            ...permissions,
            '--',
            'sh',
            '-c',
            `git config --global --get user.email >/dev/null || export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t; ${script}`,
          ],
          { cwd, env },
        ).then(
          () => 'allowed',
          (error) => (/Operation not permitted/.test(error.stderr) ? 'EPERM' : error.stderr),
        );
    };
    const sandboxed = sandbox(repo);
    const added = join(root, 'added');
    // Outside every writable place of the profile, including the temporary directories that Codex opens.
    await mkdir(join(ROOT, '.tmp'), { recursive: true });
    const outside = await mkdtemp(join(ROOT, '.tmp/codex-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'profile'), 'original');
    assert.deepEqual(
      {
        fetch: await sandboxed('git fetch -q origin'),
        worktree: await sandboxed(`git worktree add -q --no-track -b added ${added} origin/main`),
        commit: await sandboxed(`cd ${added} && echo x > f && git add f && git commit -qm linked`),
        commitInExisting: await sandboxed(`cd ${join(root, 'existing')} && git commit -q --allow-empty -m again`),
        fetchInLinked: await sandboxed(`git -C ${added} fetch -q origin`),
      },
      {
        fetch: 'allowed',
        worktree: 'allowed',
        commit: 'allowed',
        commitInExisting: 'allowed',
        fetchInLinked: 'allowed',
      },
    );
    assert.deepEqual(
      {
        upstream: await sandboxed('git branch -q --set-upstream-to=origin/main main'),
        hook: await sandboxed('echo evil > .git/hooks/pre-commit'),
        config: await sandboxed('git config core.fsmonitor evil'),
        renameGitDirectory: await sandboxed('mv .git .git-moved'),
        commitInMainCheckout: await sandboxed('git commit -q --allow-empty -m main'),
        pointerOutsideRoot: await sandboxed('echo /tmp/evil > .git/worktrees/elsewhere/commondir'),
        worktreeOutsideRoot: await sandboxed(`touch ${join(directory, 'elsewhere/planted')}`),
        claudeSettings: await sandboxed('mkdir .claude'),
        cwdNestedHook: await sandboxed('echo evil > vendor/inner/.git/hooks/pre-commit'),
        symbolicLink: await sandboxed(
          `ln -s ${outside} ${join(root, 'link')} && echo evil >> ${join(root, 'link/profile')}`,
        ),
        credential: await sandboxed(`cat ${credentialFile}`),
        dataDirectory: await sandboxed(`touch ${join(dataDir, 'planted')}`),
        siblingOfRoot: await sandboxed(`touch ${join(root, '..', 'planted')}`),
      },
      {
        upstream: 'EPERM',
        hook: 'EPERM',
        config: 'EPERM',
        renameGitDirectory: 'EPERM',
        commitInMainCheckout: 'EPERM',
        pointerOutsideRoot: 'EPERM',
        worktreeOutsideRoot: 'EPERM',
        claudeSettings: 'EPERM',
        cwdNestedHook: 'EPERM',
        symbolicLink: 'EPERM',
        credential: 'allowed',
        dataDirectory: 'EPERM',
        siblingOfRoot: 'EPERM',
      },
    );
    // Everything in a writable root is writable work, other worktrees and their pointers included.
    assert.deepEqual(
      {
        pointerInsideRoot: await sandboxed('echo /tmp/evil > .git/worktrees/existing/commondir'),
        otherWorktreePointer: await sandboxed(`echo gitdir: /tmp/evil > ${join(root, 'existing/.git')}`),
        cloneHooks: await sandboxed(`echo evil > ${join(root, 'clone/.git/hooks/post-checkout')}`),
      },
      { pointerInsideRoot: 'allowed', otherWorktreePointer: 'allowed', cloneHooks: 'allowed' },
    );
    assert.equal((await git(added, 'log', '-1', '--format=%s')).stdout.trim(), 'linked');
    assert.equal(
      await readFile(join(outside, 'profile'), 'utf8'),
      'original',
      'a link in a writable root leads nowhere writable',
    );

    const inAdded = sandbox(added);
    assert.deepEqual(
      {
        ownPointer: await inAdded('echo gitdir: /tmp/evil > .git'),
        ownCommondir: await inAdded(`echo /tmp/evil > ${join(repo, '.git/worktrees/added/commondir')}`),
        ownCommit: await inAdded('git commit -q --allow-empty -m own'),
      },
      { ownPointer: 'EPERM', ownCommondir: 'EPERM', ownCommit: 'allowed' },
      'an agent in a linked worktree keeps its own pointers',
    );
  },
);

test('codexSandbox in the configuration takes only absolute writable roots', async (t) => {
  const file = join(await shortTempDir(t, 'codex-config'), 'mu.config.json');
  const load = async (config) => {
    await writeFile(file, JSON.stringify(config));
    return loadConfig(file);
  };
  assert.deepEqual((await load({ codexSandbox: { writableRoots: ['/Users/me/dev/worktrees'] } })).codexSandbox, {
    writableRoots: ['/Users/me/dev/worktrees'],
  });
  await assert.rejects(
    load({ codexSandbox: { writableRoots: ['dev/worktrees'] } }),
    /Invalid codexSandbox.writableRoots: expected an array of absolute paths/,
  );
  await assert.rejects(load({ codexSandbox: { writableRoots: '/Users/me' } }), /Invalid codexSandbox.writableRoots/);
  await assert.rejects(load({ codexSandbox: { localPorts: [1] } }), /Invalid codexSandbox: unknown keys localPorts/);
});

test('a Codex turn gets the configured writable roots and the git grants of its repository', async (t) => {
  const { repo, root } = await lab(t);
  const dataDir = await shortTempDir(t, 'codex-runner');
  const sockets = new AgentSockets({ dataDir, handler: (request, response) => response.end() });
  t.after(() => sockets.close());
  const store = new Store();
  t.after(() => store.close());
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  store.createAgent({ id: 'worker', role: 'worker', adapter: 'codex', cwd: repo, task: 'Implement' });
  const chat = { state: { connected: true }, async send() {} };
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    sockets,
    store,
    chat,
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    dataDir,
    pricing: offlinePricing(),
    codexSandbox: { writableRoots: [root] },
    privatePaths: FAKE_PRIVATE_PATHS,
  });
  /** @type {{args: string[]} | undefined} */
  let captured;
  runner.execute = async (command) => {
    captured = command;
    throw new Error('stop after the command is built');
  };
  store.addMessage('implement', 'user', 'Implement the change', 'dm-worker');
  runner.kick();
  const end = Date.now() + 10000;
  while (!captured && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  runner.close();
  const profile = captured.args.find((arg) => arg.startsWith('permissions.mu-agent='));
  for (const entry of [
    `"${root}"="write"`,
    `"${join(repo, '.git/objects')}"="write"`,
    `"${join(repo, '.git/config')}"="read"`,
    `"${join(repo, '.git/hooks')}"="read"`,
    ...FAKE_PRIVATE_PATHS.map((path) => `"${path}"="deny"`),
  ])
    assert.ok(profile.includes(entry), entry);
  assert.ok(
    captured.args.includes('--ignore-rules') && captured.args.includes('approvals_reviewer="auto_review"'),
    "the turn ignores the user's execpolicy rules and has a reviewer for escalations",
  );
});
