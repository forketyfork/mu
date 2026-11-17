// A check of dragging a card of the focus list in a real browser, for what JSDOM cannot show: where the lanes are laid
// out and which element a real drag event reaches. It starts a throwaway Mu app with a fake chat and drives headless
// Chrome over the DevTools protocol, which intercepts the browser's drag and replays it as drag events at chosen points.
// It is not part of `npm test`, because it needs Google Chrome; `npm run test:browser` runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { FakeChat, sleep, startBrowser, until } from './support.mjs';

test('a card dropped anywhere in a lane box moves to that lane, also below its cards and on its edge', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'focus-drag-browser'),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
    platform: 'darwin',
  });
  await app.start();
  t.after(async () => {
    app.runner.active.clear();
    await app.close();
  });
  const url = `http://127.0.0.1:${port}`;
  const request = async (method, path, data) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: userHeaders(app),
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  // A tall Focus lane next to a short Control lane leaves Control's box much taller than its cards.
  for (const [text, lane] of [
    ['Decide on the release', 'focus'],
    ['Reply to the auditor', 'focus'],
    ['Review the budget', 'focus'],
    ['Plan the offsite', 'focus'],
    ['Book the venue', 'focus'],
    ['Check the contract', 'focus'],
    ['Audit report', 'control'],
  ])
    assert.equal((await request('POST', '/api/activities', { text, lane })).status, 201);
  const lanes = async () => {
    const { body } = await request('GET', '/api/state');
    const order = (lane) =>
      body.activities
        .filter((activity) => activity.lane === lane && !activity.checkedAt)
        .sort((a, b) => a.position - b.position)
        .map((activity) => activity.text);
    return { focus: order('focus'), control: order('control') };
  };

  const browser = await startBrowser(t);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  const evaluate = async (expression) => {
    const result = await browser.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}` }, sessionId);
  await until('the cards', () => evaluate(`document.querySelectorAll('.activity-card').length === 7`));

  const box = (selector) =>
    evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return r.toJSON(); })()`,
    );
  const cardBox = (text) =>
    evaluate(`(() => {
      const card = [...document.querySelectorAll('.activity-card')].find((item) => item.textContent.includes(${JSON.stringify(text)}));
      card.scrollIntoView({ block: 'center' });
      return card.getBoundingClientRect().toJSON();
    })()`);

  // The browser's own drag, started by a real press and move on the card; the protocol hands over the drag data, and the
  // drag events are then sent where the pointer is meant to be.
  await browser.send('Input.setInterceptDrags', { enabled: true }, sessionId);
  const drag = async (text, drop) => {
    let intercepted;
    const listener = (message) => {
      if (message.method === 'Input.dragIntercepted' && message.sessionId === sessionId)
        intercepted = message.params.data;
    };
    browser.on(listener);
    const from = await cardBox(text);
    // The card's padding, not its text or its buttons.
    const start = { x: from.left + from.width / 2, y: from.bottom - 4 };
    const mouse = (type, x, y, extra = {}) =>
      browser.send(
        'Input.dispatchMouseEvent',
        { type, x, y, button: 'left', buttons: 1, clickCount: 1, ...extra },
        sessionId,
      );
    await mouse('mouseMoved', start.x, start.y, { button: 'none', buttons: 0 });
    await mouse('mousePressed', start.x, start.y);
    for (let step = 1; step <= 5 && !intercepted; step += 1)
      await mouse('mouseMoved', start.x + step * 6, start.y + step * 6);
    await until('the browser to start the drag', () => intercepted);
    const point = await drop();
    const send = (type) =>
      browser.send(
        'Input.dispatchDragEvent',
        { type, x: point.x, y: point.y, data: intercepted, modifiers: 0 },
        sessionId,
      );
    await send('dragEnter');
    await send('dragOver');
    await sleep(50);
    await send('drop');
    await mouse('mouseReleased', point.x, point.y, { buttons: 0 });
    await sleep(300);
  };

  assert.deepEqual(await lanes(), {
    focus: [
      'Decide on the release',
      'Reply to the auditor',
      'Review the budget',
      'Plan the offsite',
      'Book the venue',
      'Check the contract',
    ],
    control: ['Audit report'],
  });

  // Below the cards of the lane but inside its box: the empty stretch under Control's cards.
  await drag('Decide on the release', async () => {
    const lane = await box('.activity-lane[data-lane="control"]');
    const card = await box('[data-lane-cards="control"] .activity-card');
    const room = lane.bottom - 30 - card.bottom;
    assert.ok(room > 30, `Control's box has room under its last card (${room}px) for the test to mean something`);
    return { x: lane.left + lane.width / 2, y: lane.bottom - 30 };
  });
  assert.deepEqual((await lanes()).control, ['Audit report', 'Decide on the release'], 'dropped under the cards');

  // On the bottom edge of the box, in its padding, under the second of the two columns that the cards flow down.
  await drag('Reply to the auditor', async () => {
    const lane = await box('.activity-lane[data-lane="control"]');
    return { x: lane.right - 40, y: lane.bottom - 4 };
  });
  assert.deepEqual((await lanes()).control, ['Audit report', 'Decide on the release', 'Reply to the auditor']);

  // On the header of the other lane: the card lands first.
  await drag('Audit report', async () => {
    const header = await box('.activity-lane[data-lane="focus"] .lane-header');
    return { x: header.left + header.width / 2, y: header.top + header.height / 2 };
  });
  assert.equal((await lanes()).focus[0], 'Audit report', 'dropped on the header');

  assert.equal(
    await evaluate(`document.querySelectorAll('.activity-drop, .drop-target').length`),
    0,
    'no drop marker is left behind',
  );
});
