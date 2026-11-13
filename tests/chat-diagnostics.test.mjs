import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import IRC from 'irc-framework';
import { Chat } from '../src/chat.mjs';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.options = { ping_timeout: 120 };
    this.user = {};
  }
  connect(options) {
    Object.assign(this.options, options);
    this.user.nick = options.nick;
    queueMicrotask(() => this.emit('registered'));
  }
  join(channel) {
    queueMicrotask(() => this.emit('join', { nick: this.user.nick, channel }));
  }
  quit() {
    queueMicrotask(() => this.emit('close'));
  }
}

async function fixture(t) {
  t.mock.method(IRC, 'Client', function () {
    return new FakeClient();
  });
  const chat = new Chat({ getConversations: () => [], onMessage: () => {} });
  t.after(async () => {
    chat.close();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await chat.start();
  return { chat, observer: chat.clients.get('mu-observer') };
}

test('socket failure and its timestamp survive the following generic close', async (t) => {
  const { chat, observer } = await fixture(t);
  observer.emit('socket error', new Error('read ECONNRESET'));
  const firstFailure = chat.state.lastDisconnect;
  observer.emit('close');
  assert.match(chat.state.error, /mu-observer.*ECONNRESET/);
  assert.equal(chat.state.connected, false);
  assert.equal(chat.state.lastDisconnect.nick, 'mu-observer');
  assert.equal(chat.state.lastDisconnect.kind, 'socket');
  assert.ok(Number.isFinite(Date.parse(chat.state.lastDisconnect.at)));
  assert.deepEqual(chat.state.lastDisconnect, firstFailure);
});

test('fatal IRC ERROR reason survives the following generic close', async (t) => {
  const { chat, observer } = await fixture(t);
  observer.emit('irc error', { error: 'irc', reason: 'Closing Link: Ping timeout: 2m30s' });
  observer.emit('close');
  assert.match(chat.state.error, /Closing Link: Ping timeout: 2m30s/);
  assert.equal(chat.state.lastDisconnect.kind, 'server');
});

test('client heartbeat timeout is distinguished from an unexplained socket close', async (t) => {
  const { chat, observer } = await fixture(t);
  observer.emit('ping timeout');
  observer.emit('close');
  assert.match(chat.state.error, /ping timeout.*120 seconds/i);
  assert.equal(chat.state.lastDisconnect.kind, 'ping-timeout');
  assert.equal(observer.options.auto_reconnect, false);
});

test('an earlier nonfatal channel error is not attributed to a later disconnect', async (t) => {
  const { chat, observer } = await fixture(t);
  observer.emit('irc error', { error: 'cannot_send_to_channel', reason: 'Cannot send to channel' });
  assert.equal(chat.state.connected, true);
  observer.emit('close');
  assert.doesNotMatch(chat.state.error, /Cannot send to channel/);
  assert.equal(chat.state.lastDisconnect.kind, 'closed');
});

test('late worker errors cannot replace the observer disconnect diagnostic', async (t) => {
  const { chat, observer } = await fixture(t);
  const worker = await chat.connect('worker');
  observer.emit('ping timeout');
  observer.emit('close');
  const observerFailure = chat.state.error;
  worker.emit('irc error', { error: 'irc', reason: 'Worker connection closed' });
  worker.emit('close');
  assert.equal(chat.state.error, observerFailure);
  assert.equal(chat.state.lastDisconnect.nick, 'mu-observer');
});

test('intentional shutdown is not overwritten by asynchronous close events', async (t) => {
  const { chat } = await fixture(t);
  chat.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chat.state.error, 'Mu is stopped');
  assert.equal(chat.state.lastDisconnect, undefined);
});
