import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createdAt, fixture, initialState } from './ui-fixture.mjs';

const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

async function pickerFixture(t) {
  const initial = initialState();
  initial.adapters = ['codex', 'claude', 'manual'];
  initial.conversations.push({ id: 'room-b', name: 'Second room', kind: 'room', members: ['user', 'lead'] });
  const ui = await fixture(t, { initial });
  const { window } = ui;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  const key = (target, name, init = {}) => {
    const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const picker = (id) => {
    const select = window.document.getElementById(id);
    const root = select.closest('.picker');
    return {
      select,
      root,
      trigger: root.querySelector('.picker-trigger'),
      list: root.querySelector('.picker-list'),
      options: [...root.querySelectorAll('.picker-option')],
      shown: () => root.querySelector('.picker-trigger').textContent,
      isOpen: () => !root.querySelector('.picker-list').hidden,
      highlighted: () => root.querySelector('.picker-option.active')?.textContent,
    };
  };
  const events = [];
  for (const id of ['agent-role', 'agent-adapter'])
    for (const type of ['input', 'change'])
      window.document.getElementById(id).addEventListener(type, () => events.push(`${id}:${type}`));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  // The picker follows the app's changes to the select's options in a microtask.
  const openAgentForm = async () => {
    ui.click('#new-agent');
    await settle();
  };
  return { ...ui, key, picker, events, settle, openAgentForm };
}

test('every select of the dashboard is a picker, and no code makes a native one later', async (t) => {
  const { window } = await pickerFixture(t);
  const selects = [...window.document.querySelectorAll('select')];
  assert.ok(selects.length >= 5, 'the transcript view and the new agent form have selects');
  for (const select of selects) {
    assert.ok(select.classList.contains('picker-native'), `#${select.id} is hidden behind a picker`);
    assert.ok(select.closest('.picker').querySelector('.picker-trigger'), `#${select.id} has a trigger`);
    assert.equal(select.tabIndex, -1, `#${select.id} is not a tab stop`);
  }
  assert.doesNotMatch(appSource, /(createElement|node)\(\s*'select'/, 'a select created at run time would be native');
});

test('the picker is named like the select, shows its value, and is a combobox over a listbox', async (t) => {
  const { picker, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const role = picker('agent-role');
  assert.equal(role.trigger.getAttribute('aria-label'), 'Role', 'the label text names the trigger, not its hint');
  assert.equal(role.trigger.getAttribute('role'), 'combobox');
  assert.equal(role.trigger.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(role.trigger.getAttribute('aria-controls'), role.list.id);
  assert.equal(role.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(role.shown(), 'Worker', 'the trigger shows the selected option');
  assert.deepEqual(
    role.options.map((option) => option.textContent),
    ['Team lead', 'Worker'],
  );
  assert.deepEqual(
    role.options.map((option) => option.getAttribute('aria-selected')),
    ['false', 'true'],
  );
  assert.equal(
    picker('agent-adapter').shown(),
    'Codex',
    'options added by the app appear without any call to the picker',
  );
});

test('choosing sets the select, fires input then change once, and the form submits the value', async (t) => {
  const { window, picker, key, events, $, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const role = picker('agent-role');
  role.trigger.focus();
  key(role.trigger, 'Enter');
  assert.equal(role.isOpen(), true);
  assert.equal(role.trigger.getAttribute('aria-expanded'), 'true');
  key(role.trigger, 'ArrowUp');
  assert.equal(role.highlighted(), 'Team lead');
  assert.equal(role.select.value, 'worker', 'moving the highlight does not choose');
  assert.deepEqual(events, []);
  key(role.trigger, 'Enter');
  assert.equal(role.select.value, 'lead');
  assert.equal(role.isOpen(), false);
  assert.equal(role.shown(), 'Team lead');
  assert.deepEqual(events, ['agent-role:input', 'agent-role:change']);
  assert.equal(window.document.activeElement, role.trigger, 'focus stays on the trigger');
  assert.equal(new window.FormData($('#agent-form')).get('role'), 'lead');
  key(role.trigger, 'Enter');
  key(role.trigger, 'Enter');
  assert.deepEqual(events, ['agent-role:input', 'agent-role:change'], 'choosing the current option is not a change');
});

test('closed, the arrows, Home, End and typing change the value at once, as on a native select', async (t) => {
  const { picker, key, events, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const adapter = picker('agent-adapter');
  adapter.trigger.focus();
  key(adapter.trigger, 'ArrowDown');
  assert.equal(adapter.select.value, 'claude');
  key(adapter.trigger, 'End');
  assert.equal(adapter.select.value, 'manual');
  key(adapter.trigger, 'ArrowDown');
  assert.equal(adapter.select.value, 'manual', 'there is nothing after the last option');
  key(adapter.trigger, 'Home');
  assert.equal(adapter.select.value, 'codex');
  key(adapter.trigger, 'e');
  assert.equal(adapter.select.value, 'manual', 'typing matches the start of the option text: External / manual');
  assert.equal(adapter.isOpen(), false);
  assert.equal(events.filter((event) => event.endsWith(':change')).length, 4);
});

test('typing repeats through options with the same first letter and builds a prefix', async (t) => {
  const { picker, key, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const room = picker('agent-conversation');
  assert.deepEqual(
    room.options.map((option) => option.textContent),
    ['Create a task room', '# Review changes', '# Second room'],
  );
  room.trigger.focus();
  key(room.trigger, '#');
  assert.equal(room.select.value, 'room-a', 'a first character lands on the next option that starts with it');
  key(room.trigger, '#');
  assert.equal(room.select.value, 'room-b', 'the same character again steps on');
  key(room.trigger, 'q');
  assert.equal(room.select.value, 'room-b', 'a prefix that nothing matches changes nothing');
  await new Promise((resolve) => setTimeout(resolve, 750));
  key(room.trigger, 'C');
  assert.equal(room.select.value, '', 'case is ignored, and the search wraps around to the first option');
  await new Promise((resolve) => setTimeout(resolve, 750));
  for (const character of ['#', ' ', 's']) key(room.trigger, character);
  assert.equal(room.select.value, 'room-b', 'typed quickly, characters form one prefix, a space included');
});

test('while open, Escape closes only the list, Tab chooses, and a click outside closes without a change', async (t) => {
  const { window, picker, key, events, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const role = picker('agent-role');
  role.trigger.focus();
  key(role.trigger, ' ');
  key(role.trigger, 'Home');
  const escape = key(role.trigger, 'Escape');
  assert.equal(escape.defaultPrevented, true, 'the dialog must not take this Escape');
  assert.equal(role.isOpen(), false);
  assert.equal(role.select.value, 'worker', 'Escape discards the highlight');
  assert.deepEqual(events, []);
  assert.equal(
    key(role.trigger, 'Escape').defaultPrevented,
    false,
    'with the list closed Escape belongs to the dialog',
  );
  key(role.trigger, 'Enter');
  key(role.trigger, 'Home');
  const tab = key(role.trigger, 'Tab');
  assert.equal(tab.defaultPrevented, false, 'Tab still moves focus');
  assert.equal(role.select.value, 'lead', 'Tab chooses the highlighted option');
  key(role.trigger, 'Enter');
  key(role.trigger, 'End');
  window.document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  assert.equal(role.isOpen(), false);
  assert.equal(role.select.value, 'lead');
  key(role.trigger, 'Enter');
  role.trigger.dispatchEvent(new window.Event('blur'));
  assert.equal(role.isOpen(), false, 'losing focus closes the list');
});

test('clicking an option chooses it and returns focus; clicking the trigger toggles', async (t) => {
  const { window, picker, events, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const adapter = picker('agent-adapter');
  adapter.trigger.click();
  assert.equal(adapter.isOpen(), true);
  adapter.trigger.click();
  assert.equal(adapter.isOpen(), false);
  adapter.trigger.click();
  adapter.options[1].click();
  assert.equal(adapter.select.value, 'claude');
  assert.equal(adapter.isOpen(), false);
  assert.equal(window.document.activeElement, adapter.trigger);
  assert.deepEqual(events, ['agent-adapter:input', 'agent-adapter:change']);
});

test('the picker follows the select: value, options, disabled, form reset', async (t) => {
  const { window, picker, settle, $, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const role = picker('agent-role');
  role.select.value = 'lead';
  assert.equal(role.shown(), 'Team lead', 'a value set by code shows at once');
  role.select.selectedIndex = 1;
  assert.equal(role.shown(), 'Worker');
  const option = window.document.createElement('option');
  option.value = 'reviewer';
  option.textContent = 'Reviewer';
  role.select.append(option);
  await settle();
  assert.deepEqual(
    picker('agent-role').options.map((item) => item.textContent),
    ['Team lead', 'Worker', 'Reviewer'],
  );
  role.select.disabled = true;
  await settle();
  assert.equal(role.trigger.disabled, true);
  role.select.disabled = false;
  await settle();
  role.select.value = 'reviewer';
  $('#agent-form').reset();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(role.shown(), role.select.selectedOptions[0].text, 'reset brings back the default option');
});

test('a disabled option is skipped by the keys and cannot be clicked', async (t) => {
  const { picker, key, settle, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const adapter = picker('agent-adapter');
  adapter.select.options[1].disabled = true;
  await settle();
  adapter.trigger.focus();
  key(adapter.trigger, 'ArrowDown');
  assert.equal(adapter.select.value, 'manual', 'the arrow steps over the disabled option');
  picker('agent-adapter').options[1].click();
  assert.equal(adapter.select.value, 'manual');
});

test('focus sent to the hidden select, by a label or by the app, lands on the trigger; an invalid select points at it', async (t) => {
  const { window, picker, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const adapter = picker('agent-adapter');
  adapter.select.focus();
  assert.equal(window.document.activeElement, adapter.trigger);
  adapter.trigger.blur();
  adapter.select.dispatchEvent(new window.Event('invalid'));
  assert.equal(window.document.activeElement, adapter.trigger);
});

test('the transcript conversation picker loads the chosen conversation and scrolls only the turn list', async (t) => {
  const initial = initialState();
  initial.agents.push({
    id: 'worker',
    role: 'worker',
    adapter: 'claude',
    status: 'idle',
    task: 'Work',
    cwd: '/project',
    conversationId: 'room-a',
    sessionIds: { 'room-a': 'a', 'dm-worker': 'b' },
    createdAt,
  });
  initial.conversations.push({ id: 'dm-worker', kind: 'direct', members: ['user', 'worker'] });
  const { window, $, click, scrolls } = await fixture(t, { initial });
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  const requests = [];
  const turn = { index: 1, messageId: 3, at: createdAt, entries: [{ kind: 'text', text: 'Done', at: createdAt }] };
  const fetch = window.fetch;
  window.fetch = async (path, options) => {
    if (!path.includes('/transcript')) return fetch(path, options);
    requests.push(path);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        agentId: 'worker',
        adapter: 'claude',
        sessionId: 'a',
        file: '/f',
        bytes: 1,
        skipped: {},
        pendingBytes: 0,
        masked: 0,
        turnCount: 1,
        start: 0,
        end: 1,
        turns: [turn],
      }),
    };
  };
  click('[data-agent="worker"] [data-action="transcript"]');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const root = $('#transcript-conversation').closest('.picker');
  assert.equal(root.querySelector('.picker-trigger').textContent, 'Review changes');
  assert.deepEqual(scrolls, [], 'scrollIntoView would scroll the page behind the dialog');
  root.querySelector('.picker-trigger').click();
  [...root.querySelectorAll('.picker-option')].find((option) => option.textContent === 'worker').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(requests.at(-1), /conversation=dm-worker/);
});

test('a reference clicked inside a dialog closes it before the page behind it moves', async (t) => {
  const { window, $, click } = await fixture(t);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  click('#task-list .task-expand');
  await settle();
  assert.equal($('#result-dialog').open, true);
  click('#result-dialog .task-worker');
  assert.equal($('#result-dialog').open, false);
  assert.equal(window.location.hash, '#team-chat', 'the private chat of the agent is open behind it');
});

test('the page behind a modal dialog cannot scroll, and a dialog does not pass its scroll on to the page', () => {
  // A top-level rule starts at the beginning of a line; its block may span several lines.
  const declarations = (selector) =>
    styles.match(new RegExp(`^${RegExp.escape(selector)} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  assert.match(declarations('html:has(dialog:modal)'), /overflow: hidden/);
  for (const selector of ['.agent-dialog', '.transcript-turns', '.result-card', '.member-picker'])
    assert.match(declarations(selector), /overscroll-behavior: contain/, selector);
  assert.match(styles, /\.conversation-list,\s*\.picker-list \{[^}]*overscroll-behavior: contain/);
});

test('a list wider than its trigger stays inside the window', async (t) => {
  const { window, picker, openAgentForm } = await pickerFixture(t);
  await openAgentForm();
  const adapter = picker('agent-adapter');
  Object.assign(window, { innerWidth: 1500, innerHeight: 900 });
  adapter.trigger.getBoundingClientRect = () => ({ left: 1400, right: 1480, top: 100, bottom: 140, width: 80 });
  const style = window.getComputedStyle;
  window.getComputedStyle = (element) => (element === adapter.list ? { minWidth: '280px' } : style(element));
  adapter.trigger.click();
  assert.equal(adapter.list.style.width, '280px');
  assert.equal(adapter.list.style.left, '1212px', 'right edge 8px inside the window');
});
