import { randomUUID } from 'node:crypto';
import { CHANGE_KINDS } from './store.mjs';

// The dashboard's event stream: one snapshot when a dashboard connects, then batches of changed records.
// See "Dashboard updates" in docs/architecture.md.

/**
 * @typedef {{ id: string }} Entity
 * @typedef {{ list: () => Entity[], get: (id: string) => Entity | null }} Source
 * @typedef {{ kind: string, id?: string, value: any }} Change
 * @typedef {{ seq: number, bytes: number, frame: string }} Batch
 */

const frame = (epoch, seq, event, data) => `id: ${epoch}:${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * @param {object} options
 * @param {Record<string, Source>} options.sources One per change kind of the store.
 * @param {() => Record<string, number>} options.lastMessageIds The newest message ID of each conversation.
 * @param {() => object} options.transport
 * @param {string[]} options.adapters
 * @param {number} [options.replayBatches] How many recent batches a reconnecting dashboard can catch up on.
 * @param {number} [options.replayBytes]
 */
export function createDashboardStream({
  sources,
  lastMessageIds,
  transport,
  adapters,
  replayBatches = 1000,
  replayBytes = 8 * 1024 * 1024,
}) {
  for (const kind of CHANGE_KINDS)
    if (!sources[kind]) throw new Error(`The dashboard stream needs a source of ${kind}`);
  // Event IDs carry the epoch, so a dashboard reconnecting after a restart never takes another process's sequence as its own.
  const epoch = randomUUID().slice(0, 8);
  let seq = 0;
  const streams = new Set();
  /** @type {Batch[]} */
  const replay = [];
  let replaySize = 0;
  // What the dashboards were last sent of each record, as JSON, so that a change that rewrites a record with the same
  // content sends nothing.
  /** @type {Map<string, Map<string, string>>} */
  const sent = new Map();
  const seed = (kind) => new Map(sources[kind].list().map((entity) => [entity.id, JSON.stringify(entity)]));
  for (const kind of CHANGE_KINDS) sent.set(kind, seed(kind));
  let sentTransport = JSON.stringify(transport());
  /** @type {Map<string, Set<string> | null>} */
  const dirty = new Map();
  /** @type {any[]} */
  let messages = [];
  let transportDirty = false;
  let scheduled = null;
  let closed = false;

  // Changes that come together, such as a turn's status, usage and acknowledgements, leave in one batch. After close the
  // sources may be gone, as the store closes during shutdown while ending turns still name their agents.
  const schedule = () => {
    if (!closed) scheduled ??= setImmediate(flush);
  };

  const compare = (kind, id, entity, changes) => {
    const previous = sent.get(kind);
    if (!entity) {
      if (!previous.has(id)) return;
      previous.delete(id);
      changes.push({ kind, id, value: null });
      return;
    }
    const json = JSON.stringify(entity);
    if (previous.get(id) === json) return;
    previous.set(id, json);
    changes.push({ kind, id, value: entity });
  };

  const collect = () => {
    /** @type {Change[]} */
    const changes = [];
    for (const [kind, ids] of dirty) {
      const source = sources[kind];
      if (ids) {
        for (const id of ids) compare(kind, id, source.get(id), changes);
        continue;
      }
      const current = source.list();
      const present = new Set(current.map((entity) => entity.id));
      for (const id of [...sent.get(kind).keys()]) if (!present.has(id)) compare(kind, id, null, changes);
      for (const entity of current) compare(kind, entity.id, entity, changes);
    }
    dirty.clear();
    for (const message of messages) changes.push({ kind: 'messages', id: String(message.id), value: message });
    messages = [];
    if (transportDirty) {
      transportDirty = false;
      const current = transport();
      const json = JSON.stringify(current);
      if (json !== sentTransport) {
        sentTransport = json;
        changes.push({ kind: 'transport', value: current });
      }
    }
    return changes;
  };

  function flush() {
    scheduled = null;
    const changes = collect();
    if (!changes.length) return;
    seq += 1;
    const data = frame(epoch, seq, 'changes', { seq, changes });
    const batch = { seq, bytes: Buffer.byteLength(data), frame: data };
    replay.push(batch);
    replaySize += batch.bytes;
    while (replay.length > replayBatches || (replay.length > 1 && replaySize > replayBytes))
      replaySize -= replay.shift().bytes;
    for (const stream of streams) stream.write(data);
  }

  const snapshot = () => ({
    epoch,
    seq,
    agents: sources.agents.list(),
    tasks: sources.tasks.list(),
    waiting: sources.waiting.list(),
    activities: sources.activities.list(),
    conversations: sources.conversations.list(),
    lastMessageIds: lastMessageIds(),
    transport: transport(),
    adapters,
  });

  // Last-Event-ID is `epoch:seq`. A dashboard that missed only batches still held here receives just those;
  // any other dashboard, a new one included, receives a snapshot.
  const missed = (lastEventId) => {
    const match = /^([0-9a-f]{8}):(\d+)$/.exec(lastEventId ?? '');
    if (!match || match[1] !== epoch) return null;
    const after = Number(match[2]);
    if (after > seq) return null;
    if (after === seq) return [];
    const first = replay.findIndex((batch) => batch.seq === after + 1);
    return first === -1 ? null : replay.slice(first);
  };

  return {
    epoch,
    get seq() {
      return seq;
    },
    get streams() {
      return streams;
    },
    snapshot,
    /** @param {[string, string | null][]} changes */
    change(changes) {
      for (const [kind, id] of changes) {
        if (id === null) dirty.set(kind, null);
        else if (!dirty.has(kind)) dirty.set(kind, new Set([id]));
        else dirty.get(kind)?.add(id);
      }
      if (changes.length) schedule();
    },
    message(message) {
      messages.push(message);
      schedule();
    },
    transportChanged() {
      transportDirty = true;
      schedule();
    },
    /**
     * @param {import('node:http').ServerResponse} response
     * @param {string | undefined} lastEventId
     */
    connect(response, lastEventId) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      // A reconnect that missed nothing writes nothing yet; without the headers the browser would not report the stream
      // open until the next batch or keepalive.
      response.flushHeaders();
      // Changes still being collected are sent first, to the dashboards already connected. Otherwise a record that changed
      // and changed back within this turn would be compared with what those dashboards were sent, found unchanged, and
      // the snapshot would keep its intermediate value.
      if (scheduled) {
        clearImmediate(scheduled);
        flush();
      }
      const catchUp = missed(lastEventId);
      if (catchUp) for (const batch of catchUp) response.write(batch.frame);
      else response.write(frame(epoch, seq, 'snapshot', snapshot()));
      streams.add(response);
      const timer = setInterval(() => response.write(': keepalive\n\n'), 15000);
      response.on('close', () => {
        clearInterval(timer);
        streams.delete(response);
      });
    },
    close() {
      closed = true;
      if (scheduled) clearImmediate(scheduled);
      scheduled = null;
      for (const stream of streams) stream.end();
    },
  };
}
