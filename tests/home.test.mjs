import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { main } from '../src/cli.mjs';
import {
  DEFAULTS,
  homeState,
  initializeHome,
  leftoverError,
  resolveConfigFile,
  resolveDataDir,
  resolveHome,
} from '../src/home.mjs';
import { shortTempDir, temporaryHome } from './isolation.mjs';

async function sourceRoot(t, suffix = 'source') {
  const root = await shortTempDir(t, suffix);
  for (const [index, path] of DEFAULTS.entries()) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `# ${index === 0 ? 'Lead' : 'Worker'}\n\nShared line.\n\nEnd.\n`, { mode: 0o600 });
  }
  const configExample = JSON.parse(await readFile(new URL('../mu.config.example.json', import.meta.url), 'utf8'));
  configExample.pricing.enabled = !configExample.pricing.enabled;
  await writeFile(join(root, 'mu.config.example.json'), `${JSON.stringify(configExample, null, 2)}\n`);
  return root;
}

async function replaceDefault(root, path, text) {
  await writeFile(join(root, path), text);
}

async function backupDirectories(home) {
  return readdir(join(home, '.backup'));
}

test('resolveHome selects ~/.mu or the MU_HOME override', () => {
  assert.equal(resolveHome({}, '/Users/example'), '/Users/example/.mu');
  assert.equal(resolveHome({ HOME: '/Users/other' }, '/Users/example'), '/Users/other/.mu');
  assert.equal(resolveHome({ MU_HOME: '/tmp/mu home' }, '/Users/example'), '/tmp/mu home');
  assert.throws(() => resolveHome({ MU_HOME: '  ' }, '/Users/example'), /must not be empty/);
});

test('dry-run reports a first install without creating the home', async (t) => {
  const home = join(await shortTempDir(t, 'dry-run-parent'), 'new home');
  const root = await sourceRoot(t, 'source');
  const result = await initializeHome({ home, root, dryRun: true });
  assert.equal(result.home, home);
  assert.equal(result.dryRun, true);
  assert.ok(result.actions.some(({ path, action }) => path === DEFAULTS[0] && action === 'install'));
  assert.ok(result.actions.some(({ path, action }) => path === 'projects.md' && action === 'seed'));
  assert.ok(result.actions.some(({ path, action }) => path === 'config.json' && action === 'seed'));
  assert.ok(
    result.actions.some(({ path, action }) => path === '.install/manifest.json' && action === 'write-manifest'),
  );
  await assert.rejects(lstat(home), { code: 'ENOENT' });
});

test('first install creates private role files and seed files at paths with spaces', async (t) => {
  const home = await temporaryHome(t, 'home with spaces');
  const root = await sourceRoot(t, 'source with spaces');
  const first = await initializeHome({ home, root });
  assert.equal(first.actions.filter(({ action }) => action === 'install').length, 2);
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), await readFile(join(root, DEFAULTS[0]), 'utf8'));
  assert.equal(
    await readFile(join(home, 'projects.md'), 'utf8'),
    '# Projects\n\nList the project checkouts and local clones used by this Mu home.\n',
  );
  assert.equal(
    await readFile(join(home, 'memory/lead/MEMORY.md'), 'utf8'),
    '# Lead memory\n\nRecord durable facts here, including the user’s name and preferences, and link to one file per fact.\n',
  );
  const sourceConfig = await readFile(join(root, 'mu.config.example.json'), 'utf8');
  assert.notEqual(sourceConfig, await readFile(new URL('../mu.config.example.json', import.meta.url), 'utf8'));
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), sourceConfig);
  const manifest = JSON.parse(await readFile(join(home, '.install/manifest.json'), 'utf8'));
  assert.equal(Number.isFinite(Date.parse(manifest.installedAt[DEFAULTS[0]])), true);
  assert.equal(Number.isFinite(Date.parse(manifest.installedAt[DEFAULTS[1]])), true);
  for (const path of [
    home,
    join(home, 'skills'),
    join(home, 'skills/team-lead'),
    join(home, 'memory'),
    join(home, 'memory/lead'),
    join(home, '.install'),
    join(home, '.install/base/skills/worker'),
    join(home, '.backup'),
  ]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o700, path);
  }
  for (const path of [
    ...DEFAULTS.map((name) => join(home, name)),
    join(home, 'projects.md'),
    join(home, 'memory/lead/MEMORY.md'),
    join(home, 'config.json'),
    join(home, '.install/manifest.json'),
    ...DEFAULTS.map((name) => join(home, '.install/base', name)),
  ]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o600, path);
  }
  assert.deepEqual(await backupDirectories(home), []);
  assert.equal((await readdir(home)).includes('data'), false);

  const config = '{\n  "pricing": { "enabled": false }\n}\n';
  await writeFile(join(home, 'config.json'), config);
  await chmod(join(home, 'config.json'), 0o644);
  const second = await initializeHome({ home, root });
  assert.ok(second.actions.some(({ path, action }) => path === DEFAULTS[0] && action === 'current'));
  assert.ok(second.actions.some(({ path, action }) => path === 'projects.md' && action === 'keep-seed'));
  assert.ok(second.actions.some(({ path, action }) => path === 'config.json' && action === 'keep-seed'));
  assert.equal(await readFile(join(home, 'config.json'), 'utf8'), config);
  assert.equal((await lstat(join(home, 'config.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await backupDirectories(home), []);
});

test('init leaves an old checkout config in place for the move check', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  await writeFile(join(root, 'mu.config.json'), '{"cliArgs":{"claude":["--from-config"]}}\n');

  const result = await initializeHome({ home, root });
  assert.ok(!result.actions.some(({ path, action }) => path === 'config.json' && action === 'seed'));
  await assert.rejects(readFile(join(home, 'config.json')), { code: 'ENOENT' });
  assert.match(await leftoverError({ home, root, env: {} }), /still holds the configuration/);
});

test('dry-run reports a conflicting merge without changing home files', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  const base = 'first\nshared\nlast\n';
  await replaceDefault(root, DEFAULTS[0], base);
  await initializeHome({ home, root });
  const local = 'first\nuser version\nlast\n';
  await writeFile(join(home, DEFAULTS[0]), local);
  await replaceDefault(root, DEFAULTS[0], 'first\nShipped version\nlast\n');
  const manifest = await readFile(join(home, '.install/manifest.json'), 'utf8');

  await assert.rejects(initializeHome({ home, root, dryRun: true }), /conflicts; no files were changed/);
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), local);
  assert.equal(await readFile(join(home, '.install/manifest.json'), 'utf8'), manifest);
  assert.deepEqual(await backupDirectories(home), []);
});

test('an existing unmanaged role file and seed are kept without starting management', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  await mkdir(join(home, 'skills/team-lead'), { recursive: true, mode: 0o700 });
  await writeFile(join(home, DEFAULTS[0]), 'user-owned role file\n', { mode: 0o600 });
  await writeFile(join(home, 'projects.md'), 'user project map\n', { mode: 0o600 });

  await initializeHome({ home, root });
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), 'user-owned role file\n');
  assert.equal(await readFile(join(home, 'projects.md'), 'utf8'), 'user project map\n');
  const manifest = JSON.parse(await readFile(join(home, '.install/manifest.json'), 'utf8'));
  assert.equal(manifest.files[DEFAULTS[0]], undefined);

  await replaceDefault(root, DEFAULTS[0], 'Changed shipped default\n');
  await initializeHome({ home, root });
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), 'user-owned role file\n');
});

test('existing home files become private, and dry-run only reports the mode change', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  await initializeHome({ home, root });
  await chmod(join(home, 'projects.md'), 0o644);

  const preview = await initializeHome({ home, root, dryRun: true });
  assert.ok(preview.actions.some(({ path, action }) => path === 'projects.md' && action === 'restrict-file-mode'));
  assert.equal((await lstat(join(home, 'projects.md'))).mode & 0o777, 0o644);
  await initializeHome({ home, root });
  assert.equal((await lstat(join(home, 'projects.md'))).mode & 0o777, 0o600);
});

test('an unedited default upgrades and keeps a private backup', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  const original = await readFile(join(root, DEFAULTS[0]), 'utf8');
  await initializeHome({ home, root });
  const updated = `${original}\nNew shipped guidance.\n`;
  await replaceDefault(root, DEFAULTS[0], updated);

  const result = await initializeHome({ home, root });
  assert.ok(result.actions.some(({ path, action }) => path === DEFAULTS[0] && action === 'replace'));
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), updated);
  const backups = await backupDirectories(home);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(home, '.backup', backups[0], DEFAULTS[0]), 'utf8'), original);
  assert.equal((await lstat(join(home, '.backup', backups[0], DEFAULTS[0]))).mode & 0o777, 0o600);
});

test('homeState reports current, edited, outdated and conflicting defaults without writing', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  const before = await homeState({ home, root });
  assert.equal(before.initialized, false);
  assert.equal(before.defaults[0].state, 'missing');
  await initializeHome({ home, root });

  const current = await homeState({ home, root });
  assert.equal(current.defaults[0].state, 'current');
  const original = await readFile(join(root, DEFAULTS[0]), 'utf8');
  await replaceDefault(root, DEFAULTS[0], `${original}\nNew shipped addition.\n`);
  assert.equal((await homeState({ home, root })).defaults[0].state, 'outdated');
  const updated = await readFile(join(root, DEFAULTS[0]), 'utf8');
  await writeFile(join(home, DEFAULTS[0]), updated.replace('# Lead', '# user lead'));
  assert.equal((await homeState({ home, root })).defaults[0].state, 'mergeable');
  await initializeHome({ home, root });
  const merged = await readFile(join(home, DEFAULTS[0]), 'utf8');
  assert.match(merged, /# user lead/);
  assert.match(merged, /New shipped addition\./);
  await writeFile(join(home, DEFAULTS[0]), merged.replace('Shared line.', 'user version.'));
  assert.equal((await homeState({ home, root })).defaults[0].state, 'edited');
  await replaceDefault(root, DEFAULTS[0], updated.replace('Shared line.', 'Shipped version.'));
  const backups = await backupDirectories(home);
  assert.equal((await homeState({ home, root })).defaults[0].state, 'conflict');
  assert.deepEqual(await backupDirectories(home), backups);
});

test('a local edit is kept while the shipped default is unchanged', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  await initializeHome({ home, root });
  const edit = 'user edit\n';
  await writeFile(join(home, DEFAULTS[0]), edit);

  const result = await initializeHome({ home, root });
  assert.ok(result.actions.some(({ path, action }) => path === DEFAULTS[0] && action === 'keep-edit'));
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), edit);
  assert.deepEqual(await backupDirectories(home), []);
});

test('a clean three-way merge keeps both the local edit and the shipped update', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  const base = 'first\nshared\nlast\n';
  await replaceDefault(root, DEFAULTS[0], base);
  await initializeHome({ home, root });
  const local = 'user first\nshared\nlast\n';
  const updated = 'first\nshared\nshipped last\n';
  await writeFile(join(home, DEFAULTS[0]), local);
  await replaceDefault(root, DEFAULTS[0], updated);

  const result = await initializeHome({ home, root });
  assert.ok(result.actions.some(({ path, action }) => path === DEFAULTS[0] && action === 'merge'));
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), 'user first\nshared\nshipped last\n');
  const backups = await backupDirectories(home);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(home, '.backup', backups[0], DEFAULTS[0]), 'utf8'), local);
});

test('a merge conflict leaves the live file, manifest, and backup tree unchanged', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  const base = 'first\nshared\nlast\n';
  await replaceDefault(root, DEFAULTS[0], base);
  await initializeHome({ home, root });
  const local = 'first\nuser version\nlast\n';
  await writeFile(join(home, DEFAULTS[0]), local);
  await replaceDefault(root, DEFAULTS[0], 'first\nShipped version\nlast\n');
  const manifest = await readFile(join(home, '.install/manifest.json'), 'utf8');

  await assert.rejects(initializeHome({ home, root }), /conflicts; no files were changed[\s\S]*init --accept/);
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), local);
  assert.equal(await readFile(join(home, '.install/manifest.json'), 'utf8'), manifest);
  assert.deepEqual(await backupDirectories(home), []);
});

test('--accept records the shipped version as the merge base and preserves the resolved file', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  const base = 'first\nshared\nlast\n';
  await replaceDefault(root, DEFAULTS[0], base);
  await initializeHome({ home, root });
  await writeFile(join(home, DEFAULTS[0]), 'first\nuser resolution\nlast\n');
  const updated = 'first\nShipped version\nlast\n';
  await replaceDefault(root, DEFAULTS[0], updated);
  await assert.rejects(initializeHome({ home, root }), /conflicts/);

  const result = await initializeHome({ home, root, accept: DEFAULTS[0] });
  assert.ok(result.actions.some(({ path, action }) => path === DEFAULTS[0] && action === 'accept-current-edit'));
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), 'first\nuser resolution\nlast\n');
  assert.equal(await readFile(join(home, `.install/base/${DEFAULTS[0]}`), 'utf8'), updated);
  await initializeHome({ home, root });
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), 'first\nuser resolution\nlast\n');
});

test('--accept accepts only a shipped role file and requires it to exist', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  await assert.rejects(initializeHome({ home, root, accept: '../projects.md' }), /must name a shipped role file/);
  await assert.rejects(initializeHome({ home, root, accept: DEFAULTS[0] }), /Cannot accept missing/);
});

test('another checkout is refused until --adopt, which updates the manifest source', async (t) => {
  const home = await temporaryHome(t);
  const firstRoot = await sourceRoot(t, 'first checkout');
  const secondRoot = await sourceRoot(t, 'second checkout');
  await initializeHome({ home, root: firstRoot });
  const original = await readFile(join(home, DEFAULTS[0]), 'utf8');
  const adoptedDefault = 'Adopted checkout default\n';
  await replaceDefault(secondRoot, DEFAULTS[0], adoptedDefault);

  await assert.rejects(initializeHome({ home, root: secondRoot }), /not .*rerun with --adopt/);
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), original);
  await initializeHome({ home, root: secondRoot, adopt: true });
  const manifest = JSON.parse(await readFile(join(home, '.install/manifest.json'), 'utf8'));
  assert.equal(manifest.sourceCheckout, secondRoot);
  assert.equal(await readFile(join(home, DEFAULTS[0]), 'utf8'), adoptedDefault);
});

test('the data directory and the configuration default to the home, and MU_DATA_DIR and MU_CONFIG override them', () => {
  assert.equal(resolveDataDir({ HOME: '/Users/me' }), '/Users/me/.mu/data');
  assert.equal(resolveConfigFile({ HOME: '/Users/me' }), '/Users/me/.mu/config.json');
  assert.equal(resolveDataDir({ MU_HOME: '/srv/mu' }), '/srv/mu/data');
  assert.equal(resolveConfigFile({ MU_HOME: '/srv/mu' }), '/srv/mu/config.json');
  const env = { HOME: '/Users/me', MU_DATA_DIR: '/var/mu', MU_CONFIG: '/etc/mu.json' };
  assert.equal(resolveDataDir(env), '/var/mu');
  assert.equal(resolveConfigFile(env), '/etc/mu.json');
  assert.throws(() => resolveDataDir({ MU_DATA_DIR: ' ' }), /MU_DATA_DIR must not be empty/);
  assert.throws(() => resolveConfigFile({ MU_CONFIG: '' }), /MU_CONFIG must not be empty/);
});

test('MU_HOME cannot overlap the checkout, and the data directory lies beside the entries of the home', async (t) => {
  const root = await sourceRoot(t);
  const homeInsideCheckout = join(root, '.mu');
  await assert.rejects(initializeHome({ home: homeInsideCheckout, root }), /must be separate from the Mu checkout/);

  const home = await temporaryHome(t);
  await assert.rejects(initializeHome({ home, root, env: { MU_DATA_DIR: home } }), /must not hold the Mu home/);
  await assert.rejects(
    initializeHome({ home, root, env: { MU_DATA_DIR: dirname(home) } }),
    /must not hold the Mu home/,
  );
  for (const entry of ['skills', 'memory/lead/data', 'config.json', '.install'])
    await assert.rejects(
      initializeHome({ home, root, env: { MU_DATA_DIR: join(home, entry) } }),
      new RegExp(`overlaps ${join(home, entry.split('/')[0])}, which belongs to the Mu home`),
    );
  await assert.rejects(lstat(join(home, '.install')), { code: 'ENOENT' });

  // The default places it in the home; an override may place it anywhere else.
  await initializeHome({ home, root, env: {} });
  await initializeHome({ home, root, env: { MU_DATA_DIR: join(home, 'state') } });
  await initializeHome({ home, root, env: { MU_DATA_DIR: await shortTempDir(t, 'data') } });
  assert.equal((await homeState({ home, root, env: {} })).initialized, true);
});

// A checkout from before the move, with the files that the move takes into the home.
async function oldCheckout(t, { database = true, config = true } = {}) {
  const root = await shortTempDir(t, "it's old");
  if (database) {
    await mkdir(join(root, '.mu'));
    await writeFile(join(root, '.mu/mu.sqlite'), '');
  }
  if (config) await writeFile(join(root, 'mu.config.json'), '{}');
  return { root, home: await temporaryHome(t) };
}

test('a start on the default places is refused while the checkout still holds the database or the configuration', async (t) => {
  const quoted = (path) => `'${path.replaceAll("'", "'\\''")}'`;
  const both = await oldCheckout(t);
  const message = await leftoverError({ root: both.root, home: both.home, env: {} });
  assert.equal(
    message,
    `Mu keeps its data directory in ${join(both.home, 'data')} and its configuration in ${join(both.home, 'config.json')}, but the checkout still holds the database ${join(both.root, '.mu/mu.sqlite')} and the configuration ${join(both.root, 'mu.config.json')}. Move them with Mu stopped: npm run service:uninstall, then mv ${quoted(join(both.root, '.mu'))} ${quoted(join(both.home, 'data'))}, then mv ${quoted(join(both.root, 'mu.config.json'))} ${quoted(join(both.home, 'config.json'))}, then npm run service:install.`,
  );
  assert.doesNotMatch(message, /\n/, 'one line, which the entry point dates');

  const database = await oldCheckout(t, { config: false });
  assert.match(await leftoverError({ ...database, env: {} }), /still holds the database [^,]*\. Move them/);
  // A data directory that exists without a database would take the moved one inside it.
  await mkdir(join(database.home, 'data'));
  assert.match(
    await leftoverError({ ...database, env: {} }),
    new RegExp(
      `npm run service:uninstall, then inspect and remove ${join(database.home, 'data')}, which exists without a database, then mv`,
    ),
  );

  const config = await oldCheckout(t, { database: false });
  assert.match(await leftoverError({ ...config, env: {} }), /still holds the configuration [^,]*\. Move them/);
});

test('the leftover check passes once the home holds the files, or when MU_DATA_DIR and MU_CONFIG choose the places', async (t) => {
  const moved = await oldCheckout(t);
  await mkdir(join(moved.home, 'data'));
  await writeFile(join(moved.home, 'data/mu.sqlite'), '');
  await writeFile(join(moved.home, 'config.json'), '{}');
  assert.equal(await leftoverError({ ...moved, env: {} }), null);

  const chosen = await oldCheckout(t);
  assert.equal(
    await leftoverError({
      ...chosen,
      env: { MU_DATA_DIR: join(chosen.root, '.mu'), MU_CONFIG: join(chosen.root, 'mu.config.json') },
    }),
    null,
  );
  assert.match(await leftoverError({ ...chosen, env: { MU_DATA_DIR: '/elsewhere' } }), /still holds the configuration/);
  assert.match(await leftoverError({ ...chosen, env: { MU_CONFIG: '/elsewhere.json' } }), /still holds the database/);

  const empty = await shortTempDir(t, 'new-checkout');
  assert.equal(await leftoverError({ root: empty, home: await temporaryHome(t), env: {} }), null);
});

test('MU_HOME cannot overlap the checkout through a symlinked parent', async (t) => {
  const root = await sourceRoot(t);
  const aliasDirectory = await shortTempDir(t, 'alias-parent');
  const aliasParent = join(aliasDirectory, 'checkout-parent');
  await symlink(dirname(root), aliasParent);
  const aliasedCheckout = join(aliasParent, basename(root));

  await assert.rejects(initializeHome({ home: aliasedCheckout, root }), /must be separate/);
  await assert.rejects(lstat(join(root, '.install')), { code: 'ENOENT' });
});

test('MU_HOME cannot overlap the checkout through a case-only alias', async (t) => {
  if (process.platform !== 'darwin') return t.skip('case-only path aliases require a Darwin volume');
  const root = await sourceRoot(t);
  const alias = root.toUpperCase();
  let originalInfo;
  let aliasInfo;
  try {
    [originalInfo, aliasInfo] = await Promise.all([stat(root), stat(alias)]);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    return t.skip('the checkout volume is case-sensitive');
  }
  if (originalInfo.dev !== aliasInfo.dev || originalInfo.ino !== aliasInfo.ino)
    return t.skip('the checkout volume is case-sensitive');

  await assert.rejects(initializeHome({ home: alias, root }), /must be separate/);
  await assert.rejects(lstat(join(root, '.install')), { code: 'ENOENT' });
});

test('init through the CLI works in the user shell without a service credential', async (t) => {
  const home = await temporaryHome(t);
  const preview = await main(['init', '--dry-run'], { MU_HOME: home });
  assert.equal(preview.dryRun, true);
  const initialized = await main(['init'], { MU_HOME: home });
  assert.equal(initialized.home, home);
  await assert.rejects(main(['init', '--unknown'], { MU_HOME: home }), /Unknown option/);
  await assert.doesNotReject(lstat(join(home, '.install')));
});

test('init refuses symlink homes and protected subdirectories', async (t) => {
  const root = await sourceRoot(t);
  const parent = await shortTempDir(t, 'symlink-home');
  const target = await temporaryHome(t, 'symlink-target');
  const linkedHome = join(parent, 'home');
  await symlink(target, linkedHome);
  await assert.rejects(initializeHome({ home: linkedHome, root }), /must not be a symbolic link/);

  for (const name of ['memory', '.install']) {
    const home = await temporaryHome(t, `linked-${name.replace('.', 'dot')}`);
    const outside = await temporaryHome(t, 'outside');
    await symlink(outside, join(home, name));
    await assert.rejects(initializeHome({ home, root }), /must not be a symbolic link/);
    assert.deepEqual(await readdir(outside), []);
  }
});

test('init refuses a symlinked live role file without following its target', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  const outside = await temporaryHome(t, 'outside-file');
  const target = join(outside, 'target.md');
  await writeFile(target, 'outside content\n', { mode: 0o600 });
  await mkdir(join(home, 'skills/team-lead'), { recursive: true, mode: 0o700 });
  await symlink(target, join(home, DEFAULTS[0]));

  await assert.rejects(initializeHome({ home, root }), /must not be a symbolic link/);
  assert.equal(await readFile(target, 'utf8'), 'outside content\n');
  await assert.rejects(lstat(join(home, '.install')), { code: 'ENOENT' });
});

test('init refuses hard-linked home files before changing the external link mode', async (t) => {
  const home = await temporaryHome(t);
  const root = await sourceRoot(t);
  const outside = await temporaryHome(t, 'outside-hard-link');
  const homeFile = join(home, DEFAULTS[0]);
  const outsideFile = join(outside, 'linked.md');
  await initializeHome({ home, root });
  await link(homeFile, outsideFile);
  await chmod(homeFile, 0o644);

  await assert.rejects(initializeHome({ home, root }), /multiple hard links/);
  assert.equal((await lstat(homeFile)).nlink, 2);
  assert.equal((await lstat(outsideFile)).mode & 0o777, 0o644);
});

test('init refuses directories writable by another user', async (t) => {
  const root = await sourceRoot(t);
  for (const name of ['home', 'memory', '.install']) {
    await t.test(name, async (subtest) => {
      const home = await temporaryHome(subtest, `writable-${name.replace('.', 'dot')}`);
      const target = name === 'home' ? home : join(home, name);
      if (name !== 'home') await mkdir(target, { mode: 0o700 });
      await chmod(target, 0o770);
      await assert.rejects(initializeHome({ home, root }), /writable by another user/);
    });
  }
});
