// A check of the mention badges in a real browser, for what JSDOM cannot show: the popover that the badge on the chat
// icon opens, where the two badges sit, and the counts across a real reload. It starts a throwaway Mu app with a fake
// chat and drives headless Chrome over the DevTools protocol; the screenshots go to the directory in SHOTS, when it is
// set. It is not part of `npm test`, because it needs Google Chrome; `npm run test:browser` runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp, ROOT } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { FakeChat, startBrowser, until } from './support.mjs';

const SHOTS = process.env.SHOTS;

async function startMu(t) {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'mention-badges'),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
    platform: 'darwin',
  });
  await app.start();
  t.after(async () => {
    app.runner.active.clear();
    await app.close();
  });
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: userHeaders(app),
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 201, await response.text());
  };
  for (const id of ['lead', 'worker'])
    await post('/api/agents', { id, role: id, adapter: 'manual', cwd: ROOT, task: '' });
  await post('/api/conversations', {
    kind: 'room',
    id: 'work',
    name: 'Work',
    from: 'lead',
    members: ['worker'],
  });
  const say = (from, conversationId, text) => app.store.addMessage(crypto.randomUUID(), from, text, conversationId);
  return { app, url: `http://127.0.0.1:${port}/?token=${app.identity.token}`, say };
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
  const ready = () =>
    until('the dashboard', () => evaluate(`document.querySelectorAll('#agent-grid [data-agent]').length > 0`));
  let shots = 0;
  const text = (id) =>
    evaluate(`document.getElementById('${id}').hidden ? '' : document.getElementById('${id}').textContent`);
  const tab = {
    evaluate,
    async open() {
      await browser.send('Page.navigate', { url }, sessionId);
      await ready();
    },
    async reload() {
      await browser.send('Page.reload', {}, sessionId);
      await ready();
    },
    unread: () => text('chat-unread'),
    mentions: () => text('chat-mentions'),
    async show(id, expected) {
      await until(`#${id} to be ${JSON.stringify(expected)}`, async () => (await text(id)) === expected || undefined);
    },
    rowBadges: (id) =>
      evaluate(`(() => {
        const row = document.querySelector('#conversation-list [data-conversation="${id}"]');
        return { unread: row.querySelector('.unread-count')?.textContent ?? '', mentions: row.querySelector('.mention-count')?.textContent ?? '' };
      })()`),
    // The box of an element relative to the chat icon, to see where a badge sits.
    boxes: () =>
      evaluate(`(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { icon: box('.rail-link[data-view="chat"]'), unread: box('#chat-unread'), mentions: box('#chat-mentions') };
      })()`),
    colors: () =>
      evaluate(`(() => {
        const color = (id) => getComputedStyle(document.getElementById(id)).backgroundColor;
        return { unread: color('chat-unread'), mentions: color('chat-mentions') };
      })()`),
    listOpen: () => evaluate(`document.getElementById('mention-list').matches(':popover-open')`),
    listed: () =>
      evaluate(
        `[...document.querySelectorAll('#mention-items .mention-item')].map((item) => ({ id: item.dataset.message, where: item.querySelector('.mention-item-where').textContent, text: item.querySelector('.mention-item-text').textContent }))`,
      ),
    async shot(name) {
      if (!SHOTS) return;
      shots += 1;
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(join(SHOTS, `mentions-${shots}-${name}.png`), Buffer.from(data, 'base64'));
    },
  };
  return tab;
}

test('mentions get their own badge and list, open the message, and persist across a reload', async (t) => {
  const mu = await startMu(t);
  const browser = await startBrowser(t);
  const tab = await openTab(browser, mu.url);
  await tab.open();
  assert.equal(await tab.mentions(), '', 'nothing mentions the user at first');

  mu.say('lead', 'dm-lead', 'build is red');
  mu.say('lead', 'dm-lead', '@user the deploy needs your decision');
  mu.say('worker', 'work', 'plan ready');
  mu.say('worker', 'work', '@all heads up');
  mu.say('worker', 'work', '@user which of the two designs do you want?\n\nTake your time.');
  await tab.show('chat-unread', '5');
  await tab.show('chat-mentions', '@2');
  await tab.shot('badges');

  const { icon, unread, mentions } = await tab.boxes();
  assert.ok(unread.top < icon.top + icon.height / 2 && unread.left > icon.left + icon.width / 2, 'unread: top right');
  assert.ok(
    mentions.top > icon.top + icon.height / 2 && mentions.left > icon.left + icon.width / 2,
    'mentions: bottom right',
  );
  assert.ok(unread.bottom <= mentions.top + 2, 'the two do not overlap');
  const { unread: unreadColor, mentions: mentionColor } = await tab.colors();
  assert.notEqual(unreadColor, mentionColor, 'a different color');

  await tab.evaluate(`document.querySelector('.rail-link[data-view="chat"]').click()`);
  await until('the chat', () => tab.evaluate(`document.getElementById('team-chat').hidden === false`));
  await tab.show('chat-mentions', '@1');
  assert.deepEqual(
    await tab.rowBadges('work'),
    { unread: '3', mentions: '@1' },
    'the room row shows both, side by side',
  );
  assert.equal(await tab.evaluate(`document.getElementById('conversation-mentions').textContent`), '@1');
  await tab.evaluate(`document.getElementById('conversation-browser').open = true`);
  await tab.shot('rows');
  await tab.evaluate(`document.getElementById('conversation-browser').open = false`);

  await tab.reload();
  await tab.show('chat-unread', '3');
  await tab.show('chat-mentions', '@1');

  await tab.evaluate(`location.hash = '#workspace'`);
  await tab.evaluate(`document.getElementById('chat-mentions').click()`);
  await until('the list to open', async () => (await tab.listOpen()) || undefined);
  assert.deepEqual(await tab.listed(), [
    {
      id: String(mu.app.store.messages(10, 'work').at(-1).id),
      where: '# Work · worker',
      text: '@user which of the two designs do you want? Take your time.',
    },
  ]);
  await tab.shot('list');

  await tab.evaluate(`document.querySelector('#mention-items .mention-item').click()`);
  await until('the room to open at its message', () =>
    tab.evaluate(
      `document.getElementById('chat-title').textContent === 'Work' && document.querySelector('#messages .message.revealed') !== null`,
    ),
  );
  assert.equal(await tab.listOpen(), false, 'the list closes');
  await tab.show('chat-mentions', '');
  await tab.show('chat-unread', '');
  await tab.shot('read');

  await tab.reload();
  assert.equal(await tab.mentions(), '', 'what was read stays read');
  assert.equal(await tab.unread(), '');
});
