import { randomUUID } from 'node:crypto';
import { httpError as bad } from './http-error.mjs';

const MAX_TEXT = 200;
export const LANES = ['focus', 'control'];

export function createActivities({ store, tasks }) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      lane TEXT NOT NULL,
      position INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      checkedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS activity_tasks (
      taskId TEXT PRIMARY KEY,
      activityId TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activityId TEXT NOT NULL,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      lane TEXT,
      fromLane TEXT
    );`);
  // Deleting hides an activity and keeps its row and history, which later reports draw on.
  if (
    !store.db
      .prepare('PRAGMA table_info(activities)')
      .all()
      .some((column) => column.name === 'deletedAt')
  )
    store.db.exec('ALTER TABLE activities ADD COLUMN deletedAt TEXT');
  // Activities from before the history was kept get the events their record still proves. Their lane at creation
  // is unknown, so the current lane stands in for it.
  store.db.exec(`
    INSERT INTO activity_events (activityId,at,kind,lane)
      SELECT id, createdAt, 'created', lane FROM activities
      WHERE NOT EXISTS (SELECT 1 FROM activity_events WHERE activityId=activities.id AND kind='created');
    INSERT INTO activity_events (activityId,at,kind)
      SELECT id, checkedAt, 'checked' FROM activities
      WHERE checkedAt IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM activity_events WHERE activityId=activities.id AND kind IN ('checked','unchecked'));`);

  const columns = 'id, text, lane, position, createdAt, checkedAt';
  const rows = () => store.db.prepare(`SELECT ${columns} FROM activities WHERE deletedAt IS NULL`).all();
  const record = (activityId, kind, at, { lane: toLane = null, fromLane = null } = {}) =>
    store.db
      .prepare('INSERT INTO activity_events (activityId,at,kind,lane,fromLane) VALUES (?,?,?,?,?)')
      .run(activityId, at, kind, toLane, fromLane);
  const linked = () => store.db.prepare('SELECT taskId, activityId FROM activity_tasks ORDER BY rowid').all();
  // Open activities come first, ordered by position within their lane; checked-off ones follow, the most recent first.
  const list = ({ checked = true } = {}) => {
    const links = linked();
    const activities = rows().map((row) => ({
      ...row,
      taskIds: links.filter((link) => link.activityId === row.id).map((link) => link.taskId),
    }));
    return activities
      .filter((activity) => checked || !activity.checkedAt)
      .sort(
        (a, b) =>
          Number(Boolean(a.checkedAt)) - Number(Boolean(b.checkedAt)) ||
          (a.checkedAt && b.checkedAt ? b.checkedAt.localeCompare(a.checkedAt) : a.position - b.position),
      );
  };
  const get = (id) => {
    const row = store.db.prepare(`SELECT ${columns} FROM activities WHERE id=? AND deletedAt IS NULL`).get(id);
    if (!row) throw bad(`Unknown activity ${id}`, 404);
    return row;
  };
  const view = (id) => list().find((activity) => activity.id === id);
  const editor = (from) => {
    if (from !== 'user' && store.agent(from)?.role !== 'lead')
      throw bad('Only the user and the team lead change activities', 403);
  };
  const plain = (value) => {
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT)
      throw bad(`text must be 1–${MAX_TEXT} characters`);
    if (/[\r\n]/.test(value)) throw bad('text must be a single line');
    return value.trim();
  };
  const lane = (value) => {
    if (!LANES.includes(value)) throw bad(`lane must be one of: ${LANES.join(', ')}`);
    return value;
  };
  const openIn = (name, except) =>
    rows()
      .filter((row) => row.lane === name && !row.checkedAt && row.id !== except)
      .sort((a, b) => a.position - b.position);
  // Positions stay contiguous from 1 in each lane, so a move is an insert followed by a renumbering.
  const renumber = (ids) => {
    const update = store.db.prepare('UPDATE activities SET position=? WHERE id=?');
    ids.forEach((id, index) => update.run(index + 1, id));
  };
  const place = (id, name, position) => {
    const ids = openIn(name, id).map((row) => row.id);
    ids.splice(position === undefined ? ids.length : Math.min(position, ids.length + 1) - 1, 0, id);
    store.db.prepare('UPDATE activities SET lane=? WHERE id=?').run(name, id);
    renumber(ids);
  };
  const positionOf = (value) => {
    if (!Number.isInteger(value) || value < 1) throw bad('position must be a positive integer, 1 being the top');
    return value;
  };
  const taskIdsOf = (value) => {
    if (!Array.isArray(value) || value.length > 50 || !value.every((id) => typeof id === 'string'))
      throw bad('taskIds must be an array of at most 50 task IDs');
    return [...new Set(value)].map((id) => tasks.get(id).id);
  };
  const attach = (activityId, taskId) =>
    store.db
      .prepare(
        'INSERT INTO activity_tasks (taskId,activityId) VALUES (?,?) ON CONFLICT(taskId) DO UPDATE SET activityId=excluded.activityId',
      )
      .run(taskId, activityId);

  const add = (input, from) => {
    editor(from);
    const text = plain(input.text);
    const name = input.lane === undefined ? 'focus' : lane(input.lane);
    const taskIds = input.taskIds === undefined ? [] : taskIdsOf(input.taskIds);
    const id = `act-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    store.transaction(() => {
      store.db
        .prepare('INSERT INTO activities (id,text,lane,position,createdAt,checkedAt) VALUES (?,?,?,?,?,NULL)')
        .run(id, text, name, openIn(name).length + 1, now);
      record(id, 'created', now, { lane: name });
      for (const taskId of taskIds) attach(id, taskId);
      store.changed(['activities', null]);
    });
    return view(id);
  };

  const update = (id, input, from) => {
    editor(from);
    const current = get(id);
    const allowed = new Set(['from', 'text', 'lane', 'position', 'checked']);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw bad(`Activity field ${key} cannot be changed`);
    if (Object.keys(input).every((key) => key === 'from')) throw bad('Provide an activity field to change');
    if (input.checked !== undefined && typeof input.checked !== 'boolean') throw bad('checked must be true or false');
    const moving = input.lane !== undefined || input.position !== undefined;
    if (moving && input.checked !== undefined) throw bad('Check off or move an activity in separate changes');
    if (moving && current.checkedAt) throw bad('A checked-off activity must be restored before it moves', 409);
    const text = input.text === undefined ? undefined : plain(input.text);
    const target = input.lane === undefined ? current.lane : lane(input.lane);
    const position = input.position === undefined ? undefined : positionOf(input.position);
    const now = new Date().toISOString();
    store.transaction(() => {
      if (text !== undefined) store.db.prepare('UPDATE activities SET text=? WHERE id=?').run(text, id);
      if (moving) {
        place(id, target, position);
        if (current.lane !== target) {
          renumber(openIn(current.lane).map((row) => row.id));
          record(id, 'moved', now, { lane: target, fromLane: current.lane });
        }
      }
      if (input.checked === true && !current.checkedAt) {
        store.db.prepare('UPDATE activities SET checkedAt=?, position=0 WHERE id=?').run(now, id);
        renumber(openIn(current.lane).map((row) => row.id));
        record(id, 'checked', now);
      } else if (input.checked === false && current.checkedAt) {
        store.db.prepare('UPDATE activities SET checkedAt=NULL WHERE id=?').run(id);
        place(id, current.lane);
        record(id, 'unchecked', now);
      }
      store.changed(['activities', null]);
    });
    return view(id);
  };

  const link = (id, taskId, from) => {
    editor(from);
    const activity = get(id);
    if (activity.checkedAt) throw bad('A checked-off activity takes no new tasks; restore it first', 409);
    const task = tasks.get(taskId);
    store.transaction(() => {
      attach(id, task.id);
      store.changed(['activities', null]);
    });
    return view(id);
  };
  const unlink = (id, taskId, from) => {
    editor(from);
    get(id);
    store.transaction(() => {
      if (!store.db.prepare('DELETE FROM activity_tasks WHERE taskId=? AND activityId=?').run(taskId, id).changes)
        throw bad(`Task ${taskId} is not linked to activity ${id}`, 404);
      store.changed(['activities', null]);
    });
    return view(id);
  };

  const remove = (id, from) => {
    editor(from);
    const current = get(id);
    const now = new Date().toISOString();
    store.transaction(() => {
      store.db.prepare('UPDATE activities SET deletedAt=?, position=0 WHERE id=?').run(now, id);
      store.db.prepare('DELETE FROM activity_tasks WHERE activityId=?').run(id);
      if (!current.checkedAt) renumber(openIn(current.lane).map((row) => row.id));
      record(id, 'deleted', now);
      store.changed(['activities', null]);
    });
    return { ok: true };
  };
  // The record of what happened to an activity, oldest first; it also answers for a deleted activity.
  const history = (id) => {
    if (!store.db.prepare('SELECT 1 FROM activities WHERE id=?').get(id)) throw bad(`Unknown activity ${id}`, 404);
    return store.db
      .prepare('SELECT at, kind, lane, fromLane FROM activity_events WHERE activityId=? ORDER BY id')
      .all(id)
      .map((row) => ({ ...row }));
  };

  const handle = async ({ request, response, pathname, body, send, actor }) => {
    const match = pathname.match(
      /^\/api\/activities(?:\/(act-[a-f0-9]{8})(?:\/(history)|\/(tasks)(?:\/([a-z][a-z0-9-]{0,47}))?)?)?$/,
    );
    if (!match) return false;
    const [, id, history_, tasksPath, taskId] = match;
    const { method } = request;
    if (!id) {
      if (method === 'GET') {
        const checked = new URL(request.url, 'http://mu').searchParams.get('include') === 'checked';
        send(response, 200, list({ checked }));
        return true;
      }
      if (method === 'POST') {
        const input = await body(request);
        send(response, 201, add(input, actor(request, input)));
        return true;
      }
    } else if (history_) {
      if (method === 'GET') {
        send(response, 200, history(id));
        return true;
      }
    } else if (!tasksPath) {
      if (method === 'PATCH') {
        const input = await body(request);
        send(response, 200, update(id, input, actor(request, input)));
        return true;
      }
      if (method === 'DELETE') {
        const input = await body(request);
        send(response, 200, remove(id, actor(request, input)));
        return true;
      }
    } else if (!taskId && method === 'POST') {
      const input = await body(request);
      if (typeof input.taskId !== 'string' || !input.taskId) throw bad('taskId must be a task ID');
      send(response, 200, link(id, input.taskId, actor(request, input)));
      return true;
    } else if (taskId && method === 'DELETE') {
      const input = await body(request);
      send(response, 200, unlink(id, taskId, actor(request, input)));
      return true;
    }
    throw bad('Unsupported activity operation', 405);
  };
  return { list, add, update, link, unlink, remove, history, handle };
}
