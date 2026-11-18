import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, initialState, message, settle } from './ui-fixture.mjs';

const KEY = 'mu:chat-viewed';
const record = (ui) => JSON.parse(ui.window.localStorage.getItem(KEY));
const railMentions = (ui) => (ui.$('#chat-mentions').hidden ? '' : ui.$('#chat-mentions').textContent);
const railUnread = (ui) => (ui.$('#chat-unread').hidden ? '' : ui.$('#chat-unread').textContent);
const rowBadges = (ui, name) => {
  const option = [...ui.$('#conversation-list').querySelectorAll('.conversation-option')].find((item) =>
    item.textContent.includes(name),
  );
  return {
    unread: option.querySelector('.unread-count')?.textContent ?? '',
    mentions: option.querySelector('.mention-count')?.textContent ?? '',
  };
};
const listed = (ui) =>
  [...ui.$('#mention-items').querySelectorAll('.mention-item')].map((item) => ({
    id: item.dataset.message,
    where: item.querySelector('.mention-item-where').textContent,
    text: item.querySelector('.mention-item-text').textContent,
  }));

const mention = (id, conversationId, mentions = ['user'], from = 'lead') => ({
  ...message(id, conversationId),
  from,
  mentions,
  text: `Needs you ${id}`,
});

// After the page opened: the private chat gets a plain message and a mention, the room gets a mention and two messages
// that only look like one.
const withArrivals = () => {
  const next = initialState();
  next.messages.push(
    message(3),
    mention(4, 'dm-lead'),
    mention(5, 'room-a'),
    mention(6, 'room-a', ['all']),
    mention(7, 'room-a', ['lead']),
    { ...mention(8, 'room-a'), from: 'user' },
  );
  return next;
};

test('a mention gets its own badge beside the unread one, on the chat icon and on its conversation row', async (t) => {
  const ui = await fixture(t, { initial: initialState() });
  ui.update(withArrivals());
  assert.equal(railUnread(ui), '5', 'every message from an agent is unread');
  assert.equal(railMentions(ui), '@2', 'only an explicit @user counts: not @all, not another member, not your own');
  ui.click('.rail-link[data-view="chat"]');
  assert.deepEqual(rowBadges(ui, 'Review changes'), { unread: '3', mentions: '@1' });
  assert.equal(
    ui.$('#conversation-mentions').textContent,
    '@1',
    'the summary of the list shows the total of what is still unread',
  );
});

test('a conversation without mentions has no mentions badge, and the icon has none while nothing mentions you', async (t) => {
  const ui = await fixture(t, { initial: initialState() });
  const next = initialState();
  next.messages.push(message(3, 'room-a'), mention(4, 'room-a', ['all']));
  ui.update(next);
  assert.equal(railUnread(ui), '2');
  assert.equal(railMentions(ui), '');
  ui.click('.rail-link[data-view="chat"]');
  assert.deepEqual(rowBadges(ui, 'Review changes'), { unread: '2', mentions: '' });
});

test('the list shows each unread mention with its conversation, sender and text, newest first', async (t) => {
  const ui = await fixture(t, { initial: initialState() });
  ui.update(withArrivals());
  assert.deepEqual(listed(ui), [
    { id: '5', where: '# Review changes · lead', text: 'Needs you 5' },
    { id: '4', where: '@lead · lead', text: 'Needs you 4' },
  ]);
  assert.ok(ui.$('#mention-items .mention-item-time').dateTime, 'each carries its time');
});

test('opening a mention from the list shows its message and reads its conversation, so both counts drop', async (t) => {
  const ui = await fixture(t, { initial: initialState() });
  ui.update(withArrivals());
  ui.$('#mention-items .mention-item[data-message="5"]').click();
  await settle();
  assert.equal(ui.$('#team-chat').hidden, false, 'the chat opens');
  assert.equal(ui.$('#chat-title').textContent, 'Review changes');
  assert.ok(ui.$('#messages [data-message="5"]'), 'the message is shown');
  assert.equal(railMentions(ui), '@1', 'the other conversation still holds its mention');
  assert.deepEqual(
    listed(ui).map((entry) => entry.id),
    ['4'],
  );
  assert.equal(railUnread(ui), '2', 'only the private chat is unread now: 3 and 4');
  assert.equal(record(ui)['room-a'], 8);
});

test('mentions survive a reload and are read by the same position as their messages', async (t) => {
  const first = await fixture(t, { initial: initialState() });
  first.update(withArrivals());
  const reloaded = await fixture(t, { initial: withArrivals(), storage: first.stored() });
  assert.equal(railMentions(reloaded), '@2');
  assert.deepEqual(
    listed(reloaded).map((entry) => entry.id),
    ['5', '4'],
  );
  reloaded.click('.rail-link[data-view="chat"]');
  assert.equal(railMentions(reloaded), '@1', 'the private chat opens first and is read, with its mention');
  reloaded.click('[data-conversation="room-a"]');
  await settle();
  assert.equal(railMentions(reloaded), '');

  const again = await fixture(t, { initial: withArrivals(), storage: reloaded.stored() });
  assert.equal(railMentions(again), '', 'both conversations were read');
  assert.equal(listed(again).length, 0);
});

test('a second tab that reads a conversation clears its mentions here', async (t) => {
  const ui = await fixture(t, { initial: initialState() });
  ui.update(withArrivals());
  ui.otherTab(KEY, JSON.stringify({ ...record(ui), 'room-a': 8 }));
  assert.equal(railMentions(ui), '@1');
  ui.otherTab(KEY, JSON.stringify({ 'dm-lead': 8, 'room-a': 8 }));
  assert.equal(railMentions(ui), '');
  assert.equal(listed(ui).length, 0);
});

test('a mention counts up to the page the unread count reads, and then shows 99+', async (t) => {
  const initial = initialState();
  for (let id = 3; id < 263; id += 1) initial.messages.push(mention(id, 'room-a'));
  const ui = await fixture(t, { initial, storage: { [KEY]: JSON.stringify({ 'dm-lead': 1, 'room-a': 2 }) } });
  assert.equal(railMentions(ui), '@99+');
});
