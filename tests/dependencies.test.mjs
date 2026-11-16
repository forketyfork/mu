import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependencyError } from '../src/dependencies.mjs';
import { ROOT } from '../src/server.mjs';
import { freePort, shortTempDir } from './isolation.mjs';

const scratch = async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mu-deps-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
// A checkout with a lockfile, and the record that npm keeps of what it installed.
const checkout = async (t, wanted, installed) => {
  const root = await scratch(t);
  if (wanted) await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: { '': {}, ...wanted } }));
  if (installed) {
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules/.package-lock.json'), JSON.stringify({ packages: installed }));
  }
  return root;
};
const at = (version, extra = {}) => ({ version, ...extra });

test('installed packages are compared with the lockfile by version', async (t) => {
  const wanted = { 'node_modules/chat': at('4.14.0'), 'node_modules/diagrams': at('12.3.0') };
  assert.equal(await dependencyError(await checkout(t, wanted, wanted)), null);
  // A checkout without a lockfile declares nothing to install.
  assert.equal(await dependencyError(await checkout(t, null, null)), null);

  // What a merge that adds a package leaves behind: the old node_modules.
  const behind = await checkout(t, wanted, { 'node_modules/chat': at('4.14.0') });
  assert.equal(
    await dependencyError(behind),
    `The packages in ${join(behind, 'node_modules')} are not the ones of package-lock.json: 1 is missing or in another version (diagrams 12.3.0). Run \`npm ci\` in ${behind}.`,
  );
  const older = await checkout(t, wanted, { ...wanted, 'node_modules/diagrams': at('11.0.0') });
  assert.match(
    await dependencyError(older),
    /1 is missing or in another version \(diagrams 12\.3\.0 \(installed: 11\.0\.0\)\)/,
  );
  const fresh = await checkout(t, wanted, null);
  assert.match(
    await dependencyError(fresh),
    /2 are missing or in another version \(chat 4\.14\.0, diagrams 12\.3\.0\)\. Run `npm ci`/,
  );
  const many = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`node_modules/p${index}`, at('1.0.0')]));
  assert.match(
    await dependencyError(await checkout(t, many, {})),
    /7 are missing or in another version \(p0 1\.0\.0, p1 1\.0\.0, p2 1\.0\.0, p3 1\.0\.0, p4 1\.0\.0, …\)/,
  );
});

test('the service needs no development tools, no package of another platform and no linked workspace', async (t) => {
  const wanted = {
    'node_modules/chat': at('4.14.0'),
    'node_modules/linter': at('10.0.0', { dev: true }),
    'node_modules/either': at('2.0.0', { devOptional: true }),
    'node_modules/@native/linux-x64': at('1.0.0', { optional: true }),
    'node_modules/workspace': { resolved: 'packages/workspace', link: true },
    'packages/workspace': at('0.0.1'),
  };
  const root = await checkout(t, wanted, { 'node_modules/chat': at('4.14.0') });
  assert.equal(await dependencyError(root), null);
  // The tests and the linters need the development tools too.
  assert.match(
    await dependencyError(root, { dev: true }),
    /2 are missing or in another version \(linter 10\.0\.0, either 2\.0\.0\)/,
  );
});

test('a lockfile that cannot be read is an error, not an empty list', async (t) => {
  const root = await checkout(t, null, null);
  await writeFile(join(root, 'package-lock.json'), '{');
  await assert.rejects(dependencyError(root), /^Error: Cannot read .*package-lock\.json: /);
});

test("this checkout's packages are the ones of its lockfile, which the step before the tests ensures", async () => {
  assert.equal(await dependencyError(ROOT, { dev: true }), null);
});

test('the service refuses to start on outdated packages, with one line that says what to run', async (t) => {
  // A copy of the checkout whose lockfile names a package that the shared node_modules does not hold.
  const root = await scratch(t);
  await cp(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
  await symlink(join(ROOT, 'node_modules'), join(root, 'node_modules'));
  await writeFile(
    join(root, 'package-lock.json'),
    JSON.stringify({ packages: { '': {}, 'node_modules/not-installed-anywhere': at('9.9.9') } }),
  );
  // A service that does not refuse would start for real, so it gets a port, a broker port and a data directory of
  // its own, and it does not outlive the test.
  const child = spawn(process.execPath, [join(root, 'src/server.mjs')], {
    env: {
      PATH: process.env.PATH,
      MU_HOME: join(root, 'home'),
      MU_DATA_DIR: await shortTempDir(t, 'deps'),
      MU_PORT: String(await freePort()),
      MU_IRC_PORT: String(await freePort()),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let output = '';
  const started = Promise.withResolvers();
  for (const stream of [child.stdout, child.stderr])
    stream.setEncoding('utf8').on('data', (data) => {
      output += data;
      if (output.includes('Mu dashboard:')) started.resolve('started');
    });
  const code = await Promise.race([new Promise((resolve) => child.once('exit', resolve)), started.promise]);
  assert.equal(code, 1, output);
  assert.match(
    output,
    new RegExp(
      `^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z The packages in ${join(root, 'node_modules')} are not the ones of package-lock\\.json: 1 is missing or in another version \\(not-installed-anywhere 9\\.9\\.9\\)\\. Run \`npm ci\` in ${root}\\.\\n$`,
    ),
  );
});
