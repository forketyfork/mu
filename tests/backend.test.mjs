import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Store, mentions } from '../src/store.mjs';
import { Chat, chunks } from '../src/chat.mjs';
import { CODEX_APPROVALS, codexPermissions, commandFor, parseOutput } from '../src/adapters.mjs';
import { Runner } from '../src/runner.mjs';
import { createApp, loadConfig, ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { testIdentity, userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, FAKE_PRIVATE_PATHS, temporaryMuHome } from './isolation.mjs';

const agent = (id, adapter = 'manual') => ({
  id,
  role: id === 'lead' ? 'lead' : 'worker',
  adapter,
  cwd: ROOT,
  task: '',
});
const temp = (t) => shortTempDir(t, 'backend');
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('mention routing excludes self, ignores unaddressed messages, and delivers broadcast once', () => {
  const store = new Store();
  for (const id of ['lead', 'worker', 'reviewer']) store.createAgent(agent(id));
  assert.deepEqual(mentions('mail@example.com (@Worker), @lead! @worker @all'), ['worker', 'lead', 'all']);
  store.addMessage('1', 'user', 'plain room message');
  store.addMessage('2', 'worker', '@all @reviewer coordinate');
  store.addMessage('2', 'worker', '@all @reviewer coordinate');
  store.addMessage('3', 'user', '@user ask human');
  assert.equal(store.inbox('worker').length, 0);
  assert.equal(store.inbox('lead').length, 1);
  assert.equal(store.inbox('reviewer').length, 1);
  assert.equal(store.messages().length, 3);
  store.close();
});

test('pending delivery survives restart; exact acknowledgements do not lose later messages', async (t) => {
  const directory = await temp(t),
    filename = join(directory, 'state.sqlite');
  let store = new Store(filename);
  store.createAgent(agent('worker'));
  const first = store.addMessage('1', 'user', '@worker first');
  const second = store.addMessage('2', 'user', '@worker second');
  store.ack('worker', first.id);
  store.updateAgent('worker', { status: 'working' });
  store.close();
  store = new Store(filename);
  assert.deepEqual(
    store.inbox('worker').map((message) => message.id),
    [second.id],
  );
  assert.equal(store.agent('worker').status, 'error');
  assert.match(store.agent('worker').lastError, /restarted/);
  assert.throws(() => store.ack('worker', 999), /not in/);
  store.close();
});

test('UTF-8 fragmentation retains every character and bounds IRC bytes', () => {
  const text = '@worker\n' + '🙂日本語 test '.repeat(100);
  const parts = chunks(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every((part) => Buffer.byteLength(part) <= 300));
});

test('newline display encoding cannot exceed the IRC fragment byte limit', async () => {
  const fragments = [];
  const chat = new Chat({ onMessage: (_id, _from, text) => ({ text }) });
  chat.state.connected = true;
  chat.syncConversation = async () => {};
  chat.connect = async () => ({
    say: (_channel, text, tags) => {
      fragments.push(text);
      queueMicrotask(() => chat.receive({ nick: 'user', tags, message: text }));
    },
  });
  const text = '@worker\n' + '\n'.repeat(1000) + 'end';
  assert.equal((await chat.send('user', text)).text, text);
  assert.ok(fragments.every((fragment) => Buffer.byteLength(fragment) <= 300));
});

test('a process interrupted after reporting done still requires explicit recovery', async (t) => {
  const directory = await temp(t),
    filename = join(directory, 'interrupted.sqlite');
  let store = new Store(filename);
  store.createAgent(agent('worker'));
  const message = store.addMessage('1', 'user', '@worker task');
  store.updateAgent('worker', { status: 'done', activeMessageId: message.id });
  store.close();
  store = new Store(filename);
  assert.equal(store.agent('worker').status, 'error');
  assert.equal(store.inbox('worker').length, 1);
  store.close();
});

test('CLI adapters use explicit session IDs and parse final result rather than progress', () => {
  const codexPaths = {
    dataDir: '/data',
    credentialFile: '/data/credentials/worker',
    privatePaths: ['/home/.claude/projects'],
  };
  const codex = commandFor(
    { ...agent('worker', 'codex'), sessionId: 'exact-session' },
    ROOT,
    {},
    {},
    { codex: codexPaths },
  );
  assert.deepEqual(codex.args, [
    ...codexPermissions(codexPaths),
    ...CODEX_APPROVALS,
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '--ignore-rules',
    'exact-session',
    '-',
  ]);
  assert.deepEqual(
    commandFor(
      agent('worker', 'codex'),
      ROOT,
      {},
      { codex: ['-c', 'approvals_reviewer="user"'] },
      { codex: codexPaths },
    ).args,
    [
      ...codexPermissions(codexPaths),
      ...CODEX_APPROVALS,
      '-c',
      'approvals_reviewer="user"',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-rules',
      '-',
    ],
    "a new turn ignores the user's execpolicy rules too, and cliArgs.codex can override the approval settings",
  );
  assert.deepEqual(CODEX_APPROVALS, ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"']);
  assert.deepEqual(codexPermissions(codexPaths), [
    '-c',
    'default_permissions="mu-agent"',
    '-c',
    'permissions.mu-agent={extends=":workspace", filesystem={"/data"="deny", "/home/.claude/projects"="deny", "/data/credentials/worker"="read"}, network={enabled=true}}',
  ]);
  const claude = commandFor({ ...agent('worker', 'claude'), sessionId: 'exact-session' }, ROOT);
  assert.ok(claude.args.includes('--resume'));
  assert.equal(claude.args.at(-1), 'exact-session');
  assert.ok(claude.args.includes(`Bash(node ${join(ROOT, 'src/cli.mjs')} *)`));
  assert.deepEqual(
    parseOutput(
      'codex',
      '{"type":"thread.started","thread_id":"s1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"final"}}\n',
    ),
    { text: 'final', sessionId: 's1' },
  );
  assert.deepEqual(parseOutput('claude', '{"type":"result","session_id":"s2","result":"answer"}\n'), {
    text: 'answer',
    sessionId: 's2',
  });
  assert.throws(() => parseOutput('codex', '{"type":"turn.failed","error":{"message":"denied"}}'), /denied/);
  assert.throws(
    () => parseOutput('claude', '{"type":"result","is_error":true,"errors":["permission denied"]}'),
    /permission denied/,
  );
  assert.throws(() => parseOutput('text', '  \n'), /no final response/);
});

test('explicit missing configuration fails and native profile arguments are retained', async (t) => {
  const directory = await temp(t),
    missing = join(directory, 'missing.json');
  assert.deepEqual(await loadConfig(missing), {});
  await assert.rejects(loadConfig(missing, { required: true }), /ENOENT/);
  const filename = join(directory, 'config.json');
  await writeFile(
    filename,
    JSON.stringify({ cliArgs: { codex: ['--profile', 'mu'], claude: ['--permission-mode', 'auto'] } }),
  );
  const config = await loadConfig(filename);
  const command = commandFor(agent('worker', 'codex'), ROOT, {}, config.cliArgs, {
    codex: { dataDir: '/data', credentialFile: '/data/credentials/worker', privatePaths: FAKE_PRIVATE_PATHS },
  });
  assert.ok(command.args.indexOf('--profile') < command.args.indexOf('exec'));
  for (const sessionId of [null, 'existing-session']) {
    const claude = commandFor({ ...agent('worker', 'claude'), sessionId }, ROOT, {}, config.cliArgs);
    assert.equal(claude.args[claude.args.indexOf('--permission-mode') + 1], 'auto');
    assert.equal(claude.args[claude.args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(claude.args[claude.args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(claude.args.includes('--resume'), Boolean(sessionId));
    if (sessionId) assert.equal(claude.args.at(-1), sessionId);
  }
  await writeFile(filename, JSON.stringify({ cliArgs: { codex: '--profile mu' } }));
  await assert.rejects(loadConfig(filename), /expected an array/);
});

test('runner runs one process per agent, preserves delivery on stop and failure, and handles NO_REPLY', async (t) => {
  const directory = await temp(t),
    script = join(directory, 'agent.mjs');
  await writeFile(
    script,
    `for await (const chunk of process.stdin) {}\nawait new Promise(r=>setTimeout(r,150));\nif(process.env.MU_PROMPT.includes('fail-now')) process.exit(2);\nconsole.log(process.env.MU_PROMPT.includes('no-reply-now')?'NO_REPLY':'@user done '+process.env.MU_MESSAGE_ID);\n`,
  );
  const store = new Store();
  const outputs = [];
  const chat = {
    state: { connected: true },
    async send(from, text) {
      outputs.push({ from, text });
      return store.addMessage(String(outputs.length), from, text);
    },
  };
  const runner = new Runner({
    home: ROOT,
    identity: testIdentity(t),
    store,
    chat,
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom: { fixture: { command: process.execPath, args: [script] } },
  });
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  store.createAgent(agent('worker', 'fixture'));
  store.addMessage('incoming1', 'user', '@worker first');
  store.addMessage('incoming2', 'user', '@worker second');
  runner.kick();
  runner.kick();
  await until(() => store.inbox('worker').length === 0);
  assert.equal(outputs.length, 1);
  assert.match(outputs[0].text, /done 2$/);
  store.addMessage('incoming3', 'user', '@worker no-reply-now');
  runner.kick();
  await until(() => store.inbox('worker').length === 0);
  assert.equal(outputs.length, 1);
  store.addMessage('incoming4', 'user', '@worker stop this');
  runner.kick();
  await until(() => runner.active.get('worker')?.child);
  runner.stop('worker');
  await until(() => !runner.active.size);
  assert.equal(store.agent('worker').status, 'stopped');
  assert.equal(store.inbox('worker').length, 1);
  store.ack('worker', store.inbox('worker')[0].id);
  store.updateAgent('worker', { status: 'idle' });
  store.addMessage('incoming5', 'user', '@worker fail-now');
  runner.kick();
  await until(() => store.agent('worker').status === 'error');
  assert.equal(store.inbox('worker').length, 1);
  assert.match(store.agent('worker').lastError, /exited 2/);
});

test('service shutdown leaves running agents resumable and the next service resumes the interrupted message', async (t) => {
  const directory = await temp(t),
    filename = join(directory, 'shutdown.sqlite'),
    script = join(directory, 'agent.mjs');
  await writeFile(
    script,
    `let prompt='';for await (const chunk of process.stdin) prompt+=chunk;\nif(!prompt.includes('Mu service shut down while you were handling message #'+process.env.MU_MESSAGE_ID)) await new Promise(r=>setTimeout(r,60000));\nconsole.log('@user resumed '+process.env.MU_MESSAGE_ID);\n`,
  );
  const custom = { fixture: { command: process.execPath, args: [script] } };
  let store = new Store(filename);
  store.createAgent(agent('worker', 'fixture'));
  const message = store.addMessage('incoming', 'user', '@worker long task');
  let runner = new Runner({
    home: ROOT,
    identity: testIdentity(t),
    store,
    chat: { state: { connected: true }, async send() {} },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom,
  });
  runner.kick();
  await until(() => runner.active.get('worker')?.child);
  runner.close();
  await until(() => !runner.active.size);
  store.close();
  store = new Store(filename);
  t.after(() => store.close());
  assert.equal(store.agent('worker').status, 'idle');
  assert.equal(store.agent('worker').interruptedMessageId, message.id);
  assert.deepEqual(
    store.inbox('worker').map((pending) => pending.id),
    [message.id],
  );
  const outputs = [];
  runner = new Runner({
    home: ROOT,
    identity: testIdentity(t),
    store,
    chat: {
      state: { connected: true },
      async send(from, text) {
        outputs.push(text);
      },
    },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom,
  });
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
  });
  runner.kick();
  await until(() => store.inbox('worker').length === 0);
  assert.deepEqual(outputs, [`@user resumed ${message.id}`]);
  assert.equal(store.agent('worker').status, 'idle');
  assert.equal(store.agent('worker').interruptedMessageId, null);
});

test('service shutdown during delivery acknowledges the posted reply instead of resuming it', async (t) => {
  const store = new Store();
  t.after(() => store.close());
  store.createAgent(agent('worker', 'demo'));
  const message = store.addMessage('incoming', 'user', '@worker task');
  /** @type {(value?: unknown) => void} */
  let release;
  const posted = [];
  const chat = {
    state: { connected: true },
    async send(from, text) {
      posted.push(text);
      await new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const runner = new Runner({
    home: ROOT,
    identity: testIdentity(t),
    store,
    chat,
    root: ROOT,
    url: 'http://127.0.0.1:4310',
  });
  store.updateAgent('worker', {
    pendingResult: { messageIds: [message.id], conversationId: 'common', text: '@user saved', status: 'idle' },
  });
  runner.kick();
  await until(() => release);
  runner.close();
  release();
  await until(() => !runner.active.size);
  assert.deepEqual(posted, ['@user saved']);
  assert.equal(store.inbox('worker').length, 0);
  assert.equal(store.agent('worker').interruptedMessageId, null);
  assert.equal(store.agent('worker').status, 'idle');
});

class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
  }
  async start() {}
  async connect() {}
  async syncConversation() {}
  close() {}
  async send(from, text, conversationId) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId);
  }
}
test('HTTP launch rejects foreign origins and hostnames, validates IDs, and browser cannot spoof sender', async (t) => {
  const directory = await temp(t),
    port = await freePort();
  const pricing = offlinePricing();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: directory,
    chatFactory: (options) => new FakeChat(options),
    pricing,
  });
  await app.start();
  t.after(() => app.close());
  assert.equal(pricing.fetches, 1, 'starting Mu without cached prices fetches them');
  const url = `http://127.0.0.1:${port}`;
  const request = (route, data, headers = {}) =>
    fetch(url + route, { method: 'POST', headers: { ...userHeaders(app), ...headers }, body: JSON.stringify(data) });
  assert.equal((await request('/api/agents', agent('worker'), { Origin: 'http://malicious.test' })).status, 403);
  const foreignHostStatus = await new Promise((resolveStatus, reject) => {
    const request = http.get(url + '/api/state', { headers: { Host: 'malicious.test' } }, (response) => {
      response.resume();
      resolveStatus(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await request('/api/agents', agent('all'))).status, 400);
  assert.equal((await request('/api/agents', { ...agent('other'), role: 'lead' })).status, 400);
  assert.equal((await request('/api/agents', { ...agent('lead'), role: 'worker' })).status, 400);
  assert.equal((await request('/api/agents', agent('user'))).status, 400);
  assert.equal((await request('/api/agents', agent('lead'))).status, 201);
  assert.equal((await request('/api/agents', agent('lead'))).status, 409);
  assert.equal((await request('/api/agents', agent('worker'))).status, 201);
  const response = await request(
    '/api/messages',
    { from: 'worker', text: '@worker run', conversationId: 'common' },
    { Origin: url },
  );
  assert.equal(response.status, 201);
  assert.equal((await response.json()).from, 'user');
  assert.equal(app.store.inbox('worker').length, 1);
  assert.equal((await request('/api/messages', { text: '@missing run' })).status, 400);
  const configure = (adapter) =>
    fetch(url + '/api/agents/worker', {
      method: 'PATCH',
      headers: { ...userHeaders(app) },
      body: JSON.stringify({ adapter }),
    });
  assert.equal((await configure('demo')).status, 409);
  await request('/api/agents/worker/stop', {});
  app.store.updateAgent('worker', { sessionId: 'old-session' });
  assert.equal((await configure('demo')).status, 200);
  assert.equal(app.store.agent('worker').sessionId, null);
  assert.equal(app.store.inbox('worker').length, 1);
});

test('@user mentions resolve to the user identity', () => {
  assert.deepEqual(mentions('@user please decide, @lead and @user agree'), ['user', 'lead']);
  assert.deepEqual(mentions('`@user` in code and @usery'), ['usery']);
  assert.deepEqual(mentions('@boss'), ['boss']);
});

test('mentions ignore code spans, fenced blocks, emails and scoped package names', () => {
  assert.deepEqual(mentions('Bumped @air/air-cloud and @dependabot/fetch-metadata'), []);
  assert.deepEqual(mentions('Run `@lead` or ```\n@worker\n``` then ~~~\n@user\n~~~ mail me@lead.io'), []);
  assert.deepEqual(mentions('`code` @lead and @air/pkg, @worker.'), ['lead', 'worker']);
});
