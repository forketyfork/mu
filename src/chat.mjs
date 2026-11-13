import IRC from 'irc-framework';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const MAX_MESSAGE_BYTES = 64 * 1024;
// Ergo allows 100 channels per client by default. Every channel is also on the observer, so capping the observer caps every client.
export const DEFAULT_MAX_CHANNELS = 80;
export const confirmationTimeout = (partCount) => 15000 + partCount * 100;

export function chunks(text, maxBytes = 300) {
  const result = [];
  let chunk = '';
  for (const character of text) {
    if (Buffer.byteLength(chunk + character) > maxBytes) {
      result.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) result.push(chunk);
  return result;
}

export class Chat extends EventEmitter {
  constructor({
    host = '127.0.0.1',
    port = 6667,
    channel = '#mu',
    observerNick = 'mu-observer',
    onMessage = undefined,
    getConversation = undefined,
    getConversations = undefined,
    maxChannels = DEFAULT_MAX_CHANNELS,
    evictionWaitMs = 30000,
  }) {
    super();
    this.state = { connected: false, host, port, channel, error: 'IRC is not connected' };
    this.onMessage = onMessage;
    this.observerNick = observerNick;
    this.clients = new Map();
    this.connecting = new Map();
    this.pending = new Map();
    this.joinedChannels = new Map();
    this.syncing = new Map();
    this.maxChannels = maxChannels;
    this.lastUsed = new Map();
    this.inUse = new Map();
    this.clock = 0;
    this.evictionWaitMs = evictionWaitMs;
    this.evicting = new Map();
    this.releaseWaiters = new Set();
    this.joinQueue = Promise.resolve();
    this.stopping = false;
    this.getConversation =
      getConversation || ((id) => (id === 'common' ? { id, kind: 'common', channel, members: [] } : null));
    this.getConversations = getConversations || (() => [this.getConversation('common')]);
  }
  change(patch) {
    Object.assign(this.state, patch);
    this.emit('change');
  }
  async start() {
    this.stopping = false;
    try {
      await this.connect(this.observerNick);
      this.change({ connected: true, error: null });
    } catch (error) {
      this.change({ connected: false, error: error.message });
      throw error;
    }
  }
  async connect(nick) {
    if (this.clients.has(nick)) return this.clients.get(nick);
    if (this.connecting.has(nick)) return this.connecting.get(nick);
    const promise = new Promise((resolve, reject) => {
      const client = new IRC.Client();
      let joined = false;
      let failed = false;
      let disconnectCause = null;
      const timer = setTimeout(() => fail(new Error(`Timed out joining IRC as ${nick}`), 'registration'), 12000);
      const fail = (error, kind) => {
        if (!disconnectCause || (disconnectCause.kind === 'closed' && kind !== 'closed')) {
          disconnectCause = { nick, kind, reason: error.message, at: new Date().toISOString() };
        }
        clearTimeout(timer);
        // A replaced connection's late close must not remove the connection that took its place.
        if (this.clients.get(nick) === client) {
          this.clients.delete(nick);
          this.joinedChannels.delete(nick);
        }
        if (this.connecting.get(nick) === promise) this.connecting.delete(nick);
        if (nick === this.observerNick && !this.stopping) {
          // The observer is the operator of every secret, invite-only channel. Members left behind would keep such a channel
          // alive on the broker, and the reconnected observer could not join it again, so every connection starts over.
          for (const [member, memberClient] of this.clients) {
            this.clients.delete(member);
            this.joinedChannels.delete(member);
            memberClient.quit('Mu lost its IRC observer');
          }
          const reason = disconnectCause.kind === 'closed' ? '' : `: ${disconnectCause.reason}`;
          this.change({
            connected: false,
            error: `IRC connection for ${nick} closed${reason}; Mu reconnects when the broker answers`,
            lastDisconnect: disconnectCause,
          });
        }
        if (!joined && !failed) {
          failed = true;
          client.quit('Connection failed');
          reject(error);
        }
      };
      client.on('registered', () => {
        if (client.user.nick !== nick) return fail(new Error(`IRC nickname ${nick} is already in use`), 'registration');
        client.join(this.state.channel);
      });
      client.on('join', (event) => {
        if (event.nick === nick && event.channel === this.state.channel) {
          joined = true;
          clearTimeout(timer);
          this.clients.set(nick, client);
          this.joinedChannels.set(nick, new Set([this.state.channel]));
          this.connecting.delete(nick);
          resolve(client);
        }
      });
      client.on('close', () => fail(new Error('Connection closed without a supplied reason'), 'closed'));
      client.on('socket error', (error) =>
        fail(new Error(`IRC ${this.state.host}:${this.state.port}: ${error.message}`), 'socket'),
      );
      client.on('ping timeout', () =>
        fail(new Error(`Ping timeout after ${client.options.ping_timeout} seconds`), 'ping-timeout'),
      );
      client.on('irc error', (event) => {
        const error = new Error(event.reason || event.error || 'IRC server rejected the connection');
        if (!joined || event.error === 'irc') fail(error, 'server');
        else if (!this.stopping && this.state.connected) this.change({ error: error.message });
      });
      client.on('message', (event) => {
        if (
          nick === this.observerNick &&
          this.getConversations().some((conversation) => conversation.channel === event.target)
        )
          this.receive(event);
      });
      client.connect({
        host: this.state.host,
        port: this.state.port,
        nick,
        username: 'mu',
        gecos: 'Mu local agent room',
        tls: false,
        auto_reconnect: false,
        message_max_length: 400,
      });
    });
    this.connecting.set(nick, promise);
    return promise;
  }
  async joinChannel(nick, channel) {
    const client = await this.connect(nick);
    if (this.joinedChannels.get(nick)?.has(channel)) return client;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        client.off('join', joined);
        client.off('irc error', failed);
        error ? reject(error) : resolve();
      };
      const joined = (event) => {
        if (event.nick === nick && event.channel === channel) {
          this.joinedChannels.get(nick).add(channel);
          finish();
        }
      };
      const failed = (event) => {
        if (!event.channel || event.channel === channel)
          finish(new Error(`Could not join ${channel}: ${event.reason || event.error}`));
      };
      const timer = setTimeout(() => finish(new Error(`Timed out joining ${channel} as ${nick}`)), 12000);
      client.on('join', joined);
      client.on('irc error', failed);
      client.join(channel);
    });
    return client;
  }
  async protectChannel(client, channel) {
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        client.off('channel info', info);
        client.off('irc error', failed);
        error ? reject(error) : resolve();
      };
      const info = (event) => {
        if (event.channel !== channel || !event.raw_modes) return;
        finish(
          event.raw_modes.includes('s') && event.raw_modes.includes('i')
            ? null
            : new Error(`IRC did not enable secret and invite-only modes for ${channel}`),
        );
      };
      const failed = (event) => {
        if (!event.channel || event.channel === channel)
          finish(new Error(`Could not protect ${channel}: ${event.reason || event.error}`));
      };
      const timer = setTimeout(() => finish(new Error(`Timed out protecting ${channel}`)), 12000);
      client.on('channel info', info);
      client.on('irc error', failed);
      client.raw('MODE', channel, '+si');
      client.raw('MODE', channel);
    });
  }
  async inviteMember(observer, member, channel) {
    const client = await this.connect(member);
    if (this.joinedChannels.get(member)?.has(channel)) return;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        client.off('invite', invited);
        observer.off('irc error', failed);
        error ? reject(error) : resolve();
      };
      const invited = (event) => {
        if (event.channel === channel && event.invited === member) finish();
      };
      const failed = (event) => {
        if (!event.channel || event.channel === channel)
          finish(new Error(`Could not invite @${member} to ${channel}: ${event.reason || event.error}`));
      };
      const timer = setTimeout(() => finish(new Error(`Timed out inviting @${member} to ${channel}`)), 12000);
      client.on('invite', invited);
      observer.on('irc error', failed);
      observer.invite(channel, member);
    });
    await this.joinChannel(member, channel);
  }
  // IRC membership only carries messages; history lives in the database. A conversation is joined when a message needs
  // it, and its least recently used peers leave for everybody once the observer holds maxChannels, so that
  // the number of channels stays bounded however many agents and rooms exist. Leaving every member lets the
  // broker drop the channel; the next use creates, protects and invites it again.
  touch(channel) {
    this.lastUsed.set(channel, ++this.clock);
  }
  holdChannel(channel) {
    this.inUse.set(channel, (this.inUse.get(channel) ?? 0) + 1);
  }
  releaseChannel(channel) {
    const remaining = this.inUse.get(channel) - 1;
    if (remaining > 0) this.inUse.set(channel, remaining);
    else this.inUse.delete(channel);
    const waiters = [...this.releaseWaiters];
    this.releaseWaiters.clear();
    for (const wake of waiters) wake();
  }
  async partChannel(nick, channel) {
    const client = this.clients.get(nick);
    const joined = this.joinedChannels.get(nick);
    if (!client || !joined?.has(channel)) return;
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        client.off('part', parted);
        client.off('irc error', failed);
        error ? reject(error) : resolve();
      };
      const parted = (event) => {
        if (event.nick === nick && event.channel === channel) {
          joined.delete(channel);
          finish();
        }
      };
      const failed = (event) => {
        if (event.channel === channel) finish(new Error(`Could not leave ${channel}: ${event.reason || event.error}`));
      };
      const timer = setTimeout(() => finish(new Error(`Timed out leaving ${channel} as ${nick}`)), 12000);
      client.on('part', parted);
      client.on('irc error', failed);
      client.part(channel);
    });
  }
  // Joins, which can raise the observer's channel count, run one at a time so that concurrent first joins cannot pass the cap together.
  exclusive(task) {
    const run = this.joinQueue.then(task, task);
    this.joinQueue = run.catch(() => {});
    return run;
  }
  // The observer leaves last: it is the channel's operator, so while members remain, it can still invite them back and
  // never ends up outside a secret, invite-only channel that it cannot rejoin.
  evict(channel) {
    const eviction = (async () => {
      const observer = this.observerNick;
      for (const nick of [...this.joinedChannels.keys()].filter((nick) => nick !== observer))
        await this.partChannel(nick, channel);
      await this.partChannel(observer, channel);
      if (this.joinedChannels.get(observer)?.has(channel))
        throw new Error(`The observer is still in ${channel} after leaving it`);
    })();
    this.evicting.set(channel, eviction);
    const done = () => this.evicting.delete(channel);
    eviction.then(done, done);
    return eviction;
  }
  releasedChannel() {
    return new Promise((resolve) => {
      this.releaseWaiters.add(resolve);
    });
  }
  async makeRoom() {
    const deadline = Date.now() + this.evictionWaitMs;
    for (;;) {
      const observed = this.joinedChannels.get(this.observerNick);
      if (!observed) throw new Error('The IRC observer is disconnected');
      if (observed.size < this.maxChannels) return;
      const victim = [...observed]
        .filter((channel) => channel !== this.state.channel && !this.inUse.get(channel) && !this.evicting.has(channel))
        .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))[0];
      if (victim) {
        await this.evict(victim);
        continue;
      }
      // Every other channel has a message in flight; one of them frees up when its message completes.
      const remaining = deadline - Date.now();
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(remaining, 0), 'timeout');
      });
      const outcome = await Promise.race([this.releasedChannel(), timedOut]);
      clearTimeout(timer);
      if (outcome === 'timeout')
        throw new Error(
          `The observer is in ${observed.size} IRC channels, all in use; cannot join another (limit ${this.maxChannels})`,
        );
    }
  }
  async syncConversation(conversation) {
    if (this.syncing.has(conversation.id)) return this.syncing.get(conversation.id);
    const promise = (async () => {
      this.touch(conversation.channel);
      // A channel that is being evicted is gone for the observer and its members; rejoin it from scratch only after that ends.
      await this.evicting.get(conversation.channel)?.catch(() => {});
      await this.connect(this.observerNick);
      if (!this.joinedChannels.get(this.observerNick)?.has(conversation.channel)) {
        await this.exclusive(async () => {
          await this.evicting.get(conversation.channel)?.catch(() => {});
          if (this.joinedChannels.get(this.observerNick)?.has(conversation.channel)) return;
          await this.makeRoom();
          await this.joinChannel(this.observerNick, conversation.channel);
        });
      }
      const observer = await this.joinChannel(this.observerNick, conversation.channel);
      if (conversation.kind === 'common') return;
      await this.protectChannel(observer, conversation.channel);
      for (const member of conversation.members) await this.inviteMember(observer, member, conversation.channel);
    })();
    this.syncing.set(conversation.id, promise);
    this.holdChannel(conversation.channel);
    try {
      await promise;
    } finally {
      this.syncing.delete(conversation.id);
      this.releaseChannel(conversation.channel);
    }
  }
  // Only messages that Mu sent itself are recorded: each completes a pending send, which carries a
  // random correlation tag and the nickname of one of Mu's own connections, and the text Mu stored for
  // it. The broker accepts any client and any free nickname, so everything else is ignored.
  receive(event) {
    const conversation =
      this.getConversations().find((item) => item.channel === event.target) ||
      (!event.target ? this.getConversation('common') : null);
    if (!conversation) return;
    const correlation = event.tags?.['+mu/id'];
    const pending = correlation && this.pending.get(correlation);
    // The broker keeps nicknames unique, so a message under the nickname of a pending send comes from Mu's own connection.
    if (!pending || event.nick !== pending.from || conversation.id !== pending.conversationId) {
      const rejected = { nick: event.nick, conversationId: conversation.id, at: new Date().toISOString() };
      console.error(`Ignored an IRC message in ${conversation.id} from ${event.nick}: Mu did not send it`);
      this.change({ lastRejected: rejected });
      return;
    }
    const part = Number(event.tags['+mu/part']);
    if (!Number.isInteger(part) || part < 0 || part >= pending.total) return;
    pending.received.add(part);
    if (pending.received.size === pending.total) {
      clearTimeout(pending.timer);
      this.pending.delete(correlation);
      try {
        pending.resolve(this.onMessage(correlation, pending.from, pending.text, pending.conversationId, pending.meta));
      } catch (error) {
        pending.reject(error);
      }
    }
  }
  async send(from, text, conversationId = 'common', meta = {}) {
    if (!this.state.connected) throw new Error(this.state.error || 'IRC is disconnected');
    if (!text || Buffer.byteLength(text) > MAX_MESSAGE_BYTES)
      throw new Error(`Chat messages must contain 1–${MAX_MESSAGE_BYTES} UTF-8 bytes`);
    const conversation = this.getConversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation ${conversationId}`);
    if (conversation.kind !== 'common' && from !== 'system' && !conversation.members.includes(from))
      throw new Error(`@${from} is not a member of ${conversationId}`);
    this.holdChannel(conversation.channel);
    try {
      return await this.deliver(from, text, conversation, meta);
    } finally {
      this.releaseChannel(conversation.channel);
    }
  }
  async deliver(from, text, conversation, meta) {
    await this.syncConversation(conversation);
    this.touch(conversation.channel);
    const client = await this.connect(from);
    if (conversation.kind !== 'common' && !this.joinedChannels.get(from)?.has(conversation.channel)) {
      const observer = await this.connect(this.observerNick);
      await this.inviteMember(observer, from, conversation.channel);
    }
    const parts = chunks(text.replace(/[\r\n]/g, '↵'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('IRC did not confirm the complete message. Check the conversation before retrying.'));
      }, confirmationTimeout(parts.length));
      this.pending.set(id, {
        from,
        text,
        conversationId: conversation.id,
        meta,
        total: parts.length,
        received: new Set(),
        resolve,
        reject,
        timer,
      });
      for (const [index, part] of parts.entries()) {
        client.say(conversation.channel, part, { '+mu/id': id, '+mu/part': String(index) });
      }
    });
  }
  close() {
    this.stopping = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('IRC connection shutting down'));
    }
    this.pending.clear();
    for (const client of this.clients.values()) client.quit('Mu shutdown');
    this.clients.clear();
    this.joinedChannels.clear();
    this.change({ connected: false, error: 'Mu is stopped' });
  }
}
