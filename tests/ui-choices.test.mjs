import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, initialState, message, settle } from './ui-fixture.mjs';

function asking(conversationId = 'dm-lead') {
  const state = initialState();
  state.messages = [
    message(1),
    message(2, 'room-a'),
    { ...message(3, conversationId), text: 'The plan is ready.\n\nStart the change?', choices: ['Yes', 'Not yet'] },
  ];
  return state;
}

const answer = (conversationId, choice) => ({
  ...message(4, conversationId),
  from: 'user',
  text: `> Re: \`#3\` Start the change?\n\n${choice}`,
  answers: 3,
  choice,
});

const choiceButtons = ($) =>
  [...$('#messages [data-message="3"] .message-choices').querySelectorAll('button')].map((button) => [
    button.textContent,
    button.disabled,
  ]);

test('a question shows a button per choice, and the click sends that label for that message', async (t) => {
  const { $, requests, update } = await fixture(t, { initial: asking() });
  assert.deepEqual(choiceButtons($), [
    ['Yes', false],
    ['Not yet', false],
    ['Reply in words', false],
  ]);
  $('#messages [data-message="3"] .choice:nth-child(2)').click();
  await settle();
  const sent = requests.find((item) => item.path === '/api/messages/3/choice');
  assert.equal(sent.options.method, 'POST');
  assert.deepEqual(JSON.parse(sent.options.body), { choice: 'Not yet' });
  assert.equal(
    $('#messages [data-message="3"] .message-choices').textContent,
    'You choseNot yet',
    'the click is shown as the answer before the reply arrives',
  );

  const next = asking();
  next.messages.push(answer('dm-lead', 'Not yet'));
  update(next);
  await settle();
  const block = $('#messages [data-message="3"] .message-choices');
  assert.ok(block.classList.contains('answered'));
  assert.equal(block.querySelectorAll('button').length, 0, 'an answered question offers no buttons');
  assert.equal(block.querySelector('.choice-chosen').textContent, 'Not yet');
});

test('an answer from another tab closes the question, and a reload shows it answered', async (t) => {
  const { $, update } = await fixture(t, { initial: asking() });
  const next = asking();
  next.messages.push(answer('dm-lead', 'Yes'));
  update(next);
  await settle();
  assert.equal($('#messages [data-message="3"] .choice-chosen').textContent, 'Yes');

  const reloaded = await fixture(t, { initial: next });
  assert.equal(reloaded.$('#messages [data-message="3"] .choice-chosen').textContent, 'Yes');
});

test('a refused answer gives the buttons back and says why', async (t) => {
  const { $, window } = await fixture(t, { initial: asking() });
  const fetch = window.fetch;
  window.fetch = async (path, options) =>
    path === '/api/messages/3/choice'
      ? { ok: false, status: 409, json: async () => ({ error: 'Message #3 is already answered' }) }
      : fetch(path, options);
  $('#messages [data-message="3"] .choice').click();
  await settle();
  assert.deepEqual(choiceButtons($), [
    ['Yes', false],
    ['Not yet', false],
    ['Reply in words', false],
  ]);
  assert.equal($('#chat-error').hidden, false);
  assert.match($('#chat-error').textContent, /Answer not sent: Message #3 is already answered/);
});

test('replying in words quotes the question under the draft, and mentions the asker in a room', async (t) => {
  const { $, window } = await fixture(t, { initial: asking('room-a') });
  $('.rail-link[data-view="chat"]').click();
  $('[data-conversation="room-a"]').click();
  await settle();
  assert.equal($('#team-chat').hidden, false);
  const input = /** @type {HTMLTextAreaElement} */ ($('#message-input'));
  input.value = 'Draft';
  $('#messages [data-message="3"] .choice-words').click();
  assert.equal(input.value, 'Draft\n\n@lead\n\n> Re: `#3`\n\n');
  assert.equal(window.document.activeElement, input);
  assert.equal(input.selectionStart, input.value.length);
});
