import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/server.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { FakeChat, startBrowser, until } from './support.mjs';

test('preview is free; the confirmed run and its evidence survive a real browser reload', async (t) => {
  const calls = [];
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    dataDir: await shortTempDir(t, 'eval-browser'),
    port,
    ircPort: await freePort(),
    pricing: offlinePricing(),
    chatFactory: (options) => new FakeChat(options),
    evalRunner: {
      prepare: async () => 'sha256:test-image',
      execute: async (call) => {
        calls.push(call);
        return {
          reply: '{"first":["a3","b2"],"stages":["package","compile"],"contrast":["a2","b2"]}',
          costUsd: 0.12,
          tokens: 37,
        };
      },
    },
  });
  await app.start();
  t.after(() => app.close());
  const browser = await startBrowser(t);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => {
    const result = await browser.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Page.navigate', { url: `http://127.0.0.1:${port}/?token=${app.identity.token}` }, sessionId);
  await until('dashboard navigation', () =>
    evaluate(`!!document.querySelector('[data-view="evals"]') && document.readyState==='complete'`),
  );
  await evaluate(`document.querySelector('[data-view="evals"]').click()`);
  await until('work samples', () => evaluate(`document.querySelectorAll('#eval-cases input').length===3`));
  await evaluate(`document.querySelector('#eval-model').focus()`);
  await browser.send('Input.insertText', { text: 'sample-model' }, sessionId);
  await evaluate(`document.querySelector('#eval-budget').select()`);
  await browser.send('Input.insertText', { text: '0.42' }, sessionId);
  await evaluate(
    `document.querySelector('#eval-effort').value='high'; [...document.querySelectorAll('#eval-cases input')].slice(1).forEach(box=>box.click()); document.querySelector('#eval-preview').click()`,
  );
  await until('a signed-off price preview', () =>
    evaluate(
      `!document.querySelector('#eval-confirm').hidden && document.querySelector('#eval-estimate').textContent.includes('$0.42')`,
    ),
  );
  assert.equal(calls.length, 0);
  await evaluate(`document.querySelector('#eval-start').click()`);
  await until('the scored result', () =>
    evaluate(`document.querySelector('#eval-comparison').textContent.includes('3/3 checks')`),
  );
  assert.deepEqual(calls[0].target, { adapter: 'claude', model: 'sample-model', effort: 'high' });
  await browser.send('Page.reload', {}, sessionId);
  await until('saved evidence after reload', () =>
    evaluate(`document.querySelector('#eval-comparison details summary')?.textContent === 'Inspect evidence'`),
  );
  await evaluate(`document.querySelector('#eval-comparison details summary').click()`);
  assert.equal(
    await evaluate(
      `document.querySelector('#eval-comparison details[open]').innerText.includes('Causal line in both jobs')`,
    ),
    true,
  );
});
