// startBrowser must say at once why a browser that dies at launch is gone, not poll its port until a bare "fetch failed".
// A stand-in binary plays the browser that a sandbox refuses; the test needs no Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startBrowser } from './browser/support.mjs';
import { shortTempDir } from './isolation.mjs';

async function standIn(t, script) {
  const binary = join(await shortTempDir(t, 'browser'), 'chrome');
  await writeFile(binary, `#!/bin/sh\n${script}\n`);
  await chmod(binary, 0o755);
  return binary;
}

async function failureOf(t, script) {
  const chrome = await standIn(t, script);
  const started = Date.now();
  const error = await startBrowser(t, { chrome }).then(
    () => assert.fail('startBrowser resolved for a browser that exited'),
    (rejection) => rejection,
  );
  // The polling that this replaces lasts ten seconds.
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  return error;
}

test('a browser that aborts at launch fails at once with its signal and the sandbox as the likely cause', async (t) => {
  const error = await failureOf(t, 'echo "Fatal: unable to get application ASN" >&2\nkill -ABRT $$');
  assert.match(error.message, /signal SIGABRT/);
  assert.match(error.message, /before DevTools answered/);
  assert.match(error.message, /sandbox/);
  assert.match(error.message, /escalation does not help/);
  assert.match(error.message, /outside an agent sandbox/);
  assert.match(error.message, /unable to get application ASN/);
  assert.doesNotMatch(error.message, /fetch failed/);
});

test('a browser that exits with a status reports the code, and an empty output is said to be empty', async (t) => {
  const error = await failureOf(t, 'exit 3');
  assert.match(error.message, /code 3/);
  assert.match(error.message, /output was empty/);
});

test('a browser that cannot be executed fails with the reason', async (t) => {
  const binary = join(await shortTempDir(t, 'browser'), 'chrome');
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o644);
  await assert.rejects(startBrowser(t, { chrome: binary }), /did not start: .*EACCES/);
});
