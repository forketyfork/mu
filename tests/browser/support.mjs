// What the tests that drive Google Chrome share: waiting for the page, a chat that talks to nobody, a connection to the
// DevTools protocol and a browser process that is stopped with the test. CHROME names the browser binary.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { freePort } from '../isolation.mjs';

export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for what the page does on its own time: loading modules, drawing diagrams, receiving a change.
export async function until(what, probe, timeout = 20_000) {
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

export class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
  }
  async start() {}
  async connect() {}
  close() {}
  async syncConversation() {}
  async send(from, text, conversationId, meta = {}) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId, meta);
  }
}

// The browser's exit is reported by a separate event, which can come a moment after the connection broke.
async function whyGone(failure, fallback) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const gone = failure();
    if (gone) return gone;
    await sleep(100);
  }
  return fallback;
}

const ANSWER_LIMIT = 60_000;

// `failure` returns the error to throw once the browser is known to be gone; polling a port nobody listens on would
// end in a bare "fetch failed" after ten seconds, and a connection that breaks while opening would say nothing of why.
export async function cdp(port, failure = () => undefined) {
  let version;
  for (let attempt = 0; ; attempt += 1) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch (error) {
      const gone = failure();
      if (gone) throw gone;
      if (attempt > 100) throw error;
      await sleep(100);
    }
  }
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = () => {
      socket.onerror = socket.onclose = null;
      resolve(undefined);
    };
    socket.onerror = socket.onclose = (event) => {
      whyGone(failure, new Error(`The DevTools connection failed to open: ${event.type}`)).then(reject, reject);
    };
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
    // A page that the browser treats as hidden never answers input, screenshots or animation frames. Without a deadline,
    // the test then waits for its own time limit, which says nothing of the call that hung.
    send(method, params = {}, sessionId = undefined) {
      next += 1;
      const id = next;
      socket.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The browser did not answer ${method} within ${ANSWER_LIMIT / 1000} s`));
        }, ANSWER_LIMIT);
        pending.set(id, {
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
    on: (listener) => listeners.push(listener),
    close: () => socket.close(),
  };
}

const STDERR_TAIL = 600;

// A browser that exits before DevTools answers has crashed or been refused at launch. The usual refuser is the sandbox of
// an agent: Chrome needs system services at start (LaunchServices, the window server), a Codex agent's Seatbelt profile
// does not allow them, and Chrome aborts in _RegisterApplication. Asking Codex to run the command outside its sandbox
// does not lift this, because Mu's profile has deny entries and the command stays under Seatbelt. A skip would read as a
// pass, so the failure names the cause and what to do instead.
function earlyExit(chrome, { code, signal, stderr, elapsed }) {
  const how = signal ? `signal ${signal}` : `code ${code}`;
  const output = stderr.trim();
  return new Error(
    [
      `${chrome} exited (${how}) ${elapsed} ms after it started, before DevTools answered.`,
      "A sandbox that blocks the system services Chrome needs at launch, such as a Codex agent's, is a likely cause.",
      'Asking for escalation does not help: the command still runs under the sandbox. Run the browser check outside an',
      'agent sandbox: from a Claude worker or from your own shell (see docs/development.md).',
      output ? `Chrome's last output:\n${output.slice(-STDERR_TAIL)}` : "Chrome's output was empty.",
    ].join(' '),
  );
}

// Starts a headless browser with a throwaway profile, and returns the connection to it. `chrome` names the binary; `args` are further switches.
export async function startBrowser(t, { chrome: binary = CHROME, args = [] } = {}) {
  assert.ok(existsSync(binary), `No browser at ${binary}; set CHROME to the binary of Google Chrome or Chromium`);
  const debugPort = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'mu-chrome-'));
  const started = Date.now();
  const chrome = spawn(
    binary,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1500,1000',
      // The checks expect motion unless they emulate the wish for less; without this, a system set to reduce motion, as
      // GitHub's macOS runners are, makes the browser report it to every page. Emulation still overrides the switch.
      '--force-prefers-no-reduced-motion',
      // The checks drive a page that no one looks at, and a loaded runner makes the browser judge its window hidden or
      // covered; it then throttles timers and withholds input and frames from the page.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      ...args,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  chrome.stderr.setEncoding('utf8');
  chrome.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  /** @type {Error | undefined} */
  let failure;
  chrome.once('error', (error) => {
    failure = new Error(`${binary} did not start: ${error.message}`);
  });
  // Not 'close': that waits for every process that holds the stderr pipe, and Chrome's helpers can outlive it.
  chrome.once('exit', (code, signal) => {
    failure ??= earlyExit(binary, { code, signal, stderr, elapsed: Date.now() - started });
  });
  t.after(async () => {
    chrome.kill('SIGKILL');
    await sleep(300);
    await rm(profile, { recursive: true, force: true });
  });
  const browser = await cdp(debugPort, () => failure);
  t.after(() => browser.close());
  return browser;
}
