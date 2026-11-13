import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp, ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';
import { fixture, initialState } from './ui-fixture.mjs';

class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
  }
  async start() {}
  async connect() {}
  async syncConversation() {}
  close() {}
  async send(from, text, conversationId) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId);
  }
}

async function until(check, describe) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out: ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// The dashboard runs in JSDOM, and its requests go to a real Mu service exactly as the browser sends them, so a request
// that the service cannot accept fails here instead of only in the user's browser.
test('the dashboard Stop button stops an errored agent with a pending message, and the message is not delivered', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'ui-stop'),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${port}`;
  app.store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  app.store.createAgent({ id: 'failed', role: 'worker', adapter: 'demo', cwd: ROOT, task: '' });
  app.store.updateAgent('failed', { status: 'error', lastError: 'codex exited 1: Transport channel closed' });
  const pending = app.store.addMessage('pending', 'user', '@failed follow-up', 'dm-failed');
  const state = await (
    await fetch(`${url}/api/state`, { headers: { Authorization: `Bearer ${app.identity.token}` } })
  ).json();
  const dashboard = await fixture(t, { initial: state });
  const pageError = () => dashboard.$('#page-error').textContent;
  dashboard.window.fetch = (path, options = {}) =>
    fetch(url + path, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${app.identity.token}`, Origin: url },
    });

  dashboard.click('[data-agent="failed"] [data-action="stop"]');
  await until(
    () => app.store.agent('failed').status === 'stopped' || pageError(),
    () => app.store.agent('failed').status,
  );
  assert.equal(pageError(), '');
  assert.equal(app.store.agent('failed').status, 'stopped');

  app.runner.kick();
  assert.equal(app.runner.active.has('failed'), false, 'a stopped agent runs no turn for its pending message');
  assert.deepEqual(
    app.store.inbox('failed').map((message) => message.id),
    [pending.id],
    'the message stays queued for an explicit resume',
  );
  assert.equal(app.store.messages(10, 'dm-failed').length, 1);
});

test('a failed Stop stays visible after the next state update', async (t) => {
  const initial = initialState();
  initial.agents.push({
    id: 'failed',
    role: 'worker',
    adapter: 'manual',
    status: 'error',
    task: 'Work',
    cwd: '/project',
    createdAt: initial.agents[0].createdAt,
  });
  const dashboard = await fixture(t, { initial });
  dashboard.window.fetch = async (path) =>
    path.endsWith('/stop')
      ? { ok: false, status: 409, json: async () => ({ error: 'Refused' }) }
      : { ok: true, json: async () => structuredClone(initial) };
  dashboard.click('[data-agent="failed"] [data-action="stop"]');
  await until(
    () => !dashboard.$('#page-error').hidden,
    () => 'no error shown',
  );
  dashboard.push(structuredClone(initial));
  assert.equal(dashboard.$('#page-error').hidden, false);
  assert.equal(dashboard.$('#page-error').textContent, 'Could not stop failed: Refused');
});
