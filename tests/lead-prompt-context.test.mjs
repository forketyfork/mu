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
    waiting: [{ taskId: 'waiting-task' }],
  });
  const { runner } = await runnerFor(t, store, { leadTaskContext: taskContext });
  const prompts = [];
  runner.execute = async (command, _agent, _message, value) => {
    prompts.push(value);
    return leadOutput(command.format, 'NO_REPLY');
  };

  await turn(runner, store, 'task-context-trigger', 'Check the work');

  const prompt = prompts[0];
  assert.ok(prompt);
  assert.ok(prompt.includes('quiet-task — Review the completed result'));
  assert.ok(prompt.includes('unassigned-task — No workers assigned'));
  assert.ok(prompt.includes('bulk-task-17 — Bulk task 17'));
  assert.doesNotMatch(prompt, /bulk-task-18/);
  assert.ok(prompt.includes('7 more active tasks meet this condition'));
  assert.ok(prompt.includes('task list'));
  for (const id of ['waiting-task', 'working-task', 'blocked-task', 'ready-task'])
    assert.doesNotMatch(prompt, new RegExp(id));
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
