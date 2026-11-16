import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp, ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';

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

/**
 * A service with a lead, a worker in the room `work` with a task, and an agent outside that room. `startTurn` records
 * a managed turn as the runner does; the chat keeps messages without a broker.
 */
export async function team(t) {
  /** @type {FakeChat} */
  let chat;
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'visuals'),
    chatFactory: (options) => (chat = new FakeChat(options)),
    pricing: offlinePricing(),
    platform: 'darwin',
  });
  await app.start();
  // The turns that startTurn records are not processes, so they are dropped before the service waits for its turns.
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
  const turn = (id) => as({ 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue(id)}` });
  const created = async (path, body) => assert.equal((await user('POST', path, body)).status, 201);
  await created('/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  await created('/api/conversations', { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [] });
  for (const [id, conversationId] of [
    ['worker', 'work'],
    ['outsider', 'common'],
  ])
    await created('/api/agents', {
      id,
      role: 'worker',
      adapter: 'claude',
      cwd: ROOT,
      task: '',
      conversationId,
      from: 'lead',
    });
  for (const id of ['worker', 'outsider']) app.store.updateAgent(id, { status: 'stopped' });
  const task = (
    await user('POST', '/api/tasks', { title: 'Plan', conversationId: 'work', agentIds: ['worker'], from: 'lead' })
  ).body;
  // A managed turn as the runner records it; each object is one turn.
  const startTurn = (id, conversationId = 'work') => app.runner.active.set(id, { conversationId });
  return {
    app,
    url,
    chat,
    user,
    worker: turn('worker'),
    outsider: turn('outsider'),
    lead: turn('lead'),
    task,
    startTurn,
  };
}
