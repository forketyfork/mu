import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AgentSockets } from '../src/identity.mjs';
import { CodexRollouts } from '../src/codex-rollout.mjs';
import { Runner } from '../src/runner.mjs';
import { Store } from '../src/store.mjs';
import { ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { testIdentity } from './identity-fixture.mjs';
import { shortTempDir, FAKE_PRIVATE_PATHS, temporaryMuHome } from './isolation.mjs';

const STREAM_AGENT = join(ROOT, 'tests/stream-agent.mjs');
// 80 tool results of 64 KiB make 5 MiB of output, more than the whole-output limit the runner once applied.
const toolOutput = 'x'.repeat(64 * 1024);
const TOOL_EVENTS = 80;

async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Runs one real turn whose CLI process is the stream agent, so the runner reads its stdout as it would the adapter's.
async function streamTurn(t, adapter, spec, agent = {}) {
  const dataDir = await shortTempDir(t, 'ol');
  const sockets = new AgentSockets({ dataDir, handler: (request, response) => response.end() });
  t.after(() => sockets.close());
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  store.createAgent({ id: 'worker', role: 'worker', adapter, cwd: ROOT, task: 'Implement', ...agent });
  const sent = [];
  const chat = {
    state: { connected: true },
    async send(from, text, conversationId) {
      sent.push({ from, text, conversationId });
    },
  };
  const custom = { fixture: { command: process.execPath, args: [STREAM_AGENT, JSON.stringify(spec)] } };
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    sockets,
    store,
    chat,
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    custom,
    dataDir,
    pricing: offlinePricing(),
    codexRollouts: new CodexRollouts(join(ROOT, '.tmp/no-codex-home')),
    privatePaths: FAKE_PRIVATE_PATHS,
  });
  const execute = runner.execute.bind(runner);
  runner.execute = (command, ...rest) =>
    execute(
      adapter === 'fixture'
        ? command
        : { ...command, command: process.execPath, args: [STREAM_AGENT, JSON.stringify(spec)] },
      ...rest,
    );
  const signals = [];
  const signal = runner.signal.bind(runner);
  runner.signal = (entry, name) => {
    signals.push({ signal: name, exited: entry.child.exitCode !== null || entry.child.signalCode !== null });
    return signal(entry, name);
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  store.addMessage('implement', 'user', 'Implement the change', 'dm-worker');
  runner.kick();
  await until(() => !runner.active.size);
  return { store, sent, signals, worker: store.agent('worker') };
}

const reply = '@lead Implemented, with tests.';

test('a Claude turn whose tool results pass 4 MiB delivers its final reply and usage', async (t) => {
  const session = 'claude-long';
  const { sent, worker } = await streamTurn(t, 'claude', {
    before: [{ type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5' }],
    filler: {
      count: TOOL_EVENTS,
      event: {
        type: 'user',
        session_id: session,
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: toolOutput }] },
      },
    },
    after: [
      {
        type: 'assistant',
        session_id: session,
        parent_tool_use_id: null,
        message: {
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: reply }],
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 90000,
            output_tokens: 20,
          },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: session,
        is_error: false,
        result: reply,
        total_cost_usd: 1.5,
        modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } },
      },
    ],
  });
  assert.equal(worker.lastError, null);
  assert.equal(worker.status, 'idle');
  assert.deepEqual(sent, [{ from: 'worker', text: reply, conversationId: 'dm-worker' }]);
  assert.equal(worker.sessionIds['dm-worker'], session);
  assert.equal(worker.usage['dm-worker'].contextTokens, 90030);
  assert.equal(worker.usage['dm-worker'].sessions[session].costUsd, 1.5);
});

test('a Codex turn whose command outputs pass 4 MiB delivers its final reply', async (t) => {
  const { sent, worker } = await streamTurn(t, 'codex', {
    before: [{ type: 'thread.started', thread_id: 'codex-long' }, { type: 'turn.started' }],
    filler: {
      count: TOOL_EVENTS,
      event: {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'command_execution',
          command: 'cat big.log',
          aggregated_output: toolOutput,
          exit_code: 0,
          status: 'completed',
        },
      },
    },
    after: [
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: reply } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 },
      },
    ],
  });
  assert.equal(worker.lastError, null);
  assert.equal(worker.status, 'idle');
  assert.deepEqual(sent, [{ from: 'worker', text: reply, conversationId: 'dm-worker' }]);
  assert.equal(worker.sessionIds['dm-worker'], 'codex-long');
  assert.equal(worker.usage['dm-worker'].sessions['codex-long'].totalTokens, 520);
});

test('a pi turn whose tool results pass 4 MiB delivers its final reply and adds up its spend', async (t) => {
  const tokens = (cost) => ({
    input: 1000,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1020,
    cost: { total: cost },
  });
  const { sent, worker } = await streamTurn(
    t,
    'pi',
    {
      before: [
        { type: 'session', version: 3, id: 'pi-long', cwd: ROOT },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'cat big.log' } }],
            model: 'gemini-3.5-flash-lite',
            usage: tokens(0.25),
            stopReason: 'toolUse',
          },
        },
      ],
      filler: {
        count: TOOL_EVENTS,
        event: {
          type: 'tool_execution_end',
          toolCallId: 'call_1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: toolOutput }] },
          isError: false,
        },
      },
      after: [
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: reply }],
            model: 'gemini-3.5-flash-lite',
            usage: tokens(0.5),
            stopReason: 'stop',
          },
        },
        { type: 'agent_end', messages: [] },
      ],
    },
    { model: 'google-vertex/gemini-3.5-flash-lite' },
  );
  assert.equal(worker.lastError, null);
  assert.equal(worker.status, 'idle');
  assert.deepEqual(sent, [{ from: 'worker', text: reply, conversationId: 'dm-worker' }]);
  assert.equal(worker.sessionIds['dm-worker'], 'pi-long');
  assert.deepEqual(worker.usage['dm-worker'].sessions['pi-long'], { adapter: 'pi', costUsd: 0.75, totalTokens: 2040 });
});

test('an event line that never ends stops the turn at the event-line limit and names that limit', async (t) => {
  const { store, sent, worker } = await streamTurn(t, 'claude', {
    before: [{ type: 'system', subtype: 'init', session_id: 'runaway', model: 'claude-opus-5-5' }],
    unterminated: true,
  });
  assert.equal(worker.status, 'error');
  assert.equal(worker.lastError, 'A single claude event line exceeded the 64 MiB limit without a newline');
  assert.ok(!worker.pendingResult);
  assert.equal(store.inbox('worker').length, 1);
  assert.deepEqual(
    sent.map((message) => message.from),
    ['system'],
  );
  assert.match(sent[0].text, /could not complete message #\d+: A single claude event line exceeded the 64 MiB limit/);
});

test('a text adapter that writes more than 4 MiB stops at the text reply limit and names that limit', async (t) => {
  const { worker } = await streamTurn(t, 'fixture', { filler: { count: TOOL_EVENTS, event: toolOutput } });
  assert.equal(worker.status, 'error');
  assert.equal(worker.lastError, "Agent output exceeded the 4 MiB limit for a text adapter's reply");
});

// Recorded from codex-cli 0.167.0 `exec --json` with an MCP server that does not answer: the turn's failure is on stdout, stderr holds only the MCP errors.
const mcpNoise = Array.from(
  { length: 40 },
  (_, index) =>
    `2026-11-06T11:29:${String(index).padStart(2, '0')}.720994Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (http://127.0.0.1:64342/stream)")))\n`,
).join('');
const flagged =
  'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.';

test('a Codex turn that exits nonzero reports its failure event with codex_error_info instead of the stderr noise', async (t) => {
  const { sent, worker } = await streamTurn(t, 'codex', {
    before: [{ type: 'thread.started', thread_id: 'codex-failed' }, { type: 'turn.started' }],
    after: [
      { type: 'error', message: flagged },
      { type: 'turn.failed', error: { message: flagged, codex_error_info: 'cyber_policy' } },
    ],
    stderr: mcpNoise,
    exitCode: 1,
  });
  assert.equal(worker.status, 'error');
  assert.equal(worker.lastError, `${process.execPath} exited 1: ${flagged} (codex_error_info: cyber_policy)`);
  assert.match(
    sent[0].text,
    /could not complete message #\d+: .* exited 1: This content was flagged .*\(codex_error_info: cyber_policy\)/,
  );
});

test('a Claude turn that exits nonzero reports its error result instead of stderr', async (t) => {
  const result =
    "There's an issue with the selected model (no-such-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.";
  const { worker } = await streamTurn(t, 'claude', {
    before: [{ type: 'system', subtype: 'init', session_id: 'claude-failed', model: 'no-such-model-xyz' }],
    after: [
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 404,
        terminal_reason: 'api_error',
        session_id: 'claude-failed',
        result,
        total_cost_usd: 0,
        modelUsage: {},
      },
    ],
    stderr: '[claude-code:unrecognized_model] {"model":"no-such-model-xyz","query_source":"sdk"}\n',
    exitCode: 1,
  });
  assert.equal(worker.lastError, `${process.execPath} exited 1: ${result}`);
});

test('a turn that exits nonzero without a failure event still reports the end of stderr', async (t) => {
  const { worker } = await streamTurn(t, 'codex', {
    before: [{ type: 'thread.started', thread_id: 'codex-crashed' }],
    stderr: 'thread panicked: out of memory\n',
    exitCode: 101,
  });
  assert.equal(worker.lastError, `${process.execPath} exited 101: thread panicked: out of memory`);
});

const hex = (text) => Buffer.from(text).toString('hex');

test('a final event without a trailing newline, written in two pieces, is read and delivered', async (t) => {
  const result = hex(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-tail',
      is_error: false,
      result: reply,
      total_cost_usd: 0.1,
      modelUsage: {},
    }),
  );
  const middle = result.length / 2 - ((result.length / 2) % 2);
  const { sent, signals, worker } = await streamTurn(t, 'claude', {
    chunks: [result.slice(0, middle), result.slice(middle)],
  });
  assert.equal(worker.lastError, null);
  assert.deepEqual(sent, [{ from: 'worker', text: reply, conversationId: 'dm-worker' }]);
  assert.equal(worker.sessionIds['dm-worker'], 'claude-tail');
  assert.deepEqual(signals, []);
});

test('a multibyte character split across two writes reaches the reply intact', async (t) => {
  const text = '@lead Готово 🙂, all checks pass.';
  const line = Buffer.from(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'claude-utf8',
      is_error: false,
      result: text,
      total_cost_usd: 0.1,
      modelUsage: {},
    }) + '\n',
  );
  const emoji = line.indexOf(Buffer.from('🙂'));
  const { sent, worker } = await streamTurn(t, 'claude', {
    chunks: [line.subarray(0, emoji + 2).toString('hex'), line.subarray(emoji + 2).toString('hex')],
  });
  assert.equal(worker.lastError, null);
  assert.deepEqual(sent, [{ from: 'worker', text, conversationId: 'dm-worker' }]);
});

test('an invalid last line without a newline fails the turn and sends no signal to the exited process group', async (t) => {
  const { signals, worker } = await streamTurn(t, 'claude', {
    before: [
      {
        type: 'result',
        subtype: 'success',
        session_id: 'claude-garbled',
        is_error: false,
        result: reply,
        total_cost_usd: 0.1,
        modelUsage: {},
      },
    ],
    chunks: [hex('{"type":"assistant","message":')],
  });
  assert.equal(worker.status, 'error');
  assert.match(worker.lastError, /^Invalid claude event: /);
  assert.deepEqual(signals, []);
});

test('a process that ignores SIGTERM after a limit stops its turn is killed with SIGKILL', async (t) => {
  const { signals, worker } = await streamTurn(t, 'claude', { ignoreTerm: true, unterminated: true });
  assert.equal(worker.lastError, 'A single claude event line exceeded the 64 MiB limit without a newline');
  assert.deepEqual(signals, [
    { signal: 'SIGTERM', exited: false },
    { signal: 'SIGKILL', exited: false },
  ]);
});

test('a failure event on an unterminated last line is reported when the CLI exits nonzero', async (t) => {
  const { worker } = await streamTurn(t, 'codex', {
    before: [{ type: 'thread.started', thread_id: 'codex-unterminated' }],
    chunks: [
      hex(JSON.stringify({ type: 'turn.failed', error: { message: flagged, codex_error_info: 'cyber_policy' } })),
    ],
    stderr: mcpNoise,
    exitCode: 1,
  });
  assert.equal(worker.lastError, `${process.execPath} exited 1: ${flagged} (codex_error_info: cyber_policy)`);
});

test('a last line cut off by a crash leaves the exit and its stderr as the reported failure', async (t) => {
  const { signals, worker } = await streamTurn(t, 'codex', {
    before: [{ type: 'thread.started', thread_id: 'codex-cut' }],
    chunks: [hex('{"type":"item.completed","item":{"te')],
    stderr: 'thread panicked: out of memory\n',
    exitCode: 101,
  });
  assert.equal(worker.lastError, `${process.execPath} exited 101: thread panicked: out of memory`);
  assert.deepEqual(signals, []);
});

test('a failure longer than a chat message is cut in the notice and kept whole in the last error', async (t) => {
  const long = 'Policy detail. '.repeat(10000);
  const { sent, worker } = await streamTurn(t, 'codex', {
    before: [{ type: 'thread.started', thread_id: 'codex-long-failure' }],
    after: [{ type: 'turn.failed', error: { message: long } }],
    exitCode: 1,
  });
  assert.ok(worker.lastError === `${process.execPath} exited 1: ${long}`, 'the last error keeps the whole failure');
  assert.deepEqual(
    sent.map((message) => message.from),
    ['system'],
  );
  assert.ok(sent[0].text.length < 5000, `notice is ${sent[0].text.length} characters`);
  assert.match(
    sent[0].text,
    /… \(cut to 4000 characters; the agent's last error has the full text\)\nThe message remains pending/,
  );
});

test('the notice cuts a long failure between characters, never inside an emoji', async (t) => {
  const failure = 'x' + '🙂'.repeat(5000);
  const { sent, worker } = await streamTurn(t, 'claude', {
    after: [
      {
        type: 'result',
        subtype: 'success',
        session_id: 'claude-emoji',
        is_error: true,
        result: failure,
        total_cost_usd: 0,
        modelUsage: {},
      },
    ],
  });
  assert.ok(worker.lastError === failure, 'the last error keeps the whole failure');
  assert.ok(sent[0].text.isWellFormed(), 'the notice holds no half of a surrogate pair');
  assert.ok(sent[0].text.includes(`x${'🙂'.repeat(3999)}… (cut to 4000 characters`));
});
