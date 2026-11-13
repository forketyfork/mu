import test from 'node:test';
import assert from 'node:assert/strict';
import { createdAt, fixture, initialState, message, settle, snapshotOf } from './ui-fixture.mjs';

const historyRequests = (ui) =>
  ui.requests.filter((request) => !request.stream).map((request) => decodeURIComponent(request.path));
const shownIds = (ui) => [...ui.$('#messages').querySelectorAll('.message')].map((row) => Number(row.dataset.message));
const unreadOf = (ui, name) =>
  [...ui.$('#conversation-list').querySelectorAll('.conversation-option')]
    .find((option) => option.textContent.includes(name))
    ?.querySelector('.unread-count')?.textContent ?? '';

test('the dashboard labels the user as You in messages and room membership', async (t) => {
  const initial = initialState();
  initial.messages[0] = { ...message(1), from: 'user' };
  const ui = await fixture(t, { initial });
  assert.equal(ui.$('#messages .message .message-sender').textContent, 'You');
  assert.equal(ui.$('#messages .message .message-avatar.user').textContent, 'Y');

  ui.click('.rail-link[data-view="chat"]');
  ui.click('[data-conversation="room-a"]');
  await settle();
  assert.equal(ui.$('#conversation-members').textContent, 'You · @lead');
});

test('the dashboard loads no whole state; it reads the history of a conversation only when it opens it', async (t) => {
  const ui = await fixture(t);
  assert.deepEqual(historyRequests(ui), ['/api/conversations/dm-lead/messages?limit=300']);
  assert.deepEqual(shownIds(ui), [1]);
  ui.click('.rail-link[data-view="chat"]');
  [...ui.$('#conversation-list').querySelectorAll('button')]
    .find((button) => button.textContent.includes('Review changes'))
    .click();
  assert.equal(ui.$('#messages').textContent, 'Loading messages…');
  await settle();
  assert.deepEqual(shownIds(ui), [2]);
  assert.deepEqual(historyRequests(ui), [
    '/api/conversations/dm-lead/messages?limit=300',
    '/api/conversations/room-a/messages?limit=300',
  ]);
});

test('the composer ticker distinguishes selected and other conversation turns', async (t) => {
  const ui = await fixture(t);
  const ticker = ui.$('#activity-ticker');
  assert.equal(ticker.hidden, true);

  const next = initialState();
  next.agents[0] = {
    ...next.agents[0],
    status: 'done',
    activeMessageId: 7,
    activeConversationId: 'dm-lead',
  };
  ui.update(next);
  assert.equal(ticker.hidden, false);
  assert.match(ticker.textContent, /^lead [a-z].*···$/);
  assert.equal(ticker.querySelector('.activity-dots').getAttribute('aria-hidden'), 'true');
  const label = ticker.textContent;
  ui.update(next);
  assert.equal(ticker.textContent, label, 'unrelated renders keep the verb steady');

  next.agents[0].activeConversationId = 'room-a';
  ui.update(next);
  assert.equal(ticker.hidden, false, 'a member turn in another conversation remains visible');
  assert.equal(ticker.textContent, 'lead busy in Review changes');
  assert.equal(ticker.querySelector('.activity-member-elsewhere') !== null, true);
  ui.click('[data-view="chat"]');
  ui.click('[data-conversation="room-a"]');
  assert.equal(ticker.hidden, false);
  assert.match(ticker.textContent, /^lead /);
  assert.equal(ticker.querySelector('.activity-member-elsewhere'), null);
});

test('the composer ticker shows visible busy destinations without naming private conversations', async (t) => {
  const ui = await fixture(t, { hash: '#team-chat' });
  ui.click('[data-conversation="room-a"]');

  const next = initialState();
  next.conversations[1] = {
    ...next.conversations[1],
    members: ['user', 'lead', 'dev', 'researcher', 'ops'],
  };
  next.conversations.push(
    { id: 'home', kind: 'room', name: 'Mu home', members: ['user', 'dev'] },
    { id: 'dm-researcher', kind: 'direct', members: ['user', 'researcher'] },
    { id: 'private', kind: 'room', name: 'Secret room', members: ['ops'] },
  );
  next.agents = [
    { ...next.agents[0], activeMessageId: 7, activeConversationId: 'room-a' },
    {
      id: 'dev',
      role: 'worker',
      adapter: 'manual',
      status: 'working',
      task: '',
      cwd: '/project',
      createdAt,
      activeMessageId: 8,
      activeConversationId: 'home',
    },
    {
      id: 'researcher',
      role: 'worker',
      adapter: 'manual',
      status: 'working',
      task: '',
      cwd: '/project',
      createdAt,
      activeMessageId: 9,
      activeConversationId: 'dm-researcher',
    },
    {
      id: 'ops',
      role: 'worker',
      adapter: 'manual',
      status: 'working',
      task: '',
      cwd: '/project',
      createdAt,
      activeMessageId: 10,
      activeConversationId: 'private',
    },
  ];
  ui.update(next);

  const ticker = ui.$('#activity-ticker');
  assert.equal(ticker.hidden, false);
  assert.match(
    ticker.textContent,
    /^lead [a-z].*··· dev busy in Mu home researcher busy in a direct chat ops busy elsewhere$/,
  );
  assert.equal(ticker.querySelectorAll('.activity-member-elsewhere').length, 3);
  assert.equal(ticker.textContent.includes('Secret room'), false);
});

test('ticker changes keep the open chat pinned when it was already at the bottom', async (t) => {
  const ui = await fixture(t, { hash: '#team-chat' });
  const messages = ui.$('#messages');
  Object.defineProperties(messages, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 200, configurable: true },
  });
  messages.scrollTop = 800;
  const next = initialState();
  next.agents[0] = { ...next.agents[0], activeMessageId: 7, activeConversationId: 'dm-lead' };
  ui.update(next);
  assert.equal(ui.$('#activity-ticker').hidden, false);
  assert.equal(messages.scrollTop, messages.scrollHeight);

  messages.scrollTop = 800;
  next.agents[0] = {
    ...next.agents[0],
    status: 'error',
    activeMessageId: null,
    activeConversationId: null,
  };
  ui.update(next);
  assert.equal(ui.$('#activity-ticker').hidden, true);
  assert.equal(messages.scrollTop, messages.scrollHeight);
});

test('a new message is appended to the open chat, and neither the other rows nor the cards are drawn again', async (t) => {
  const ui = await fixture(t);
  ui.click('.rail-link[data-view="chat"]');
  const row = ui.$('#messages [data-message="1"]');
  const agentCard = ui.$('[data-agent="lead"]');
  const taskCard = ui.$('#task-list [data-task="task-a"]');
  const next = initialState();
  next.messages.push(message(3), message(4, 'room-a'));
  ui.update(next);
  assert.deepEqual(shownIds(ui), [1, 3]);
  assert.equal(ui.$('#messages [data-message="1"]'), row, 'the shown row stays');
  assert.equal(ui.$('[data-agent="lead"]'), agentCard);
  assert.equal(ui.$('#task-list [data-task="task-a"]'), taskCard);
  assert.equal(unreadOf(ui, 'Review changes'), '1', 'a message in a closed conversation counts as unread');

  next.agents[0].status = 'working';
  ui.update(next);
  assert.notEqual(ui.$('[data-agent="lead"]'), agentCard, 'the changed agent is drawn again');
  assert.equal(ui.$('#messages [data-message="1"]'), row, 'an agent change does not rebuild the chat');
  assert.equal(ui.$('#task-list [data-task="task-a"]'), taskCard);
});

test('a gap in the batch numbers replaces the stream, and the new snapshot repairs the page', async (t) => {
  const ui = await fixture(t);
  assert.equal(ui.streams.length, 1);
  ui.send('changes', {
    seq: 5,
    changes: [{ kind: 'agents', id: 'lead', value: { ...initialState().agents[0], status: 'error' } }],
  });
  assert.equal(ui.streams[0].readyState, 2, 'the stream with the gap is closed');
  assert.equal(ui.streams.length, 2);
  assert.equal(
    ui.$('[data-agent="lead"] .status-badge').textContent,
    'Ready',
    'the batch after the gap is not applied',
  );
  await settle();
  assert.equal(ui.$('[data-agent="lead"] .status-badge').textContent, 'Ready');
  assert.equal(ui.$('#page-error').hidden, true);
  const next = initialState();
  next.agents[0].status = 'working';
  ui.update(next);
  assert.equal(ui.$('[data-agent="lead"] .status-badge').textContent, 'Working', 'the new stream applies batches');
});

test('a snapshot after a reconnect fetches the messages missed meanwhile, for the open chat and the unread counts', async (t) => {
  const ui = await fixture(t);
  ui.click('.rail-link[data-view="chat"]');
  const missed = initialState();
  missed.messages.push(message(3), message(4, 'room-a'), message(5, 'room-a'), message(6));
  // Mu restarted while the stream was down: the stream reconnects, names a batch of the old process, and gets a snapshot.
  ui.serve(missed);
  const requestsBefore = historyRequests(ui).length;
  ui.send('snapshot', snapshotOf(missed, 0));
  await settle();
  assert.deepEqual(historyRequests(ui).slice(requestsBefore).sort(), [
    '/api/conversations/dm-lead/messages?limit=1000&after=1',
    '/api/conversations/room-a/messages?limit=100&after=2',
  ]);
  assert.deepEqual(shownIds(ui), [1, 3, 6]);
  assert.equal(unreadOf(ui, 'Review changes'), '2');
});

test('a reference to a message older than the loaded page loads earlier pages and shows it', async (t) => {
  const initial = initialState();
  initial.messages = [
    ...Array.from({ length: 350 }, (_, index) => ({ ...message(index + 1, 'room-a'), text: `Room ${index + 1}` })),
    { ...message(351), text: 'See `#5`' },
  ];
  const ui = await fixture(t, { initial });
  ui.click('#messages .message-ref');
  await settle();
  const target = ui.$('#messages [data-message="5"]');
  assert.ok(target, 'the old message is shown');
  assert.ok(target.classList.contains('revealed'));
  assert.equal(ui.scrolls.at(-1).element, target);
  assert.deepEqual(shownIds(ui).length, 350, 'the history is contiguous from the first page down to the message');
  assert.deepEqual(
    historyRequests(ui).filter((path) => path.includes('room-a') || path.startsWith('/api/messages/')),
    [
      '/api/messages/5',
      '/api/conversations/room-a/messages?limit=300',
      '/api/conversations/room-a/messages?limit=300&before=51',
    ],
  );
});

test('a reference to a message ID beyond the newest one the dashboard knows stays literal', async (t) => {
  const initial = initialState();
  initial.messages.push({ ...message(3), text: 'Soon `#4`', createdAt });
  const ui = await fixture(t, { initial });
  assert.equal(ui.$('#messages .message-ref'), null);
});
