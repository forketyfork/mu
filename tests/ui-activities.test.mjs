import test from 'node:test';
import assert from 'node:assert/strict';
import { moveActivity, taskSquare } from '../public/model.js';
import { createdAt, fixture, initialState } from './ui-fixture.mjs';

const activity = (id, text, lane, position, extra = {}) => ({
  id: `act-0000000${id}`,
  text,
  lane,
  position,
  createdAt,
  checkedAt: null,
  taskIds: [],
  ...extra,
});

const withActivities = (activities) => {
  const state = initialState();
  state.tasks.push(
    { ...state.tasks[0], id: 'task-b', title: 'Ship the fix', status: 'ready' },
    { ...state.tasks[0], id: 'task-c', title: 'Old cleanup', status: 'verified', verifiedAt: createdAt },
  );
  return { ...state, activities };
};

const sample = () =>
  withActivities([
    activity(1, 'Decide on the release', 'focus', 1, { taskIds: ['task-a', 'task-b', 'task-c'] }),
    activity(2, 'Reply to the auditor', 'focus', 2),
    activity(3, 'Audit report', 'control', 1),
    activity(4, 'Old chore', 'focus', 0, { checkedAt: '2026-11-08T10:00:00Z', taskIds: ['task-c'] }),
  ]);

const texts = (ui, lane) =>
  [...ui.window.document.querySelectorAll(`[data-lane-cards="${lane}"] .activity-text`)].map(
    (item) => item.textContent,
  );
const apiCalls = (ui) =>
  ui.requests
    .filter((request) => request.options?.method && request.options.method !== 'GET')
    .map((request) => ({ method: request.options.method, path: request.path, body: JSON.parse(request.options.body) }));
const key = (ui, element, name) =>
  element.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
const mouse = (ui, element, type, clientY = 0) =>
  element.dispatchEvent(new ui.window.MouseEvent(type, { bubbles: true, cancelable: true, clientY }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the focus list sits under Waiting for you and shows open activities by lane, order and archive', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  assert.ok(
    ui.$('#waiting-section').compareDocumentPosition(ui.$('#activities-section')) &
      ui.window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.ok(
    ui.$('#activities-section').compareDocumentPosition(ui.$('.metrics')) & ui.window.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  assert.deepEqual(texts(ui, 'focus'), ['Decide on the release', 'Reply to the auditor']);
  assert.deepEqual(texts(ui, 'control'), ['Audit report']);
  assert.equal(ui.$('#activities-count').textContent, '3');
  assert.equal(ui.$('#activity-archive-count').textContent, '1');
  assert.equal(ui.$('#activity-archive').hidden, true);

  ui.update({ ...sample(), activities: [] });
  assert.equal(ui.$('#activities-section').hidden, false, 'the section stays so that a card can be added');
  assert.match(ui.$('[data-lane-cards="focus"]').textContent, /Nothing on you/);
  assert.match(ui.$('[data-lane-cards="control"]').textContent, /Nothing to wait for/);
});

test('one square per linked task, coloured by task status, naming the task on hover', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const squares = [...ui.window.document.querySelectorAll('[data-lane-cards="focus"] .task-square')];
  assert.deepEqual(
    squares.map((square) => [square.dataset.task, square.className.replace('task-square ', '')]),
    [
      ['task-a', 'active'],
      ['task-b', 'inactive'],
      ['task-c', 'archived'],
    ],
  );
  assert.equal(squares[1].querySelector('.task-square-tip strong').textContent, 'Ship the fix');
  assert.equal(squares[1].getAttribute('aria-label'), 'Ship the fix (inactive)');
  assert.equal(ui.$('[data-lane-cards="control"] .task-square'), null);
  squares[0].click();
  assert.equal(ui.$('.task-card.revealed').dataset.task, 'task-a');
  assert.deepEqual(
    ['verified', 'active', 'ready'].map((status) => taskSquare({ status }).state),
    ['archived', 'active', 'inactive'],
  );
});

test('a task status update animates its badge without treating activity squares as task cards', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const next = sample();
  next.tasks[0].status = 'ready';

  ui.update(next);

  const status = ui.$('#task-list [data-task="task-a"] .task-status');
  const animations = ui.animations.filter((animation) => animation.id === 'mu-status');
  assert.equal(animations.length, 1);
  assert.equal(animations[0].effect.target, status);
  assert.equal(status.getAttribute('aria-label'), 'Status: Ready to verify');
});

test('the plus button adds a card with a focused field, and Enter saves it in that lane', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  ui.click('[data-add-activity="control"]');
  const input = ui.$('[data-lane-cards="control"] .activity-input');
  assert.equal(ui.window.document.activeElement, input);
  input.value = '  Wait for the audit  ';
  key(ui, input, 'Enter');
  await settle();
  assert.deepEqual(apiCalls(ui), [
    { method: 'POST', path: '/api/activities', body: { text: 'Wait for the audit', lane: 'control' } },
  ]);
});

test('an empty or abandoned new card makes no request and disappears', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  ui.click('[data-add-activity="focus"]');
  key(ui, ui.$('.activity-input'), 'Enter');
  assert.equal(ui.$('.activity-input'), null);
  ui.click('[data-add-activity="focus"]');
  ui.$('.activity-input').value = 'Typed but dropped';
  key(ui, ui.$('.activity-input'), 'Escape');
  assert.equal(ui.$('.activity-input'), null);
  assert.deepEqual(texts(ui, 'focus'), ['Decide on the release', 'Reply to the auditor']);
  assert.deepEqual(apiCalls(ui), []);
});

test('double-clicking the text edits it in place; Enter or blur saves a change, Escape and no change save nothing', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const card = () => ui.$('[data-activity="act-00000002"]');
  card()
    .querySelector('.activity-text')
    .dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true }));
  let input = card().querySelector('.activity-input');
  assert.equal(input.value, 'Reply to the auditor');
  assert.equal(ui.window.document.activeElement, input);
  assert.equal(card().draggable, false);
  input.value = 'Reply to the auditor today';
  key(ui, input, 'Enter');
  await settle();
  assert.deepEqual(apiCalls(ui), [
    { method: 'PATCH', path: '/api/activities/act-00000002', body: { text: 'Reply to the auditor today' } },
  ]);

  card()
    .querySelector('.activity-text')
    .dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true }));
  input = card().querySelector('.activity-input');
  input.value = 'Discarded';
  key(ui, input, 'Escape');
  assert.equal(card().querySelector('.activity-text').textContent, 'Reply to the auditor');
  card()
    .querySelector('.activity-text')
    .dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true }));
  card().querySelector('.activity-input').dispatchEvent(new ui.window.FocusEvent('blur'));
  await settle();
  assert.equal(apiCalls(ui).length, 1);

  card()
    .querySelector('.activity-text')
    .dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true }));
  input = card().querySelector('.activity-input');
  input.value = 'Saved on blur';
  input.dispatchEvent(new ui.window.FocusEvent('blur'));
  await settle();
  assert.equal(apiCalls(ui).at(-1).body.text, 'Saved on blur');
  assert.equal(apiCalls(ui).length, 2);
});

test('a state update does not rebuild the list under an open editor, and catches up afterwards', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  ui.click('[data-add-activity="focus"]');
  ui.$('.activity-input').value = 'Half typed';
  const next = sample();
  next.activities.push(activity(5, 'Arrived meanwhile', 'control', 2));
  ui.update(next);
  assert.equal(ui.$('.activity-input').value, 'Half typed');
  assert.deepEqual(texts(ui, 'control'), ['Audit report']);
  key(ui, ui.$('.activity-input'), 'Escape');
  assert.deepEqual(texts(ui, 'control'), ['Audit report', 'Arrived meanwhile']);
});

test('the check button saves the check-off, and the archive lists checked activities with a restore button', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  ui.$('[data-activity="act-00000001"] .activity-check').click();
  await settle();
  assert.deepEqual(apiCalls(ui), [{ method: 'PATCH', path: '/api/activities/act-00000001', body: { checked: true } }]);

  assert.equal(ui.$('#activity-archive').hidden, true);
  ui.click('#activity-archive-toggle');
  assert.equal(ui.$('#activity-archive').hidden, false);
  assert.equal(ui.$('#activity-archive-toggle').getAttribute('aria-pressed'), 'true');
  const item = ui.$('[data-archived-activity="act-00000004"]');
  assert.equal(item.querySelector('.archive-text').textContent, 'Old chore');
  assert.equal(item.querySelector('.task-square').className, 'task-square archived');
  item.querySelector('button.text-button').click();
  await settle();
  assert.deepEqual(apiCalls(ui).at(-1), {
    method: 'PATCH',
    path: '/api/activities/act-00000004',
    body: { checked: false },
  });
  ui.click('#activity-archive-toggle');
  assert.equal(ui.$('#activity-archive').hidden, true);
});

test('a failed change is shown, and the list returns to the saved state', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const respond = ui.window.fetch;
  ui.window.fetch = async (path, options) =>
    options?.method === 'PATCH'
      ? { ok: false, status: 403, json: async () => ({ error: 'Only the user and the team lead change activities' }) }
      : respond(path, options);
  ui.$('[data-activity="act-00000002"] .activity-text').dispatchEvent(
    new ui.window.MouseEvent('dblclick', { bubbles: true }),
  );
  const input = ui.$('.activity-input');
  input.value = 'Rejected text';
  key(ui, input, 'Enter');
  await settle();
  assert.equal(ui.$('#page-error').hidden, false);
  assert.match(ui.$('#page-error').textContent, /Could not update the focus list: Only the user/);
  assert.equal(ui.$('[data-activity="act-00000002"] .activity-text').textContent, 'Reply to the auditor');
});

test('a dropped card moves on the page at once, before the server answers, and the request carries lane and position', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const card = ui.$('[data-activity="act-00000002"]');
  const control = ui.$('[data-lane-cards="control"]');
  mouse(ui, card, 'dragstart');
  assert.ok(card.classList.contains('dragging'));
  mouse(ui, control, 'dragover', 0);
  assert.ok(control.classList.contains('drop-target'));
  assert.ok(ui.$('.activity-drop'), 'a marker shows where the card will land');
  mouse(ui, control, 'drop', 0);
  assert.equal(ui.$('.activity-drop'), null);
  assert.deepEqual(texts(ui, 'control'), ['Reply to the auditor', 'Audit report'], 'no wait for the server');
  assert.deepEqual(texts(ui, 'focus'), ['Decide on the release']);
  assert.deepEqual(apiCalls(ui), [
    { method: 'PATCH', path: '/api/activities/act-00000002', body: { lane: 'control', position: 1 } },
  ]);
  await settle();
});

test('a drop where the card already is saves nothing and a drop at the end saves the last position', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const focus = ui.$('[data-lane-cards="focus"]');
  const first = ui.$('[data-activity="act-00000001"]');
  mouse(ui, first, 'dragstart');
  mouse(ui, focus, 'drop', 0);
  assert.deepEqual(apiCalls(ui), []);
  assert.deepEqual(texts(ui, 'focus'), ['Decide on the release', 'Reply to the auditor']);

  const again = ui.$('[data-activity="act-00000001"]');
  mouse(ui, again, 'dragstart');
  mouse(ui, focus, 'drop', 1000);
  assert.deepEqual(texts(ui, 'focus'), ['Reply to the auditor', 'Decide on the release']);
  assert.deepEqual(apiCalls(ui), [
    { method: 'PATCH', path: '/api/activities/act-00000001', body: { lane: 'focus', position: 2 } },
  ]);
  await settle();
});

test('a move the server rejects is undone by the saved state', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const respond = ui.window.fetch;
  ui.window.fetch = async (path, options) =>
    options?.method === 'PATCH'
      ? { ok: false, status: 409, json: async () => ({ error: 'Not now' }) }
      : respond(path, options);
  const card = ui.$('[data-activity="act-00000002"]');
  mouse(ui, card, 'dragstart');
  mouse(ui, ui.$('[data-lane-cards="control"]'), 'drop', 0);
  assert.deepEqual(texts(ui, 'control'), ['Reply to the auditor', 'Audit report']);
  await settle();
  assert.deepEqual(texts(ui, 'control'), ['Audit report']);
  assert.match(ui.$('#page-error').textContent, /Could not update the focus list: Not now/);
});

test('cards flow down two columns, so a drop lands by column first and height within it', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const { window } = ui;
  const focus = ui.$('[data-lane-cards="focus"]');
  const rect = (left, top, width, height) => () => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  focus.getBoundingClientRect = rect(0, 0, 600, 200);
  ui.$('[data-activity="act-00000001"]').getBoundingClientRect = rect(0, 0, 290, 50);
  ui.$('[data-activity="act-00000002"]').getBoundingClientRect = rect(310, 0, 290, 50);
  const style = window.getComputedStyle;
  window.getComputedStyle = (element) => (element === focus ? { columnCount: '2' } : style(element));
  const dragged = ui.$('[data-activity="act-00000003"]');
  const over = (clientX, clientY) => {
    mouse(ui, dragged, 'dragstart');
    focus.dispatchEvent(new window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY }));
    const line = ui.$('.activity-drop').style;
    focus.dispatchEvent(new window.MouseEvent('dragleave', { bubbles: true }));
    return [line.top, line.left, line.width];
  };
  assert.deepEqual(over(400, 10), ['-6px', '310px', '290px'], 'above the second column card');
  assert.deepEqual(over(400, 40), ['54px', '310px', '290px'], 'below the second column card');
  assert.deepEqual(over(100, 40), ['54px', '0px', '290px'], 'below the first column card, in the first column');
  assert.deepEqual(over(100, 10), ['-6px', '0px', '290px'], 'above the first column card');
  mouse(ui, dragged, 'dragstart');
  focus.dispatchEvent(new window.MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 400, clientY: 10 }));
  assert.deepEqual(apiCalls(ui).at(-1).body, { lane: 'focus', position: 2 }, 'after the whole first column');
  await settle();
});

test('the delete cross asks first; Cancel and Escape keep the activity, Delete removes it', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const card = () => ui.$('[data-activity="act-00000002"]');
  card().querySelector('.activity-delete').click();
  assert.match(card().querySelector('.activity-confirm').textContent, /Delete this activity\?/);
  assert.equal(ui.window.document.activeElement.dataset.confirm, 'cancel', 'the safe choice has focus');
  assert.equal(card().draggable, false);
  assert.deepEqual(apiCalls(ui), []);

  ui.update(sample());
  assert.ok(card().querySelector('.activity-confirm'), 'a state update keeps the question open');
  assert.equal(ui.window.document.activeElement.dataset.confirm, 'cancel');

  card().querySelector('[data-confirm="cancel"]').click();
  assert.equal(card().querySelector('.activity-confirm'), null);
  card().querySelector('.activity-delete').click();
  key(ui, ui.window.document.activeElement, 'Escape');
  assert.equal(card().querySelector('.activity-confirm'), null);
  assert.deepEqual(apiCalls(ui), []);

  card().querySelector('.activity-delete').click();
  card().querySelector('[data-confirm="delete"]').click();
  await settle();
  assert.deepEqual(apiCalls(ui), [{ method: 'DELETE', path: '/api/activities/act-00000002', body: {} }]);
  assert.equal(card().querySelector('.activity-confirm'), null);
});

test('moveActivity numbers each lane from 1 as the server does', () => {
  const list = [
    activity(1, 'A', 'focus', 1),
    activity(2, 'B', 'focus', 2),
    activity(3, 'C', 'control', 1),
    activity(4, 'Done', 'focus', 0, { checkedAt: '2026-11-08T10:00:00Z' }),
  ];
  const summary = (items) => items.map((item) => [item.text, item.lane, item.position]);
  assert.deepEqual(summary(moveActivity(list, list[0].id, 'control', 2)), [
    ['A', 'control', 2],
    ['B', 'focus', 1],
    ['C', 'control', 1],
    ['Done', 'focus', 0],
  ]);
  assert.deepEqual(summary(moveActivity(list, list[1].id, 'focus', 1)).slice(0, 2), [
    ['A', 'focus', 2],
    ['B', 'focus', 1],
  ]);
  assert.deepEqual(summary(moveActivity(list, list[0].id, 'control', 99)).slice(0, 3), [
    ['A', 'control', 2],
    ['B', 'focus', 1],
    ['C', 'control', 1],
  ]);
  assert.equal(moveActivity(list, list[3].id, 'control', 1), list, 'a checked-off activity stays');
  assert.equal(moveActivity(list, 'act-missing', 'control', 1), list);
  assert.equal(list[0].lane, 'focus', 'the input is not changed');
});

test('a drop that was not started on a card does nothing', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  mouse(ui, ui.$('[data-lane-cards="control"]'), 'drop', 0);
  assert.deepEqual(apiCalls(ui), []);
});

test('each task card has an activity dropdown of open activities that links, moves and unlinks the task', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const select = () => ui.$('[data-task="task-a"] .activity-link select');
  assert.deepEqual(
    [...select().options].map((option) => option.textContent),
    ['No activity', 'Decide on the release', 'Reply to the auditor', 'Audit report'],
  );
  assert.equal(select().value, 'act-00000001');
  assert.equal(ui.$('[data-task="task-a"] .activity-link .picker-value').textContent, 'Decide on the release');

  select().value = 'act-00000003';
  select().dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(apiCalls(ui), [
    { method: 'POST', path: '/api/activities/act-00000003/tasks', body: { taskId: 'task-a' } },
  ]);

  select().value = '';
  select().dispatchEvent(new ui.window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(apiCalls(ui).at(-1), {
    method: 'DELETE',
    path: '/api/activities/act-00000001/tasks/task-a',
    body: {},
  });
});

test('a task linked to a checked-off activity shows it as done in the dropdown', async (t) => {
  const state = sample();
  state.tasks.push({ ...state.tasks[0], id: 'task-d', title: 'Chore task', status: 'active' });
  state.activities[3].taskIds.push('task-d');
  const ui = await fixture(t, { initial: state });
  const select = ui.$('[data-task="task-d"] .activity-link select');
  assert.equal(select.value, 'act-00000004');
  assert.equal(select.selectedOptions[0].textContent, 'Old chore (done)');
});

test('an open activity dropdown is not rebuilt by a state update', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const trigger = ui.$('[data-task="task-a"] .activity-link .picker-trigger');
  trigger.click();
  assert.ok(ui.$('.activity-link .picker.open'));
  ui.update({ ...sample(), activities: sample().activities.slice(0, 2) });
  assert.ok(ui.$('.activity-link .picker.open'), 'the open list stays');
  assert.equal(ui.$('[data-task="task-a"] .activity-link select').options.length, 4);
  trigger.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle();
  assert.equal(ui.$('[data-task="task-a"] .activity-link select').options.length, 3);
});

test('a task card has four circles in a 2x2 grid: status and expand above, link and verify below', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const cells = (id) => {
    const side = ui.$(`#task-list [data-task="${id}"] .task-card-header > .task-card-side`);
    return [...side.children].map((child) => child.className.split(' ')[0]);
  };
  assert.deepEqual(cells('task-b'), ['task-status', 'task-expand', 'activity-link', 'check-button']);
  assert.deepEqual(cells('task-a'), ['task-status', 'task-expand', 'activity-link'], 'no verify cell off a ready task');
  const ready = ui.$('#task-list [data-task="task-b"]');
  assert.equal(ready.querySelector('.task-card-footer'), null, 'a ready task has no footer row');
  assert.doesNotMatch(ready.textContent, /Review the result, then verify/);
  assert.equal(ready.querySelector('button.primary'), null);
  for (const circle of ready.querySelectorAll('.task-card-side > *:not(.activity-link)'))
    assert.ok(circle.querySelector('svg'), `${circle.className} is an icon`);
});

test('the status is one icon per status, named by tooltip and accessible label, with no text', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  ui.click('#show-archived');
  const status = (id) => ui.$(`#task-list [data-task="${id}"] .task-status`);
  const icons = new Set();
  for (const [id, label] of [
    ['task-a', 'Active'],
    ['task-b', 'Ready to verify'],
    ['task-c', 'Verified'],
  ]) {
    assert.equal(status(id).title, label);
    assert.equal(status(id).getAttribute('aria-label'), `Status: ${label}`);
    assert.equal(status(id).getAttribute('role'), 'img');
    assert.equal(status(id).textContent, '');
    icons.add(status(id).innerHTML);
  }
  assert.equal(icons.size, 3, 'each status has its own icon');
});

test('expand and collapse are icon buttons that keep their names', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const expand = ui.$('#task-list [data-task="task-b"] .task-expand');
  assert.equal(expand.textContent, '');
  assert.ok(expand.querySelector('svg'));
  assert.equal(expand.title, 'Expand');
  assert.equal(expand.getAttribute('aria-label'), 'Expand Ship the fix');
});

test('the check icon verifies a ready task, and only a ready task has one', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  assert.deepEqual(
    [...ui.window.document.querySelectorAll('#task-list .task-verify')].map(
      (button) => button.closest('[data-task]').dataset.task,
    ),
    ['task-b'],
  );
  const verify = ui.$('[data-task="task-b"] .task-verify');
  assert.equal(verify.getAttribute('aria-label'), 'Mark verified: Ship the fix');
  assert.equal(verify.title, 'Mark verified');
  assert.equal(verify.textContent, '', 'an icon, no label');
  assert.ok(verify.querySelector('svg'));
  verify.click();
  await settle();
  assert.deepEqual(apiCalls(ui), [{ method: 'POST', path: '/api/tasks/task-b/verify', body: {} }]);
});

test('the activity dropdown of a task is one icon, named and lit by its link', async (t) => {
  const ui = await fixture(t, { initial: sample() });
  const linked = ui.$('[data-task="task-a"] .activity-link');
  const trigger = linked.querySelector('.picker-trigger');
  assert.ok(linked.classList.contains('linked'));
  assert.equal(trigger.title, 'Activity: Decide on the release');
  assert.match(trigger.getAttribute('aria-label'), /^Activity: Decide on the release/);
  assert.ok(trigger.querySelector('.activity-link-icon svg'));
  const unlinked = sample();
  unlinked.activities[0].taskIds = [];
  ui.update(unlinked);
  const none = ui.$('[data-task="task-a"] .activity-link');
  assert.equal(none.classList.contains('linked'), false);
  assert.equal(none.querySelector('.picker-trigger').title, 'Link to an activity');
});

test('a verified task whose lead notification failed keeps its retry button in the footer', async (t) => {
  const state = sample();
  state.tasks[2] = { ...state.tasks[2], retiredAgentIds: [], verificationNotice: { state: 'error', error: 'down' } };
  const ui = await fixture(t, { initial: state });
  ui.click('#show-archived');
  const card = ui.$('#task-list [data-task="task-c"]');
  assert.equal(card.querySelector('.task-card-footer button.primary').textContent, 'Retry lead notification');
  assert.equal(card.querySelector('.task-verify'), null);
  assert.match(ui.$('#task-list [data-task="task-a"] .task-card-footer').textContent, /assigned worker/);
});
