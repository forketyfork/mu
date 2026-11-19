// A check, in a real browser, of the note at the top of the "Start an agent" and "Create task room" forms: it shows,
// its link closes the form and opens the lead's private chat, and it is calm in a dark and a light theme. It starts a
// throwaway Mu app with a fake chat and drives headless Chrome over the DevTools protocol. It is not part of `npm test`,
// because it needs Google Chrome; `npm run test:browser` runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ROOT } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { FakeChat, sleep, startBrowser, until } from './support.mjs';

const LIGHT_THEME = 'seed-2533678612';

async function startDashboard(t, post = []) {
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
  for (const [path, body] of post) {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: userHeaders(app),
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201, await response.text());
  }

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
  const load = async () => {
    await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}` }, sessionId);
    await until('the dashboard state', () =>
      evaluate(`document.querySelectorAll('#conversation-list [data-conversation]').length > 0`),
    );
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
  // The note's colors next to the tokens it should use and the ones of the alarming amber it must not use.
  const tones = (id) =>
    evaluate(`(() => {
      const resolve = (property, token) => {
        const probe = document.createElement('i');
        probe.style[property] = 'var(--' + token + ')';
        document.body.append(probe);
        const value = getComputedStyle(probe)[property];
        probe.remove();
        return value;
      };
      const style = getComputedStyle(document.getElementById(${JSON.stringify(id)}));
      const own = [style.backgroundColor, style.borderTopColor, style.color];
      const of = (group) => [
        resolve('backgroundColor', group + '-surface'),
        resolve('borderTopColor', group + '-edge'),
        resolve('color', group + '-ink'),
      ];
      return { own, calm: of('status-idle'), blocked: of('status-blocked') };
    })()`);
  return { url, app, browser, sessionId, evaluate, load, clickAt, where, note, tones };
}

test('the agent and room forms point the user to the lead, and the link opens the lead chat', async (t) => {
  const { evaluate, load, clickAt, where, note, tones } = await startDashboard(t, [
    ['/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' }],
    ['/api/conversations', { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [] }],
    ['/api/agents', { id: 'guest', role: 'worker', adapter: 'manual', cwd: ROOT, task: '' }],
  ]);
  await load();

  await clickAt('#new-agent');
  assert.equal((await where()).agentDialog, true);
  const agentNote = await note('agent-manual-note');
  assert.equal(agentNote.visible, true);
  assert.equal(
    agentNote.text,
    "You don't need to create agents by hand. Ask the lead in chat and it sets them up. Use this form when you want more control.",
  );
  const dark = await tones('agent-manual-note');
  assert.deepEqual(dark.own, dark.calm, 'the dark theme uses the calm tone');
  assert.notDeepEqual(dark.own, dark.blocked);
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
  assert.equal(
    roomNote.text,
    "You don't need to create rooms by hand. Ask the lead in chat and it sets them up. Use this form when you want more control.",
  );
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

  // A light theme has its own values for the same tokens.
  await evaluate(`localStorage.setItem('mu-theme', ${JSON.stringify(LIGHT_THEME)})`);
  await load();
  assert.equal(await evaluate(`document.documentElement.dataset.theme`), LIGHT_THEME);
  await clickAt('#new-agent');
  const light = await tones('agent-manual-note');
  assert.deepEqual(light.own, light.calm, 'the light theme uses the calm tone');
  assert.notDeepEqual(light.own, light.blocked);
  assert.notDeepEqual(light.own, dark.own, 'the light theme really changed the colors');
});

test('without a lead the forms have no note, since there is nobody to ask', async (t) => {
  const { evaluate, load, clickAt, where, note } = await startDashboard(t);
  await load();
  await clickAt('#new-agent');
  assert.equal((await where()).agentDialog, true);
  assert.equal((await note('agent-manual-note')).visible, false);
  await clickAt('#close-dialog');
  await evaluate(`document.querySelector('.rail-link[data-view="chat"]').click()`);
  await clickAt('#new-room');
  assert.equal((await where()).roomDialog, true);
  assert.equal((await note('room-manual-note')).visible, false);
});
