import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import IRC from 'irc-framework';
import { Chat } from '../src/chat.mjs';

const BROKER_LIMIT = 100;

// A broker with the rules of Ergo that matter here: a per-client channel limit, secret invite-only
// channels that only an invited client can join, and channels that disappear when the last client leaves.
class Broker {
  channels = new Map();
  clients = new Map();
  peak = 0;
  partLog = [];
  // The broker applies a PART at once; with a delay, its confirmation reaches the client later.
  partConfirmDelay = 0;
}
class FakeClient extends EventEmitter {
  constructor(broker) {
    super();
    this.broker = broker;
    this.options = { ping_timeout: 120 };
    this.user = {};
    this.joined = new Set();
  }
  later(fn) {
    queueMicrotask(fn);
  }
  connect(options) {
    Object.assign(this.options, options);
    this.user.nick = options.nick;
    this.broker.clients.set(options.nick, this);
    this.later(() => this.emit('registered'));
  }
  join(name) {
    this.later(() => {
      const channel = this.broker.channels.get(name);
      if (this.joined.size >= BROKER_LIMIT)
        return this.emit('irc error', {
          error: 'too_many_channels',
          channel: name,
          reason: 'You have joined too many channels',
        });
      if (channel?.modes.includes('i') && !channel.invited.has(this.user.nick))
        return this.emit('irc error', {
          error: 'invite_only_chan',
          channel: name,
          reason: 'Cannot join channel (invite only)',
        });
      const entry = channel ?? { members: new Set(), invited: new Set(), modes: '' };
      this.broker.channels.set(name, entry);
      entry.members.add(this.user.nick);
      this.joined.add(name);
      this.broker.peak = Math.max(this.broker.peak, this.joined.size);
      this.emit('join', { nick: this.user.nick, channel: name });
    });
  }
  part(name) {
    this.later(() => {
      const channel = this.broker.channels.get(name);
      channel.members.delete(this.user.nick);
      this.joined.delete(name);
      this.broker.partLog.push({ nick: this.user.nick, channel: name });
      if (!channel.members.size) this.broker.channels.delete(name);
      const confirm = () => this.emit('part', { nick: this.user.nick, channel: name });
      if (this.broker.partConfirmDelay) setTimeout(confirm, this.broker.partConfirmDelay);
      else confirm();
    });
  }
  raw(command, name, modes) {
    this.later(() => {
      const channel = this.broker.channels.get(name);
      if (modes) channel.modes = modes.replace('+', '');
      else this.emit('channel info', { channel: name, raw_modes: `+${channel.modes}` });
    });
  }
  invite(name, nick) {
    this.later(() => {
      this.broker.channels.get(name).invited.add(nick);
      this.broker.clients.get(nick).emit('invite', { channel: name, invited: nick });
    });
  }
  say(name, text, tags) {
    this.later(() => {
      if (!this.broker.channels.get(name)?.members.has(this.user.nick)) return;
      for (const member of this.broker.channels.get(name).members)
        this.broker.clients.get(member).emit('message', { target: name, nick: this.user.nick, message: text, tags });
    });
  }
  // Like Ergo, a quitting client leaves its channels, and a channel without members disappears.
  quit() {
    this.later(() => {
      for (const name of this.joined) {
        const channel = this.broker.channels.get(name);
        channel?.members.delete(this.user.nick);
        if (channel && !channel.members.size) this.broker.channels.delete(name);
      }
      this.joined.clear();
      if (this.broker.clients.get(this.user.nick) === this) this.broker.clients.delete(this.user.nick);
      this.emit('close');
    });
  }
}

async function fixture(
  t,
  { maxChannels = undefined, conversations = 130, partConfirmDelay = 0, evictionWaitMs = undefined } = {},
) {
  const broker = new Broker();
  broker.partConfirmDelay = partConfirmDelay;
  t.mock.method(IRC, 'Client', function () {
    return new FakeClient(broker);
  });
  const all = [
    { id: 'common', kind: 'common', channel: '#mu', members: ['user'] },
    ...Array.from({ length: conversations }, (_, index) => ({
      id: `dm-agent-${index}`,
      kind: 'direct',
      channel: `#mu-dm-agent-${index}`,
      members: ['user', `agent-${index}`],
    })),
  ];
  const delivered = [];
  const chat = new Chat({
    maxChannels,
    evictionWaitMs,
    getConversation: (id) => all.find((item) => item.id === id),
    getConversations: () => all,
    onMessage: (id, from, text, conversationId) => {
      delivered.push({ from, conversationId });
      return { id, from, text, conversationId };
    },
  });
  t.after(async () => {
    chat.close();
    await new Promise((resolve) => setImmediate(resolve));
  });
  await chat.start();
  return { broker, chat, all, delivered };
}

test('without a cap, the observer reaches the broker limit and the 101st conversation cannot be joined', async (t) => {
  const { chat, all } = await fixture(t, { maxChannels: Infinity });
  await assert.rejects(async () => {
    for (const conversation of all.slice(1)) await chat.send('user', 'hello', conversation.id);
  }, /Could not join #mu-dm-agent-99: You have joined too many channels/);
});

test('IRC channels stay under the cap however many conversations exist, and every message is delivered', async (t) => {
  const { broker, chat, all, delivered } = await fixture(t, { maxChannels: 20 });
  for (const conversation of all.slice(1)) await chat.send('user', `hello ${conversation.id}`, conversation.id);
  assert.equal(delivered.length, 130);
  assert.ok(broker.peak <= 20, `peak per-client channels ${broker.peak}`);
  assert.equal(chat.joinedChannels.get('mu-observer').size, 20);
  assert.ok(chat.joinedChannels.get('mu-observer').has('#mu'), 'the common channel is never left');
});

test('a conversation that was left is joined again, protected again, and delivered', async (t) => {
  const { broker, chat, all, delivered } = await fixture(t, { maxChannels: 5 });
  for (const conversation of all.slice(1, 11)) await chat.send('user', 'hello', conversation.id);
  assert.equal(
    broker.channels.has('#mu-dm-agent-0'),
    false,
    'the least recently used channel left for everybody and the broker dropped it',
  );
  await chat.send('agent-0', 'back again', 'dm-agent-0');
  assert.deepEqual(delivered.at(-1), { from: 'agent-0', conversationId: 'dm-agent-0' });
  assert.match(broker.channels.get('#mu-dm-agent-0').modes, /s/);
  assert.match(broker.channels.get('#mu-dm-agent-0').modes, /i/);
  assert.deepEqual([...broker.channels.get('#mu-dm-agent-0').members].sort(), ['agent-0', 'mu-observer', 'user']);
});

test('a conversation in active use is not chosen for eviction', async (t) => {
  const { chat, all } = await fixture(t, { maxChannels: 3 });
  const busy = all[1];
  await chat.syncConversation(busy);
  chat.holdChannel(busy.channel);
  for (const conversation of all.slice(2, 8)) await chat.send('user', 'hello', conversation.id);
  assert.ok(chat.joinedChannels.get('mu-observer').has(busy.channel));
  chat.releaseChannel(busy.channel);
});

test('when every channel is in use the failure names the limit instead of hanging', async (t) => {
  const { chat, all } = await fixture(t, { maxChannels: 2, evictionWaitMs: 50 });
  await chat.syncConversation(all[1]);
  chat.holdChannel(all[1].channel);
  await assert.rejects(chat.syncConversation(all[2]), /all in use; cannot join another \(limit 2\)/);
});

const settled = (promise) =>
  promise.then(
    () => 'delivered',
    (error) => error.message,
  );
const until = async (condition) => {
  for (let turn = 0; turn < 1000 && !condition(); turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(condition(), 'condition was not reached');
};

test(
  'a send to a conversation that is being evicted waits for the eviction and then rejoins it',
  { timeout: 5000 },
  async (t) => {
    const { broker, chat, delivered } = await fixture(t, { maxChannels: 3, partConfirmDelay: 20 });
    await chat.send('user', 'one', 'dm-agent-0');
    await chat.send('user', 'two', 'dm-agent-1');
    // #mu, agent-0 and agent-1 fill the cap; joining agent-2 evicts the least recently used, agent-0.
    const joining = chat.send('user', 'three', 'dm-agent-2');
    await until(() => broker.partLog.some((entry) => entry.channel === '#mu-dm-agent-0'));
    const racing = chat.send('agent-0', 'while it leaves', 'dm-agent-0');
    assert.deepEqual([await settled(joining), await settled(racing)], ['delivered', 'delivered']);
    assert.deepEqual(
      delivered.map((item) => item.conversationId),
      ['dm-agent-0', 'dm-agent-1', 'dm-agent-2', 'dm-agent-0'],
    );
    assert.ok(chat.joinedChannels.get('mu-observer').size <= 3);
    assert.deepEqual(
      broker.partLog.slice(0, 3).map((entry) => entry.nick),
      ['user', 'agent-0', 'mu-observer'],
      'members leave before the observer',
    );
  },
);

test(
  'concurrent first sends to new conversations never take the observer past the cap',
  { timeout: 5000 },
  async (t) => {
    const { broker, chat, all, delivered } = await fixture(t, { maxChannels: 3, partConfirmDelay: 5 });
    const results = await Promise.all(
      all.slice(1, 9).map((conversation) => settled(chat.send('user', 'hello', conversation.id))),
    );
    assert.deepEqual(results, Array(8).fill('delivered'));
    assert.equal(delivered.length, 8);
    assert.ok(broker.peak <= 3, `peak per-client channels ${broker.peak}`);
  },
);

test('an eviction that the broker does not carry out fails instead of looping', { timeout: 5000 }, async (t) => {
  const { chat } = await fixture(t, { maxChannels: 3 });
  await chat.send('user', 'one', 'dm-agent-0');
  await chat.send('user', 'two', 'dm-agent-1');
  t.mock.method(chat, 'partChannel', async () => {});
  await assert.rejects(chat.send('user', 'three', 'dm-agent-2'), /still in #mu-dm-agent-\d after leaving it/);
});

test('after a lost observer, every connection starts over, so the reconnected observer can join secret channels again', async (t) => {
  const { broker, chat, delivered } = await fixture(t, { maxChannels: 20, conversations: 2 });
  await chat.send('agent-0', 'before', 'dm-agent-0');
  broker.clients.get('mu-observer').quit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chat.state.connected, false);
  assert.deepEqual([...chat.clients.keys()], [], 'the members were disconnected with the observer');
  assert.equal(
    broker.channels.has('#mu-dm-agent-0'),
    false,
    'the broker dropped the channel that only the members kept',
  );
  await chat.start();
  await chat.send('agent-0', 'after', 'dm-agent-0');
  assert.deepEqual(delivered.at(-1), { from: 'agent-0', conversationId: 'dm-agent-0' });
  assert.match(broker.channels.get('#mu-dm-agent-0').modes, /s/);
});
