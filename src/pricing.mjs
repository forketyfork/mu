import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
// A model missing from the cached prices triggers a fetch at most this often, so repeated sightings do not hammer GitHub.
const UNKNOWN_MODEL_RETRY_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;

// Codex service tiers and the LiteLLM key suffix that prices them. Codex sends `fast` to the API as priority processing.
const TIER_SUFFIXES = Object.freeze({ default: '', fast: '_priority', priority: '_priority', flex: '_flex' });
const RATES = Object.freeze([
  ['uncached', 'input_cost_per_token', 'input'],
  ['cachedInput', 'cache_read_input_token_cost', 'cached input'],
  ['cacheWrite', 'cache_creation_input_token_cost', 'cache write'],
  ['output', 'output_cost_per_token', 'output'],
]);

// Keeps the numeric cost fields of every entry that has per-token input and output prices.
export function parsePrices(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('LiteLLM price data is not a JSON object');
  const models = {};
  for (const [name, entry] of Object.entries(data)) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.input_cost_per_token !== 'number' ||
      typeof entry.output_cost_per_token !== 'number'
    )
      continue;
    models[name] = Object.fromEntries(
      Object.entries(entry).filter(([key, value]) => key.includes('cost') && typeof value === 'number'),
    );
  }
  if (!Object.keys(models).length) throw new Error('LiteLLM price data contains no per-token prices');
  return models;
}

function tokenBand(entry, inputTokens) {
  let band = null;
  for (const key of Object.keys(entry)) {
    const match = key.match(/^input_cost_per_token_above_(\d+(?:\.\d+)?)k_tokens$/);
    if (match && inputTokens > Number(match[1]) * 1000 && (!band || Number(match[1]) > band.threshold))
      band = { threshold: Number(match[1]), suffix: `_above_${match[1]}k_tokens` };
  }
  return band;
}

// Prices each model call with the rates LiteLLM lists for its model, service tier and prompt size.
// A rate that the call needs but LiteLLM does not list makes the whole result unknown instead of substituting another rate.
export function priceCalls(models, calls) {
  let costUsd = 0;
  const errors = new Set();
  for (const call of calls) {
    if (!call.model) {
      errors.add('the Codex session log does not name the model of a call');
      continue;
    }
    const entry = models[call.model];
    if (!entry) {
      errors.add(`LiteLLM has no per-token price for ${call.model}`);
      continue;
    }
    const tier = call.serviceTier ?? 'default';
    if (!(tier in TIER_SUFFIXES)) {
      errors.add(`Mu cannot price the Codex service tier "${tier}"`);
      continue;
    }
    const uncached = call.input - call.cachedInput - call.cacheWrite;
    if (uncached < 0) {
      errors.add(`Codex reported more cached than total input tokens for ${call.model}`);
      continue;
    }
    const band = tokenBand(entry, call.input);
    const tokens = { uncached, cachedInput: call.cachedInput, cacheWrite: call.cacheWrite, output: call.output };
    for (const [field, base, label] of RATES) {
      if (!tokens[field]) continue;
      const key = `${base}${band?.suffix ?? ''}${TIER_SUFFIXES[tier]}`;
      if (typeof entry[key] !== 'number') {
        errors.add(
          `LiteLLM lists no ${label} price for ${call.model}${tier === 'default' ? '' : ` in the ${tier} tier`}${band ? ` above ${band.threshold}k prompt tokens` : ''}`,
        );
        continue;
      }
      costUsd += tokens[field] * entry[key];
    }
  }
  return errors.size ? { costUsd: null, costError: [...errors].join('; ') } : { costUsd, costError: null };
}

// LiteLLM's public price list, cached on disk and refreshed periodically and whenever usage names a model it lacks.
// Each fetch attempt, successful or not, emits `update` so callers can reprice what was unknown.
/** @typedef {(url: string, init: {signal: AbortSignal}) => Promise<{ok: boolean, status: number, json(): Promise<unknown>}>} PriceFetch */
export class PricingCatalog extends EventEmitter {
  constructor({
    cacheFile = null,
    enabled = true,
    url = LITELLM_PRICES_URL,
    fetch = /** @type {PriceFetch} */ (globalThis.fetch),
    now = Date.now,
    refreshIntervalMs = REFRESH_INTERVAL_MS,
    unknownModelRetryMs = UNKNOWN_MODEL_RETRY_MS,
    timeoutMs = FETCH_TIMEOUT_MS,
  } = {}) {
    super();
    this.cacheFile = cacheFile;
    this.enabled = enabled;
    this.url = url;
    this.fetch = fetch;
    this.now = now;
    this.refreshIntervalMs = refreshIntervalMs;
    this.unknownModelRetryMs = unknownModelRetryMs;
    this.timeoutMs = timeoutMs;
    this.models = null;
    this.fetchedAt = null;
    this.lastAttempt = null;
    this.inflight = null;
    this.timer = null;
  }
  async start() {
    if (this.cacheFile) {
      try {
        const cached = JSON.parse(await readFile(this.cacheFile, 'utf8'));
        if (cached.url === this.url && Number.isFinite(Date.parse(cached.fetchedAt))) {
          this.models = parsePrices(cached.models);
          this.fetchedAt = Date.parse(cached.fetchedAt);
        }
      } catch (error) {
        if (error.code !== 'ENOENT')
          console.error(`Ignoring unreadable LiteLLM price cache ${this.cacheFile}: ${error.message}`);
      }
    }
    if (this.enabled) {
      this.timer = setInterval(() => this.refresh(), this.refreshIntervalMs);
      this.timer.unref();
      if (this.fetchedAt === null || this.now() - this.fetchedAt >= this.refreshIntervalMs) this.refresh();
    }
  }
  close() {
    clearInterval(this.timer);
  }
  refresh() {
    if (!this.enabled) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const startedAt = this.now();
    this.inflight = this.download()
      .then(
        async (models) => {
          Object.assign(this, { models, fetchedAt: startedAt, lastAttempt: { at: startedAt, error: null } });
          if (this.cacheFile)
            await this.save().catch((error) =>
              console.error(`Could not cache LiteLLM prices in ${this.cacheFile}: ${error.message}`),
            );
        },
        (error) => {
          this.lastAttempt = { at: startedAt, error: error.message };
          console.error(`LiteLLM price fetch failed: ${error.message}`);
        },
      )
      .finally(() => {
        this.inflight = null;
        this.emit('update');
      });
    return this.inflight;
  }
  async download() {
    const response = await this.fetch(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${this.url}`);
    return parsePrices(await response.json());
  }
  async save() {
    await mkdir(dirname(this.cacheFile), { recursive: true });
    const temporary = `${this.cacheFile}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({ url: this.url, fetchedAt: new Date(this.fetchedAt).toISOString(), models: this.models }),
    );
    await rename(temporary, this.cacheFile);
  }
  // Returns the cost of the calls, or why it is unknown. Never estimates a missing price.
  price(calls, { fetchMissing = true } = {}) {
    const missing = [...new Set(calls.map((call) => call.model).filter((model) => model && !this.models?.[model]))];
    if (
      this.enabled &&
      fetchMissing &&
      missing.length &&
      !this.inflight &&
      (!this.lastAttempt || this.now() - this.lastAttempt.at >= this.unknownModelRetryMs)
    )
      this.refresh();
    const pricesFetchedAt = this.fetchedAt === null ? null : new Date(this.fetchedAt).toISOString();
    if (this.inflight && (missing.length || !this.models))
      return {
        costUsd: null,
        costPending: true,
        costError: `Fetching LiteLLM prices${missing.length ? ` for ${missing.join(', ')}` : ''}`,
        pricesFetchedAt,
      };
    if (!this.models)
      return {
        costUsd: null,
        costPending: false,
        costError: this.enabled
          ? `LiteLLM prices unavailable: ${this.lastAttempt?.error ?? 'not fetched yet'}`
          : 'LiteLLM price fetching is disabled',
        pricesFetchedAt,
      };
    const failure =
      !this.enabled && missing.length
        ? '; price fetching is disabled'
        : this.lastAttempt?.error && missing.length
          ? `; the latest LiteLLM fetch failed: ${this.lastAttempt.error}`
          : '';
    const result = priceCalls(this.models, calls);
    return {
      ...result,
      costError: result.costError && `${result.costError} (prices fetched ${pricesFetchedAt}${failure})`,
      costPending: false,
      pricesFetchedAt,
    };
  }
}
