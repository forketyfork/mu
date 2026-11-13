import test from 'node:test';
import assert from 'node:assert/strict';
import { createdAt, fixture } from './ui-fixture.mjs';

const agent = { id: 'lead', role: 'lead', adapter: 'manual', status: 'idle', task: 'Lead', cwd: '/project', createdAt };
const task = (id, status) => ({
  id,
  title: `Title ${id}`,
  status,
  agentIds: [],
  retiredAgentIds: [],
  conversationId: 'common',
  sourceConversationId: 'dm-lead',
  result: `Result of ${id}`,
  verifiedAt: null,
  verificationNotice: null,
  createdAt,
});
const state = () => ({
  agents: [agent],
  tasks: [task('task-ready', 'ready'), task('task-active', 'active')],
  conversations: [
    { id: 'common', name: 'Common', kind: 'common', members: ['user', 'lead'] },
    { id: 'dm-lead', kind: 'direct', members: ['user', 'lead'] },
  ],
  messages: [],
  transport: { connected: true },
  adapters: ['manual'],
});

const dialogStubs = (ui) => {
  ui.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  ui.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new ui.window.Event('close'));
  };
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a task card expands into a dialog with everything the card shows and the full result', async (t) => {
  const ui = await fixture(t, { initial: state(), reduced: true });
  dialogStubs(ui);
  assert.equal(ui.window.document.querySelector('.task-card details'), null);
  assert.equal(ui.$('#result-dialog').open, false);
  ui.$('[data-task="task-ready"] .task-expand').click();
  await settle();
  const card = ui.$('#result-card .task-card.expanded');
  assert.equal(ui.$('#result-dialog').open, true);
  assert.ok(card.textContent.includes('Title task-ready'));
  assert.ok(card.querySelector('.task-status'));
  assert.ok(card.querySelector('.task-assignment'));
  assert.deepEqual(
    [...card.querySelectorAll('.task-card-side > *')].map((child) => child.className.split(' ')[0]),
    ['task-status', 'task-expand', 'activity-link', 'check-button'],
    'the dialog keeps the same four circles in the same cells',
  );
  assert.ok(card.querySelector('button.task-verify'), 'the verify action is available in the dialog');
  assert.equal(card.querySelector('.task-result-full').textContent.includes('Result of task-ready'), true);
  ui.$('#result-card .task-card-header').click();
  await settle();
  assert.equal(ui.$('#result-dialog').open, true, 'a click inside leaves it open');
  ui.$('#result-dialog').click();
  await settle();
  assert.equal(ui.$('#result-dialog').open, false, 'a click on the backdrop closes it');
  ui.$('[data-task="task-active"] .task-result').click();
  await settle();
  ui.$('#result-card .task-expand').click();
  await settle();
  assert.equal(ui.$('#result-dialog').open, false, 'the collapse button closes it');
  ui.$('[data-task="task-ready"] .task-expand').click();
  await settle();
  const cancel = new ui.window.Event('cancel', { cancelable: true });
  ui.$('#result-dialog').dispatchEvent(cancel);
  await settle();
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(ui.$('#result-dialog').open, false, 'Escape closes it through the same path');
});

test('the dialog grows from the card and shrinks back before it closes, and reduced motion skips both', async (t) => {
  const ui = await fixture(t, { initial: state() });
  dialogStubs(ui);
  const run = (kind) => ui.animations.filter((animation) => animation.id === kind);
  ui.$('[data-task="task-ready"] .task-expand').click();
  assert.equal(run('mu-expand').length, 1);
  run('mu-expand')[0].dispatchEvent(new ui.window.Event('finish'));
  await settle();
  ui.$('#result-card .task-expand').click();
  assert.equal(ui.$('#result-dialog').open, true, 'it stays open while it collapses');
  assert.equal(run('mu-expand').length, 2);
  run('mu-expand')[1].dispatchEvent(new ui.window.Event('finish'));
  await settle();
  assert.equal(ui.$('#result-dialog').open, false);
  ui.preference.matches = true;
  ui.$('[data-task="task-ready"] .task-expand').click();
  await settle();
  assert.equal(run('mu-expand').length, 2, 'no animation under reduced motion');
});

test('the open dialog follows state updates and closes when its task disappears', async (t) => {
  const ui = await fixture(t, { initial: state(), reduced: true });
  dialogStubs(ui);
  ui.$('[data-task="task-ready"] .task-expand').click();
  await settle();
  const next = state();
  next.tasks[0] = { ...next.tasks[0], result: 'Fresh result' };
  ui.update(next);
  assert.ok(ui.$('#result-card .task-result-full').textContent.includes('Fresh result'));
  ui.update({ ...state(), tasks: [state().tasks[1]] });
  assert.equal(ui.$('#result-dialog').open, false);
});

test('the header carries the new-agent button and the dashboard drops the local indicator and heading', async (t) => {
  const { $, window } = await fixture(t, { initial: state() });
  assert.ok($('.topbar #new-agent'), 'new-agent button is in the header');
  assert.equal(window.document.querySelector('.local-dot, .rail-caption, .page-heading'), null);
  assert.equal(window.document.querySelector('h1').classList.contains('sr-only'), true);
});

test('summary blocks list the active agents and the tasks they count, with untrusted text as text', async (t) => {
  const hostile = '<img src=x onerror=alert(1)>';
  const worker = (id, status) => ({ ...agent, id, role: 'worker', status });
  const initial = {
    ...state(),
    agents: [agent, worker('w-run', 'working'), worker('w-stuck', 'blocked'), worker('w-done', 'done')],
    tasks: [
      { ...task('task-run', 'active'), title: hostile, agentIds: ['w-run'] },
      { ...task('task-stuck', 'active'), agentIds: ['w-stuck'] },
      { ...task('task-old', 'verified'), agentIds: ['w-run'] },
    ],
  };
  const { window, $ } = await fixture(t, { initial });
  const items = (id) => [...window.document.querySelectorAll(`#${id} li`)];
  assert.equal($('#active-list').textContent, '@lead, @w-run, @w-stuck');
  assert.equal(items('active-list').length, 0);
  assert.deepEqual(
    items('working-list').map((li) => li.textContent),
    [hostile],
  );
  assert.equal($('#working-list img'), null);
  assert.deepEqual(
    items('attention-list').map((li) => li.textContent),
    ['Title task-stuck'],
  );
  assert.equal($('#working-count').textContent, '1');
  assert.equal($('#attention-count').textContent, '1');
  assert.ok($('#working-list a.task-ref'));
});

test('an agent task starts collapsed and stays open once expanded across state updates', async (t) => {
  const { window, $, update } = await fixture(t, { initial: state() });
  const details = () => $('.agent-card .agent-task-details');
  assert.equal(details().open, false);
  assert.equal(details().querySelector('.agent-task').textContent.trim(), 'Lead');
  details().open = true;
  details().dispatchEvent(new window.Event('toggle'));
  update({ ...state(), agents: [{ ...agent, status: 'working' }] });
  assert.equal(details().open, true);
});

test('agent tiles show a harness mark or its name, and icon-only actions with accessible names', async (t) => {
  const worker = (id, adapter) => ({ ...agent, id, role: 'worker', adapter, status: 'idle' });
  const initial = {
    ...state(),
    agents: [worker('c', 'claude'), worker('x', 'codex'), worker('p', 'pi'), worker('m', 'manual')],
  };
  const { window, $ } = await fixture(t, { initial });
  const chip = (id) => $(`[data-agent="${id}"] .harness-chip`);
  for (const [id, name] of [
    ['c', 'claude'],
    ['x', 'codex'],
    ['p', 'pi'],
  ]) {
    assert.ok(chip(id).querySelector(`.glyph-${name}`), `${name} mark`);
    assert.equal(chip(id).textContent, '');
    assert.match(chip(id).getAttribute('aria-label'), /^Harness: /);
  }
  assert.equal(chip('m').querySelector('.glyph'), null);
  assert.equal(chip('m').textContent, 'External / manual');
  for (const button of window.document.querySelectorAll('.agent-actions button')) {
    assert.equal(button.textContent, '');
    assert.ok(button.getAttribute('aria-label') && button.title, `${button.dataset.action} has a name and a title`);
  }
  assert.deepEqual(
    [...window.document.querySelectorAll('[data-agent="c"] .agent-actions button')].map(
      (button) => button.dataset.action,
    ),
    ['mention', 'stop'],
  );
  const footer = $('[data-agent="c"] .agent-card-footer');
  assert.ok(footer.firstElementChild === chip('c'), 'chips and actions share one row');
  assert.ok(footer.lastElementChild.classList.contains('agent-actions'));
});

test('the dialog is named by its task, keeps focus across live updates and returns it to the card when closed', async (t) => {
  const ui = await fixture(t, { initial: state(), reduced: true });
  dialogStubs(ui);
  const doc = ui.window.document;
  ui.$('[data-task="task-ready"] .task-expand').click();
  await settle();
  const dialog = ui.$('#result-dialog');
  assert.equal(doc.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Title task-ready');
  assert.equal(dialog.hasAttribute('aria-label'), false);
  assert.equal(doc.activeElement, ui.$('#result-card .task-expand'));
  const verify = ui.$('#result-card button.task-verify');
  verify.focus();
  const updated = state();
  updated.tasks[0].description = 'Updated while the dialog is open';
  ui.update(updated);
  assert.equal(
    doc.activeElement,
    ui.$('#result-card button.task-verify'),
    'focus stays on the same control of the rebuilt card',
  );
  assert.notEqual(doc.activeElement, verify);
  ui.$('#result-card .task-expand').click();
  await settle();
  assert.equal(doc.activeElement, ui.$('[data-task="task-ready"] .task-expand'));
  ui.$('[data-task="task-ready"] .task-result').click();
  await settle();
  ui.$('#result-card .task-expand').click();
  await settle();
  assert.equal(
    doc.activeElement,
    ui.$('[data-task="task-ready"] .task-result'),
    'focus returns to the control that opened it',
  );
});

test('filtering out the open task closes its dialog', async (t) => {
  const ui = await fixture(t, { initial: state(), reduced: true });
  dialogStubs(ui);
  ui.$('[data-task="task-ready"] .task-expand').click();
  await settle();
  ui.click('[data-task-filter="active"]');
  assert.equal(ui.$('#result-dialog').open, false);
  assert.equal(ui.$('#task-list [data-task="task-ready"]'), null);
});

test('a reduced-motion change mid-animation cancels both the clip and the backdrop effects', async (t) => {
  const ui = await fixture(t, { initial: state() });
  dialogStubs(ui);
  ui.$('[data-task="task-ready"] .task-expand').click();
  const effects = ui.animations.filter((animation) => animation.id?.startsWith('mu-expand'));
  assert.deepEqual(
    effects.map((animation) => animation.id),
    ['mu-expand', 'mu-expand-backdrop'],
  );
  ui.preference.matches = true;
  ui.preference.dispatchEvent(new ui.window.Event('change'));
  assert.deepEqual(
    effects.map((animation) => animation.cancelled),
    [true, true],
  );
  await settle();
  assert.equal(ui.$('#result-dialog').open, true);
});

test('focus moves to Collapse when an update removes the focused control, and to the task filters when the card is gone', async (t) => {
  const ui = await fixture(t, { initial: state(), reduced: true });
  dialogStubs(ui);
  const doc = ui.window.document;
  ui.$('[data-task="task-ready"] .task-expand').click();
  await settle();
  ui.$('#result-card button.task-verify').focus();
  const reopened = state();
  reopened.tasks[0] = { ...reopened.tasks[0], status: 'active' };
  ui.update(reopened);
  assert.equal(
    ui.$('#result-card button.task-verify'),
    null,
    'the Verify button is gone once the task is no longer ready',
  );
  assert.equal(doc.activeElement, ui.$('#result-card .task-expand'));
  ui.click('[data-task-filter="verified"]');
  assert.equal(ui.$('#result-dialog').open, false);
  assert.equal(doc.activeElement, ui.$('[data-task-filter="verified"]'));
});
