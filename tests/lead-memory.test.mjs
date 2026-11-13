import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Runner } from '../src/runner.mjs';
import { claudeLeadArgs, commandFor, readTurn } from '../src/adapters.mjs';
import { CodexRollouts } from '../src/codex-rollout.mjs';
import { MAX_MEMORY_INDEX_BYTES, readLeadMemoryIndex } from '../src/memory.mjs';
import { Store } from '../src/store.mjs';
import { ROOT, loadConfig } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { testIdentity } from './identity-fixture.mjs';
import { shortTempDir, temporaryMuHome } from './isolation.mjs';

const lines = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const claudeTurn = ({ session = 'claude-session', context = 40000 } = {}) =>
  lines([
    { type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5' },
    {
      type: 'assistant',
      session_id: session,
      parent_tool_use_id: null,
      message: {
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: context - 1000,
          output_tokens: 0,
        },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: session,
      is_error: false,
      result: 'NO_REPLY',
      total_cost_usd: 0.1,
      modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } },
    },
  ]);

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const INDEX = '# Lead memory\n\n- [Local proxy](local-proxy.md) — pi workers depend on it\n';
const indexPath = (home) => join(home, 'memory/lead/MEMORY.md');

test('the index is read as text with its hash, and a blank index is reported as empty', async (t) => {
  const home = await temporaryMuHome(t);
  await writeFile(indexPath(home), INDEX);
  const index = await readLeadMemoryIndex(home);
  assert.equal(index.text, INDEX);
  assert.equal(index.path, indexPath(home));
  assert.equal(index.cut, false);
  assert.equal(index.empty, false);
  await writeFile(indexPath(home), INDEX + '- [More](more.md) — another fact\n');
  assert.notEqual((await readLeadMemoryIndex(home)).hash, index.hash);
  await writeFile(indexPath(home), ' \n\n');
  assert.equal((await readLeadMemoryIndex(home)).empty, true);
});

test('a symbolic link or a second hard link as the index is refused, so that the lead cannot make Mu read another file', async (t) => {
  const home = await temporaryMuHome(t);
  const secret = join(await shortTempDir(t, 'memory-secret'), 'secret.txt');
  await writeFile(secret, 'a file the lead cannot read itself');
  await rm(indexPath(home));
  await symlink(secret, indexPath(home));
  await assert.rejects(readLeadMemoryIndex(home), /memory index .* must not be a symbolic link/);

  await rm(indexPath(home));
  await link(secret, indexPath(home));
  await assert.rejects(readLeadMemoryIndex(home), /memory index .* has multiple hard links/);
});

test('a memory directory that is a symbolic link, a missing index, a directory as index, and a foreign-writable index are refused', async (t) => {
  const home = await temporaryMuHome(t);
  await rm(indexPath(home));
  await assert.rejects(readLeadMemoryIndex(home), /memory index .* is missing/);
  await mkdir(indexPath(home));
  await assert.rejects(readLeadMemoryIndex(home), /not a regular file/);
  await rm(indexPath(home), { recursive: true });
  await writeFile(indexPath(home), INDEX);
  await chmod(indexPath(home), 0o666);
  await assert.rejects(readLeadMemoryIndex(home), /writable by another user/);
  await chmod(indexPath(home), 0o644);
  await readLeadMemoryIndex(home);

  const outside = await shortTempDir(t, 'memory-outside');
  await writeFile(join(outside, 'MEMORY.md'), 'planted');
  await rename(join(home, 'memory/lead'), join(home, 'memory/lead-moved'));
  await symlink(outside, join(home, 'memory/lead'));
  await assert.rejects(readLeadMemoryIndex(home), /memory directory .* must not be a symbolic link/);
  await rm(join(home, 'memory/lead'));
  await assert.rejects(readLeadMemoryIndex(home), /memory directory .* is missing/);
});

test('a FIFO as the index is refused at once, not waited on, because a FIFO without a writer would block the lead turn forever', async (t) => {
  const home = await temporaryMuHome(t);
  await rm(indexPath(home));
  const made = spawnSync('mkfifo', ['-m', '600', indexPath(home)]);
  assert.equal(made.status, 0, String(made.stderr));
  const outcome = await Promise.race([
    readLeadMemoryIndex(home).then(
      () => 'read',
      (error) => error.message,
    ),
    new Promise((resolve) => setTimeout(resolve, 2000, 'hung')),
  ]);
  assert.match(outcome, /memory index .* is not a regular file/);
});

test('an index that is not UTF-8 text is refused', async (t) => {
  const home = await temporaryMuHome(t);
  await writeFile(indexPath(home), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  await assert.rejects(readLeadMemoryIndex(home), /not valid UTF-8/);
});

test('an index over the limit is cut at the last whole line, one exactly at the limit is not cut', async (t) => {
  const home = await temporaryMuHome(t);
  const line = (n) => `- [Fact ${n}](f${n}.md) — ${'x'.repeat(40)}\n`;
  const kept = [];
  let size = 0;
  while (size + Buffer.byteLength(line(kept.length)) <= MAX_MEMORY_INDEX_BYTES + 1) {
    size += Buffer.byteLength(line(kept.length));
    kept.push(line(kept.length));
  }
  await writeFile(indexPath(home), kept.join('') + line(kept.length) + line(kept.length + 1));
  const cut = await readLeadMemoryIndex(home);
  assert.equal(cut.cut, true);
  assert.equal(cut.text, kept.join('').slice(0, -1));
  assert.ok(Buffer.byteLength(cut.text) <= MAX_MEMORY_INDEX_BYTES);

  const filler = 'a'.repeat(MAX_MEMORY_INDEX_BYTES - 1) + '\n';
  await writeFile(indexPath(home), filler);
  const exact = await readLeadMemoryIndex(home);
  assert.equal(Buffer.byteLength(filler), MAX_MEMORY_INDEX_BYTES);
  assert.equal(exact.cut, false);
  assert.equal(exact.text, filler);
  await writeFile(indexPath(home), filler + 'b');
  assert.equal((await readLeadMemoryIndex(home)).cut, true);
});

test('a cut never splits a character, and a change after the cut is not a change of what was delivered', async (t) => {
  const home = await temporaryMuHome(t);
  const text = 'é'.repeat(MAX_MEMORY_INDEX_BYTES) + 'tail';
  await writeFile(indexPath(home), text);
  const first = await readLeadMemoryIndex(home);
  assert.equal(first.cut, true);
  assert.ok(Buffer.byteLength(first.text) <= MAX_MEMORY_INDEX_BYTES);
  assert.match(first.text, /^é+$/);
  await writeFile(indexPath(home), text + 'more beyond the cut');
  assert.equal((await readLeadMemoryIndex(home)).hash, first.hash);
});

async function leadSetup(t, adapter = 'claude') {
  const home = await temporaryMuHome(t);
  await writeFile(indexPath(home), INDEX);
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter, cwd: ROOT, task: 'Coordinate' });
  store.createAgent({ id: 'worker', role: 'worker', adapter, cwd: ROOT, task: 'Work' });
  store.createConversation({
    id: 'room',
    kind: 'room',
    name: 'Room',
    members: ['user', 'lead', 'worker'],
    createdBy: 'user',
  });
  const runner = new Runner({
    home,
    identity: testIdentity(t),
    store,
    chat: { state: { connected: true }, async send() {} },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    codexRollouts: new CodexRollouts(join(ROOT, '.tmp/no-codex-home')),
    pricing: offlinePricing(),
  });
  const prompts = [],
    outputs = [];
  let duringTurn = null;
  runner.execute = async (command, agent, message, prompt) => {
    prompts.push({ agent: agent.id, prompt });
    if (duringTurn) await duringTurn();
    duringTurn = null;
    return readTurn(command.format, outputs.shift());
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  let count = 0;
  const turn = async (output, conversationId = 'dm-lead', agent = 'lead') => {
    outputs.push(output);
    store.addMessage(`turn-${++count}`, 'user', `@${agent} Report`, conversationId);
    runner.kick();
    await until(() => !runner.active.size);
    return prompts.at(-1)?.prompt;
  };
  return {
    home,
    store,
    turn,
    prompts,
    runner,
    during: (callback) => (duringTurn = callback),
  };
}

const HEADER = /^Your memory index, from .*\/memory\/lead\/MEMORY\.md/m;
const UNCHANGED = /Your memory index is unchanged since an earlier turn of this session/;

test('the lead gets the index on a new session and one line while the session holds it', async (t) => {
  const { home, turn } = await leadSetup(t);
  const first = await turn(claudeTurn({ context: 40000 }));
  assert.match(first, HEADER);
  assert.ok(first.includes('- [Local proxy](local-proxy.md) — pi workers depend on it'));
  assert.ok(first.includes(`from ${indexPath(home)}`));
  assert.match(first, /End of the memory index\./);
  const second = await turn(claudeTurn({ context: 52000 }));
  assert.match(second, UNCHANGED);
  assert.ok(second.includes(indexPath(home)));
  assert.ok(!second.includes('pi workers depend on the local proxy'));
});

test('a fact that another session saved reaches the lead session on its next turn, and a session does not get its own change again', async (t) => {
  const { home, store, turn, during } = await leadSetup(t);
  store.createConversation({
    id: 'task-room',
    kind: 'room',
    name: 'Task',
    members: ['user', 'lead'],
    createdBy: 'user',
  });
  await turn(claudeTurn({ session: 'direct', context: 40000 }), 'dm-lead');
  assert.match(await turn(claudeTurn({ session: 'task', context: 40000 }), 'task-room'), HEADER);

  const changed = `${INDEX}- [New](new.md) — saved in the task room\n`;
  during(() => writeFile(indexPath(home), changed));
  const writer = await turn(claudeTurn({ session: 'task', context: 50000 }), 'task-room');
  assert.match(writer, UNCHANGED, 'the turn that writes still got the old index, which its session held');
  assert.match(await turn(claudeTurn({ session: 'task', context: 60000 }), 'task-room'), UNCHANGED);

  const other = await turn(claudeTurn({ session: 'direct', context: 60000 }), 'dm-lead');
  assert.match(other, HEADER);
  assert.ok(other.includes('saved in the task room'));
  assert.match(await turn(claudeTurn({ session: 'direct', context: 70000 }), 'dm-lead'), UNCHANGED);
});

test('an edit by the user between turns is delivered to every session once', async (t) => {
  const { home, turn } = await leadSetup(t);
  await turn(claudeTurn({ context: 40000 }));
  await writeFile(indexPath(home), `${INDEX}- [Edited](edited.md) — the user's edit\n`);
  const edited = await turn(claudeTurn({ context: 50000 }));
  assert.match(edited, HEADER);
  assert.ok(edited.includes("the user's edit"));
  assert.match(await turn(claudeTurn({ context: 60000 })), UNCHANGED);
});

test('a new native session or a shrinking context gets the index again', async (t) => {
  const { store, turn } = await leadSetup(t);
  await turn(claudeTurn({ context: 400000 }));
  assert.match(
    await turn(claudeTurn({ context: 90000 })),
    UNCHANGED,
    'this turn could not know about the compaction yet',
  );
  assert.match(await turn(claudeTurn({ context: 95000 })), HEADER);
  assert.match(await turn(claudeTurn({ context: 99000 })), UNCHANGED);
  store.updateAgent('lead', { sessionIds: { 'dm-lead': 'fresh' } });
  assert.match(await turn(claudeTurn({ session: 'fresh', context: 30000 })), HEADER);
});

test('an adapter that reports no context size gets the index on every turn', async (t) => {
  const { turn } = await leadSetup(t, 'demo');
  assert.match(await turn('NO_REPLY\n'), HEADER);
  assert.match(await turn('NO_REPLY\n'), HEADER);
});

test('an empty index tells the lead where its memory is', async (t) => {
  const { home, turn } = await leadSetup(t);
  await writeFile(indexPath(home), '\n');
  const prompt = await turn(claudeTurn());
  assert.match(prompt, HEADER);
  assert.match(prompt, /The index is empty\./);
  const runnerContext = prompt.slice(prompt.indexOf('Your identity: @lead;'));
  assert.match(runnerContext, /The user has identity @user\./);
  assert.doesNotMatch(runnerContext, /@boss|\bBoss\b/);
});

test('an index over the limit is delivered up to it with a sentence that says it was cut', async (t) => {
  const { home, turn } = await leadSetup(t);
  const facts = Array.from({ length: 400 }, (_, n) => `- [Fact ${n}](f${n}.md) — ${'y'.repeat(60)}\n`).join('');
  await writeFile(indexPath(home), facts);
  const prompt = await turn(claudeTurn());
  assert.match(prompt, /Mu cut it here\. Prune it/);
  assert.ok(prompt.includes('- [Fact 0](f0.md)'));
  assert.ok(!prompt.includes('- [Fact 399](f399.md)'));
});

test('a worker never gets the lead memory, even when the index has facts', async (t) => {
  const { store, turn, prompts } = await leadSetup(t);
  const workerOutput = claudeTurn();
  const lead = await turn(workerOutput, 'dm-lead');
  assert.match(lead, HEADER);
  await turn(workerOutput, 'dm-worker');
  const worker = prompts.at(-1);
  assert.equal(worker.agent, 'worker');
  assert.ok(!worker.prompt.includes('pi workers depend on the local proxy'));
  assert.doesNotMatch(worker.prompt, /memory index/i);
  assert.equal(store.agent('worker').memoryDelivered, undefined);
});

test('a symbolic link as the index fails the lead turn instead of delivering the target', async (t) => {
  const { home, prompts, store, turn } = await leadSetup(t);
  const secret = join(await shortTempDir(t, 'memory-lead-secret'), 'secret.txt');
  await writeFile(secret, 'TOP SECRET');
  await rm(indexPath(home));
  await symlink(secret, indexPath(home));
  await turn(claudeTurn());
  assert.equal(prompts.length, 0);
  assert.equal(store.agent('lead').status, 'error');
  assert.match(store.agent('lead').lastError, /must not be a symbolic link/);
});

test('an index that became unreadable during the turn keeps the reply and fails the next turn on the diagnosis', async (t) => {
  const { home, store, turn, during } = await leadSetup(t);
  await turn(claudeTurn({ context: 40000 }));
  const secret = join(await shortTempDir(t, 'memory-lead-race'), 'secret.txt');
  await writeFile(secret, 'TOP SECRET');
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  t.after(() => (console.error = original));
  during(async () => {
    await rm(indexPath(home));
    await symlink(secret, indexPath(home));
  });
  await turn(claudeTurn({ context: 50000 }));
  console.error = original;
  assert.equal(store.agent('lead').status, 'idle');
  assert.equal(store.agent('lead').memoryDelivered['dm-lead'], undefined);
  assert.match(errors.join('\n'), /memory index is unreadable after its turn/);
  await turn(claudeTurn({ context: 60000 }));
  assert.equal(store.agent('lead').status, 'error');
  assert.match(store.agent('lead').lastError, /must not be a symbolic link/);
});

const claudeArgs = (agent, cliArgs = {}) =>
  commandFor({ id: agent.role, adapter: 'claude', cwd: ROOT, ...agent }, ROOT, {}, cliArgs).args;
const codexArgs = (agent, cliArgs = {}) =>
  commandFor({ id: agent.role, adapter: 'codex', cwd: ROOT, ...agent }, ROOT, {}, cliArgs, {
    codex: { dataDir: '/data', credentialFile: '/data/credential', privatePaths: [] },
  }).args;
const settingsOf = (args) => JSON.parse(args[args.lastIndexOf('--settings') + 1]);

test('the Claude lead turns its own memory off inside the configured settings object, the worker does not', () => {
  const configured = ['--permission-mode', 'auto', '--settings', '{"autoCompactWindow":263000}'];
  const lead = claudeArgs({ role: 'lead' }, { claude: configured });
  assert.deepEqual(settingsOf(lead), { autoCompactWindow: 263000, autoMemoryEnabled: false });
  assert.equal(lead.filter((arg) => arg === '--settings').length, 1, 'Claude Code reads only the last --settings');
  const worker = claudeArgs({ role: 'worker' }, { claude: configured });
  assert.deepEqual(settingsOf(worker), { autoCompactWindow: 263000 });
  assert.ok(!claudeArgs({ role: 'worker' }, { claude: ['--permission-mode', 'auto'] }).includes('--settings'));
});

test('the Claude lead gets the switch without configured settings, and it beats a configured autoMemoryEnabled', () => {
  assert.deepEqual(settingsOf(claudeArgs({ role: 'lead' })), { autoMemoryEnabled: false });
  assert.deepEqual(
    settingsOf(claudeArgs({ role: 'lead' }, { claude: ['--settings', '{"autoMemoryEnabled":true,"x":1}'] })),
    {
      autoMemoryEnabled: false,
      x: 1,
    },
  );
});

test('only the last --settings of several is changed, in both spellings', () => {
  assert.deepEqual(claudeLeadArgs(['--settings', '{"a":1}', '--settings', '{"b":2}']), [
    '--settings',
    '{"a":1}',
    '--settings',
    '{"b":2,"autoMemoryEnabled":false}',
  ]);
  assert.deepEqual(claudeLeadArgs(['--settings={"a":1}', '--model', 'x']), [
    '--settings={"a":1,"autoMemoryEnabled":false}',
    '--model',
    'x',
  ]);
});

test('settings that are not a JSON object are refused, because they cannot take the switch', () => {
  for (const value of ['/etc/settings.json', '[1]', 'null', '"x"', '{broken'])
    assert.throws(() => claudeLeadArgs(['--settings', value]), /not a JSON object/, value);
  assert.throws(() => claudeLeadArgs(['--settings']), /not a JSON object/);
});

test('the Codex lead disables the memories feature after the configured arguments, the worker keeps the configuration', () => {
  const configured = { codex: ['-c', 'features.memories=true', '-c', 'x=1'] };
  const lead = codexArgs({ role: 'lead' }, configured);
  assert.ok(lead.lastIndexOf('features.memories=false') > lead.lastIndexOf('features.memories=true'));
  assert.ok(lead.lastIndexOf('features.memories=false') < lead.indexOf('exec'));
  assert.ok(lead[lead.lastIndexOf('features.memories=false') - 1] === '-c');
  const worker = codexArgs({ role: 'worker' }, configured);
  assert.ok(!worker.includes('features.memories=false'));
  assert.ok(!codexArgs({ role: 'worker' }).some((arg) => arg.includes('memories')));
});

test('the lead turn of the Claude CLI carries the switch through the runner, with the role arguments of the configuration', async (t) => {
  const { runner, turn } = await leadSetup(t);
  runner.roleCliArgs = { lead: { claude: ['--settings', '{"autoCompactWindow":263000}'] } };
  runner.cliArgs = { claude: ['--permission-mode', 'auto'] };
  const commands = [];
  const execute = runner.execute;
  runner.execute = async (command, ...rest) => {
    commands.push(command.args);
    return execute(command, ...rest);
  };
  await turn(claudeTurn());
  assert.deepEqual(settingsOf(commands.at(-1)), { autoCompactWindow: 263000, autoMemoryEnabled: false });
});

test('a configuration whose lead settings are not a JSON object is refused at the start', async (t) => {
  const dir = await shortTempDir(t, 'lead-memory-config');
  const file = join(dir, 'mu.config.json');
  await writeFile(file, JSON.stringify({ roleCliArgs: { lead: { claude: ['--settings', '/path/settings.json'] } } }));
  await assert.rejects(loadConfig(file), /lead's claude arguments pass --settings .* not a JSON object/);
  await writeFile(file, JSON.stringify({ cliArgs: { claude: ['--settings', '{"autoCompactWindow":1}'] } }));
  assert.deepEqual((await loadConfig(file)).cliArgs, { claude: ['--settings', '{"autoCompactWindow":1}'] });
  await writeFile(file, JSON.stringify({ roleCliArgs: { worker: { claude: ['--settings', '/path/settings.json'] } } }));
  await loadConfig(file);
});
