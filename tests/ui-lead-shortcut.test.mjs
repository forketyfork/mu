import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isLeadChatShortcut, leadChatShortcutLabel } from '../public/model.js';
import { fixture, initialState, settle } from './ui-fixture.mjs';
import { ID, record, section, versionOf, viewer } from './ui-visuals-fixture.mjs';

const press = (ui, target, init = /** @type {KeyboardEventInit} */ ({ ctrlKey: true }), key = 'l') => {
  const event = new ui.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

// JSDOM draws no modal; the attribute is what the page reads.
const open = (ui, selector) => {
  const dialog = ui.$(selector);
  dialog.close = function () {
    this.removeAttribute('open');
  };
  dialog.setAttribute('open', '');
  return dialog;
};

const withoutLead = () => {
  const state = initialState();
  state.conversations = state.conversations.filter((conversation) => conversation.id !== 'dm-lead');
  return state;
};

test('Cmd+L answers on a Mac, Ctrl+L elsewhere, and only as a plain chord', () => {
  const chord = (init) => ({ key: 'l', ...init });
  assert.equal(isLeadChatShortcut(chord({ metaKey: true }), true), true);
  assert.equal(isLeadChatShortcut(chord({ ctrlKey: true }), false), true);
  assert.equal(isLeadChatShortcut({ key: 'L', metaKey: true }, true), true, 'Caps Lock');
  // Ctrl+L centers the line in a Mac text field; the Windows key with L locks the system.
  assert.equal(isLeadChatShortcut(chord({ ctrlKey: true }), true), false);
  assert.equal(isLeadChatShortcut(chord({ metaKey: true }), false), false);
  assert.equal(isLeadChatShortcut(chord({ metaKey: true, ctrlKey: true }), true), false);
  for (const extra of [{ shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }])
    assert.equal(isLeadChatShortcut(chord({ metaKey: true, ...extra }), true), false, JSON.stringify(extra));
  assert.equal(isLeadChatShortcut({ key: 'k', metaKey: true }, true), false);
  // A Cyrillic layout types д on the key of L.
  assert.equal(isLeadChatShortcut({ key: 'д', code: 'KeyL', metaKey: true }, true), true);
  assert.equal(isLeadChatShortcut({ key: 'k', code: 'KeyL', metaKey: true }, true), false, 'a Latin letter is the key');
  assert.equal(isLeadChatShortcut({ key: 'д', code: 'KeyK', metaKey: true }, true), false);
  assert.equal(leadChatShortcutLabel(true), '⌘L');
  assert.equal(leadChatShortcutLabel(false), 'Ctrl+L');
});

test('the shortcut opens the lead chat and focuses its composer from the workspace, and names itself on the rail', async (t) => {
  const ui = await fixture(t);
  assert.equal(ui.$('.rail-link[data-view="chat"]').title, 'Team chat (Ctrl+L writes to the lead)');
  assert.equal(ui.$('#team-chat').hidden, true);
  ui.$('#new-agent').focus();
  const event = press(ui, ui.$('#new-agent'));
  await settle();
  assert.equal(event.defaultPrevented, true, 'the browser must not move to its address bar');
  assert.equal(ui.$('#team-chat').hidden, false);
  assert.equal(ui.window.location.hash, '#team-chat');
  assert.equal(ui.window.document.activeElement, ui.$('#message-input'));
  ui.$('#message-input').value = 'Please look at the failing build';
  ui.$('#message-input').dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  ui.$('#message-form').requestSubmit();
  await settle();
  const sent = ui.requests.find((request) => request.options?.method === 'POST' && /messages/.test(request.path));
  assert.ok(sent, 'the message goes out');
  assert.equal(JSON.parse(sent.options.body).conversationId, 'dm-lead');
});

test('from another chat the draft stays there, and from the lead composer the typed text and the focus stay', async (t) => {
  const ui = await fixture(t);
  ui.click('.rail-link[data-view="chat"]');
  await settle();
  const input = ui.$('#message-input');
  const room = ui.$('#conversation-list [data-conversation="room-a"]');
  room.click();
  await settle();
  input.value = 'half-written note to the room';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  press(ui, input);
  await settle();
  assert.equal(ui.window.document.activeElement, input);
  assert.equal(input.value, '', 'the lead chat has its own, empty draft');

  input.value = 'to the lead';
  input.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  const event = press(ui, input);
  await settle();
  assert.equal(event.defaultPrevented, true);
  assert.equal(input.value, 'to the lead', 'pressing it in the lead composer keeps the text');
  assert.equal(ui.window.document.activeElement, input);

  ui.$('#conversation-list [data-conversation="room-a"]').click();
  await settle();
  assert.equal(input.value, 'half-written note to the room', 'the draft of the room came back');
});

test('a dialog with a form keeps the key and its input; a read-only dialog gives way, as it does for a reference', async (t) => {
  const ui = await fixture(t);
  const dialog = open(ui, '#agent-dialog');
  const field = ui.$('#agent-id');
  field.focus();
  field.value = 'api-worker';
  const event = press(ui, field);
  await settle();
  assert.equal(event.defaultPrevented, false, 'the browser keeps the key where the page does not act');
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(field.value, 'api-worker');
  assert.equal(ui.$('#team-chat').hidden, true);
  dialog.removeAttribute('open');

  open(ui, '#transcript-dialog');
  const second = press(ui, ui.$('#close-transcript'));
  await settle();
  assert.equal(second.defaultPrevented, true);
  assert.equal(ui.$('#transcript-dialog').hasAttribute('open'), false);
  assert.equal(ui.window.document.activeElement, ui.$('#message-input'));
});

test('the shortcut closes the open mention menu before it takes the focus', async (t) => {
  const ui = await fixture(t);
  ui.click('.rail-link[data-view="chat"]');
  await settle();
  ui.click('#mention-toggle');
  assert.equal(ui.$('#mention-menu').hidden, false);
  press(ui, ui.$('#mention-toggle'));
  await settle();
  assert.equal(ui.$('#mention-menu').hidden, true);
  assert.equal(ui.$('#mention-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(ui.window.document.activeElement, ui.$('#message-input'));
});

test('without a lead chat the page leaves the key to the browser', async (t) => {
  const ui = await fixture(t, { initial: withoutLead() });
  const event = press(ui, ui.$('#new-agent'));
  await settle();
  assert.equal(event.defaultPrevented, false);
  assert.equal(ui.$('#team-chat').hidden, true);
  assert.equal(ui.$('#chat-error').hidden, true);
});

test('on a Mac the dashboard answers to Cmd+L and leaves Ctrl+L to the text field', async (t) => {
  const ui = await fixture(t, { platform: 'MacIntel' });
  assert.equal(ui.$('.rail-link[data-view="chat"]').title, 'Team chat (⌘L writes to the lead)');
  const ctrl = press(ui, ui.$('#new-agent'), { ctrlKey: true });
  assert.equal(ctrl.defaultPrevented, false);
  assert.equal(ui.$('#team-chat').hidden, true);
  const meta = press(ui, ui.$('#new-agent'), { metaKey: true });
  await settle();
  assert.equal(meta.defaultPrevented, true);
  assert.equal(ui.window.document.activeElement, ui.$('#message-input'));
});

test('a shortcut pressed inside the visual frame, which never reaches the page, is passed on by the frame', async (t) => {
  const visual = record();
  const ui = await viewer(t, {
    hash: `#visuals/${ID}`,
    versions: { latest: versionOf(visual, 2, [section('intro', 'r1', 'Intro')]) },
  });
  await settle();
  assert.equal(ui.$('#visual-viewer').hidden, false);
  const pressed = {
    key: 'l',
    code: 'KeyL',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
  };
  ui.fromFrame({ type: 'key', ...pressed, key: 'k' });
  ui.fromFrame({ type: 'key', ...pressed, ctrlKey: false });
  ui.fromFrame({ type: 'key', ...pressed }, ui.window);
  await settle();
  assert.equal(ui.$('#visual-viewer').hidden, false, 'another key, no modifier, or another sender does nothing');
  ui.fromFrame({ type: 'key', ...pressed });
  await settle();
  assert.equal(ui.$('#team-chat').hidden, false);
  assert.equal(ui.window.document.activeElement, ui.$('#message-input'));
});

test('the frame applies the same rule as the dashboard to every key it could be given', async () => {
  const source = await readFile(new URL('../public/visual/frame.js', import.meta.url), 'utf8');
  const copy = /^function isLeadChatShortcut[\s\S]*?^}$/m.exec(source)?.[0];
  assert.ok(copy, 'the frame holds its copy of the rule');
  const framed = new Function(`${copy}\nreturn isLeadChatShortcut;`)();
  const keys = [
    { key: 'l', code: 'KeyL' },
    { key: 'L', code: 'KeyL' },
    { key: 'д', code: 'KeyL' },
    { key: 'д', code: 'KeyK' },
    { key: 'k', code: 'KeyL' },
    { key: 'k', code: 'KeyK' },
    { key: 'Dead', code: 'KeyL' },
  ];
  let accepted = 0;
  for (const mac of [true, false])
    for (const base of keys)
      for (let bits = 0; bits < 64; bits += 1) {
        const event = {
          ...base,
          metaKey: Boolean(bits & 1),
          ctrlKey: Boolean(bits & 2),
          shiftKey: Boolean(bits & 4),
          altKey: Boolean(bits & 8),
          repeat: Boolean(bits & 16),
          isComposing: Boolean(bits & 32),
        };
        const expected = isLeadChatShortcut(event, mac);
        assert.equal(framed(event, mac), expected, JSON.stringify({ mac, ...event }));
        if (expected) accepted += 1;
      }
  assert.ok(accepted > 0);
});
