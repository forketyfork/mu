import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { temporaryMuHome } from './isolation.mjs';
import { Runner } from '../src/runner.mjs';
import { readTurn } from '../src/adapters.mjs';
import { CodexRollouts } from '../src/codex-rollout.mjs';
import { Store } from '../src/store.mjs';
import { ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { testIdentity } from './identity-fixture.mjs';

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runnerFor(t, store, options = {}) {
  const sent = [];
  const chat = {
    state: { connected: true },
    async send(from, text, conversationId, meta) {
      sent.push(text);
      return store.addMessage(`sent-${sent.length}`, from, text, conversationId, meta);
    },
  };
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat,
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    codexRollouts: new CodexRollouts(join(ROOT, '.tmp/no-codex-home')),
    pricing: offlinePricing(),
    ...options,
  });
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  return { runner, sent };
}

function leadOutput(format, text) {
  return readTurn(format, format === 'text' ? text : JSON.stringify({ type: 'result', result: text }));
}

async function turn(runner, store, id, text) {
  store.addMessage(id, 'user', text, 'dm-lead');
  runner.kick();
  await until(() => !runner.active.size && store.agent('lead').status === 'idle');
}

test('lead prompts list only active tasks with no waiting card and no working or blocked workers', async (t) => {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT, task: 'Coordinate' });
  for (const [id, status] of [
    ['idle-worker', 'idle'],
    ['done-worker', 'done'],
    ['stopped-worker', 'stopped'],
    ['working-worker', 'working'],
    ['blocked-worker', 'blocked'],
  ]) {
    store.createAgent({ id, role: 'worker', adapter: 'manual', cwd: ROOT, task: '' });
    store.updateAgent(id, { status });
  }
  const taskContext = () => ({
    tasks: [
      {
        id: 'quiet-task',
        title: 'Review the completed result',
        status: 'active',
        agentIds: ['idle-worker', 'done-worker', 'stopped-worker'],
      },
      { id: 'waiting-task', title: 'Has an open decision', status: 'active', agentIds: ['idle-worker'] },
      { id: 'working-task', title: 'Still running', status: 'active', agentIds: ['working-worker'] },
      { id: 'blocked-task', title: 'Worker is blocked', status: 'active', agentIds: ['blocked-worker'] },
      { id: 'ready-task', title: 'Already marked ready', status: 'ready', agentIds: ['idle-worker'] },
      { id: 'unassigned-task', title: 'No workers assigned', status: 'active', agentIds: [] },
      ...Array.from({ length: 25 }, (_, index) => ({
        id: `bulk-task-${String(index).padStart(2, '0')}`,
        title: `Bulk task ${index}`,
        status: 'active',
        agentIds: [],
      })),
    ],
    waiting: [{ id: 'wait-00000001', text: 'Open decision', taskId: 'waiting-task' }],
  });
  const { runner } = await runnerFor(t, store, { leadTaskContext: taskContext });
  const prompts = [];
  runner.execute = async (command, _agent, _message, value) => {
    prompts.push(value);
    return leadOutput(command.format, 'NO_REPLY');
  };

  await turn(runner, store, 'task-context-trigger', 'Check the work');

  assert.ok(prompts[0]);
  const prompt = prompts[0].split('Open "Waiting for you" cards')[0];
  assert.ok(prompt.includes('quiet-task — Review the completed result'));
  assert.ok(prompt.includes('unassigned-task — No workers assigned'));
  assert.ok(prompt.includes('bulk-task-17 — Bulk task 17'));
  assert.doesNotMatch(prompt, /bulk-task-18/);
  assert.ok(prompt.includes('7 more active tasks meet this condition'));
  assert.ok(prompt.includes('task list'));
  for (const id of ['waiting-task', 'working-task', 'blocked-task', 'ready-task'])
    assert.doesNotMatch(prompt, new RegExp(id));
});

test('lead turn for a user message in the direct chat lists the open waiting cards', async (t) => {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT, task: 'Coordinate' });
  const cards = Array.from({ length: 22 }, (_, index) => ({
    id: `wait-0000000${index % 10}`,
    text: `Decision ${index}`,
    taskId: index === 0 ? 'task-linked' : null,
  }));
  const { runner } = await runnerFor(t, store, { leadTaskContext: () => ({ tasks: [], waiting: cards }) });
  const prompts = [];
  runner.execute = async (command, _agent, _message, value) => {
    prompts.push(value);
    return leadOutput(command.format, 'NO_REPLY');
  };

  await turn(runner, store, 'cards-direct-user', 'Go ahead with the release');
  assert.ok(prompts[0].includes('wait-00000000 — Decision 0 (task task-linked)'));
  assert.ok(prompts[0].includes('wait-00000001 — Decision 1\n'));
  assert.ok(prompts[0].includes('Decision 19'));
  assert.doesNotMatch(prompts[0], /Decision 20/);
  assert.ok(prompts[0].includes('2 more cards are open'));
  assert.ok(prompts[0].includes('remove it in this turn'));

  store.createConversation({ id: 'card-room', kind: 'room', name: 'Card room', members: ['lead'] });
  store.addMessage('cards-room-user', 'user', '@lead Room question', 'card-room');
  runner.kick();
  await until(() => prompts.length === 2 && !runner.active.size && store.agent('lead').status === 'idle');
  assert.doesNotMatch(prompts[1], /Open "Waiting for you" cards/);
});

test('lead turn omits the card block when there are no cards', async (t) => {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT, task: 'Coordinate' });
  let waiting = [];
  const { runner } = await runnerFor(t, store, { leadTaskContext: () => ({ tasks: [], waiting }) });
  const prompts = [];
  runner.execute = async (command, _agent, _message, value) => {
    prompts.push(value);
    return leadOutput(command.format, 'NO_REPLY');
  };

  await turn(runner, store, 'no-cards-direct', 'Hello');
  assert.doesNotMatch(prompts[0], /Open "Waiting for you" cards/);

  waiting = [{ id: 'wait-00000001', text: 'Approve the release', taskId: null }];
  await turn(runner, store, 'cards-second', 'Approved');
  assert.ok(prompts[1].includes('wait-00000001 — Approve the release\n'));
});

test('lead turns name stale service code in every conversation until the code is current again', async (t) => {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT, task: 'Coordinate' });
  store.createAgent({ id: 'worker', role: 'worker', adapter: 'claude', cwd: ROOT, task: 'Work' });
  let code = { state: 'stale', message: 'Mu runs old code: the checkout changed.' };
  const { runner } = await runnerFor(t, store, { serviceCode: async () => code });
  const prompts = [];
  runner.execute = async (command, agent, message, value) => {
    prompts.push({ agent: agent.id, value });
    const sessionId = `session-${agent.id}-${message.conversationId}`;
    return readTurn(command.format, JSON.stringify({ type: 'result', result: 'NO_REPLY', session_id: sessionId }));
  };

  await turn(runner, store, 'stale-direct', 'Hello');
  assert.ok(prompts[0].value.includes('Mu runs old code: the checkout changed. Pick the moment as mu-changes.md'));

  store.createConversation({ id: 'stale-room', kind: 'room', name: 'Stale room', members: ['lead', 'worker'] });
  store.addMessage('stale-room-worker', 'worker', '@lead Merged', 'stale-room');
  runner.kick();
  await until(() => prompts.length === 2 && !runner.active.size && store.agent('lead').status === 'idle');
  assert.ok(prompts[1].value.includes('Mu runs old code'));

  store.addMessage('stale-worker-turn', 'lead', '@worker Report', 'stale-room');
  runner.kick();
  await until(() => prompts.length === 3 && !runner.active.size && store.agent('worker').status === 'idle');
  assert.equal(prompts[2].agent, 'worker');
  assert.doesNotMatch(prompts[2].value, /Mu runs old code/);

  await turn(runner, store, 'stale-direct-again', 'Still there?');
  assert.equal(prompts[3].agent, 'lead');
  assert.ok(prompts[3].value.includes('Continue your existing session for this conversation.'));
  assert.ok(prompts[3].value.includes('Mu runs old code: the checkout changed. Pick the moment as mu-changes.md'));

  for (const state of ['current', 'unknown']) {
    code = { state, message: `Code is ${state}.` };
    await turn(runner, store, `code-${state}`, 'Again');
    assert.ok(prompts.at(-1).value.includes('Continue your existing session for this conversation.'));
    assert.doesNotMatch(prompts.at(-1).value, /Code is|mu-changes\.md in your skill/);
  }
});

test('lead direct chat carries shortened messages from other sessions and does not repeat its own replies', async (t) => {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT, task: 'Coordinate' });
  const { runner } = await runnerFor(t, store);
  const prompts = [];
  let response = 0;
  runner.execute = async (command, _agent, _message, prompt) => {
    prompts.push(prompt);
    response += 1;
    return leadOutput(command.format, `Direct response ${response}`);
  };

  store.addMessage('other-session-before-first-turn', 'lead', 'Earlier room session update', 'dm-lead');
  await turn(runner, store, 'direct-trigger-one', 'Start the direct session');
  const firstReply = store.messages(1, 'dm-lead')[0];
  assert.ok(firstReply.text.includes('Direct response 1'));
  assert.ok(prompts[0].includes('Earlier room session update'));

  store.addMessage('other-session-report', 'lead', `Room session report ${'x'.repeat(500)}`, 'dm-lead');
  await turn(runner, store, 'direct-trigger-two', 'Continue');

  assert.ok(prompts[1].includes('Messages from your other sessions posted in this direct chat since your last turn'));
  assert.ok(prompts[1].includes('Room session report'));
  assert.ok(prompts[1].includes(`${'x'.repeat(100)}…`));
  assert.doesNotMatch(prompts[1], /x{401}/);
  assert.doesNotMatch(prompts[1], /Direct response 1/);

  await turn(runner, store, 'direct-trigger-three', 'Continue again');
  assert.doesNotMatch(prompts[2], /Room session report/);
  assert.doesNotMatch(prompts[2], /Direct response 2/);
});

test('lead direct chat counts its own reply when limiting messages from other sessions', async (t) => {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'claude', cwd: ROOT, task: 'Coordinate' });
  const { runner } = await runnerFor(t, store);
  const prompts = [];
  let releaseFirst = () => {};
  let markStarted = () => {};
  const firstStarted = new Promise((resolve) => {
    markStarted = () => resolve(undefined);
  });
  runner.execute = async (command, _agent, _message, prompt) => {
    prompts.push(prompt);
    if (prompts.length === 1) {
      markStarted();
      await new Promise((resolve) => {
        releaseFirst = () => resolve(undefined);
      });
      return leadOutput(command.format, 'Direct response after room reports');
    }
    return leadOutput(command.format, 'Next direct response');
  };

  store.addMessage('turn-before-room-reports', 'user', 'Start a slow turn', 'dm-lead');
  runner.kick();
  await firstStarted;
  for (let index = 0; index < 21; index += 1)
    store.addMessage(`room-report-${index}`, 'lead', `Room report ${String(index).padStart(2, '0')}`, 'dm-lead');
  releaseFirst();
  await until(() => !runner.active.size && store.agent('lead').status === 'idle');

  await turn(runner, store, 'turn-after-room-reports', 'What did the room sessions report?');

  assert.ok(prompts[1].includes('Room report 01'));
  assert.ok(prompts[1].includes('Room report 20'));
  assert.doesNotMatch(prompts[1], /Room report 00/);
  assert.ok(prompts[1].includes('Some earlier messages may be omitted.'));
  assert.doesNotMatch(prompts[1], /Direct response after room reports/);
});
