// A check of the shortcut to the lead's chat (Cmd+L, Ctrl+L off a Mac) in a real browser, for what JSDOM cannot show:
// real focus, a sandboxed frame that takes the keys of its own, and the default action of the key. It starts a
// throwaway Mu app with a fake chat and drives headless Chrome over the DevTools protocol. It is not part of `npm test`,
// because it needs Google Chrome; `npm run test:browser` runs it.
//
// Whether a browser gives the page this key before its address bar is not decided here: headless Chrome has no address
// bar, and a key sent over the protocol skips the browser's own shortcuts. Chromium offers a key that is not in its
// reserved list (tabs, windows, quitting) to the page first, and the jump to the address bar is not in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ROOT } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { FakeChat, sleep, startBrowser, until } from './support.mjs';

const META = 4;
const CTRL = 2;

test('Cmd+L or Ctrl+L takes the user to the composer of the lead chat from every state of the dashboard', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'lead-shortcut-browser'),
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
  const as = (headers) => async (method, path, data) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const user = as(userHeaders(app));
  const worker = as({ 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue('worker')}` });
  const created = async (path, body) => assert.equal((await user('POST', path, body)).status, 201);
  await created('/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  await created('/api/conversations', { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [] });
  await created('/api/agents', {
    id: 'worker',
    role: 'worker',
    adapter: 'claude',
    cwd: ROOT,
    task: '',
    conversationId: 'work',
    from: 'lead',
  });
  app.store.updateAgent('worker', { status: 'stopped' });
  await created('/api/tasks', { title: 'Plan the migration', conversationId: 'work', agentIds: ['worker'] });
  const visual = await worker('POST', '/api/visuals', {
    source: '# Plan\n\nReading text to click on.\n\n## Steps {#steps}\n\n- one\n- two\n',
  });
  assert.equal(visual.status, 201, JSON.stringify(visual.body));

  const browser = await startBrowser(t);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  // The sessions of the frames, to look inside the sandboxed frame of a visual.
  const frames = new Map();
  browser.on((message) => {
    if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'iframe')
      frames.set(message.params.targetInfo.targetId, message.params.sessionId);
    else if (message.method === 'Target.detachedFromTarget') frames.delete(message.params.targetId);
  });
  await browser.send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    sessionId,
  );
  await browser.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: 1500,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    },
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
  const navigate = (hash) =>
    evaluate(`location.hash = ${JSON.stringify(hash)}; new Promise((resolve) => setTimeout(resolve, 100))`);
  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}` }, sessionId);
  await until('the dashboard', () => evaluate(`document.querySelectorAll('#agent-grid [data-agent]').length > 0`));

  const mac = await evaluate(`/^Mac/i.test(navigator.userAgentData?.platform ?? navigator.platform)`);
  const chord = mac ? META : CTRL;
  const wrong = mac ? CTRL : META;
  // A listener added after the page's own sees whether the page took the key from the browser.
  await evaluate(`window.pressed = [];
    document.addEventListener('keydown', (event) => {
      if (event.key.toLowerCase() === 'l') window.pressed.push(event.defaultPrevented);
    })`);
  const press = async (modifiers = chord, { key = 'l', autoRepeat = false } = {}) => {
    const pressed = { key, code: 'KeyL', windowsVirtualKeyCode: 76, modifiers };
    await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...pressed, autoRepeat }, sessionId);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...pressed }, sessionId);
    await sleep(150);
  };
  const where = () =>
    evaluate(`({
      view: document.getElementById('view-label').textContent,
      active: document.activeElement.id || document.activeElement.className,
      hasFocus: document.hasFocus(),
      draft: document.getElementById('message-input').value,
      conversation: document.querySelector('#conversation-list .selected')?.dataset.conversation,
      prevented: window.pressed.at(-1),
    })`);
  const type = (text) => browser.send('Input.insertText', { text }, sessionId);
  const enter = async () => {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' };
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key }, sessionId);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key }, sessionId);
  };
  const lead = { view: 'Chat', active: 'message-input', hasFocus: true, conversation: 'dm-lead', prevented: true };

  assert.match(
    await evaluate(`document.querySelector('.rail-link[data-view="chat"]').title`),
    mac ? /⌘L/ : /Ctrl\+L/,
    'the rail names the shortcut',
  );

  // From the workspace, with nothing in focus, and then a message typed as a hurried user would.
  assert.equal((await where()).view, 'Overview');
  await press();
  assert.deepEqual({ ...(await where()), draft: undefined }, { ...lead, draft: undefined });
  await type('Check the failing build');
  await enter();
  await until('the message in the chat', () =>
    evaluate(
      `[...document.querySelectorAll('#messages .message')].some((item) => item.textContent.includes('Check the failing build'))`,
    ),
  );
  assert.equal((await where()).draft, '', 'the sent text left the composer');
  assert.ok(
    app.store
      .messages(50, 'dm-lead')
      .some((message) => message.from === 'user' && message.text === 'Check the failing build'),
  );

  // The other platform's chord does nothing, and the browser keeps it.
  await navigate('#');
  await press(wrong);
  assert.equal((await where()).view, 'Overview');
  assert.equal((await where()).prevented, false);

  // From a text field of the workspace.
  await evaluate(`document.getElementById('agent-search').focus()`);
  await type('half a search');
  await press();
  assert.deepEqual({ ...(await where()), draft: undefined }, { ...lead, draft: undefined });
  await navigate('#');
  assert.equal(
    await evaluate(`document.getElementById('agent-search').value`),
    'half a search',
    'what was typed elsewhere stays',
  );

  // From another chat, with a draft in it: the draft stays in that chat, and the lead chat opens empty.
  await evaluate(`document.querySelector('.rail-link[data-view="chat"]').click()`);
  await evaluate(`document.querySelector('#conversation-list [data-conversation="work"]').click()`);
  await evaluate(`document.getElementById('message-input').focus()`);
  await type('note to the room');
  await press();
  assert.deepEqual({ ...(await where()), draft: undefined }, { ...lead, draft: undefined });
  assert.equal((await where()).draft, '');
  await evaluate(`document.querySelector('#conversation-list [data-conversation="work"]').click()`);
  assert.equal((await where()).draft, 'note to the room');

  // Pressed again in the lead composer: the typed text and the focus stay, and the browser does not get the key.
  await press();
  await type('draft for the lead');
  await press();
  assert.deepEqual(await where(), { ...lead, draft: 'draft for the lead' });

  // From inside the sandboxed frame of a visual, which keeps its keys to itself.
  const intoFrame = async () => {
    await navigate('#');
    await navigate(`#visuals/${visual.body.id}`);
    const box = await until('the frame', () =>
      evaluate(
        `(() => { const box = document.querySelector('iframe.visual-frame')?.getBoundingClientRect(); return box?.height > 100 && box.toJSON(); })()`,
      ),
    );
    await until('the frame', () => frames.size > 0);
    const session = [...frames.values()].at(-1);
    const inFrame = async (expression) =>
      (await browser.send('Runtime.evaluate', { expression, returnByValue: true }, session)).result.value;
    await until('the visual drawn in the frame', () =>
      inFrame(`document.querySelectorAll('#document h1, #document p').length > 0`),
    );
    // Added after the frame's own listener, so it sees whether the frame took the key from the browser.
    await inFrame(`window.taken = [];
      addEventListener('keydown', (event) => window.taken.push([event.key, event.defaultPrevented]))`);
    // A click puts the focus in the frame; the frame's own process gets it a moment later than the page, and a plain
    // key tells when it has.
    await until('the keyboard in the frame', async () => {
      for (const type of ['mousePressed', 'mouseReleased'])
        await browser.send(
          'Input.dispatchMouseEvent',
          { type, x: box.x + 100, y: box.y + 60, button: 'left', clickCount: 1 },
          sessionId,
        );
      const probe = { key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: 0 };
      await browser.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...probe }, sessionId);
      await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...probe }, sessionId);
      await sleep(100);
      return (
        (await where()).active === 'visual-frame' &&
        JSON.parse(await inFrame('JSON.stringify(window.taken)')).length > 0
      );
    });
    await inFrame('window.taken.length = 0');
    return () => inFrame('JSON.stringify(window.taken)');
  };
  let taken = await intoFrame();
  assert.equal((await where()).view, 'Visuals');
  // A key the dashboard would not act on stays with the browser, and the dashboard stays where it is.
  await press(wrong);
  await press(chord | 8);
  await press(chord, { autoRepeat: true });
  assert.equal(await taken(), JSON.stringify(['l', 'l', 'l'].map((key) => [key, false])));
  assert.deepEqual(await where(), {
    view: 'Visuals',
    active: 'visual-frame',
    hasFocus: true,
    draft: 'draft for the lead',
    conversation: 'dm-lead',
    prevented: lead.prevented,
  });
  await press();
  assert.equal(await taken(), JSON.stringify([...['l', 'l', 'l'].map((key) => [key, false]), ['l', true]]));
  assert.deepEqual(await where(), { ...lead, draft: 'draft for the lead' });

  // On a layout without a Latin L the key is still the L key.
  taken = await intoFrame();
  await press(chord, { key: 'д' });
  // The protocol may deliver the key more than once for a character outside Latin; each time the frame takes it.
  const cyrillic = JSON.parse(await taken());
  assert.ok(cyrillic.length > 0);
  assert.deepEqual([...new Set(cyrillic.map((entry) => JSON.stringify(entry)))], [JSON.stringify(['д', true])]);
  assert.deepEqual(await where(), { ...lead, draft: 'draft for the lead' });

  // A dialog with a form keeps the key and what is typed into it; the browser keeps the key too.
  await navigate('#');
  await evaluate(`document.getElementById('new-agent').click()`);
  await evaluate(`document.getElementById('agent-id').focus()`);
  await type('api-worker');
  await press();
  const dialog = await evaluate(`({
    open: document.getElementById('agent-dialog').open,
    active: document.activeElement.id,
    value: document.getElementById('agent-id').value,
    view: document.getElementById('view-label').textContent,
    prevented: window.pressed.at(-1),
  })`);
  assert.deepEqual(dialog, { open: true, active: 'agent-id', value: 'api-worker', view: 'Overview', prevented: false });
});
