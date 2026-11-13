import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { listFiles } from './files.mjs';

// Codex writes each thread to CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl.
// The rollout format is internal to Codex rather than a documented interface, so parsing fails loudly
// when the expected events are missing instead of guessing.
export function codexHome(env = process.env) {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

export async function findRollout(home, threadId) {
  const sessions = join(home, 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const match = (await listFiles(sessions)).find(
    (name) => basename(name).startsWith('rollout-') && name.endsWith(suffix),
  );
  if (!match) throw new Error(`No Codex rollout file for thread ${threadId} under ${sessions}`);
  return join(sessions, match);
}

// Codex writes a token_count event after each model call and repeats it unchanged on other updates, such as rate limits.
// A call is therefore counted only when the thread's cumulative total changes; it is attributed to the model and
// service tier in effect at that point.
export function parseRollout(text) {
  let model = null,
    serviceTier = null,
    contextTokens = null,
    contextWindow = null,
    total = null;
  const calls = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`Invalid Codex rollout line ${index + 1}`);
    }
    const payload = record.payload;
    if (record.type === 'turn_context' && payload?.model) model = payload.model;
    if (
      record.type === 'event_msg' &&
      payload?.type === 'thread_settings_applied' &&
      payload.thread_settings?.service_tier !== undefined
    )
      serviceTier = payload.thread_settings.service_tier;
    if (record.type === 'event_msg' && payload?.type === 'token_count' && payload.info) {
      const last = payload.info.last_token_usage;
      if (last) contextTokens = last.total_tokens ?? (last.input_tokens || 0) + (last.output_tokens || 0);
      if (payload.info.model_context_window) contextWindow = payload.info.model_context_window;
      const current = JSON.stringify(payload.info.total_token_usage ?? null);
      if (last && current !== total)
        calls.push({
          model,
          serviceTier,
          input: last.input_tokens || 0,
          cachedInput: last.cached_input_tokens || 0,
          cacheWrite: last.cache_write_input_tokens || 0,
          output: last.output_tokens || 0,
        });
      total = current;
    }
  }
  if (model === null && contextTokens === null)
    throw new Error('Codex rollout has no turn_context or token_count events');
  return { model, contextTokens, contextWindow, calls };
}

export class CodexRollouts {
  constructor(home = codexHome()) {
    this.home = home;
    this.paths = new Map();
  }
  async read(threadId) {
    if (!this.paths.has(threadId)) this.paths.set(threadId, await findRollout(this.home, threadId));
    try {
      return parseRollout(await readFile(this.paths.get(threadId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') this.paths.delete(threadId);
      throw error;
    }
  }
}
