import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, initialState, message, settle } from './ui-fixture.mjs';
import { ID, record, section, versionOf, viewer, withVisuals } from './ui-visuals-fixture.mjs';
import { codeReference, viewFromHash, visualFromHash, visualHash } from '../public/model.js';
import { changedSections, safeLink } from '../public/visuals-view.js';

test('a visual has an address, and its ID in text is a reference to it', () => {
  assert.equal(visualHash(ID), `#visuals/${ID}`);
  assert.equal(visualHash(ID, 3), `#visuals/${ID}/v3`);
  assert.deepEqual(visualFromHash(`#visuals/${ID}`), { id: ID, version: null });
  assert.deepEqual(visualFromHash(`#visuals/${ID}/v12`), { id: ID, version: 12 });
  // As many digits as the service takes for a version.
  assert.deepEqual(visualFromHash(`#visuals/${ID}/v123456789`), { id: ID, version: 123456789 });
  assert.equal(visualFromHash(`#visuals/${ID}/v1234567890`), null);
  for (const hash of ['#visuals', '#visuals/', '#visuals/vis-xyz', `#visuals/${ID}/v0`, `#visuals/${ID}/../x`])
    assert.equal(visualFromHash(hash), null, hash);
  assert.equal(viewFromHash(`#visuals/${ID}/v2`), 'visuals');
  assert.equal(viewFromHash('#visuals'), 'visuals');
  assert.equal(viewFromHash('#visuals/unknown'), 'workspace');
  assert.deepEqual(codeReference(ID, { visuals: [record()] }), {
    kind: 'visual',
    id: ID,
    title: 'Storage plan',
    agentId: 'lead',
  });
  assert.equal(codeReference('vis-ffffffff', { visuals: [record()] }), null);
});

test('only a web or mail address from a visual is offered to the user', () => {
  assert.equal(safeLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeLink('mailto:a@example.com'), 'mailto:a@example.com');
  for (const href of [
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'file:///etc/passwd',
    '/api/state',
    '',
    7,
    null,
    `https://example.com/${'a'.repeat(2000)}`,
  ])
    assert.equal(safeLink(href), null, String(href).slice(0, 40));
});

test('the sections to mark are those that are new or have new content', () => {
  const before = [section('a', '1'), section('b', '1'), section('c', '1')];
  assert.deepEqual(changedSections(before, [section('b', '1'), section('a', '2'), section('d', '1')]), ['a', 'd']);
  assert.deepEqual(changedSections(before, before), []);
});

test('the Visuals view lists visuals as cards with their task, a task card links to its visuals, and chat links a visual by its ID', async (t) => {
  const state = withVisuals(
    record(),
    record({
      id: 'vis-11111111',
      title: 'Loose notes',
      taskId: null,
      version: 1,
      sectionCount: 1,
      updatedAt: '2026-11-05T10:00:00Z',
    }),
  );
  state.messages.push({ ...message(3, 'room-a'), text: `See \`${ID}\` and \`vis-99999999\`.` });
  const ui = await fixture(t, { initial: state });
  const { window, $ } = ui;
  const chip = $('[data-task="task-a"] .visual-chip');
  assert.equal(chip.querySelector('.visual-chip-title').textContent, 'Storage plan');
  assert.equal(chip.querySelector('.visual-version-pill').textContent, 'v2');
  assert.equal(chip.getAttribute('href'), `#visuals/${ID}`);

  ui.click('.rail-link[data-view="visuals"]');
  await settle();
  assert.equal($('#visuals').hidden, false);
  assert.equal($('#view-label').textContent, 'Visuals');
  assert.equal($('#visuals-count').textContent, '2');
  assert.deepEqual(
    [...window.document.querySelectorAll('#visuals-list .visual-card')].map((card) => [
      card.querySelector('.visual-card-title').textContent,
      card.querySelector('.task-ref')?.textContent ?? null,
    ]),
    [
      ['Loose notes', null],
      ['Storage plan', 'Review changes'],
    ],
    'one flat list, the latest change first, and the task only on a visual that has one',
  );
  const taskLink = $(`[data-visual="${ID}"] .task-ref`);
  assert.equal(taskLink.closest('a.visual-card-link'), null, 'a link inside a link is invalid');
  taskLink.click();
  await settle();
  assert.equal($('#workspace').hidden, false, 'the task reference goes to the task, not to the visual');
  ui.click('.rail-link[data-view="visuals"]');
  await settle();
  $(`[data-visual="${ID}"] .visual-card-link`).click();
  await settle();
  assert.equal(window.location.hash, `#visuals/${ID}`);
  window.location.hash = '#visuals';
  await settle();
  assert.match($(`[data-visual="${ID}"] .visual-card-meta`).textContent, /@lead.*v2.*2 sections/);

  // A visual that appears while the list is shown is listed at once.
  ui.update({
    ...state,
    visuals: [...state.visuals, record({ id: 'vis-22222222', title: 'Fresh', updatedAt: '2026-11-06T10:00:00Z' })],
  });
  assert.equal($('#visuals-count').textContent, '3');
  assert.equal($('.visual-card-title').textContent, 'Fresh');

  window.document.querySelector('.rail-link[data-view="chat"]').click();
  window.document.querySelector('[data-conversation="room-a"]')?.click();
  await settle();
  const reference = $('.message .visual-ref');
  assert.equal(reference.textContent, 'Storage plan');
  assert.match($('.message:last-child .message-text').textContent, /vis-99999999/, 'an unknown ID stays code');
  reference.click();
  await settle();
  assert.equal(window.location.hash, `#visuals/${ID}`);
  assert.equal($('#visual-viewer').hidden, false);
});

test('the viewer draws a visual in a sandboxed frame and names its author, task and version itself', async (t) => {
  const visual = record();
  const sections = [section('intro', 'r1', ''), section('steps', 'r2', 'Steps')];
  const ui = await viewer(t, {
    hash: `#visuals/${ID}`,
    versions: { latest: versionOf(visual, 2, sections, { changed: ['steps'], removed: ['old'] }) },
  });
  const { $, window } = ui;
  await settle();
  assert.equal($('#visuals-index').hidden, true);
  const frame = ui.frame();
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts', 'no allow-same-origin: the frame has an opaque origin');
  assert.equal(frame.getAttribute('src'), '/visual/frame.html');
  assert.deepEqual(ui.asked, [`/api/visuals/${ID}`]);
  assert.equal($('#visual-title').textContent, 'Storage plan');
  assert.match($('#visual-meta').textContent, /by@lead.*for.*Review changes/);
  assert.equal($('#visual-version-label').textContent, 'Version 2 of 2');
  assert.equal($('#visual-following').hidden, false);
  assert.equal($('#visual-version-latest').hidden, true);
  assert.equal($('#visual-version-next').disabled, true);
  assert.equal($('#visual-version-previous').disabled, false);
  assert.deepEqual(
    [...window.document.querySelectorAll('.visual-outline-item')].map((item) => item.textContent),
    ['Introduction', 'Stepschanged'],
  );
  assert.equal($('#visual-removed').textContent, 'Removed in this version: old');

  // Nothing is sent before the frame's page says it is ready.
  ui.attach();
  assert.deepEqual(ui.posted, []);
  ui.fromFrame({ type: 'ready' });
  assert.equal(ui.posted.length, 1);
  const [render] = ui.posted;
  assert.equal(render.type, 'render');
  assert.equal(render.targetOrigin, '*');
  assert.deepEqual(render.sections, sections);
  assert.deepEqual(render.flash, []);
  assert.equal(render.tokens.accent, window.document.documentElement.style.getPropertyValue('--accent'));
  assert.ok(Object.keys(render.tokens).length > 100);

  $('.visual-outline-item:last-child').click();
  assert.deepEqual(
    { ...ui.posted.at(-1), targetOrigin: undefined },
    { type: 'scrollTo', sectionId: 'steps', targetOrigin: undefined },
  );
  ui.fromFrame({ type: 'active', sectionId: 'steps' });
  assert.equal($('.visual-outline-item[aria-current="true"]').dataset.section, 'steps');

  window.document.dispatchEvent(new window.CustomEvent('mu-theme-change', { detail: 'seed' }));
  assert.equal(ui.posted.at(-1).type, 'theme');
});

test('a change by the agent is drawn in place and marked while the newest version is followed', async (t) => {
  const first = record({ version: 1, revision: 1 });
  const sections = [section('a', 'a1'), section('b', 'b1')];
  const ui = await viewer(t, {
    hash: `#visuals/${ID}`,
    visuals: [first],
    versions: { latest: versionOf(first, 1, sections) },
  });
  const { $ } = ui;
  await settle();
  ui.attach();
  ui.fromFrame({ type: 'ready' });
  assert.equal(ui.posted.at(-1).top, true);

  const second = record({ version: 2, revision: 2 });
  const next = [section('a', 'a2'), section('b', 'b1'), section('c', 'c1')];
  ui.served.versions = { latest: versionOf(second, 2, next, { changed: ['a'], added: ['c'] }) };
  ui.update(withVisuals(second));
  await settle();
  assert.deepEqual(ui.asked, [`/api/visuals/${ID}`, `/api/visuals/${ID}`]);
  const render = ui.posted.at(-1);
  assert.deepEqual(render.sections, next);
  assert.deepEqual(render.flash, ['a', 'c']);
  assert.equal(render.top, false, 'the reader keeps their place');
  assert.equal($('#visual-version-label').textContent, 'Version 2 of 2');
  assert.deepEqual(
    [...ui.window.document.querySelectorAll('.visual-outline-mark')].map((mark) => mark.textContent),
    ['changed', 'new'],
  );

  // An update that leaves the content as it is, such as the author's status, loads nothing.
  ui.update({ ...withVisuals(second), agents: [{ ...initialState().agents[0], status: 'working' }] });
  await settle();
  assert.equal(ui.asked.length, 2);
  assert.equal($('.visual-working').textContent, 'working');
});

test('the user steps through versions; an older version stays put when a newer one arrives', async (t) => {
  const visual = record({ version: 3, revision: 5 });
  const ui = await viewer(t, {
    hash: `#visuals/${ID}`,
    visuals: [visual],
    versions: {
      latest: versionOf(visual, 3, [section('a', 'a3')]),
      2: versionOf(visual, 2, [section('a', 'a2')]),
      1: versionOf(visual, 1, [section('a', 'a1')]),
    },
  });
  const { $, window } = ui;
  await settle();
  ui.attach();
  ui.fromFrame({ type: 'ready' });

  // The steps are buttons that say what they do, with an icon and no text; at an end, the step that leads nowhere
  // is off, and a click on it goes nowhere.
  const steps = () =>
    ['previous', 'next'].map((step) => {
      const button = $(`#visual-version-${step}`);
      return [button.tagName, button.type, button.title, button.getAttribute('aria-label'), button.disabled];
    });
  assert.deepEqual(steps(), [
    ['BUTTON', 'button', 'Previous version', 'Previous version', false],
    ['BUTTON', 'button', 'Next version', 'Next version', true],
  ]);
  for (const step of ['previous', 'next']) {
    const button = $(`#visual-version-${step}`);
    assert.equal(button.textContent.trim(), '');
    assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(button.hasAttribute('tabindex'), false, 'the button is in the order of the Tab key');
  }
  ui.click('#visual-version-next');
  await settle();
  assert.equal(window.location.hash, `#visuals/${ID}`);

  ui.click('#visual-version-previous');
  await settle();
  assert.equal(window.location.hash, `#visuals/${ID}/v2`);
  assert.equal($('#visual-version-label').textContent, 'Version 2 of 3');
  assert.deepEqual(
    steps().map((step) => step.at(-1)),
    [false, false],
  );
  ui.click('#visual-version-previous');
  await settle();
  assert.equal($('#visual-version-label').textContent, 'Version 1 of 3');
  assert.deepEqual(
    steps().map((step) => step.at(-1)),
    [true, false],
  );
  ui.click('#visual-version-previous');
  await settle();
  assert.equal(window.location.hash, `#visuals/${ID}/v1`);
  ui.click('#visual-version-next');
  await settle();
  assert.equal(window.location.hash, `#visuals/${ID}/v2`);
  assert.equal($('#visual-version-label').textContent, 'Version 2 of 3');
  assert.equal($('#visual-following').hidden, true);
  assert.equal($('#visual-version-latest').hidden, false);
  assert.equal($('#visual-version-latest').textContent, 'Newest: v3');
  assert.deepEqual(ui.posted.at(-1).sections, [section('a', 'a2')]);
  assert.deepEqual(ui.posted.at(-1).flash, []);
  assert.equal(ui.posted.at(-1).top, true);

  const asked = ui.asked.length;
  const newer = record({ version: 4, revision: 6 });
  ui.update(withVisuals(newer));
  await settle();
  assert.equal(ui.asked.length, asked, 'the pinned version is not replaced');
  assert.equal($('#visual-version-label').textContent, 'Version 2 of 4');
  assert.equal($('#visual-version-latest').textContent, 'Newest: v4');

  ui.served.versions.latest = versionOf(newer, 4, [section('a', 'a4')]);
  ui.click('#visual-version-latest');
  await settle();
  assert.equal(window.location.hash, `#visuals/${ID}`);
  assert.equal($('#visual-version-label').textContent, 'Version 4 of 4');
  assert.equal($('#visual-following').hidden, false);

  // The browser's history steps back through what was shown.
  window.history.back();
  await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
  window.dispatchEvent(new window.HashChangeEvent('hashchange'));
  await settle();
  assert.equal($('#visual-version-label').textContent, 'Version 2 of 4');

  ui.click('#visual-back');
  await settle();
  assert.equal(window.location.hash, '#visuals');
  assert.equal($('#visual-viewer').hidden, true);
  assert.equal($('#visuals-index').hidden, false);
  assert.equal(ui.frame(), null, 'the frame is removed with its content');
});

test('the newest version changes while its turn runs, also for a user who pinned it', async (t) => {
  const visual = record({ version: 2, revision: 3 });
  const ui = await viewer(t, {
    hash: `#visuals/${ID}/v2`,
    visuals: [visual],
    versions: { 2: versionOf(visual, 2, [section('a', 'a1'), section('b', 'b1')]) },
  });
  await settle();
  ui.attach();
  ui.fromFrame({ type: 'ready' });
  assert.deepEqual(ui.asked, [`/api/visuals/${ID}?version=2`]);

  const amended = record({ version: 2, revision: 4 });
  ui.served.versions[2] = versionOf(amended, 2, [section('a', 'a2'), section('b', 'b1')]);
  ui.update(withVisuals(amended));
  await settle();
  assert.equal(ui.asked.length, 2);
  assert.deepEqual(ui.posted.at(-1).sections, [section('a', 'a2'), section('b', 'b1')]);
  assert.deepEqual(ui.posted.at(-1).flash, ['a']);
  assert.equal(ui.posted.at(-1).top, false);

  // The next turn makes version 3; from then on version 2 stays as it is, and is not asked for again.
  const next = record({ version: 3, revision: 5 });
  ui.served.versions[2] = versionOf(next, 2, [section('a', 'a2'), section('b', 'b1')]);
  ui.update(withVisuals(next));
  await settle();
  assert.equal(ui.asked.length, 3);
  assert.deepEqual(ui.posted.at(-1).flash, []);
  ui.update(withVisuals(record({ version: 3, revision: 6 })));
  await settle();
  assert.equal(ui.asked.length, 3);
  assert.equal(ui.$('#visual-version-latest').textContent, 'Newest: v3');
});

test('what the frame says is checked: only its own messages count, and a link opens only as a confirmed web address', async (t) => {
  const visual = record();
  const ui = await viewer(t, {
    hash: `#visuals/${ID}`,
    versions: { latest: versionOf(visual, 2, [section('a', 'a1')]) },
  });
  const { $, window } = ui;
  await settle();
  ui.attach();

  // A message from another window, such as a page that embeds or opened the dashboard, is not the frame.
  ui.fromFrame({ type: 'ready' }, window);
  ui.fromFrame({ type: 'link', href: 'https://evil.example/' }, window);
  assert.deepEqual(ui.posted, []);
  assert.equal($('#visual-link').hidden, true);

  ui.fromFrame({ type: 'ready' });
  for (const hostile of [
    null,
    'ready',
    7,
    { type: 'link' },
    { type: 'link', href: 'javascript:alert(1)' },
    { type: 'link', href: { toString: () => 'https://x.example' } },
    { type: 'active', sectionId: {} },
    { type: 'problems', problems: 'many' },
    { type: 'unknown' },
  ])
    ui.fromFrame(hostile);
  assert.equal($('#visual-link').hidden, true);
  assert.equal($('#visual-problems').hidden, true);
  assert.equal($('#page-error').hidden, true);

  ui.fromFrame({ type: 'link', href: 'https://example.com/docs?a=<b>' });
  assert.equal($('#visual-link').hidden, false);
  assert.equal($('#visual-link-url').textContent, 'https://example.com/docs?a=%3Cb%3E');
  const open = $('#visual-link-open');
  assert.equal(open.getAttribute('href'), 'https://example.com/docs?a=%3Cb%3E');
  assert.equal(open.target, '_blank');
  assert.equal(open.rel, 'noopener noreferrer');
  ui.click('#visual-link-dismiss');
  assert.equal($('#visual-link').hidden, true);
  assert.equal(open.hasAttribute('href'), false);

  ui.fromFrame({
    type: 'problems',
    problems: [
      { sectionId: 'flow', block: 1, message: '<img src=x onerror=alert(1)>' },
      { sectionId: 'flow', block: 2, message: 'again' },
      { sectionId: 7, message: 'ignored' },
    ],
  });
  assert.equal(
    $('#visual-problems').textContent,
    '2 blocks could not be drawn, in flow. The reason is shown in its place.',
  );
  assert.equal($('#visual-problems img'), null);
  ui.fromFrame({ type: 'problems', problems: [] });
  assert.equal($('#visual-problems').hidden, true);
});

test('a page opened at the address of a visual shows it once the workspace is known', async (t) => {
  const ui = await fixture(t, { hash: `#visuals/${ID}/v1`, initial: withVisuals(record()) });
  assert.equal(ui.$('#visual-viewer').hidden, false);
  assert.equal(ui.$('#visuals').hidden, false);
  assert.ok(ui.$('iframe.visual-frame'));
  assert.ok(ui.requests.some((request) => request.path === `/api/visuals/${ID}?version=1`));
});

test('a visual that cannot be loaded says why', async (t) => {
  const ui = await viewer(t, { hash: `#visuals/${ID}/v9`, versions: {} });
  await settle();
  assert.equal(ui.$('#visual-error').hidden, false);
  assert.equal(ui.$('#visual-error').textContent, `${ID} has no version 9`);
});

test('a visual is archived from its card and from the viewer, hidden until archived items are shown, and restored', async (t) => {
  const loose = record({ id: 'vis-11111111', title: 'Loose notes', taskId: null, sectionCount: 1 });
  let state = withVisuals(record(), loose);
  const ui = await fixture(t, { initial: state });
  const { window, $ } = ui;
  // The service applies a change of the archive and tells the dashboard, as it does through the stream.
  const calls = [];
  const fetch = window.fetch;
  window.fetch = async (path, options = {}) => {
    const match = /^\/api\/visuals\/(vis-[0-9a-f]{8})$/.exec(path);
    if (!match || options.method !== 'PATCH') return fetch(path, options);
    const { archived } = JSON.parse(options.body);
    calls.push([match[1], archived]);
    state = {
      ...state,
      visuals: state.visuals.map((visual) =>
        visual.id === match[1] ? { ...visual, archivedAt: archived ? '2026-11-06T10:00:00Z' : undefined } : visual,
      ),
    };
    ui.update(state);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const listed = () =>
    [...window.document.querySelectorAll('#visuals-list .visual-card')].map((card) => card.dataset.visual);
  ui.click('.rail-link[data-view="visuals"]');
  await settle();
  assert.equal($('#visuals-archive-toggle').hidden, true, 'nothing is archived, so nothing is offered');

  $(`[data-visual="${ID}"] .visual-card-archive`).click();
  await settle();
  assert.deepEqual(calls, [[ID, true]]);
  assert.deepEqual(listed(), ['vis-11111111']);
  assert.equal($('#visuals-count').textContent, '1');
  assert.equal($('[data-task="task-a"] .visual-chip'), null, 'the task card stops linking an archived visual');
  assert.equal($('#visuals-archive-toggle').textContent, 'Show 1 archived visual');

  // The one switch of the dashboard shows archived visuals, and tasks and chats with them.
  $('#visuals-archive-toggle').click();
  await settle();
  assert.equal(window.localStorage.getItem('mu:show-archived'), 'true');
  assert.equal($('#show-archived').checked, true);
  assert.deepEqual(listed().sort(), [ID, 'vis-11111111'].sort());
  assert.equal($(`[data-visual="${ID}"] .archived-tag`).textContent, 'Archived');
  assert.equal($(`[data-visual="${ID}"] .visual-card-archive`).textContent, 'Restore');
  assert.equal($('[data-task="task-a"] .visual-chip').getAttribute('href'), `#visuals/${ID}`);
  assert.equal($('#visuals-archive-toggle').textContent, 'Hide archived visuals');

  // An archived visual opens from its link, says that it is archived, and is restored from its viewer.
  $(`[data-visual="${ID}"] .visual-card-link`).click();
  await settle();
  assert.match($('#visual-meta').textContent, /Archived/);
  assert.equal($('#visual-archive').textContent, 'Restore');
  $('#visual-archive').click();
  await settle();
  assert.deepEqual(calls.at(-1), [ID, false]);
  assert.doesNotMatch($('#visual-meta').textContent, /Archived/);
  assert.equal($('#visual-archive').textContent, 'Archive');
  $('#visual-archive').click();
  await settle();
  assert.deepEqual(calls.at(-1), [ID, true]);
  assert.equal($('#visual-archive').textContent, 'Restore');

  // The service refuses: the user is told.
  window.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'Not allowed' }) });
  $('#visual-archive').click();
  await settle();
  assert.match($('#toast')?.textContent ?? '', /Not allowed/);
});
