import test from 'node:test';
import assert from 'node:assert/strict';
import IRC from 'irc-framework';
import { Store } from '../src/store.mjs';
import { Chat, MAX_MESSAGE_BYTES } from '../src/chat.mjs';
import { brokerSkip, startBroker } from './broker.mjs';

async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Timed out waiting for IRC event');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
test(
  'real private and task IRC channels isolate delivery, protect membership and preserve long results',
  { skip: brokerSkip },
  async (t) => {
    const port = await startBroker(t);
    const store = new Store();
    for (const id of ['lead', 'worker', 'reviewer'])
      store.createAgent({
        id,
        role: id === 'lead' ? 'lead' : 'worker',
        adapter: 'manual',
        cwd: process.cwd(),
        task: '',
      });
    store.createConversation({
      id: 'investigation',
      kind: 'room',
      name: 'Investigation',
      members: ['lead', 'worker'],
      createdBy: 'lead',
      sourceConversationId: 'dm-lead',
    });
    store.createConversation({
      id: 'review',
      kind: 'room',
      name: 'Review',
      members: ['lead', 'reviewer'],
      createdBy: 'lead',
      sourceConversationId: 'dm-lead',
    });
    const chat = new Chat({
      port,
      onMessage: (...args) => store.addMessage(...args),
      getConversation: (id) => store.conversation(id),
      getConversations: () => store.conversations(),
    });
    t.after(() => {
      chat.close();
      store.close();
    });
    await chat.start();
    const direct = await chat.send('user', 'Please coordinate this issue', 'dm-lead');
    assert.equal(direct.conversationId, 'dm-lead');
    assert.equal(store.inbox('lead').length, 1);
    assert.equal(store.inbox('worker').length, 0);
    const task = await chat.send('lead', '@all Investigate the issue', 'investigation');
    assert.equal(store.inbox('worker')[0].id, task.id);
    assert.equal(store.inbox('reviewer').length, 0);
    const long = '@lead Complete findings:\n' + '日本語🙂 detailed evidence\n'.repeat(150);
    assert.ok(long.length > 2718);
    await chat.send('worker', long, 'investigation');
    assert.equal(store.messages(300, 'investigation').at(-1).text, long);
    const maximum = '@lead\n' + '\n'.repeat(MAX_MESSAGE_BYTES - 6);
    await chat.send('worker', maximum, 'investigation');
    assert.equal(store.messages(300, 'investigation').at(-1).text, maximum);
    assert.equal(store.messages(300, 'common').length, 0);
    assert.equal(store.messages(300, 'review').length, 0);
    await assert.rejects(chat.send('reviewer', '@lead Not invited', 'investigation'), /not a member/);
    const outsider = new IRC.Client(),
      errors = [];
    t.after(() => outsider.quit('test complete'));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Outsider registration timeout')), 5000);
      outsider.on('registered', () => {
        clearTimeout(timer);
        resolve();
      });
      outsider.on('socket error', reject);
      outsider.on('irc error', (event) => errors.push(event));
      outsider.connect({ host: '127.0.0.1', port, nick: 'outsider', tls: false, auto_reconnect: false });
    });
    outsider.join(store.conversation('investigation').channel);
    await until(() => errors.some((event) => event.channel === store.conversation('investigation').channel));
    assert.match(
      errors.find((event) => event.channel === store.conversation('investigation').channel).reason,
      /\(\+i\)/,
    );
    const updated = store.addMembers('investigation', ['reviewer']);
    await chat.syncConversation(updated);
    const nativeClient = await chat.connect('reviewer');
    nativeClient.say(updated.channel, '@worker Native IRC review follow-up');
    await until(() => chat.state.lastRejected?.nick === 'reviewer');
    assert.equal(chat.state.lastRejected.conversationId, 'investigation');
    assert.equal(
      store.inbox('worker').length,
      1,
      'a message that a member typed in a native IRC client is ignored, not delivered',
    );
    await chat.send('reviewer', '@all Review completed', 'review');
    assert.equal(store.inbox('worker').length, 1);
    assert.equal(store.messages(300, 'review').length, 1);
    for (let index = 0; index < 40; index++) await chat.connect(`burst-${index}`);
    const afterBurst = await chat.send('user', '@lead Still connected after agent startup burst', 'dm-lead');
    assert.equal(afterBurst.conversationId, 'dm-lead');
  },
);
