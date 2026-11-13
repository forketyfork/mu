import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';
import { ROOT } from '../src/server.mjs';
import { shortTempDir } from './isolation.mjs';

const agent = (id) => ({ id, role: id === 'lead' ? 'lead' : 'worker', adapter: 'manual', cwd: ROOT, task: '' });

// Records the SQL of every statement the store prepares while operation runs.
function preparedDuring(store, operation) {
  const statements = new Set();
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql) => {
    statements.add(sql);
    return prepare(sql);
  };
  try {
    operation();
  } finally {
    store.db.prepare = prepare;
  }
  return [...statements];
}

function queryPlan(store, sql) {
  return store.db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...Array.from({ length: (sql.match(/\?/g) || []).length }, () => 1))
    .map((row) => String(row.detail));
}

// The messages and inbox tables grow with every message, and the dashboard state reads them on each change, so a
// statement that reads all their rows stalls the event loop as the history grows. A filter on a JSON field does so
// even when SQLite reports a SEARCH on the rowid range, unless an index on the same expression serves it.
function fullScans(store, statements) {
  return statements
    .filter((sql) => /\b(messages|inbox)\b/.test(sql))
    .flatMap((sql) => {
      const plan = store.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: (sql.match(/\?/g) || []).length }, () => 1))
        .map((row) => String(row.detail));
      const problems = plan.filter((detail) => /^SCAN (messages|inbox|m|i)\b/.test(detail));
      if (
        /WHERE[\s\S]*json_extract\(/.test(sql) &&
        !plan.some((detail) => /USING (COVERING )?INDEX \S+ \(<expr>/.test(detail))
      )
        problems.push(...plan);
      return problems.map((detail) => `${sql} -> ${detail}`);
    });
}

test('reading conversations, messages and inboxes never scans the message history, also in a database created before the index', async (t) => {
  const filename = join(await shortTempDir(t, 'store-queries'), 'mu.sqlite');
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, transport_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE inbox (agent_id TEXT NOT NULL REFERENCES agents(id), message_id INTEGER NOT NULL REFERENCES messages(id), acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id,message_id));
    CREATE TABLE conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  old.close();

  const store = new Store(filename);
  t.after(() => store.close());
  for (const id of ['lead', 'worker']) store.createAgent(agent(id));
  const room = store.createConversation({ id: 'room', kind: 'room', name: 'Room', members: ['lead', 'worker'] });
  const statements = preparedDuring(store, () => {
    const message = store.addMessage('1', 'lead', '@worker go', room.id);
    store.addMessage('2', 'user', 'hello', 'dm-lead');
    store.ack('worker', message.id);
    store.addMessage('3', 'lead', '@worker again', room.id);
    store.completeTurn('worker', [3], { status: 'idle' });
    for (const conversation of store.conversations()) store.messages(300, conversation.id);
    store.messages(300, room.id, 3);
    store.messages(300);
    store.messagesAfter(room.id, 1);
    store.messagesFromAfter(room.id, 'lead', 1);
    store.message(3);
    store.lastMessageIds();
    store.inbox('worker');
    store.agents();
  });
  assert.ok(
    statements.some((sql) => sql.includes("json_extract(data,'$.conversationId')")),
    'the conversation read is among the recorded statements',
  );
  assert.deepEqual(fullScans(store, statements), []);
  const inboxQuery = statements.find((sql) => /SELECT m\.id,m\.data FROM inbox i JOIN messages m/.test(sql));
  assert.ok(inboxQuery, 'the pending inbox read is among the recorded statements');
  const inboxPlan = queryPlan(store, inboxQuery);
  assert.ok(
    inboxPlan.some((detail) =>
      /SEARCH i USING COVERING INDEX inbox_pending \(agent_id=\? AND acknowledged=\?\)/.test(detail),
    ),
    `pending inbox reads must use both indexed filters: ${inboxPlan.join(' | ')}`,
  );
  assert.ok(
    !inboxPlan.some((detail) => /USE TEMP B-TREE FOR ORDER BY/.test(detail)),
    `pending inbox reads must preserve message order through the index: ${inboxPlan.join(' | ')}`,
  );
  const pendingCount = statements.find((sql) =>
    /SELECT COUNT\(\*\) AS n FROM inbox WHERE agent_id=\? AND acknowledged=0/.test(sql),
  );
  assert.ok(pendingCount, 'the pending count is among the recorded statements');
  const pendingPlan = queryPlan(store, pendingCount);
  assert.ok(
    pendingPlan.some((detail) =>
      /SEARCH inbox USING COVERING INDEX inbox_pending \(agent_id=\? AND acknowledged=\?\)/.test(detail),
    ),
    `pending counts must use both indexed filters: ${pendingPlan.join(' | ')}`,
  );
  assert.deepEqual(
    store.messages(300, room.id).map((message) => message.text),
    ['@worker go', '@worker again'],
  );
  assert.deepEqual(
    store.messages(300, room.id, 3).map((message) => message.text),
    ['@worker go'],
  );
  assert.deepEqual(
    store.messagesAfter(room.id, 1).map((message) => message.text),
    ['@worker again'],
  );
  assert.deepEqual(
    store.messagesFromAfter(room.id, 'lead', 1).map((message) => message.text),
    ['@worker again'],
  );
  assert.deepEqual(store.lastMessageIds(), { room: 3, 'dm-lead': 2 });
  store.addMessage('4', 'lead', 'newer', room.id);
  store.addMessage('5', 'lead', 'newest', room.id);
  assert.deepEqual(
    store.messagesFromAfter(room.id, 'lead', 1, 2).map((message) => message.text),
    ['newer', 'newest'],
  );
});
