// What JSDOM cannot show about the pages of the dashboard: how wide each one is, which element scrolls, and how the
// cards of the Visuals page flow. It starts a throwaway Mu app with a fake chat and drives headless Chrome. The
// screenshots go to the directory in SHOTS, when it is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp, ROOT } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { FakeChat, sleep, startBrowser, until } from './support.mjs';

const SHOTS = process.env.SHOTS;
const PAGES = { workspace: '', 'brag-doc': '#brag-doc', evals: '#evals', visuals: '#visuals' };

// An app with two tasks that each have visuals, a task without any open task for a third author's visual, and enough
// visuals that the list is longer than the window.
async function seeded(t) {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'pages-layout'),
    ircPort: await freePort(),
    pricing: offlinePricing(),
    chatFactory: (options) => new FakeChat(options),
    platform: 'darwin',
  });
  await app.start();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${port}`;
  const as = (headers) => async (method, path, data) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const user = as(userHeaders(app));
  const asAgent = (id) => as({ 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue(id)}` });
  const created = async (path, body) => {
    const response = await user('POST', path, body);
    assert.equal(response.status, 201, JSON.stringify(response));
    return response.body;
  };
  await created('/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  const authors = [
    ['worker', 'work', 'Plan the storage migration'],
    ['writer', 'docs', 'Write the operator handbook for the evening shift'],
    ['drifter', 'loose', null],
  ];
  const tasks = new Map();
  for (const [agent, room, title] of authors) {
    await created('/api/conversations', { kind: 'room', id: room, name: room, from: 'lead', members: [] });
    await created('/api/agents', {
      id: agent,
      role: 'worker',
      adapter: 'claude',
      cwd: ROOT,
      task: '',
      conversationId: room,
      from: 'lead',
    });
    app.store.updateAgent(agent, { status: 'stopped' });
    if (title)
      tasks.set(agent, await created('/api/tasks', { title, conversationId: room, agentIds: [agent], from: 'lead' }));
  }
  const visuals = [];
  for (let index = 0; index < 12; index += 1) {
    const [agent] = authors[index % authors.length];
    const title = index === 1 ? 'Cutover checklist and rollback steps for the staging environment' : `Visual ${index}`;
    const response = await asAgent(agent)('POST', '/api/visuals', { source: `# ${title}\n\n## One\n\nText\n` });
    assert.equal(response.status, 201, JSON.stringify(response));
    visuals.push({ ...response.body, agent, title });
    await sleep(15);
  }
  return { app, url, tasks, visuals };
}

async function openedDashboard(t, { app, url }) {
  const browser = await startBrowser(t);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  const evaluate = async (expression) => {
    const result = await browser.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const viewport = (width, height) =>
    browser.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  const shot = async (name) => {
    if (!SHOTS) return;
    await sleep(300);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(join(SHOTS, `pages-layout-${name}.png`), Buffer.from(data, 'base64'));
  };
  await viewport(1500, 600);
  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}` }, sessionId);
  await until('the dashboard', () =>
    evaluate(`document.readyState === 'complete' && !!document.querySelector('.rail-link')`),
  );
  // Opens a page by its address, and waits until its pane is the one that shows.
  const open = async (page) => {
    await evaluate(`location.hash = ${JSON.stringify(PAGES[page])}`);
    const pane = page === 'workspace' ? 'workspace' : page;
    await until(`the ${page} page`, () => evaluate(`!document.getElementById('${pane}').hidden`));
    await sleep(500);
  };
  return { evaluate, viewport, shot, open };
}

// The box of the page that shows, against the box of the content area, and the elements below it that scroll on
// their own: the page must scroll with the document, so that its scrollbar is the window's.
const MEASURE = `(() => {
  const area = document.querySelector('.workspace-shell').getBoundingClientRect();
  const pane = [...document.querySelectorAll('.workspace-content > *')].find((element) => !element.hidden);
  const box = pane.getBoundingClientRect();
  const scrollers = [...document.querySelectorAll('.workspace-content *')]
    .filter((element) => /auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1)
    .map((element) => element.id || element.className);
  return {
    pane: pane.id,
    left: Math.round(box.left - area.left),
    right: Math.round(area.right - box.right),
    documentScrolls: document.documentElement.scrollHeight > innerHeight,
    scrollers,
  };
})()`;

test('every page fills the content area and scrolls with the document', async (t) => {
  const seed = await seeded(t);
  const { evaluate, viewport, shot, open } = await openedDashboard(t, seed);
  for (const [width, height] of [
    [1500, 500],
    [700, 500],
  ])
    for (const page of Object.keys(PAGES)) {
      await viewport(width, height);
      await open(page);
      const measured = await evaluate(MEASURE);
      const where = `${page} at ${width}: ${JSON.stringify(measured)}`;
      assert.equal(measured.left, 0, where);
      assert.equal(measured.right, 0, where);
      assert.deepEqual(measured.scrollers, [], where);
      if (page !== 'brag-doc') assert.equal(measured.documentScrolls, true, where);
      await shot(`${page}-${width}`);
    }
});

test('visuals are cards in the columns of the task cards, each with its task inside', async (t) => {
  const seed = await seeded(t);
  const { evaluate, viewport, shot, open } = await openedDashboard(t, seed);
  await open('visuals');
  const cards = `[...document.querySelectorAll('#visuals-list .visual-card')].map((card) => {
    const box = card.getBoundingClientRect();
    return {
      id: card.dataset.visual,
      tag: card.tagName,
      left: Math.round(box.left),
      top: Math.round(box.top),
      task: card.querySelector('.task-ref')?.textContent ?? null,
      taskInsideLink: Boolean(card.querySelector('a a')),
    };
  })`;
  const wide = await evaluate(cards);
  assert.equal(wide.length, 12);
  assert.equal(await evaluate(`document.querySelectorAll('#visuals-list .visuals-group').length`), 0, 'not grouped');
  assert.equal(new Set(wide.map((card) => card.left)).size, 3, JSON.stringify(wide));
  assert.equal(
    await evaluate(`getComputedStyle(document.getElementById('task-list')).columnCount`),
    await evaluate(`getComputedStyle(document.getElementById('visuals-list')).columnCount`),
  );
  const byVisual = new Map(seed.visuals.map((visual) => [visual.id, visual]));
  for (const card of wide) {
    const visual = byVisual.get(card.id);
    assert.equal(card.task, seed.tasks.get(visual.agent)?.title ?? null, JSON.stringify(card));
    assert.equal(card.taskInsideLink, false, 'no link inside a link');
  }
  assert.ok(
    wide.some((card) => card.task === null),
    'a visual without a task shows no reference',
  );
  await shot('visuals-cards-1500');

  // The task link goes to the task, not to the visual that holds it.
  const withTask = wide.find((card) => card.task);
  await evaluate(`document.querySelector('[data-visual="${withTask.id}"] .task-ref').click()`);
  await until('the task on the overview', () => evaluate(`!document.getElementById('workspace').hidden`));
  await open('visuals');
  // The card itself opens the visual.
  await evaluate(`document.querySelector('[data-visual="${withTask.id}"] .visual-card-link').click()`);
  await until('the viewer', () => evaluate(`!document.getElementById('visual-viewer').hidden`));
  assert.equal(await evaluate(`location.hash`), `#visuals/${withTask.id}`);

  await viewport(500, 700);
  await open('visuals');
  await evaluate(`document.getElementById('visual-back')?.click()`);
  await until('the list', () => evaluate(`!document.getElementById('visuals-index').hidden`));
  const narrow = await evaluate(cards);
  assert.equal(new Set(narrow.map((card) => card.left)).size, 1, JSON.stringify(narrow));
  await shot('visuals-cards-500');
});
