// A check, in a real browser, of the note at the top of the "Start an agent" and "Create task room" forms: it shows,
// and its link closes the form and opens the lead's private chat. It starts a throwaway Mu app with a fake chat and
// drives headless Chrome over the DevTools protocol. It is not part of `npm test`, because it needs Google Chrome;
// `npm run test:browser` runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ROOT } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { FakeChat, sleep, startBrowser, until } from './support.mjs';

test('the agent and room forms point the user to the lead, and the link opens the lead chat', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'manual-forms-note-browser'),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(async () => {
    app.runner.active.clear();
    await app.close();
  });
  const url = `http://127.0.0.1:${port}`;
  const user = userHeaders(app);
  const created = await fetch(`${url}/api/agents`, {
    method: 'POST',
    headers: user,
    body: JSON.stringify({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' }),
  });
  assert.equal(created.status, 201, await created.text());
  const room = await fetch(`${url}/api/conversations`, {
    method: 'POST',
    headers: user,
    body: JSON.stringify({ kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [] }),
  });
  assert.equal(room.status, 201, await room.text());
  const guest = await fetch(`${url}/api/agents`, {
    method: 'POST',
    headers: user,
    body: JSON.stringify({ id: 'guest', role: 'worker', adapter: 'manual', cwd: ROOT, task: '' }),
  });
  assert.equal(guest.status, 201, await guest.text());

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
  const clickAt = async (selector) => {
    const point = await evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    const mouse = { ...point, button: 'left', clickCount: 1 };
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse }, sessionId);
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse }, sessionId);
    await sleep(150);
  };
  const where = () =>
    evaluate(`({
      view: document.getElementById('view-label').textContent,
      conversation: document.querySelector('#conversation-list .selected')?.dataset.conversation,
      agentDialog: document.getElementById('agent-dialog').open,
      roomDialog: document.getElementById('room-dialog').open,
    })`);
  const note = (id) =>
    evaluate(`(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      const box = element.getBoundingClientRect();
      return { visible: box.width > 0 && box.height > 0, text: element.textContent.replace(/\\s+/g, ' ').trim() };
    })()`);

  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}` }, sessionId);
  await until('the dashboard', () => evaluate(`document.querySelectorAll('#agent-grid [data-agent]').length > 0`));

  await clickAt('#new-agent');
  assert.equal((await where()).agentDialog, true);
  const agentNote = await note('agent-manual-note');
  assert.equal(agentNote.visible, true);
  assert.match(agentNote.text, /create agents by hand/);
  await clickAt('#agent-manual-note .note-link');
  assert.deepEqual(await where(), {
    view: 'Chat',
    conversation: 'dm-lead',
    agentDialog: false,
    roomDialog: false,
  });
  assert.equal(await evaluate(`document.activeElement.id`), 'message-input');

  await evaluate(`location.hash = '#'`);
  await evaluate(`document.querySelector('.rail-link[data-view="chat"]').click()`);
  await clickAt('#new-room');
  assert.equal((await where()).roomDialog, true);
  const roomNote = await note('room-manual-note');
  assert.equal(roomNote.visible, true);
  assert.match(roomNote.text, /create rooms by hand/);
  await clickAt('#room-manual-note .note-link');
  assert.deepEqual(await where(), {
    view: 'Chat',
    conversation: 'dm-lead',
    agentDialog: false,
    roomDialog: false,
  });

  // Inviting to a room is not creating one: the note stays out of that dialog.
  await evaluate(`document.querySelector('#conversation-list [data-conversation="work"]').click()`);
  await clickAt('#invite-members');
  assert.equal((await where()).roomDialog, true);
  assert.equal((await note('room-manual-note')).visible, false);
  await evaluate(`document.getElementById('cancel-room-dialog').click()`);
});
