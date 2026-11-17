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
  async send(from, text, conversationId) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId);
  }
}

export async function cdp(port) {
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

// Starts a headless browser with a throwaway profile, and returns the connection to it.
export async function startBrowser(t) {
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
  return browser;
}
