import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseUsage, readTurn } from '../src/adapters.mjs';
import { Runner } from '../src/runner.mjs';
import { CodexRollouts, parseRollout } from '../src/codex-rollout.mjs';
import { PricingCatalog } from '../src/pricing.mjs';
import { Store } from '../src/store.mjs';
import { ROOT } from '../src/server.mjs';
import { testIdentity } from './identity-fixture.mjs';
import { FAKE_PRIVATE_PATHS, temporaryMuHome } from './isolation.mjs';

const astraPrices = {
  'gpt-6-astra': {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00005,
    cache_read_input_token_cost: 0.000001,
    cache_creation_input_token_cost: 0.0000125,
  },
};
function pricingWith(prices, now = () => Date.parse('2026-11-04T12:00:00Z')) {
  const requests = [];
  const fetch = () =>
    new Promise((resolve, reject) =>
      requests.push({ resolve: (data = prices) => resolve({ ok: true, status: 200, json: async () => data }), reject }),
    );
  return { pricing: new PricingCatalog({ fetch, now }), requests };
}

const lines = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

// Shapes recorded from Claude Code 2.1.318 stream-json and codex-cli 0.166.0 exec --json output.
const claudeTurn = ({ session = 'claude-session', cost = 0.2088886, contextWindow = 1000000, extra = [] } = {}) =>
  lines([
    { type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5' },
    {
      type: 'assistant',
      session_id: session,
      parent_tool_use_id: null,
      message: {
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 25831,
          cache_read_input_tokens: 10763,
          output_tokens: 4,
        },
      },
    },
    ...extra,
    {
      type: 'result',
      subtype: 'success',
      session_id: session,
      is_error: false,
      result: 'OK',
      total_cost_usd: cost,
      modelUsage: { 'claude-opus-5-5': { costUSD: cost, contextWindow, maxOutputTokens: 128000 } },
    },
  ]);
const codexTurn = (inputTokens, outputTokens) =>
  lines([
    { type: 'thread.started', thread_id: 'codex-thread' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'OK' } },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: inputTokens,
        cached_input_tokens: 0,
        output_tokens: outputTokens,
        reasoning_output_tokens: 0,
      },
    },
  ]);

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setup(
  t,
  adapter,
  codexRollouts = new CodexRollouts(join(ROOT, '.tmp/no-codex-home')),
  pricing = pricingWith(astraPrices).pricing,
) {
  const store = new Store();
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  store.createAgent({ id: 'worker', role: 'worker', adapter, cwd: ROOT, task: 'Measure' });
  const runner = new Runner({
    home: await temporaryMuHome(t),
    identity: testIdentity(t),
    store,
    chat: { state: { connected: true }, async send() {} },
    root: ROOT,
    url: 'http://127.0.0.1:4310',
    codexRollouts,
    pricing,
    privatePaths: FAKE_PRIVATE_PATHS,
  });
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  return { store, runner };
}

async function turn(store, runner, id) {
  store.addMessage(`turn-${id}`, 'user', 'Report', 'dm-worker');
  runner.kick();
  await until(() => !runner.active.size);
}

test('Claude usage reports model, main-context occupation, window and cumulative session cost', () => {
  const subagent = {
    type: 'assistant',
    session_id: 'claude-session',
    parent_tool_use_id: 'tool-1',
    message: { model: 'claude-haiku-5-5', usage: { input_tokens: 900000, output_tokens: 1 } },
  };
  assert.deepEqual(parseUsage('claude', claudeTurn({ extra: [subagent] })), {
    sessionId: 'claude-session',
    model: 'claude-opus-5-5',
    contextTokens: 36600,
    contextWindow: 1000000,
    costUsd: 0.2088886,
    totalTokens: null,
  });
});

test('Codex usage reports only cumulative thread tokens', () => {
  assert.deepEqual(parseUsage('codex', codexTurn(31741, 11)), {
    sessionId: 'codex-thread',
    model: null,
    contextTokens: null,
    contextWindow: null,
    costUsd: null,
    totalTokens: 31752,
  });
  assert.equal(parseUsage('text', 'plain reply'), null);
});

test('a resumed Claude session replaces its cumulative cost and a new session adds to the conversation spend', async (t) => {
  const { store, runner } = await setup(t, 'claude');
  const outputs = [
    claudeTurn({ cost: 0.2 }),
    claudeTurn({ cost: 0.35 }),
    claudeTurn({ session: 'second-session', cost: 0.1 }),
  ];
  runner.execute = async (command) => readTurn(command.format, outputs.shift());
  await turn(store, runner, 1);
  await turn(store, runner, 2);
  assert.deepEqual(store.agent('worker').usage['dm-worker'].sessions, {
    'claude-session': { adapter: 'claude', costUsd: 0.35, totalTokens: null },
  });
  await turn(store, runner, 3);
  const usage = store.agent('worker').usage['dm-worker'];
  assert.deepEqual(usage.sessions, {
    'claude-session': { adapter: 'claude', costUsd: 0.35, totalTokens: null },
    'second-session': { adapter: 'claude', costUsd: 0.1, totalTokens: null },
  });
  assert.equal(usage.sessionId, 'second-session');
  assert.equal(usage.contextTokens, 36600);
  assert.equal(usage.contextWindow, 1000000);
  assert.equal(usage.model, 'claude-opus-5-5');
});

test('a failed Claude result still records the cost it reports', async (t) => {
  const { store, runner } = await setup(t, 'claude');
  runner.execute = async (command) =>
    readTurn(
      command.format,
      lines([
        { type: 'system', subtype: 'init', session_id: 'failed-session', model: 'claude-opus-5-5' },
        {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'failed-session',
          is_error: true,
          errors: ['permission denied'],
          total_cost_usd: 0.07,
          modelUsage: {},
        },
      ]),
    );
  await turn(store, runner, 1);
  assert.equal(store.agent('worker').status, 'error');
  assert.match(store.agent('worker').lastError, /permission denied/);
  assert.equal(store.agent('worker').usage['dm-worker'].sessions['failed-session'].costUsd, 0.07);
});

// Shape recorded from a codex-cli 0.166.0 rollout file after a resumed turn. Codex repeats a token_count event
// unchanged when only rate limits change; input tokens include cached reads and cache writes.
const tokens = (input, cachedInput, cacheWrite, output) => ({
  input_tokens: input,
  cached_input_tokens: cachedInput,
  cache_write_input_tokens: cacheWrite,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output,
});
const rollout = lines([
  { type: 'session_meta', payload: { id: 'codex-thread', cli_version: '0.166.0' } },
  {
    type: 'event_msg',
    payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', service_tier: 'default' } },
  },
  { type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-6-astra' } },
  {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: tokens(15833, 0, 15800, 5),
        last_token_usage: tokens(15833, 0, 15800, 5),
        model_context_window: 258400,
      },
    },
  },
  {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: tokens(15833, 0, 15800, 5),
        last_token_usage: tokens(15833, 0, 15800, 5),
        model_context_window: 258400,
      },
      rate_limits: { limit_id: 'codex' },
    },
  },
  { type: 'turn_context', payload: { turn_id: 't2', model: 'gpt-6-astra' } },
  {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: tokens(31741, 15800, 15900, 11),
        last_token_usage: tokens(15908, 15800, 100, 6),
        model_context_window: 258400,
      },
    },
  },
]);
const rolloutCost =
  33 * 0.00001 + 15800 * 0.0000125 + 5 * 0.00005 + (8 * 0.00001 + 15800 * 0.000001 + 100 * 0.0000125 + 6 * 0.00005);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('the Codex rollout parser reads the latest model, context and window, one entry per model call, and rejects unknown content', () => {
  assert.deepEqual(parseRollout(rollout), {
    model: 'gpt-6-astra',
    contextTokens: 15914,
    contextWindow: 258400,
    calls: [
      { model: 'gpt-6-astra', serviceTier: 'default', input: 15833, cachedInput: 0, cacheWrite: 15800, output: 5 },
      { model: 'gpt-6-astra', serviceTier: 'default', input: 15908, cachedInput: 15800, cacheWrite: 100, output: 6 },
    ],
  });
  const switched = parseRollout(
    rollout +
      lines([
        {
          type: 'event_msg',
          payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-sol', service_tier: 'fast' } },
        },
        { type: 'turn_context', payload: { turn_id: 't3', model: 'gpt-6-sol' } },
        {
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: tokens(31751, 15800, 15900, 12),
              last_token_usage: tokens(10, 0, 0, 1),
              model_context_window: 400000,
            },
          },
        },
      ]),
  );
  assert.deepEqual(switched.calls.at(-1), {
    model: 'gpt-6-sol',
    serviceTier: 'fast',
    input: 10,
    cachedInput: 0,
    cacheWrite: 0,
    output: 1,
  });
  assert.equal(switched.calls.length, 3);
  assert.throws(() => parseRollout(lines([{ type: 'session_meta', payload: {} }])), /no turn_context or token_count/);
  assert.throws(() => parseRollout('{"type":'), /Invalid Codex rollout line 1/);
});

async function codexHomeWith(t, text) {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const home = await mkdtemp(join(ROOT, '.tmp/codex-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'sessions/2026/11/04'), { recursive: true });
  await writeFile(
    join(home, 'sessions/2026/11/04/rollout-2026-11-04T14-44-40-other-thread.jsonl'),
    lines([{ type: 'turn_context', payload: { model: 'wrong-model' } }]),
  );
  await writeFile(join(home, 'sessions/2026/11/04/rollout-2026-11-04T14-44-40-codex-thread.jsonl'), text);
  return home;
}

test('a Codex turn with a model missing from the cached prices fetches LiteLLM prices and is priced when they arrive', async (t) => {
  const { pricing, requests } = pricingWith(astraPrices);
  const { store, runner } = await setup(t, 'codex', new CodexRollouts(await codexHomeWith(t, rollout)), pricing);
  runner.execute = async (command) => readTurn(command.format, codexTurn(31741, 11));
  await turn(store, runner, 1);
  const usage = store.agent('worker').usage['dm-worker'];
  assert.deepEqual(
    {
      model: usage.model,
      contextTokens: usage.contextTokens,
      contextWindow: usage.contextWindow,
      usageError: usage.usageError,
    },
    { model: 'gpt-6-astra', contextTokens: 15914, contextWindow: 258400, usageError: null },
  );
  assert.deepEqual(usage.sessions, {
    'codex-thread': {
      adapter: 'codex',
      costUsd: null,
      costError: 'Fetching LiteLLM prices for gpt-6-astra',
      costPending: true,
      pricesFetchedAt: null,
      totalTokens: 31752,
    },
  });
  assert.equal(requests.length, 1);
  requests[0].resolve();
  await until(() => store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costUsd !== null);
  const session = store.agent('worker').usage['dm-worker'].sessions['codex-thread'];
  near(session.costUsd, rolloutCost);
  assert.deepEqual(
    { ...session, costUsd: 0 },
    {
      adapter: 'codex',
      costUsd: 0,
      costError: null,
      costPending: false,
      pricesFetchedAt: '2026-11-04T12:00:00.000Z',
      totalTokens: 31752,
    },
  );

  runner.execute = async (command) => readTurn(command.format, codexTurn(31741, 11));
  await turn(store, runner, 2);
  near(store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costUsd, rolloutCost);
  assert.equal(requests.length, 1, 'cached prices are reused for a known model');
});

test('a Codex session stays unpriced with the reason when LiteLLM lacks the model or the fetch fails', async (t) => {
  const home = await codexHomeWith(t, rollout);
  const missing = pricingWith({ 'gpt-5-codex': { input_cost_per_token: 1e-6, output_cost_per_token: 1e-5 } });
  const first = await setup(t, 'codex', new CodexRollouts(home), missing.pricing);
  first.runner.execute = async (command) => readTurn(command.format, codexTurn(31741, 11));
  await turn(first.store, first.runner, 1);
  missing.requests[0].resolve();
  await until(() => !first.store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costPending);
  assert.deepEqual(first.store.agent('worker').usage['dm-worker'].sessions['codex-thread'], {
    adapter: 'codex',
    costUsd: null,
    costError: 'LiteLLM has no per-token price for gpt-6-astra (prices fetched 2026-11-04T12:00:00.000Z)',
    costPending: false,
    pricesFetchedAt: '2026-11-04T12:00:00.000Z',
    totalTokens: 31752,
  });

  const failing = pricingWith(astraPrices);
  const second = await setup(t, 'codex', new CodexRollouts(home), failing.pricing);
  second.runner.execute = async (command) => readTurn(command.format, codexTurn(31741, 11));
  await turn(second.store, second.runner, 1);
  const error = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = error;
  });
  failing.requests[0].reject(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'));
  await until(() => !second.store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costPending);
  assert.equal(
    second.store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costError,
    'LiteLLM prices unavailable: getaddrinfo ENOTFOUND raw.githubusercontent.com',
  );
  assert.equal(second.store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costUsd, null);
});

test('repricing on start fetches prices for Codex sessions recorded before Mu priced Codex usage', async (t) => {
  const { pricing, requests } = pricingWith(astraPrices);
  const { store, runner } = await setup(t, 'codex', new CodexRollouts(await codexHomeWith(t, rollout)), pricing);
  store.updateAgent('worker', {
    usage: {
      'dm-worker': {
        adapter: 'codex',
        sessionId: 'codex-thread',
        sessions: { 'codex-thread': { adapter: 'codex', costUsd: null, totalTokens: 31752 } },
        updatedAt: '2026-11-04T11:00:00Z',
      },
    },
  });
  await runner.reprice({ fetchMissing: true });
  assert.equal(requests.length, 1);
  requests[0].resolve();
  await until(() => store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costUsd !== null);
  near(store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costUsd, rolloutCost);
  assert.equal(store.agent('worker').usage['dm-worker'].sessions['codex-thread'].totalTokens, 31752);
});

test('repricing after a fetch does not fetch again for a model that LiteLLM does not list', async (t) => {
  let now = Date.parse('2026-11-04T12:00:00Z');
  const { pricing, requests } = pricingWith(
    { 'gpt-5-codex': { input_cost_per_token: 1e-6, output_cost_per_token: 1e-5 } },
    () => now,
  );
  const { store, runner } = await setup(t, 'codex', new CodexRollouts(await codexHomeWith(t, rollout)), pricing);
  runner.execute = async (command) => readTurn(command.format, codexTurn(31741, 11));
  await turn(store, runner, 1);
  now += 2 * 60 * 1000;
  requests[0].resolve();
  await until(() => !store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costPending);
  await runner.repricing;
  assert.match(
    store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costError,
    /^LiteLLM has no per-token price for gpt-6-astra/,
  );
  assert.equal(requests.length, 1);
});

test('a fetch that completes while the turn is still delivering its reply prices the session', async (t) => {
  const { pricing, requests } = pricingWith(astraPrices);
  const { store, runner } = await setup(t, 'codex', new CodexRollouts(await codexHomeWith(t, rollout)), pricing);
  /** @type {(value?: unknown) => void} */
  let release;
  const delivered = new Promise((resolve) => {
    release = resolve;
  });
  runner.chat.send = () => delivered;
  runner.execute = async (command) => readTurn(command.format, codexTurn(31741, 11));
  store.addMessage('slow-delivery', 'user', 'Report', 'dm-worker');
  runner.kick();
  await until(() => store.agent('worker').usage?.['dm-worker']?.sessions?.['codex-thread']?.costPending);
  requests[0].resolve();
  await until(() => store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costUsd !== null);
  assert.equal(runner.active.has('worker'), true);
  near(store.agent('worker').usage['dm-worker'].sessions['codex-thread'].costUsd, rolloutCost);
  release();
  await until(() => !runner.active.size);
});

test('a missing Codex rollout is recorded as a usage error without failing the turn', async (t) => {
  const { store, runner } = await setup(t, 'codex');
  runner.execute = async (command) => readTurn(command.format, codexTurn(15833, 5));
  await turn(store, runner, 1);
  const worker = store.agent('worker');
  assert.equal(worker.status, 'idle');
  assert.match(worker.usage['dm-worker'].usageError, /^Codex session log unavailable: .*no-codex-home/);
  assert.equal(worker.usage['dm-worker'].model, null);
  assert.equal(worker.usage['dm-worker'].sessions['codex-thread'].totalTokens, 15838);
  assert.equal(worker.usage['dm-worker'].sessions['codex-thread'].costUsd, null);
  assert.match(worker.usage['dm-worker'].sessions['codex-thread'].costError, /^Codex session log unavailable: /);
});

test('Claude context occupation is recorded while the turn is still running', async (t) => {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.tmp/usage-live-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = join(directory, 'release');
  const events = claudeTurn().trim().split('\n');
  await writeFile(
    join(directory, 'claude'),
    `#!${process.execPath}
import {existsSync} from 'node:fs';
for await (const chunk of process.stdin) {}
console.log(${JSON.stringify(events.slice(0, 2).join('\n'))});
while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
console.log(${JSON.stringify(events[2])});
`,
  );
  await chmod(join(directory, 'claude'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${directory}:${path}`;
  t.after(() => {
    process.env.PATH = path;
  });
  const { store, runner } = await setup(t, 'claude');
  store.addMessage('live', 'user', 'Report', 'dm-worker');
  runner.kick();
  await until(() => store.agent('worker').usage?.['dm-worker']?.contextTokens === 36600);
  const live = store.agent('worker').usage['dm-worker'];
  assert.equal(runner.active.has('worker'), true);
  assert.deepEqual(live.sessions, {});
  assert.equal(live.model, 'claude-opus-5-5');
  await writeFile(release, '');
  await until(() => !runner.active.size);
  assert.equal(store.agent('worker').usage['dm-worker'].sessions['claude-session'].costUsd, 0.2088886);
});
