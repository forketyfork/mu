import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PricingCatalog, parsePrices, priceCalls } from '../src/pricing.mjs';
import { ROOT } from '../src/server.mjs';

// Rates copied from LiteLLM's model_prices_and_context_window.json on 2026-11-04.
const astra = {
  input_cost_per_token: 0.00001,
  output_cost_per_token: 0.00005,
  cache_read_input_token_cost: 0.000001,
  cache_creation_input_token_cost: 0.0000125,
  input_cost_per_token_above_272k_tokens: 0.00002,
  output_cost_per_token_above_272k_tokens: 0.000075,
  cache_read_input_token_cost_above_272k_tokens: 0.000002,
  cache_creation_input_token_cost_above_272k_tokens: 0.000025,
  input_cost_per_token_priority: 0.00002,
  output_cost_per_token_priority: 0.0001,
  cache_read_input_token_cost_priority: 0.000002,
  cache_creation_input_token_cost_priority: 0.000025,
};
const legacy = {
  input_cost_per_token: 0.00000125,
  output_cost_per_token: 0.00001,
  cache_read_input_token_cost: 1.25e-7,
};
const litellm = {
  'gpt-6-astra': { ...astra, litellm_provider: 'openai', mode: 'chat', search_context_cost_per_query: { low: 0.01 } },
  'gpt-5-codex': legacy,
  'dall-e-3': { input_cost_per_pixel: 1e-8 },
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 'n/a' },
};
const models = parsePrices(litellm);
// Token counts recorded from a codex-cli 0.166.0 rollout: input includes cached reads and cache writes.
const call = (overrides = {}) => ({
  model: 'gpt-6-astra',
  serviceTier: 'default',
  input: 38419,
  cachedInput: 6415,
  cacheWrite: 32001,
  output: 55,
  ...overrides,
});

test('LiteLLM data keeps the numeric cost fields of models with per-token prices', () => {
  assert.deepEqual(Object.keys(models).sort(), ['gpt-5-codex', 'gpt-6-astra']);
  assert.deepEqual(models['gpt-6-astra'], astra);
  assert.throws(() => parsePrices({ 'dall-e-3': { input_cost_per_pixel: 1e-8 } }), /no per-token prices/);
  assert.throws(() => parsePrices([]), /not a JSON object/);
});

test('a disabled catalog reads cached prices without making requests', async (t) => {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.tmp', 'disabled-pricing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheFile = join(directory, 'prices.json');
  await writeFile(
    cacheFile,
    JSON.stringify({ url: 'https://prices.example', fetchedAt: '2026-11-04T12:00:00.000Z', models }),
  );
  let fetches = 0;
  const catalog = new PricingCatalog({
    cacheFile,
    url: 'https://prices.example',
    enabled: false,
    fetch: async () => {
      fetches += 1;
      throw new Error('fetch should not run');
    },
  });
  await catalog.start();
  t.after(() => catalog.close());

  assert.equal(catalog.price([call()]).costUsd, priceCalls(models, [call()]).costUsd);
  assert.match(catalog.price([call({ model: 'not-listed' })]).costError, /price fetching is disabled/);
  assert.equal(catalog.price([call({ model: 'not-listed' })]).costPending, false);
  await catalog.refresh();
  assert.equal(fetches, 0);
});

test('a disabled catalog reports the opt-out when it has no cache', async (t) => {
  let fetches = 0;
  const catalog = new PricingCatalog({
    enabled: false,
    fetch: async () => {
      fetches += 1;
      throw new Error('fetch should not run');
    },
  });
  await catalog.start();
  t.after(() => catalog.close());

  assert.deepEqual(catalog.price([call()]), {
    costUsd: null,
    costPending: false,
    costError: 'LiteLLM price fetching is disabled',
    pricesFetchedAt: null,
  });
  assert.equal(fetches, 0);
});

test('a call is priced by uncached input, cached input, cache writes and output', () => {
  const { costUsd, costError } = priceCalls(models, [call()]);
  assert.equal(costError, null);
  assert.ok(Math.abs(costUsd - (3 * 0.00001 + 6415 * 0.000001 + 32001 * 0.0000125 + 55 * 0.00005)) < 1e-12);
  const both = priceCalls(models, [
    call(),
    call({ model: 'gpt-5-codex', input: 1000, cachedInput: 400, cacheWrite: 0, output: 10 }),
  ]);
  assert.ok(Math.abs(both.costUsd - costUsd - (600 * 0.00000125 + 400 * 1.25e-7 + 10 * 0.00001)) < 1e-12);
});

test('prompt-size bands and service tiers select their own LiteLLM rates', () => {
  const large = priceCalls(models, [call({ input: 300000, cachedInput: 0, cacheWrite: 0, output: 100 })]);
  assert.ok(Math.abs(large.costUsd - (300000 * 0.00002 + 100 * 0.000075)) < 1e-12);
  const atThreshold = priceCalls(models, [call({ input: 272000, cachedInput: 0, cacheWrite: 0, output: 0 })]);
  assert.ok(Math.abs(atThreshold.costUsd - 272000 * 0.00001) < 1e-12);
  const fast = priceCalls(models, [call({ serviceTier: 'fast', input: 10, cachedInput: 0, cacheWrite: 0, output: 1 })]);
  assert.ok(Math.abs(fast.costUsd - (10 * 0.00002 + 0.0001)) < 1e-12);
  assert.equal(
    priceCalls(models, [call({ serviceTier: null, input: 10, cachedInput: 0, cacheWrite: 0, output: 0 })]).costUsd,
    10 * 0.00001,
  );
});

test('a rate that LiteLLM does not list makes the cost unknown instead of borrowing another rate', () => {
  assert.deepEqual(priceCalls(models, [call(), call({ model: 'gpt-7' })]), {
    costUsd: null,
    costError: 'LiteLLM has no per-token price for gpt-7',
  });
  assert.deepEqual(priceCalls(models, [call({ model: 'gpt-5-codex' })]), {
    costUsd: null,
    costError: 'LiteLLM lists no cache write price for gpt-5-codex',
  });
  assert.deepEqual(priceCalls(models, [call({ serviceTier: 'fast', input: 300000 })]), {
    costUsd: null,
    costError:
      'LiteLLM lists no input price for gpt-6-astra in the fast tier above 272k prompt tokens; LiteLLM lists no cached input price for gpt-6-astra in the fast tier above 272k prompt tokens; LiteLLM lists no cache write price for gpt-6-astra in the fast tier above 272k prompt tokens; LiteLLM lists no output price for gpt-6-astra in the fast tier above 272k prompt tokens',
  });
  assert.match(
    priceCalls(models, [call({ serviceTier: 'scale' })]).costError,
    /cannot price the Codex service tier "scale"/,
  );
  assert.match(priceCalls(models, [call({ model: null })]).costError, /does not name the model/);
  assert.match(priceCalls(models, [call({ cachedInput: 40000 })]).costError, /more cached than total input/);
});

function deferredFetch() {
  const requests = [];
  const fetch = (url, options) =>
    new Promise((resolve, reject) =>
      requests.push({
        url,
        options,
        resolve: (data) => resolve({ ok: true, status: 200, json: async () => data }),
        fail: reject,
        status: (status) => resolve({ ok: false, status }),
      }),
    );
  return { fetch, requests };
}
const settled = (catalog) => new Promise((resolve) => catalog.once('update', resolve));

test('an unknown model fetches prices immediately, is pending meanwhile, and stays unknown with a reason when still missing', async () => {
  let now = Date.parse('2026-11-04T12:00:00Z');
  const { fetch, requests } = deferredFetch();
  const catalog = new PricingCatalog({ fetch, now: () => now });
  const pending = catalog.price([call()]);
  assert.deepEqual(pending, {
    costUsd: null,
    costPending: true,
    costError: 'Fetching LiteLLM prices for gpt-6-astra',
    pricesFetchedAt: null,
  });
  catalog.price([call()]);
  assert.equal(requests.length, 1, 'a fetch in progress is shared');
  let update = settled(catalog);
  requests[0].resolve({ 'gpt-5-codex': legacy });
  await update;
  assert.deepEqual(catalog.price([call()]), {
    costUsd: null,
    costPending: false,
    costError: 'LiteLLM has no per-token price for gpt-6-astra (prices fetched 2026-11-04T12:00:00.000Z)',
    pricesFetchedAt: '2026-11-04T12:00:00.000Z',
  });
  assert.equal(requests.length, 1, 'a model missing right after a fetch waits for the retry interval');
  now += 60 * 1000;
  assert.equal(catalog.price([call()]).costPending, true);
  assert.equal(requests.length, 2);
  update = settled(catalog);
  requests[1].resolve(litellm);
  await update;
  const priced = catalog.price([call()]);
  assert.equal(priced.costError, null);
  assert.equal(priced.pricesFetchedAt, '2026-11-04T12:01:00.000Z');
  assert.ok(priced.costUsd > 0.4);
});

test('a failed fetch leaves the cost unknown and names the failure', async () => {
  let now = Date.parse('2026-11-04T12:00:00Z');
  const { fetch, requests } = deferredFetch();
  const catalog = new PricingCatalog({ fetch, now: () => now });
  catalog.price([call()]);
  let update = settled(catalog);
  requests[0].status(503);
  await update;
  assert.deepEqual(catalog.price([call()]), {
    costUsd: null,
    costPending: false,
    costError: `LiteLLM prices unavailable: HTTP 503 from ${catalog.url}`,
    pricesFetchedAt: null,
  });
  now += 60 * 1000;
  catalog.price([call()]);
  update = settled(catalog);
  requests[1].resolve({ 'gpt-5-codex': legacy });
  await update;
  now += 60 * 1000;
  catalog.price([call()]);
  update = settled(catalog);
  requests[2].fail(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'));
  await update;
  assert.equal(
    catalog.price([call()]).costError,
    'LiteLLM has no per-token price for gpt-6-astra (prices fetched 2026-11-04T12:01:00.000Z; the latest LiteLLM fetch failed: getaddrinfo ENOTFOUND raw.githubusercontent.com)',
  );
  assert.ok(requests[0].options.signal instanceof AbortSignal, 'fetches are bounded by a timeout');
});

test('prices are cached on disk, reused while fresh, and refreshed when stale and periodically', async (t) => {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.tmp/pricing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cacheFile = join(directory, 'litellm-prices.json');
  let now = Date.parse('2026-11-04T12:00:00Z');
  const first = deferredFetch();
  const catalog = new PricingCatalog({ cacheFile, fetch: first.fetch, now: () => now });
  await catalog.start();
  t.after(() => catalog.close());
  assert.equal(first.requests.length, 1, 'starting without a cache fetches prices');
  const update = settled(catalog);
  first.requests[0].resolve(litellm);
  await update;
  assert.deepEqual(JSON.parse(await readFile(cacheFile, 'utf8')), {
    url: catalog.url,
    fetchedAt: '2026-11-04T12:00:00.000Z',
    models,
  });
  catalog.close();

  now += 60 * 60 * 1000;
  const second = deferredFetch();
  const warm = new PricingCatalog({ cacheFile, fetch: second.fetch, now: () => now });
  await warm.start();
  warm.close();
  assert.equal(second.requests.length, 0, 'a fresh cache is used without fetching');
  assert.equal(warm.price([call()]).pricesFetchedAt, '2026-11-04T12:00:00.000Z');

  now += 3 * 60 * 60 * 1000;
  const third = deferredFetch();
  const stale = new PricingCatalog({ cacheFile, fetch: third.fetch, now: () => now });
  await stale.start();
  stale.close();
  assert.equal(third.requests.length, 1, 'a cache older than the refresh interval is refreshed');
  assert.equal(stale.price([call()]).costError, null, 'known models keep their cached prices during the refresh');

  await writeFile(cacheFile, '{"url":');
  const periodic = deferredFetch();
  const ticking = new PricingCatalog({ cacheFile, fetch: periodic.fetch, refreshIntervalMs: 20 });
  const errors = [];
  const error = console.error;
  console.error = (message) => errors.push(message);
  try {
    await ticking.start();
  } finally {
    console.error = error;
  }
  t.after(() => ticking.close());
  assert.match(errors[0], /Ignoring unreadable LiteLLM price cache/);
  periodic.requests[0].resolve(litellm);
  const end = Date.now() + 2000;
  while (periodic.requests.length < 2 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(periodic.requests.length >= 2, 'the refresh timer fetches again');
});
