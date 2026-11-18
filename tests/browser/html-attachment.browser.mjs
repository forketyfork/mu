// A check of HTML attachments in a real browser, for what JSDOM cannot show: the sandbox and the policy of the frame
// that runs an agent's page, and how the dashboard sizes, enlarges and keeps that frame. It starts a throwaway Mu app
// with a fake chat and drives headless Chrome over the DevTools protocol; `npm run test:browser` runs it, and so does
// the pre-commit hook when a commit touches what it covers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp, ROOT } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';
import { FakeChat, sleep, startBrowser, until } from './support.mjs';

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// A page that plays and that tries the ways out of its frame that a content security policy governs. `elsewhere` is a
// server other than Mu, which must get no request. Its own script records what each attempt gave. WebRTC and the
// connection that Chrome opens ahead of a refused navigation are outside the policy; see "HTML attachments" in
// docs/architecture.md.
const page = (elsewhere) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Pong</title>
<link rel="stylesheet" href="${elsewhere}/link.css">
<link rel="prefetch" href="${elsewhere}/prefetch">
<link rel="icon" href="${elsewhere}/icon.png">
<style>
  @import url("${elsewhere}/import.css");
  body { margin: 0; font-family: sans-serif; }
  #court { width: 400px; height: 300px; background: rgb(10, 20, 30) url("${elsewhere}/background.png"); }
  @font-face { font-family: remote; src: url("${elsewhere}/font.woff2"); }
  h1 { font-family: remote; color: rgb(200, 30, 40); }
</style>
<script src="${elsewhere}/script.js"></script>
</head>
<body>
<h1 id="title">Pong</h1>
<canvas id="court"></canvas>
<img src="${elsewhere}/image.png" alt="">
<img id="inline" src="${PIXEL}" alt="">
<audio src="${elsewhere}/sound.mp3" autoplay></audio>
<form action="${elsewhere}/form" method="post"><input name="q" value="secret"></form>
<a id="away" href="${elsewhere}/link" ping="${elsewhere}/ping">away</a>
<script>
  window.boot = Math.random();
  window.ticks = 0;
  setInterval(() => { window.ticks += 1; }, 10);
  const results = {};
  const attempt = async (name, action) => {
    try { results[name] = await action(); } catch (error) { results[name] = error.name; }
  };
  window.done = (async () => {
    await attempt('origin', () => window.origin);
    await attempt('storage', () => localStorage.length);
    await attempt('cookie', () => document.cookie);
    await attempt('parentDocument', () => parent.document.title);
    await attempt('parentToken', () => parent.localStorage.getItem('mu-user-token'));
    await attempt('api', async () => (await fetch('/api/state')).status);
    await attempt('fetch', async () => (await fetch(${JSON.stringify(`${elsewhere}/fetch`)})).status);
    await attempt('xhr', () => new Promise((resolve) => {
      const request = new XMLHttpRequest();
      request.open('GET', ${JSON.stringify(`${elsewhere}/xhr`)});
      request.onload = () => resolve('loaded');
      request.onerror = () => resolve('error');
      request.send();
    }));
    await attempt('socket', () => new Promise((resolve) => {
      const socket = new WebSocket(${JSON.stringify(elsewhere.replace('http', 'ws'))});
      socket.onopen = () => resolve('open');
      socket.onerror = () => resolve('error');
    }));
    await attempt('beacon', () => navigator.sendBeacon(${JSON.stringify(`${elsewhere}/beacon`)}, 'secret'));
    await attempt('image', () => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve('loaded');
      image.onerror = () => resolve('error');
      image.src = ${JSON.stringify(`${elsewhere}/new-image.png`)};
    }));
    await attempt('worker', () => new Worker(URL.createObjectURL(new Blob(['postMessage(1)']))) && 'created');
    await attempt('frame', () => new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.src = ${JSON.stringify(`${elsewhere}/nested`)};
      frame.onload = () => resolve('loaded');
      document.body.append(frame);
      setTimeout(() => resolve('no load'), 1000);
    }));
    await attempt('popup', () => window.open(${JSON.stringify(`${elsewhere}/popup`)}) === null ? 'refused' : 'opened');
    await attempt('top', () => { top.location = ${JSON.stringify(`${elsewhere}/top`)}; return 'navigated'; });
    await attempt('alert', () => { alert('hi'); return 'returned'; });
    await attempt('submit', () => { document.querySelector('form').submit(); return 'submitted'; });
    await attempt('inlineImage', () => new Promise((resolve) => {
      const image = document.getElementById('inline');
      if (image.complete) resolve(image.naturalWidth);
      else image.onload = () => resolve(image.naturalWidth);
    }));
    await attempt('style', () => getComputedStyle(document.getElementById('title')).color);
    return results;
  })();
</script>
</body>
</html>`;

test('an HTML attachment runs in its sandboxed frame without reaching Mu, the dashboard or the network', async (t) => {
  const { app, url, worker, created } = await startDashboard(t);

  // A server that is not Mu.
  const reached = [];
  const other = createServer((request, response) => {
    reached.push(`${request.method} ${request.url}`);
    response.end();
  });
  other.on('upgrade', (request, socket) => {
    reached.push(`upgrade ${request.url}`);
    socket.destroy();
  });
  const otherPort = await freePort();
  await new Promise((resolve) => other.listen(otherPort, '127.0.0.1', () => resolve(undefined)));
  t.after(() => other.close());
  const elsewhere = `http://127.0.0.1:${otherPort}`;

  const posted = await worker('POST', '/api/messages', {
    conversationId: 'work',
    text: '@lead The game is ready.',
    attachment: { type: 'html', title: 'Pong', html: page(elsewhere) },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));

  const { browser, sessionId, sessions, evaluate, inFrame, frameSession } = await startSession(t);

  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}#team-chat` }, sessionId);
  await until('the conversation list', () =>
    evaluate(`Boolean(document.querySelector('#conversation-list [data-conversation="work"]'))`),
  );
  await evaluate(`document.querySelector('#conversation-list [data-conversation="work"]').click()`);
  // Nothing of the page runs before the user asks for it: the message shows what it is, and a Run button.
  await until('the attachment under its message', () =>
    evaluate(`Boolean(document.querySelector('.message-attachment'))`),
  );
  await sleep(500);
  assert.deepEqual(
    await evaluate(`(() => {
      const figure = document.querySelector('.message-attachment');
      return {
        frames: document.querySelectorAll('iframe').length,
        run: figure.querySelector('.message-attachment-run')?.textContent,
        visible: [...figure.querySelectorAll('.message-attachment-bar button')].filter((button) => !button.hidden).length,
      };
    })()`),
    { frames: 0, run: 'Run', visible: 0 },
  );
  const run = () => evaluate(`document.querySelector('.message-attachment-run').click()`);
  await run();
  await until('the frame as a target of its own', frameSession);
  await until('the page in the frame', () => inFrame(`Boolean(window.done)`));
  // A beacon, a worker and a frame are refused after the call returns, so what proves them is the other server below.
  const results = await inFrame(`window.done`);
  assert.deepEqual(results, {
    origin: 'null',
    storage: 'SecurityError',
    cookie: 'SecurityError',
    parentDocument: 'SecurityError',
    parentToken: 'SecurityError',
    api: 'TypeError',
    fetch: 'TypeError',
    xhr: 'error',
    socket: 'error',
    beacon: true,
    image: 'error',
    worker: 'created',
    frame: 'loaded',
    popup: 'refused',
    top: 'SecurityError',
    alert: 'returned',
    submit: 'submitted',
    inlineImage: 1,
    style: 'rgb(200, 30, 40)',
  });
  // What the page asked for in markup, in its styles and by script.
  await sleep(1000);
  assert.deepEqual(reached, [], 'the other server got nothing');
  // The dashboard draws the name and the size of the attachment, and gives the frame the height of the page.
  const pageHeight = await inFrame(
    `Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, document.body.scrollHeight))`,
  );
  const shown = await evaluate(`(() => {
    const figure = document.querySelector('.message-attachment');
    const frame = figure.querySelector('iframe');
    return {
      sandbox: frame.getAttribute('sandbox'),
      allow: frame.getAttribute('allow'),
      title: figure.querySelector('.message-attachment-title').textContent,
      size: figure.querySelector('.message-attachment-size').textContent,
      height: frame.getBoundingClientRect().height,
      width: frame.getBoundingClientRect().width <= figure.closest('.message-main').getBoundingClientRect().width,
      text: figure.closest('.message').querySelector('.message-text').textContent,
    };
  })()`);
  assert.equal(shown.sandbox, 'allow-scripts');
  assert.equal(shown.allow, "autoplay; picture-in-picture 'none'", 'the frame is given no other capability');
  assert.equal(shown.title, 'Pong');
  assert.match(shown.size, /^\d+\.\d KiB$/);
  assert.equal(shown.height, pageHeight);
  assert.equal(shown.width, true);
  assert.match(shown.text, /The game is ready/);
  const frameHeight = () =>
    evaluate(`document.querySelector('.message-attachment iframe').getBoundingClientRect().height`);
  // A height the page claims is bounded, so a page cannot push the chat away.
  await inFrame(`parent.postMessage({ type: 'size', height: 100000 }, '*')`);
  await until('the bounded height', () =>
    evaluate(`(() => {
      const frame = document.querySelector('.message-attachment iframe');
      return frame.style.height === '640px' && frame.getBoundingClientRect().height <= Math.min(640, innerHeight * 0.7);
    })()`),
  );
  await inFrame(`parent.postMessage({ type: 'size', height: ${pageHeight} }, '*')`);
  await until('the height of the page again', async () => (await frameHeight()) === pageHeight);

  // The larger view shows the same frame above the page, so the game goes on where it was.
  const boot = await inFrame(`window.boot`);
  const ticks = await inFrame(`window.ticks`);
  await evaluate(`document.querySelector('.message-attachment-expand').click()`);
  const larger = await evaluate(`(() => {
    const figure = document.querySelector('.message-attachment');
    return {
      open: figure.matches(':popover-open'),
      height: figure.querySelector('iframe').getBoundingClientRect().height,
      toggle: figure.querySelector('.message-attachment-expand').textContent,
    };
  })()`);
  assert.equal(larger.open, true);
  assert.ok(larger.height > 640, JSON.stringify(larger));
  assert.equal(larger.toggle, 'Close');
  assert.equal(await inFrame(`window.boot`), boot, 'the frame did not reload');
  await until('the page running on', async () => (await inFrame(`window.ticks`)) > ticks);
  await evaluate(`document.querySelector('.message-attachment-expand').click()`);
  assert.equal(await evaluate(`document.querySelector('.message-attachment').matches(':popover-open')`), false);
  assert.equal(await frameHeight(), pageHeight);

  // A change of the names that messages can link rebuilds the chat; the running frame moves into the new log.
  await evaluate(`document.querySelector('.message').dataset.before = 'rebuild'`);
  await created('/api/agents', { id: 'helper', role: 'worker', adapter: 'manual', cwd: ROOT, task: '' });
  await until('the rebuilt chat', () => evaluate(`!document.querySelector('.message[data-before]')`));
  assert.equal(await evaluate(`document.querySelectorAll('.message-attachment iframe').length`), 1);
  assert.equal(await inFrame(`window.boot`), boot, 'the rebuild did not restart the page');

  // Back in its conversation after another one, the page waits for Run again.
  await evaluate(`document.querySelector('#conversation-list [data-conversation="dm-worker"]').click()`);
  await until('the other conversation', () => evaluate(`!document.querySelector('.message-attachment')`));
  await evaluate(`document.querySelector('#conversation-list [data-conversation="work"]').click()`);
  await until('the attachment again', () => evaluate(`Boolean(document.querySelector('.message-attachment-run'))`));
  await sleep(500);
  assert.equal(await evaluate(`document.querySelectorAll('.message-attachment iframe').length`), 0);
  await run();
  await until('the page running again', async () => {
    const now = await inFrame(`window.boot ?? null`).catch(() => null);
    return now !== null && now !== boot;
  });
  const again = await inFrame(`window.boot`);

  // Restart runs the page again from its start.
  await evaluate(`document.querySelector('.message-attachment-restart').click()`);
  await until('the page started again', async () => {
    const now = await inFrame(`window.boot ?? null`).catch(() => null);
    return now !== null && now !== again;
  });

  // The page cannot take its frame to another host, by a link or by script: the dashboard's policy refuses it, and
  // the frame shows the browser's error page instead.
  await until('the page started again', () => inFrame(`Boolean(document.getElementById('away'))`));
  await inFrame(`document.getElementById('away').click()`);
  await sleep(1000);
  await evaluate(`document.querySelector('.message-attachment-restart').click()`);
  await until('the page started once more', () => inFrame(`Boolean(document.getElementById('away'))`));
  await inFrame(`location.href = ${JSON.stringify(`${elsewhere}/navigate`)}`);
  await sleep(1000);
  assert.deepEqual(reached, [], 'the other server got nothing');

  // A page that takes the keyboard by itself would get what the user types into the dashboard. It has the keyboard
  // while the user gave it, and Mu stops it when it takes it back from the message box.
  const trapped = await worker('POST', '/api/messages', {
    conversationId: 'work',
    text: 'Type here.',
    attachment: { type: 'html', title: 'Trap', html: TRAP },
  });
  const trap = `document.querySelector('[data-attachment="${trapped.body.id}"]')`;
  await until('the second attachment', () => evaluate(`Boolean(${trap})`));
  const centerOf = (selector) =>
    evaluate(
      `(() => { const box = ${selector}.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
    );
  await evaluate(`${trap}.scrollIntoView()`);
  // The page reports each key it gets, so that a key it took from the message box shows.
  await evaluate(
    `window.leaked = ''; addEventListener('message', (event) => { if (event.data?.type === 'key') window.leaked += event.data.key; })`,
  );
  await clickAt(browser, sessionId, await centerOf(`${trap}.querySelector('.message-attachment-run')`));
  const trapSession = async () => {
    for (const [session] of [...sessions].filter(([, info]) => info.type === 'iframe'))
      if (await evaluate(`Boolean(window.trap)`, session).catch(() => false)) return session;
    return null;
  };
  await until('the trap page', trapSession);
  const inTrap = async (expression) => evaluate(expression, await trapSession());
  await typeKeys(browser, sessionId, 'into-page');
  await until('the keys in the page it was given to', async () => await inTrap(`window.captured`));
  // It got its page once, however often it asks.
  assert.equal(await inTrap(`window.copies`), 0);

  await clickAt(
    browser,
    sessionId,
    await evaluate(
      `(() => { const box = document.getElementById('message-input').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
    ),
  );
  await evaluate(`window.leaked = ''`);
  await typeKeys(browser, sessionId, 'typed-after');
  await until('the page stopped', () => evaluate(`${trap}.classList.contains('stopped')`));
  assert.deepEqual(
    await evaluate(`({
      composer: document.getElementById('message-input').value,
      active: document.activeElement.id,
      frame: Boolean(${trap}.querySelector('iframe')),
      note: ${trap}.querySelector('.message-attachment-error').textContent,
      run: Boolean(${trap}.querySelector('.message-attachment-run')),
      leaked: window.leaked,
    })`),
    {
      composer: 'typed-after',
      active: 'message-input',
      frame: false,
      note: 'Mu stopped this page because it took the keyboard without your click.',
      run: true,
      leaked: '',
    },
  );
});

// A throwaway Mu app with a lead, a room `work` and a worker in it, as the user and the worker see its API.
async function startDashboard(t) {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'attachment-browser'),
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
  const created = async (path, body) => assert.equal((await user('POST', path, body)).status, 201, path);
  await created('/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  await created('/api/conversations', { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [] });
  await created('/api/agents', {
    id: 'worker',
    role: 'worker',
    adapter: 'manual',
    cwd: ROOT,
    task: '',
    conversationId: 'work',
    from: 'lead',
  });
  return { app, url, user, worker, created };
}

// A browser with one tab, and what it takes to read the tab and its attachment frame.
async function startSession(t, options = {}) {
  const browser = await startBrowser(t, options);
  /** @type {Map<string, any>} */
  const sessions = new Map();
  browser.on((message) => {
    if (message.method === 'Target.detachedFromTarget') sessions.delete(message.params.sessionId);
    else if (message.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = message.params;
      sessions.set(sessionId, targetInfo);
      void browser.send('Runtime.enable', {}, sessionId).catch(() => {});
    }
  });
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send(
    'Target.setAutoAttach',
    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
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
    if (!current) throw new Error('the attachment frame is not attached');
    return evaluate(expression, current);
  };
  return { browser, sessionId, sessions, evaluate, inFrame, frameSession };
}

// What a page that plays sound needs from its frame. The user's click on Run lands in the dashboard, not in the page:
// without the frame's `allow="autoplay"`, Chrome keeps the page's audio suspended until the user clicks or types inside
// it. The browser is told its default policy, so the check does not depend on the flags of the build.
const AUDIO_PAGE = `<!doctype html><title>Sound</title><canvas width="100" height="50"></canvas>
<script>
  const context = new AudioContext();
  const tone = context.createOscillator();
  tone.connect(context.destination);
  tone.start();
  window.audio = context;
  window.keys = '';
  addEventListener('keydown', (event) => { window.keys += event.key; });
</script>`;

async function runAudioPage(t) {
  const { app, url, worker } = await startDashboard(t);
  const posted = await worker('POST', '/api/messages', {
    conversationId: 'work',
    text: '@lead Listen.',
    attachment: { type: 'html', title: 'Sound', html: AUDIO_PAGE },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  const session = await startSession(t, {
    args: ['--autoplay-policy=document-user-activation-required', '--mute-audio'],
  });
  const { browser, sessionId, evaluate, inFrame, frameSession } = session;
  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}#team-chat` }, sessionId);
  await until('the conversation list', () =>
    evaluate(`Boolean(document.querySelector('#conversation-list [data-conversation="work"]'))`),
  );
  await evaluate(`document.querySelector('#conversation-list [data-conversation="work"]').click()`);
  await until('the Run button', () => evaluate(`Boolean(document.querySelector('.message-attachment-run'))`));
  await clickAt(
    browser,
    sessionId,
    await evaluate(
      `(() => { const box = document.querySelector('.message-attachment-run').getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
    ),
  );
  await until('the frame as a target of its own', frameSession);
  await until('the page in the frame', () => inFrame(`Boolean(window.audio)`));
  // Nothing has reached the page itself.
  assert.equal(await inFrame(`navigator.userActivation.hasBeenActive`), false);
  return session;
}

test('the page of an HTML attachment can play sound after the user clicked Run', async (t) => {
  const { inFrame } = await runAudioPage(t);
  await until('the audio running', async () => (await inFrame(`window.audio.state`)) === 'running', 5000);
});

// It takes the keyboard every 50 ms, records the keys it gets, and asks for its page again and again.
const TRAP = `<!doctype html><title>Trap</title><input id="field">
<script>
  window.trap = true;
  window.copies = 0;
  addEventListener('message', (event) => { if (event.data?.type === 'page') window.copies += 1; });
  for (let i = 0; i < 50; i += 1) parent.postMessage({ type: 'ready' }, '*');
  window.captured = '';
  addEventListener('keydown', (event) => {
    window.captured += event.key;
    parent.postMessage({ type: 'key', key: event.key }, '*');
  }, true);
  setInterval(() => { window.focus(); field.focus(); }, 50);
</script>`;

/** Keys as a user types them: the browser sends each to the frame that has the focus. */
async function typeKeys(browser, sessionId, text) {
  for (const key of text) {
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key }, sessionId);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, sessionId);
  }
}

/** A real click, with the pointer moved there first, as a user's. */
async function clickAt(browser, sessionId, { x, y }) {
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  for (const type of ['mousePressed', 'mouseReleased'])
    await browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
}
