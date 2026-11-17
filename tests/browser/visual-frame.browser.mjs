// A check of the visual frame in a real browser, for what JSDOM cannot show: the sandbox, the content security
// policies, module loading from an opaque origin, Mermaid and the highlighter. It starts a throwaway Mu app with a
// fake chat and drives headless Chrome over the DevTools protocol. It is not part of `npm test`, because it needs
// Google Chrome; `npm run test:browser` runs it, and so does the pre-commit hook when a commit touches what it
// covers. CHROME names the browser binary; the screenshots go to the directory in SHOTS, when it is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, ROOT } from '../../src/server.mjs';
import { offlinePricing } from '../offline-pricing.mjs';
import { userHeaders } from '../identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from '../isolation.mjs';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for what the page does on its own time: loading modules, drawing diagrams, receiving a change.
async function until(what, probe, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${what}; last: ${last instanceof Error ? last.message : JSON.stringify(last)}`,
      );
    await sleep(50);
  }
}

class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
  }
  async start() {}
  async connect() {}
  close() {}
  async syncConversation() {}
  async send(from, text, conversationId) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId);
  }
}

// `elsewhere` is the address of a server other than Mu. Whatever the content tries, that server gets no request.
const source = (elsewhere) => `# Storage migration plan

This plan moves the **session store** from files to SQLite. Read the [SQLite docs](https://sqlite.org/docs.html) or jump to [the steps](#steps).

<script>window.parent.postMessage({type:'link', href:'javascript:alert(1)'}, '*')</script>
<img src="${elsewhere}/markdown.png" alt="remote" onerror="window.pwned = 'markdown image'">
<a href="javascript:alert(1)">bad link</a>
<svg onload="window.pwned = 'markdown svg'"></svg>
<style>@import url("${elsewhere}/markdown.css");</style>
<div style="background-image: url('${elsewhere}/markdown-style.png')">styled</div>

## Overview {#overview}

- [x] Schema designed
- [ ] Migration written

| Option | Cost | Risk |
| --- | --- | --- |
| Files | low | high |
| SQLite | medium | low |

> A note: \`mu.sqlite\` is owned by the service.

## Flow {#flow}

\`\`\`mermaid
flowchart LR
  A[Agent] -->|patch| B(Mu service)
  B --> C[(SQLite)]
  B -->|stream| D{Dashboard}
  D --> E[Sandboxed frame]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant U as User
  participant M as Mu
  participant A as Agent
  U->>M: comment
  M->>A: message
  A->>M: visual patch
  M-->>U: new version
\`\`\`

## Steps {#steps}

\`\`\`js
// Content-addressed sections
export function rev(section) {
  const text = JSON.stringify([section.id, section.title, section.body]);
  return sha256(text).slice(0, 16); // 64 bits
}
\`\`\`

\`\`\`kotlin
data class Visual(val id: String, val version: Int) {
    fun next() = copy(version = version + 1)
}
\`\`\`

\`\`\`unknownlang
plain text stays plain
\`\`\`

## Hostile {#hostile}

A label that a diagram keeps as HTML, with handlers and addresses in it.

\`\`\`mermaid
flowchart LR
  A["<img src=${elsewhere}/label.png onerror=window.pwned=1>"] --> B["<b id=hostile-label onmouseover=window.pwned=2 style=background:url(${elsewhere}/label-style.png)>label</b>"]
  click A "${elsewhere}/click" _blank
\`\`\`

## Broken {#broken}

\`\`\`mermaid
flowchart LR
  A -->
  ??? not a diagram
\`\`\`
`;

async function cdp(port) {
  let version;
  for (let attempt = 0; ; attempt += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch (error) {
      if (attempt > 100) throw error;
      await sleep(100);
    }
  }
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  const listeners = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    } else for (const listener of listeners) listener(message);
  };
  return {
    send(method, params = {}, sessionId = undefined) {
      next += 1;
      const id = next;
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on: (listener) => listeners.push(listener),
    close: () => socket.close(),
  };
}

// A Mu app with one visual of a worker whose turn runs, and a browser that shows the visual in the dashboard.
// `shots` starts the names of the screenshots of one test.
async function opened(t, shots) {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'visuals-browser'),
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
  await user('POST', '/api/tasks', {
    title: 'Plan the storage migration',
    conversationId: 'work',
    agentIds: ['worker'],
    from: 'lead',
  });
  app.runner.active.set('worker', { conversationId: 'work' });
  // A server that is not Mu. The content of the visual names it in every way it can; none may reach it.
  const reached = [];
  const other = createServer((request, response) => {
    reached.push(`${request.method} ${request.url}`);
    response.end();
  });
  const otherPort = await freePort();
  await new Promise((resolve) => other.listen(otherPort, '127.0.0.1', () => resolve(undefined)));
  t.after(() => other.close());
  const elsewhere = `http://127.0.0.1:${otherPort}`;
  const visual = (await worker('POST', '/api/visuals', { source: source(elsewhere) })).body;
  assert.match(visual.id, /^vis-/, JSON.stringify(visual));

  assert.ok(existsSync(CHROME), `No browser at ${CHROME}; set CHROME to the binary of Google Chrome or Chromium`);
  const debugPort = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'mu-chrome-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1500,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  t.after(async () => {
    chrome.kill('SIGKILL');
    await sleep(300);
    await rm(profile, { recursive: true, force: true });
  });
  const browser = await cdp(debugPort);
  t.after(() => browser.close());
  const logs = [];
  const sessions = new Map();
  // Every request of the dashboard and the frame, by its ID, and the ones the browser itself refused.
  const requests = new Map();
  const refused = new Map();
  browser.on((message) => {
    if (message.method === 'Network.requestWillBeSent')
      requests.set(message.params.requestId, message.params.request.url);
    else if (message.method === 'Network.loadingFailed' && message.params.blockedReason)
      refused.set(message.params.requestId, message.params.blockedReason);
    else if (message.method === 'Target.detachedFromTarget') sessions.delete(message.params.sessionId);
    else if (message.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = message.params;
      sessions.set(sessionId, targetInfo);
      for (const domain of ['Runtime', 'Log', 'Network'])
        void browser.send(`${domain}.enable`, {}, sessionId).catch(() => {});
      void browser
        .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId)
        .catch(() => {});
    } else if (message.method === 'Runtime.consoleAPICalled')
      logs.push(
        `[console.${message.params.type}] ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`,
      );
    else if (message.method === 'Runtime.exceptionThrown')
      logs.push(
        `[exception] ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`,
      );
    else if (message.method === 'Log.entryAdded')
      logs.push(
        `[log.${message.params.entry.source}.${message.params.entry.level}] ${message.params.entry.text} ${message.params.entry.url ?? ''}`,
      );
  });
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Network.enable', {}, sessionId);
  const viewport = (width, height) =>
    browser.send(
      'Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  await viewport(1500, 1000);
  const evaluate = async (expression, session = sessionId) => {
    const result = await browser.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: false },
      session,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    // A picture shows what is painted, which is a moment after what the document holds.
    await sleep(300);
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(join(SHOTS, `shot-${shots}${name}.png`), Buffer.from(data, 'base64'));
  };
  const frameSession = () => [...sessions].find(([, info]) => info.type === 'iframe')?.[0];
  // The mouse of a real user: `type` is mousePressed or mouseReleased, at a point of the page.
  const mouse = (type, { x, y }) =>
    browser.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
  // A key of a real keyboard, pressed and let go in the dashboard.
  const KEYS = { Enter: [13, '\r'], Tab: [9, undefined], ' ': [32, ' '] };
  const keyboard = async (key) => {
    const [windowsVirtualKeyCode, text] = KEYS[key];
    const pressed = { key, code: key === ' ' ? 'Space' : key, windowsVirtualKeyCode };
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...pressed, text }, sessionId);
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...pressed }, sessionId);
  };
  // What the user asked of the system about motion, for the dashboard and for the frame, which is a page of its own.
  const reducedMotion = async (on) => {
    const features = [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : '' }];
    for (const session of [sessionId, frameSession()])
      await browser.send('Emulation.setEmulatedMedia', { features }, session);
  };

  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}#visuals` }, sessionId);
  await until('the list of visuals', () => evaluate(`Boolean(document.querySelector('.visual-card'))`));
  await shot('1-index');
  await evaluate(`document.querySelector('.visual-card').click()`);
  await until('the sandboxed frame as a target of its own', frameSession);
  const inFrame = (expression) => {
    const current = frameSession();
    if (!current) throw new Error('the sandboxed frame is not attached');
    return evaluate(expression, current);
  };
  const drawn = `document.querySelectorAll('.visual-section').length > 0 && !document.querySelector('.visual-rich.pending')`;
  await until('the diagrams and the code', () =>
    inFrame(`${drawn} && document.querySelectorAll('code.hljs').length === 2`),
  );
  await shot('2-viewer');
  return {
    app,
    url,
    user,
    worker,
    visual,
    elsewhere,
    reached,
    requests,
    refused,
    logs,
    evaluate,
    inFrame,
    shot,
    drawn,
    viewport,
    mouse,
    keyboard,
    reducedMotion,
  };
}

test('a visual renders in the sandboxed frame of a real browser', async (t) => {
  const {
    app,
    url,
    worker,
    visual,
    elsewhere,
    reached,
    requests,
    refused,
    logs,
    evaluate,
    inFrame,
    shot,
    drawn,
    viewport,
  } = await opened(t, '');
  const facts = await inFrame(`(async () => {
    const result = {
      origin: window.origin,
      sections: [...document.querySelectorAll('.visual-section')].map((s) => s.dataset.section),
      diagrams: document.querySelectorAll('.visual-mermaid svg').length,
      failed: document.querySelectorAll('.visual-rich.failed').length,
      highlighted: document.querySelectorAll('code.hljs').length,
      highlightSpans: document.querySelectorAll('code.hljs span').length > 10,
      scripts: document.querySelectorAll('#document script').length,
      images: document.querySelectorAll('.visual-markdown img').length,
      links: [...document.querySelectorAll('.visual-markdown a')].map((a) => a.getAttribute('href')),
      checkboxes: document.querySelectorAll('input[type=checkbox]').length,
      styled: document.querySelectorAll('.visual-markdown [style]').length,
      styleSheets: document.querySelectorAll('.visual-markdown style').length,
    };
    try { localStorage.getItem('x'); result.storage = 'readable'; } catch (error) { result.storage = error.name; }
    try { result.cookie = document.cookie; } catch (error) { result.cookie = error.name; }
    try { result.api = (await fetch('/api/visuals')).status; } catch (error) { result.api = error.name; }
    try { result.app = (await fetch('/app.js')).status; } catch (error) { result.app = error.name; }
    try { result.parent = window.parent.localStorage.getItem('mu-user-token'); } catch (error) { result.parent = error.name; }
    try { window.top.location = ${JSON.stringify(`${elsewhere}/top`)}; result.top = 'navigated'; } catch (error) { result.top = error.name; }
    try { result.eval = eval('1+1'); } catch (error) { result.eval = error.name; }
    return result;
  })()`);
  assert.deepEqual(facts, {
    origin: 'null',
    sections: ['intro', 'overview', 'flow', 'steps', 'hostile', 'broken'],
    diagrams: 3,
    failed: 1,
    highlighted: 2,
    highlightSpans: true,
    scripts: 0,
    images: 0,
    links: ['https://sqlite.org/docs.html', '#steps'],
    checkboxes: 2,
    styled: 0,
    styleSheets: 0,
    storage: 'SecurityError',
    cookie: 'SecurityError',
    api: 'TypeError',
    app: 'TypeError',
    parent: 'SecurityError',
    top: 'SecurityError',
    eval: 'EvalError',
  });
  await inFrame(`window.scrollTo(0, document.getElementById('section-flow').offsetTop + 300)`);
  await shot('2b-sequence');
  await inFrame(`document.getElementById('section-steps').scrollIntoView()`);
  await shot('2c-code');

  // The diagram library keeps the HTML of a label, handlers included. The frame's policy is what stops them: no
  // handler runs, and nothing the content names is fetched.
  const hostile = await inFrame(`(() => {
    const label = document.querySelector('#section-hostile .visual-mermaid svg');
    for (const element of label.querySelectorAll('*'))
      for (const type of ['mouseover', 'click', 'error', 'load', 'toggle'])
        element.dispatchEvent(new Event(type, { bubbles: true }));
    return {
      handlers: [...label.querySelectorAll('*')].flatMap((element) =>
        element.getAttributeNames().filter((name) => name.startsWith('on')).map((name) => element.localName + ' ' + name)),
      pwned: window.pwned ?? null,
      text: label.textContent.includes('label'),
    };
  })()`);
  await shot('2d-hostile');
  assert.equal(hostile.pwned, null, JSON.stringify(hostile));
  assert.equal(hostile.text, true);
  assert.equal(await evaluate(`window.pwned ?? null`), null);
  // A link of a diagram does not navigate the frame either; the dashboard shows its address like any other link.
  await inFrame(
    `document.querySelector('#section-hostile .visual-mermaid svg a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`,
  );
  const linkShown = `document.getElementById('visual-link').hidden ? null : document.getElementById('visual-link-url').textContent`;
  await until('the address of the diagram link', async () => (await evaluate(linkShown)) === `${elsewhere}/click`);
  await evaluate(`document.getElementById('visual-link-dismiss').click()`);
  assert.equal(await inFrame(`document.querySelectorAll('.visual-section').length`), 6, 'the frame kept its document');
  await inFrame(`window.scrollTo(0, 0)`);
  assert.deepEqual(
    await evaluate(`({
      title: document.getElementById('visual-title').textContent,
      label: document.getElementById('visual-version-label').textContent,
      outline: [...document.querySelectorAll('.visual-outline-item')].map((i) => i.textContent),
      problems: document.getElementById('visual-problems').textContent,
      error: document.getElementById('visual-error').textContent,
      hash: location.hash,
      sandbox: document.querySelector('iframe').getAttribute('sandbox'),
    })`),
    {
      title: 'Storage migration plan',
      label: 'Version 1 of 1',
      outline: ['Introduction', 'Overview', 'Flow', 'Steps', 'Hostile', 'Broken'],
      problems: 'One block could not be drawn, in broken. The reason is shown in its place.',
      error: '',
      hash: `#visuals/${visual.id}`,
      sandbox: 'allow-scripts',
    },
  );

  // A change in the same turn is drawn in place; the diagrams stay as they are.
  await worker('PATCH', `/api/visuals/${visual.id}`, {
    source:
      '## Overview {#overview}\n\nRewritten **in simple words**: files are slow, a database is fast.\n\n## Rollback {#rollback}\n\nKeep the files for a week.\n',
    remove: ['broken', 'hostile'],
  });
  await until('the change in the frame', () => inFrame(`Boolean(document.getElementById('section-rollback'))`));
  await shot('3-live-update');
  assert.deepEqual(
    await inFrame(
      `({ sections: [...document.querySelectorAll('.visual-section')].map((s) => s.dataset.section + (s.classList.contains('flash') ? '!' : '')), diagrams: document.querySelectorAll('.visual-mermaid svg').length })`,
    ),
    { sections: ['intro', 'overview!', 'rollback!', 'flow', 'steps'], diagrams: 2 },
  );
  // The next turn makes version 2.
  app.runner.active.set('worker', { conversationId: 'work' });
  await worker('PATCH', `/api/visuals/${visual.id}`, {
    source: '## Steps {#steps}\n\n1. Write the migration\n2. Run it\n',
  });
  const versionLabel = `document.getElementById('visual-version-label').textContent`;
  await until('version 2', async () => (await evaluate(versionLabel)) === 'Version 2 of 2');
  await shot('4-version-2');
  await evaluate(`document.getElementById('visual-version-previous').click()`);
  await until('version 1', async () => (await evaluate(versionLabel)) === 'Version 1 of 2');
  assert.equal(await evaluate(`location.hash`), `#visuals/${visual.id}/v1`);
  await until('the content of version 1', () =>
    inFrame(`Boolean(document.getElementById('section-rollback')) && ${drawn}`),
  );
  await shot('5-version-1');

  // The reading settings of the dashboard reach the frame: the text grows and the diagrams are drawn again.
  const textSize = `({ size: parseFloat(getComputedStyle(document.getElementById('document')).fontSize), diagrams: document.querySelectorAll('.visual-mermaid svg').length })`;
  const dashboardSize = `parseFloat(document.documentElement.style.getPropertyValue('--font-size-18px'))`;
  const initial = await evaluate(`document.documentElement.dataset.fontSize`);
  const before = await inFrame(textSize);
  assert.equal(before.size, await evaluate(dashboardSize));
  await evaluate(`document.querySelector('#reader-font-size-options [data-font-size="largest"]').click()`);
  const redrawn = (size) =>
    until(`text of ${size}px with the diagrams drawn again`, async () => {
      const now = await inFrame(`({ ...${textSize}, drawn: ${drawn} })`);
      return now.size === size && now.drawn && now.diagrams === before.diagrams;
    });
  const largest = await evaluate(dashboardSize);
  assert.ok(largest > before.size, `${largest} > ${before.size}`);
  await redrawn(largest);
  await shot('5b-largest-text');
  // The larger text moved the sections; the outline marks the one that is now at the reading line.
  const atReadingLine = `[...document.querySelectorAll('.visual-section')].filter((s) => s.getBoundingClientRect().top <= innerHeight * 0.35).at(-1)?.dataset.section ?? null`;
  const marked = `document.querySelector('#visual-outline [aria-current="true"]')?.dataset.section ?? null`;
  await until(
    'the outline to follow the moved sections',
    async () => (await evaluate(marked)) === (await inFrame(atReadingLine)),
  );
  await evaluate(`document.querySelector('#reader-font-size-options [data-font-size="${initial}"]').click()`);
  await redrawn(before.size);

  await evaluate(`document.querySelector('#reader-font-size-options [data-font-size="largest"]').click()`);
  await redrawn(largest);
  await viewport(390, 844);
  const mobileViewer = await evaluate(`(() => {
    const pane = document.getElementById('visuals');
    const header = document.querySelector('.visual-header');
    const versions = document.querySelector('.visual-versions');
    const body = document.querySelector('.visual-body');
    const frame = document.querySelector('.visual-frame');
    return {
      width: innerWidth,
      paneWidth: pane.clientWidth,
      paneScrollWidth: pane.scrollWidth,
      headerWidth: header.clientWidth,
      headerScrollWidth: header.scrollWidth,
      versionsWidth: versions.clientWidth,
      versionsScrollWidth: versions.scrollWidth,
      bodyWidth: body.clientWidth,
      bodyScrollWidth: body.scrollWidth,
      frameWidth: frame.getBoundingClientRect().width,
    };
  })()`);
  assert.equal(mobileViewer.width, 390, JSON.stringify(mobileViewer));
  assert.ok(mobileViewer.paneScrollWidth <= mobileViewer.paneWidth + 1, JSON.stringify(mobileViewer));
  assert.ok(mobileViewer.headerScrollWidth <= mobileViewer.headerWidth + 1, JSON.stringify(mobileViewer));
  assert.ok(mobileViewer.versionsScrollWidth <= mobileViewer.versionsWidth + 1, JSON.stringify(mobileViewer));
  assert.ok(mobileViewer.bodyScrollWidth <= mobileViewer.bodyWidth + 1, JSON.stringify(mobileViewer));
  assert.ok(mobileViewer.frameWidth > 0, JSON.stringify(mobileViewer));
  await evaluate(`document.getElementById('visual-back').click()`);
  await until('the mobile visual index', () => evaluate(`!document.getElementById('visuals-index').hidden`));
  const mobileIndex = await evaluate(`(() => {
    const pane = document.getElementById('visuals');
    const index = document.getElementById('visuals-index');
    return { width: innerWidth, paneWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth,
      indexWidth: index.clientWidth, indexScrollWidth: index.scrollWidth };
  })()`);
  assert.equal(mobileIndex.width, 390, JSON.stringify(mobileIndex));
  assert.ok(mobileIndex.paneScrollWidth <= mobileIndex.paneWidth + 1, JSON.stringify(mobileIndex));
  assert.ok(mobileIndex.indexScrollWidth <= mobileIndex.indexWidth + 1, JSON.stringify(mobileIndex));
  await evaluate(`location.hash = '#visuals/${visual.id}/v1'`);
  await until('the mobile visual viewer again', () => evaluate(`!document.getElementById('visual-viewer').hidden`));
  await viewport(1500, 1000);
  await evaluate(`document.querySelector('#reader-font-size-options [data-font-size="${initial}"]').click()`);
  await redrawn(before.size);

  // A click on a link inside the frame only asks the dashboard, which shows the address.
  await inFrame(`document.querySelector('#document a[href^="https://sqlite"]').click()`);
  await until('the address of the link in the dashboard', () =>
    evaluate(`!document.getElementById('visual-link').hidden`),
  );
  await shot('6-link');
  assert.equal(
    await evaluate(`document.getElementById('visual-link-url').textContent`),
    'https://sqlite.org/docs.html',
  );
  // The frame cannot navigate itself away from Mu.
  await inFrame(`location.href = ${JSON.stringify(`${elsewhere}/navigation`)}`);
  await until('the browser to refuse the navigation', () =>
    logs.some((line) => line.includes(`Framing '${elsewhere}/' violates`) && line.includes("frame-src 'self'")),
  );
  await shot('7-after-self-navigation');

  await evaluate(`document.querySelector('.rail-link[data-view="workspace"]').click()`);
  const chips = `[...document.querySelectorAll('.visual-chip')].map((c) => c.textContent).join(' | ')`;
  await until('the visual on its task', async () => (await evaluate(chips)) === 'Storage migration planv2');
  await shot('8-workspace');

  // Nothing left Mu: the other server was never asked, and every request to an address that is not Mu's is one
  // that the browser refused under a content security policy.
  assert.deepEqual(reached, []);
  const foreign = [...requests].filter(
    ([, address]) => !/^(data|blob|about):/.test(address) && !address.startsWith(`${url}/`),
  );
  assert.deepEqual(
    foreign.filter(([id]) => refused.get(id) !== 'csp'),
    [],
  );
  // The addresses in the diagram's label got past the diagram library's sanitizer, as far as the browser's loader:
  // the policy is what stopped them. If the library starts to drop them, give this check content that it keeps.
  for (const path of ['/label.png', '/label-style.png'])
    assert.ok(
      foreign.some(([, address]) => address === `${elsewhere}${path}`),
      `${path} was not asked for`,
    );
  // The only complaints of the browser are the ones this check provoked.
  const unexpected = logs.filter(
    (line) =>
      !/violates the following Content Security Policy|Refused to connect|Unsafe attempt to initiate navigation/.test(
        line,
      ),
  );
  assert.deepEqual(unexpected, []);
});

test('the user comments on selected text, a diagram and code, and the author answers', async (t) => {
  const { app, user, worker, visual, reached, evaluate, inFrame, shot, drawn } = await opened(t, 'comments-');
  // The turn that wrote the visual has ended; version 1 stays as it is.
  app.runner.active.clear();
  const highlights = `Object.fromEntries(['draft', 'sent', 'answered', 'active'].map((state) => [state, CSS.highlights.get('comment-' + state).size]))`;
  const cards = `[...document.querySelectorAll('#visual-comments-list .visual-comment')].map((card) => [card.querySelector('.visual-comment-where').textContent, card.querySelector('.visual-comment-state').textContent, card.querySelector('.visual-comment-quote')?.textContent ?? null, card.querySelector('.visual-comment-text').textContent])`;
  const scopes = `[...document.querySelectorAll('.visual-scope')].map((option) => option.textContent + (option.getAttribute('aria-pressed') === 'true' ? '*' : ''))`;
  const write = (text) =>
    evaluate(`(() => {
      const field = document.getElementById('visual-composer-text');
      field.focus();
      field.value = ${JSON.stringify(text)};
      field.dispatchEvent(new Event('input'));
    })()`);
  const bubble = `!document.getElementById('visual-comment-bubble').hidden`;
  // A click on a button, which takes the focus from the comment field as a pointer does.
  const press = (id) =>
    evaluate(`(() => { const button = document.getElementById('${id}'); button.focus(); button.click(); })()`);

  // Text selected across two elements of a paragraph.
  await inFrame(`(() => {
    const paragraph = document.querySelector('#section-intro p');
    const range = document.createRange();
    range.setStart(paragraph.querySelector('strong').firstChild, 0);
    range.setEnd(paragraph.querySelector('strong').nextSibling, 11);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  })()`);
  await until('the offer to comment on the selection', () => evaluate(bubble));
  await shot('1-selected');
  assert.deepEqual(await evaluate(scopes), ['Selected text*', 'Section “Introduction”', 'Whole visual']);
  assert.equal(
    await evaluate(`document.getElementById('visual-composer-quote').textContent`),
    'session store from files',
  );
  await evaluate(`document.getElementById('visual-comment-bubble').click()`);
  await write('Which files? Name them.');
  await until('the mark of the comment that is written', async () => (await inFrame(highlights)).active === 1);
  await shot('2-writing');
  await press('visual-composer-draft');
  await until('the draft', async () => (await evaluate(cards)).length === 1);
  assert.deepEqual(await evaluate(cards), [
    ['Introduction', 'Draft', 'session store from files', 'Which files? Name them.'],
  ]);

  // A click on a diagram offers a comment on it.
  await inFrame(`getSelection().removeAllRanges()`);
  await inFrame(
    `document.querySelector('#section-flow .visual-mermaid svg .node').dispatchEvent(new MouseEvent('click', { bubbles: true }))`,
  );
  await until('the offer to comment on the diagram', async () => (await evaluate(scopes))[0] === 'Block 1*');
  await evaluate(`document.getElementById('visual-comment-bubble').click()`);
  await write('Show the cache in this diagram.');
  await press('visual-composer-draft');
  await until('the second draft', async () => (await evaluate(cards)).length === 2);

  // Text inside highlighted code, where every token is an element of its own.
  await inFrame(`(() => {
    const code = document.querySelector('#section-steps code.hljs');
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    const start = texts.find((node) => node.data.includes('JSON'));
    const end = texts.find((node) => node.data.includes('body'));
    const range = document.createRange();
    range.setStart(start, start.data.indexOf('JSON'));
    range.setEnd(end, end.data.indexOf('body') + 4);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  })()`);
  await until('the offer to comment on the code', async () =>
    (await evaluate(`document.getElementById('visual-composer-quote').textContent`)).startsWith('JSON.stringify'),
  );
  await evaluate(`document.getElementById('visual-comment-bubble').click()`);
  await write('Why not hash the body alone?');
  await press('visual-composer-draft');
  await until('the third draft', async () => (await evaluate(cards)).length === 3);
  await inFrame(`getSelection().removeAllRanges()`);
  await until('the marks of three drafts', async () => {
    const marks = await inFrame(`({ ...${highlights}, blocks: document.querySelectorAll('.commented').length })`);
    // The comment saved last is the one in view, and marked as such.
    return marks.draft + marks.active === 2 && marks.blocks === 1;
  });
  await shot('3-drafts');
  assert.deepEqual(
    (await evaluate(cards)).map(([where, state, quote]) => [where, state, quote]),
    [
      ['Introduction', 'Draft', 'session store from files'],
      ['Flow, block 1', 'Draft', null],
      ['Steps', 'Draft', 'JSON.stringify([section.id, section.title, section.body'],
    ],
  );
  // A click on marked text names its comment in the list.
  await inFrame(`(() => {
    const mark = [...CSS.highlights.get('comment-draft')][0].getClientRects()[0];
    document.getElementById('document').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: mark.left + 2, clientY: mark.top + 2 }));
  })()`);
  await until('the comment of the clicked text', () =>
    evaluate(`Boolean(document.querySelector('#visual-comments-list .visual-comment[aria-current="true"]'))`),
  );

  await press('visual-comments-send-all');
  await until('the sent comments', async () => (await evaluate(cards)).every(([, state]) => state === 'Sent'));
  await until('the marks of sent comments', async () => {
    const marks = await inFrame(highlights);
    return marks.sent + marks.active === 2 && marks.draft === 0;
  });
  await shot('4-sent');
  const messages = (await user('GET', '/api/conversations/work/messages?limit=20')).body.messages;
  const message = messages.find((item) => item.from === 'user');
  const comments = (await worker('GET', `/api/visuals/${visual.id}/comments`)).body;
  assert.equal(comments.length, 3);
  assert.equal(
    message.text,
    [
      `@worker 3 comments on visual \`${visual.id}\` \`Storage migration plan\`, version 1:`,
      `1. \`${comments[0].id}\` on section \`intro\`, at \`session store from files\`:\n> Which files? Name them.`,
      `2. \`${comments[1].id}\` on section \`flow\`, block 1 (mermaid):\n> Show the cache in this diagram.`,
      `3. \`${comments[2].id}\` on section \`steps\`, at \`JSON.stringify([section.id, section.title, section.body\`:\n> Why not hash the body alone?`,
      `Change the sections these concern with \`visual patch --id ${visual.id}\`, and name the comments a change answers with \`--resolves\`. \`visual comments --id ${visual.id}\` shows each comment with its whole quote.`,
    ].join('\n\n'),
  );

  // The author answers two of them in its next turn. The dashboard follows to version 2 and names what it answers.
  app.runner.active.set('worker', { conversationId: 'work' });
  const answer = await worker('PATCH', `/api/visuals/${visual.id}`, {
    source:
      '# Storage migration plan\n\nThis plan moves the **session store** from the files `sessions/*.json` to SQLite.\n\n## Flow {#flow}\n\n```mermaid\nflowchart LR\n  A[Agent] --> B(Mu service) --> C[(SQLite)]\n  B --> K[[Cache]]\n```\n',
    resolves: [comments[0].id, comments[1].id],
  });
  assert.deepEqual(answer.body.resolved, [comments[0].id, comments[1].id]);
  await until(
    'version 2 with its answers',
    async () =>
      (await evaluate(`document.getElementById('visual-version-label').textContent`)) === 'Version 2 of 2' &&
      (await evaluate(`document.querySelectorAll('#visual-answers-list .visual-comment').length`)) === 2,
  );
  await until('the new diagram', () =>
    inFrame(`${drawn} && document.querySelector('#section-flow').textContent.includes('Cache')`),
  );
  await shot('5-answered');
  assert.deepEqual(await evaluate(cards), [], 'a new version starts without comments');
  assert.equal(
    await evaluate(`document.getElementById('visual-comments-note').textContent`),
    'Comments on other versions:v1 (3)',
  );
  // Version 1 keeps its comments, each with its state and its mark.
  await evaluate(`document.querySelector('#visual-answers-list .visual-comment button').click()`);
  await until('version 1 with its comments', async () => (await evaluate(cards)).length === 3);
  assert.deepEqual(
    (await evaluate(cards)).map(([where, state]) => [where, state]),
    [
      ['Introduction', 'Answered'],
      ['Flow, block 1', 'Answered'],
      ['Steps', 'Sent'],
    ],
  );
  await until('the marks of version 1', async () => {
    const marks = await inFrame(`({ ...${highlights}, blocks: document.querySelectorAll('.commented').length })`);
    return marks.answered === 1 && marks.sent === 1 && marks.blocks === 1;
  });
  await shot('6-version-1');
  assert.deepEqual(reached, []);
});

test('the user answers the questions of a visual, reviews the answers beside the frame and sends them', async (t) => {
  const { app, user, worker, visual, elsewhere, reached, evaluate, inFrame, shot, viewport, mouse } = await opened(
    t,
    'forms-',
  );
  // The author asks in its next turn; the labels are its text, and try what a label can.
  const form = {
    fields: [
      {
        id: 'database',
        type: 'choice',
        label: `Which database? <img src=${elsewhere}/form.png onerror=window.pwned=3>`,
        help: 'One store for all sessions.',
        options: [
          { id: 'sqlite', label: 'SQLite', hint: 'One file' },
          { id: 'postgres', label: '<b onmouseover=window.pwned=4>PostgreSQL</b>' },
        ],
        default: 'sqlite',
      },
      { id: 'notes', type: 'text', label: 'Anything I should know?', multiline: true },
      { id: 'dry-run', type: 'toggle', label: 'Start with a dry run?' },
    ],
  };
  app.runner.active.set('worker', { conversationId: 'work' });
  const asked = await worker('PATCH', `/api/visuals/${visual.id}`, {
    source: `## Decide {#decide}\n\nThree questions before I start.\n\n\`\`\`form\n${JSON.stringify(form)}\n\`\`\`\n`,
  });
  assert.equal(asked.body.version, 2, JSON.stringify(asked.body));
  app.runner.active.clear();

  const rows = `[...document.querySelectorAll('#visual-questions-list .visual-question')].map((row) => [row.querySelector('.visual-question-label').textContent, row.querySelector('.visual-question-state').textContent, row.querySelector('.visual-question-value').textContent])`;
  const states = `[...document.querySelectorAll('.form-field')].map((field) => [field.dataset.field, field.dataset.state])`;
  const control = (field, selector) => `document.querySelector('.form-field[data-field="${field}"] ${selector}')`;
  await until('the questions beside the frame', async () => (await evaluate(rows)).length === 3);
  // The controls take no answer until the dashboard has said that this version can be answered.
  await until('controls that can be used', () => inFrame(`${control('database', 'input')}?.disabled === false`));
  await shot('1-asked');
  assert.deepEqual(await evaluate(rows), [
    [form.fields[0].label, 'Suggested', 'SQLite'],
    ['Anything I should know?', 'No answer', '—'],
    ['Start with a dry run?', 'No answer', '—'],
  ]);
  assert.equal(await evaluate(`document.getElementById('visual-questions-count').textContent`), '1 of 3');
  assert.deepEqual(await inFrame(states), [
    ['database', 'suggested'],
    ['notes', 'open'],
    ['dry-run', 'open'],
  ]);
  assert.equal(await inFrame(`${control('database', 'input[value="sqlite"]')}.checked`), true);
  assert.equal(await inFrame(`document.querySelector('.visual-form img, .visual-form b')`), null);

  // An answer in the frame is stored by the dashboard, which shows it for review outside the frame.
  await inFrame(`${control('database', 'input[value="postgres"]')}.click()`);
  await until('the choice in the review', async () => (await evaluate(rows))[0][1] === 'Not sent');
  await inFrame(`(() => {
    const notes = ${control('notes', 'textarea')};
    notes.focus();
    notes.value = 'Keep the old files.';
    notes.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until('the typed answer in the review', async () => (await evaluate(rows))[1][2] === 'Keep the old files.');
  // The frame is not trusted: an answer that no control of the question can give is dropped, and no message of the
  // frame sends anything.
  await inFrame(`(() => {
    for (const message of [
      { type: 'answer', field: 'database', value: 'mysql' },
      { type: 'answer', field: 'dry-run', value: 'yes' },
      { type: 'answer', field: 'unknown', value: true },
      { type: 'feedback', version: 2 },
      { type: 'send' },
    ])
      window.parent.postMessage(message, '*');
  })()`);
  await inFrame(`${control('dry-run', 'input[value="no"]')}.click()`);
  await until('the last answer in the review', async () => (await evaluate(rows))[2][1] === 'Not sent');
  assert.deepEqual(await evaluate(rows), [
    [form.fields[0].label, 'Not sent', '<b onmouseover=window.pwned=4>PostgreSQL</b>'],
    ['Anything I should know?', 'Not sent', 'Keep the old files.'],
    ['Start with a dry run?', 'Not sent', 'No'],
  ]);
  const chat = async () =>
    (await user('GET', '/api/conversations/work/messages?limit=20')).body.messages.filter(
      (message) => message.from === 'user',
    );
  assert.deepEqual(await chat(), []);
  assert.deepEqual((await worker('GET', `/api/visuals/${visual.id}/answers`)).body.answers, {});
  assert.equal(
    await evaluate(`document.getElementById('visual-questions-bar-text').textContent`),
    '3 answers not sent',
  );
  await shot('2-answered');

  // On a narrow screen the questions and the bar stay inside the page.
  await viewport(390, 844);
  const narrow = await evaluate(`(() => {
    const pane = document.getElementById('visuals');
    const bar = document.getElementById('visual-questions-bar').getBoundingClientRect();
    return { width: innerWidth, paneWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth, barLeft: bar.left, barRight: bar.right };
  })()`);
  assert.ok(narrow.paneScrollWidth <= narrow.paneWidth + 1, JSON.stringify(narrow));
  assert.ok(narrow.barLeft >= 0 && narrow.barRight <= narrow.width + 1, JSON.stringify(narrow));
  // A label without a space to break at, like the address in this one, wraps inside its question.
  const question = await inFrame(`(() => {
    const field = ${control('database', '.form-label')};
    return { width: field.clientWidth, scrollWidth: field.scrollWidth, page: document.documentElement.scrollWidth, view: innerWidth };
  })()`);
  assert.ok(question.scrollWidth <= question.width + 1 && question.page <= question.view + 1, JSON.stringify(question));
  await shot('3-narrow');
  await viewport(1500, 1000);

  // Script in the frame cannot see the pointer over the dashboard, but its window loses the focus when the user
  // presses the Send button, and it can report another answer at that moment. Here the press is a real one, the
  // user has read the list for longer than the list asks for, and the report comes while the button is down.
  await sleep(1600);
  const sendAt = await evaluate(`(() => {
    const send = document.getElementById('visual-questions-send');
    send.scrollIntoView({ block: 'center' });
    const { left, top, width, height } = send.getBoundingClientRect();
    return { x: left + width / 2, y: top + height / 2 };
  })()`);
  await mouse('mousePressed', sendAt);
  await inFrame(
    `window.parent.postMessage({ type: 'answer', field: 'notes', value: 'Also delete the backups.' }, '*')`,
  );
  await until(
    'the changed answer under the pointer',
    async () => (await evaluate(rows))[1][2] === 'Also delete the backups.',
  );
  await mouse('mouseReleased', sendAt);
  await until('the refusal', () => evaluate(`!document.getElementById('visual-questions-error').hidden`));
  assert.equal(
    await evaluate(`document.getElementById('visual-questions-error').textContent`),
    'One line of this list changed just before you pressed Send, so nothing was sent. Read what is marked, then send again.',
  );
  assert.deepEqual(
    await evaluate(
      `[...document.querySelectorAll('#visual-questions-list .visual-question.unread')].map((row) => [row.querySelector('.visual-question-label').textContent, row.querySelector('.visual-question-state').textContent])`,
    ),
    [['Anything I should know?', 'Changed just now']],
  );
  assert.deepEqual(await chat(), []);
  assert.deepEqual((await worker('GET', `/api/visuals/${visual.id}/answers`)).body.answers, {});
  await shot('4-held');
  // The user writes the answer again, reads the list and sends it.
  await inFrame(`(() => {
    const notes = ${control('notes', 'textarea')};
    notes.value = 'Keep the old files.';
    notes.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await until(
    'the answer of the user in the review',
    async () => (await evaluate(rows))[1][2] === 'Keep the old files.',
  );
  await sleep(1600);

  // Only the user's click in the dashboard sends, and it sends what the review shows.
  await evaluate(`document.getElementById('visual-questions-send').click()`);
  await until('the sent answers', async () => (await evaluate(rows)).every(([, state]) => state === 'Sent'));
  await until('the sent state in the frame', async () =>
    (await inFrame(states)).every(([, state]) => state === 'sent'),
  );
  await shot('5-sent');
  const [message, ...more] = await chat();
  assert.deepEqual(more, []);
  assert.equal(
    message.text,
    [
      `@worker Answers on visual \`${visual.id}\` \`Storage migration plan\`, version 2:`,
      [
        'Answers:',
        '- `database` `Which database? <img src=http://127.0.0.1:' +
          `${new URL(elsewhere).port}/form.png onerror=window.pwned=3>\`: \`postgres\` \`<b onmouseover=window.pwned=4>PostgreSQL</b>\``,
        '- `notes` `Anything I should know?`:\n> Keep the old files.',
        '- `dry-run` `Start with a dry run?`: no',
      ].join('\n'),
      `Read the answers with \`visual answers --id ${visual.id}\`.`,
    ].join('\n\n'),
  );
  assert.deepEqual((await worker('GET', `/api/visuals/${visual.id}/answers`)).body.answers, {
    database: 'postgres',
    notes: 'Keep the old files.',
    'dry-run': false,
  });
  assert.equal(await evaluate(`document.getElementById('visual-questions-send').hidden`), true);
  assert.equal(await inFrame(`window.pwned ?? null`), null);
  assert.equal(await evaluate(`window.pwned ?? null`), null);
  assert.deepEqual(reached, []);
});

test('what the author works on is lit until its turn writes a version or ends, and the versions have icon buttons', async (t) => {
  const {
    app,
    user,
    worker,
    visual,
    reached,
    logs,
    evaluate,
    inFrame,
    shot,
    drawn,
    viewport,
    keyboard,
    reducedMotion,
  } = await opened(t, 'sheen-');
  app.runner.active.clear();
  const path = `/api/visuals/${visual.id}`;
  const rev = Object.fromEntries(
    (await user('GET', path)).body.shown.sections.map((section) => [section.id, section.rev]),
  );
  const draft = async (input) => {
    const made = await user('POST', `${path}/comments`, { version: 1, ...input });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    return made.body.id;
  };
  const QUOTE = 'session store from files to SQLite. Read the SQLite docs';
  const onText = await draft({
    sectionId: 'intro',
    sectionRev: rev.intro,
    block: 0,
    quote: { text: QUOTE, prefix: 'moves the ', suffix: ' or jump' },
    text: 'Which files? Name them.',
  });
  const onDiagram = await draft({ sectionId: 'flow', sectionRev: rev.flow, block: 0, text: 'Show the cache.' });
  const onSection = await draft({ sectionId: 'steps', sectionRev: rev.steps, text: 'Add a rollback step.' });
  const onAll = await draft({ text: 'Shorter, please.' });
  const send = async (ids) => (await user('POST', `${path}/comments/send`, { version: 1, ids })).body.messageId;
  const first = await send([onText, onDiagram, onSection]);
  const second = await send([onAll]);
  // What the runner does when a turn of the author starts on these messages, and when it ends.
  const turn = (messageIds) => {
    app.runner.active.set('worker', { conversationId: 'work', messageIds });
    app.store.updateAgent('worker', { status: 'working', activeMessageId: messageIds.at(-1) });
  };
  const turnEnds = (status) => {
    app.runner.active.clear();
    app.store.updateAgent('worker', { status, activeMessageId: null });
  };

  const lights = `[...document.querySelectorAll('.working-layer > .working-sheen')].map((light) => {
    const box = light.getBoundingClientRect();
    const band = getComputedStyle(light, '::after');
    return {
      id: light.dataset.comment,
      kind: light.className.replace('working-sheen ', ''),
      box: [box.left, box.top, box.width, box.height].map(Math.round),
      lines: (light.style.clipPath.match(/M/g) ?? []).length,
      animation: band.animationName,
      band: band.display === 'none' ? null : band.transform,
      tint: Number(getComputedStyle(light, '::before').opacity),
    };
  })`;
  const kinds = async () => Object.fromEntries((await inFrame(lights)).map((light) => [light.id, light.kind]));
  const places = `(() => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
    };
    return {
      strong: box(document.querySelector('#section-intro strong')),
      paragraph: box(document.querySelector('#section-intro [data-block="0"]')),
      block: box(document.querySelector('#section-flow > [data-block="0"]')),
      section: box(document.getElementById('section-steps')),
      whole: box(document.getElementById('document')),
    };
  })()`;
  const states = `Object.fromEntries([...document.querySelectorAll('#visual-comments-list .visual-comment')].map((card) => [card.dataset.comment, card.querySelector('.visual-comment-state').textContent]))`;
  const within = ([left, top, width, height], [outerLeft, outerTop, outerWidth, outerHeight]) =>
    left >= outerLeft - 1 &&
    top >= outerTop - 1 &&
    left + width <= outerLeft + outerWidth + 1 &&
    top + height <= outerTop + outerHeight + 1;

  // Sent, and the author does nothing: no light.
  await until('the sent comments', async () => Object.keys(await evaluate(states)).length === 4);
  assert.deepEqual(await inFrame(lights), []);
  await shot('1-sent');

  // The author's turn starts on the first message.
  turn([first]);
  await until('the lights of the first message', async () => (await inFrame(lights)).length === 3);
  assert.deepEqual(await kinds(), { [onText]: 'text', [onDiagram]: 'block', [onSection]: 'section' });
  assert.deepEqual(await evaluate(states), {
    [onText]: 'In work',
    [onDiagram]: 'In work',
    [onSection]: 'In work',
    [onAll]: 'Sent',
  });
  let placed = await inFrame(places);
  let lit = Object.fromEntries((await inFrame(lights)).map((light) => [light.id, light]));
  // A block and a section are covered exactly; the text is covered by its lines only, not by its paragraph.
  assert.deepEqual(lit[onDiagram].box, placed.block);
  assert.deepEqual(lit[onSection].box, placed.section);
  assert.ok(within(placed.strong, lit[onText].box), JSON.stringify([placed.strong, lit[onText].box]));
  assert.ok(lit[onText].box[2] < placed.paragraph[2], 'the light is as wide as the quote, not as its paragraph');
  assert.ok(lit[onText].lines >= 3, 'the quote runs through three elements, each with a box of its own');
  for (const light of Object.values(lit)) assert.equal(light.animation, 'working-sweep');
  // The light moves.
  const seen = new Set();
  await until('the band to move', async () => {
    seen.add((await inFrame(lights))[0].band);
    return seen.size > 2;
  });
  // It takes no click and no selection from what it lies on.
  assert.equal(
    await inFrame(`(() => {
      document.getElementById('section-steps').scrollIntoView();
      const box = document.querySelector('.working-sheen.section').getBoundingClientRect();
      const under = document.elementFromPoint(box.left + box.width / 2, box.top + 20);
      window.scrollTo(0, 0);
      return under.closest('.working-layer') ? 'the light' : under.closest('.visual-section')?.id;
    })()`),
    'section-steps',
  );
  for (const frame of ['a', 'b', 'c', 'd']) await shot(`2-turn-${frame}`);

  // A narrower window breaks the lines anew: every light follows its target.
  await viewport(980, 1000);
  await until('the lights at their new places', async () => {
    placed = await inFrame(places);
    lit = Object.fromEntries((await inFrame(lights)).map((light) => [light.id, light]));
    return (
      JSON.stringify(lit[onSection].box) === JSON.stringify(placed.section) &&
      JSON.stringify(lit[onDiagram].box) === JSON.stringify(placed.block) &&
      within(placed.strong, lit[onText].box)
    );
  });
  await shot('3-narrow');
  await viewport(1500, 1000);

  // The turn ends without a patch, here by an error: nothing stays lit.
  turnEnds('error');
  await until('no light after the turn', async () => (await inFrame(lights)).length === 0);
  assert.deepEqual(Object.values(await evaluate(states)), ['Sent', 'Sent', 'Sent', 'Sent']);
  await shot('4-ended');

  // The next turn holds both messages: four comments in flight, one of them on the whole visual.
  turn([first, second]);
  await until('the lights of both messages', async () => (await inFrame(lights)).length === 4);
  assert.deepEqual(await kinds(), {
    [onText]: 'text',
    [onDiagram]: 'block',
    [onSection]: 'section',
    [onAll]: 'whole',
  });
  placed = await inFrame(places);
  // The light on the whole visual covers the document, as wide as the light on a section.
  const whole = (await inFrame(lights)).find((light) => light.id === onAll).box;
  assert.ok(within(placed.whole, whole) && within(placed.section, whole), JSON.stringify([placed, whole]));
  assert.deepEqual([whole[0], whole[2]], [placed.section[0], placed.section[2]]);
  assert.deepEqual([whole[1], whole[3]], [placed.whole[1], placed.whole[3]]);
  await shot('5-all');

  // A user who asked for less motion gets a tint that stands still, a little stronger than under the light.
  const moving = (await inFrame(lights)).map((light) => light.tint);
  await reducedMotion(true);
  await until('the still tint', async () => (await inFrame(lights)).every((light) => light.band === null));
  const still = await inFrame(lights);
  assert.equal(still.length, 4);
  still.forEach((light, index) => assert.ok(light.tint > moving[index], JSON.stringify([light, moving[index]])));
  assert.equal(
    await inFrame(`document.querySelector('.working-sheen').getAnimations({ subtree: true }).length`),
    0,
    'nothing moves',
  );
  await shot('6-reduced-motion');
  await reducedMotion(false);
  await until('the light again', async () => (await inFrame(lights)).every((light) => light.band !== null));

  // The turn writes its version: the lights go, and the change is marked in place by the flash.
  const patched = await worker('PATCH', path, {
    source: '## Steps {#steps}\n\n1. Copy the files.\n2. Switch the reads.\n3. Roll back with `mu restore`.\n',
    resolves: [onSection],
  });
  assert.equal(patched.body.version, 2);
  await until(
    'version 2',
    async () => (await evaluate(`document.getElementById('visual-version-label').textContent`)) === 'Version 2 of 2',
  );
  await until('the changed section', () =>
    inFrame(`${drawn} && document.querySelector('#section-steps').textContent.includes('mu restore')`),
  );
  assert.deepEqual(await inFrame(lights), []);
  assert.equal(await inFrame(`document.querySelector('#section-steps').classList.contains('flash')`), true);
  await shot('7-version');
  turnEnds('idle');

  // The steps through the versions: icon buttons with a name, a tooltip and a state that shows.
  const steps = `['previous', 'next'].map((step) => {
    const button = document.getElementById('visual-version-' + step);
    const style = getComputedStyle(button);
    const box = button.getBoundingClientRect();
    const icon = button.querySelector('svg').getBoundingClientRect();
    return {
      name: button.getAttribute('aria-label'),
      tip: button.title,
      disabled: button.disabled,
      size: [box.width, box.height, icon.width, icon.height].map(Math.round),
      edge: style.borderTopStyle,
      cursor: style.cursor,
      opacity: Number(style.opacity),
    };
  })`;
  const [previous, next] = await evaluate(steps);
  assert.deepEqual(
    [previous, next].map((step) => [step.name, step.tip, step.disabled]),
    [
      ['Previous version', 'Previous version', false],
      ['Next version', 'Next version', true],
    ],
  );
  // Each is a square large enough to hit, with its icon drawn.
  for (const { size } of [previous, next]) {
    assert.deepEqual([size[0], size[2]], [size[1], size[3]], JSON.stringify(size));
    assert.ok(size[0] >= 32 && size[2] >= 16, JSON.stringify(size));
  }
  // The step that leads nowhere shows it: another edge, fainter, and a pointer that says no.
  assert.notEqual(next.edge, previous.edge);
  assert.ok(next.opacity < previous.opacity);
  assert.deepEqual([previous.cursor, next.cursor], ['pointer', 'not-allowed']);
  await shot('8-newest');
  // By keyboard: Enter on the focused step goes back, and Tab leads on to the other step.
  const label = `document.getElementById('visual-version-label').textContent`;
  await evaluate(`document.getElementById('visual-version-previous').focus()`);
  await keyboard('Enter');
  await until('version 1', async () => (await evaluate(label)) === 'Version 1 of 2');
  assert.deepEqual(
    (await evaluate(steps)).map((step) => step.disabled),
    [true, false],
  );
  await keyboard('Tab');
  assert.equal(await evaluate(`document.activeElement.id`), 'visual-version-next');
  assert.equal(await evaluate(`document.activeElement.matches(':focus-visible')`), true);
  assert.notEqual(await evaluate(`getComputedStyle(document.activeElement).outlineStyle`), 'none');
  await shot('9-first');
  await keyboard(' ');
  await until('version 2 again', async () => (await evaluate(label)) === 'Version 2 of 2');

  assert.deepEqual(reached, []);
  assert.deepEqual(
    logs.filter((line) => !line.includes('violates the following Content Security Policy')),
    [],
  );
  // The lights are placed through the style of their elements, which the frame's policy lets a script of Mu do.
  assert.deepEqual(
    logs.filter((line) => /sheen|style-src/.test(line)),
    [],
  );
});
