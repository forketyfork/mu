import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { main } from '../src/cli.mjs';
import { listenLocal } from './isolation.mjs';

/** @param {unknown} [response] */
async function fixture(t, response = { ok: true }, status = 200) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  const port = await listenLocal(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, env: { MU_URL: `http://127.0.0.1:${port}`, MU_AGENT_ID: 'lead', MU_TOKEN: 'a'.repeat(64) } };
}

test('spawns an agent with the supplied role, cwd, and literal task', async (t) => {
  const { calls, env } = await fixture(t);
  await main(
    [
      'spawn',
      '--id',
      'worker-one',
      '--adapter',
      'claude',
      '--cwd',
      '.',
      '--task',
      'Inspect $(echo unsafe) literally',
      '--conversation',
      'issue-42',
      '--task-id',
      'task-42',
    ],
    env,
  );
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/api/agents',
      body: {
        from: 'lead',
        id: 'worker-one',
        role: 'worker',
        adapter: 'claude',
        cwd: process.cwd(),
        task: 'Inspect $(echo unsafe) literally',
        conversationId: 'issue-42',
        taskId: 'task-42',
      },
    },
  ]);
});

test('chat messages preserve identity and mention text', async (t) => {
  const { calls, env } = await fixture(t);
  await main(['say', '@worker-one', 'What is the status?'], env);
  await main(['say', '--from', 'user', '@lead New request'], env);
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      { from: 'lead', conversationId: 'common', text: '@worker-one What is the status?' },
      { from: 'user', conversationId: 'common', text: '@lead New request' },
    ],
  );
});

test('self-registration works when the shell already contains the new identity', async (t) => {
  const { calls, env } = await fixture(t);
  await main(
    [
      'register',
      '--id',
      'lead',
      '--role',
      'lead',
      '--adapter',
      'manual',
      '--cwd',
      '.',
      '--task',
      'Coordinate requests',
    ],
    env,
  );
  assert.equal(calls[0].body.from, 'user');
});

test('inbox waits and exact message acknowledgments use the current agent', async (t) => {
  const { calls, env } = await fixture(t, { messages: [] });
  await main(['inbox', '--wait', '25'], env);
  await main(['ack', '--message', '42'], env);
  assert.deepEqual(calls, [
    { method: 'GET', path: '/api/agents/lead/inbox?wait=25', body: undefined },
    { method: 'POST', path: '/api/agents/lead/ack', body: { id: 42 } },
  ]);
});

test('invalid acknowledgment and wait values fail before contacting the service', async (t) => {
  const { calls, env } = await fixture(t);
  await assert.rejects(main(['ack', '--message', '1.5'], env), /must be an integer/);
  await assert.rejects(main(['inbox', '--wait', '26'], env), /between 0 and 25/);
  await assert.rejects(main(['ack', '--message', '42', '--unknown', 'value'], env), /Unknown option/);
  assert.equal(calls.length, 0);
});

test('service failures remain visible to the caller', async (t) => {
  const { env } = await fixture(t, { error: 'IRC transport is disconnected' }, 503);
  await assert.rejects(main(['say', '@lead Hello'], env), /IRC transport is disconnected/);
});

test('status updates and stops address the requested agent', async (t) => {
  const { calls, env } = await fixture(t);
  await main(['status', '--id', 'worker-two', '--status', 'blocked', '--task', 'Awaiting input'], env);
  await main(['stop', '--id', 'worker-two'], env);
  assert.deepEqual(calls, [
    {
      method: 'PATCH',
      path: '/api/agents/worker-two',
      body: { from: 'lead', status: 'blocked', task: 'Awaiting input' },
    },
    { method: 'POST', path: '/api/agents/worker-two/stop', body: { from: 'lead' } },
  ]);
});

test('configure changes an existing identity through the registry', async (t) => {
  const { calls, env } = await fixture(t);
  await main(['configure', '--id', 'lead', '--adapter', 'claude', '--cwd', '.'], env);
  assert.deepEqual(calls, [
    { method: 'PATCH', path: '/api/agents/lead', body: { from: 'lead', adapter: 'claude', cwd: process.cwd() } },
  ]);
});

test('messages stay in the inherited conversation unless explicitly routed elsewhere', async (t) => {
  const { calls, env } = await fixture(t);
  env.MU_CONVERSATION_ID = 'issue-42';
  await main(['say', '@worker-one What is the status?'], env);
  await main(['say', '--conversation', 'dm-lead', '@user I have a question'], env);
  await main(['say', '--room', 'common', '@all Shared dependency notice'], env);
  assert.deepEqual(
    calls.map((call) => call.body.conversationId),
    ['issue-42', 'dm-lead', 'common'],
  );
  await assert.rejects(
    main(['say', '--room', 'common', '--conversation', 'dm-lead', 'Invalid routing'], env),
    /either/,
  );
  assert.equal(calls.length, 3);
});

test('a message to the managed turn’s own conversation returns a note about the final text', async (t) => {
  const { env } = await fixture(t, { id: 7, conversationId: 'issue-42' });
  const turn = { ...env, MU_CONVERSATION_ID: 'issue-42', MU_MESSAGE_ID: '5' };
  const own = await main(['say', 'The fix is merged'], turn);
  assert.equal(own.id, 7);
  assert.match(own.note, /Posted to issue-42.*final text of this turn is posted there too.*NO_REPLY/);
  assert.match((await main(['say', '--conversation', 'issue-42', 'Same room, named'], turn)).note, /NO_REPLY/);
  // A summary for another conversation, a message sent as someone else, and a shell outside a managed turn are not answers of this turn.
  assert.equal((await main(['say', '--conversation', 'dm-lead', '@user Summary'], turn)).note, undefined);
  assert.equal((await main(['say', '--from', 'user', 'From the user'], turn)).note, undefined);
  assert.equal((await main(['say', 'Manual shell'], { ...env, MU_CONVERSATION_ID: 'issue-42' })).note, undefined);
});

test('room creation, invitations, and assignment use explicit conversation membership', async (t) => {
  const { calls, env } = await fixture(t);
  await main(
    ['room', 'create', '--id', 'issue-42', '--name', 'Issue 42 investigation', '--members', 'lead,reviewer,lead'],
    env,
  );
  await main(['room', 'invite', '--conversation', 'issue-42', '--members', 'worker-one,worker-two'], env);
  await main(
    [
      'spawn',
      '--id',
      'worker-one',
      '--adapter',
      'codex',
      '--cwd',
      '.',
      '--task',
      'Investigate',
      '--conversation',
      'issue-42',
      '--task-id',
      'task-42',
    ],
    env,
  );
  await main(['room', 'list'], env);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/conversations',
    body: { kind: 'room', id: 'issue-42', name: 'Issue 42 investigation', members: ['lead', 'reviewer'], from: 'lead' },
  });
  assert.deepEqual(calls[1], {
    method: 'POST',
    path: '/api/conversations/issue-42/members',
    body: { members: ['worker-one', 'worker-two'], from: 'lead' },
  });
  assert.equal(calls[2].body.conversationId, 'issue-42');
  assert.equal(calls[3].path, '/api/conversations');
});

test('room origin and scoped history retain the user conversation without changing message routing', async (t) => {
  const { calls, env } = await fixture(t);
  env.MU_CONVERSATION_ID = 'dm-lead';
  await main(['room', 'create', '--name', 'Investigation'], env);
  await main(['room', 'create', '--name', 'Review', '--source-conversation', 'dm-reviewer'], env);
  await main(['history', '--conversation', 'issue-42', '--before', '55', '--limit', '20'], env);
  assert.equal(calls[0].body.sourceConversationId, 'dm-lead');
  assert.equal(calls[1].body.sourceConversationId, 'dm-reviewer');
  assert.equal(calls[2].path, '/api/conversations/issue-42/messages?limit=20&before=55');
});

test('task list asks for verified tasks only with --include-verified', async (t) => {
  const { calls, env } = await fixture(t);
  await main(['task', 'list'], env);
  await main(['task', 'list', '--include-verified'], env);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/tasks', '/api/tasks?include=verified'],
  );
});

test("task list --conversation keeps only that room's tasks", async (t) => {
  const tasks = [
    { id: 'task-1', conversationId: 'issue-42' },
    { id: 'task-2', conversationId: 'issue-43' },
  ];
  const { calls, env } = await fixture(t, tasks);
  assert.deepEqual(await main(['task', 'list'], env), tasks);
  assert.deepEqual(await main(['task', 'list', '--include-verified', '--conversation', 'issue-43'], env), [tasks[1]]);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/tasks', '/api/tasks?include=verified'],
  );
});

test('agents filters the registry by ID and by status', async (t) => {
  const registry = [
    { id: 'lead', status: 'idle' },
    { id: 'worker-one', status: 'working' },
    { id: 'worker-two', status: 'stopped' },
  ];
  const { calls, env } = await fixture(t, registry);
  assert.deepEqual(await main(['agents'], env), registry);
  assert.deepEqual(await main(['agents', '--id', 'worker-two, lead'], env), [registry[0], registry[2]]);
  assert.deepEqual(await main(['agents', '--status', 'working,idle'], env), [registry[0], registry[1]]);
  assert.deepEqual(await main(['agents', '--id', 'worker-two', '--status', 'working'], env), []);
  assert.ok(calls.every((call) => call.path === '/api/agents'));
});

test('history pages forward with --after and refuses both directions at once', async (t) => {
  const { calls, env } = await fixture(t);
  await main(['history', '--conversation', 'issue-42', '--after', '120', '--limit', '5'], env);
  await main(['history', '--conversation', 'issue-42', '--after', '0'], env);
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/conversations/issue-42/messages?limit=5&after=120',
      '/api/conversations/issue-42/messages?limit=300&after=0',
    ],
  );
  await assert.rejects(main(['history', '--before', '9', '--after', '3'], env), /either --before or --after/);
  await assert.rejects(main(['history', '--after', 'x'], env), /--after must be an integer/);
  assert.equal(calls.length, 2);
});

test('task lifecycle preserves assignment and actor identity without exposing agent verification', async (t) => {
  const { calls, env } = await fixture(t);
  env.MU_CONVERSATION_ID = 'dm-lead';
  await main(
    [
      'task',
      'create',
      '--title',
      'Investigate issue',
      '--description',
      '**Acceptance:** evidence',
      '--conversation',
      'issue-42',
      '--agents',
      'worker-one,reviewer',
    ],
    env,
  );
  await main(
    ['task', 'update', '--id', 'task-42', '--status', 'ready', '--result', '### Findings\nVerified by tests'],
    env,
  );
  await main(['task', 'retire', '--id', 'task-42'], env);
  assert.deepEqual(calls[0].body, {
    title: 'Investigate issue',
    description: '**Acceptance:** evidence',
    conversationId: 'issue-42',
    sourceConversationId: 'dm-lead',
    agentIds: ['worker-one', 'reviewer'],
    from: 'lead',
  });
  assert.deepEqual(calls[1], {
    method: 'PATCH',
    path: '/api/tasks/task-42',
    body: { from: 'lead', status: 'ready', result: '### Findings\nVerified by tests' },
  });
  assert.deepEqual(calls[2], { method: 'POST', path: '/api/tasks/task-42/retire', body: { from: 'lead' } });
  await assert.rejects(main(['task', 'verify', '--id', 'task-42'], env), /Unknown command/);
});

test('tracked worker launch and registry discovery do not need global chat history', async (t) => {
  const { calls, env } = await fixture(t);
  await main(['agents'], env);
  await main(
    [
      'spawn',
      '--id',
      'worker-one',
      '--adapter',
      'demo',
      '--cwd',
      '.',
      '--task',
      'Verify room delivery',
      '--conversation',
      'issue-42',
      '--task-id',
      'task-42',
    ],
    env,
  );
  assert.equal(calls[0].path, '/api/agents');
  assert.equal(calls[1].body.taskId, 'task-42');
  assert.equal(calls[1].body.conversationId, 'issue-42');
});

test('worker work needs a tracked task while empty manual registration remains possible', async (t) => {
  const { calls, env } = await fixture(t);
  await assert.rejects(
    main(['spawn', '--id', 'worker-one', '--adapter', 'demo', '--cwd', '.', '--task', 'Invisible work'], env),
    /require --task-id/,
  );
  assert.equal(calls.length, 0);
  await main(['register', '--id', 'worker-one', '--adapter', 'manual', '--cwd', '.'], env);
  assert.equal(calls[0].body.task, '');
});
