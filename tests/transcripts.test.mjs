import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import fsPromises, {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { createApp, ROOT } from '../src/server.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';
import {
  DISPLAY_CHARS,
  LABELLED_SECRETS,
  SECRET_PATTERNS,
  Transcripts,
  maskSecrets,
  parseClaude,
  parseCodex,
  parsePi,
  readContained,
} from '../src/transcripts.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/transcripts/${name}`, import.meta.url), 'utf8');
const kinds = (turn) => turn.entries.map((entry) => entry.kind);
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const CODEX_ID = '01a1a6f8-2372-75a3-95f9-7ba31dd6b210';
const PI_ID = 'dd38d113-8ce0-41d9-993a-94cf4145ec23';

test('a Claude session splits into turns by prompt and counts the records it does not show', async () => {
  const { turns, skipped, pendingBytes } = parseClaude(await fixture('claude.jsonl'));
  assert.equal(pendingBytes, 0);
  assert.deepEqual(
    turns.map((turn) => turn.messageId),
    [41, 57],
  );
  assert.deepEqual(kinds(turns[0]), [
    'prompt',
    'thinking',
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
    'text',
    'compaction',
    'compaction',
  ]);
  const [, thinking, call, result, , failed, , boundary, summary] = turns[0].entries;
  assert.deepEqual(
    [thinking.hidden, thinking.text],
    [true, null],
    'a thinking block with only a signature has no text to show',
  );
  assert.deepEqual(
    call.input,
    { command: 'ls src', description: 'List sources' },
    'the tool input keeps its structure for the viewer to lay out',
  );
  assert.deepEqual([result.name, result.text, result.isError], ['Bash', 'cli.mjs\nserver.mjs', false]);
  assert.deepEqual([failed.name, failed.isError], ['Read', true]);
  assert.match(boundary.detail, /899067 → 17480 tokens/);
  assert.equal(summary.text, 'Summary: the worker listed the files.');
  assert.deepEqual(skipped, {
    'queue-operation': 1,
    attachment: 1,
    'api-request': 1,
    'assistant (sidechain)': 1,
    'system/stop_hook_summary': 1,
    'user (meta)': 1,
  });
});

test('a Codex rollout is read from its completed items, not from the raw model traffic', async () => {
  const { turns, skipped } = parseCodex(await fixture('codex.jsonl'));
  assert.deepEqual(
    turns.map((turn) => turn.messageId),
    [12, 15],
  );
  assert.deepEqual(kinds(turns[0]), [
    'prompt',
    'thinking',
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
    'text',
  ]);
  const [, reasoning, command, output, patch, , mcp, mcpResult] = turns[0].entries;
  assert.equal(reasoning.hidden, true);
  assert.equal(command.input, 'npm test', 'a Codex command is its shell script');
  assert.deepEqual([output.text, output.isError], ['1 failing\n[exit code 1]', true]);
  assert.deepEqual(patch.input, { '/project/a.txt': { type: 'add', content: 'hello\n' } });
  assert.deepEqual(
    [mcp.name, mcp.input, mcpResult.text],
    ['issue_tracker.get_issue', { id: 'ISSUE-1' }, 'Issue ISSUE-1'],
  );
  assert.equal(turns[0].entries.at(-1).text, 'One test fails.', 'Codex writes agent message parts with type Text');
  assert.deepEqual(kinds(turns[1]), ['prompt', 'compaction', 'notice']);
  assert.equal(turns[1].entries[2].text, 'Turn aborted: interrupted');
  assert.equal(skipped.response_item, 1);
  assert.equal(skipped['item_completed/SubAgentActivity'], 1);
  assert.equal(skipped.compacted, 1);
});

test('an older Codex rollout format is refused instead of shown as empty', () => {
  const legacy =
    '{"timestamp":"2025-07-23T07:35:58Z","type":"session_meta","payload":{}}\n{"timestamp":"2025-07-23T07:36:00Z","type":"response_item","payload":{"type":"message"}}\n';
  assert.throws(() => parseCodex(legacy), /no task_started or item_completed events/);
});

test('a pi session shows the path to its latest entry and counts entries on other branches', async () => {
  const { turns, skipped } = parsePi(await fixture('pi.jsonl'));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].messageId, 7);
  assert.deepEqual(kinds(turns[0]), ['prompt', 'thinking', 'tool_call', 'tool_result', 'compaction', 'text']);
  assert.equal(turns[0].entries[1].text, 'I should run ls.');
  assert.equal(turns[0].entries[3].text, '3\n[image omitted: image/png]', 'image data is not passed on');
  assert.ok(!JSON.stringify(turns).includes('Abandoned branch'));
  assert.deepEqual(skipped, { 'entries on other branches': 1, 'message/system': 1, model_change: 1 });
});

test('pi sessions of an unknown version or with a broken tree are refused', async () => {
  const text = await fixture('pi.jsonl');
  assert.throws(() => parsePi(text.replace('"version":3', '"version":4')), /version 4 is not supported/);
  assert.throws(() => parsePi(text.replace('"parentId":"e6"', '"parentId":"gone"')), /refers to a missing parent gone/);
});

test('an invalid line fails with its line number, and an unfinished last line is reported as pending', async () => {
  const text = await fixture('claude.jsonl');
  const lines = text.split('\n');
  lines[3] = '{"type":"api-request",';
  assert.throws(() => parseClaude(lines.join('\n')), /line 4 is not valid JSON/);
  const writing = `${text}{"type":"assistant","message":{"content":[{"type":"text","text":"half`;
  const parsed = parseClaude(writing);
  assert.equal(
    parsed.pendingBytes,
    Buffer.byteLength('{"type":"assistant","message":{"content":[{"type":"text","text":"half'),
  );
  assert.equal(parsed.turns.at(-1).entries.at(-1).text, 'Done.');
});

test('masking hides credentials and keeps the surrounding text, paths and identifiers', () => {
  const github = `ghp_${'A1'.repeat(18)}`;
  const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(20)}`;
  const credential = 'f'.repeat(64);
  const { text, count } = maskSecrets(
    [
      `remote: https://x:${github}@github.com`,
      `Authorization: Bearer ${'Z'.repeat(40)}`,
      'export API_TOKEN="s3cr3t-value-123"',
      `cookie=${jwt}`,
      `MU_TOKEN_FILE=/data/credentials/lead and token ${credential}`,
      'task-0da535b1 sha256 ' + 'e'.repeat(64),
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
    ].join('\n'),
    [credential],
  );
  assert.equal(count, 6);
  for (const secret of [github, 'Z'.repeat(40), 's3cr3t-value-123', jwt, credential, 'AAAA'])
    assert.ok(!text.includes(secret), secret);
  assert.match(text, /x:\[masked: GitHub token\]@github\.com/);
  assert.match(text, /Bearer \[masked: bearer credential\]/);
  assert.match(text, /export API_TOKEN="\[masked: secret value\]"/);
  assert.match(text, /MU_TOKEN_FILE=\/data\/credentials\/lead/, 'a path assigned to a TOKEN variable stays visible');
  assert.match(text, /task-0da535b1 sha256 e{64}/, 'task IDs and digests are not credentials');
});

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

async function place(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(new URL(`./fixtures/transcripts/${source}`, import.meta.url), target);
  return target;
}

// A service whose Claude, Codex and pi homes hold one fixture session each, with a stopped agent per harness.
async function workspace(t) {
  const root = await shortTempDir(t, 'tr');
  const port = await freePort();
  const dataDir = join(root, 'd'),
    claudeHome = join(root, 'claude'),
    codexHome = join(root, 'codex');
  const files = {
    claude: await place('claude.jsonl', join(claudeHome, 'projects/-project', `${CLAUDE_ID}.jsonl`)),
    codex: await place(
      'codex.jsonl',
      join(codexHome, 'sessions/2026/11/06', `rollout-2026-11-06T10-00-00-${CODEX_ID}.jsonl`),
    ),
    pi: await place(
      'pi.jsonl',
      join(dataDir, 'pi/cheap/sessions/--project--', `2026-11-06T10-00-00-000Z_${PI_ID}.jsonl`),
    ),
  };
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir,
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
    transcriptHomes: { claudeHome, codexHome },
  });
  await app.start();
  t.after(() => app.close());
  for (const [id, role, adapter, sessionId] of [
    ['lead', 'lead', 'claude', CLAUDE_ID],
    ['worker', 'worker', 'claude', CLAUDE_ID],
    ['coder', 'worker', 'codex', CODEX_ID],
    ['cheap', 'worker', 'pi', PI_ID],
    ['hand', 'worker', 'manual', CLAUDE_ID],
  ]) {
    app.store.createAgent({
      id,
      role,
      adapter,
      ...(adapter === 'pi' ? { model: 'provider/model' } : {}),
      cwd: ROOT,
      task: '',
      conversationId: 'common',
    });
    app.store.updateAgent(id, { status: 'stopped', sessionIds: { common: sessionId } });
  }
  const url = `http://127.0.0.1:${port}`;
  const get = async (path, headers = userHeaders(app), method = 'GET') => {
    const response = await fetch(url + path, { method, headers });
    return { status: response.status, body: await response.json() };
  };
  return { app, root, dataDir, claudeHome, codexHome, files, get };
}

test('the user pages through a transcript, newest turns first, and loads a truncated entry in full', async (t) => {
  const { files, get } = await workspace(t);
  const long = 'x'.repeat(DISPLAY_CHARS + 500);
  await appendFile(
    files.claude,
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Incoming chat message #90 from @lead:\nAgain.' }, timestamp: '2026-11-06T12:00:00Z' })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: long }] }, timestamp: '2026-11-06T12:00:01Z' })}\n`,
  );
  const latest = await get('/api/agents/worker/transcript?conversation=common&limit=2');
  assert.equal(latest.status, 200, JSON.stringify(latest.body));
  assert.deepEqual(
    [latest.body.adapter, latest.body.sessionId, latest.body.turnCount, latest.body.start, latest.body.end],
    ['claude', CLAUDE_ID, 3, 1, 3],
  );
  assert.deepEqual(
    latest.body.turns.map((turn) => turn.messageId),
    [57, 90],
  );
  assert.equal(latest.body.file, files.claude);
  assert.equal(latest.body.skipped['api-request'], 1);
  const truncated = latest.body.turns[1].entries[1];
  assert.deepEqual([truncated.truncated, truncated.length, truncated.text.length], [true, long.length, DISPLAY_CHARS]);
  const earlier = await get('/api/agents/worker/transcript?conversation=common&limit=2&before=1');
  assert.deepEqual(
    earlier.body.turns.map((turn) => turn.messageId),
    [41],
  );
  const full = await get('/api/agents/worker/transcript/entry?conversation=common&turn=2&entry=1');
  assert.equal(full.status, 200);
  assert.equal(full.body.text, long);
  assert.equal(full.body.truncated, undefined);
  for (const [adapter, id, messageId] of [
    ['codex', 'coder', 15],
    ['pi', 'cheap', 7],
  ]) {
    const page = await get(`/api/agents/${id}/transcript?conversation=common`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.adapter, adapter);
    assert.equal(page.body.turns.at(-1).messageId, messageId);
  }
  assert.equal((await get('/api/agents/worker/transcript?conversation=common&limit=0')).status, 400);
  assert.equal((await get('/api/agents/worker/transcript')).status, 400);
});

test('only the user reads transcripts: agents, sockets and anonymous callers are refused', async (t) => {
  const { app, get } = await workspace(t);
  const path = '/api/agents/worker/transcript?conversation=common';
  const as = (token) => ({ Authorization: `Bearer ${token}` });
  for (const id of ['lead', 'worker', 'coder']) {
    const refused = await get(path, as(app.identity.issue(id)));
    assert.equal(refused.status, 403, `@${id} must not read transcripts`);
    assert.match(refused.body.error, /Only the user reads agent transcripts/);
    assert.equal(
      (await get('/api/agents/worker/transcript/entry?conversation=common&turn=0&entry=0', as(app.identity.issue(id))))
        .status,
      403,
    );
  }
  assert.equal((await get(path, {})).status, 401);
  assert.equal((await get(path, userHeaders(app), 'POST')).status, 405);
  assert.equal((await get(path, as(app.identity.issue('lead')), 'POST')).status, 403);
  const socket = await app.sockets.ensure('cheap');
  const token = app.identity.issue('cheap', { socket: true });
  const viaSocket = await new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath: socket, path: '/api/agents/cheap/transcript?conversation=common', headers: as(token) },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, text }));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(viaSocket.status, 403, 'a pi agent cannot read even its own transcript through its socket');
  assert.ok(!viaSocket.text.includes('Count the files'));
});

test('symbolic links and paths outside the harness directories are refused', async (t) => {
  const { app, root, dataDir, files, get } = await workspace(t);
  const userToken = join(dataDir, 'user-token');
  // A pi agent can write its own sessions directory; a link there must not make Mu read the user credential.
  await unlink(files.pi);
  await symlink(userToken, files.pi);
  const linked = await get('/api/agents/cheap/transcript?conversation=common');
  assert.equal(linked.status, 422);
  assert.match(linked.body.error, /is a symbolic link; Mu reads only regular files/);
  assert.ok(!JSON.stringify(linked.body).includes(app.identity.token));
  // Replacing the sessions directory itself moves the real path outside the agent's pi home.
  const outside = join(root, 'elsewhere');
  await place('pi.jsonl', join(outside, '--project--', `2026-11-06T10-00-00-000Z_${PI_ID}.jsonl`));
  await rm(join(dataDir, 'pi/cheap/sessions'), { recursive: true });
  await symlink(outside, join(dataDir, 'pi/cheap/sessions'));
  const redirected = await get('/api/agents/cheap/transcript?conversation=common');
  assert.equal(redirected.status, 422);
  assert.match(redirected.body.error, /outside .*pi\/cheap\/sessions/);
  await unlink(files.claude);
  await symlink(join(outside, '--project--', `2026-11-06T10-00-00-000Z_${PI_ID}.jsonl`), files.claude);
  const claude = await get('/api/agents/worker/transcript?conversation=common');
  assert.equal(claude.status, 422);
  assert.match(claude.body.error, /symbolic link/);
});

test('missing sessions, missing files and unreadable files are explicit errors', async (t) => {
  const { files, get } = await workspace(t);
  const noSession = await get('/api/agents/worker/transcript?conversation=dm-worker');
  assert.equal(noSession.status, 404);
  assert.match(noSession.body.error, /@worker has no claude session in dm-worker/);
  assert.equal(
    (await get('/api/agents/hand/transcript?conversation=common')).status,
    400,
    'a manual agent has no harness transcript',
  );
  await rm(files.codex);
  const missing = await get('/api/agents/coder/transcript?conversation=common');
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, new RegExp(`No Codex rollout file for thread ${CODEX_ID}`));
  await writeFile(files.claude, '{"type":"user","message":{"role":"user","content":"x"}}\nnot json\n');
  const broken = await get('/api/agents/lead/transcript?conversation=common');
  assert.equal(broken.status, 422);
  assert.match(broken.body.error, /line 2 is not valid JSON/);
  assert.equal((await get('/api/agents/nobody/transcript?conversation=common')).status, 404);
  assert.equal((await get('/api/agents/worker/transcript?conversation=missing-room')).status, 404);
});

test('a stored session ID that is not a UUID never becomes a path', async (t) => {
  const { app, get } = await workspace(t);
  app.store.updateAgent('worker', { sessionIds: { common: '../../../../etc/passwd' } });
  const refused = await get('/api/agents/worker/transcript?conversation=common');
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /is not a UUID/);
});

test('transcripts mask the Mu credentials and secret values before they leave the service', async (t) => {
  const { app, files, get } = await workspace(t);
  const turnToken = app.identity.issue('worker');
  await appendFile(
    files.claude,
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: `${app.identity.token}\n${turnToken}` }] } })}\n`,
  );
  const page = await get('/api/agents/worker/transcript?conversation=common');
  const text = JSON.stringify(page.body);
  assert.ok(!text.includes(app.identity.token), 'the user credential is masked');
  assert.ok(!text.includes(turnToken), 'a live turn credential is masked');
  assert.ok(!text.includes('fixture-not-a-real-value'));
  assert.match(text, /GITHUB_TOKEN=\[masked: secret value\]/);
  assert.equal(page.body.masked, 3);
});

// One realistic sample per masking label. A pattern added without a sample fails the first test below.
const SECRET_SAMPLES = {
  'private key':
    '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  'GitHub token': `ghp_${'A1b2'.repeat(9)}`,
  'GitLab token': `glpat-${'xY9_'.repeat(6)}`,
  'Slack token': 'xoxb-1234567890-abcdefghij',
  'AWS access key': 'AKIAABCDEFGHIJ234567',
  'API key': `sk-ant-${'aB3_'.repeat(6)}`,
  'permission token': 'perm:dXNlcg==.abc-123_xyz.Q',
  JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLXZhbHVl',
  'bearer credential': 'Bearer Z9y8X7w6V5u4T3s2',
  'secret value': 'export GITHUB_API_TOKEN="s3cr3t-value-123"',
};
const MASKING_PATTERNS = [...SECRET_PATTERNS, ...LABELLED_SECRETS];

test('every masking pattern has a sample secret, and masks it', () => {
  assert.deepEqual(
    MASKING_PATTERNS.map(([label]) => label).filter((label) => !(label in SECRET_SAMPLES)),
    [],
    'add a sample for each new pattern',
  );
  for (const [label, sample] of Object.entries(SECRET_SAMPLES))
    assert.match(maskSecrets(`x ${sample} y`).text, new RegExp(`\\[masked: ${label}\\]`), label);
});

// CPU time of one replace over `text`, which a busy machine does not inflate the way it inflates wall-clock time.
const cpuMillis = (pattern, text) => {
  const before = process.cpuUsage();
  text.replace(new RegExp(pattern.source, pattern.flags), '');
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
};
const GROWTH_STEP = 4;
const LINEAR_TOLERANCE = 2; // linear growth costs GROWTH_STEP times as much, quadratic growth GROWTH_STEP squared
const NOISE_FLOOR_MS = 5;

// A backtracking pattern is slow on long runs of the text around its start: a prefix of a secret or one of its words,
// repeated with or without a separator, so that every repetition starts a match that reads far ahead and then fails.
// The test compares the cost of a short run with that of a run GROWTH_STEP times longer instead of bounding wall-clock
// time, so a loaded machine does not fail it and a super-linear pattern still does.
test('every masking pattern stays linear on long runs built from its sample secret', () => {
  const size = 50_000;
  for (const [label, pattern] of MASKING_PATTERNS) {
    const sample = SECRET_SAMPLES[label];
    const step = Math.max(1, Math.floor(sample.length / 8));
    const prefixes = Array.from({ length: Math.ceil((sample.length - 1) / step) }, (_, index) =>
      sample.slice(0, 1 + index * step),
    );
    const words = sample.split(/[^A-Za-z0-9_]+/).filter(Boolean);
    for (const part of new Set([...prefixes, ...words])) {
      for (const separator of ['', '-', '_', '.', ' ', '=', ':', '\n']) {
        const unit = separator + part;
        const run = (length) => unit.repeat(Math.ceil(length / unit.length));
        const short = run(size);
        const long = run(size * GROWTH_STEP);
        const shortMs = Math.max(
          NOISE_FLOOR_MS,
          Math.min(cpuMillis(pattern, short), cpuMillis(pattern, short), cpuMillis(pattern, short)),
        );
        const longMs = cpuMillis(pattern, long);
        assert.ok(
          longMs <= shortMs * GROWTH_STEP * LINEAR_TOLERANCE + NOISE_FLOOR_MS,
          `${label}: ${JSON.stringify(unit)} repeated took ${Math.round(longMs)} ms for ${long.length} characters, ${shortMs.toFixed(1)} ms for ${short.length}`,
        );
      }
    }
  }
});

test('masking stays linear on long identifier and key runs', () => {
  const cpuOf = (text) => {
    const before = process.cpuUsage();
    maskSecrets(text);
    const used = process.cpuUsage(before);
    return (used.user + used.system) / 1000;
  };
  /** @type {[string, number][]} */
  const runs = [
    ['TOKEN', 20_000],
    ['-----BEGIN PRIVATE KEY-----', 10_000],
    ['A_TOKEN: ', 25_000],
    ['-eyJaaaaaaaaaaaa', 6_250],
  ];
  for (const [unit, repeats] of runs) {
    const short = unit.repeat(repeats);
    const long = unit.repeat(repeats * GROWTH_STEP);
    const shortMs = Math.max(NOISE_FLOOR_MS, Math.min(cpuOf(short), cpuOf(short), cpuOf(short)));
    const longMs = cpuOf(long);
    assert.ok(
      longMs <= shortMs * GROWTH_STEP * LINEAR_TOLERANCE + NOISE_FLOOR_MS,
      `masking ${JSON.stringify(unit)} repeated took ${Math.round(longMs)} ms for ${long.length} characters, ${shortMs.toFixed(1)} ms for ${short.length}`,
    );
  }
});

test('a secret that crosses the display cut is masked whole, in the page and in the full entry', async (t) => {
  const { files, get } = await workspace(t);
  const github = `ghp_${'A'.repeat(36)}`;
  await appendFile(
    files.claude,
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_4', content: `${'x'.repeat(DISPLAY_CHARS - 10)} ${github}` }] } })}\n`,
  );
  const page = await get('/api/agents/worker/transcript?conversation=common&limit=1');
  const cut = page.body.turns[0].entries.at(-1);
  assert.equal(cut.truncated, true);
  assert.ok(!cut.text.includes('ghp_'), 'no part of the secret is shown before the cut');
  const full = await get(
    `/api/agents/worker/transcript/entry?conversation=common&turn=${page.body.turns[0].index}&entry=${page.body.turns[0].entries.length - 1}`,
  );
  assert.ok(full.body.text.endsWith(' [masked: GitHub token]'), full.body.text.slice(-40));
});

test('every string of a structured tool input is masked, keys included, and cut within the display limit', async (t) => {
  const { files, get } = await workspace(t);
  const github = `ghp_${'B'.repeat(36)}`;
  const input = {
    file_path: `/tmp/${github}/notes.md`,
    content: `export GITHUB_TOKEN="s3cr3t-value-123"\n${'y'.repeat(DISPLAY_CHARS)}`,
    edits: [{ [github]: 'key' }],
  };
  await appendFile(
    files.claude,
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Write', input }] } })}\n`,
  );
  const page = await get('/api/agents/worker/transcript?conversation=common&limit=1');
  const turn = page.body.turns[0];
  const call = turn.entries.at(-1);
  assert.equal(call.kind, 'tool_call');
  assert.ok(!JSON.stringify(call).includes(github), 'neither a value nor a key shows the secret');
  assert.equal(call.input.file_path, '/tmp/[masked: GitHub token]/notes.md');
  assert.match(
    call.input.content,
    /^export GITHUB_TOKEN="\[masked: secret value\]"\n/,
    'a quoted value is masked as in plain text, not as escaped JSON',
  );
  assert.equal(call.truncated, true);
  assert.ok(call.input.file_path.length + call.input.content.length <= DISPLAY_CHARS);
  assert.equal(call.input.edits, undefined, 'members after the budget runs out are left out');
  const full = await get(
    `/api/agents/worker/transcript/entry?conversation=common&turn=${turn.index}&entry=${turn.entries.length - 1}`,
  );
  assert.equal(full.body.truncated, undefined);
  assert.deepEqual(Object.keys(full.body.input), ['file_path', 'content', 'edits']);
  assert.deepEqual(full.body.input.edits, [{ '[masked: GitHub token]': 'key' }]);
  assert.equal(
    full.body.input.content.length,
    input.content.length - 's3cr3t-value-123'.length + '[masked: secret value]'.length,
  );
  const characters = (value) =>
    typeof value === 'string'
      ? value.length
      : value && typeof value === 'object'
        ? Object.entries(value).reduce(
            (sum, [key, item]) => sum + (Array.isArray(value) ? 0 : key.length) + characters(item),
            0,
          )
        : 0;
  assert.equal(call.length, characters(full.body.input), 'the length counts every string of the full input');
});

async function toolCallPage(t, input) {
  const { files, get } = await workspace(t);
  const before = await get('/api/agents/worker/transcript?conversation=common&limit=1');
  await appendFile(
    files.claude,
    `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_10', name: 'mcp__docker__run', input }] } })}\n`,
  );
  const page = await get('/api/agents/worker/transcript?conversation=common&limit=1');
  const turn = page.body.turns[0];
  const full = await get(
    `/api/agents/worker/transcript/entry?conversation=common&turn=${turn.index}&entry=${turn.entries.length - 1}`,
  );
  return { masked: page.body.masked - before.body.masked, call: turn.entries.at(-1), full: full.body };
}

test('the value of a key named like a secret is masked, as it was when the input was JSON text', async (t) => {
  const { masked, call } = await toolCallPage(t, {
    image: 'x',
    env: { GITHUB_TOKEN: 'abcdefgh12345678', API_KEY: 'zzzzzzzz9999', PATH_TOKEN: 'short', HOME: '/home/agent' },
    DB_PASSWORD: 'p4ssw0rd!',
    PIN_SECRET: 12345678,
    RETRY_TOKEN: 1234567,
  });
  assert.deepEqual(call.input, {
    image: 'x',
    env: {
      GITHUB_TOKEN: '[masked: secret value]',
      API_KEY: '[masked: secret value]',
      PATH_TOKEN: 'short',
      HOME: '/home/agent',
    },
    DB_PASSWORD: '[masked: secret value]',
    PIN_SECRET: '[masked: secret value]',
    RETRY_TOKEN: 1234567,
  });
  assert.equal(masked, 4);
});

test('paths, $ references and placeholders under a key named like a secret stay visible, as in text', async (t) => {
  const input = {
    MU_TOKEN_FILE: '/Users/me/.mu/token',
    GH_TOKEN: '$GITHUB_TOKEN_VALUE',
    API_KEY: '<your api key here>',
    AUTH_TOKEN: '[redacted-by-user]',
    SPACED_SECRET: 'ab cdefghijkl',
  };
  const { masked, call } = await toolCallPage(t, input);
  assert.deepEqual(call.input, input);
  assert.equal(masked, 0);
  for (const [key, value] of Object.entries(input))
    assert.equal(maskSecrets(`${key}=${value}`).count, 0, `the text form of ${key} is not masked either`);
});

test('keys that mask to the same label stay separate members', async (t) => {
  const { call } = await toolCallPage(t, {
    [`ghp_${'a'.repeat(36)}`]: 'first',
    [`ghp_${'b'.repeat(36)}`]: 'second',
    [`ghp_${'c'.repeat(36)}`]: 'third',
  });
  assert.deepEqual(call.input, {
    '[masked: GitHub token]': 'first',
    '[masked: GitHub token] (2)': 'second',
    '[masked: GitHub token] (3)': 'third',
  });
});

test('a key cut to the name of an earlier key does not replace that member', async (t) => {
  const { call } = await toolCallPage(t, {
    pppp: 'EARLIER',
    filler: 'f'.repeat(DISPLAY_CHARS - 24),
    ppppzzzz: 'LATER',
  });
  assert.equal(call.truncated, true);
  assert.equal(call.input.pppp, 'EARLIER');
  assert.deepEqual(Object.keys(call.input), ['pppp', 'filler']);
});

test('long keys are cut within the display limit, at the top and nested', async (t) => {
  for (const [input, length] of [
    [{ ['k'.repeat(5_000_000)]: 'v' }, 5_000_001],
    [{ outer: { ['k'.repeat(3_000_000)]: 'v' } }, 3_000_006],
  ]) {
    const { call, full } = await toolCallPage(t, input);
    assert.equal(call.truncated, true);
    assert.ok(
      JSON.stringify(call.input).length < DISPLAY_CHARS + 100,
      `${JSON.stringify(call.input).length} characters`,
    );
    assert.equal(call.length, length);
    assert.equal(full.truncated, true, 'the full entry is cut at its own, larger limit');
  }
});

test(
  'links that loop or leave a pi or Codex sessions directory neither hang the service nor widen the search',
  { timeout: 15_000 },
  async (t) => {
    const { dataDir, codexHome, get } = await workspace(t);
    const sessions = join(dataDir, 'pi/cheap/sessions');
    await symlink('.', join(sessions, 'loop'));
    await symlink('..', join(sessions, 'up'));
    await symlink('/', join(sessions, '--project--/root'));
    await symlink('..', join(codexHome, 'sessions/2026/up'));
    for (const path of [
      '/api/agents/cheap/transcript?conversation=common',
      '/api/agents/coder/transcript?conversation=common',
    ]) {
      const page = await get(path);
      assert.equal(page.status, 200, JSON.stringify(page.body));
    }
  },
);

// Runs action once, right after readContained resolves the transcript's real path and before it opens the file.
function afterRealpath(t, path, action) {
  const original = fsPromises.realpath;
  let done = false;
  fsPromises.realpath = /** @type {typeof original} */ (
    async (target, ...rest) => {
      const result = await original(target, ...rest);
      if (target === path && !done) {
        done = true;
        await action();
      }
      return result;
    }
  );
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises.realpath = original;
    syncBuiltinESMExports();
  });
}

async function sessionsDirectory(t) {
  const home = await shortTempDir(t, 'tr-race');
  const file = join(home, 'sessions/--project--', `2026-11-06T10-00-00-000Z_${PI_ID}.jsonl`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{"type":"session"}\n');
  return { home, file };
}

test('a transcript file replaced after its check is refused', async (t) => {
  const { home, file } = await sessionsDirectory(t);
  const other = join(home, 'sessions/--project--/other.jsonl');
  await writeFile(other, '{"type":"other"}\n');
  afterRealpath(t, file, () => rename(other, file));
  await assert.rejects(readContained(file, home, 'sessions'), /changed while Mu opened it/);
});

test('a transcript file swapped for a link to itself after its check is not opened through the link', async (t) => {
  const { home, file } = await sessionsDirectory(t);
  afterRealpath(t, file, async () => {
    await rename(file, `${file}.moved`);
    await symlink(`${file}.moved`, file);
  });
  await assert.rejects(readContained(file, home, 'sessions'), /changed while Mu opened it/);
});

test('the parse cache is bounded by file bytes, and masking uses the credentials valid at each request', async (t) => {
  const root = await shortTempDir(t, 'tr-cache');
  const claudeHome = join(root, 'claude');
  const otherId = '11111111-2222-4333-8444-666666666666';
  const first = await place('claude.jsonl', join(claudeHome, 'projects/-project', `${CLAUDE_ID}.jsonl`));
  await place('claude.jsonl', join(claudeHome, 'projects/-project', `${otherId}.jsonl`));
  const { size } = await stat(first);
  const credentials = [];
  const transcripts = new Transcripts({
    dataDir: join(root, 'd'),
    claudeHome,
    codexHome: join(root, 'codex'),
    credentials: () => [...credentials],
    cacheBytes: Math.floor(size * 1.5),
  });
  const agent = (sessionId) => ({ id: 'worker', adapter: 'claude', sessionIds: { common: sessionId } });
  const before = await transcripts.page(agent(CLAUDE_ID), 'common');
  assert.ok(JSON.stringify(before.turns).includes('server.mjs'));
  credentials.push('server.mjs');
  const after = await transcripts.page(agent(CLAUDE_ID), 'common');
  assert.ok(
    !JSON.stringify(after.turns).includes('server.mjs'),
    'a credential issued after the file was parsed is masked',
  );
  assert.ok(after.masked > before.masked);
  await transcripts.page(agent(otherId), 'common');
  assert.deepEqual(
    [...transcripts.cache.keys()],
    [`claude:${join(claudeHome, 'projects/-project', `${otherId}.jsonl`)}`],
    'two files exceed the byte budget, so only the file read last stays',
  );
});

const jsonl = (records) => records.map((record) => `${JSON.stringify(record)}\n`).join('');

test('a command without an exit code is not shown as failed unless its status or a cancellation says so', () => {
  const command = (id, extra) => ({
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id,
        command: ['bash', '-lc', 'sleep 9'],
        aggregated_output: 'partial',
        ...extra,
      },
    },
  });
  const codex = parseCodex(
    jsonl([
      { type: 'event_msg', payload: { type: 'task_started' } },
      command('c1', { status: 'completed' }),
      command('c2', { exit_code: null, status: 'failed' }),
      command('c3', { exit_code: 0, status: 'completed' }),
    ]),
  );
  const results = codex.turns[0].entries.filter((entry) => entry.kind === 'tool_result');
  assert.deepEqual(
    results.map((result) => [result.text, result.isError]),
    [
      ['partial', false],
      ['partial', true],
      ['partial\n[exit code 0]', false],
    ],
  );
  const bash = (id, extra) => ({
    type: 'message',
    id,
    parentId: id === 'b1' ? null : `b${Number(id.slice(1)) - 1}`,
    message: { role: 'bashExecution', command: 'sleep 9', output: 'partial', ...extra },
  });
  const pi = parsePi(
    jsonl([
      { type: 'session', version: 3, id: PI_ID },
      bash('b1', { cancelled: false }),
      bash('b2', { cancelled: true }),
      bash('b3', { exitCode: 2, cancelled: false }),
    ]),
  );
  const piResults = pi.turns[0].entries.filter((entry) => entry.kind === 'tool_result');
  assert.deepEqual(
    piResults.map((result) => [result.text, result.isError]),
    [
      ['partial', false],
      ['partial\n[cancelled]', true],
      ['partial\n[exit code 2]', true],
    ],
  );
});

test('a Claude interruption is a notice in the interrupted turn, not a new turn', () => {
  const user = (content) => ({ type: 'user', message: { role: 'user', content } });
  const { turns } = parseClaude(
    jsonl([
      user('Incoming chat message #41 from @lead:\nCheck.'),
      user([{ type: 'text', text: '[Request interrupted by user]\n' }]),
      user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
    ]),
  );
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].entries.map((entry) => [entry.kind, entry.text]),
    [
      ['prompt', 'Incoming chat message #41 from @lead:\nCheck.'],
      ['notice', '[Request interrupted by user]'],
      ['notice', '[Request interrupted by user for tool use]'],
    ],
  );
});

test('after a pi branch, a full entry is returned only for the entry its page showed', async (t) => {
  const { files, get } = await workspace(t);
  const reply = (id, text) => ({
    type: 'message',
    id,
    parentId: 'e7',
    timestamp: '2026-11-06T12:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
  await appendFile(files.pi, jsonl([reply('b1', 'y'.repeat(DISPLAY_CHARS + 1))]));
  const truncated = async () => {
    const page = await get('/api/agents/cheap/transcript?conversation=common');
    const turn = page.body.turns.at(-1);
    const index = turn.entries.findIndex((entry) => entry.truncated);
    return {
      path: `/api/agents/cheap/transcript/entry?conversation=common&turn=${turn.index}&entry=${index}`,
      ref: turn.entries[index].ref,
    };
  };
  const before = await truncated();
  assert.equal(before.ref, 'b1.0');
  await appendFile(files.pi, jsonl([reply('b2', 'z'.repeat(DISPLAY_CHARS + 1))]));
  const stale = await get(`${before.path}&ref=${before.ref}`);
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.match(stale.body.error, /reload the transcript/);
  assert.ok(!JSON.stringify(stale.body).includes('zzz'));
  assert.equal((await get(before.path)).status, 400, 'an entry with a ref is not returned without it');
  const after = await truncated();
  assert.equal(after.ref, 'b2.0');
  const full = await get(`${after.path}&ref=${after.ref}`);
  assert.equal(full.body.text, 'z'.repeat(DISPLAY_CHARS + 1));
});
