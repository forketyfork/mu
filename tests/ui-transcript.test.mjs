import test from 'node:test';
import assert from 'node:assert/strict';
import { createdAt, fixture, initialState } from './ui-fixture.mjs';
import { transcriptConversations, transcriptNote } from '../public/model.js';

const hostile = '<img src=x onerror="window.injected=true">';
const page = (overrides = {}) => ({
  agentId: 'worker',
  conversationId: 'room-a',
  adapter: 'claude',
  sessionId: '11111111-2222-4333-8444-555555555555',
  file: '/home/.claude/projects/-project/s.jsonl',
  bytes: 2048,
  skipped: { 'api-request': 3, attachment: 1 },
  pendingBytes: 0,
  masked: 1,
  turnCount: 7,
  start: 5,
  end: 7,
  turns: [
    {
      index: 5,
      messageId: 41,
      at: createdAt,
      entries: [
        { kind: 'prompt', text: 'Incoming chat message #41 from @lead:\nCheck.', at: createdAt },
        { kind: 'thinking', text: null, hidden: true, at: createdAt },
        { kind: 'tool_call', id: 't1', name: 'Bash', input: `echo '${hostile}'`, at: createdAt },
        { kind: 'tool_result', id: 't1', name: 'Bash', text: hostile, isError: false, at: createdAt },
        { kind: 'text', text: `**Checked.** ${hostile}`, at: createdAt },
      ],
    },
    {
      index: 6,
      messageId: 57,
      at: createdAt,
      entries: [
        { kind: 'compaction', text: null, detail: '899067 → 17480 tokens (auto trigger)', at: createdAt },
        {
          kind: 'tool_result',
          id: 't2',
          name: 'Read',
          text: 'x'.repeat(8000),
          truncated: true,
          length: 9000,
          isError: true,
          ref: 'e9.0',
          at: createdAt,
        },
      ],
    },
  ],
  ...overrides,
});

async function transcriptFixture(t) {
  const initial = initialState();
  initial.agents.push({
    id: 'worker',
    role: 'worker',
    adapter: 'claude',
    status: 'idle',
    task: 'Work',
    cwd: '/project',
    conversationId: 'room-a',
    sessionIds: {
      'room-a': '11111111-2222-4333-8444-555555555555',
      'dm-worker': '22222222-2222-4333-8444-555555555555',
    },
    createdAt,
  });
  initial.conversations.push({ id: 'dm-worker', kind: 'direct', members: ['user', 'worker'] });
  const ui = await fixture(t, { initial });
  ui.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  ui.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new ui.window.Event('close'));
  };
  const transcriptRequests = [];
  ui.window.fetch = async (path) => {
    if (!path.includes('/transcript')) return { ok: true, status: 200, json: async () => structuredClone(initial) };
    transcriptRequests.push(path);
    if (path.includes('/transcript/entry'))
      return {
        ok: true,
        status: 200,
        json: async () => ({ kind: 'tool_result', text: 'y'.repeat(9000), isError: true }),
      };
    if (path.includes('conversation=dm-worker'))
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'No Claude Code session file 2222.jsonl under ~/.claude/projects' }),
      };
    return {
      ok: true,
      status: 200,
      json: async () =>
        path.includes('before=5')
          ? page({
              start: 0,
              end: 5,
              turns: [
                {
                  index: 4,
                  messageId: 30,
                  at: createdAt,
                  entries: [{ kind: 'notice', text: 'Older turn', at: createdAt }],
                },
              ],
            })
          : page(),
    };
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { ...ui, transcriptRequests, settle };
}

test('only agents with a harness session offer a transcript', () => {
  assert.deepEqual(transcriptConversations({ adapter: 'codex', sessionIds: { a: 'x', b: 'y' } }), ['a', 'b']);
  assert.deepEqual(transcriptConversations({ adapter: 'manual', sessionIds: { a: 'x' } }), []);
  assert.deepEqual(transcriptConversations({ adapter: 'pi' }), []);
});

test('the transcript note lists skipped record types, masked secrets and an unfinished write', () => {
  assert.equal(
    transcriptNote({ skipped: { attachment: 1, 'api-request': 3 }, masked: 2, pendingBytes: 2048 }),
    'Not shown: api-request ×3, attachment ×1. 2 secrets masked for display. 2.0 KiB at the end of the file is still being written.',
  );
  assert.equal(transcriptNote({ skipped: {}, masked: 0, pendingBytes: 0 }), '');
});

test('the viewer shows tool input and output as plain text and assistant text as sanitized markdown', async (t) => {
  const { window, $, click, transcriptRequests, settle } = await transcriptFixture(t);
  assert.equal($('[data-agent="lead"] [data-action="transcript"]'), null, 'a manual agent has no transcript');
  click('[data-agent="worker"] [data-action="transcript"]');
  await settle();
  assert.equal($('#transcript-dialog').open, true);
  assert.equal(transcriptRequests[0], '/api/agents/worker/transcript?conversation=room-a&limit=5');
  const turns = $('#transcript-turns');
  assert.equal(
    turns.querySelectorAll('.transcript-call img, .transcript-result img, .transcript-prompt img').length,
    0,
    'tool input, tool output and prompts are never parsed as HTML',
  );
  assert.ok(
    [...turns.querySelectorAll('img')].every((image) => !image.hasAttribute('onerror')),
    'assistant markdown is sanitized',
  );
  assert.equal(window.injected, undefined);
  assert.ok(
    [...turns.querySelectorAll('.transcript-call pre, .transcript-result pre')].some(
      (pre) => pre.textContent === hostile,
    ),
  );
  assert.equal(turns.querySelector('.transcript-text strong').textContent, 'Checked.');
  assert.match(turns.querySelector('.transcript-thinking').textContent, /did not record its text/);
  assert.match(turns.querySelector('.transcript-compaction').textContent, /899067 → 17480 tokens/);
  assert.deepEqual(
    [...turns.querySelectorAll('.transcript-turn-message')].map((element) => element.textContent),
    ['message #41', 'message #57'],
  );
  assert.equal(
    $('#transcript-note').textContent,
    'Not shown: api-request ×3, attachment ×1. 1 secret masked for display.',
  );
  assert.match(
    $('#transcript-meta').textContent,
    /Claude Code · session 11111111-2222-4333-8444-555555555555 · 7 turns · 2\.0 KiB/,
  );
  assert.equal(turns.querySelector('.transcript-result.error').open, true, 'a failed tool call is expanded');
});

test('the viewer loads earlier turns, full entries, and reports a missing transcript as an error', async (t) => {
  const { $, click, transcriptRequests, settle } = await transcriptFixture(t);
  click('[data-agent="worker"] [data-action="transcript"]');
  await settle();
  assert.equal($('#transcript-earlier').hidden, false);
  click('#transcript-earlier');
  await settle();
  assert.equal(transcriptRequests.at(-1), '/api/agents/worker/transcript?conversation=room-a&limit=5&before=5');
  assert.equal(
    $('#transcript-turns .transcript-turn .transcript-notice').textContent,
    'Older turn',
    'earlier turns are placed above the loaded ones',
  );
  assert.equal($('#transcript-earlier').hidden, true);
  assert.equal(
    $('#transcript-note').textContent,
    'Not shown: api-request ×3, attachment ×1. 2 secrets masked for display.',
    'the masked count covers every page shown',
  );
  click('.transcript-more');
  await settle();
  assert.equal(
    transcriptRequests.at(-1),
    '/api/agents/worker/transcript/entry?conversation=room-a&turn=6&entry=1&ref=e9.0',
    'the request names the entry it replaces',
  );
  assert.equal($('.transcript-result.error pre').textContent, 'y'.repeat(9000));
  assert.equal($('.transcript-more'), null);
  const select = $('#transcript-conversation');
  select.value = 'dm-worker';
  select.dispatchEvent(new select.ownerDocument.defaultView.Event('change'));
  await settle();
  assert.equal($('#transcript-error').hidden, false);
  assert.match($('#transcript-error').textContent, /Could not load the transcript: No Claude Code session file/);
  assert.equal($('#transcript-turns').children.length, 0);
  assert.deepEqual(
    [$('#transcript-note').hidden, $('#transcript-note').textContent, $('#transcript-earlier').hidden],
    [true, '', true],
    'nothing from the previous session stays on screen',
  );
});

test('the viewer lays out tool calls as text, keeps the raw input, and loads a cut input in full', async (t) => {
  const { window, click, transcriptRequests, settle } = await transcriptFixture(t);
  const $$ = (selector) => [...window.document.querySelectorAll(selector)];
  const cut = { file_path: '/p/big.md', content: 'z'.repeat(100) };
  const tools = page({
    turns: [
      {
        index: 6,
        messageId: 57,
        at: createdAt,
        entries: [
          {
            kind: 'tool_call',
            id: 't1',
            name: 'Bash',
            input: { command: `cd /p; echo '${hostile}'`, description: `List ${hostile}` },
            at: createdAt,
          },
          {
            kind: 'tool_call',
            id: 't2',
            name: 'Edit',
            input: { file_path: `/p/${hostile}.js`, old_string: hostile, new_string: 'safe' },
            at: createdAt,
          },
          {
            kind: 'tool_call',
            id: 't3',
            name: 'Read',
            input: '{"file_path": "/p/legacy.js", "offset": 3, "limit": 2}',
            at: createdAt,
          },
          {
            kind: 'tool_call',
            id: 't4',
            name: 'Write',
            input: cut,
            truncated: true,
            length: 5000,
            ref: 'e4.0',
            at: createdAt,
          },
        ],
      },
    ],
  });
  const fetch = window.fetch;
  window.fetch = async (path, options) => {
    if (path.includes('/transcript/entry')) {
      transcriptRequests.push(path);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          kind: 'tool_call',
          id: 't4',
          name: 'Write',
          input: { ...cut, content: 'z'.repeat(4980) },
          ref: 'e4.0',
          at: createdAt,
        }),
      };
    }
    if (path.includes('/transcript?')) {
      transcriptRequests.push(path);
      return { ok: true, status: 200, json: async () => structuredClone(tools) };
    }
    return fetch(path, options);
  };
  click('[data-agent="worker"] [data-action="transcript"]');
  await settle();
  const calls = $$('.transcript-call');
  assert.equal(calls.length, 4);
  assert.equal($$('#transcript-turns img').length, 0, 'markup in tool input is never parsed');
  assert.equal(window.injected, undefined);
  const [bash, edit, read, write] = calls;
  assert.equal(bash.querySelector('.transcript-tool-summary').textContent, `List ${hostile}`);
  assert.equal(bash.querySelector('.tool-shell').textContent, `cd /p;\necho '${hostile}'`);
  assert.equal(edit.querySelector('.transcript-tool-summary code').textContent, `/p/${hostile}.js`);
  assert.deepEqual(
    [...edit.querySelectorAll('.tool-del, .tool-add')].map((line) => line.textContent),
    [`-${hostile}`, '+safe'],
  );
  assert.equal(
    read.querySelector('.transcript-tool-summary').textContent,
    '/p/legacy.js lines 3–4',
    'JSON text from a service that has not restarted is laid out too',
  );
  assert.equal(
    bash.querySelector('.transcript-raw pre').textContent,
    JSON.stringify(tools.turns[0].entries[0].input, null, 2),
    'the raw input of every call stays available',
  );
  assert.equal(bash.querySelector('.transcript-raw').open, false);
  assert.match(write.querySelector('.transcript-hint').textContent, /5,000 characters in total/);
  assert.equal(
    write.querySelector('.transcript-tool-summary').textContent,
    '/p/big.md',
    'the line count waits for the full input',
  );
  click('.transcript-call .transcript-more');
  await settle();
  assert.equal(
    transcriptRequests.at(-1),
    '/api/agents/worker/transcript/entry?conversation=room-a&turn=6&entry=3&ref=e4.0',
  );
  const full = $$('.transcript-call')[3];
  assert.equal(
    full.querySelector('pre.tool-code').textContent,
    'z'.repeat(4980),
    'the full input replaces the cut one',
  );
  assert.equal(full.querySelector('.transcript-more'), null);
  assert.equal(full.querySelector('.transcript-tool-summary').textContent, '/p/big.md 1 line');
});

// A pi agent writes its own session file, so it chooses tool names and input.
async function forgedFixture(t, entries) {
  const ui = await transcriptFixture(t);
  const fetch = ui.window.fetch;
  ui.window.fetch = async (path, options) =>
    path.includes('/transcript?')
      ? {
          ok: true,
          status: 200,
          json: async () => page({ turns: [{ index: 6, messageId: 57, at: createdAt, entries }] }),
        }
      : fetch(path, options);
  ui.click('[data-agent="worker"] [data-action="transcript"]');
  await ui.settle();
  return ui;
}
const forgedInput = () => ({
  summary: [{ tag: 'button', className: 'primary-button', children: ['Approve deploy'] }],
  body: [
    { tag: 'script', className: '', children: ['window.ran = true'] },
    { tag: 'textarea', className: 'composer-input', children: ['fake'] },
  ],
});

test('a tool named after an inherited property renders its input as text and keeps the page working', async (t) => {
  const names = ['constructor', 'toString', 'valueOf', '__proto__'];
  const { $ } = await forgedFixture(
    t,
    names.map((name, index) => ({ kind: 'tool_call', id: `t${index}`, name, input: forgedInput(), at: createdAt })),
  );
  assert.equal($('#transcript-error').hidden, true, $('#transcript-error').textContent);
  const turns = $('#transcript-turns');
  assert.equal(turns.querySelectorAll('.transcript-call').length, names.length);
  assert.equal(
    turns.querySelectorAll('button.primary-button, script, textarea').length,
    0,
    'no element is built from the input',
  );
  assert.ok(
    [...turns.querySelectorAll('.transcript-call')].every((call) => call.textContent.includes('Approve deploy')),
  );
});

test('the dashboard builds only the elements tool views use', async (t) => {
  const ui = await transcriptFixture(t);
  ui.window.toolView = () => ({
    summary: [],
    body: [{ tag: 'textarea', className: 'composer-input', children: ['fake'] }],
    input: {},
  });
  const fetch = ui.window.fetch;
  ui.window.fetch = async (path, options) =>
    path.includes('/transcript?')
      ? {
          ok: true,
          status: 200,
          json: async () =>
            page({
              turns: [
                {
                  index: 6,
                  messageId: 57,
                  at: createdAt,
                  entries: [{ kind: 'tool_call', id: 't1', name: 'Read', input: {}, at: createdAt }],
                },
              ],
            }),
        }
      : fetch(path, options);
  ui.click('[data-agent="worker"] [data-action="transcript"]');
  await ui.settle();
  assert.equal(ui.$('#transcript-turns textarea'), null);
  assert.match(ui.$('#transcript-error').textContent, /A tool view has an unexpected element: textarea/);
});
