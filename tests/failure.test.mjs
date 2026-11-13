import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryMuHome } from './isolation.mjs';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';
import { readTurn } from '../src/adapters.mjs';
import { ROOT } from '../src/server.mjs';
import { lexer } from 'marked';
import { testIdentity } from './identity-fixture.mjs';

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t, output) {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.tmp/response-regression-'));
  const script = join(directory, 'adapter.mjs');
  const executions = join(directory, 'executions.txt');
  await writeFile(
    script,
    `import {appendFileSync} from 'node:fs';\nfor await (const chunk of process.stdin) {}\nappendFileSync(${JSON.stringify(executions)}, 'run\\n');\nconsole.log(${JSON.stringify(output)});\n`,
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, executions, custom: { fixture: { command: process.execPath, args: [script] } } };
}

test('a complete investigation report longer than 2000 characters is delivered without truncation', async (t) => {
  const report = ('@lead ' + 'Evidence and verification. '.repeat(130)).trim();
  const { custom } = await fixture(t, report);
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: 'Coordinate' });
  store.createAgent({ id: 'worker', role: 'worker', adapter: 'fixture', cwd: ROOT, task: 'Investigate the issue' });
  const trigger = store.addMessage('task', 'user', '@worker Investigate');
  const sent = [];
  const chat = {
    state: { connected: true },
    async send(from, text, conversationId) {
      sent.push({ from, text, conversationId });
    },
  };
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat,
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom,
  });
  const acknowledgements = [];
  const completeTurn = store.completeTurn.bind(store);
  store.completeTurn = (id, messageIds, patch) => {
    acknowledgements.push([id, messageIds]);
    return completeTurn(id, messageIds, patch);
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  runner.kick();
  await until(() => !runner.active.size);
  assert.equal(store.agent('worker').status, 'idle', store.agent('worker').lastError);
  assert.equal(store.inbox('worker').length, 0);
  assert.deepEqual(sent, [{ from: 'worker', text: report, conversationId: 'common' }]);
  assert.equal(store.agent('worker').pendingResult, null);
  assert.deepEqual(acknowledgements, [['worker', [trigger.id]]]);
});

test('a completed result survives delivery failure and restart without re-running investigation', async (t) => {
  const report = '@user Completed investigation with evidence.';
  const { directory, executions, custom } = await fixture(t, report);
  const filename = join(directory, 'state.sqlite');
  let store = new Store(filename);
  store.createAgent({ id: 'worker', role: 'worker', adapter: 'fixture', cwd: ROOT, task: 'Investigate' });
  const trigger = store.addMessage('task', 'user', '@worker Investigate');
  const failures = [];
  let runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: {
      state: { connected: true },
      async send(from, text, conversationId) {
        if (from === 'worker') throw new Error('IRC confirmation failed');
        failures.push({ from, text, conversationId });
      },
    },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom,
  });
  const execute = runner.execute.bind(runner);
  runner.execute = async (...args) => {
    const result = await execute(...args);
    store.updateAgent('worker', { status: 'done' });
    return result;
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  runner.kick();
  await until(() => !runner.active.size);
  assert.equal(store.agent('worker').pendingResult?.text, report);
  assert.deepEqual(store.agent('worker').pendingResult.messageIds, [trigger.id]);
  assert.equal(store.inbox('worker').length, 1);
  assert.equal(failures[0].from, 'system');
  assert.match(failures[0].text, /@user.*agent worker.*IRC confirmation failed/);
  assert.equal(failures[0].conversationId, 'common');
  runner.close();
  store.close();

  store = new Store(filename);
  const sent = [];
  runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: {
      state: { connected: true },
      async send(from, text, conversationId) {
        sent.push({ from, text, conversationId });
      },
    },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom,
  });
  store.updateAgent('worker', { status: 'idle' });
  runner.kick();
  await until(() => !runner.active.size);
  assert.deepEqual(sent, [{ from: 'worker', text: report, conversationId: 'common' }]);
  assert.equal(await readFile(executions, 'utf8'), 'run\n');
  assert.equal(store.inbox('worker').length, 0);
  assert.equal(store.agent('worker').pendingResult, null);
  assert.equal(store.agent('worker').status, 'done');
});

for (const kind of ['room', 'direct'])
  test(`failure notification stays in the ${kind} and cannot mention unrelated agents`, async (t) => {
    const { directory } = await fixture(t, 'unused');
    const script = join(directory, 'failure.mjs');
    await writeFile(
      script,
      `for await (const chunk of process.stdin) {}\nconsole.error('failure diagnostic contains @all and @outsider');\nprocess.exit(2);\n`,
    );
    const store = new Store();
    for (const id of ['lead', 'outsider'])
      store.createAgent({ id, role: id === 'lead' ? 'lead' : 'worker', adapter: 'manual', cwd: ROOT, task: '' });
    store.createAgent({ id: 'worker', role: 'worker', adapter: 'fixture', cwd: ROOT, task: '' });
    const conversationId = kind === 'room' ? 'investigation' : 'dm-worker';
    if (kind === 'room')
      store.createConversation({
        id: conversationId,
        kind: 'room',
        name: 'Investigation',
        members: ['user', 'lead', 'worker'],
        createdBy: 'lead',
      });
    const trigger = store.addMessage('task', 'user', '@worker Investigate', conversationId);
    const sent = [];
    const chat = {
      state: { connected: true },
      async send(from, text, id) {
        sent.push({ from, text, conversationId: id });
        return store.addMessage('error-notice', from, text, id);
      },
    };
    const runner = new Runner({
      home: await temporaryMuHome(t),
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
    runner.kick();
    await until(() => !runner.active.size);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, 'system');
    assert.equal(sent[0].conversationId, conversationId);
    assert.match(sent[0].text, /failure diagnostic/);
    assert.doesNotMatch(sent[0].text, /@all|@outsider|@worker/);
    assert.deepEqual(
      store.inbox('worker').map((message) => message.id),
      [trigger.id],
    );
    assert.equal(store.inbox('outsider').length, 0);
    assert.equal(store.inbox('lead').length, kind === 'room' ? 1 : 0);
  });

test('native sessions, assignment context and reply recipients are scoped to each conversation', async (t) => {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  store.createAgent({ id: 'worker', role: 'worker', adapter: 'claude', cwd: ROOT, task: 'PRIVATE_COMMON_ASSIGNMENT' });
  store.updateAgent('worker', { sessionId: 'legacy-common', sessionIds: { common: 'legacy-common' } });
  store.createConversation({
    id: 'task-room',
    kind: 'room',
    name: 'Task',
    members: ['user', 'lead', 'worker'],
    createdBy: 'lead',
    sourceConversationId: 'dm-lead',
  });
  const calls = [],
    sent = [];
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: {
      state: { connected: true },
      async send(from, text, conversationId) {
        sent.push({ from, text, conversationId });
      },
    },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
  });
  runner.execute = async (command, agent, message, prompt) => {
    calls.push({ sessionId: agent.sessionId, args: command.args, conversationId: message.conversationId, prompt });
    return readTurn(
      command.format,
      JSON.stringify({
        type: 'result',
        session_id: `session-${message.conversationId}`,
        result: 'Complete with evidence.',
      }),
    );
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  for (const [index, conversationId] of ['common', 'dm-worker', 'task-room', 'dm-worker', 'common'].entries()) {
    store.addMessage(`task-${index}`, 'user', '@worker Report', conversationId);
    runner.kick();
    await until(() => !runner.active.size);
    assert.equal(store.inbox('worker').length, 0);
  }
  assert.deepEqual(
    calls.map((call) => call.sessionId),
    ['legacy-common', null, null, 'session-dm-worker', 'session-common'],
  );
  assert.equal(calls[1].args.includes('--resume'), false);
  assert.equal(calls[2].args.includes('--resume'), false);
  assert.match(calls[2].prompt, /request originated in dm-lead/);
  assert.match(calls[1].prompt, /standalone shell tool call/);
  assert.match(calls[0].prompt, /PRIVATE_COMMON_ASSIGNMENT/);
  assert.doesNotMatch(calls[1].prompt, /PRIVATE_COMMON_ASSIGNMENT/);
  assert.doesNotMatch(calls[2].prompt, /PRIVATE_COMMON_ASSIGNMENT/);
  assert.match(sent[1].text, /^@user\b/);
  assert.match(sent[2].text, /^@lead\b/);
  assert.deepEqual(
    sent.map((message) => message.conversationId),
    ['common', 'dm-worker', 'task-room', 'dm-worker', 'common'],
  );
  assert.deepEqual(store.agent('worker').sessionIds, {
    common: 'session-common',
    'dm-worker': 'session-dm-worker',
    'task-room': 'session-task-room',
  });
});

test('automatic recipient prefixes preserve a leading Markdown heading', async (t) => {
  const { custom } = await fixture(t, '## Findings\n\nThe requested investigation is complete.');
  const store = new Store();
  store.createAgent({ id: 'worker', role: 'worker', adapter: 'fixture', cwd: ROOT, task: '' });
  store.addMessage('task', 'user', 'Write the report', 'dm-worker');
  const sent = [];
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: {
      state: { connected: true },
      async send(_from, value) {
        sent.push(value);
      },
    },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom,
  });
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  runner.kick();
  await until(() => !runner.active.size);
  assert.ok(lexer(sent[0]).some((token) => token.type === 'heading' && token.depth === 2 && token.text === 'Findings'));
});

async function routedReplies(t, { from, reply, agentId = 'worker', autoRouted = false, stopped = [] }) {
  const store = new Store();
  for (const [id, role] of [
    ['lead', 'lead'],
    ['worker', 'worker'],
    ['peer', 'worker'],
  ])
    store.createAgent({ id, role, adapter: 'claude', cwd: ROOT, task: '' });
  store.createConversation({
    id: 'task-room',
    kind: 'room',
    name: 'Task',
    members: ['user', 'lead', 'worker', 'peer'],
    createdBy: 'lead',
  });
  for (const id of stopped) store.updateAgent(id, { status: 'stopped' });
  const sent = [];
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: {
      state: { connected: true },
      async send(sender, text, conversationId, meta) {
        sent.push({ sender, text, conversationId, meta });
      },
    },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
  });
  runner.execute = async (command) =>
    readTurn(command.format, JSON.stringify({ type: 'result', session_id: 's', result: reply }));
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  store.addMessage('trigger', from, `@${agentId} please do it`, 'task-room', { autoRouted });
  runner.kick();
  await until(() => !runner.active.size);
  return Object.assign(sent, { store });
}

test('a final reply without a mention reaches the agent that started the turn', async (t) => {
  const sent = await routedReplies(t, { from: 'peer', reply: 'Done, no mention here.' });
  assert.equal(sent[0].text, '@peer\n\nDone, no mention here.');
  assert.equal(sent[0].meta.autoRouted, true);
});

test('mentions in code spans, scoped package names and emails address nobody, so the reply reaches the requester', async (t) => {
  const sent = await routedReplies(t, { from: 'lead', reply: 'Report for `@lead`, see @air/air-cloud and a@b.com' });
  assert.match(sent[0].text, /^@lead\n\n/);
});

test('a reply addressed to another member goes only to that member, not also to the requester', async (t) => {
  for (const reply of [
    '@peer Review round 1/3: one blocking finding.',
    'Escalating to @user.',
    'Asking @user to decide.',
  ]) {
    const sent = await routedReplies(t, { from: 'lead', reply });
    assert.equal(sent[0].text, reply);
    assert.equal(sent[0].meta.autoRouted, false);
  }
});

test('a mention of a non-member or of the replying agent itself does not address the reply', async (t) => {
  for (const reply of ['Ping @ghost about it.', 'Noted by @worker.']) {
    const sent = await routedReplies(t, { from: 'lead', reply });
    assert.equal(sent[0].text, `@lead\n\n${reply}`);
  }
});

test('a mention of a stopped member does not address the reply, so the report reaches the requester', async (t) => {
  const sent = await routedReplies(t, { from: 'lead', reply: 'Done; the review ran with @peer.', stopped: ['peer'] });
  assert.equal(sent[0].text, '@lead\n\nDone; the review ran with @peer.');
  assert.equal(sent[0].meta.autoRouted, true);
  const live = await routedReplies(t, { from: 'lead', reply: 'Done; cc @peer.' });
  assert.equal(live[0].text, 'Done; cc @peer.');
});

test('a report never lands in the inbox of a stopped requester or lead', async (t) => {
  /** @type {[string, string[], string, string?][]} */
  const cases = [
    ['peer', ['peer'], 'lead'],
    ['peer', ['peer', 'lead'], 'user'],
    ['user', ['lead'], 'user'],
  ];
  for (const reply of ['Done; @worker handled it.', 'Done; ask @ghost later.'])
    cases.push(['peer', ['peer'], 'lead', reply]);
  for (const [from, stopped, recipient, reply = 'Done.'] of cases) {
    const sent = await routedReplies(t, { from, reply, stopped });
    assert.equal(sent[0].text, `@${recipient}\n\n${reply}`);
    const stored = sent.store.addMessage('report', 'worker', sent[0].text, 'task-room', sent[0].meta);
    const holders = ['lead', 'peer'].filter((id) => sent.store.inbox(id).some((item) => item.id === stored.id));
    assert.deepEqual(holders, recipient === 'lead' ? ['lead'] : []);
  }
});

test('a reply that already mentions the requester or @all is posted unchanged and not flagged', async (t) => {
  for (const reply of ['@lead done', 'Done @all']) {
    const sent = await routedReplies(t, { from: 'lead', reply });
    assert.equal(sent[0].text, reply);
    assert.equal(sent[0].meta.autoRouted, false);
  }
});

test('a reply to an automatically routed message is not routed back to its sender', async (t) => {
  const sent = await routedReplies(t, { from: 'peer', reply: 'Thanks, noted.', autoRouted: true });
  assert.equal(sent[0].text, '@lead\n\nThanks, noted.');
  const lead = await routedReplies(t, { from: 'peer', reply: 'Thanks, noted.', autoRouted: true, agentId: 'lead' });
  assert.equal(lead[0].text, '@user\n\nThanks, noted.');
  const mentioned = await routedReplies(t, { from: 'peer', reply: 'Ask @lead.', autoRouted: true });
  assert.equal(mentioned[0].text, 'Ask @lead.');
});

test('two agents that both reply without mentions stop after one automatic hop', async (t) => {
  const store = new Store();
  for (const [id, role] of [
    ['lead', 'lead'],
    ['worker', 'worker'],
  ])
    store.createAgent({ id, role, adapter: 'claude', cwd: ROOT, task: '' });
  store.createConversation({
    id: 'task-room',
    kind: 'room',
    name: 'Task',
    members: ['user', 'lead', 'worker'],
    createdBy: 'lead',
  });
  let turns = 0;
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: {
      state: { connected: true },
      async send(from, text, conversationId, meta) {
        store.addMessage(`m${turns}`, from, text, conversationId, meta);
      },
    },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
  });
  runner.execute = async (command) => {
    turns++;
    return readTurn(command.format, JSON.stringify({ type: 'result', session_id: 's', result: 'Acknowledged.' }));
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  store.addMessage('start', 'lead', '@worker go', 'task-room');
  for (let i = 0; i < 10; i++) {
    runner.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await until(() => !runner.active.size);
  }
  assert.equal(turns, 2);
});

test('a review loop between two workers ends with one report to the lead and wakes nobody after it', async (t) => {
  const store = new Store();
  for (const [id, role] of [
    ['lead', 'lead'],
    ['impl', 'worker'],
    ['reviewer', 'worker'],
  ])
    store.createAgent({ id, role, adapter: 'claude', cwd: ROOT, task: '' });
  store.createConversation({
    id: 'task-room',
    kind: 'room',
    name: 'Task',
    members: ['user', 'lead', 'impl', 'reviewer'],
    createdBy: 'lead',
  });
  // Each agent answers its turns in order, as the worker skill's review loop prescribes; the lead returns NO_REPLY to the final report.
  const script = {
    reviewer: ['@impl Review round 1/3: blocking finding in a.mjs:3.', '@impl Review round 2/3: pass at c2.'],
    impl: ['@reviewer Fixed in c2.', '@lead Done: c2 merged, review passed in round 2/3.'],
    lead: ['NO_REPLY'],
  };
  const turns = { lead: 0, impl: 0, reviewer: 0 };
  let posted = 0;
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: {
      state: { connected: true },
      async send(from, text, conversationId, meta) {
        store.addMessage(`m${posted++}`, from, text, conversationId, meta);
      },
    },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
  });
  runner.execute = async (_command, agent) =>
    readTurn(
      'claude',
      JSON.stringify({
        type: 'result',
        session_id: 's',
        result: script[agent.id][turns[agent.id]++] ?? 'unexpected turn',
      }),
    );
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  store.addMessage('start', 'lead', '@reviewer Review c1 by `impl`.', 'task-room');
  for (let i = 0; i < 12; i++) {
    runner.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await until(() => !runner.active.size);
  }
  assert.deepEqual(turns, { lead: 1, impl: 2, reviewer: 2 });
  const texts = store.messages(300, 'task-room').map((message) => message.text);
  assert.equal(texts.filter((text) => /^@lead\b/.test(text)).length, 1);
  assert.equal(texts.at(-1), '@lead Done: c2 merged, review passed in round 2/3.');
});

test('a group that refuses with EPERM gets the signal through its unreaped leader, and other refusals stay fatal', (t) => {
  const runner = Object.create(Runner.prototype);
  const kill = (group, leader = group) => {
    const calls = [];
    t.mock.method(process, 'kill', (pid) => {
      calls.push(pid);
      const code = pid < 0 ? group : leader;
      if (code) throw Object.assign(new Error(code), { code });
    });
    return calls;
  };
  let calls = kill('EPERM', null);
  assert.doesNotThrow(() => runner.signal({ child: { pid: 4242, exitCode: null, signalCode: null } }, 'SIGTERM'));
  assert.deepEqual(calls, [-4242, 4242], 'the unreaped leader is signalled directly');
  t.mock.restoreAll();
  calls = kill('EPERM');
  assert.doesNotThrow(() => runner.signal({ child: { pid: 4242, exitCode: 0, signalCode: null } }, 'SIGTERM'));
  assert.doesNotThrow(() => runner.signal({ child: { pid: 4242, exitCode: null, signalCode: 'SIGKILL' } }, 'SIGTERM'));
  assert.deepEqual(calls, [-4242, -4242], 'a reaped leader is not signalled, because its process ID may be reused');
  assert.throws(() => runner.signal({ child: { pid: 4242, exitCode: null, signalCode: null } }, 'SIGTERM'), {
    code: 'EPERM',
  });
  t.mock.restoreAll();
  kill('ESRCH');
  assert.doesNotThrow(() => runner.signal({ child: { pid: 4242, exitCode: null, signalCode: null } }, 'SIGTERM'));
  t.mock.restoreAll();
  kill('EINVAL');
  assert.throws(() => runner.signal({ child: { pid: 4242, exitCode: 0, signalCode: null } }, 'SIGTERM'), {
    code: 'EINVAL',
  });
});
