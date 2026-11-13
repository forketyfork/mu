import test from 'node:test';
import assert from 'node:assert/strict';
import { createdAt, fixture } from './ui-fixture.mjs';

/** @returns {Record<string, any>} */
const agent = (id, overrides = {}) => ({
  id,
  role: 'worker',
  adapter: 'manual',
  status: 'stopped',
  task: `Work of ${id}`,
  cwd: '/project',
  createdAt,
  ...overrides,
});
const task = (id, status, conversationId, agentIds, retiredAgentIds = []) => ({
  id,
  title: `Title ${id}`,
  status,
  agentIds,
  retiredAgentIds,
  conversationId,
  sourceConversationId: 'dm-lead',
  verifiedAt: status === 'verified' ? createdAt : null,
  verificationNotice: status === 'verified' ? { state: 'sent' } : null,
  createdAt,
});
const archiveState = () => ({
  agents: [
    agent('lead', { role: 'lead', status: 'idle' }),
    agent('old-worker'),
    agent('busy-worker', { status: 'working' }),
  ],
  tasks: [
    task('task-done', 'verified', 'room-done', ['old-worker'], ['old-worker']),
    task('task-mixed-done', 'verified', 'room-mixed', []),
    task('task-mixed-open', 'active', 'room-mixed', ['busy-worker']),
  ],
  conversations: [
    { id: 'common', name: 'Common', kind: 'common', members: ['user', 'lead'] },
    { id: 'dm-lead', kind: 'direct', members: ['user', 'lead'] },
    { id: 'dm-old-worker', kind: 'direct', members: ['user', 'old-worker'] },
    { id: 'dm-busy-worker', kind: 'direct', members: ['user', 'busy-worker'] },
    { id: 'room-done', name: 'Done room', kind: 'room', members: ['user', 'lead', 'old-worker'] },
    { id: 'room-mixed', name: 'Mixed room', kind: 'room', members: ['user', 'lead', 'busy-worker'] },
  ],
  messages: [],
  transport: { connected: true },
  adapters: ['manual'],
});

const ids = ($all, attribute) =>
  [...$all(`[data-${attribute}]`)].map(
    (element) => element.dataset[attribute.replace(/-./g, (part) => part[1].toUpperCase())],
  );

async function archiveFixture(t, options) {
  const ui = await fixture(t, { initial: archiveState(), ...options });
  const $all = (selector) => ui.window.document.querySelectorAll(selector);
  return {
    ...ui,
    tasks: () => ids($all, 'task'),
    agents: () => ids($all, 'agent'),
    conversations: () => ids($all, 'conversation').filter((id) => id !== 'archive-toggle'),
  };
}

test('verified work, its rooms, and retired workers are hidden by default and revealed by Show archived', async (t) => {
  const { $, click, window, tasks, agents, conversations } = await archiveFixture(t);
  assert.equal($('#show-archived').checked, false);
  assert.deepEqual(tasks(), ['task-mixed-open']);
  assert.deepEqual(agents(), ['lead', 'busy-worker']);
  assert.deepEqual(conversations(), ['dm-lead', 'dm-busy-worker', 'room-mixed', 'common']);
  assert.equal($('#archived-count').textContent, '5');
  assert.equal($('#task-count').textContent, '1');
  assert.equal($('#conversation-total').textContent, '4');
  assert.match($('.conversation-archive-toggle').textContent, /Show 2 archived conversations/);
  $('#conversation-browser').open = true;
  click('.conversation-archive-toggle');
  assert.equal($('#conversation-browser').open, true, 'the in-list toggle keeps the conversation list open');
  click('.conversation-archive-toggle');

  click('#show-archived');
  assert.equal(window.localStorage.getItem('mu:show-archived'), 'true');
  assert.deepEqual(tasks().sort(), ['task-done', 'task-mixed-done', 'task-mixed-open']);
  assert.deepEqual(agents(), ['lead', 'old-worker', 'busy-worker']);
  assert.deepEqual(conversations(), [
    'dm-lead',
    'dm-busy-worker',
    'dm-old-worker',
    'room-done',
    'room-mixed',
    'common',
  ]);
  assert.deepEqual(
    [...window.document.querySelectorAll('.conversation-option.archived')].map((option) => option.dataset.conversation),
    ['dm-old-worker', 'room-done'],
  );

  click('.conversation-archive-toggle');
  assert.equal($('#show-archived').checked, false);
  assert.deepEqual(tasks(), ['task-mixed-open']);
});

test('unread messages in hidden archived conversations do not count toward the chat badge', async (t) => {
  const { $, update, click } = await archiveFixture(t);
  const next = archiveState();
  next.messages.push({ id: 1, conversationId: 'room-done', from: 'system', text: 'Verified', createdAt });
  update(next);
  assert.equal($('#chat-unread').hidden, true);
  click('#show-archived');
  assert.equal($('#chat-unread').textContent, '1');
});

test('a worker that resumes unverified work becomes visible again with its private chat', async (t) => {
  const { update, agents, conversations } = await archiveFixture(t);
  const next = archiveState();
  next.tasks.push(task('task-new', 'active', 'room-mixed', ['old-worker']));
  next.agents[1].status = 'idle';
  update(next);
  assert.deepEqual(agents(), ['lead', 'old-worker', 'busy-worker']);
  assert.ok(conversations().includes('dm-old-worker'));
  assert.ok(!conversations().includes('room-done'));
});

test('references to archived items open them without listing the rest of the archive', async (t) => {
  const { $, update, click, tasks, conversations } = await archiveFixture(t, { hash: '#team-chat' });
  const next = archiveState();
  next.messages.push({
    id: 1,
    conversationId: 'dm-lead',
    from: 'lead',
    text: 'Done by `old-worker` in `task-done`.',
    createdAt,
  });
  update(next);
  click('#messages .agent-ref');
  assert.equal($('#chat-title').textContent, 'old-worker');
  assert.deepEqual(conversations(), ['dm-lead', 'dm-busy-worker', 'dm-old-worker', 'room-mixed', 'common']);
  assert.equal($('[data-conversation="dm-old-worker"] .archived-tag').textContent, 'Archived');

  click('[data-conversation="dm-lead"]');
  click('#messages .task-ref');
  assert.equal($('#show-archived').checked, true, 'revealing a verified task turns on Show archived');
  assert.ok(tasks().includes('task-done'));
});

test('a worker whose tasks are all verified is hidden from every agent listing despite stale queued messages', async (t) => {
  const { $, click, update, window, agents } = await archiveFixture(t);
  const next = archiveState();
  next.agents[1].pending = 1;
  next.conversations.find((conversation) => conversation.id === 'room-mixed').members.push('old-worker');
  next.conversations.push({ id: 'room-new', name: 'New room', kind: 'room', members: ['user', 'lead'] });
  update(next);
  const options = (selector) => [...window.document.querySelectorAll(selector)].map((element) => element.textContent);
  const roomCandidates = () =>
    [...window.document.querySelectorAll('#room-member-options input')].map((input) => input.value);
  assert.deepEqual(agents(), ['lead', 'busy-worker']);
  assert.equal($('#team-count').textContent, '2');
  assert.equal($('#active-detail').textContent, '2 agents in your team');

  click('#new-room');
  assert.deepEqual(roomCandidates(), ['lead', 'busy-worker']);
  click('#cancel-room-dialog');

  click('[data-view="chat"]');
  click('[data-conversation="room-mixed"]');
  click('#mention-toggle');
  assert.deepEqual(options('#mention-menu strong'), ['@lead', '@busy-worker']);
  click('#mention-toggle');
  click('[data-conversation="room-new"]');
  click('#invite-members');
  assert.deepEqual(roomCandidates(), ['busy-worker']);
  click('#cancel-room-dialog');

  click('#show-archived');
  assert.deepEqual(agents(), ['lead', 'old-worker', 'busy-worker']);
  click('[data-conversation="room-mixed"]');
  click('#mention-toggle');
  assert.deepEqual(options('#mention-menu strong'), ['@lead', '@old-worker', '@busy-worker']);
});
