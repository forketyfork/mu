import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { containerRunner } from '../src/eval-runner.mjs';
import { shortTempDir } from './isolation.mjs';

const digest = `sha256:${'b'.repeat(64)}`;

// A stand-in for the Docker CLI that records each invocation: its arguments and the values of the variables that
// `--env NAME` would pass into the container.
async function stubDocker(t) {
  const directory = await shortTempDir(t, 'docker-stub');
  const log = join(directory, 'calls.jsonl');
  const script = join(directory, 'docker');
  await writeFile(
    script,
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const forwarded = {};
for (let index = 0; index < args.length; index++) if (args[index] === '--env') forwarded[args[index + 1]] = process.env[args[index + 1]];
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, forwarded, input }) + '\\n');
  if (args[0] === 'image') return console.log(${JSON.stringify(digest)});
  if (args[0] === 'rm') return;
  const echo = Object.values(forwarded).join(' ');
  if (process.env.STUB_FAIL) {
    process.stderr.write('provider rejected ' + echo);
    process.exit(1);
  }
  console.log(JSON.stringify({ reply: 'saw ' + echo, costUsd: 0.01, tokens: 5 }));
});
`,
  );
  await chmod(script, 0o755);
  const calls = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { path: [directory, dirname(process.execPath), process.env.PATH].join(delimiter), calls };
}

const target = (adapter, model) => ({ adapter, model, effort: 'medium' });
const run = (runner, adapter, model) =>
  runner.execute({
    target: target(adapter, model),
    prompt: 'Answer.',
    remaining: 0.4,
    image: digest,
    signal: undefined,
  });

test('a case container is sealed, and only explicit MU_EVAL_ values for the selected harness reach it', async (t) => {
  const docker = await stubDocker(t);
  const runner = containerRunner(
    {
      PATH: docker.path,
      ANTHROPIC_API_KEY: 'service-own-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'service-login',
      OPENAI_API_KEY: 'service-openai-key',
      MU_EVAL_ANTHROPIC_API_KEY: 'eval-anthropic-key',
      MU_EVAL_ANTHROPIC_BASE_URL: 'http://gateway.example/anthropic',
      MU_EVAL_CODEX_API_KEY: 'eval-codex-key',
      MU_EVAL_PI_OPENROUTER_API_KEY: 'eval-openrouter-key',
    },
    { price: () => assert.fail('no Codex calls to price') },
  );
  assert.equal(await runner.prepare(), digest);
  const claude = await run(runner, 'claude', 'sonnet');
  assert.equal(claude.reply, 'saw [redacted] http://gateway.example/anthropic', 'a key echoed in a reply is redacted');
  await run(runner, 'codex', 'exact-id');
  await run(runner, 'pi', 'openrouter/some-model');
  const [, ...cases] = await docker.calls();
  assert.deepEqual(
    cases.map(({ forwarded }) => forwarded),
    [
      { ANTHROPIC_API_KEY: 'eval-anthropic-key', ANTHROPIC_BASE_URL: 'http://gateway.example/anthropic' },
      { CODEX_API_KEY: 'eval-codex-key' },
      { OPENROUTER_API_KEY: 'eval-openrouter-key' },
    ],
  );
  for (const { args, input } of cases) {
    for (const flag of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=1000:1000'])
      assert.ok(args.includes(flag), flag);
    for (const flag of ['--pids-limit=', '--memory=', '--cpus=', '--tmpfs=/tmp:'])
      assert.ok(
        args.some((arg) => arg.startsWith(flag)),
        flag,
      );
    assert.ok(
      !args.some((arg) => /^(-v|--volume|--mount|--privileged|--network=host|--net=host)(=|$)/.test(arg)),
      args.join(' '),
    );
    assert.equal(args.at(-1), digest, 'the image is pinned by ID');
    assert.ok(!args.some((arg) => arg.includes('key') && arg !== 'Answer.'), 'values pass by name only');
    assert.deepEqual(JSON.parse(input), { target: JSON.parse(input).target, prompt: 'Answer.', remaining: 0.4 });
  }
});

test('a failed case container is removed, and its error does not reveal the forwarded key', async (t) => {
  const docker = await stubDocker(t);
  const runner = containerRunner(
    { PATH: docker.path, STUB_FAIL: '1', MU_EVAL_ANTHROPIC_API_KEY: 'eval-anthropic-key' },
    { price: () => ({}) },
  );
  await assert.rejects(run(runner, 'claude', 'sonnet'), (/** @type {Error} */ error) => {
    assert.match(error.message, /provider rejected \[redacted\]/);
    assert.ok(!error.message.includes('eval-anthropic-key'));
    return true;
  });
  const [started, removed] = await docker.calls();
  const name = started.args[started.args.indexOf('--name') + 1];
  assert.deepEqual(removed.args, ['rm', '--force', name]);
});
