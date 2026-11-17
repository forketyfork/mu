import test from 'node:test';
import assert from 'node:assert/strict';
import { filterMentionEntries, mentionEntries, mentionTrigger } from '../public/model.js';
import { mentions } from '../src/store.mjs';
import { fixture, initialState, settle } from './ui-fixture.mjs';

const agent = (id, status = 'idle', role = 'worker') => ({
  id,
  role,
  adapter: 'manual',
  status,
  task: '',
  cwd: '/project',
  createdAt: '2026-11-04T10:00:00Z',
});

const workspace = () => {
  const state = initialState();
  state.agents.push(
    agent('api-worker', 'working'),
    agent('docs-writer'),
    agent('retired', 'stopped'),
    agent('outsider'),
  );
  state.conversations = [
    { id: 'dm-lead', kind: 'direct', members: ['user', 'lead'] },
    { id: 'dm-api-worker', kind: 'direct', members: ['user', 'api-worker'] },
    { id: 'common', name: 'Common', kind: 'common', members: ['user', 'lead', 'api-worker', 'docs-writer'] },
    {
      id: 'room-a',
      name: 'Review changes',
      kind: 'room',
      members: ['user', 'lead', 'api-worker', 'docs-writer', 'retired'],
    },
  ];
  return state;
};

test('the trigger is the name being typed at the caret, and only where Mu would count a mention', () => {
  const at = (text, caret = text.length) => mentionTrigger(text, caret);
  assert.deepEqual(at('@'), { start: 0, end: 1, query: '' });
  assert.deepEqual(at('hello @le'), { start: 6, end: 9, query: 'le' });
  assert.deepEqual(at('see\n@Api-w'), { start: 4, end: 10, query: 'Api-w' });
  assert.deepEqual(at('(@lead'), { start: 1, end: 6, query: 'lead' });
  assert.deepEqual(
    at('@lead is @wo', 5),
    { start: 0, end: 5, query: 'lead' },
    'the caret may stand at the end of an earlier name',
  );
  assert.deepEqual(at('@lead', 3), { start: 0, end: 5, query: 'le' }, 'a pick replaces the rest of the name too');
  assert.equal(at('@lead '), null, 'a space ends the name');
  assert.equal(at('@lead is'), null);
  assert.equal(at('hello'), null);
  assert.equal(at('mail me@host'), null, 'an e-mail address');
  assert.equal(at('@@lead'), null);
  assert.equal(at('@scope/pkg', 6), null, 'a scoped package name');
  assert.equal(at('a/@lead'), null);
  assert.equal(at('@1'), null, 'an ID starts with a letter');
  assert.equal(at('@-'), null);
  assert.equal(at(`@${'a'.repeat(25)}`), null, 'longer than any ID');
});

test('a backtick that nothing closes yet opens code, where Mu would still count the mention', () => {
  assert.equal(mentionTrigger('run `@le', 8), null);
  assert.equal(mentionTrigger('run `@le'.concat(' and `x`'), 8), null);
  assert.deepEqual(mentions('run `@le'), ['le']);
});

test('no trigger inside code, and one again after the code ends', () => {
  const at = (text, caret = text.length) => mentionTrigger(text, caret);
  assert.equal(at('run `@le', 8), null, 'caret in a span that the rest of the text closes');
  assert.equal(at('run `@le` now', 8), null);
  assert.equal(at('```\n@le'), null, 'an open fence runs to the end');
  assert.equal(at('~~~\n@le\n~~~\ndone'.slice(0, 7)), null);
  assert.equal(at('`code` @le')?.query, 'le');
  assert.equal(at('```\ncode\n```\n@le')?.query, 'le');
  assert.equal(at('`@a` @b')?.query, 'b');
  assert.equal(at('``a`b`` @c')?.query, 'c', 'a double backtick span holds a single one');
});

// The dashboard cannot import src/, so its reading of a message is a copy of `mentions`. They must never differ about
// where a typed name counts.
test('the trigger agrees with the mentions that Mu counts', () => {
  const prefixes = [
    '',
    'hello ',
    'x',
    'me@',
    '@',
    '`a` ',
    '``a`b`` ',
    '```\n',
    '```\ncode\n```\n',
    '~~~\n@x\n',
    'a/',
    'a/@b ',
    '(',
    '\n',
    'pkg@',
    '@scope/',
  ];
  for (const prefix of prefixes) {
    const text = `${prefix}@zz`;
    assert.equal(
      mentionTrigger(text, text.length)?.query === 'zz',
      mentions(text).includes('zz'),
      `Mu and the dashboard disagree about ${JSON.stringify(text)}`,
    );
  }
});

test('the entries are the live members that can be mentioned, with @all where it routes', () => {
  const state = workspace();
  const entries = (id) =>
    mentionEntries(
      state.conversations.find((conversation) => conversation.id === id),
      state.agents,
    );
  assert.deepEqual(
    entries('room-a').map((entry) => entry.id),
    ['all', 'lead', 'api-worker', 'docs-writer'],
    'no user, no stopped agent, no agent outside the room',
  );
  assert.deepEqual(
    entries('room-a').map((entry) => entry.hint),
    ['Everyone in this conversation', 'Team lead · Ready', 'Worker · Working', 'Worker · Ready'],
  );
  assert.deepEqual(
    entries('common').map((entry) => entry.id),
    ['all', 'lead', 'api-worker', 'docs-writer'],
  );
  assert.deepEqual(
    entries('dm-api-worker').map((entry) => entry.id),
    ['api-worker'],
    'a private chat delivers without a mention, so @all has no use there',
  );
  state.agents.find((item) => item.id === 'docs-writer').status = 'error';
  assert.ok(
    entries('room-a').some((entry) => entry.id === 'docs-writer'),
    'a failed agent is still mentionable',
  );
});

test('filtering ranks a prefix before a contained word and ignores case', () => {
  const entries = ['all', 'lead', 'api-worker', 'docs-writer', 'worker'].map((id) => ({ id, hint: '' }));
  assert.deepEqual(
    filterMentionEntries(entries, 'wor').map((entry) => entry.id),
    ['worker', 'api-worker'],
  );
  assert.deepEqual(
    filterMentionEntries(entries, 'LE').map((entry) => entry.id),
    ['lead'],
  );
  assert.equal(filterMentionEntries(entries, 'zzz').length, 0);
  assert.equal(filterMentionEntries(entries, '').length, 5);
});

async function chat(t, conversation = 'room-a') {
  const ui = await fixture(t, { initial: workspace() });
  ui.click('.rail-link[data-view="chat"]');
  await settle();
  ui.$(`#conversation-list [data-conversation="${conversation}"]`).click();
  await settle();
  const input = ui.$('#message-input');
  const type = (text, caret = text.length) => {
    input.focus();
    input.value = text;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  };
  const press = (key, init = {}) => {
    const event = new ui.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(event);
    return event;
  };
  const list = ui.$('#mention-suggestions');
  const ids = () => [...list.querySelectorAll('[role="option"] strong')].map((option) => option.textContent);
  const highlighted = () => list.querySelector('[aria-selected="true"] strong')?.textContent;
  return { ui, input, type, press, list, ids, highlighted };
}

test('typing @ lists the members of the room and narrows as the name is typed', async (t) => {
  const { ui, input, type, list, ids, highlighted } = await chat(t);
  assert.equal(list.hidden, true);
  type('@');
  assert.equal(list.hidden, false);
  assert.deepEqual(ids(), ['@all', '@lead', '@api-worker', '@docs-writer']);
  assert.deepEqual(
    [...list.querySelectorAll('[role="option"] span')].map((hint) => hint.textContent),
    ['Everyone in this conversation', 'Team lead · Ready', 'Worker · Working', 'Worker · Ready'],
  );
  assert.equal(highlighted(), '@all');
  type('@wor');
  assert.deepEqual(ids(), ['@api-worker']);
  type('@zzz');
  assert.equal(list.hidden, true, 'no match, no empty popup');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  type('@d');
  assert.deepEqual(ids(), ['@docs-writer', '@lead'], 'a name that starts with the text, then one that contains it');
  assert.equal(ui.consoleErrors.length, 0, ui.consoleErrors.join('\n'));
});

test('the message box is a combobox that names the highlighted option', async (t) => {
  const { input, type, press, list } = await chat(t);
  assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(input.getAttribute('aria-controls'), list.id);
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(list.getAttribute('role'), 'listbox');
  type('@');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  const options = [...list.querySelectorAll('[role="option"]')];
  assert.equal(options.length, 4);
  assert.equal(input.getAttribute('aria-activedescendant'), options[0].id);
  assert.deepEqual(
    options.map((option) => option.getAttribute('aria-selected')),
    ['true', 'false', 'false', 'false'],
  );
  press('ArrowDown');
  assert.equal(input.getAttribute('aria-activedescendant'), options[1].id);
  assert.equal(options[0].getAttribute('aria-selected'), 'false');
  assert.equal(options[1].getAttribute('aria-selected'), 'true');
  press('Escape');
  assert.equal(input.hasAttribute('aria-activedescendant'), false);
});

test('arrows move and wrap, Enter and Tab pick, and the pick lands at the caret with a space', async (t) => {
  const { ui, input, type, press, highlighted, list } = await chat(t);
  type('@');
  const down = press('ArrowDown');
  assert.equal(down.defaultPrevented, true, 'the caret stays where it is');
  assert.equal(highlighted(), '@lead');
  press('ArrowUp');
  press('ArrowUp');
  assert.equal(highlighted(), '@docs-writer', 'wraps to the end');
  press('ArrowDown');
  assert.equal(highlighted(), '@all', 'and back to the start');
  press('ArrowDown');
  const enter = press('Enter');
  assert.equal(enter.defaultPrevented, true);
  assert.equal(input.value, '@lead ');
  assert.equal(input.selectionStart, 6);
  assert.equal(list.hidden, true);
  assert.equal(
    ui.requests.filter((request) => request.options?.method === 'POST').length,
    0,
    'Enter picked; it did not send',
  );

  type('please ask @api and @do', 14);
  assert.deepEqual(
    [...list.querySelectorAll('[role="option"] strong')].map((option) => option.textContent),
    ['@api-worker'],
  );
  const tab = press('Tab');
  assert.equal(tab.defaultPrevented, true);
  assert.equal(input.value, 'please ask @api-worker and @do');
  assert.equal(
    input.selectionStart,
    'please ask @api-worker '.length,
    'the caret follows the mention, before the rest',
  );
});

test('a pick that meets a space after the name adds none', async (t) => {
  const { input, type, press } = await chat(t);
  type('@le text', 3);
  press('Enter');
  assert.equal(input.value, '@lead text');
  assert.equal(input.selectionStart, 6, 'the caret passes the space that was there');
});

test('Escape closes the list and keeps the text; typing again can open it', async (t) => {
  const { input, type, press, list } = await chat(t);
  type('hi @');
  const escape = press('Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(list.hidden, true);
  assert.equal(input.value, 'hi @');
  const second = press('Escape');
  assert.equal(second.defaultPrevented, false, 'with the list closed the key is not taken');
  type('hi @l');
  assert.equal(list.hidden, false);
});

test('with the list closed, Enter still sends and Tab is left alone', async (t) => {
  const { ui, input, type, press } = await chat(t);
  type('plain message');
  const tab = press('Tab');
  assert.equal(tab.defaultPrevented, false);
  const enter = press('Enter');
  await settle();
  assert.equal(enter.defaultPrevented, true);
  const sent = ui.requests.find((request) => request.options?.method === 'POST' && /messages/.test(request.path));
  assert.ok(sent, 'the message goes out');
  assert.equal(JSON.parse(sent.options.body).text, 'plain message');
  assert.equal(input.value, '');
});

test('Enter sends a mention that matches nobody instead of swallowing the key', async (t) => {
  const { ui, type, press, list } = await chat(t);
  type('write to @nobody');
  assert.equal(list.hidden, true);
  press('Enter');
  await settle();
  assert.ok(ui.requests.some((request) => request.options?.method === 'POST' && /messages/.test(request.path)));
});

test('Shift+Enter, Shift+Tab and other keys pass through an open list', async (t) => {
  const { type, press, list } = await chat(t);
  type('@');
  assert.equal(press('Enter', { shiftKey: true }).defaultPrevented, false, 'Shift+Enter is a new line');
  assert.equal(list.hidden, false);
  assert.equal(press('Tab', { shiftKey: true }).defaultPrevented, false, 'Shift+Tab goes back through the page');
  assert.equal(press('ArrowLeft').defaultPrevented, false);
  assert.equal(press('a').defaultPrevented, false);
});

test('a space, a newline, a caret move away, or a blur close the list', async (t) => {
  const { ui, input, type, list } = await chat(t);
  type('@le');
  assert.equal(list.hidden, false);
  type('@le ');
  assert.equal(list.hidden, true, 'a space ends the name');
  type('@le\n');
  assert.equal(list.hidden, true);

  type('word @le');
  assert.equal(list.hidden, false);
  input.setSelectionRange(2, 2);
  input.dispatchEvent(new ui.window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(list.hidden, true, 'the caret left the name');
  input.setSelectionRange(8, 8);
  input.dispatchEvent(new ui.window.KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  assert.equal(list.hidden, true, 'moving the caret back into a name does not open the list');

  type('@l');
  assert.equal(list.hidden, false);
  input.blur();
  assert.equal(list.hidden, true);
});

test('a caret move inside the name updates the open list', async (t) => {
  const { ui, input, type, list, ids } = await chat(t);
  type('@api-work');
  assert.deepEqual(ids(), ['@api-worker']);
  input.setSelectionRange(2, 2);
  input.dispatchEvent(new ui.window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(list.hidden, false);
  assert.deepEqual(ids(), ['@all', '@api-worker', '@lead'], 'the name up to the caret is "a"');
  input.setSelectionRange(1, 1);
  input.dispatchEvent(new ui.window.KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
  assert.deepEqual(ids(), ['@all', '@lead', '@api-worker', '@docs-writer'], 'an empty name lists everyone');
});

test('no list in an e-mail address, a code span, or a fenced block', async (t) => {
  const { type, list } = await chat(t);
  type('write to me@lead');
  assert.equal(list.hidden, true);
  type('run `@lead');
  assert.equal(list.hidden, true);
  type('```\n@lead');
  assert.equal(list.hidden, true);
  type('`x` and @lead');
  assert.equal(list.hidden, false);
});

test('a click on an option picks it without taking the focus from the text', async (t) => {
  const { ui, input, type, list } = await chat(t);
  type('Hello @');
  const mousedown = new ui.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  list.querySelectorAll('[role="option"]')[2].dispatchEvent(mousedown);
  assert.equal(mousedown.defaultPrevented, true, 'a pressed option must not blur the textarea');
  list.querySelectorAll('[role="option"]')[2].click();
  assert.equal(input.value, 'Hello @api-worker ');
  assert.equal(ui.window.document.activeElement, input);
  assert.equal(list.hidden, true);
  assert.equal(ui.$('#message-length').textContent, '18 B / 64 KiB', 'the byte count follows the pick');
});

test('the draft keeps a picked mention, and the sent message carries it', async (t) => {
  const { ui, type, press } = await chat(t);
  type('@lea');
  press('Enter');
  ui.$('#message-input').value += 'please look';
  ui.$('#message-form').requestSubmit();
  await settle();
  const sent = ui.requests.find((request) => request.options?.method === 'POST' && /messages/.test(request.path));
  assert.deepEqual(JSON.parse(sent.options.body), { conversationId: 'room-a', text: '@lead please look' });
});

test('every conversation offers its own members: common, a room, and a private chat', async (t) => {
  const common = await chat(t, 'common');
  common.type('@');
  assert.deepEqual(common.ids(), ['@all', '@lead', '@api-worker', '@docs-writer']);
  const direct = await chat(t, 'dm-api-worker');
  direct.type('@');
  assert.deepEqual(direct.ids(), ['@api-worker']);
  const lead = await chat(t, 'dm-lead');
  lead.type('@');
  assert.deepEqual(lead.ids(), ['@lead']);
});

test('switching the conversation closes the list, and a status change updates it', async (t) => {
  const { ui, type, list, ids } = await chat(t);
  type('@');
  assert.equal(list.hidden, false);
  const next = workspace();
  next.agents.find((item) => item.id === 'docs-writer').status = 'stopped';
  ui.update(next);
  await settle();
  assert.deepEqual(ids(), ['@all', '@lead', '@api-worker'], 'an agent retired meanwhile leaves the open list');
  ui.$('#conversation-list [data-conversation="common"]').click();
  await settle();
  assert.equal(list.hidden, true);
});

test('the list and the @ button menu are never open together', async (t) => {
  const { ui, type, list } = await chat(t);
  ui.click('#mention-toggle');
  assert.equal(ui.$('#mention-menu').hidden, false);
  type('@');
  assert.equal(list.hidden, false);
  assert.equal(ui.$('#mention-menu').hidden, true);
  assert.equal(ui.$('#mention-toggle').getAttribute('aria-expanded'), 'false');
  ui.click('#mention-toggle');
  assert.equal(list.hidden, true);
  assert.equal(ui.$('#mention-menu').hidden, false);
});

test('a pick that would pass the size limit is refused with a reason and keeps the text', async (t) => {
  const { ui, input, type, press, list } = await chat(t);
  const filler = 'x'.repeat(65536 - 3);
  type(`${filler} @`);
  assert.equal(list.hidden, false);
  press('Enter');
  assert.equal(input.value, `${filler} @`);
  assert.equal(ui.$('#chat-error').textContent, 'This message is too long to add another mention.');
  assert.equal(list.hidden, true);
});

test('sending with a modifier while the list is open sends the text and closes the list', async (t) => {
  const { ui, type, press, list } = await chat(t);
  type('@lead hurry @do');
  assert.equal(list.hidden, false);
  press('Enter', { metaKey: true });
  await settle();
  const sent = ui.requests.find((request) => request.options?.method === 'POST' && /messages/.test(request.path));
  assert.equal(JSON.parse(sent.options.body).text, '@lead hurry @do');
  assert.equal(list.hidden, true);
});

test('the pointer moves the highlight instead of lighting a second row', async (t) => {
  const { ui, type, list, highlighted, input } = await chat(t);
  type('@');
  list.querySelectorAll('[role="option"]')[2].dispatchEvent(new ui.window.MouseEvent('mousemove', { bubbles: true }));
  assert.equal(highlighted(), '@api-worker');
  assert.equal(list.querySelectorAll('[aria-selected="true"]').length, 1);
  assert.equal(input.getAttribute('aria-activedescendant'), list.querySelectorAll('[role="option"]')[2].id);
});
