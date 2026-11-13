import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityVerbs,
  agentRuntime,
  archivedItems,
  codeReference,
  conversationActivity,
  conversationMessages,
  defaultConversationId,
  filterAgents,
  isAgentBusy,
  baselineViewed,
  applyChanges,
  mergeLatestPage,
  mergeMessages,
  isNewMessage,
  newMessageBoundary,
  parseViewed,
  splitMentions,
  summarizeAgents,
  tasksOfAgents,
  totalUnread,
  unreadCount,
  viewFromHash,
  viewHashes,
} from './model.js';

const agents = [
  {
    id: 'api-worker',
    role: 'worker',
    adapter: 'codex',
    cwd: '/projects/api',
    task: 'Fix authentication',
    status: 'working',
    createdAt: '2026-11-04T10:00:00Z',
  },
  {
    id: 'lead',
    role: 'lead',
    adapter: 'claude',
    cwd: '/projects/main',
    task: 'Coordinate release',
    status: 'idle',
    createdAt: '2026-11-04T10:01:00Z',
  },
  {
    id: 'ui-worker',
    role: 'worker',
    adapter: 'codex',
    cwd: '/projects/web',
    task: 'Improve keyboard navigation',
    status: 'blocked',
    createdAt: '2026-11-04T10:02:00Z',
  },
  {
    id: 'docs-worker',
    role: 'worker',
    adapter: 'manual',
    cwd: '/projects/docs',
    task: 'Write setup guide',
    status: 'done',
    createdAt: '2026-11-04T10:03:00Z',
  },
  {
    id: 'failed-worker',
    role: 'worker',
    adapter: 'codex',
    cwd: '/projects/api',
    task: 'Run checks',
    status: 'error',
    createdAt: '2026-11-04T10:04:00Z',
  },
];

test('workspace metrics distinguish active work from blocked and failed agents', () => {
  assert.deepEqual(summarizeAgents(agents), { active: 3, working: 1, attention: 2, total: 5 });
  assert.deepEqual(summarizeAgents([]), { active: 0, working: 0, attention: 0, total: 0 });
});

test('filters combine lifecycle and case-insensitive task or directory search', () => {
  assert.deepEqual(
    filterAgents(agents, 'attention', '').map((agent) => agent.id),
    ['ui-worker', 'failed-worker'],
  );
  assert.deepEqual(
    filterAgents(agents, 'all', '  KEYBOARD ').map((agent) => agent.id),
    ['ui-worker'],
  );
  assert.deepEqual(
    filterAgents(agents, 'working', '/projects/API').map((agent) => agent.id),
    ['api-worker'],
  );
  assert.deepEqual(
    filterAgents(agents, 'finished', '').map((agent) => agent.id),
    ['docs-worker'],
  );
  assert.equal(filterAgents(agents, 'all', '')[0].id, 'lead');
});

test('mention rendering recognizes recipients without transforming emails or unknown names', () => {
  const text = '@lead ask @api-worker, then @all. email@lead.test @unknown <script>alert(1)</script>';
  const parts = splitMentions(text, ['lead', 'api-worker', 'all']);
  assert.equal(parts.map((part) => part.text).join(''), text);
  assert.deepEqual(
    parts.filter((part) => part.mention).map((part) => part.text),
    ['@lead', '@api-worker', '@all'],
  );
  assert.ok(parts.some((part) => !part.mention && part.text.includes('<script>')));
});

test('mention rendering does not highlight known prefixes inside longer identifiers', () => {
  const parts = splitMentions('@lead-extra @lead_2 @@lead @lead', ['lead']);
  assert.deepEqual(
    parts.filter((part) => part.mention).map((part) => part.text),
    ['@lead'],
  );
});

test('inline code resolves only exact agent and task identifiers', () => {
  const tasks = [{ id: 'task-508d2eb1', title: 'Fix the CI pipeline', status: 'active' }];
  assert.deepEqual(codeReference('api-worker', { agents, tasks }), { kind: 'agent', id: 'api-worker' });
  assert.deepEqual(codeReference('task-508d2eb1', { agents, tasks }), {
    kind: 'task',
    id: 'task-508d2eb1',
    title: 'Fix the CI pipeline',
  });
  for (const text of [
    '@api-worker',
    ' api-worker',
    'API-WORKER',
    'api-worker.log',
    'task-508d2eb',
    'task-00000000',
    'npm test',
  ]) {
    assert.equal(codeReference(text, { agents, tasks }), null, text);
  }
  assert.equal(codeReference('task-508d2eb1', { agents, tasks: undefined }), null);
});

test('inline code resolves a message ID only in the exact `#123` form for an existing message', () => {
  const messages = [{ id: 123, conversationId: 'room-a' }];
  assert.deepEqual(codeReference('#123', { messages }), { kind: 'message', id: 123, conversationId: 'room-a' });
  for (const text of ['123', '#124', '#0123', '#123 ', 'PR #123', '#12.3', '#', '#-1']) {
    assert.equal(codeReference(text, { messages }), null, text);
  }
  assert.equal(codeReference('#123', {}), null);
});

test('a message ID the dashboard does not hold is a reference once Mu has issued it, in an unknown conversation', () => {
  const messages = [{ id: 5, conversationId: 'room-a' }];
  assert.deepEqual(codeReference('#3', { messages, lastMessageId: 9 }), {
    kind: 'message',
    id: 3,
    conversationId: null,
  });
  assert.deepEqual(codeReference('#9', { messages, lastMessageId: 9 }), {
    kind: 'message',
    id: 9,
    conversationId: null,
  });
  assert.equal(codeReference('#10', { messages, lastMessageId: 9 }), null);
  assert.deepEqual(codeReference('#5', { messages, lastMessageId: 9 }), {
    kind: 'message',
    id: 5,
    conversationId: 'room-a',
  });
});

test('conversation selection keeps private and task-room histories isolated', () => {
  const messages = [
    { id: 1, conversationId: 'common', from: 'lead', text: 'Common coordination' },
    { id: 2, conversationId: 'dm-lead', from: 'user', text: 'Private request' },
    { id: 3, conversationId: 'task-42', from: 'worker-one', text: 'Task evidence' },
    { id: 4, conversationId: 'dm-lead', from: 'lead', text: 'Private answer' },
  ];
  assert.deepEqual(
    conversationMessages(messages, 'dm-lead').map((message) => message.text),
    ['Private request', 'Private answer'],
  );
  assert.deepEqual(
    conversationMessages(messages, 'task-42').map((message) => message.text),
    ['Task evidence'],
  );
  assert.equal(unreadCount(messages, 'dm-lead', 2), 1);
  assert.equal(unreadCount(messages, 'dm-lead', 4), 0);
  assert.equal(unreadCount(messages, 'task-42', 0), 1);
});

test('the initial conversation is a private lead chat when available', () => {
  const conversations = [
    { id: 'common', kind: 'common' },
    { id: 'task-42', kind: 'room' },
    { id: 'dm-worker-one', kind: 'direct' },
    { id: 'dm-lead', kind: 'direct' },
  ];
  assert.equal(defaultConversationId(conversations), 'dm-lead');
  assert.equal(defaultConversationId(conversations.slice(0, -1)), 'dm-worker-one');
  assert.equal(defaultConversationId([{ id: 'common', kind: 'common' }]), 'common');
});

test('the URL hash selects the visible view, defaulting to the workspace', () => {
  assert.equal(viewFromHash(viewHashes.chat), 'chat');
  assert.equal(viewFromHash(viewHashes.brag), 'brag');
  assert.equal(viewFromHash(viewHashes.workspace), 'workspace');
  assert.equal(viewFromHash(''), 'workspace');
  assert.equal(viewFromHash('#unknown'), 'workspace');
});

test('total unread sums agent messages after each conversation read marker', () => {
  const conversations = [{ id: 'dm-lead' }, { id: 'room-a' }, { id: 'room-b' }];
  const messages = [
    { id: 1, conversationId: 'dm-lead', from: 'lead' },
    { id: 2, conversationId: 'dm-lead', from: 'user' },
    { id: 3, conversationId: 'room-a', from: 'worker' },
    { id: 4, conversationId: 'room-a', from: 'lead' },
    { id: 5, conversationId: 'room-b', from: 'worker' },
  ];
  assert.equal(
    totalUnread(
      messages,
      conversations,
      new Map([
        ['dm-lead', 1],
        ['room-a', 3],
        ['room-b', 5],
      ]),
    ),
    1,
  );
  assert.equal(totalUnread(messages, conversations, new Map()), 4);
});

test('an agent is busy while it reports working or a managed turn is still running', () => {
  assert.equal(isAgentBusy({ status: 'working', activeMessageId: null }), true);
  assert.equal(isAgentBusy({ status: 'done', activeMessageId: 36 }), true);
  assert.equal(isAgentBusy({ status: 'idle', activeMessageId: null }), false);
  assert.equal(isAgentBusy({ status: 'blocked' }), false);
});

test('only items tied exclusively to verified work are archived', () => {
  const worker = (id, overrides = {}) => ({
    id,
    role: 'worker',
    status: 'stopped',
    activeMessageId: null,
    pending: 0,
    ...overrides,
  });
  const task = (id, status, conversationId, agentIds, retiredAgentIds = []) => ({
    id,
    status,
    conversationId,
    sourceConversationId: 'dm-lead',
    agentIds,
    retiredAgentIds,
  });
  const direct = (id) => ({ id: `dm-${id}`, kind: 'direct', members: ['user', id] });
  const state = {
    agents: [
      { id: 'lead', role: 'lead', status: 'stopped' },
      worker('retired'),
      worker('mixed'),
      worker('restarted', { status: 'idle' }),
      worker('reassigned'),
      worker('unretired'),
      worker('busy', { activeMessageId: 9 }),
      worker('queued', { pending: 2 }),
      worker('active-worker', { status: 'working' }),
      worker('unassigned', { status: 'idle' }),
    ],
    tasks: [
      task('done-a', 'verified', 'room-done', ['retired', 'busy', 'queued'], ['retired', 'busy', 'queued']),
      task(
        'done-b',
        'verified',
        'room-mixed',
        ['mixed', 'restarted', 'reassigned', 'unretired'],
        ['mixed', 'restarted', 'reassigned'],
      ),
      task('open-b', 'active', 'room-mixed', ['active-worker']),
      task('open-c', 'ready', 'room-ready', ['reassigned']),
      task('child', 'verified', 'room-child', []),
      { ...task('from-room', 'active', 'room-child-open', []), sourceConversationId: 'room-source' },
    ],
    conversations: [
      { id: 'common', kind: 'common', members: ['user', 'lead'] },
      direct('lead'),
      ...[
        'retired',
        'mixed',
        'restarted',
        'reassigned',
        'unretired',
        'busy',
        'queued',
        'active-worker',
        'unassigned',
        'gone',
      ].map(direct),
      { id: 'room-done', kind: 'room', members: ['user', 'lead'] },
      { id: 'room-mixed', kind: 'room', members: ['user', 'lead'] },
      { id: 'room-ready', kind: 'room', members: ['user', 'lead'] },
      { id: 'room-child', kind: 'room', members: ['user', 'lead'] },
      { id: 'room-source', kind: 'room', members: ['user', 'lead'] },
      { id: 'room-untracked', kind: 'room', members: ['user', 'lead'] },
    ],
  };
  const archived = archivedItems(state);
  assert.deepEqual([...archived.tasks].sort(), ['child', 'done-a', 'done-b']);
  // A worker whose tasks are all verified is archived whatever its process state, retirement, or stale queued messages.
  assert.deepEqual([...archived.agents].sort(), ['busy', 'mixed', 'queued', 'restarted', 'retired', 'unretired']);
  assert.deepEqual([...archived.conversations].sort(), [
    'dm-busy',
    'dm-mixed',
    'dm-queued',
    'dm-restarted',
    'dm-retired',
    'dm-unretired',
    'room-child',
    'room-done',
  ]);
  state.tasks[1].status = 'ready';
  const reopened = archivedItems(state);
  assert.deepEqual(
    [...reopened.agents].sort(),
    ['busy', 'queued', 'retired'],
    'a worker on an unverified task stays visible',
  );
  assert.deepEqual([...reopened.conversations].sort(), [
    'dm-busy',
    'dm-queued',
    'dm-retired',
    'room-child',
    'room-done',
  ]);
  assert.deepEqual(archivedItems({ ...state, tasks: undefined }), {
    tasks: new Set(),
    agents: new Set(),
    conversations: new Set(),
  });
});

const claudeUsage = (overrides = {}) => ({
  adapter: 'claude',
  sessionId: 's-task',
  model: 'claude-opus-5-5',
  contextTokens: 250000,
  contextWindow: 1000000,
  usageError: null,
  sessions: { 's-task': { adapter: 'claude', costUsd: 0.35, totalTokens: null } },
  updatedAt: '2026-11-04T12:00:00Z',
  ...overrides,
});
const runtimeAgent = (overrides = {}) => ({
  id: 'worker',
  adapter: 'claude',
  taskId: 'task-1',
  conversationId: 'task-room',
  sessionIds: { 'task-room': 's-task' },
  usage: {},
  ...overrides,
});
const shown = (agent) =>
  Object.fromEntries(agentRuntime(agent).indicators.map(({ key, text, state }) => [key, `${text} [${state}]`]));
const titles = (agent) => Object.fromEntries(agentRuntime(agent).indicators.map(({ key, title }) => [key, title]));

test('Claude indicators show model, context percentage and task spend from the latest reported turn', () => {
  const agent = runtimeAgent({
    sessionIds: { 'task-room': 's-task', 'dm-worker': 's-dm' },
    usage: {
      'task-room': claudeUsage(),
      'dm-worker': claudeUsage({
        sessionId: 's-dm',
        model: 'claude-sonnet-5-5',
        contextTokens: 900000,
        sessions: { 's-dm': { adapter: 'claude', costUsd: 2, totalTokens: null } },
        updatedAt: '2026-11-04T11:00:00Z',
      }),
    },
  });
  assert.equal(agentRuntime(agent).harness, 'Claude Code');
  assert.deepEqual(shown(agent), { model: 'claude-opus-5-5 [ok]', context: '25% [ok]', spend: '$0.35 [ok]' });
  assert.equal(agentRuntime(agent).indicators[1].percent, 25);
  assert.equal(titles(agent).context, 'Context: 250K of 1M tokens in task-room');
  assert.match(titles(agent).spend, /^Task spend: estimated by Claude Code at list prices$/);
});

test('a Mu-set effort sits next to the model, and an agent on its CLI default shows none', () => {
  const agent = runtimeAgent({ adapter: 'codex', effort: 'high', sessionIds: {} });
  assert.deepEqual(
    agentRuntime(agent).indicators.map(({ key }) => key),
    ['model', 'effort', 'context', 'spend'],
  );
  assert.equal(shown(agent).effort, 'effort high [ok]');
  assert.equal(titles(agent).effort, 'Reasoning effort: high, passed to Codex on every turn');
  assert.ok(!('effort' in shown(runtimeAgent({ effort: null }))));
});

test('agents without a task total spend across conversations and tiny costs stay visible', () => {
  const agent = runtimeAgent({
    taskId: undefined,
    usage: {
      'task-room': claudeUsage({ sessions: { a: { adapter: 'claude', costUsd: 0.004, totalTokens: null } } }),
      common: claudeUsage({
        sessions: { b: { adapter: 'claude', costUsd: 0.002, totalTokens: null } },
        updatedAt: '2026-11-04T10:00:00Z',
      }),
    },
  });
  assert.equal(shown(agent).spend, '<$0.01 [ok]');
  assert.match(titles(agent).spend, /^Spend:/);
});

test('missing values use symbols: pending before a report and absent when unsupported or unreadable', () => {
  assert.deepEqual(shown(runtimeAgent({ sessionIds: {} })), {
    model: 'model … [pending]',
    context: 'ctx … [pending]',
    spend: '$… [pending]',
  });
  const replaced = runtimeAgent({ sessionIds: { 'task-room': 's-new' }, usage: { 'task-room': claudeUsage() } });
  assert.equal(shown(replaced).context, 'ctx … [pending]');
  assert.equal(shown(replaced).spend, '$0.35 [ok]');
  const noWindow = runtimeAgent({ usage: { 'task-room': claudeUsage({ contextWindow: null }) } });
  assert.equal(shown(noWindow).context, '250K tok [ok]');
  assert.equal(agentRuntime(noWindow).indicators[1].percent, undefined);
  const manual = runtimeAgent({ adapter: 'manual', taskId: undefined });
  assert.deepEqual(shown(manual), { model: 'model — [absent]', context: 'ctx — [absent]', spend: '$— [absent]' });
  assert.equal(titles(manual).context, 'Context: not reported by External / manual');
});

const pricedSession = (overrides = {}) => ({
  adapter: 'codex',
  costUsd: 0.21551,
  costError: null,
  costPending: false,
  pricesFetchedAt: '2026-11-04T12:00:00.000Z',
  totalTokens: 31752,
  ...overrides,
});
const codexUsage = (overrides = {}) => ({
  adapter: 'codex',
  sessionId: 'thread',
  model: 'gpt-6-astra',
  contextTokens: 15914,
  contextWindow: 258400,
  usageError: null,
  sessions: { thread: pricedSession() },
  updatedAt: '2026-11-04T12:00:00Z',
  ...overrides,
});
const codexAgent = (usage) =>
  runtimeAgent({ adapter: 'codex', sessionIds: { 'task-room': 'thread' }, usage: { 'task-room': codexUsage(usage) } });

test('Codex indicators show model and context from its session log and the cost Mu computed from LiteLLM prices', () => {
  const agent = codexAgent();
  assert.deepEqual(shown(agent), { model: 'gpt-6-astra [ok]', context: '6% [ok]', spend: '$0.22 [ok]' });
  assert.equal(
    titles(agent).spend,
    'Task spend: computed by Mu from Codex token usage at LiteLLM list prices fetched 2026-11-04T12:00:00.000Z',
  );
  const unreadable = codexAgent({
    model: null,
    contextTokens: null,
    contextWindow: null,
    usageError: 'Codex session log unavailable: missing',
    sessions: { thread: pricedSession({ costUsd: null, costError: 'Codex session log unavailable: missing' }) },
  });
  assert.deepEqual(shown(unreadable), {
    model: 'model — [absent]',
    context: 'ctx — [absent]',
    spend: '$— 31.8K tok [partial]',
  });
  assert.equal(titles(unreadable).model, 'Model: Codex session log unavailable: missing');
  assert.equal(
    titles(unreadable).spend,
    'Task spend: price unknown: Codex session log unavailable: missing; 31.8K tokens processed',
  );
  assert.equal(shown(runtimeAgent({ adapter: 'codex', sessionIds: {} })).spend, '$… [pending]');
});

test('an unknown Codex price shows why instead of a number, and a fetch in progress shows as pending', () => {
  const missing = codexAgent({
    sessions: {
      thread: pricedSession({
        costUsd: null,
        costError: 'LiteLLM has no per-token price for gpt-7 (prices fetched 2026-11-04T12:00:00.000Z)',
      }),
    },
  });
  assert.equal(shown(missing).spend, '$— 31.8K tok [partial]');
  assert.equal(
    titles(missing).spend,
    'Task spend: price unknown: LiteLLM has no per-token price for gpt-7 (prices fetched 2026-11-04T12:00:00.000Z); 31.8K tokens processed',
  );
  const fetching = codexAgent({
    sessions: {
      thread: pricedSession({ costUsd: null, costPending: true, costError: 'Fetching LiteLLM prices for gpt-7' }),
    },
  });
  assert.equal(shown(fetching).spend, '$… [pending]');
  assert.equal(titles(fetching).spend, 'Task spend: Fetching LiteLLM prices for gpt-7; 31.8K tokens processed');
  const legacy = codexAgent({ sessions: { thread: { adapter: 'codex', costUsd: null, totalTokens: 2000 } } });
  assert.equal(titles(legacy).spend, 'Task spend: price unknown: Codex session not priced yet; 2K tokens processed');
});

test('a total that excludes unpriced sessions is marked as a lower bound and names their reasons', () => {
  const agent = codexAgent({
    sessions: {
      's-task': { adapter: 'claude', costUsd: 1.5, totalTokens: null },
      thread: pricedSession(),
      other: pricedSession({ costUsd: null, costError: 'LiteLLM prices unavailable: HTTP 503', totalTokens: 2000 }),
    },
  });
  assert.equal(shown(agent).spend, '$1.72+ [partial]');
  assert.equal(
    titles(agent).spend,
    'Task spend: at least $1.72, estimated by Claude Code at list prices; computed by Mu from Codex token usage at LiteLLM list prices fetched 2026-11-04T12:00:00.000Z; excludes 1 unpriced session: LiteLLM prices unavailable: HTTP 503; 2K tokens processed',
  );
  const complete = codexAgent({
    sessions: { 's-task': { adapter: 'claude', costUsd: 1.5, totalTokens: null }, thread: pricedSession() },
  });
  assert.equal(shown(complete).spend, '$1.72 [ok]');
});

test('tasksOfAgents lists unverified tasks that have an agent in the given statuses', () => {
  const agents = [
    { id: 'a', status: 'working' },
    { id: 'b', status: 'blocked' },
    { id: 'c', status: 'idle' },
  ];
  const tasks = [
    { id: 't1', status: 'active', agentIds: ['a', 'c'] },
    { id: 't2', status: 'active', agentIds: ['b'] },
    { id: 't3', status: 'verified', agentIds: ['a'] },
    { id: 't4', status: 'ready', agentIds: ['c'] },
  ];
  assert.deepEqual(
    tasksOfAgents(tasks, agents, ['working']).map((task) => task.id),
    ['t1'],
  );
  assert.deepEqual(
    tasksOfAgents(tasks, agents, ['blocked', 'error']).map((task) => task.id),
    ['t2'],
  );
});

test('a first record treats the existing history as seen', () => {
  const messages = [
    { id: 1, conversationId: 'dm-lead', from: 'lead' },
    { id: 2, conversationId: 'room-a', from: 'dev' },
    { id: 3, conversationId: 'dm-lead', from: 'lead' },
  ];
  const viewed = baselineViewed({ 'dm-lead': 3, 'room-a': 2 }, [{ id: 'dm-lead' }, { id: 'room-a' }, { id: 'empty' }]);
  assert.deepEqual(viewed, { 'dm-lead': 3, 'room-a': 2, empty: 0 });
  assert.equal(
    messages.some((message) => isNewMessage(message, newMessageBoundary(viewed, message.conversationId))),
    false,
  );
});

test("messages above the viewed id are new, except the user's own", () => {
  const viewed = parseViewed('{"dm-lead":4}');
  const boundary = newMessageBoundary(viewed, 'dm-lead');
  assert.equal(isNewMessage({ id: 4, from: 'lead' }, boundary), false);
  assert.equal(isNewMessage({ id: 5, from: 'lead' }, boundary), true);
  assert.equal(isNewMessage({ id: 6, from: 'user' }, boundary), false);
});

test('a conversation missing from the record has all its messages new', () => {
  assert.equal(newMessageBoundary(parseViewed('{"dm-lead":4}'), 'room-a'), 0);
});

test('unreadable viewed data is treated as no record', () => {
  assert.equal(parseViewed(null), null);
  for (const raw of ['not json', '[1]', '7', 'null']) assert.equal(parseViewed(raw), null);
});

const held = (id, conversationId = 'room-a') => ({ id, conversationId, from: 'lead', text: `#${id}` });

test('activity lines stay lowercase without trailing ellipses or film titles', () => {
  assert.equal(activityVerbs.length, 64);
  for (const line of activityVerbs) {
    assert.match(line, /^[a-z]/);
    assert.equal(line.endsWith('...'), false);
    assert.equal(line.includes('('), false);
  }
});

test('conversation activity lists member turns in that room with stable per-turn verbs', () => {
  const conversation = { id: 'room-a', members: ['user', 'lead', 'dev'] };
  const agents = [
    { id: 'lead', activeMessageId: 12, activeConversationId: 'room-a' },
    { id: 'dev', activeMessageId: 13, activeConversationId: 'room-a' },
    { id: 'elsewhere', activeMessageId: 14, activeConversationId: 'room-b' },
    { id: 'manual', status: 'working', conversationId: 'room-a' },
  ];
  const activity = conversationActivity(agents, conversation);
  assert.deepEqual(
    activity.map(({ id }) => id),
    ['lead', 'dev'],
  );
  assert.deepEqual(
    conversationActivity(
      agents.map((agent) => ({ ...agent, pending: 1 })),
      conversation,
    ),
    activity,
    'changes unrelated to the active message keep each member’s verb stable',
  );
  assert.ok(activity.every(({ verb }) => typeof verb === 'string' && verb.length > 0));
  assert.deepEqual(
    conversationActivity(
      agents.map((agent) => ({ ...agent, activeMessageId: null })),
      conversation,
    ),
    [],
    'a turn without an active message is no longer shown even if its runner entry is still unwinding',
  );
  assert.deepEqual(conversationActivity(agents, null), []);
});

test('conversation activity puts local turns first and hides inaccessible destination names', () => {
  const room = {
    id: 'room-a',
    kind: 'room',
    name: 'Current room',
    members: ['user', 'lead', 'dev', 'researcher', 'ops'],
  };
  const home = { id: 'home', kind: 'room', name: 'Mu home', members: ['user', 'dev'] };
  const direct = { id: 'dm-researcher', kind: 'direct', members: ['user', 'researcher'] };
  const privateRoom = { id: 'private', kind: 'room', name: 'Secret room', members: ['ops'] };
  const agents = [
    { id: 'lead', activeMessageId: 1, activeConversationId: room.id },
    { id: 'dev', activeMessageId: 2, activeConversationId: home.id },
    { id: 'researcher', activeMessageId: 3, activeConversationId: direct.id },
    { id: 'ops', activeMessageId: 4, activeConversationId: privateRoom.id },
    { id: 'outside', activeMessageId: 5, activeConversationId: home.id },
    { id: 'manual', status: 'working', conversationId: room.id },
  ];

  const activity = conversationActivity(agents, room, [room, home, direct, privateRoom]);

  assert.equal(activity[0].id, 'lead');
  assert.equal(activity[0].type, 'current');
  assert.ok(activity[0].verb.length > 0);
  assert.deepEqual(activity.slice(1), [
    { id: 'dev', type: 'elsewhere', conversationName: 'Mu home', conversationKind: 'room' },
    { id: 'researcher', type: 'elsewhere', conversationName: null, conversationKind: 'direct' },
    { id: 'ops', type: 'elsewhere', conversationName: null, conversationKind: null },
  ]);
});

test('merging messages keeps them sorted by ID and holds each once', () => {
  const messages = [held(1), held(4)];
  assert.deepEqual(
    mergeMessages(messages, [held(5), held(6)]).map((message) => message.id),
    [1, 4, 5, 6],
  );
  assert.deepEqual(
    mergeMessages(messages, [held(4), held(2), held(7)]).map((message) => message.id),
    [1, 2, 4, 7],
  );
  assert.equal(mergeMessages(messages, []), messages);
});

test('the newest page of a history drops older held messages of that conversation only when history remains', () => {
  const messages = [held(1), held(2, 'dm-lead'), held(3), held(9)];
  const page = [held(6), held(7), held(8)];
  assert.deepEqual(
    mergeLatestPage(messages, 'room-a', page, false).map((message) => message.id),
    [2, 6, 7, 8, 9],
    'messages 1 and 3 would sit above a gap; the other conversation keeps its message',
  );
  assert.deepEqual(
    mergeLatestPage(messages, 'room-a', page, true).map((message) => message.id),
    [1, 2, 3, 6, 7, 8, 9],
  );
});

test('a stream batch replaces, adds and removes whole records and appends new messages', () => {
  const state = {
    agents: [
      { id: 'lead', status: 'idle' },
      { id: 'dev', status: 'idle' },
    ],
    tasks: [{ id: 'task-1', status: 'active' }],
    waiting: [{ id: 'wait-1', text: 'Decide' }],
    activities: [],
    conversations: [{ id: 'dm-lead' }],
    transport: { connected: true },
    lastMessageIds: { 'dm-lead': 4 },
    lastMessageId: 4,
    messages: [held(4, 'dm-lead')],
  };
  const frozen = structuredClone(state);
  const { state: next, touched } = applyChanges(state, [
    { kind: 'agents', id: 'dev', value: { id: 'dev', status: 'working' } },
    { kind: 'agents', id: 'new', value: { id: 'new', status: 'idle' } },
    { kind: 'waiting', id: 'wait-1', value: null },
    { kind: 'waiting', id: 'wait-unknown', value: null },
    { kind: 'messages', id: '6', value: held(6) },
    { kind: 'messages', id: '5', value: held(5, 'dm-lead') },
    { kind: 'transport', value: { connected: false, error: 'gone' } },
  ]);
  assert.deepEqual(state, frozen, 'the previous state is left as it was');
  assert.deepEqual(next.agents, [
    { id: 'lead', status: 'idle' },
    { id: 'dev', status: 'working' },
    { id: 'new', status: 'idle' },
  ]);
  assert.deepEqual(next.waiting, []);
  assert.equal(next.tasks, state.tasks, 'an untouched kind keeps its list');
  assert.deepEqual(
    next.messages.map((message) => message.id),
    [4, 5, 6],
  );
  assert.deepEqual(next.lastMessageIds, { 'dm-lead': 5, 'room-a': 6 });
  assert.equal(next.lastMessageId, 6);
  assert.deepEqual(next.transport, { connected: false, error: 'gone' });
  assert.deepEqual([...touched].sort(), ['agents', 'messages', 'transport', 'waiting']);
  assert.throws(() => applyChanges(state, [{ kind: 'secrets', value: 1 }]), /unknown change kind: secrets/);
});
