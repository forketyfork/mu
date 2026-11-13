import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, initialState, message, settle } from './ui-fixture.mjs';

const tinted = ($) => [...$('#messages').querySelectorAll('.message.new .message-id')].map((item) => item.textContent);

test('messages that arrived since the chat was last open are tinted on the next open and clear on the one after', async (t) => {
  const { $, click, update } = await fixture(t, { initial: initialState() });
  click('.rail-link[data-view="chat"]');
  assert.deepEqual(tinted($), [], 'the first open records the history as seen');
  click('.rail-link[data-view="workspace"]');
  const next = initialState();
  next.messages.push(message(3), { ...message(4), from: 'user' }, message(5));
  update(next);
  click('.rail-link[data-view="chat"]');
  assert.deepEqual(tinted($), ['#3', '#5'], "the user's own message is not tinted");
  update({ ...next, messages: [...next.messages, message(6)] });
  assert.deepEqual(tinted($), ['#3', '#5', '#6'], 'a message arriving while reading is tinted too');
  click('.rail-link[data-view="workspace"]');
  click('.rail-link[data-view="chat"]');
  assert.deepEqual(tinted($), [], 'the tint clears on the next open');
});

test('opening another conversation tints only what it received since it was last seen', async (t) => {
  const { $, click, update } = await fixture(t, { initial: initialState() });
  click('.rail-link[data-view="chat"]');
  const next = initialState();
  next.messages.push(message(3, 'room-a'), message(4));
  update(next);
  assert.deepEqual(tinted($), ['#4'], 'arrivals while reading stay tinted');
  const room = [...$('#conversation-list').querySelectorAll('button')].find((button) =>
    button.textContent.includes('Review changes'),
  );
  room.click();
  await settle();
  assert.deepEqual(tinted($), ['#3']);
});
