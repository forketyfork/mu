// A check of the @ autocomplete of the message box in a real browser, for what JSDOM cannot show: real key events with
// their default actions (Tab must not move the focus, Enter must not send), the focus staying in the text while the list
// is used with the mouse, and the list standing above the box rather than over the words. It starts a throwaway Mu app
// with a fake chat and drives headless Chrome over the DevTools protocol. It is not part of `npm test`, because it
// needs Google Chrome; `npm run test:browser` runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ROOT } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { FakeChat, sleep, startBrowser, until } from './support.mjs';

test('typing @ in a message box offers the live members, and every key does what the list promises', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'mention-browser'),
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
  const user = async (method, path, data) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: userHeaders(app),
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  const created = async (path, body) => assert.equal((await user('POST', path, body)).status, 201);
  await created('/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  await created('/api/conversations', { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [] });
  for (const id of ['api-worker', 'docs-writer', 'retired'])
    await created('/api/agents', {
      id,
      role: 'worker',
      adapter: 'manual',
      cwd: ROOT,
      task: '',
      conversationId: 'work',
      from: 'lead',
    });
  app.store.updateAgent('retired', { status: 'stopped' });

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
  await until('the dashboard', () => evaluate(`document.querySelectorAll('#agent-grid [data-agent]').length > 0`));
  await evaluate(`document.querySelector('.rail-link[data-view="chat"]').click()`);
  await evaluate(`document.querySelector('#conversation-list [data-conversation="work"]').click()`);
  await evaluate(`document.getElementById('message-input').focus()`);

  const key = async (name, code, virtualKeyCode, text = undefined) => {
    const pressed = { key: name, code, windowsVirtualKeyCode: virtualKeyCode, ...(text ? { text } : {}) };
    await browser.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...pressed }, sessionId);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...pressed }, sessionId);
  };
  const typeKeys = async (text) => {
    for (const character of text) await key(character, 'Key', character.toUpperCase().charCodeAt(0), character);
  };
  const arrowDown = () => key('ArrowDown', 'ArrowDown', 40);
  const arrowUp = () => key('ArrowUp', 'ArrowUp', 38);
  const enter = () => key('Enter', 'Enter', 13, '\r');
  const tab = () => key('Tab', 'Tab', 9);
  const escape = () => key('Escape', 'Escape', 27);
  const state = () =>
    evaluate(`(() => {
      const input = document.getElementById('message-input');
      const list = document.getElementById('mention-suggestions');
      const box = input.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      return {
        value: input.value,
        caret: input.selectionStart,
        focused: document.activeElement === input,
        open: !list.hidden,
        options: [...list.querySelectorAll('[role=option] strong')].map((item) => item.textContent),
        highlighted: list.querySelector('[aria-selected=true] strong')?.textContent,
        active: input.getAttribute('aria-activedescendant') === list.querySelector('[aria-selected=true]')?.id,
        expanded: input.getAttribute('aria-expanded'),
        above: list.hidden || bounds.bottom <= box.top,
      };
    })()`);
  const clear = () =>
    evaluate(`(() => {
      const input = document.getElementById('message-input');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  const sentInWork = () => app.store.messages(50, 'work').filter((message) => message.from === 'user');

  await typeKeys('Hi @');
  let seen = await state();
  assert.deepEqual(
    { open: seen.open, expanded: seen.expanded, focused: seen.focused, above: seen.above, active: seen.active },
    { open: true, expanded: 'true', focused: true, above: true, active: true },
  );
  assert.deepEqual(seen.options, ['@all', '@lead', '@api-worker', '@docs-writer'], 'no retired agent, no user');
  assert.equal(seen.highlighted, '@all');

  await arrowDown();
  await arrowDown();
  await arrowUp();
  assert.equal((await state()).highlighted, '@lead');
  await enter();
  seen = await state();
  assert.equal(seen.value, 'Hi @lead ');
  assert.equal(seen.caret, 9);
  assert.equal(seen.open, false);
  assert.equal(seen.focused, true);
  assert.equal(sentInWork().length, 0, 'Enter picked and did not send');

  await typeKeys('and @doc');
  assert.deepEqual((await state()).options, ['@docs-writer']);
  await tab();
  seen = await state();
  assert.equal(seen.value, 'Hi @lead and @docs-writer ');
  assert.equal(seen.focused, true, 'Tab picked and did not move the focus');

  await typeKeys('@a');
  await escape();
  seen = await state();
  assert.equal(seen.open, false);
  assert.equal(seen.value, 'Hi @lead and @docs-writer @a');
  await typeKeys('p');
  assert.deepEqual((await state()).options, ['@api-worker'], 'typing after Esc brings the list back');

  await clear();
  await typeKeys('mail me@le');
  assert.equal((await state()).open, false, 'an e-mail address');
  await clear();
  await typeKeys('run `@le');
  assert.equal((await state()).open, false, 'code');

  // With the list closed, Enter sends.
  await clear();
  await typeKeys('@lead status please');
  assert.equal((await state()).open, false, 'a space ended the name');
  await enter();
  await until('the message', () => sentInWork().length === 1);
  assert.equal(sentInWork()[0].text, '@lead status please');
  await until('the box to empty', async () => (await state()).value === '');

  // The mouse picks without taking the focus away.
  await typeKeys('@');
  const target = await evaluate(`(() => {
    const rect = document.querySelectorAll('#mention-suggestions [role=option]')[2].getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased'])
    await browser.send('Input.dispatchMouseEvent', { type, ...target, button: 'left', clickCount: 1 }, sessionId);
  await sleep(100);
  seen = await state();
  assert.equal(seen.value, '@api-worker ');
  assert.equal(seen.focused, true);
  assert.equal(seen.open, false);

  // The list while the user looks at it.
  await clear();
  await typeKeys('Please ask @');
  await arrowDown();
  const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  assert.ok(shot.data.length > 1000);
  if (process.env.MENTION_SCREENSHOT) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(process.env.MENTION_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
});
