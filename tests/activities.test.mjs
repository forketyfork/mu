import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createApp, ROOT } from '../src/server.mjs';
import { main } from '../src/cli.mjs';
import { createActivities } from '../src/activities.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, listenLocal, temporaryMuHome } from './isolation.mjs';

class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
  }
  async start() {}
  async connect() {}
  close() {}
  async syncConversation() {}
  async send(from, text, conversationId) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId);
  }
}

async function team(t, dataDir) {
  dataDir ??= await shortTempDir(t, 'activities');
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir,
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
    platform: 'darwin',
  });
  await app.start();
  t.after(() => app.close());
  const as = (headers) => async (method, path, data) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const user = as(userHeaders(app));
  const turn = (id) => as({ 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue(id)}` });
  if (!app.store.agent('lead')) {
    for (const body of [
      { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' },
      { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [], sourceConversationId: 'dm-lead' },
    ])
      assert.equal((await user('POST', body.kind ? '/api/conversations' : '/api/agents', body)).status, 201);
    assert.equal(
      (
        await user('POST', '/api/agents', {
          id: 'worker',
          role: 'worker',
          adapter: 'claude',
          cwd: ROOT,
          task: '',
          conversationId: 'work',
          from: 'lead',
        })
      ).status,
      201,
    );
    app.store.updateAgent('worker', { status: 'stopped' });
  }
  const task = async (title) =>
    (await user('POST', '/api/tasks', { title, conversationId: 'work', agentIds: ['worker'], from: 'lead' })).body;
  return { app, user, lead: turn('lead'), worker: turn('worker'), task, port, dataDir };
}

const texts = (activities, lane) =>
  activities.filter((item) => item.lane === lane && !item.checkedAt).map((item) => item.text);

test('the user and the lead change activities, workers cannot, and everyone can read them', async (t) => {
  const { app, user, lead, worker } = await team(t);
  const made = await lead('POST', '/api/activities', { text: 'Decide on the release' });
  assert.equal(made.status, 201);
  assert.match(made.body.id, /^act-[a-f0-9]{8}$/);
  assert.deepEqual(
    { ...made.body, id: undefined, createdAt: undefined },
    {
      id: undefined,
      text: 'Decide on the release',
      lane: 'focus',
      position: 1,
      createdAt: undefined,
      checkedAt: null,
      taskIds: [],
    },
  );
  const userActivity = await user('POST', '/api/activities', { text: 'Wait for the audit', lane: 'control' });
  assert.equal(userActivity.status, 201);
  assert.equal(userActivity.body.lane, 'control');

  const id = made.body.id;
  assert.equal((await worker('POST', '/api/activities', { text: 'Worker adds' })).status, 403);
  assert.equal((await worker('PATCH', `/api/activities/${id}`, { text: 'Worker edits' })).status, 403);
  assert.equal((await worker('POST', `/api/activities/${id}/tasks`, { taskId: 'x' })).status, 403);
  assert.equal((await worker('DELETE', `/api/activities/${id}/tasks/x`, {})).status, 403);
  assert.equal(
    (await worker('POST', '/api/activities', { text: 'Worker acts as the lead', from: 'lead' })).status,
    403,
  );
  assert.equal((await user('POST', '/api/activities', { text: 'user acts as a worker', from: 'worker' })).status, 403);
  assert.deepEqual(
    app.activities.list().map((item) => item.text),
    ['Decide on the release', 'Wait for the audit'],
  );
  for (const read of [user, lead, worker])
    assert.deepEqual(
      (await read('GET', '/api/activities')).body.map((item) => item.text),
      ['Decide on the release', 'Wait for the audit'],
    );
  assert.deepEqual(
    (await user('GET', '/api/state')).body.activities.map((item) => item.id),
    [id, userActivity.body.id],
  );
});

test('activity text is one line of 1 to 200 characters, and the lane is focus or control', async (t) => {
  const { app, lead } = await team(t);
  for (const body of [
    {},
    { text: '   ' },
    { text: 7 },
    { text: 'x'.repeat(201) },
    { text: 'Two\nlines' },
    { text: 'Fine', lane: 'elsewhere' },
    { text: 'Fine', taskIds: 'task-1' },
  ])
    assert.equal((await lead('POST', '/api/activities', body)).status, 400, JSON.stringify(body));
  assert.deepEqual(app.activities.list(), []);
  const made = await lead('POST', '/api/activities', { text: '  Padded  ' });
  assert.equal(made.body.text, 'Padded');
  const edit = (body) => lead('PATCH', `/api/activities/${made.body.id}`, body);
  assert.equal((await edit({ text: '' })).status, 400);
  assert.equal((await edit({})).status, 400);
  assert.equal((await edit({ from: 'lead' })).status, 400);
  assert.equal((await edit({ lane: 'elsewhere' })).status, 400);
  assert.equal((await edit({ position: 0 })).status, 400);
  assert.equal((await edit({ position: 1.5 })).status, 400);
  assert.equal((await edit({ checked: 'yes' })).status, 400);
  assert.equal((await edit({ id: 'act-00000000' })).status, 400);
  assert.equal((await edit({ checked: true, lane: 'control' })).status, 400);
  assert.equal((await lead('PATCH', '/api/activities/act-00000000', { text: 'x' })).status, 404);
  assert.equal((await edit({ text: 'Renamed' })).body.text, 'Renamed');
});

test('activities keep a contiguous order per lane and move between lanes', async (t) => {
  const { app, lead } = await team(t);
  const add = async (text, lane) => (await lead('POST', '/api/activities', { text, lane })).body;
  const [a, b, c] = [await add('A', 'focus'), await add('B', 'focus'), await add('C', 'focus')];
  const [x, y] = [await add('X', 'control'), await add('Y', 'control')];
  const move = (item, body) => lead('PATCH', `/api/activities/${item.id}`, body);

  assert.deepEqual(texts(app.activities.list(), 'focus'), ['A', 'B', 'C']);
  await move(c, { position: 1 });
  assert.deepEqual(texts(app.activities.list(), 'focus'), ['C', 'A', 'B']);
  await move(c, { position: 99 });
  assert.deepEqual(texts(app.activities.list(), 'focus'), ['A', 'B', 'C']);

  await move(a, { lane: 'control', position: 2 });
  assert.deepEqual(texts(app.activities.list(), 'focus'), ['B', 'C']);
  assert.deepEqual(texts(app.activities.list(), 'control'), ['X', 'A', 'Y']);
  await move(b, { lane: 'control' });
  assert.deepEqual(texts(app.activities.list(), 'control'), ['X', 'A', 'Y', 'B']);
  assert.deepEqual(
    app.activities.list().map((item) => [item.text, item.position]),
    [
      ['C', 1],
      ['X', 1],
      ['A', 2],
      ['Y', 3],
      ['B', 4],
    ],
  );
  assert.equal(x.position + y.position, 3);
});

test('checking off moves an activity to the archive, and unchecking puts it at the end of its lane', async (t) => {
  const { app, lead } = await team(t);
  const add = async (text) => (await lead('POST', '/api/activities', { text })).body;
  const [a, b, c] = [await add('A'), await add('B'), await add('C')];
  const checked = await lead('PATCH', `/api/activities/${b.id}`, { checked: true });
  assert.equal(checked.status, 200);
  assert.ok(checked.body.checkedAt);
  assert.deepEqual(
    app.activities.list().map((item) => [item.text, item.position, Boolean(item.checkedAt)]),
    [
      ['A', 1, false],
      ['C', 2, false],
      ['B', 0, true],
    ],
  );
  assert.deepEqual(
    (await lead('GET', '/api/activities')).body.map((item) => item.text),
    ['A', 'C'],
  );
  assert.deepEqual(
    (await lead('GET', '/api/activities?include=checked')).body.map((item) => item.text),
    ['A', 'C', 'B'],
  );
  assert.equal((await lead('PATCH', `/api/activities/${b.id}`, { lane: 'control' })).status, 409);
  assert.equal((await lead('POST', `/api/activities/${b.id}/tasks`, { taskId: 'task-x' })).status, 409);
  assert.equal((await lead('PATCH', `/api/activities/${b.id}`, { text: 'B renamed' })).status, 200);

  const restored = await lead('PATCH', `/api/activities/${b.id}`, { checked: false });
  assert.equal(restored.body.checkedAt, null);
  assert.deepEqual(texts(app.activities.list(), 'focus'), ['A', 'C', 'B renamed']);
  assert.equal(a.position, 1);
  assert.equal(c.position, 3);
});

test('a task belongs to at most one activity; linking again moves it, and verified tasks can be linked', async (t) => {
  const { app, user, lead, task } = await team(t);
  const [one, two] = [await task('First task'), await task('Second task')];
  const a = (await lead('POST', '/api/activities', { text: 'A', taskIds: [one.id] })).body;
  const b = (await lead('POST', '/api/activities', { text: 'B', lane: 'control' })).body;
  assert.deepEqual(a.taskIds, [one.id]);

  assert.equal((await lead('POST', `/api/activities/${a.id}/tasks`, { taskId: two.id })).status, 200);
  assert.deepEqual(app.activities.list().find((item) => item.id === a.id).taskIds, [one.id, two.id]);
  const moved = await lead('POST', `/api/activities/${b.id}/tasks`, { taskId: one.id });
  assert.deepEqual(moved.body.taskIds, [one.id]);
  assert.deepEqual(app.activities.list().find((item) => item.id === a.id).taskIds, [two.id]);

  assert.equal((await lead('POST', `/api/activities/${a.id}/tasks`, { taskId: 'no-such-task' })).status, 404);
  assert.equal((await lead('POST', `/api/activities/${a.id}/tasks`, {})).status, 400);
  assert.equal((await lead('POST', '/api/activities', { text: 'C', taskIds: ['no-such-task'] })).status, 404);
  assert.equal(app.activities.list().length, 2);

  assert.equal((await lead('PATCH', `/api/tasks/${two.id}`, { status: 'ready', result: 'Done' })).status, 200);
  assert.equal((await user('POST', `/api/tasks/${two.id}/verify`, {})).status, 200);
  const relinked = await user('POST', `/api/activities/${b.id}/tasks`, { taskId: two.id });
  assert.deepEqual(relinked.body.taskIds, [one.id, two.id]);

  assert.equal((await lead('DELETE', `/api/activities/${a.id}/tasks/${one.id}`, {})).status, 404);
  const unlinked = await lead('DELETE', `/api/activities/${b.id}/tasks/${one.id}`, {});
  assert.deepEqual(unlinked.body.taskIds, [two.id]);
  assert.equal((await lead('DELETE', `/api/activities/${b.id}/tasks/${one.id}`, {})).status, 404);
});

test('a failed create leaves nothing behind and links survive checking off', async (t) => {
  const { app, lead, task } = await team(t);
  const one = await task('First task');
  assert.equal((await lead('POST', '/api/activities', { text: 'Half', taskIds: [one.id, 'ghost'] })).status, 404);
  assert.deepEqual(app.activities.list(), []);
  const a = (await lead('POST', '/api/activities', { text: 'A', taskIds: [one.id] })).body;
  await lead('PATCH', `/api/activities/${a.id}`, { checked: true });
  assert.deepEqual(app.activities.list()[0].taskIds, [one.id]);
});

test('activities and links survive a restart, and a database from before activities gets the tables', async (t) => {
  const dataDir = await shortTempDir(t, 'activities-restart');
  const first = await team(t, dataDir);
  const one = await first.task('First task');
  const a = (await first.lead('POST', '/api/activities', { text: 'Kept', lane: 'control', taskIds: [one.id] })).body;
  await first.lead('POST', '/api/activities', { text: 'Done', lane: 'focus' });
  const done = first.app.activities.list().find((item) => item.text === 'Done');
  await first.lead('PATCH', `/api/activities/${done.id}`, { checked: true });
  const before = first.app.activities.list();
  await first.app.close();

  const second = await team(t, dataDir);
  assert.deepEqual(second.app.activities.list(), before);
  assert.equal(second.app.activities.list()[0].id, a.id);

  second.app.store.db.exec('DROP TABLE activities; DROP TABLE activity_tasks');
  assert.deepEqual(createActivities({ store: second.app.store, tasks: second.app.tasks }).list(), []);
  const migrated = createActivities({ store: second.app.store, tasks: second.app.tasks });
  assert.equal(migrated.add({ text: 'Fresh' }, 'user').position, 1);
});

test('the CLI sends activity commands as the calling agent', async (t) => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const port = await listenLocal(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { MU_URL: `http://127.0.0.1:${port}`, MU_AGENT_ID: 'lead', MU_TOKEN: 'a'.repeat(64) };
  await main(
    ['activity', 'add', '--text', 'Decide on the release', '--lane', 'control', '--task-ids', 'task-1,task-2'],
    env,
  );
  await main(['activity', 'add', '--text', 'Plain'], env);
  await main(['activity', 'list'], env);
  await main(['activity', 'list', '--include-checked'], env);
  await main(
    ['activity', 'edit', '--id', 'act-1a2b3c4d', '--text', 'New text', '--lane', 'focus', '--position', '2'],
    env,
  );
  await main(['activity', 'check', '--id', 'act-1a2b3c4d'], env);
  await main(['activity', 'uncheck', '--id', 'act-1a2b3c4d'], env);
  await main(['activity', 'link', '--id', 'act-1a2b3c4d', '--task-id', 'task-42'], env);
  await main(['activity', 'unlink', '--id', 'act-1a2b3c4d', '--task-id', 'task-42'], env);
  await main(['activity', 'history', '--id', 'act-1a2b3c4d'], env);
  await main(['activity', 'delete', '--id', 'act-1a2b3c4d'], env);
  const id = '/api/activities/act-1a2b3c4d';
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/api/activities',
      body: { text: 'Decide on the release', lane: 'control', taskIds: ['task-1', 'task-2'], from: 'lead' },
    },
    { method: 'POST', path: '/api/activities', body: { text: 'Plain', from: 'lead' } },
    { method: 'GET', path: '/api/activities', body: undefined },
    { method: 'GET', path: '/api/activities?include=checked', body: undefined },
    { method: 'PATCH', path: id, body: { from: 'lead', text: 'New text', lane: 'focus', position: 2 } },
    { method: 'PATCH', path: id, body: { checked: true, from: 'lead' } },
    { method: 'PATCH', path: id, body: { checked: false, from: 'lead' } },
    { method: 'POST', path: `${id}/tasks`, body: { taskId: 'task-42', from: 'lead' } },
    { method: 'DELETE', path: `${id}/tasks/task-42`, body: { from: 'lead' } },
    { method: 'GET', path: `${id}/history`, body: undefined },
    { method: 'DELETE', path: id, body: { from: 'lead' } },
  ]);
  await assert.rejects(main(['activity', 'edit', '--id', 'act-1a2b3c4d'], env), /Provide --text/);
  await assert.rejects(main(['activity', 'edit', '--id', 'act-1a2b3c4d', '--position', 'top'], env), /--position/);
  await assert.rejects(main(['activity', 'add'], env), /--text/);
});

const kinds = (events) => events.map((event) => [event.kind, event.fromLane, event.lane]);

test('every activity keeps its creation, lane moves and check-offs, in order, for later reports', async (t) => {
  const { app, user, lead } = await team(t);
  const a = (await lead('POST', '/api/activities', { text: 'A', lane: 'control' })).body;
  const b = (await lead('POST', '/api/activities', { text: 'B', lane: 'control' })).body;
  const patch = (item, body) => user('PATCH', `/api/activities/${item.id}`, body);
  await patch(a, { lane: 'focus' });
  await patch(a, { position: 1 });
  await patch(a, { lane: 'focus', position: 1 });
  await patch(a, { text: 'A renamed' });
  await patch(a, { lane: 'control' });
  const checkedAt = (await patch(a, { checked: true })).body.checkedAt;
  await patch(a, { checked: false });
  await patch(a, { lane: 'focus' });
  assert.deepEqual(kinds(app.activities.history(a.id)), [
    ['created', null, 'control'],
    ['moved', 'control', 'focus'],
    ['moved', 'focus', 'control'],
    ['checked', null, null],
    ['unchecked', null, null],
    ['moved', 'control', 'focus'],
  ]);
  assert.deepEqual(kinds(app.activities.history(b.id)), [['created', null, 'control']]);
  const events = (await lead('GET', `/api/activities/${a.id}/history`)).body;
  assert.deepEqual(events, app.activities.history(a.id));
  assert.deepEqual(
    events.map((event) => event.at),
    [...events.map((event) => event.at)].sort(),
  );
  assert.equal(events[0].at, app.activities.list().find((item) => item.id === a.id).createdAt);
  assert.equal(events[3].at, checkedAt);
  assert.equal((await lead('GET', '/api/activities/act-00000000/history')).status, 404);
});

test('the user and the lead delete an activity; it leaves the lists, frees its tasks and keeps its history', async (t) => {
  const { app, user, lead, worker, task } = await team(t);
  const one = await task('First task');
  const make = async (text, extra = {}) => (await lead('POST', '/api/activities', { text, ...extra })).body;
  const first = await make('First', { taskIds: [one.id] });
  const second = await make('Second');
  const third = await make('Third');
  assert.equal((await worker('DELETE', `/api/activities/${first.id}`, {})).status, 403);
  assert.equal(app.activities.list().length, 3);

  assert.equal((await user('DELETE', `/api/activities/${first.id}`, {})).status, 200);
  assert.deepEqual(
    app.activities.list().map((item) => [item.text, item.position]),
    [
      ['Second', 1],
      ['Third', 2],
    ],
  );
  assert.deepEqual(
    (await user('GET', '/api/state')).body.activities.map((item) => item.text),
    ['Second', 'Third'],
  );
  assert.equal((await lead('DELETE', `/api/activities/${first.id}`, {})).status, 404);
  assert.equal((await lead('PATCH', `/api/activities/${first.id}`, { text: 'Back' })).status, 404);
  assert.equal((await lead('POST', `/api/activities/${first.id}/tasks`, { taskId: one.id })).status, 404);
  assert.deepEqual(kinds(app.activities.history(first.id)), [
    ['created', null, 'focus'],
    ['deleted', null, null],
  ]);
  assert.equal(
    app.store.db.prepare('SELECT COUNT(*) AS count FROM activity_tasks').get().count,
    0,
    'the task is free to link elsewhere',
  );
  assert.equal((await lead('POST', `/api/activities/${second.id}/tasks`, { taskId: one.id })).status, 200);

  await lead('PATCH', `/api/activities/${third.id}`, { checked: true });
  assert.equal((await lead('DELETE', `/api/activities/${third.id}`, {})).status, 200);
  assert.deepEqual(
    (await lead('GET', '/api/activities?include=checked')).body.map((item) => item.text),
    ['Second'],
  );
});

test('activities from before the history was kept get their creation and check-off events once', async (t) => {
  const dataDir = await shortTempDir(t, 'activities-backfill');
  const first = await team(t, dataDir);
  const kept = (await first.lead('POST', '/api/activities', { text: 'Kept', lane: 'control' })).body;
  const done = (await first.lead('POST', '/api/activities', { text: 'Done' })).body;
  await first.lead('PATCH', `/api/activities/${done.id}`, { checked: true });
  const checkedAt = first.app.activities.list().find((item) => item.id === done.id).checkedAt;
  first.app.store.db.exec('DROP TABLE activity_events; ALTER TABLE activities DROP COLUMN deletedAt');
  const store = first.app.store;
  const reopened = createActivities({ store, tasks: first.app.tasks });
  assert.deepEqual(
    reopened.list().map((item) => item.text),
    ['Kept', 'Done'],
  );
  assert.deepEqual(kinds(reopened.history(kept.id)), [['created', null, 'control']]);
  assert.deepEqual(reopened.history(done.id), [
    { at: done.createdAt, kind: 'created', lane: 'focus', fromLane: null },
    { at: checkedAt, kind: 'checked', lane: null, fromLane: null },
  ]);
  const again = createActivities({ store, tasks: first.app.tasks });
  assert.equal(again.history(done.id).length, 2, 'a second start adds nothing');
});
