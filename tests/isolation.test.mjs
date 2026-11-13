import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Two overlapping `npm test` runs share the machine's ports, so a test that binds a number of its own fails whenever another run holds it.
test('no test binds a fixed TCP port', async () => {
  const offenders = [];
  for (const name of (await readdir(new URL('.', import.meta.url))).filter(
    (name) => (name.endsWith('.test.mjs') || name.endsWith('.integration.mjs')) && name !== 'isolation.test.mjs',
  )) {
    const text = await readFile(new URL(name, import.meta.url), 'utf8');
    for (const [index, line] of text.split('\n').entries())
      if (/\b(?:port|Port)\b\s*[:=]\s*\d{4,5}\b|\b(?:team|startApp)\(t,\s*\d{4,5}/.test(line))
        offenders.push(`${name}:${index + 1}`);
  }
  assert.deepEqual(offenders, []);
});

// The entry point refuses to start while the checkout holds a configuration that it would not read, as the main
// checkout does until the user moves it into the home, so such a test names its configuration file too.
test('a test that starts the server entry point supplies an isolated MU_HOME and its own MU_CONFIG', async () => {
  const offenders = [];
  for (const name of (await readdir(new URL('.', import.meta.url))).filter((name) => name.endsWith('.test.mjs'))) {
    const text = await readFile(new URL(name, import.meta.url), 'utf8');
    if (/spawn\(process\.execPath,\s*\[join\(ROOT, ['"]src\/server\.mjs['"]\)/.test(text)) {
      if (!/MU_HOME:\s*home\b/.test(text)) offenders.push(`${name} has no MU_HOME`);
      if (!/MU_CONFIG:\s*config\b/.test(text)) offenders.push(`${name} has no MU_CONFIG`);
    }
  }
  assert.deepEqual(offenders, []);
});

// The live broker on 6667 serves the running Mu service, and a second client would share its agent nicknames.
test('no integration test reaches the live IRC broker', async () => {
  const offenders = [];
  for (const name of (await readdir(new URL('.', import.meta.url))).filter((name) =>
    name.endsWith('.integration.mjs'),
  )) {
    const text = await readFile(new URL(name, import.meta.url), 'utf8');
    if (/\b6667\b/.test(text)) offenders.push(`${name} names the live broker's port`);
    if (/new Chat\(\{(?![^)]*\bport\b)/.test(text)) offenders.push(`${name} creates a Chat without a port`);
  }
  assert.deepEqual(offenders, []);
});
