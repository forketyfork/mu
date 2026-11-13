import { randomUUID } from 'node:crypto';
import { httpError as bad } from './http-error.mjs';

const MAX_TEXT = 200;
// Cards are read as plain sentences. A reference the user cannot resolve at a glance defeats the list.
const REFERENCE = /#\d+|https?:\/\//i;

export function createWaiting({ store, tasks }) {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS waiting (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt TEXT NOT NULL)',
  );
  // A card without a task has a null taskId and shows no task icon.
  if (
    !store.db
      .prepare('PRAGMA table_info(waiting)')
      .all()
      .some((column) => column.name === 'taskId')
  )
    store.db.exec('ALTER TABLE waiting ADD COLUMN taskId TEXT');
  const list = () => store.db.prepare('SELECT id, text, taskId, createdAt FROM waiting ORDER BY rowid').all();
  const lead = (from) => {
    if (store.agent(from)?.role !== 'lead')
      throw bad('Only the team lead changes the waiting list; the user reads and clicks its cards', 403);
  };
  const plain = (value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT)
      throw bad(`text must be 1–${MAX_TEXT} characters of plain words`);
    const text = value.trim();
    if (/[\r\n]/.test(text)) throw bad('text must be a single line');
    if (REFERENCE.test(text)) throw bad('Card text uses words only: no PR numbers or links');
    const lowered = text.toLowerCase();
    for (const task of tasks.list()) {
      if (lowered.includes(task.id)) throw bad(`Card text uses words only: it contains the task ID ${task.id}`);
    }
    return text;
  };
  const add = (input, from) => {
    lead(from);
    const text = plain(input.text);
    // A link is optional because some decisions concern no single task. A given ID must name a task that can still be blocked.
    let taskId = null;
    if (input.taskId !== undefined && input.taskId !== null) {
      if (typeof input.taskId !== 'string' || !input.taskId) throw bad('taskId must be a task ID');
      const task = tasks.get(input.taskId);
      if (task.status === 'verified') throw bad(`Task ${task.id} is verified, so nothing it needs is blocked`, 409);
      taskId = task.id;
    }
    const card = { id: `wait-${randomUUID().slice(0, 8)}`, text, taskId, createdAt: new Date().toISOString() };
    store.db
      .prepare('INSERT INTO waiting (id,text,taskId,createdAt) VALUES (?,?,?,?)')
      .run(card.id, card.text, card.taskId, card.createdAt);
    store.changed(['waiting', card.id]);
    return card;
  };
  const remove = (id, from) => {
    lead(from);
    if (!store.db.prepare('DELETE FROM waiting WHERE id=?').run(id).changes)
      throw bad(`Unknown waiting card ${id}`, 404);
    store.changed(['waiting', id]);
    return { ok: true };
  };
  const handle = async ({ request, response, pathname, body, send, actor }) => {
    const match = pathname.match(/^\/api\/waiting(?:\/(wait-[a-f0-9]{8}))?$/);
    if (!match) return false;
    const [, id] = match;
    if (request.method === 'GET' && !id) {
      send(response, 200, list());
      return true;
    }
    if (request.method === 'POST' && !id) {
      const input = await body(request);
      send(response, 201, add(input, actor(request, input)));
      return true;
    }
    if (request.method === 'DELETE' && id) {
      const input = await body(request);
      send(response, 200, remove(id, actor(request, input)));
      return true;
    }
    throw bad('Unsupported waiting-list operation', 405);
  };
  return { list, add, remove, handle };
}
