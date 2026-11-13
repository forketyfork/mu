import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { codexHome, findRollout } from './codex-rollout.mjs';
import { listFiles } from './files.mjs';
import { httpError } from './http-error.mjs';

// Reads an agent's harness transcript for the dashboard. See "Agent transcripts" in docs/architecture.md.
// The session files are internal to Claude Code and Codex and documented for pi; each parser picks the
// records it understands by type, counts every other record type, and fails loudly on anything it cannot read.

export const TRANSCRIPT_ADAPTERS = ['claude', 'codex', 'pi'];
export const DISPLAY_CHARS = 8000;
export const FULL_CHARS = 2_000_000;
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
// A parsed file takes several times its size in memory, so the cache is bounded by the file bytes it holds;
// it always keeps the file read last.
const CACHE_BYTES = 64 * 1024 * 1024;
// Claude session IDs and Codex thread IDs are UUIDs; Mu creates pi session IDs with randomUUID.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The runner's turn prompt names the chat message that started the turn.
const PROMPT_MESSAGE = /Incoming chat message #(\d+) from @/;
// Claude Code records an interruption as a user message with only this text; it does not start a turn.
const CLAUDE_INTERRUPTION = /^\[Request interrupted by user[^\]\n]*\]\s*$/;
const exitNote = (code) => (typeof code === 'number' ? `\n[exit code ${code}]` : '');

const fail = (message, status = 422) => httpError(message, status);

// Masking keeps credentials off the screen; it is not an access boundary, because only the user reads transcripts.
// Masking runs on the service's event loop over text that agents control, so every pattern must stay linear in the
// text length: repetitions that could backtrack against each other are bounded, and a key body ends at the next `-----`.
// A pattern whose match can fail after an unbounded class must not be able to start again inside that class: `\b`
// matches after each `-`, so the JWT pattern uses a lookbehind for its start instead.
// The masking tests need a sample secret for every label here.
/** @type {[string, RegExp][]} */
export const SECRET_PATTERNS = [
  ['private key', /-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----(?:[^-]|-(?!----))*-----END [A-Z ]{0,32}PRIVATE KEY-----/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ['permission token', /\bperm[:-][A-Za-z0-9._=-]{20,}/g],
  ['JWT', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];
// A name that marks its value as a secret: `GITHUB_TOKEN`, `DB_PASSWORD`.
const SECRET_NAME =
  '[A-Za-z0-9_]{0,64}(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]{0,64}';
// A secret's value: paths, `$` references and placeholders such as `<token>` or `[...]` do not start one.
const SECRET_VALUE = `[^\\s"'$/<[][^\\s"']{7,}`;
// These keep the label in front of the value: `Bearer <value>`, `GITHUB_TOKEN=<value>`. Paths and variable references stay visible.
/** @type {[string, RegExp][]} */
export const LABELLED_SECRETS = [
  ['bearer credential', /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi],
  ['secret value', new RegExp(`\\b(${SECRET_NAME}["']?\\s*[=:]\\s*["']?)(${SECRET_VALUE})`, 'g')],
];
// In a structured tool input the name and its value are separate strings, such as a key in an `env` object and its value.
// The value is masked whole when it starts as the pattern's value does; a number is read as its JSON text.
const SECRET_KEY = new RegExp(`^${SECRET_NAME}$`);
const SECRET_KEY_VALUE = new RegExp(`^${SECRET_VALUE}`);
const isSecretValue = (item) =>
  (typeof item === 'string' || typeof item === 'number') && SECRET_KEY_VALUE.test(String(item));

export function maskSecrets(text, credentials = []) {
  let count = 0;
  let masked = text;
  for (const credential of credentials) {
    if (credential && masked.includes(credential)) {
      count += masked.split(credential).length - 1;
      masked = masked.replaceAll(credential, '[masked: Mu credential]');
    }
  }
  for (const [label, pattern] of SECRET_PATTERNS)
    masked = masked.replace(pattern, () => {
      count++;
      return `[masked: ${label}]`;
    });
  for (const [label, pattern] of LABELLED_SECRETS)
    masked = masked.replace(pattern, (match, prefix) => {
      count++;
      return `${prefix}[masked: ${label}]`;
    });
  return { text: masked, count };
}

const TEXT_FIELDS = ['text', 'input'];
// A tool call keeps its input as the harness recorded it, usually an object, so the viewer can lay out each tool's
// arguments. Masking and the display cut apply to every string in it, keys included.
// Object.fromEntries defines a `__proto__` key as an own property instead of setting the prototype.
function maskStructured(value, mask) {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map((item) => maskStructured(item, mask));
  if (!value || typeof value !== 'object') return value;
  const used = new Set();
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const base = mask(key);
      let shown = base;
      // Two keys can mask to the same label; a number keeps both members visible.
      for (let copy = 2; used.has(shown); copy++) shown = `${base} (${copy})`;
      used.add(shown);
      if (SECRET_KEY.test(key) && isSecretValue(item)) return [shown, mask.label('secret value')];
      return [shown, maskStructured(item, mask)];
    }),
  );
}
function stringLength(value) {
  if (typeof value === 'string') return value.length;
  if (!value || typeof value !== 'object') return 0;
  let length = 0;
  for (const [key, item] of Object.entries(value))
    length += (Array.isArray(value) ? 0 : key.length) + stringLength(item);
  return length;
}
// Keeps the strings of a structured input, keys included, within `chars` characters in total. Each member also costs
// one character, so an input of many short strings is cut as well; members after the budget runs out are left out.
function limitStructured(value, chars) {
  let left = chars;
  let cut = false;
  const take = (text) => {
    if (text.length <= left) {
      left -= text.length;
      return text;
    }
    cut = true;
    const part = text.slice(0, Math.max(left, 0));
    left = 0;
    return part;
  };
  const walk = (item) => {
    if (typeof item === 'string') return take(item);
    if (!item || typeof item !== 'object') return item;
    const kept = [];
    const keys = new Set();
    for (const [key, member] of Object.entries(item)) {
      if (left <= 0) {
        cut = true;
        break;
      }
      left -= 1;
      const shown = Array.isArray(item) ? key : take(key);
      // A cut key can equal a key already kept; its member would replace that one.
      if (keys.has(shown)) break;
      keys.add(shown);
      kept.push([shown, walk(member)]);
    }
    return Array.isArray(item) ? kept.map(([, member]) => member) : Object.fromEntries(kept);
  };
  const limited = walk(value);
  return { value: limited, cut };
}
function maskEntry(entry, credentials) {
  const masked = { ...entry };
  let count = 0;
  const mask = (text) => {
    const result = maskSecrets(text, credentials);
    count += result.count;
    return result.text;
  };
  mask.label = (label) => {
    count++;
    return `[masked: ${label}]`;
  };
  for (const field of TEXT_FIELDS) if (typeof entry[field] === 'string') masked[field] = mask(entry[field]);
  if (entry.kind === 'tool_call' && entry.input && typeof entry.input === 'object')
    masked.input = maskStructured(entry.input, mask);
  return { entry: masked, count };
}
function limitEntry(entry, chars) {
  const limited = { ...entry };
  for (const field of TEXT_FIELDS) {
    if (typeof entry[field] === 'string' && entry[field].length > chars)
      Object.assign(limited, {
        [field]: entry[field].slice(0, chars),
        truncated: true,
        length: Math.max(limited.length || 0, entry[field].length),
      });
  }
  if (entry.kind === 'tool_call' && entry.input && typeof entry.input === 'object') {
    const { value, cut } = limitStructured(entry.input, chars);
    if (cut) Object.assign(limited, { input: value, truncated: true, length: stringLength(entry.input) });
  }
  return limited;
}

// Splits on LF only: JSON strings may contain U+2028, and a record is complete only once its LF is written.
function records(text, label) {
  const end = text.lastIndexOf('\n');
  const complete = end === -1 ? '' : text.slice(0, end);
  const pendingBytes = Buffer.byteLength(text.slice(end + 1));
  const list = [];
  for (const [index, line] of complete.split('\n').entries()) {
    if (!line.trim()) continue;
    let record;
    // JSON.parse quotes the text around the error, which can hold part of a secret that masking no longer recognizes.
    try {
      record = JSON.parse(line);
    } catch {
      throw fail(`${label} line ${index + 1} is not valid JSON`);
    }
    if (!record || typeof record !== 'object' || typeof record.type !== 'string')
      throw fail(`${label} line ${index + 1} has no record type`);
    list.push(record);
  }
  return { list, pendingBytes };
}

// An entry gets a ref when its source record has an ID and the record's position can change, as on a pi branch;
// the request for a full entry repeats the ref, so it never returns another entry that took the same position.
class Collector {
  constructor() {
    this.turns = [];
    this.skipped = {};
    this.names = new Map();
    this.ref = null;
  }
  source(id) {
    this.ref = id ?? null;
    this.part = 0;
  }
  skip(type) {
    this.skipped[type] = (this.skipped[type] || 0) + 1;
  }
  current() {
    if (!this.turns.length) this.turns.push({ index: 0, messageId: null, at: null, entries: [] });
    return this.turns.at(-1);
  }
  prompt(text, at) {
    const id = PROMPT_MESSAGE.exec(text)?.[1];
    this.turns.push({ index: this.turns.length, messageId: id ? Number(id) : null, at, entries: [] });
    this.add({ kind: 'prompt', text, at });
  }
  add(entry) {
    this.current().entries.push(this.ref === null ? entry : { ...entry, ref: `${this.ref}.${this.part++}` });
  }
  call(id, name, input, at) {
    if (id) this.names.set(id, name);
    this.add({ kind: 'tool_call', id: id ?? null, name, input, at });
  }
  result(id, text, isError, at, name = this.names.get(id) ?? null) {
    this.add({ kind: 'tool_result', id: id ?? null, name, text, isError: Boolean(isError), at });
  }
}

const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return asText(content ?? '');
  return content
    .map((part) => {
      // Codex writes agent message parts as Text and user message parts as text.
      if (part?.type === 'text' || part?.type === 'Text') return part.text;
      if (part?.type === 'local_image') return `[image omitted: ${part.path ?? 'local file'}]`;
      if (part?.type === 'image')
        return `[image omitted${part.mimeType || part.source?.media_type ? `: ${part.mimeType || part.source.media_type}` : ''}]`;
      return asText(part);
    })
    .join('\n');
}

export function parseClaude(text) {
  const { list, pendingBytes } = records(text, 'Claude session file');
  const out = new Collector();
  for (const record of list) {
    const at = record.timestamp ?? null;
    if (record.isSidechain) {
      out.skip(`${record.type} (sidechain)`);
      continue;
    }
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const meta = record.compactMetadata || {};
      out.add({
        kind: 'compaction',
        text: null,
        detail:
          meta.preTokens && meta.postTokens
            ? `${meta.preTokens} → ${meta.postTokens} tokens (${meta.trigger || 'unknown'} trigger)`
            : null,
        at,
      });
      continue;
    }
    if (record.type === 'user' && record.message) {
      const content = record.message.content;
      if (record.isCompactSummary) {
        out.add({
          kind: 'compaction',
          text: contentText(content),
          detail: 'Summary that replaced the earlier context',
          at,
        });
        continue;
      }
      if (record.isMeta) {
        out.skip('user (meta)');
        continue;
      }
      const blocks =
        typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : null;
      if (!blocks) throw fail('Claude session file has a user record without content');
      if (blocks.every((block) => block.type === 'text')) {
        const text = blocks.map((block) => block.text).join('\n');
        if (CLAUDE_INTERRUPTION.test(text)) out.add({ kind: 'notice', text: text.trim(), at });
        else out.prompt(text, at);
        continue;
      }
      for (const block of blocks) {
        if (block.type === 'tool_result') out.result(block.tool_use_id, contentText(block.content), block.is_error, at);
        else if (block.type === 'text') out.add({ kind: 'text', role: 'user', text: block.text, at });
        else out.add({ kind: 'notice', text: contentText([block]), at });
      }
      continue;
    }
    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      for (const block of record.message.content) {
        if (block.type === 'text') out.add({ kind: 'text', text: block.text, at });
        else if (block.type === 'thinking' || block.type === 'redacted_thinking')
          out.add({ kind: 'thinking', text: block.thinking || null, hidden: !block.thinking, at });
        else if (block.type === 'tool_use' || block.type === 'server_tool_use')
          out.call(block.id, block.name, block.input ?? null, at);
        else out.skip(`assistant ${block.type} block`);
      }
      continue;
    }
    out.skip(record.subtype ? `${record.type}/${record.subtype}` : record.type);
  }
  return { turns: out.turns, skipped: out.skipped, pendingBytes };
}

const shellCommand = (command) =>
  Array.isArray(command)
    ? command.length === 3 && /^-l?c$/.test(command[1])
      ? command[2]
      : command.join(' ')
    : asText(command);

export function parseCodex(text) {
  const { list, pendingBytes } = records(text, 'Codex rollout');
  const out = new Collector();
  let understood = false;
  for (const record of list) {
    const payload = record.payload || {};
    const at = record.timestamp ?? null;
    if (record.type !== 'event_msg') {
      out.skip(record.type);
      continue;
    }
    if (payload.type === 'task_started') {
      understood = true;
      continue;
    }
    if (payload.type === 'turn_aborted') {
      out.add({ kind: 'notice', text: `Turn aborted: ${payload.reason || 'no reason given'}`, at });
      continue;
    }
    if (payload.type !== 'item_completed' || !payload.item) {
      out.skip(`event_msg/${payload.type}`);
      continue;
    }
    understood = true;
    const item = payload.item;
    if (item.type === 'UserMessage') out.prompt(contentText(item.content), at);
    else if (item.type === 'AgentMessage') out.add({ kind: 'text', text: contentText(item.content), at });
    else if (item.type === 'Reasoning') {
      const reasoning = [...(item.summary_text || []), ...(item.raw_content || [])].map(asText).join('\n');
      out.add({ kind: 'thinking', text: reasoning || null, hidden: !reasoning, at });
    } else if (item.type === 'CommandExecution') {
      out.call(item.id, 'command', shellCommand(item.command), at);
      // A command without an exit code, such as one still running when the turn ended, fails only by its status.
      out.result(
        item.id,
        `${item.aggregated_output ?? ''}${exitNote(item.exit_code)}`,
        (typeof item.exit_code === 'number' && item.exit_code !== 0) || item.status === 'failed',
        at,
      );
    } else if (item.type === 'McpToolCall') {
      out.call(item.id, `${item.server}.${item.tool}`, item.arguments ?? null, at);
      out.result(
        item.id,
        item.error ? asText(item.error) : contentText(item.result?.content ?? item.result ?? ''),
        Boolean(item.error) || item.status === 'failed',
        at,
      );
    } else if (item.type === 'FileChange') {
      out.call(item.id, 'apply_patch', item.changes ?? {}, at);
      out.result(item.id, [item.stdout, item.stderr].filter(Boolean).join('\n'), item.status === 'failed', at);
    } else if (item.type === 'ImageView') out.add({ kind: 'notice', text: `Viewed image ${item.path}`, at });
    else if (item.type === 'ContextCompaction') out.add({ kind: 'compaction', text: null, detail: null, at });
    else out.skip(`item_completed/${item.type}`);
  }
  if (list.length && !understood)
    throw fail(
      'This Codex rollout has no task_started or item_completed events; its format is older or newer than the one Mu reads',
    );
  return { turns: out.turns, skipped: out.skipped, pendingBytes };
}

// pi stores a tree of entries; the transcript is the path from the root to the latest entry, which is the
// current leaf unless the session was branched afterwards. Entries on other branches are counted, not shown.
export function parsePi(text) {
  const { list, pendingBytes } = records(text, 'pi session file');
  const [header, ...entries] = list;
  if (header?.type !== 'session') throw fail('pi session file does not start with a session header');
  if (header.version !== 3)
    throw fail(`pi session file version ${header.version} is not supported; Mu reads version 3`);
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const path = [];
  for (
    let entry = entries.findLast((item) => item.id);
    entry;
    entry = entry.parentId ? byId.get(entry.parentId) : null
  ) {
    if (entry.parentId && !byId.has(entry.parentId))
      throw fail(`pi session entry ${entry.id} refers to a missing parent ${entry.parentId}`);
    if (path.length > entries.length) throw fail('pi session entries form a cycle');
    path.push(entry);
  }
  path.reverse();
  const out = new Collector();
  const offBranch = entries.length - path.length;
  if (offBranch) out.skipped['entries on other branches'] = offBranch;
  for (const entry of path) {
    out.source(entry.id);
    const at = entry.timestamp ?? null;
    const message = entry.message;
    if (entry.type === 'compaction') {
      out.add({
        kind: 'compaction',
        text: entry.summary ?? null,
        detail: entry.tokensBefore ? `${entry.tokensBefore} tokens before` : null,
        at,
      });
      continue;
    }
    if (entry.type !== 'message' || !message) {
      out.skip(entry.type);
      continue;
    }
    if (message.role === 'user') out.prompt(contentText(message.content), at);
    else if (message.role === 'assistant') {
      for (const block of message.content || []) {
        if (block.type === 'text') out.add({ kind: 'text', text: block.text, at });
        else if (block.type === 'thinking')
          out.add({ kind: 'thinking', text: block.thinking || null, hidden: !block.thinking, at });
        else if (block.type === 'toolCall') out.call(block.id, block.name, block.arguments ?? null, at);
        else out.skip(`assistant ${block.type} block`);
      }
      if (['error', 'aborted'].includes(message.stopReason))
        out.add({
          kind: 'notice',
          text: `Model call ended with ${message.stopReason}${message.errorMessage ? `: ${message.errorMessage}` : ''}`,
          at,
        });
    } else if (message.role === 'toolResult')
      out.result(message.toolCallId, contentText(message.content), message.isError, at, message.toolName ?? null);
    else if (message.role === 'bashExecution') {
      // pi records no exit code for a command that was cancelled or did not finish.
      out.call(null, 'bash (user)', message.command, at);
      out.result(
        null,
        `${message.output ?? ''}${exitNote(message.exitCode)}${message.cancelled ? '\n[cancelled]' : ''}`,
        Boolean(message.cancelled) || (typeof message.exitCode === 'number' && message.exitCode !== 0),
        at,
        'bash (user)',
      );
    } else out.skip(`message/${message.role}`);
  }
  return { turns: out.turns, skipped: out.skipped, pendingBytes };
}

const PARSERS = { claude: parseClaude, codex: parseCodex, pi: parsePi };

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Opens a transcript only if it is a regular file, not a symbolic link, whose real path lies under
// realpath(anchor)/sub. The file is opened without following a final link and must be the same file that was checked.
// For pi the anchor is the agent's pi home in Mu's data directory. The agent can write the sessions directory inside
// it but not replace the home itself: the pi sandbox denies creating, removing or renaming the home and its parents,
// and Mu refuses to launch pi with a linked home. The viewer does not rely on that alone, because a home that became a
// link would move the anchor wherever the link points: a file is shown only when its name contains Mu's random
// session ID, and Seatbelt refuses the agent a hard link to a file it cannot read.
// When unchanged(stat) says the cached parse of this file is current, the content is not read again.
export async function readContained(path, anchor, sub, unchanged = (_facts) => false) {
  let trusted;
  try {
    trusted = join(await realpath(anchor), sub);
  } catch (error) {
    if (error.code === 'ENOENT') throw fail(`The transcript directory ${anchor} does not exist`, 404);
    throw error;
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw fail(`The transcript file ${path} does not exist`, 404);
    throw error;
  }
  if (info.isSymbolicLink()) throw fail(`The transcript file ${path} is a symbolic link; Mu reads only regular files`);
  if (!info.isFile()) throw fail(`The transcript file ${path} is not a regular file`);
  const real = await realpath(path);
  if (!real.startsWith(trusted + sep))
    throw fail(`The transcript file ${path} resolves to ${real}, outside ${trusted}`);
  if (info.size > MAX_TRANSCRIPT_BYTES)
    throw fail(
      `The transcript file ${path} has ${info.size} bytes; Mu reads transcripts up to ${MAX_TRANSCRIPT_BYTES} bytes`,
      413,
    );
  let handle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP' || error.code === 'ENOENT')
      throw fail(`The transcript file ${path} changed while Mu opened it`);
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev)
      throw fail(`The transcript file ${path} changed while Mu opened it`);
    const facts = { real, size: opened.size, mtimeMs: opened.mtimeMs, ino: opened.ino };
    if (unchanged(facts)) return { ...facts, text: null };
    const buffer = Buffer.alloc(Math.min(opened.size, MAX_TRANSCRIPT_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      real,
      size: bytesRead,
      mtimeMs: opened.mtimeMs,
      ino: opened.ino,
      text: buffer.subarray(0, bytesRead).toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

export class Transcripts {
  // credentials returns the Mu credentials currently valid, which masking hides wherever they appear.
  constructor({
    dataDir,
    claudeHome = join(homedir(), '.claude'),
    codexHome: codexDirectory = codexHome(),
    credentials = () => [],
    cacheBytes = CACHE_BYTES,
  }) {
    this.dataDir = dataDir;
    this.claudeHome = claudeHome;
    this.codexHome = codexDirectory;
    this.credentials = credentials;
    this.cacheBytes = cacheBytes;
    this.cache = new Map();
  }
  sessionFor(agent, conversationId) {
    if (!TRANSCRIPT_ADAPTERS.includes(agent.adapter))
      throw fail(
        `Transcripts are available for ${TRANSCRIPT_ADAPTERS.join(', ')} agents; @${agent.id} uses ${agent.adapter}`,
        400,
      );
    const sessionId = agent.sessionIds?.[conversationId];
    if (!sessionId) throw fail(`@${agent.id} has no ${agent.adapter} session in ${conversationId}`, 404);
    if (!SESSION_ID.test(sessionId))
      throw fail(`The stored session ID of @${agent.id} in ${conversationId} is not a UUID`);
    return sessionId;
  }
  // Returns the file path and the trusted anchor it must stay under; every path derives from the stored session ID.
  async locate(agent, sessionId) {
    if (agent.adapter === 'claude') {
      const projects = join(this.claudeHome, 'projects');
      let directories;
      try {
        directories = await readdir(projects, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') throw fail(`Claude Code has no projects directory at ${projects}`, 404);
        throw error;
      }
      const matches = [];
      for (const directory of directories.filter((entry) => entry.isDirectory())) {
        const candidate = join(projects, directory.name, `${sessionId}.jsonl`);
        if (await exists(candidate)) matches.push(candidate);
      }
      if (!matches.length)
        throw fail(
          `No Claude Code session file ${sessionId}.jsonl under ${projects}; Claude Code may have deleted it after its cleanup period`,
          404,
        );
      if (matches.length > 1) throw fail(`Claude Code session ${sessionId} has several files: ${matches.join(', ')}`);
      return { path: matches[0], anchor: this.claudeHome, sub: 'projects' };
    }
    if (agent.adapter === 'codex') {
      try {
        return { path: await findRollout(this.codexHome, sessionId), anchor: this.codexHome, sub: 'sessions' };
      } catch (error) {
        if (error.code === 'ENOENT' || /^No Codex rollout/.test(error.message)) throw fail(error.message, 404);
        throw error;
      }
    }
    const home = join(this.dataDir, 'pi', agent.id);
    const sessions = join(home, 'sessions');
    let names;
    // pi keeps each session at sessions/<encoded cwd>/<time>_<session>.jsonl.
    try {
      names = await listFiles(sessions, 2);
    } catch (error) {
      if (error.code === 'ENOENT') throw fail(`@${agent.id} has no pi sessions directory at ${sessions}`, 404);
      throw error;
    }
    const matches = names.filter((name) => name.endsWith(`_${sessionId}.jsonl`));
    if (!matches.length) throw fail(`No pi session file for ${sessionId} under ${sessions}`, 404);
    if (matches.length > 1) throw fail(`pi session ${sessionId} has several files under ${sessions}`);
    return { path: join(sessions, matches[0]), anchor: home, sub: 'sessions' };
  }
  // The cache holds parsed, unmasked turns. Masking runs per request on the entries it returns, so loading a file
  // does not mask all of it, and credentials issued after the file was parsed are masked as well.
  async load(agent, conversationId) {
    const sessionId = this.sessionFor(agent, conversationId);
    const { path, anchor, sub } = await this.locate(agent, sessionId);
    const key = `${agent.adapter}:${path}`;
    const cached = this.cache.get(key);
    const file = await readContained(
      path,
      anchor,
      sub,
      (facts) =>
        Boolean(cached) &&
        cached.real === facts.real &&
        cached.size === facts.size &&
        cached.mtimeMs === facts.mtimeMs &&
        cached.ino === facts.ino,
    );
    if (file.text === null) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const parsed = PARSERS[agent.adapter](file.text);
    const loaded = {
      adapter: agent.adapter,
      sessionId,
      file: path,
      real: file.real,
      size: file.size,
      mtimeMs: file.mtimeMs,
      ino: file.ino,
      turns: parsed.turns,
      skipped: parsed.skipped,
      pendingBytes: parsed.pendingBytes,
    };
    this.cache.delete(key);
    this.cache.set(key, loaded);
    let bytes = 0;
    for (const value of this.cache.values()) bytes += value.size;
    for (const [oldest, value] of this.cache) {
      if (bytes <= this.cacheBytes || oldest === key) break;
      this.cache.delete(oldest);
      bytes -= value.size;
    }
    return loaded;
  }
  // Turns are numbered from the start of the session; a page holds up to `limit` turns before `before`.
  // `masked` counts the secrets masked in this page.
  async page(agent, conversationId, { before = null, limit = 5 } = {}) {
    const loaded = await this.load(agent, conversationId);
    const end = before === null ? loaded.turns.length : Math.min(before, loaded.turns.length);
    const start = Math.max(0, end - limit);
    const credentials = this.credentials();
    let masked = 0;
    const turns = loaded.turns.slice(start, end).map((turn) => ({
      ...turn,
      entries: turn.entries.map((entry) => {
        const result = maskEntry(entry, credentials);
        masked += result.count;
        return limitEntry(result.entry, DISPLAY_CHARS);
      }),
    }));
    const { adapter, sessionId, file, size: bytes, skipped, pendingBytes } = loaded;
    return {
      agentId: agent.id,
      conversationId,
      adapter,
      sessionId,
      file,
      bytes,
      skipped,
      pendingBytes,
      masked,
      turnCount: loaded.turns.length,
      start,
      end,
      turns,
    };
  }
  // ref is the entry's ref from the page, when it has one; see Collector.
  async entry(agent, conversationId, turnIndex, entryIndex, ref = null) {
    const loaded = await this.load(agent, conversationId);
    const entry = loaded.turns[turnIndex]?.entries[entryIndex];
    if (!entry) throw fail(`Turn ${turnIndex} has no entry ${entryIndex} in this transcript`, 404);
    if (entry.ref !== undefined && ref === null)
      throw fail(`Entry ${entryIndex} of turn ${turnIndex} has a ref, and the request must name it`, 400);
    if ((entry.ref ?? null) !== ref)
      throw fail(
        `The transcript changed since its page was loaded: entry ${entryIndex} of turn ${turnIndex} is now another entry; reload the transcript`,
        409,
      );
    return limitEntry(maskEntry(entry, this.credentials()).entry, FULL_CHARS);
  }
}
