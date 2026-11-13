import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, initialState, message, settle } from './ui-fixture.mjs';

function stateWithText(text) {
  const state = initialState();
  state.messages = [message(1), { ...message(2, 'room-a'), text: 'Room message' }, { ...message(3), text }];
  return state;
}

test('every chat message shows its ID', async (t) => {
  const { $ } = await fixture(t, { initial: stateWithText('hello') });
  assert.deepEqual(
    [...$('#messages').querySelectorAll('.message-id')].map((item) => item.textContent),
    ['#1', '#3'],
  );
});

test('only a backticked message ID becomes a link; plain numbers stay text', async (t) => {
  const { $ } = await fixture(t, {
    initial: stateWithText('See `#1`, PR #2, sample-repo#2 and `#99` and `#1x`, `PR #2`.'),
  });
  const body = $('#messages .message:last-child .message-text');
  assert.deepEqual(
    [...body.querySelectorAll('a.message-ref')].map((item) => item.textContent),
    ['#1'],
  );
  assert.match(body.textContent, /PR #2, sample-repo#2 and #99 and #1x, PR #2\./);
  assert.deepEqual(
    [...body.querySelectorAll('code')].map((item) => item.textContent),
    ['#99', '#1x', 'PR #2'],
  );
});

test('a message link scrolls to and highlights a message in the same conversation', async (t) => {
  const { $, click, scrolls } = await fixture(t, { initial: stateWithText('Look at `#1`') });
  click('#messages .message-ref');
  await settle();
  const target = $('#messages [data-message="1"]');
  assert.ok(target.classList.contains('revealed'));
  assert.equal(scrolls.at(-1).element, target);
  assert.equal($('#messages [data-message="3"]').classList.contains('revealed'), false);
});

test('a message link into another conversation opens it and highlights the message', async (t) => {
  const { $, click, scrolls } = await fixture(t, { initial: stateWithText('Look at `#2`') });
  assert.equal($('#messages [data-message="2"]'), null);
  click('#messages .message-ref');
  await settle();
  const target = $('#messages [data-message="2"]');
  assert.ok(target, 'the room conversation is open');
  assert.ok(target.classList.contains('revealed'));
  assert.equal(scrolls.at(-1).element, target);
});
