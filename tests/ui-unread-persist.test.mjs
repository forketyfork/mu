import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, initialState, message, settle } from './ui-fixture.mjs';

const KEY = 'mu:chat-viewed';
const record = (ui) => JSON.parse(ui.window.localStorage.getItem(KEY));
const railBadge = (ui) => (ui.$('#chat-unread').hidden ? '' : ui.$('#chat-unread').textContent);
const unreadOf = (ui, name) =>
  [...ui.$('#conversation-list').querySelectorAll('.conversation-option')]
    .find((option) => option.textContent.includes(name))
    ?.querySelector('.unread-count')?.textContent ?? '';
const tinted = (ui) =>
  [...ui.$('#messages').querySelectorAll('.message.new .message-id')].map((item) => item.textContent);

// Messages 3 (private chat) and 4 (room) arrive from the lead after the page opened.
const withArrivals = () => {
  const next = initialState();
  next.messages.push(message(3), message(4, 'room-a'));
  return next;
};

test('a first load with nothing stored marks no history unread, and stores that as the starting position', async (t) => {
  const ui = await fixture(t, { initial: withArrivals() });
  assert.equal(railBadge(ui), '');
  assert.deepEqual(record(ui), { 'dm-lead': 3, 'room-a': 4 });
  assert.deepEqual(
    ui.requests.filter((request) => !request.stream).map((request) => request.path),
    ['/api/conversations/dm-lead/messages?limit=300'],
    'nothing is missing, so no conversation is fetched for its count',
  );
});

test('unread messages survive a reload, and opening the conversation clears them for the next reload', async (t) => {
  const first = await fixture(t, { initial: initialState() });
  first.update(withArrivals());
  assert.equal(railBadge(first), '2');

  const reloaded = await fixture(t, { initial: withArrivals(), storage: first.stored() });
  assert.equal(railBadge(reloaded), '2', 'the rail badge');
  reloaded.click('.rail-link[data-view="chat"]');
  assert.equal(unreadOf(reloaded, 'Review changes'), '1');
  assert.deepEqual(tinted(reloaded), ['#3'], 'the private chat shows what it received since the last visit');

  reloaded.click('[data-conversation="room-a"]');
  await settle();
  assert.deepEqual(tinted(reloaded), ['#4']);
  assert.equal(unreadOf(reloaded, 'Review changes'), '');

  const again = await fixture(t, { initial: withArrivals(), storage: reloaded.stored() });
  assert.equal(railBadge(again), '', 'both conversations were read');
  again.click('.rail-link[data-view="chat"]');
  assert.deepEqual(tinted(again), []);
});

test('messages that arrived while no tab was open count as unread on the next load, however long ago', async (t) => {
  const initial = initialState();
  for (let id = 3; id <= 7; id += 1) initial.messages.push(message(id, id % 2 ? 'room-a' : 'dm-lead'));
  initial.messages.push({ ...message(8), from: 'user' });
  const ui = await fixture(t, { initial, storage: { [KEY]: JSON.stringify({ 'dm-lead': 1, 'room-a': 2 }) } });
  ui.click('.rail-link[data-view="chat"]');
  assert.equal(unreadOf(ui, 'Review changes'), '3', 'the room: 3, 5, 7');
  assert.equal(railBadge(ui), '3', "the private chat is open and read; the user's own message is never unread");
  assert.deepEqual(record(ui), { 'dm-lead': 8, 'room-a': 2 }, 'only the conversation that was shown moved on');
});

test('a conversation the record does not know is new: all of its messages are unread', async (t) => {
  const ui = await fixture(t, { initial: initialState(), storage: { [KEY]: JSON.stringify({ 'dm-lead': 1 }) } });
  assert.equal(railBadge(ui), '1');
  ui.click('.rail-link[data-view="chat"]');
  assert.equal(unreadOf(ui, 'Review changes'), '1');
});

test('a count stops at the page it reads and then shows 99+', async (t) => {
  const initial = initialState();
  for (let id = 3; id < 263; id += 1) initial.messages.push(message(id, 'room-a'));
  const ui = await fixture(t, { initial, storage: { [KEY]: JSON.stringify({ 'dm-lead': 1, 'room-a': 2 }) } });
  assert.equal(railBadge(ui), '99+');
  ui.click('.rail-link[data-view="chat"]');
  assert.equal(unreadOf(ui, 'Review changes'), '99+');
  const fetched = ui.requests.filter((request) => String(request.path).includes('/room-a/messages?limit=100'));
  assert.equal(fetched.length, 1, 'one page of 100 is enough to know the label');
});

test('a second tab that reads a conversation clears its marker here, and an unrelated key changes nothing', async (t) => {
  const ui = await fixture(t, { initial: initialState() });
  ui.update(withArrivals());
  assert.equal(railBadge(ui), '2');
  ui.otherTab('mu:theme', 'dark');
  assert.equal(railBadge(ui), '2');
  ui.otherTab(KEY, JSON.stringify({ ...record(ui), 'dm-lead': 3 }));
  assert.equal(railBadge(ui), '1');
  ui.otherTab(KEY, JSON.stringify({ 'dm-lead': 3, 'room-a': 4 }));
  assert.equal(railBadge(ui), '');
});

test('a tab that is behind does not move the stored position back', async (t) => {
  const initial = withArrivals();
  const ui = await fixture(t, { initial });
  ui.click('.rail-link[data-view="chat"]');
  ui.otherTab(KEY, JSON.stringify({ 'dm-lead': 4, 'room-a': 4 }));
  ui.update({ ...initial, messages: [...initial.messages, message(5, 'room-a')] });
  assert.equal(record(ui)['dm-lead'], 4, 'a position that exists is kept when this tab reads less');
});

test('a position beyond the newest message belongs to another history and does not hide new messages', async (t) => {
  const ui = await fixture(t, {
    initial: initialState(),
    storage: { [KEY]: JSON.stringify({ 'dm-lead': 900, 'room-a': 900 }) },
  });
  assert.equal(railBadge(ui), '');
  ui.update(withArrivals());
  assert.equal(railBadge(ui), '2');
  ui.click('.rail-link[data-view="chat"]');
  assert.equal(record(ui)['dm-lead'], 3, 'reading replaces the position that cannot be real');
  ui.click('.rail-link[data-view="workspace"]');
  const next = withArrivals();
  next.messages.push(message(5));
  ui.update(next);
  assert.equal(unreadOf(ui, 'Review changes'), '1');
  assert.equal(railBadge(ui), '2', 'the new message in the private chat and the room message are unread');
});

test('the record drops conversations that no longer exist when it is written', async (t) => {
  const ui = await fixture(t, {
    initial: initialState(),
    storage: { [KEY]: JSON.stringify({ 'dm-lead': 1, 'room-a': 2, 'room-deleted': 40 }) },
  });
  assert.equal(record(ui)['room-deleted'], 40, 'reading nothing writes nothing');
  ui.click('.rail-link[data-view="chat"]');
  assert.deepEqual(record(ui), { 'dm-lead': 1, 'room-a': 2 });
});

test('an unreadable record is reported in the console with its text, then replaced by the starting position', async (t) => {
  for (const raw of ['not json', '[1]', 'null', '{"dm-lead":"4"}', '{"dm-lead":-1}', '{"dm-lead":1.5}']) {
    const ui = await fixture(t, { initial: withArrivals(), storage: { [KEY]: raw } });
    assert.equal(ui.consoleErrors.length, 1, raw);
    assert.match(ui.consoleErrors[0], /unreadable record of read messages/);
    assert.ok(ui.consoleErrors[0].endsWith(raw), 'the stored text is in the report');
    assert.equal(railBadge(ui), '');
    assert.deepEqual(record(ui), { 'dm-lead': 3, 'room-a': 4 });
  }
});

test('a record that is cleared by another tab is treated as a first load', async (t) => {
  const ui = await fixture(t, { initial: initialState() });
  ui.update(withArrivals());
  assert.equal(railBadge(ui), '2');
  ui.otherTab(KEY, null);
  assert.equal(railBadge(ui), '');
  assert.deepEqual(record(ui), { 'dm-lead': 3, 'room-a': 4 });
});

test('a conversation of verified work is not kept in the record', async (t) => {
  const initial = initialState();
  initial.tasks[0].status = 'verified';
  const ui = await fixture(t, { initial, storage: { [KEY]: JSON.stringify({ 'dm-lead': 1, 'room-a': 2 }) } });
  ui.click('.rail-link[data-view="chat"]');
  assert.deepEqual(record(ui), { 'dm-lead': 1 });
});

test('a position that another tab erased by writing at the same moment is put back', async (t) => {
  const ui = await fixture(t, { initial: withArrivals() });
  ui.click('.rail-link[data-view="chat"]');
  ui.click('[data-conversation="room-a"]');
  await settle();
  assert.deepEqual(record(ui), { 'dm-lead': 3, 'room-a': 4 });
  // The other tab read the record before this tab's write and replaced it after, with an advance of its own.
  ui.otherTab(KEY, JSON.stringify({ 'dm-lead': 3, 'room-a': 2, extra: 1 }));
  assert.deepEqual(record(ui), { 'dm-lead': 3, 'room-a': 4, extra: 1 });
  assert.equal(unreadOf(ui, 'Review changes'), '', 'the room stays read');
});

test('a record that another tab cleared is not put back from this tab', async (t) => {
  const ui = await fixture(t, { initial: withArrivals() });
  ui.click('.rail-link[data-view="chat"]');
  ui.otherTab(KEY, null);
  assert.deepEqual(record(ui), { 'dm-lead': 3, 'room-a': 4 });
});

test('a room that returns from the archive is unread again, and no stale position is put back for it', async (t) => {
  const initial = initialState();
  const ui = await fixture(t, { initial, storage: { [KEY]: JSON.stringify({ 'dm-lead': 1 }) } });
  ui.click('.rail-link[data-view="chat"]');
  ui.click('[data-conversation="room-a"]');
  await settle();
  assert.deepEqual(record(ui), { 'dm-lead': 1, 'room-a': 2 });
  const verified = structuredClone(initial);
  verified.tasks[0].status = 'verified';
  ui.update(verified);
  ui.click('[data-conversation="dm-lead"]');
  assert.deepEqual(record(ui), { 'dm-lead': 1 }, 'the archived room is forgotten');
  ui.update(initial);
  assert.equal(unreadOf(ui, 'Review changes'), '1', 'the returned room is unknown, so its messages are unread');
  ui.otherTab(KEY, JSON.stringify({ 'dm-lead': 1 }));
  assert.deepEqual(record(ui), { 'dm-lead': 1 }, 'the old position of the room is not restored');
});
