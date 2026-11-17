// A check of the unread markers in a real browser, for what JSDOM cannot show: a real reload, real storage events
// between two tabs, and storage that is kept apart per origin. It starts throwaway Mu apps with a fake chat and drives
// headless Chrome over the DevTools protocol. It is not part of `npm test`, because it needs Google Chrome;
// `npm run test:browser` runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, ROOT } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { FakeChat, startBrowser, until } from './support.mjs';

async function startMu(t, name) {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, name),
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
  const post = async (path, body) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: userHeaders(app),
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201, await response.text());
  };
  await post('/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  await post('/api/conversations', { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [] });
  const say = (conversationId, text) => app.store.addMessage(crypto.randomUUID(), 'lead', text, conversationId);
  return { app, url, say };
}

async function openTab(browser, url) {
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
  const tab = {
    evaluate,
    async open() {
      await browser.send('Page.navigate', { url }, sessionId);
      await until('the dashboard', () => evaluate(`document.querySelectorAll('#agent-grid [data-agent]').length > 0`));
    },
    async reload() {
      await browser.send('Page.reload', {}, sessionId);
      await until('the dashboard', () => evaluate(`document.querySelectorAll('#agent-grid [data-agent]').length > 0`));
    },
    badge: () =>
      evaluate(
        `document.getElementById('chat-unread').hidden ? '' : document.getElementById('chat-unread').textContent`,
      ),
    conversationBadge: (id) =>
      evaluate(
        `document.querySelector('#conversation-list [data-conversation="${id}"] .unread-count')?.textContent ?? ''`,
      ),
    record: () => evaluate(`localStorage.getItem('mu:chat-viewed')`),
    async showBadge(expected) {
      await until(
        `the rail badge to be ${JSON.stringify(expected)}`,
        async () => (await tab.badge()) === expected || undefined,
      );
    },
    async openChat() {
      await evaluate(`document.querySelector('.rail-link[data-view="chat"]').click()`);
    },
    async openConversation(id) {
      await evaluate(`document.querySelector('#conversation-list [data-conversation="${id}"]').click()`);
      await until('the conversation', () =>
        evaluate(
          `document.querySelector('#conversation-list .selected')?.dataset.conversation === ${JSON.stringify(id)}`,
        ),
      );
    },
    tinted: () =>
      evaluate(`[...document.querySelectorAll('#messages .message.new .message-id')].map((item) => item.textContent)`),
  };
  return tab;
}

test('unread markers survive a reload, follow a second tab and stay apart per Mu instance', async (t) => {
  const first = await startMu(t, 'unread-persist-a');
  const second = await startMu(t, 'unread-persist-b');
  const browser = await startBrowser(t);
  const sign = (mu) => `${mu.url}/?token=${mu.app.identity.token}`;
  const tabA = await openTab(browser, sign(first));
  await tabA.open();
  assert.equal(await tabA.badge(), '', 'a first load marks nothing unread');
  assert.ok(await tabA.record(), 'and stores the starting position at once');

  first.say('dm-lead', 'build is red');
  first.say('work', 'plan ready');
  await tabA.showBadge('2');

  await tabA.reload();
  await tabA.showBadge('2');
  await tabA.openChat();
  await tabA.showBadge('1');
  assert.equal(await tabA.conversationBadge('work'), '1');
  assert.equal((await tabA.tinted()).length, 1, 'the private chat tints what it received since the last visit');

  await tabA.reload();
  await tabA.showBadge('1');
  await tabA.openConversation('work');
  await tabA.showBadge('');

  await tabA.reload();
  assert.equal(await tabA.badge(), '', 'a conversation that was opened stays read after a reload');

  // A second tab of the same browser follows the first. This one leaves the chat, so that arrivals stay unread in it.
  await tabA.evaluate(`location.hash = '#workspace'`);
  const tabB = await openTab(browser, first.url);
  await tabB.open();
  first.say('dm-lead', 'second message');
  first.say('work', 'second plan');
  await tabA.showBadge('2');
  await tabB.showBadge('2');
  await tabA.openChat();
  await tabA.showBadge('1');
  await tabB.showBadge('1');

  // Another instance on another port keeps its own record.
  const tabC = await openTab(browser, sign(second));
  await tabC.open();
  assert.equal(await tabC.badge(), '');
  second.say('dm-lead', 'other instance');
  await tabC.showBadge('1');
  await tabC.reload();
  await tabC.showBadge('1');
  assert.notEqual(await tabC.record(), await tabA.record());
  await tabB.reload();
  await tabB.showBadge('1');
});
