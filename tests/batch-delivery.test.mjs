import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Runner } from '../src/runner.mjs';
import { readTurn, turnReply } from '../src/adapters.mjs';
import { ROOT } from '../src/server.mjs';
import { testIdentity } from './identity-fixture.mjs';

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// The fixture adapter records each turn's newest message and prompt. A turn whose prompt contains HOLD-GATE waits
// until the file `release` exists; any turn fails while the file `fail` exists. Its reply mentions nobody.
async function fixture(t) {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.tmp/batch-delivery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'adapter.mjs');
  const runsFile = join(directory, 'runs.jsonl');
  await writeFile(
    script,
    `import { appendFileSync, existsSync } from 'node:fs';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(runsFile)}, JSON.stringify({ id: Number(process.env.MU_MESSAGE_ID), prompt }) + '\\n');
if (prompt.includes('HOLD-GATE')) while (!existsSync(${JSON.stringify(join(directory, 'release'))})) await new Promise((r) => setTimeout(r, 10));
if (existsSync(${JSON.stringify(join(directory, 'fail'))})) process.exit(3);
console.log('done ' + process.env.MU_MESSAGE_ID);
`,
  );
  const runs = async () =>
    existsSync(runsFile)
      ? (await readFile(runsFile, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return {
    directory,
    runs,
    release: () => writeFile(join(directory, 'release'), ''),
    custom: { fixture: { command: process.execPath, args: [script] } },
  };
}

function team(store) {
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: 'Coordinate' });
  store.createAgent({ id: 'reviewer', role: 'worker', adapter: 'manual', cwd: ROOT, task: 'Review' });
  store.createAgent({ id: 'worker', role: 'worker', adapter: 'fixture', cwd: ROOT, task: 'Build' });
  for (const id of ['room-a', 'room-b'])
    store.createConversation({
      id,
      kind: 'room',
      name: id,
      members: ['lead', 'reviewer', 'worker'],
      createdBy: 'lead',
    });
}

// Posts replies as messages, as the real chat does, and records every completed turn's acknowledgements.
/**
 * @param {import('node:test').TestContext} t
 * @param {Store} store
 * @param {Record<string, { command: string, args: string[] }>} custom
 * @param {{ failSend?: (from: string) => boolean }} [options]
 */
function harness(t, store, custom, { failSend = () => false } = {}) {
  const sent = [];
  const chat = {
    state: { connected: true },
    async send(from, text, conversationId, meta) {
      if (failSend(from)) throw new Error('IRC confirmation failed');
      sent.push({ from, text, conversationId });
      return store.addMessage(`reply-${sent.length}-${Math.random()}`, from, text, conversationId, meta);
    },
  };
  const acknowledged = [];
  const completeTurn = store.completeTurn.bind(store);
  store.completeTurn = (id, messageIds, patch) => {
    const result = completeTurn(id, messageIds, patch);
    acknowledged.push(messageIds);
    return result;
  };
  const runner = new Runner({
    home: ROOT,
    identity: testIdentity(t),
    store,
    chat,
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom,
  });
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
  });
  return { runner, sent, acknowledged };
}

const post = (store, from, text, conversationId = 'room-a') =>
  store.addMessage(`${from}-${text}-${Math.random()}`, from, text, conversationId);
const pendingIds = (store) => store.inbox('worker').map((message) => message.id);
const settled = (runner) => until(() => !runner.active.size);

test('messages that arrive during a turn are delivered together in the next turn, in order', async (t) => {
  const { runs, release, custom } = await fixture(t);
  const store = new Store();
  t.after(() => store.close());
  team(store);
  const { runner, sent, acknowledged } = harness(t, store, custom);
  const first = post(store, 'lead', '@worker HOLD-GATE first');
  runner.kick();
  await until(() => runner.active.get('worker')?.child);
  const second = post(store, 'lead', '@worker second request');
  const third = post(store, 'reviewer', '@worker third request');
  runner.kick();
  await release();
  await until(() => !pendingIds(store).length && !runner.active.size);

  const [, burst] = await runs();
  assert.equal((await runs()).length, 2);
  assert.equal(burst.id, third.id);
  assert.match(burst.prompt, /2 chat messages are queued for you in this conversation, oldest first\./);
  const secondAt = burst.prompt.indexOf(`Incoming chat message #${second.id} from @lead:\n@worker second request`);
  const thirdAt = burst.prompt.indexOf(`Incoming chat message #${third.id} from @reviewer:\n@worker third request`);
  assert.ok(secondAt !== -1 && thirdAt > secondAt, burst.prompt);
  assert.ok(!burst.prompt.includes('HOLD-GATE first'));
  assert.deepEqual(acknowledged, [[first.id], [second.id, third.id]]);
  // An unaddressed reply reaches the sender of every message it answers.
  assert.deepEqual(
    sent.map(({ text }) => text),
    [`@lead\n\ndone ${first.id}`, `@lead @reviewer\n\ndone ${third.id}`],
  );
  for (const id of ['lead', 'reviewer'])
    assert.ok(
      store.inbox(id).some(({ text }) => text.endsWith(`done ${third.id}`)),
      `@${id} was not reached`,
    );
  assert.equal(store.agent('worker').activeMessageId, null);
  assert.equal(store.agent('worker').status, 'idle');
});

test('one turn covers one conversation; a message of another conversation waits for its own turn', async (t) => {
  const { runs, custom } = await fixture(t);
  const store = new Store();
  t.after(() => store.close());
  team(store);
  const { runner, acknowledged } = harness(t, store, custom);
  const a1 = post(store, 'lead', '@worker a1', 'room-a');
  const b1 = post(store, 'lead', '@worker b1', 'room-b');
  const a2 = post(store, 'lead', '@worker a2', 'room-a');
  runner.kick();
  await until(() => !pendingIds(store).length && !runner.active.size);
  const turns = await runs();
  assert.deepEqual(
    turns.map(({ id }) => id),
    [a2.id, b1.id],
  );
  assert.match(turns[0].prompt, /Conversation: room-a /);
  assert.ok(turns[0].prompt.includes('@worker a1') && turns[0].prompt.includes('@worker a2'));
  assert.ok(!turns[0].prompt.includes('@worker b1'));
  assert.match(turns[1].prompt, /Conversation: room-b /);
  assert.ok(!turns[1].prompt.includes('chat messages are queued'));
  assert.deepEqual(acknowledged, [[a1.id, a2.id], [b1.id]]);
});

test('a failed turn leaves all of its messages pending, and the retry delivers them again with later ones', async (t) => {
  const { directory, runs, custom } = await fixture(t);
  const store = new Store();
  t.after(() => store.close());
  team(store);
  const { runner, sent, acknowledged } = harness(t, store, custom);
  await writeFile(join(directory, 'fail'), '');
  const first = post(store, 'lead', '@worker first');
  const second = post(store, 'reviewer', '@worker second');
  runner.kick();
  await until(() => store.agent('worker').status === 'error');
  await settled(runner);
  assert.deepEqual(pendingIds(store), [first.id, second.id]);
  assert.deepEqual(acknowledged, []);
  assert.equal(store.agent('worker').activeMessageId, null);
  const [notice] = sent;
  assert.equal(notice.from, 'system');
  assert.match(notice.text, /^@lead @user @reviewer Mu runtime: agent worker could not complete messages #\d+, #\d+: /);
  assert.ok(notice.text.includes(`messages #${first.id}, #${second.id}:`));
  assert.match(notice.text, /The messages remain pending; no automatic retry was started\./);

  await rm(join(directory, 'fail'));
  const third = post(store, 'lead', '@worker third');
  store.updateAgent('worker', { status: 'idle' });
  runner.kick();
  await until(() => !pendingIds(store).length && !runner.active.size);
  const retry = (await runs()).at(-1);
  assert.equal((await runs()).length, 2);
  assert.equal(retry.id, third.id);
  const positions = [first, second, third].map(({ id }) => retry.prompt.indexOf(`Incoming chat message #${id} `));
  assert.ok(positions[0] !== -1 && positions[0] < positions[1] && positions[1] < positions[2], retry.prompt);
  assert.deepEqual(acknowledged, [[first.id, second.id, third.id]]);
});

test('a saved result acknowledges exactly the messages of its turn, and later ones get their own turn', async (t) => {
  const { runs, custom } = await fixture(t);
  const store = new Store();
  t.after(() => store.close());
  team(store);
  let sendFails = true;
  const { runner, sent, acknowledged } = harness(t, store, custom, {
    failSend: (from) => from === 'worker' && sendFails,
  });
  const first = post(store, 'lead', '@worker first');
  const second = post(store, 'lead', '@worker second');
  runner.kick();
  await until(() => store.agent('worker').status === 'error');
  await settled(runner);
  assert.deepEqual(store.agent('worker').pendingResult.messageIds, [first.id, second.id]);
  assert.match(sent[0].text, /saved; explicitly resuming delivers that response without running the task again/);

  const third = post(store, 'lead', '@worker third');
  sendFails = false;
  store.updateAgent('worker', { status: 'idle' });
  runner.kick();
  await until(() => !pendingIds(store).length && !runner.active.size);
  assert.deepEqual(
    (await runs()).map(({ id }) => id),
    [second.id, third.id],
  );
  assert.deepEqual(
    sent.filter(({ from }) => from === 'worker').map(({ text }) => text),
    [`@lead\n\ndone ${second.id}`, `@lead\n\ndone ${third.id}`],
  );
  assert.deepEqual(acknowledged, [[first.id, second.id], [third.id]]);
  assert.equal(store.agent('worker').pendingResult, null);
});

test('a saved result whose messages are no longer all pending is not delivered, and nothing is acknowledged', async (t) => {
  const { runs, custom } = await fixture(t);
  const store = new Store();
  t.after(() => store.close());
  team(store);
  const first = post(store, 'lead', '@worker first');
  const second = post(store, 'lead', '@worker second');
  const third = post(store, 'lead', '@worker third');
  store.updateAgent('worker', {
    status: 'idle',
    pendingResult: { messageIds: [first.id, second.id], conversationId: 'room-a', text: '@lead saved', status: 'idle' },
  });
  store.ack('worker', first.id);
  const { runner, sent, acknowledged } = harness(t, store, custom);
  runner.kick();
  await until(() => store.agent('worker').status === 'error');
  await settled(runner);
  assert.match(store.agent('worker').lastError, /Saved result does not match the next inbox messages/);
  assert.deepEqual(pendingIds(store), [second.id, third.id]);
  assert.deepEqual(acknowledged, []);
  assert.deepEqual(await runs(), []);
  assert.deepEqual(
    sent.map(({ from }) => from),
    ['system'],
  );
});

test('turn completion acknowledges all of its messages or none of them', () => {
  const store = new Store();
  team(store);
  const first = post(store, 'lead', '@worker first');
  store.updateAgent('worker', { status: 'working', activeMessageId: first.id });
  assert.throws(() => store.completeTurn('worker', [first.id, 999999], { status: 'idle' }), /999999 is not pending/);
  assert.deepEqual(pendingIds(store), [first.id]);
  assert.equal(store.agent('worker').status, 'working');
  assert.throws(() => store.completeTurn('worker', [], { status: 'idle' }), /at least one message/);
  store.completeTurn('worker', [first.id], { status: 'idle', activeMessageId: null });
  assert.deepEqual(pendingIds(store), []);
  assert.throws(() => store.completeTurn('worker', [first.id], { status: 'idle' }), /is not pending/);
  store.close();
});

test('a burst larger than the batch budget is split across turns without losing or reordering a message', async (t) => {
  const { runs, custom } = await fixture(t);
  const store = new Store();
  t.after(() => store.close());
  team(store);
  const { runner, acknowledged } = harness(t, store, custom);
  // Four of these fit the 256 KiB budget of a turn; the fifth does not.
  const posted = [1, 2, 3, 4, 5].map((index) => post(store, 'lead', `@worker part ${index} ${'x'.repeat(60000)}`));
  runner.kick();
  await until(() => !pendingIds(store).length && !runner.active.size);
  const ids = posted.map(({ id }) => id);
  assert.deepEqual(acknowledged, [ids.slice(0, 4), ids.slice(4)]);
  assert.deepEqual(
    (await runs()).map(({ id }) => id),
    [ids[3], ids[4]],
  );
});

test('a turn interrupted by shutdown resumes with all of its messages and names them in the prompt', async (t) => {
  const { runs, release, custom } = await fixture(t);
  const store = new Store();
  t.after(() => store.close());
  team(store);
  let { runner, acknowledged } = harness(t, store, custom);
  const first = post(store, 'lead', '@worker HOLD-GATE first');
  const second = post(store, 'lead', '@worker second');
  runner.kick();
  await until(() => runner.active.get('worker')?.child);
  runner.close();
  await settled(runner);
  assert.equal(store.agent('worker').interruptedMessageId, second.id);
  assert.deepEqual(pendingIds(store), [first.id, second.id]);
  assert.deepEqual(acknowledged, []);

  const third = post(store, 'lead', '@worker third');
  await release();
  ({ runner, acknowledged } = harness(t, store, custom));
  runner.kick();
  await until(() => !pendingIds(store).length && !runner.active.size);
  const resumed = (await runs()).at(-1);
  assert.equal(resumed.id, third.id);
  assert.ok(
    resumed.prompt.includes(
      `The Mu service shut down while you were handling messages #${first.id}, #${second.id} and terminated that turn`,
    ),
    resumed.prompt,
  );
  assert.deepEqual(acknowledged, [[first.id, second.id, third.id]]);
  assert.equal(store.agent('worker').interruptedMessageId, null);
});

test('a saved result from before turns covered several messages is migrated and delivered once', async (t) => {
  const { directory, runs, custom } = await fixture(t);
  const filename = join(directory, 'state.sqlite');
  let store = new Store(filename);
  team(store);
  const message = post(store, 'lead', '@worker first');
  store.updateAgent('worker', {
    status: 'error',
    pendingResult: { messageId: message.id, conversationId: 'room-a', text: '@lead saved', status: 'idle' },
  });
  store.close();
  store = new Store(filename);
  t.after(() => store.close());
  assert.deepEqual(store.agent('worker').pendingResult, {
    messageIds: [message.id],
    conversationId: 'room-a',
    text: '@lead saved',
    status: 'idle',
  });
  const { runner, sent, acknowledged } = harness(t, store, custom);
  store.updateAgent('worker', { status: 'idle' });
  runner.kick();
  await until(() => !pendingIds(store).length && !runner.active.size);
  assert.deepEqual(sent, [{ from: 'worker', text: '@lead saved', conversationId: 'room-a' }]);
  assert.deepEqual(acknowledged, [[message.id]]);
  assert.deepEqual(await runs(), []);
});

const claudeEvents = (...results) =>
  [
    { type: 'system', subtype: 'init', session_id: 'session-1', model: 'claude-opus-5-5' },
    ...results.map((result) => ({
      type: 'result',
      subtype: 'success',
      session_id: 'session-1',
      is_error: false,
      result,
    })),
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
const claudeReply = (...results) => turnReply('claude', readTurn('claude', claudeEvents(...results))).text;

test('a Claude reply is not replaced by a NO_REPLY from a later response of the same process', () => {
  const report = '@lead Draft PR is open; tests pass.';
  assert.equal(claudeReply(report, 'NO_REPLY'), report);
  assert.equal(claudeReply('NO_REPLY', report), report);
  assert.equal(claudeReply(report, 'Background build finished too.'), `${report}\n\nBackground build finished too.`);
  assert.equal(claudeReply('NO_REPLY', 'NO_REPLY'), 'NO_REPLY');
  assert.equal(claudeReply(report), report);
  assert.throws(() => claudeReply(''), /claude produced no final response/);
  const failed = [
    { type: 'result', is_error: true, result: '@lead report', errors: ['API overloaded'] },
    { type: 'result', is_error: false, result: 'NO_REPLY' },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  assert.throws(() => turnReply('claude', readTurn('claude', failed)), /API overloaded/);
});

test('a final line that is exactly NO_REPLY after text is dropped, and the text is the reply', () => {
  assert.equal(claudeReply('@lead Report.\n\nNO_REPLY'), '@lead Report.');
  assert.equal(claudeReply('@lead Report.\nNO_REPLY  \n'), '@lead Report.');
  assert.equal(claudeReply('  NO_REPLY\n'), 'NO_REPLY');
  // Only a bare final line counts; other mentions of the token are text.
  assert.equal(claudeReply('@lead Done NO_REPLY'), '@lead Done NO_REPLY');
  assert.equal(claudeReply('NO_REPLY\n@lead Report.'), 'NO_REPLY\n@lead Report.');
  const codex = JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: '@lead Report.\nNO_REPLY' },
  });
  assert.equal(turnReply('codex', readTurn('codex', codex)).text, '@lead Report.');
  assert.equal(turnReply('text', { stdout: '@lead Report.\n\nNO_REPLY\n' }).text, '@lead Report.');
  assert.equal(turnReply('text', { stdout: 'NO_REPLY\n' }).text, 'NO_REPLY');
});

test('the runner posts a Claude report that a later NO_REPLY response would have replaced', async (t) => {
  const store = new Store();
  t.after(() => store.close());
  team(store);
  store.updateAgent('worker', { adapter: 'claude' });
  const { runner, sent, acknowledged } = harness(t, store, {});
  runner.execute = async () => readTurn('claude', claudeEvents('Draft PR is open; tests pass.', 'NO_REPLY'));
  const request = post(store, 'lead', '@worker open the PR');
  runner.kick();
  await until(() => !pendingIds(store).length && !runner.active.size);
  assert.equal(store.agent('worker').lastError, null);
  assert.deepEqual(sent, [
    { from: 'worker', text: '@lead\n\nDraft PR is open; tests pass.', conversationId: 'room-a' },
  ]);
  assert.deepEqual(acknowledged, [[request.id]]);
});

test('a burst reply keeps the single-message routing rules for each message it answers', async (t) => {
  const store = new Store();
  t.after(() => store.close());
  team(store);
  store.updateAgent('worker', { adapter: 'claude' });
  const { runner, sent } = harness(t, store, {});
  let reply = '';
  runner.execute = async () => readTurn('claude', claudeEvents(reply));
  const turn = async (text, messages) => {
    reply = text;
    for (const [from, body, meta] of messages)
      store.addMessage(`${from}-${body}-${Math.random()}`, from, body, 'room-a', meta);
    runner.kick();
    await until(() => !pendingIds(store).length && !runner.active.size);
    assert.equal(store.agent('worker').lastError, null);
    return sent.at(-1).text;
  };
  // A reply that addresses a member is the agent's own routing choice.
  assert.equal(
    await turn('@reviewer Fixed.', [
      ['lead', '@worker status?'],
      ['reviewer', '@worker verdict'],
    ]),
    '@reviewer Fixed.',
  );
  // Replies to automatically routed messages go to the lead, so two agents cannot answer each other indefinitely.
  assert.equal(
    await turn('Noted.', [
      ['reviewer', '@worker one', { autoRouted: true }],
      ['reviewer', '@worker two', { autoRouted: true }],
    ]),
    '@lead\n\nNoted.',
  );
  // The user's request falls back to the lead, which the lead's own message names once.
  assert.equal(
    await turn('Done.', [
      ['user', '@worker do it'],
      ['lead', '@worker and this'],
    ]),
    '@lead\n\nDone.',
  );
});

test('a reply posted while the agent is stopped is acknowledged and not posted again on resume', async (t) => {
  const { runs, custom } = await fixture(t);
  const store = new Store();
  t.after(() => store.close());
  team(store);
  const sent = [];
  /** @type {(value?: unknown) => void} */
  let finishSend;
  const chat = {
    state: { connected: true },
    async send(from, text, conversationId) {
      sent.push({ from, text, conversationId });
      if (from === 'worker' && sent.length === 1) await new Promise((resolve) => (finishSend = resolve));
    },
  };
  const runner = new Runner({
    home: ROOT,
    identity: testIdentity(t),
    store,
    chat,
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom,
  });
  t.after(async () => {
    runner.close();
    await settled(runner);
  });
  const request = post(store, 'lead', '@worker first');
  runner.kick();
  await until(() => finishSend);
  runner.stop('worker');
  finishSend();
  await settled(runner);
  assert.deepEqual(pendingIds(store), []);
  assert.equal(store.agent('worker').pendingResult, null);
  assert.equal(store.agent('worker').status, 'stopped');
  store.updateAgent('worker', { status: 'idle' });
  runner.kick();
  await settled(runner);
  assert.deepEqual(
    sent.map(({ text }) => text),
    [`@lead\n\ndone ${request.id}`],
  );
  assert.equal((await runs()).length, 1);
});
