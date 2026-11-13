import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

// Every table keeps its record as JSON text in the data column.
const parseData = (row) => JSON.parse(/** @type {string} */ (row.data));

export const STATUSES = ['idle', 'working', 'blocked', 'done', 'stopped', 'error'];
// Code spans, emails and scoped package names such as @scope/pkg are not mentions.
export function mentions(text) {
  const prose = text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, ' ').replace(/(`+)[\s\S]*?\1/g, ' ');
  return [
    ...new Set(
      [...prose.matchAll(/(?:^|[^\w@/])@([a-z][a-z0-9-]{0,23})(?![a-z0-9-]|\/[\w@.-])/gi)].map((match) =>
        match[1].toLowerCase(),
      ),
    ),
  ];
}

// The kinds of record a `change` event can name. The dashboard stream sends only the records a change names, so a
// change that named nothing, or the wrong record, would leave every open dashboard stale.
export const CHANGE_KINDS = Object.freeze(['agents', 'conversations', 'tasks', 'waiting', 'activities']);

export class Store extends EventEmitter {
  // A `change` event carries what changed: a list of `[kind, id]`, where a null id means any record of that kind.
  emit(name, ...args) {
    if (name === 'change') {
      const [changes] = args;
      if (
        !Array.isArray(changes) ||
        !changes.every(
          (change) =>
            Array.isArray(change) &&
            CHANGE_KINDS.includes(change[0]) &&
            (change[1] === null || typeof change[1] === 'string'),
        )
      )
        throw new Error('A store change lists what changed as [kind, id or null] pairs');
      if (this.batchingChanges) {
        this.transactionChanged = true;
        this.transactionChanges.push(...changes);
        return true;
      }
    }
    return super.emit(name, ...args);
  }
  changed(...changes) {
    this.emit('change', changes);
  }
  transaction(operation) {
    if (this.batchingChanges) throw new Error('Nested store transactions are not supported');
    this.batchingChanges = true;
    this.transactionChanged = false;
    this.transactionChanges = [];
    this.db.exec('BEGIN');
    let result;
    try {
      result = operation();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.transactionChanged = false;
      throw error;
    } finally {
      this.batchingChanges = false;
    }
    if (this.transactionChanged) this.emit('change', this.transactionChanges);
    return result;
  }
  constructor(filename = ':memory:', { commonChannel = '#mu' } = {}) {
    super();
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, transport_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (agent_id TEXT NOT NULL REFERENCES agents(id), message_id INTEGER NOT NULL REFERENCES messages(id), acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id,message_id));
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      -- The role files of the Mu home as the service last saw them, so that a change shows up once, also across restarts.
      CREATE TABLE IF NOT EXISTS role_files (name TEXT PRIMARY KEY, data TEXT NOT NULL);
      -- History reads filter on the conversation: GET /api/state reads the latest messages of every conversation, and
      -- the dashboard pages through one. Without this index each read parses every stored message; when the dashboard
      -- state was rebuilt on each change, that blocked the event loop for seconds per change and stalled HTTP and IRC.
      -- The expression must match the one in messages() exactly, or SQLite does not use the index.
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(json_extract(data,'$.conversationId'), id);
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(agent_id, acknowledged, message_id);`);
    this.db.exec('BEGIN');
    try {
      if (!this.conversation('common'))
        this.insertConversation({
          id: 'common',
          kind: 'common',
          name: 'Common',
          channel: commonChannel,
          members: ['user'],
          createdBy: 'user',
        });
      for (const row of this.db.prepare('SELECT id,data FROM messages').all()) {
        const message = parseData(row);
        if (!message.conversationId)
          this.db
            .prepare('UPDATE messages SET data=? WHERE id=?')
            .run(JSON.stringify({ ...message, conversationId: 'common' }), row.id);
      }
      for (const row of this.db.prepare('SELECT id,data FROM agents').all()) {
        let agent = parseData(row);
        const stored = agent;
        if (!agent.conversationId)
          agent = {
            ...agent,
            conversationId: 'common',
            sessionIds: agent.sessionIds || (agent.sessionId ? { common: agent.sessionId } : {}),
          };
        // A saved result covers every message of the turn that produced it; before a turn could cover several, it named one.
        if (agent.pendingResult && !agent.pendingResult.messageIds) {
          const { messageId, ...saved } = agent.pendingResult;
          agent = { ...agent, pendingResult: { ...saved, messageIds: [messageId] } };
        }
        if (agent !== stored) this.db.prepare('UPDATE agents SET data=? WHERE id=?').run(JSON.stringify(agent), row.id);
        this.ensureDirect(agent.id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const agent of this.agents()) {
      if (agent.status === 'working' || agent.activeMessageId)
        this.updateAgent(agent.id, {
          status: 'error',
          activeMessageId: null,
          lastError:
            'Server restarted during a turn. Inspect the work, then set status idle to retry the unacknowledged messages.',
        });
    }
  }
  agent(id) {
    const row = this.db.prepare('SELECT data FROM agents WHERE id=?').get(id);
    if (!row) return null;
    return {
      ...parseData(row),
      pending: this.db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE agent_id=? AND acknowledged=0').get(id).n,
    };
  }
  agents() {
    return this.db
      .prepare('SELECT id FROM agents ORDER BY rowid')
      .all()
      .map((row) => this.agent(row.id));
  }
  conversation(id) {
    const row = this.db.prepare('SELECT data FROM conversations WHERE id=?').get(id);
    if (!row) return null;
    const conversation = parseData(row);
    if (conversation.kind === 'common')
      conversation.members = [
        'user',
        ...this.db
          .prepare('SELECT id FROM agents ORDER BY rowid')
          .all()
          .map((agent) => agent.id),
      ];
    return conversation;
  }
  conversations() {
    return this.db
      .prepare('SELECT id FROM conversations ORDER BY rowid')
      .all()
      .map((row) => this.conversation(row.id));
  }
  insertConversation(input) {
    const conversation = { ...input, members: [...new Set(input.members)], createdAt: new Date().toISOString() };
    this.db
      .prepare('INSERT INTO conversations (id,data) VALUES (?,?)')
      .run(conversation.id, JSON.stringify(conversation));
    return conversation;
  }
  ensureDirect(agentId) {
    const id = `dm-${agentId}`;
    if (!this.conversation(id)) {
      this.insertConversation({
        id,
        kind: 'direct',
        name: `@${agentId}`,
        channel: `${this.conversation('common').channel}-${id}`,
        members: ['user', agentId],
        createdBy: 'user',
      });
      this.changed(['conversations', id]);
    }
    return this.conversation(id);
  }
  createConversation(input) {
    if (this.conversation(input.id)) throw new Error(`Conversation ${input.id} already exists`);
    for (const member of input.members)
      if (member !== 'user' && !this.agent(member)) throw new Error(`Unknown member @${member}`);
    const conversation = this.insertConversation({
      ...input,
      channel: `${this.conversation('common').channel}-room-${input.id}`,
      members: ['user', ...input.members],
    });
    this.changed(['conversations', conversation.id]);
    return conversation;
  }
  addMembers(id, members) {
    const conversation = this.conversation(id);
    if (!conversation) throw new Error(`Unknown conversation ${id}`);
    if (conversation.kind !== 'room') throw new Error('Only task rooms can invite additional members');
    for (const member of members)
      if (member !== 'user' && !this.agent(member)) throw new Error(`Unknown member @${member}`);
    const updated = { ...conversation, members: [...new Set([...conversation.members, ...members])] };
    this.db.prepare('UPDATE conversations SET data=? WHERE id=?').run(JSON.stringify(updated), id);
    this.changed(['conversations', id]);
    return updated;
  }
  createAgent(input) {
    if (this.agent(input.id)) throw new Error(`Agent @${input.id} already exists`);
    const now = new Date().toISOString();
    const agent = {
      conversationId: 'common',
      ...input,
      status: 'idle',
      sessionId: null,
      sessionIds: {},
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    this.db.prepare('INSERT INTO agents (id,data) VALUES (?,?)').run(agent.id, JSON.stringify(agent));
    this.ensureDirect(agent.id);
    // The common room lists every agent.
    this.changed(['agents', agent.id], ['conversations', 'common']);
    return this.agent(agent.id);
  }
  updateAgent(id, patch) {
    const agent = this.agent(id);
    if (!agent) throw new Error(`Unknown agent @${id}`);
    const updated = { ...agent, ...patch, updatedAt: new Date().toISOString() };
    delete updated.pending;
    this.db.prepare('UPDATE agents SET data=? WHERE id=?').run(JSON.stringify(updated), id);
    this.changed(['agents', id]);
    return this.agent(id);
  }
  addMessage(transportId, from, text, conversationId = 'common', { autoRouted = false } = {}) {
    const existing = this.db.prepare('SELECT id,data FROM messages WHERE transport_id=?').get(transportId);
    if (existing) return { id: existing.id, ...parseData(existing) };
    const conversation = this.conversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation ${conversationId}`);
    if (conversation.kind !== 'common' && from !== 'system' && !conversation.members.includes(from))
      throw new Error(`@${from} is not a member of ${conversationId}`);
    /** @type {Record<string, any>} */
    const message = {
      from,
      text,
      conversationId,
      mentions: mentions(text),
      ...(autoRouted && { autoRouted: true }),
      createdAt: new Date().toISOString(),
    };
    const recipients = [];
    this.db.exec('BEGIN');
    try {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO messages (transport_id,data) VALUES (?,?)')
        .run(transportId, JSON.stringify(message));
      message.id = Number(lastInsertRowid);
      for (const agent of this.agents()) {
        const addressed =
          (conversation.kind === 'direct' && from !== 'system') ||
          message.mentions.includes('all') ||
          message.mentions.includes(agent.id);
        if (agent.id !== from && conversation.members.includes(agent.id) && addressed) {
          this.db.prepare('INSERT INTO inbox (agent_id,message_id) VALUES (?,?)').run(agent.id, message.id);
          recipients.push(agent.id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // A recipient's count of queued messages changed.
    this.changed(...recipients.map((id) => /** @type {[string, string]} */ (['agents', id])));
    this.emit('message', message);
    return message;
  }
  messages(limit = 300, conversationId, before = Number.MAX_SAFE_INTEGER) {
    const rows =
      conversationId === undefined
        ? this.db.prepare('SELECT id,data FROM messages WHERE id<? ORDER BY id DESC LIMIT ?').all(before, limit)
        : this.db
            .prepare(
              "SELECT id,data FROM messages WHERE json_extract(data,'$.conversationId')=? AND id<? ORDER BY id DESC LIMIT ?",
            )
            .all(conversationId, before, limit);
    return rows.reverse().map((row) => ({ id: row.id, ...parseData(row) }));
  }
  // Ascending from the message after `after`; a dashboard that missed messages catches up with these.
  messagesAfter(conversationId, after, limit = 300) {
    return this.db
      .prepare(
        "SELECT id,data FROM messages WHERE json_extract(data,'$.conversationId')=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(conversationId, after, limit)
      .map((row) => ({ id: row.id, ...parseData(row) }));
  }
  // Reads the newest messages from one author after a conversation cursor, returned in chronological order.
  messagesFromAfter(conversationId, from, after, limit = 300) {
    return this.db
      .prepare(
        "SELECT id,data FROM messages WHERE json_extract(data,'$.conversationId')=? AND json_extract(data,'$.from')=? AND id>? ORDER BY id DESC LIMIT ?",
      )
      .all(conversationId, from, after, limit)
      .reverse()
      .map((row) => ({ id: row.id, ...parseData(row) }));
  }
  message(id) {
    const row = this.db.prepare('SELECT id,data FROM messages WHERE id=?').get(id);
    return row ? { id: row.id, ...parseData(row) } : null;
  }
  // The newest message ID of each conversation that has messages. SQLite uses the conversation index only for a
  // conversation given as a parameter, not in a correlated subquery, so each conversation is one lookup.
  lastMessageIds() {
    const newest = this.db.prepare("SELECT MAX(id) AS id FROM messages WHERE json_extract(data,'$.conversationId')=?");
    /** @type {Record<string, number>} */
    const ids = {};
    for (const { id } of this.db.prepare('SELECT id FROM conversations ORDER BY rowid').all()) {
      const last = newest.get(id).id;
      if (last !== null) ids[/** @type {string} */ (id)] = Number(last);
    }
    return ids;
  }
  inbox(id) {
    return this.db
      .prepare(
        'SELECT m.id,m.data FROM inbox i JOIN messages m ON m.id=i.message_id WHERE i.agent_id=? AND i.acknowledged=0 ORDER BY i.message_id LIMIT 100',
      )
      .all(id)
      .map((row) => ({ id: row.id, ...parseData(row) }));
  }
  ack(id, messageId) {
    const result = this.db
      .prepare('UPDATE inbox SET acknowledged=1 WHERE agent_id=? AND message_id=?')
      .run(id, messageId);
    if (!result.changes) throw new Error(`Message ${messageId} is not in @${id}'s inbox`);
    this.changed(['agents', id]);
  }
  // Acknowledges every message a turn covered together with the agent's new state, or none of them.
  completeTurn(id, messageIds, patch) {
    const agent = this.agent(id);
    if (!agent) throw new Error(`Unknown agent @${id}`);
    if (!messageIds.length) throw new Error('A turn covers at least one message');
    const updated = { ...agent, ...patch, updatedAt: new Date().toISOString() };
    delete updated.pending;
    this.db.exec('BEGIN');
    try {
      const acknowledge = this.db.prepare(
        'UPDATE inbox SET acknowledged=1 WHERE agent_id=? AND message_id=? AND acknowledged=0',
      );
      for (const messageId of messageIds)
        if (!acknowledge.run(id, messageId).changes)
          throw new Error(`Message ${messageId} is not pending in @${id}'s inbox`);
      this.db.prepare('UPDATE agents SET data=? WHERE id=?').run(JSON.stringify(updated), id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.changed(['agents', id]);
    return this.agent(id);
  }
  roleFile(name) {
    const row = this.db.prepare('SELECT data FROM role_files WHERE name=?').get(name);
    return row ? parseData(row) : null;
  }
  // Records the file's hash and reports the previous record, or null when this is the first one. Only a changed
  // hash replaces the record, so two turns that see the same change at once report it once.
  observeRoleFile(name, hash) {
    const previous = this.roleFile(name);
    if (previous?.hash === hash) return { changed: false, previous };
    this.db
      .prepare('INSERT INTO role_files (name,data) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET data=excluded.data')
      .run(name, JSON.stringify({ hash, seenAt: new Date().toISOString() }));
    return { changed: previous !== null, previous };
  }
  // Puts back the record that an observation replaced, so that the next one reports the change again, unless
  // a later observation has replaced it since.
  restoreRoleFile(name, observedHash, previous) {
    if (this.roleFile(name)?.hash !== observedHash) return;
    if (previous) this.db.prepare('UPDATE role_files SET data=? WHERE name=?').run(JSON.stringify(previous), name);
    else this.db.prepare('DELETE FROM role_files WHERE name=?').run(name);
  }
  close() {
    this.db.close();
  }
}
