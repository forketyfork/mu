// A check in a real browser of what the user sees when the author of a visual cannot run: the note before a comment is
// sent, the author that the comment wakes, and the lead that takes a comment for an author that failed. It starts a
// throwaway Mu app with a fake chat and drives headless Chrome over the DevTools protocol. Like the other browser
// checks it is not part of `npm test`; `npm run test:browser` runs it. The screenshots go to the directory in SHOTS.
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
const SOURCE = `# Storage plan

This plan moves the **session store** from files to SQLite.

## Steps {#steps}

1. Copy the files.
`;

test('a comment on a visual whose author is stopped wakes it, and one for an author that failed goes to the lead', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'visual-wake'),
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
  const lead = as({ 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue('lead')}` });
  const worker = as({ 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue('worker')}` });
  const created = async (path, body) => assert.equal((await user('POST', path, body)).status, 201);
  await created('/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  await created('/api/conversations', { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [] });
  // A manual worker: no CLI starts when it wakes, and the test plays its turn.
  await created('/api/agents', {
    id: 'worker',
    role: 'worker',
    adapter: 'manual',
    cwd: ROOT,
    task: '',
    conversationId: 'work',
    from: 'lead',
  });
  const task = (
    await user('POST', '/api/tasks', { title: 'Plan', conversationId: 'work', agentIds: ['worker'], from: 'lead' })
  ).body;
  app.runner.active.set('worker', { conversationId: 'work', messageIds: [] });
  const visual = (await worker('POST', '/api/visuals', { source: SOURCE })).body;
  assert.match(visual.id, /^vis-/, JSON.stringify(visual));
  app.runner.active.clear();
  // The task is verified and its worker retired, as when the user closed the task.
  assert.equal(
    (await lead('PATCH', `/api/tasks/${task.id}`, { status: 'ready', result: 'The plan is written.\n\n- Done.' }))
      .status,
    200,
  );
  assert.equal((await user('POST', `/api/tasks/${task.id}/verify`, {})).status, 200);
  assert.equal(app.store.agent('worker').status, 'stopped');

  const browser = await startBrowser(t);
  const sessions = new Map();
  browser.on((message) => {
    if (message.method === 'Target.attachedToTarget') {
      sessions.set(message.params.sessionId, message.params.targetInfo);
      void browser
        .send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          message.params.sessionId,
        )
        .catch(() => {});
    } else if (message.method === 'Target.detachedFromTarget') sessions.delete(message.params.sessionId);
  });
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  const evaluate = async (expression, session = sessionId) => {
    const result = await browser.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      session,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const frameSession = () => [...sessions].find(([, info]) => info.type === 'iframe')?.[0];
  const inFrame = (expression) => {
    const current = frameSession();
    if (!current) throw new Error('the sandboxed frame is not attached');
    return evaluate(expression, current);
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    await sleep(300);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(join(SHOTS, `wake-${name}.png`), Buffer.from(data, 'base64'));
  };
  const text = (id) =>
    evaluate(`(() => { const e = document.getElementById('${id}'); return e.hidden ? null : e.textContent; })()`);
  // A click on a button, which takes the focus from the comment field as a pointer does.
  const press = (id) =>
    evaluate(`(() => { const button = document.getElementById('${id}'); button.focus(); button.click(); })()`);
  // Types into the comment field as a user does.
  const write = (value) =>
    evaluate(`(() => {
      const field = document.getElementById('visual-composer-text');
      field.focus();
      field.value = ${JSON.stringify(value)};
      field.dispatchEvent(new Event('input'));
    })()`);
  const wholeVisual = () =>
    evaluate(
      `[...document.querySelectorAll('.visual-scope')].find((option) => option.textContent === 'Whole visual').click()`,
    );
  // What the panel says about the author, apart from the other notes.
  const about = () =>
    evaluate(`document.querySelector('#visual-comments-note .visual-comments-author')?.textContent ?? null`);
  const messagesFromUser = async () =>
    (await user('GET', '/api/conversations/work/messages?limit=50')).body.messages.filter(
      (message) => message.from === 'user',
    );

  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}#visuals/${visual.id}` }, sessionId);
  await until('the sandboxed frame', frameSession);
  await until('the document', () => inFrame(`document.querySelectorAll('.visual-section').length === 2`));

  // The panel says what a comment does before there is any comment.
  assert.equal(await about(), '@worker is stopped. Sending a comment wakes it, so that it takes the comment.');
  await shot('1-stopped');

  // A comment on the selected text, sent now.
  await inFrame(`(() => {
    const paragraph = document.querySelector('#section-intro p');
    const range = document.createRange();
    range.setStart(paragraph.querySelector('strong').firstChild, 0);
    range.setEnd(paragraph.querySelector('strong').nextSibling, 11);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  })()`);
  await until('the offer to comment', () => evaluate(`!document.getElementById('visual-comment-bubble').hidden`));
  await evaluate(`document.getElementById('visual-comment-bubble').click()`);
  await write('Which files? Name them.');
  await press('visual-composer-send');
  await until('the toast', async () => (await text('toast')) === '@worker was stopped and runs again to take it.');
  await shot('2-woken');
  assert.equal(app.store.agent('worker').status, 'idle');
  const [sent] = await messagesFromUser();
  assert.deepEqual(
    app.store.inbox('worker').map((message) => message.id),
    [sent.id],
  );
  const room = (await user('GET', '/api/conversations/work/messages?limit=50')).body.messages;
  assert.equal(
    room.filter((message) => message.from === 'system' && /nobody will process/.test(message.text)).length,
    0,
  );
  await until('no note: the author can run', async () => (await about()) === null);
  await until(
    'the sent comment',
    async () =>
      (await evaluate(`document.querySelector('#visual-comments-list .visual-comment-state')?.textContent`)) === 'Sent',
  );

  // The woken author takes its turn and answers: the section that it changed flashes in place.
  const [comment] = (await worker('GET', `/api/visuals/${visual.id}/comments`)).body;
  app.store.updateAgent('worker', { status: 'working' });
  app.runner.active.set('worker', { conversationId: 'work', messageIds: [sent.id] });
  const answered = await worker('PATCH', `/api/visuals/${visual.id}`, {
    source: '# Storage plan\n\nThis plan moves the **session store** from the files `sessions/*.json` to SQLite.\n',
    resolves: [comment.id],
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  await until('the changed section', () =>
    inFrame(`document.querySelector('#section-intro').textContent.includes('sessions/*.json')`),
  );
  assert.equal(await inFrame(`document.querySelector('#section-intro').classList.contains('flash')`), true);
  await shot('3-answered');
  app.runner.active.clear();
  app.store.updateAgent('worker', { status: 'idle' });

  // The author fails: a comment does not resume it, and the panel says so before the user sends.
  app.store.updateAgent('worker', { status: 'error', lastError: 'claude exited with code 1' });
  await until('the note about the failure', async () =>
    ((await about()) ?? '').startsWith('@worker failed: claude exited with code 1.'),
  );
  assert.equal(
    await about(),
    '@worker failed: claude exited with code 1. A comment does not resume it: sending goes to @lead, who can resume @worker.',
  );
  await shot('4-failed');
  await wholeVisual();
  await write('Please also cover the rollback.');
  await press('visual-composer-send');
  await until('the toast', async () => (await text('toast')) === 'Sent to @lead: the author cannot run.');
  await shot('5-to-lead');
  assert.equal(app.store.agent('worker').status, 'error');
  const toLead = (await messagesFromUser()).at(-1);
  assert.match(
    toLead.text,
    /^@lead A comment on visual `vis-[0-9a-f]{8}` `Storage plan`, version 2, sent to you because/,
  );
  // The failed author gets nothing that it would run on resume; the lead has the comment.
  assert.equal(
    app.store.inbox('worker').some((message) => message.id === toLead.id),
    false,
  );
  assert.equal(
    app.store.inbox('lead').some((message) => message.id === toLead.id),
    true,
  );
});
