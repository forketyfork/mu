// A check of choices in chat messages in a real browser: the user clicks a button with the mouse, the answer reaches
// the asker as the user's message, and the question shows the answer instead of its buttons; Reply in words puts a
// quote into the message box, where the user types and sends with Enter. It starts a throwaway Mu app with a fake chat
// and drives headless Chrome over the DevTools protocol; `npm run test:browser` runs it.
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

test('the user answers a question by a click, or in words', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'choices-browser'),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
    platform: 'darwin',
  });
  await app.start();
  t.after(async () => {
    app.runner.active.clear();
    await app.close();
  });
  app.runner.paused = true;
  const url = `http://127.0.0.1:${port}`;
  const post = async (path, data) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: userHeaders(app),
      body: JSON.stringify(data),
    });
    const body = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  };
  await post('/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  await post('/api/agents', { id: 'worker', role: 'worker', adapter: 'manual', cwd: ROOT, task: '' });
  await post('/api/conversations', { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: ['worker'] });
  const question = await post('/api/messages', {
    from: 'lead',
    conversationId: 'dm-lead',
    text: 'The review passed.\n\nMerge it now?',
    choices: ['Merge', 'Wait for CI'],
  });

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
  let shots = 0;
  const shot = async (name) => {
    if (!SHOTS) return;
    await sleep(300);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(join(SHOTS, `choices-${(shots += 1)}-${name}.png`), Buffer.from(data, 'base64'));
  };
  // The mouse of a real user, at the middle of the element that the selector finds.
  const click = async (selector) => {
    const point = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center' });
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    for (const type of ['mousePressed', 'mouseReleased'])
      await browser.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }, sessionId);
  };
  const enter = async () => {
    const pressed = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...pressed, text: '\r' }, sessionId);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...pressed }, sessionId);
  };
  const block = (id) => `#messages [data-message="${id}"] .message-choices`;
  const labels = (id) =>
    evaluate(`[...document.querySelectorAll('${block(id)} button')].map((button) => button.textContent)`);

  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}#team-chat` }, sessionId);
  await until('the question offers its choices', async () => (await labels(question.id))?.length === 3);
  assert.deepEqual(await labels(question.id), ['Merge', 'Wait for CI', 'Reply in words']);
  await shot('question');

  await click(`${block(question.id)} button:nth-child(2)`);
  await until('the answer is in the chat', () => app.store.answerTo(app.store.message(question.id)));
  const answer = app.store.answerTo(app.store.message(question.id));
  assert.equal(answer.from, 'user');
  assert.equal(answer.choice, 'Wait for CI');
  assert.equal(answer.text, `> Re: \`#${question.id}\` Merge it now?\n\nWait for CI`);
  assert.deepEqual(
    app.store.inbox('lead').map((message) => message.id),
    [answer.id],
    'the answer starts a turn of the asker',
  );
  await until(
    'the question shows the answer instead of its buttons',
    async () =>
      (await evaluate(`document.querySelector('${block(question.id)}.answered')?.textContent`)) ===
      'You choseWait for CI',
  );
  assert.deepEqual(await labels(question.id), []);
  await until('the answer shows as the user message', () =>
    evaluate(`Boolean(document.querySelector('#messages [data-message="${answer.id}"]'))`),
  );
  assert.equal(
    await evaluate(`document.querySelector('${block(question.id)}.answered')?.textContent`),
    'You choseWait for CI',
  );
  await shot('answered');

  // A question in a room, answered in words.
  const roomQuestion = await post('/api/messages', {
    from: 'worker',
    conversationId: 'work',
    text: 'Which branch should I rebase on?',
    choices: ['main', 'release'],
  });
  await evaluate(`document.querySelector('[data-conversation="work"]').click()`);
  await until('the room question offers its choices', async () => (await labels(roomQuestion.id))?.length === 3);
  await click(`${block(roomQuestion.id)} .choice-words`);
  assert.equal(await evaluate(`document.activeElement.id`), 'message-input');
  assert.equal(await evaluate(`document.activeElement.value`), `@worker\n\n> Re: \`#${roomQuestion.id}\`\n\n`);
  await browser.send('Input.insertText', { text: 'Neither: rebase on the hotfix branch.' }, sessionId);
  await shot('in-words');
  await enter();
  const reply = await until('the reply in words is in the chat', () =>
    app.store.messages(300, 'work').find((message) => message.from === 'user'),
  );
  assert.equal(reply.text, `@worker\n\n> Re: \`#${roomQuestion.id}\`\n\nNeither: rebase on the hotfix branch.`);
  assert.equal(reply.answers, undefined, 'words are not a click');
  assert.deepEqual(
    app.store.inbox('worker').map((message) => message.id),
    [reply.id],
  );
  await until('the reply is shown', () =>
    evaluate(`Boolean(document.querySelector('#messages [data-message="${reply.id}"]'))`),
  );
  assert.deepEqual(await labels(roomQuestion.id), ['main', 'release', 'Reply in words'], 'words leave the buttons');
  await shot('replied');
});
