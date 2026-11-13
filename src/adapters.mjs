import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { privateUserPaths, sandboxPi } from './sandbox.mjs';

// Adapters whose CLI takes a model per process; other adapters reject a per-agent model.
export const MODEL_ADAPTERS = ['claude', 'codex', 'pi'];
// Adapters that cannot run without an explicit model.
export const MODEL_REQUIRED_ADAPTERS = ['pi'];
// What a per-agent model must look like, and where it is accepted. Null: the model suits the adapter.
export function modelError(adapter, model) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/.test(model))
    return 'Model must be 1–100 letters, digits or ._:/@- characters, starting with a letter or digit';
  if (!MODEL_ADAPTERS.includes(adapter))
    return `The ${adapter} adapter does not take a model; models are supported for ${MODEL_ADAPTERS.join(', ')}`;
  return null;
}

// Reasoning effort levels each CLI accepts, verified by one-turn probes. Claude Code and pi only warn about an
// unknown level and run on their default, so Mu rejects it before it reaches them.
export const EFFORT_LEVELS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  pi: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};

export function effortError(adapter, effort) {
  const levels = EFFORT_LEVELS[adapter];
  if (!levels)
    return `The ${adapter} adapter does not take a reasoning effort; efforts are supported for ${Object.keys(EFFORT_LEVELS).join(', ')}`;
  if (!levels.includes(effort))
    return `The ${adapter} adapter takes a reasoning effort of ${levels.join(', ')}; got ${JSON.stringify(effort)}`;
  return null;
}

// Adapters whose agents run in a sandbox that keeps Mu's data directory unreadable, apart from their own files.
export const SANDBOXED_ADAPTERS = ['codex', 'pi'];

export function muCommand(root) {
  const filename = join(root, 'src/cli.mjs');
  const argument = /^[a-zA-Z0-9_./-]+$/.test(filename) ? filename : `'${filename.replaceAll("'", "'\\''")}'`;
  return `node ${argument}`;
}

// A Codex permission profile equivalent to workspace-write with network access, plus the writable,
// read-only and unreadable paths that codexAccess chooses, except that Mu's data directory and the storage in
// privateUserPaths are unreadable, apart from the agent's own credential file. In Codex the most
// specific path wins; for the same path, a later entry here replaces an earlier one. Paths must be real
// paths, because the sandbox matches those. TOML basic strings accept JSON string escapes.
export function codexPermissions({
  dataDir,
  credentialFile,
  privatePaths = privateUserPaths(),
  writable = [],
  readOnly = [],
  unreadable = [],
}) {
  /** @type {Map<string, string>} */
  const access = new Map();
  for (const path of writable) access.set(path, 'write');
  for (const path of readOnly) access.set(path, 'read');
  for (const path of [...unreadable, dataDir, ...privatePaths]) access.set(path, 'deny');
  access.set(credentialFile, 'read');
  const filesystem = [...access].map(([path, mode]) => `${JSON.stringify(path)}="${mode}"`).join(', ');
  return [
    '-c',
    `default_permissions="${CODEX_PROFILE}"`,
    '-c',
    `permissions.${CODEX_PROFILE}={extends=":workspace", filesystem={${filesystem}}, network={enabled=true}}`,
  ];
}
const CODEX_PROFILE = 'mu-agent';

// A step that the sandbox refuses goes to Codex's reviewer, which can approve running that one command
// with the whole file system writable and the profile's deny entries kept. Mu sets the policy instead of
// inheriting it from the user's configuration, because a non-interactive turn has no user to ask;
// cliArgs.codex comes later and can override it.
export const CODEX_APPROVALS = ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"'];
// The user's execpolicy rules are ignored: they are allow rules for interactive use, and an allow rule
// skips the review while a profile with deny entries keeps the command sandboxed, so a matching command
// could never leave the sandbox, even when the agent asked for that.
const CODEX_EXEC_OPTIONS = ['--json', '--skip-git-repo-check', '--ignore-rules'];

// The lead's memory is Mu's: plain files in the Mu home, delivered by the runner. The CLI's own memory is turned off for
// the lead, and for no other role, so that two memories do not run side by side and the lead's does not depend on the
// user's CLI configuration. pi has none. Codex takes the last -c for a key, so the switch goes after cliArgs.codex.
const CODEX_MEMORY_OFF = ['-c', 'features.memories=false'];

// Claude Code takes only the last --settings flag (probed with 2.1.323: with two flags, the earlier one is ignored), so
// the switch goes into the last flag's JSON object, which holds the configured settings. A value that is not a JSON
// object, such as a file name, cannot be merged, so it is refused.
export function claudeLeadArgs(args) {
  const index = args.findLastIndex((arg) => arg === '--settings' || arg.startsWith('--settings='));
  if (index === -1) return [...args, '--settings', JSON.stringify({ autoMemoryEnabled: false })];
  const inline = args[index].startsWith('--settings=');
  const value = inline ? args[index].slice('--settings='.length) : args[index + 1];
  let settings;
  try {
    settings = JSON.parse(value);
  } catch {
    settings = undefined;
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings))
    throw new Error(
      `The lead's claude arguments pass --settings ${JSON.stringify(value)}, which is not a JSON object; Mu adds autoMemoryEnabled=false to that object, because Claude Code reads only the last --settings, so give the settings inline as a JSON object`,
    );
  const merged = JSON.stringify({ ...settings, autoMemoryEnabled: false });
  const copy = [...args];
  if (inline) copy[index] = `--settings=${merged}`;
  else copy[index + 1] = merged;
  return copy;
}

// options.pi: {dataDir, home, localPorts, writableRoots, socket, credentialFile, platform, privatePaths} for the pi sandbox.
// options.codex: {dataDir, credentialFile, privatePaths, writable, readOnly, unreadable} for the Codex permission profile.
/** @returns {{command: string, args: string[], format: string, env?: Record<string, string>}} */
export function commandFor(agent, root, custom = {}, cliArgs = {}, options = {}) {
  if (agent.adapter === 'codex') {
    if (!options.codex?.dataDir || !options.codex.credentialFile)
      throw new Error('A Codex agent needs the Mu data directory and its credential file for its permission profile');
    const globalArgs = [
      ...codexPermissions(options.codex),
      ...CODEX_APPROVALS,
      ...(cliArgs.codex || []),
      ...(agent.role === 'lead' ? CODEX_MEMORY_OFF : []),
      ...(agent.effort ? ['-c', `model_reasoning_effort=${agent.effort}`] : []),
    ];
    const model = agent.model ? ['-m', agent.model] : [];
    return agent.sessionId
      ? {
          command: 'codex',
          args: [...globalArgs, 'exec', 'resume', ...model, ...CODEX_EXEC_OPTIONS, agent.sessionId, '-'],
          format: 'codex',
        }
      : { command: 'codex', args: [...globalArgs, 'exec', ...model, ...CODEX_EXEC_OPTIONS, '-'], format: 'codex' };
  }
  // The agent's own model and effort come after cliArgs, so they override those set there for the whole adapter;
  // each CLI takes the last occurrence of a repeated option.
  if (agent.adapter === 'claude')
    return {
      command: 'claude',
      args: [
        ...(agent.role === 'lead' ? claudeLeadArgs(cliArgs.claude || []) : cliArgs.claude || []),
        ...(agent.model ? ['--model', agent.model] : []),
        ...(agent.effort ? ['--effort', agent.effort] : []),
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--permission-prompts',
        'none',
        '--allowedTools',
        `Bash(${muCommand(root)} *)`,
        ...(agent.sessionId ? ['--resume', agent.sessionId] : []),
      ],
      format: 'claude',
    };
  // pi lets the caller name the session, so a new session gets its ID from Mu and later turns reuse it.
  // pi has no approval prompts or sandbox of its own, so Mu runs the whole process inside Seatbelt.
  if (agent.adapter === 'pi')
    return {
      ...sandboxPi({
        ...options.pi,
        root,
        agent,
        args: [
          ...(cliArgs.pi || []),
          '-p',
          '--mode',
          'json',
          '--model',
          agent.model,
          ...(agent.effort ? ['--thinking', agent.effort] : []),
          '--session-id',
          agent.sessionId || randomUUID(),
        ],
      }),
      format: 'pi',
    };
  if (agent.adapter === 'demo')
    return { command: process.execPath, args: [join(root, 'scripts/demo-agent.mjs')], format: 'text' };
  const config = custom[agent.adapter];
  if (!config) throw new Error(`No executable adapter configured for ${agent.adapter}`);
  return {
    command: config.command,
    args: config.args.map((value) => value.replaceAll('{session}', agent.sessionId || '')),
    format: 'text',
  };
}

function parseEvents(format, stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid ${format} JSON event: ${line.slice(0, 120)}`);
      }
    });
}

export function emptyUsage() {
  return { sessionId: null, model: null, contextTokens: null, contextWindow: null, costUsd: null, totalTokens: null };
}

// Reports only what each CLI's machine-readable output states; see the runtime usage section in docs/architecture.md.
export function foldUsage(format, usage, event) {
  if (format === 'claude' && event.session_id) usage = { ...usage, sessionId: event.session_id };
  if (format === 'codex' && event.type === 'thread.started') usage = { ...usage, sessionId: event.thread_id };
  if (format === 'claude') {
    if (event.type === 'system' && event.subtype === 'init' && event.model) return { ...usage, model: event.model };
    // Subagent messages carry a parent tool use and occupy their own context.
    if (event.type === 'assistant' && !event.parent_tool_use_id && event.message?.usage) {
      const tokens = event.message.usage;
      const contextTokens =
        (tokens.input_tokens || 0) +
        (tokens.cache_creation_input_tokens || 0) +
        (tokens.cache_read_input_tokens || 0) +
        (tokens.output_tokens || 0);
      return { ...usage, model: event.message.model || usage.model, contextTokens };
    }
    if (event.type === 'result') {
      const contextWindow = usage.model
        ? (event.modelUsage?.[usage.model]?.contextWindow ?? usage.contextWindow)
        : usage.contextWindow;
      return {
        ...usage,
        contextWindow,
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : usage.costUsd,
      };
    }
  }
  if (format === 'pi') {
    if (event.type === 'session' && event.id) return { ...usage, sessionId: event.id };
    // pi prices each model call from its own model catalog; the turn's spend is their sum.
    if (event.type === 'message_end' && event.message?.role === 'assistant' && event.message.usage) {
      const tokens = event.message.usage;
      return {
        ...usage,
        model: event.message.model || usage.model,
        contextTokens: (tokens.input || 0) + (tokens.cacheRead || 0) + (tokens.cacheWrite || 0) + (tokens.output || 0),
        costUsd: typeof tokens.cost?.total === 'number' ? (usage.costUsd || 0) + tokens.cost.total : usage.costUsd,
        totalTokens: (usage.totalTokens || 0) + (tokens.totalTokens || 0),
      };
    }
  }
  // Codex reports cumulative thread usage, not the size of the current context.
  if (format === 'codex' && event.type === 'turn.completed' && event.usage)
    return { ...usage, totalTokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0) };
  return usage;
}

export const NO_REPLY = 'NO_REPLY';

// A final line that is exactly NO_REPLY after other text adds nothing to that text, so it is not posted with it.
export function withoutNoReply(text) {
  const trimmed = text.trim();
  if (trimmed === NO_REPLY) return '';
  return trimmed.replace(/\n[ \t]*NO_REPLY$/, '').trimEnd();
}

function joinReplies(earlier, latest) {
  const parts = [earlier, latest].map(withoutNoReply).filter(Boolean);
  if (parts.length) return parts.join('\n\n');
  return [earlier, latest].some((reply) => reply.trim() === NO_REPLY) ? NO_REPLY : '';
}

// What Mu keeps from a JSON event stream: the session, the final reply or failure, and the usage.
// The runner folds each event as it arrives, so the size of a turn's whole output does not matter.
export function emptyTurn() {
  return { sessionId: null, text: '', failure: null, usage: emptyUsage() };
}

export function foldTurn(format, turn, event) {
  let { sessionId, text, failure } = turn;
  if (format === 'pi') {
    if (event.type === 'session') sessionId = event.id;
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message;
      failure = ['error', 'aborted'].includes(message.stopReason)
        ? message.errorMessage || `pi turn ended with ${message.stopReason}`
        : null;
      text = (message.content || [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('');
    }
  } else if (format === 'codex') {
    if (event.type === 'thread.started') sessionId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
    if (event.type === 'turn.failed') {
      const info = event.error?.codex_error_info;
      failure = `${event.error?.message || 'Codex turn failed'}${info ? ` (codex_error_info: ${typeof info === 'string' ? info : JSON.stringify(info)})` : ''}`;
    }
  } else {
    if (event.session_id) sessionId = event.session_id;
    // One process can run several responses: a background task that finishes after the reply starts another, and
    // its result, often NO_REPLY, would otherwise replace the reply. Each response's result is part of the turn's reply.
    if (event.type === 'result') {
      text = joinReplies(text, event.result || '');
      if (event.is_error) failure = event.errors?.join('; ') || event.result || 'Claude turn failed';
    }
  }
  return { sessionId, text, failure, usage: foldUsage(format, turn.usage, event) };
}

// A text adapter's turn is its whole stdout; a JSON adapter's turn is the fold of its events.
export function readTurn(format, stdout) {
  if (format === 'text') return { stdout };
  return parseEvents(format, stdout).reduce((turn, event) => foldTurn(format, turn, event), emptyTurn());
}

export function turnReply(format, turn) {
  if (format === 'text') {
    if (!turn.stdout.trim()) throw new Error('Custom adapter produced no final response; return text or NO_REPLY');
    return { text: withoutNoReply(turn.stdout) || NO_REPLY, sessionId: null };
  }
  if (turn.failure) throw new Error(turn.failure);
  if (!turn.text.trim()) throw new Error(`${format} produced no final response`);
  return { text: withoutNoReply(turn.text) || NO_REPLY, sessionId: turn.sessionId };
}

export function parseUsage(format, stdout) {
  return readTurn(format, stdout).usage ?? null;
}

export function parseOutput(format, stdout) {
  return turnReply(format, readTurn(format, stdout));
}
