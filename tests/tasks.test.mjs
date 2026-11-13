import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { createTasks } from '../src/tasks.mjs';
import { ROOT } from '../src/server.mjs';

function fixture(filename) {
  const store = new Store(filename);
  if (!store.agent('lead')) {
    for (const id of ['lead', 'worker', 'shared', 'busy'])
      store.createAgent({ id, role: id === 'lead' ? 'lead' : 'worker', adapter: 'manual', cwd: ROOT, task: '' });
    store.createConversation({
      id: 'task-room',
      kind: 'room',
      name: 'Task',
      members: ['user', 'lead', 'worker', 'shared', 'busy'],
      createdBy: 'lead',
      sourceConversationId: 'dm-lead',
    });
  }
  const stopped = [],
    sent = [];
  const runner = {
    active: new Map(),
    stop(id) {
      stopped.push(id);
      store.updateAgent(id, { status: 'stopped' });
    },
  };
  const chat = {
    async send(from, text, conversationId) {
      sent.push({ from, text, conversationId });
      return store.addMessage(crypto.randomUUID(), from, text, conversationId);
    },
  };
  const tasks = createTasks({ store, chat, runner });
  return { store, stopped, sent, runner, chat, tasks };
}
const input = (id = 'issue') => ({
  id,
  title: 'Investigate the issue',
  description: 'Find the cause and provide **evidence**.',
  conversationId: 'task-room',
  agentIds: ['worker'],
});

test('only explicit user verification can authorize retirement of a completed task', async (t) => {
  const { store, tasks, stopped, sent } = fixture();
  t.after(() => store.close());
  tasks.create(input(), 'lead');
  assert.throws(() => tasks.update('issue', { status: 'verified' }, 'lead'), { status: 403 });
  assert.throws(() => tasks.update('issue', { verifiedAt: new Date().toISOString() }, 'worker'), { status: 403 });
  await assert.rejects(tasks.verify('issue', 'lead'), { status: 403 });
  await assert.rejects(tasks.verify('issue', 'worker'), { status: 403 });
  await assert.rejects(tasks.verify('issue', 'user'), { status: 409 });
  assert.throws(() => tasks.update('issue', { status: 'ready' }, 'lead'), /Record the task result/);
  tasks.update(
    'issue',
    { status: 'ready', result: 'The investigation found the cause.\n\n- Regression test described.' },
    'lead',
  );
  assert.throws(() => tasks.retire('issue', {}, 'lead'), { status: 409 });
  const verified = await tasks.verify('issue', 'user');
  assert.equal(verified.status, 'verified');
  assert.equal(verified.verifiedBy, 'user');
  assert.ok(verified.verifiedAt);
  assert.equal(verified.verificationNotice.state, 'sent');
  assert.deepEqual(stopped, ['worker'], 'verification retires the assigned workers without a lead turn');
  assert.deepEqual(verified.retiredAgentIds, ['worker']);
  assert.equal(sent[0].from, 'system');
  assert.equal(sent[0].conversationId, 'task-room');
  assert.match(sent[0].text, /^The user verified task issue.* Mu retired its workers \(worker\)/);
  assert.equal(store.inbox('lead').length, 0, 'a routine verification does not wake the lead');
  assert.equal(store.inbox('worker').length, 0);
  assert.throws(() => tasks.update('issue', { result: 'Changed after human approval' }, 'lead'), { status: 409 });
  assert.throws(() => tasks.retire('issue', {}, 'user'), { status: 403 });
  const retired = tasks.retire('issue', {}, 'lead');
  assert.deepEqual(retired.alreadyRetiredAgentIds, ['worker']);
  assert.equal(store.agent('worker').status, 'stopped');
  assert.deepEqual(tasks.retire('issue', {}, 'lead').alreadyRetiredAgentIds, ['worker']);
  assert.deepEqual(stopped, ['worker']);
  assert.equal(store.messages().length, 1);
});

test('verification survives IRC failure and restart and a retry notifies lead without changing approval time', async (t) => {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.tmp/task-persistence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'state.sqlite');
  let state = fixture(filename);
  state.tasks.create(input(), 'lead');
  state.tasks.update('issue', { status: 'ready', result: 'Verified implementation evidence' }, 'lead');
  state.chat.send = async () => {
    throw new Error('IRC unavailable');
  };
  const failed = await state.tasks.verify('issue', 'user');
  assert.equal(failed.status, 'verified');
  assert.equal(failed.verificationNotice.state, 'error');
  assert.match(failed.verificationNotice.error, /IRC unavailable/);
  state.store.close();
  state = fixture(filename);
  t.after(() => state.store.close());
  const [first, concurrent] = await Promise.all([
    state.tasks.verify('issue', 'user'),
    state.tasks.verify('issue', 'user'),
  ]);
  assert.equal(first.verifiedAt, failed.verifiedAt);
  assert.equal(concurrent.verificationNotice.messageId, first.verificationNotice.messageId);
  assert.equal(first.verificationNotice.state, 'sent');
  assert.equal(state.sent.length, 1);
  await state.tasks.verify('issue', 'user');
  assert.equal(state.sent.length, 1);
  assert.equal(state.store.inbox('lead').length, 0);
  assert.deepEqual(state.stopped, [], 'the retry after the restart does not retire the worker again');
});

test('retirement retains workers with other unverified assignments or pending work', async (t) => {
  const { store, tasks, stopped, sent } = fixture();
  t.after(() => store.close());
  tasks.create({ ...input(), agentIds: ['worker', 'shared', 'busy'] }, 'lead');
  tasks.create({ ...input('other-task'), agentIds: ['shared'] }, 'lead');
  store.addMessage('unrelated-followup', 'user', 'A different request', 'dm-busy');
  tasks.update('issue', { status: 'ready', result: 'The assigned task is complete' }, 'lead');
  await tasks.verify('issue', 'user');
  assert.deepEqual(stopped, ['worker'], 'verification already retired the free worker and kept the others');
  assert.match(
    sent[0].text,
    /^@lead The user verified task issue.* Mu retired its workers \(worker\); their history is kept\. Mu did not retire shared \(Still assigned to unverified tasks: other-task\), busy \(Agent has pending work/,
  );
  assert.equal(store.inbox('lead').length, 1, "a skipped worker is the lead's to follow up");
  assert.throws(() => tasks.guardAgentStop('lead', 'shared'), /unverified tasks: other-task/);
  assert.throws(() => tasks.guardAgentStop('lead', 'busy'), /pending work/);
  assert.doesNotThrow(() => tasks.guardAgentStop('user', 'shared'));
  assert.throws(() => tasks.guardAgentStop('lead', 'lead'), { status: 403 });
  assert.throws(() => tasks.retire('issue', { agentIds: ['lead'] }, 'lead'), /assigned workers/);
  const result = tasks.retire('issue', {}, 'lead');
  assert.deepEqual(stopped, ['worker']);
  assert.deepEqual(result.alreadyRetiredAgentIds, ['worker']);
  assert.deepEqual(
    result.skipped.map((item) => item.agentId),
    ['shared', 'busy'],
  );
  assert.match(result.skipped[0].reason, /other-task/);
  assert.match(result.skipped[1].reason, /pending work/);
  assert.equal(tasks.get('other-task').status, 'active');
  assert.equal(store.agent('shared').status, 'idle');
  assert.equal(store.agent('busy').pending, 1);
});

test('retirement retires a failed managed worker whose pending messages all belong to verified tasks, and keeps them queued', async (t) => {
  const { store, tasks, stopped, sent } = fixture();
  t.after(() => store.close());
  // The fixture's agents are manual; a manual agent works its own inbox in any status.
  for (const id of ['saved', 'asked', 'flagged'])
    store.createAgent({ id, role: 'worker', adapter: 'demo', cwd: ROOT, task: '' });
  store.addMembers('task-room', ['saved', 'asked', 'flagged']);
  const workers = ['worker', 'saved', 'asked', 'flagged', 'busy'];
  tasks.create({ ...input(), agentIds: workers }, 'lead');
  store.updateAgent('worker', { adapter: 'demo' });
  for (const id of workers) {
    store.addMessage(`assignment-${id}`, 'lead', `@${id} your assignment`, 'task-room');
    store.updateAgent(id, { status: 'error', lastError: id === 'flagged' ? null : 'codex exited 1' });
  }
  const assignment = store.inbox('worker')[0];
  store.addMessage('user-followup', 'user', 'A request outside the task', 'dm-asked');
  store.updateAgent('saved', {
    pendingResult: {
      messageIds: [store.inbox('saved')[0].id],
      conversationId: 'task-room',
      text: 'Done',
      status: 'idle',
    },
  });
  assert.throws(() => tasks.guardAgentStop('lead', 'worker'), /unverified tasks: issue/);
  tasks.update('issue', { status: 'ready', result: 'The assigned task is complete' }, 'lead');
  await tasks.verify('issue', 'user');
  assert.deepEqual(stopped, ['worker']);
  assert.deepEqual(
    store.inbox('worker').map((message) => message.id),
    [assignment.id],
    'retiring cancels nothing; an explicit resume still delivers it',
  );
  assert.match(
    sent[0].text,
    /Mu did not retire saved \(Agent has a saved response\), asked \(Agent has pending work\), flagged \(Agent has pending work\), busy \(Agent has pending work\)/,
  );
  assert.equal(store.agent('busy').adapter, 'manual');
  assert.throws(
    () => tasks.guardAgentStop('lead', 'busy'),
    /pending work/,
    'a failed manual agent may still be working on its message',
  );
  assert.throws(
    () => tasks.guardAgentStop('lead', 'flagged'),
    /pending work/,
    'a status set to error by hand is no evidence of a failed turn',
  );
  store.updateAgent('asked', { status: 'idle', lastError: null });
  store.ack('asked', store.inbox('asked').find((message) => message.conversationId === 'dm-asked').id);
  assert.throws(
    () => tasks.guardAgentStop('lead', 'asked'),
    /pending work/,
    'an agent that is not failed may still run its pending message',
  );
});

test('task metadata is scoped, Markdown is preserved, and notification titles cannot broadcast', async (t) => {
  const { store, tasks, sent } = fixture();
  t.after(() => store.close());
  assert.throws(() => tasks.create({ ...input('invalid'), agentIds: ['lead'] }, 'lead'), /registered workers/);
  assert.throws(
    () => tasks.create({ ...input('private-source'), sourceConversationId: 'dm-worker' }, 'user'),
    /source conversation must include @lead/,
  );
  const task = tasks.create({ ...input(), title: 'Inspect @all and @worker mentions' }, 'lead');
  assert.equal(task.description, 'Find the cause and provide **evidence**.');
  assert.equal(task.sourceConversationId, 'dm-lead');
  tasks.update('issue', { status: 'ready', result: 'A **Markdown** result' }, 'lead');
  await tasks.verify('issue', 'user');
  assert.doesNotMatch(sent[0].text, /@all|@worker/);
  assert.equal(store.inbox('worker').length, 0);
  assert.equal(tasks.get('issue').status, 'verified');
});
