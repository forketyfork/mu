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

test('a visual renders in the sandboxed frame of a real browser', async (t) => {
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
  await browser.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
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
    await writeFile(join(SHOTS, `shot-${name}.png`), Buffer.from(data, 'base64'));
  };
  const frameSession = () => [...sessions].find(([, info]) => info.type === 'iframe')?.[0];

  await browser.send('Page.navigate', { url: `${url}/?token=${app.identity.token}#visuals` }, sessionId);
  await until('the list of visuals', () => evaluate(`Boolean(document.querySelector('.visual-card'))`));
  await shot('1-index');
  await evaluate(`document.querySelector('.visual-card').click()`);
  const frameId = await until('the sandboxed frame as a target of its own', frameSession);
  const inFrame = (expression) => evaluate(expression, frameId);
  const drawn = `document.querySelectorAll('.visual-section').length > 0 && !document.querySelector('.visual-rich.pending')`;
  await until('the diagrams and the code', () =>
    inFrame(`${drawn} && document.querySelectorAll('code.hljs').length === 2`),
  );
  await shot('2-viewer');
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
