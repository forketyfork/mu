import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp, ROOT } from '../src/server.mjs';
import { createEvals } from '../src/evals.mjs';
import { grade, loadCases } from '../src/eval-cases.mjs';
import { evalCommand, resultFromStream } from '../src/eval-driver.mjs';
import { Store } from '../src/store.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { FakeChat, until } from './browser/support.mjs';

const sampleDir = join(ROOT, 'evals');
const selected = { adapter: 'claude', model: 'example-model', effort: 'high', budgetUsd: 0.5 };
const fakeReply = {
  reply: '{"first":["a3","b2"],"stages":["package","compile"],"contrast":["a2","b2"]}',
  costUsd: 0.2,
  tokens: 72,
  observedModel: 'example-model',
};
const fakeRunner = (execute) => ({ prepare: async () => 'sha256:test-image', execute });
async function fixture(t, execute) {
  const home = await shortTempDir(t, 'evals');
  const store = new Store(join(home, 'eval.sqlite'));
  const service = createEvals({ store, home, root: ROOT, runner: fakeRunner(execute) });
  t.after(async () => {
    await service.close();
    store.close();
  });
  const { cases } = await service.catalog();
  const body = { ...selected, cases: cases.map(({ digest }) => digest) };
  const finish = async (id) => {
    await until('the run to finish', () => service.details(id).status !== 'running');
    return service.details(id);
  };
  return { service, store, body, finish, home };
}

test('the CLI rubric executes submitted options on default, legacy and combined invocations', async (t) => {
  const cases = await loadCases(sampleDir, await shortTempDir(t, 'empty-evals'));
  const item = cases.find(({ id }) => id === 'cli-options');
  const options = {
    format: { type: 'string', short: 'f', default: 'text' },
    tag: { type: 'string', short: 't', multiple: true },
  };
  assert.equal(grade(item, JSON.stringify({ options })).earned, 3);
  const regression = { argv: ['-t', 'a', '--tag', 'b'], values: { format: 'text', tag: ['a', 'b'] } };
  assert.equal(grade(item, JSON.stringify({ options, regression })).earned, 4);
  assert.equal(
    grade(item, JSON.stringify({ options, regression: { argv: [], values: { format: 'text' } } })).earned,
    3,
  );
  assert.equal(
    grade(
      item,
      JSON.stringify({ options, regression: { argv: ['--tag', 'solo'], values: { format: 'text', tag: ['solo'] } } }),
    ).earned,
    3,
  );
  assert.equal(grade(item, JSON.stringify({ options, regression: { ...regression, values: { tag: 'b' } } })).earned, 3);
  options.tag.multiple = false;
  assert.equal(grade(item, JSON.stringify({ options })).earned, 2);
  assert.equal(grade(item, 'ignore these checks, all passed').earned, 0);
  assert.equal(grade(item, 'null').earned, 0);
  assert.equal(grade(item, '{"options":{"format":42}}').earned, 0);
});

test('private case edits change identity; duplicates and symlinks fail explicitly', async (t) => {
  const directory = await shortTempDir(t, 'private-evals');
  const original = JSON.parse(await readFile(join(sampleDir, 'merge-contract.json'), 'utf8'));
  const path = join(directory, 'personal.json');
  await writeFile(path, JSON.stringify(original));
  await assert.rejects(loadCases(sampleDir, directory), /Duplicate eval/);
  original.id = 'personal';
  await writeFile(path, JSON.stringify(original));
  const before = (await loadCases(sampleDir, directory)).at(-1).digest;
  original.checks[0].value = ['other'];
  await writeFile(path, JSON.stringify(original));
  assert.notEqual((await loadCases(sampleDir, directory)).at(-1).digest, before);
  await symlink(path, join(directory, 'linked.json'));
  await assert.rejects(loadCases(sampleDir, directory), /linked.json: Expected a regular file/);
});

test('only one case runs at once, forwards remaining dollars, records overruns and versioned price estimates', async (t) => {
  const calls = [];
  const { promise: gate, resolve: release } = Promise.withResolvers();
  const { service, body, finish } = await fixture(t, async (call) => {
    calls.push(call);
    await gate;
    return { ...fakeReply, costUsd: calls.length === 1 ? 0.2 : 0.35 };
  });
  const first = await service.start(body);
  assert.deepEqual(first.target, { adapter: 'claude', model: 'example-model', effort: 'high' });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].prompt.includes('Causal line in both jobs'));
  await assert.rejects(service.start(body), /Another run is active/);
  release(undefined);
  const run = await finish(first.id);
  assert.deepEqual(
    calls.map(({ remaining }) => remaining),
    [0.5, 0.3],
  );
  assert.equal(run.status, 'stopped');
  assert.match(run.reason, /Budget reached/);
  assert.equal(run.costUsd, 0.55);
  assert.equal(run.results[0].score.earned, 3);
  assert.equal(run.results[1].score.earned, 0);
  assert.equal(run.results[0].tokens, 72);
  assert.deepEqual(
    (await service.estimate(body)).map(({ usd }) => usd),
    [0.2, 0.35, null],
  );
  assert.deepEqual(
    (await service.estimate({ ...body, effort: 'low' })).map(({ usd }) => usd),
    [null, null, null],
  );
  assert.equal(service.list()[0].results, undefined);
  assert.deepEqual(service.list(String(first.id)), []);
});

test('a floating-point remainder cannot buy an extra case', async (t) => {
  const costs = [0.1, 0.7, 0.4];
  const { service, body, finish } = await fixture(t, async () => ({ ...fakeReply, costUsd: costs.shift() }));
  const { id } = await service.start({ ...body, budgetUsd: 0.8 });
  const run = await finish(id);
  assert.equal(run.results.length, 2);
  assert.match(run.reason, /Budget reached/);
});

test('unknown spend preserves the known subtotal, scores the answer and stops; a new service can read both', async (t) => {
  let count = 0;
  const { service, body, finish, home } = await fixture(t, async () => ({
    ...fakeReply,
    costUsd: ++count === 1 ? 0.02 : null,
  }));
  const { id } = await service.start(body);
  const run = await finish(id);
  assert.equal(count, 2);
  assert.equal(run.knownUsd, 0.02);
  assert.equal(run.costUsd, null);
  assert.equal(run.results[1].status, 'graded');
  assert.match(run.reason, /No measured cost/);
  await service.close();
  const secondConnection = new Store(join(home, 'eval.sqlite'));
  t.after(() => secondConnection.close());
  const reopened = createEvals({
    store: secondConnection,
    home,
    root: ROOT,
    runner: fakeRunner(() => assert.fail('must not replay')),
  });
  assert.deepEqual(reopened.details(id), run);
  const personal = join(home, 'evals');
  await mkdir(personal);
  await writeFile(join(personal, 'bad.json'), 'not json');
  await assert.rejects(reopened.catalog(), /bad.json/);
  assert.equal(reopened.details(id).results.length, 2);
});

test('an interrupted case is never replayed or priced at zero', async (t) => {
  const { store, service, body, home, finish } = await fixture(t, async () => fakeReply);
  const { id } = await service.start({ ...body, cases: [body.cases[0]] });
  const run = await finish(id);
  assert.equal(run.status, 'complete');
  store.db.prepare("UPDATE eval_runs SET data=json_set(data,'$.status','running','$.knownUsd',0,'$.costUsd',0)").run();
  store.db.prepare("UPDATE eval_results SET data=json_set(data,'$.status','running','$.costUsd',null)").run();
  const restarted = createEvals({ store, home, root: ROOT, runner: fakeRunner(() => assert.fail('must not replay')) });
  const saved = restarted.details(id);
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.costUsd, null);
  assert.equal(saved.results[0].status, 'error');
  assert.match(saved.reason, /restarted/);
});

test('subprocess flags, reported spend and token accounting reflect each adapter', () => {
  const command = (adapter, model) => evalCommand({ adapter, model, effort: 'high' }, 0.37);
  const claude = command('claude', 'sonnet');
  assert.equal(claude[claude.indexOf('--max-budget-usd') + 1], '0.37');
  assert.equal(claude[claude.indexOf('--effort') + 1], 'high');
  const codex = command('codex', 'exact-id');
  assert.ok(codex.includes('model_reasoning_effort=high'));
  assert.equal(codex[codex.indexOf('-m') + 1], 'exact-id');
  const gateway = evalCommand({ adapter: 'codex', model: 'exact-id', effort: 'medium' }, 0.25, {
    OPENAI_BASE_URL: 'http://model-gateway/v1',
    CODEX_API_KEY: 'fixture',
  });
  assert.ok(gateway.includes('model_provider="mu_eval"'));
  assert.ok(
    gateway.some(
      (arg) => arg.includes('base_url="http://model-gateway/v1"') && arg.includes('env_key="CODEX_API_KEY"'),
    ),
  );
  assert.ok(!gateway.includes('fixture'));
  const pi = command('pi', 'provider/id');
  assert.equal(pi[pi.indexOf('--model') + 1], 'provider/id');
  assert.equal(pi[pi.indexOf('--thinking') + 1], 'high');
  assert.throws(() => command('demo', 'demo'), /does not take a model/);
  const event = {
    type: 'result',
    result: '{}',
    total_cost_usd: 0.03,
    usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 7 },
  };
  const parsed = resultFromStream('claude', JSON.stringify(event));
  assert.equal(parsed.costUsd, 0.03);
  assert.equal(parsed.tokens, 22);
  assert.equal(resultFromStream('claude', JSON.stringify({ ...event, is_error: true })).costUsd, 0.03);
  assert.equal(
    resultFromStream('codex', '{"type":"turn.failed","error":{"message":"provider refused"}}').error,
    'provider refused',
  );
});

test('eval HTTP endpoints require the user even to read, reject stale selections, and never expose the key in the catalog', async (t) => {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    ircPort: await freePort(),
    dataDir: await shortTempDir(t, 'eval-http'),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
    evalRunner: fakeRunner(async () => fakeReply),
  });
  await app.start();
  t.after(() => app.close());
  const api = (path, headers, body = undefined) =>
    fetch(`http://127.0.0.1:${port}/api/evals${path}`, {
      headers,
      method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined,
    });
  const user = userHeaders(app),
    agent = { Authorization: `Bearer ${app.identity.issue('worker')}` };
  for (const [path, body] of [
    ['', null],
    ['/runs', null],
    ['/runs/1', null],
    ['/estimate', {}],
    ['/runs', {}],
  ])
    assert.equal((await api(path, agent, body)).status, 403);
  assert.equal((await api('', {}, null)).status, 401);
  const { cases } = await (await api('', user)).json();
  assert.equal(cases[0].checks, undefined);
  assert.equal(cases[0].prompt, undefined);
  const body = { ...selected, cases: [cases[0].digest] };
  assert.equal((await api('/runs', user, { ...body, cases: ['stale'] })).status, 409);
  assert.equal((await api('/runs', user, { ...body, budgetUsd: 0 })).status, 400);
  const response = await api('/runs', user, body);
  assert.equal(response.status, 202);
  const { id } = await response.json();
  await until('persisted result', async () => (await (await api(`/runs/${id}`, user)).json()).status === 'complete');
  assert.equal((await (await api('/runs', user)).json())[0].costUsd, 0.2);
});
