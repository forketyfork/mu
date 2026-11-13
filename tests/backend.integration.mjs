import test from 'node:test';
import assert from 'node:assert/strict';
import IRC from 'irc-framework';
import { Chat } from '../src/chat.mjs';
import { Store } from '../src/store.mjs';
import { brokerSkip, startBroker } from './broker.mjs';

test(
  'real IRC transports long Unicode once, and Mu ignores what an ordinary IRC client posts',
  { skip: brokerSkip },
  async (t) => {
    const suffix = Date.now().toString(36),
      sender = `s-${suffix}`,
      worker = `w-${suffix}`,
      peer = `p-${suffix}`,
      channel = `#test-${suffix}`;
    const port = await startBroker(t);
    const store = new Store();
    store.createAgent({ id: worker, role: 'worker', adapter: 'manual', cwd: process.cwd(), task: '' });
    const chat = new Chat({
      port,
      channel,
      observerNick: `o-${suffix}`,
      onMessage: (...args) => store.addMessage(...args),
    });
    await chat.start();
    const client = new IRC.Client(),
      received = [];
    t.after(() => {
      client.quit('test complete');
      chat.close();
      store.close();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IRC peer join timeout')), 5000);
      client.on('registered', () => client.join(channel));
      client.on('join', (event) => {
        if (event.nick === peer) {
          clearTimeout(timer);
          resolve();
        }
      });
      client.on('socket error', reject);
      client.on('message', (event) => received.push(event));
      client.connect({ host: '127.0.0.1', port, nick: peer, tls: false, auto_reconnect: false });
    });
    const long = `@${worker}\n` + '日本語🙂 hello '.repeat(130);
    await chat.send(sender, long);
    assert.equal(store.inbox(worker).length, 1);
    assert.equal(store.inbox(worker)[0].text, long);
    const peerDeadline = Date.now() + 3000;
    while (received.length < 2 && Date.now() < peerDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(received.length > 1, 'ordinary IRC clients see readable fragments');
    assert.ok(received[0].message.startsWith(`@${worker}`));
    client.say(channel, `(@${worker}), native IRC follow-up`);
    const end = Date.now() + 3000;
    while (chat.state.lastRejected?.nick !== peer && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(chat.state.lastRejected?.nick, peer);
    assert.equal(store.inbox(worker).length, 1, 'a message Mu did not send is neither stored nor delivered');
  },
);
