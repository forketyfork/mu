import { access, readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { initializeHome, resolveDataDir, resolveHome } from './home.mjs';

const help = `Mu — local agent team

Usage: node src/cli.mjs COMMAND [options]

  spawn, register  --id ID --adapter NAME --cwd DIR --task TEXT [--model MODEL] [--effort LEVEL] [--role worker|lead] [--conversation ID] [--task-id ID | --task-title TITLE]
                  (TEXT: at most 1800 characters; post a longer brief with say --file first and point to its message)
                  (--model: the native CLI's model name or alias for claude, codex and pi; required for pi; default: the CLI's configured model)
                  (--effort: reasoning effort for every turn; claude: low|medium|high|xhigh|max,
                   codex: none|minimal|low|medium|high|xhigh|max, pi: off|minimal|low|medium|high|xhigh|max; default: the CLI's)
  say             [--from ID] [--conversation ID] TEXT  (or --file FILE)
  init            [--dry-run] [--accept ROLE_FILE] [--adopt]
                  (user's shell or managed lead; installs or upgrades instructions and seed files in MU_HOME, default ~/.mu)
  room create     --name NAME [--id ID] [--members lead,worker-one] [--source-conversation ID]
  room invite     --conversation ID --members worker-one,worker-two
  room list
  history         [--conversation ID] [--before MESSAGE_ID | --after MESSAGE_ID] [--limit COUNT]
  task create     --title TITLE --conversation ID [--description TEXT] [--agents worker-one,reviewer]
  task list       [--include-verified] [--conversation ID]
  task update     --id ID [--title TEXT] [--description TEXT] [--result TEXT | --file FILE] [--status active|ready] [--agents IDS]
  task retire     --id ID  (lead; verified tasks only)
  waiting add     --text TEXT [--task-id ID]  (lead; one plain sentence about a decision that blocks a task, no PR or task IDs)
  waiting list
  waiting remove  --id CARD_ID  (lead; once the decision is made)
  activity add    --text TEXT [--lane focus|control] [--task-ids IDS]  (lead; focus: waits on the user, control: waits on others)
  activity list   [--include-checked]
  activity edit   --id ID [--text TEXT] [--lane focus|control] [--position N]  (lead; position 1 is the top of the lane)
  activity check  --id ID  (lead; only when the user asks)
  activity uncheck --id ID  (lead; restores a checked-off activity)
  activity delete --id ID  (lead; only when the user asks; the history is kept)
  activity history --id ID
  activity link   --id ID --task-id TASK_ID  (lead; a task belongs to one activity, so this moves it)
  activity unlink --id ID --task-id TASK_ID  (lead)
  inbox           [--id ID] [--wait SECONDS]
  ack             [--id ID] --message MESSAGE_ID
  status          [--id ID] --status STATUS [--task TEXT]
  configure       [--id ID] [--adapter NAME] [--model MODEL|default] [--cwd DIR] [--effort LEVEL|default] [--new-session]
                  (user; stopped or failed agents. default: the model or effort that the configuration or the CLI selects.
                   --new-session: forget the agent's native sessions, so its next turn starts from an empty context)
  stop            [--id ID]
  agents          [--id ID,ID] [--status STATUS,STATUS]
  state
  chat            [--to AGENT | --conversation ID]
  dashboard       (prints the user's dashboard sign-in link)
  service         (the running service: process, start time, launchd job, restart in progress)
  restart         [--conversation ID]  (lead and user; launchd only. Checks the checkout's code, then restarts
                  after the calling turn has ended; the new process reports in the conversation)

All commands accept --url URL (default MU_URL or http://127.0.0.1:4310; unix:/path for a socket).
The credential is MU_TOKEN, else the file named by MU_TOKEN_FILE, which Mu gives each managed
agent turn, else the user credential in the data directory (MU_DATA_DIR, default data in MU_HOME). The service decides the caller
from the credential: an agent always acts as itself, and the user credential acts as the user or
as a manual agent named by --from or MU_AGENT_ID.
Agent identity defaults to MU_AGENT_ID. Messages default to the user identity.
Messages use --conversation, then MU_CONVERSATION_ID, then common.
The --room option is an alias for --conversation.
The chat command is a human terminal client; it does not run an AI model.
`;

const commandOptions = {
  init: ['dry-run', 'accept', 'adopt'],
  spawn: ['id', 'adapter', 'model', 'effort', 'cwd', 'task', 'role', 'conversation', 'room', 'task-id', 'task-title'],
  register: [
    'id',
    'adapter',
    'model',
    'effort',
    'cwd',
    'task',
    'role',
    'conversation',
    'room',
    'task-id',
    'task-title',
  ],
  say: ['from', 'file', 'conversation', 'room'],
  'room:create': ['id', 'name', 'members', 'from', 'source-conversation'],
  'room:invite': ['conversation', 'room', 'members', 'from'],
  'room:list': [],
  history: ['conversation', 'room', 'before', 'after', 'limit'],
  'task:create': ['title', 'description', 'conversation', 'room', 'source-conversation', 'agents', 'from'],
  'task:list': ['include-verified', 'conversation', 'room'],
  'task:update': ['id', 'title', 'description', 'result', 'file', 'status', 'agents', 'from'],
  'task:retire': ['id', 'from'],
  'waiting:add': ['text', 'task-id', 'from'],
  'waiting:list': [],
  'waiting:remove': ['id', 'from'],
  'activity:add': ['text', 'lane', 'task-ids', 'from'],
  'activity:list': ['include-checked'],
  'activity:edit': ['id', 'text', 'lane', 'position', 'from'],
  'activity:check': ['id', 'from'],
  'activity:uncheck': ['id', 'from'],
  'activity:delete': ['id', 'from'],
  'activity:history': ['id'],
  'activity:link': ['id', 'task-id', 'from'],
  'activity:unlink': ['id', 'task-id', 'from'],
  inbox: ['id', 'wait'],
  ack: ['id', 'message'],
  status: ['id', 'status', 'task'],
  configure: ['id', 'adapter', 'model', 'cwd', 'effort', 'new-session'],
  stop: ['id'],
  agents: ['id', 'status'],
  state: [],
  chat: ['to', 'conversation', 'room'],
  dashboard: [],
  service: [],
  restart: ['conversation', 'room'],
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Longer than the service's whole start check (60 seconds), so a check that ends in time always answers.
const RESTART_TIMEOUT_MS = 90_000;

// The checkout held the data directory before it moved into the home; a credential still there means the move is due.
async function movePending(env, root) {
  if (env.MU_DATA_DIR !== undefined) return '';
  const legacy = join(root, '.mu', 'user-token');
  try {
    await access(legacy);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  return ` The checkout still holds ${legacy}: the data directory has not been moved into the Mu home yet. Until then, set MU_DATA_DIR=${join(root, '.mu')}.`;
}

/** The user credential in the data directory, for a caller without a turn credential, such as the user's shell. */
export async function readUserCredential(env, root = ROOT) {
  const file = join(resolveDataDir(env, resolveHome(env)), 'user-token');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (error) {
    throw new Error(
      `Cannot read the Mu user credential ${file}: ${error.message}. Start the service once to create it, or set MU_DATA_DIR to its data directory.${await movePending(env, root)}`,
      { cause: error },
    );
  }
}

async function credential(env) {
  if (env.MU_TOKEN) return env.MU_TOKEN;
  if (env.MU_TOKEN_FILE) {
    try {
      return (await readFile(env.MU_TOKEN_FILE, 'utf8')).trim();
    } catch (error) {
      throw new Error(
        `Cannot read this turn's Mu credential ${env.MU_TOKEN_FILE}: ${error.message}. Mu revokes it when the turn ends.`,
        { cause: error },
      );
    }
  }
  return readUserCredential(env);
}

function conversationOption(values) {
  if (values.conversation && values.room) throw new Error('Use either --conversation or --room.');
  return values.conversation ?? values.room;
}

function ownConversationNote(conversationId) {
  return `Posted to ${conversationId}, the conversation of your current turn. The final text of this turn is posted there too: if this message already is your answer, end the turn with exactly NO_REPLY.`;
}

function members(value) {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
}

function required(value, name) {
  if (!value?.trim()) throw new Error(`Missing ${name}. See --help.`);
  return value;
}

function integer(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value ?? '')) throw new Error(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

// MU_URL is http://host:port or unix:/absolute/socket/path; a sandboxed agent has only its socket.
/**
 * @param {string} url
 * @param {string} path
 * @param {{method?: string, body?: unknown, signal?: AbortSignal, token?: string}} [options]
 */
export async function send(url, path, { method = 'GET', body, signal, token } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    ...(payload === undefined
      ? {}
      : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let target;
  if (url.startsWith('unix:')) {
    const socketPath = url.slice('unix:'.length);
    if (!isAbsolute(socketPath)) throw new Error(`Invalid Mu URL ${url}: a socket URL needs an absolute path`);
    target = { socketPath, path };
  } else {
    const parsed = new URL(path, url);
    target = { host: parsed.hostname, port: parsed.port, path: `${parsed.pathname}${parsed.search}` };
  }
  let status, text;
  try {
    ({ status, text } = await new Promise((resolveResponse, reject) => {
      const outgoing = httpRequest(
        { ...target, method, headers, signal: signal ?? AbortSignal.timeout(35_000) },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            data += chunk;
          });
          response.on('end', () => resolveResponse({ status: response.statusCode, text: data }));
          response.on('error', reject);
        },
      );
      outgoing.on('error', reject);
      outgoing.end(payload);
    }));
  } catch (error) {
    throw new Error(`Cannot reach Mu at ${url}: ${error.message}`, { cause: error });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Mu returned non-JSON data (HTTP ${status}).`);
  }
  if (status < 200 || status >= 300) throw new Error(data.error ?? `Mu returned HTTP ${status}.`);
  return data;
}

async function terminalChat(url, conversationId, token) {
  const request = send;
  const initial = await request(url, '/api/state', { token });
  const conversation = initial.conversations.find((item) => item.id === conversationId);
  if (!conversation) throw new Error(`Unknown conversation: ${conversationId}. Use room list to see conversations.`);
  let lastId = 0;
  const show = (messages) => {
    for (const message of messages) {
      if (message.id > lastId) {
        process.stdout.write(`${message.from}: ${message.text}\n`);
        lastId = message.id;
      }
    }
  };
  show(initial.messages.filter((message) => message.conversationId === conversationId).slice(-20));
  process.stdout.write(
    `${conversation.name} (${conversationId}). ${conversation.kind === 'direct' ? 'Messages are delivered directly; no mention is needed.' : 'Mention an agent or @all to deliver a message.'} Type /quit to leave.\n`,
  );
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  input.setPrompt('you> ');
  input.prompt();
  let closed = false;
  let pollError;
  const controller = new AbortController();
  input.on('close', () => {
    closed = true;
    controller.abort();
  });
  const poll = (async () => {
    while (!closed) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (closed) break;
      try {
        const state = await request(url, '/api/state', { signal: controller.signal, token });
        const fresh = state.messages.filter(
          (message) => message.conversationId === conversationId && message.id > lastId,
        );
        if (fresh.length) {
          process.stdout.write('\n');
          show(fresh);
          input.prompt(true);
        }
      } catch (error) {
        if (!closed) {
          pollError = error;
          input.close();
        }
      }
    }
  })();
  try {
    for await (const line of input) {
      const text = line.trim();
      if (text === '/quit') break;
      if (text) {
        await request(url, '/api/messages', { method: 'POST', token, body: { from: 'user', conversationId, text } });
      }
      input.prompt();
    }
  } finally {
    input.close();
    await poll;
  }
  if (pollError) throw pollError;
}

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  { restartTimeoutMs = RESTART_TIMEOUT_MS } = {},
) {
  let [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    return help;
  }
  if (command === 'room' || command === 'task' || command === 'waiting' || command === 'activity') {
    const [action, ...rest] = args;
    if (!action || action === '--help' || action === '-h') return help;
    command = `${command}:${action}`;
    args = rest;
  }
  const allowed = commandOptions[command];
  if (!allowed) throw new Error(`Unknown command: ${command}. See --help.`);
  const options = Object.fromEntries([...allowed, 'url'].map((name) => [name, { type: 'string' }]));
  options.help = { type: 'boolean', short: 'h' };
  for (const flag of ['include-verified', 'include-checked', 'new-session', 'dry-run', 'adopt'])
    if (options[flag]) options[flag] = { type: 'boolean' };
  // The options are chosen per command, so parseArgs cannot type the values; every option is a string except the boolean flags.
  /** @type {{values: Record<string, any>, positionals: string[]}} */
  const { values, positionals } = parseArgs({ args, options, allowPositionals: command === 'say' });
  if (values.help) return help;
  const url = values.url ?? env.MU_URL ?? 'http://127.0.0.1:4310';
  const selectedConversation = conversationOption(values);
  if (values['task-id'] && values['task-title']) throw new Error('Use either --task-id or --task-title.');
  const id = () => encodeURIComponent(required(values.id ?? env.MU_AGENT_ID, '--id or MU_AGENT_ID'));
  if (command === 'init') {
    if (env.MU_AGENT_ID || env.MU_TOKEN || env.MU_TOKEN_FILE) {
      return send(url, '/api/home/init', {
        method: 'POST',
        token: await credential(env),
        body: {
          from: env.MU_AGENT_ID ?? 'user',
          dryRun: Boolean(values['dry-run']),
          ...(values.accept === undefined ? {} : { accept: values.accept }),
          adopt: Boolean(values.adopt),
        },
      });
    }
    return initializeHome({
      env,
      home: resolveHome(env),
      dryRun: Boolean(values['dry-run']),
      accept: values.accept,
      adopt: Boolean(values.adopt),
    });
  }
  if (command === 'dashboard') {
    if (env.MU_TOKEN || env.MU_TOKEN_FILE)
      throw new Error(
        "This shell holds an agent credential (MU_TOKEN or MU_TOKEN_FILE); the dashboard sign-in link is the user's.",
      );
    return `${url.startsWith('unix:') ? 'http://127.0.0.1:4310' : new URL(url).origin}/?token=${await credential(env)}\n`;
  }
  const token = await credential(env);
  const request = (target, path, options = {}) => send(target, path, { ...options, token });
  switch (command) {
    case 'spawn':
    case 'register': {
      const role = values.role ?? 'worker';
      const task = command === 'register' ? (values.task ?? '') : required(values.task, '--task');
      if (role === 'worker' && task.trim()) {
        if (!values['task-id'] && !values['task-title'])
          throw new Error(
            'Worker assignments require --task-id or --task-title. Create a tracked task before starting work.',
          );
        required(selectedConversation, '--conversation for the task room');
      }
      return request(url, '/api/agents', {
        method: 'POST',
        body: {
          from: env.MU_AGENT_ID === values.id ? 'user' : (env.MU_AGENT_ID ?? 'user'),
          id: required(values.id, '--id'),
          role,
          adapter: required(values.adapter, '--adapter'),
          ...(values.model === undefined ? {} : { model: values.model }),
          ...(values.effort === undefined ? {} : { effort: values.effort }),
          cwd: resolve(required(values.cwd, '--cwd')),
          task,
          ...(selectedConversation === undefined ? {} : { conversationId: selectedConversation }),
          ...(values['task-id'] === undefined ? {} : { taskId: values['task-id'] }),
          ...(values['task-title'] === undefined ? {} : { taskTitle: values['task-title'] }),
        },
      });
    }
    case 'say': {
      if (values.file && positionals.length) throw new Error('Use either message text or --file.');
      const text = values.file ? await readFile(values.file, 'utf8') : positionals.join(' ');
      const from = values.from ?? env.MU_AGENT_ID ?? 'user';
      const conversationId = selectedConversation ?? env.MU_CONVERSATION_ID ?? 'common';
      const sent = await request(url, '/api/messages', {
        method: 'POST',
        body: { from, conversationId, text: required(text, 'message text') },
      });
      // A managed turn also posts its final text to its own conversation. The turn prompt says so, but a context
      // compaction in the middle of the turn drops the prompt, and the agent then answers twice: with this message and
      // with its final text. The note reaches the agent after the compaction, at the moment it could repeat itself.
      const ownTurnConversation =
        env.MU_MESSAGE_ID !== undefined && from === env.MU_AGENT_ID && conversationId === env.MU_CONVERSATION_ID;
      return ownTurnConversation ? { ...sent, note: ownConversationNote(conversationId) } : sent;
    }
    case 'room:create':
      return request(url, '/api/conversations', {
        method: 'POST',
        body: {
          kind: 'room',
          name: required(values.name, '--name'),
          ...(values.id === undefined ? {} : { id: values.id }),
          members: members(values.members),
          from: values.from ?? env.MU_AGENT_ID ?? 'user',
          ...((values['source-conversation'] ?? env.MU_CONVERSATION_ID) === undefined
            ? {}
            : { sourceConversationId: values['source-conversation'] ?? env.MU_CONVERSATION_ID }),
        },
      });
    case 'room:invite':
      return request(
        url,
        `/api/conversations/${encodeURIComponent(required(selectedConversation, '--conversation'))}/members`,
        {
          method: 'POST',
          body: {
            members: members(required(values.members, '--members')),
            from: values.from ?? env.MU_AGENT_ID ?? 'user',
          },
        },
      );
    case 'room:list':
      return request(url, '/api/conversations');
    case 'history': {
      const conversation = selectedConversation ?? env.MU_CONVERSATION_ID ?? 'common';
      const query = new URLSearchParams({ limit: String(integer(values.limit ?? '300', '--limit', 1, 1000)) });
      if (values.before !== undefined && values.after !== undefined) throw new Error('Use either --before or --after.');
      if (values.before !== undefined) query.set('before', String(integer(values.before, '--before', 1)));
      if (values.after !== undefined) query.set('after', String(integer(values.after, '--after', 0)));
      return request(url, `/api/conversations/${encodeURIComponent(conversation)}/messages?${query}`);
    }
    case 'task:create':
      return request(url, '/api/tasks', {
        method: 'POST',
        body: {
          title: required(values.title, '--title'),
          description: values.description ?? '',
          conversationId: required(selectedConversation ?? env.MU_CONVERSATION_ID, '--conversation'),
          ...((values['source-conversation'] ?? env.MU_CONVERSATION_ID) === undefined
            ? {}
            : { sourceConversationId: values['source-conversation'] ?? env.MU_CONVERSATION_ID }),
          agentIds: members(values.agents),
          from: values.from ?? env.MU_AGENT_ID ?? 'user',
        },
      });
    case 'task:list': {
      const tasks = await request(url, values['include-verified'] ? '/api/tasks?include=verified' : '/api/tasks');
      return selectedConversation ? tasks.filter((task) => task.conversationId === selectedConversation) : tasks;
    }
    case 'task:update': {
      if (values.file && values.result !== undefined) throw new Error('Use either --result or --file.');
      const body = { from: values.from ?? env.MU_AGENT_ID ?? 'user' };
      for (const key of ['title', 'description', 'result', 'status']) {
        if (values[key] !== undefined) body[key] = values[key];
      }
      if (values.file) body.result = await readFile(values.file, 'utf8');
      if (values.agents !== undefined) body.agentIds = members(values.agents);
      if (Object.keys(body).length === 1) throw new Error('Provide a task field to update.');
      return request(url, `/api/tasks/${encodeURIComponent(required(values.id, '--id'))}`, { method: 'PATCH', body });
    }
    case 'waiting:add':
      return request(url, '/api/waiting', {
        method: 'POST',
        body: {
          text: required(values.text, '--text'),
          ...(values['task-id'] === undefined ? {} : { taskId: values['task-id'] }),
          from: values.from ?? env.MU_AGENT_ID ?? 'user',
        },
      });
    case 'waiting:list':
      return request(url, '/api/waiting');
    case 'waiting:remove':
      return request(url, `/api/waiting/${encodeURIComponent(required(values.id, '--id'))}`, {
        method: 'DELETE',
        body: { from: values.from ?? env.MU_AGENT_ID ?? 'user' },
      });
    case 'activity:add':
      return request(url, '/api/activities', {
        method: 'POST',
        body: {
          text: required(values.text, '--text'),
          ...(values.lane === undefined ? {} : { lane: values.lane }),
          ...(values['task-ids'] === undefined ? {} : { taskIds: members(values['task-ids']) }),
          from: values.from ?? env.MU_AGENT_ID ?? 'user',
        },
      });
    case 'activity:list':
      return request(url, values['include-checked'] ? '/api/activities?include=checked' : '/api/activities');
    case 'activity:edit': {
      const body = { from: values.from ?? env.MU_AGENT_ID ?? 'user' };
      for (const key of ['text', 'lane']) if (values[key] !== undefined) body[key] = values[key];
      if (values.position !== undefined) body.position = integer(values.position, '--position', 1, 10_000);
      if (Object.keys(body).length === 1) throw new Error('Provide --text, --lane or --position.');
      return request(url, `/api/activities/${encodeURIComponent(required(values.id, '--id'))}`, {
        method: 'PATCH',
        body,
      });
    }
    case 'activity:check':
    case 'activity:uncheck':
      return request(url, `/api/activities/${encodeURIComponent(required(values.id, '--id'))}`, {
        method: 'PATCH',
        body: { checked: command === 'activity:check', from: values.from ?? env.MU_AGENT_ID ?? 'user' },
      });
    case 'activity:delete':
      return request(url, `/api/activities/${encodeURIComponent(required(values.id, '--id'))}`, {
        method: 'DELETE',
        body: { from: values.from ?? env.MU_AGENT_ID ?? 'user' },
      });
    case 'activity:history':
      return request(url, `/api/activities/${encodeURIComponent(required(values.id, '--id'))}/history`);
    case 'activity:link':
      return request(url, `/api/activities/${encodeURIComponent(required(values.id, '--id'))}/tasks`, {
        method: 'POST',
        body: { taskId: required(values['task-id'], '--task-id'), from: values.from ?? env.MU_AGENT_ID ?? 'user' },
      });
    case 'activity:unlink':
      return request(
        url,
        `/api/activities/${encodeURIComponent(required(values.id, '--id'))}/tasks/${encodeURIComponent(required(values['task-id'], '--task-id'))}`,
        { method: 'DELETE', body: { from: values.from ?? env.MU_AGENT_ID ?? 'user' } },
      );
    case 'task:retire':
      return request(url, `/api/tasks/${encodeURIComponent(required(values.id, '--id'))}/retire`, {
        method: 'POST',
        body: { from: values.from ?? env.MU_AGENT_ID ?? 'user' },
      });
    case 'inbox': {
      const wait = integer(values.wait ?? '0', '--wait', 0, 25);
      return request(url, `/api/agents/${id()}/inbox?wait=${wait}`);
    }
    case 'ack':
      return request(url, `/api/agents/${id()}/ack`, {
        method: 'POST',
        body: { id: integer(values.message, '--message', 1) },
      });
    case 'status':
      return request(url, `/api/agents/${id()}`, {
        method: 'PATCH',
        body: {
          from: env.MU_AGENT_ID ?? 'user',
          status: required(values.status, '--status'),
          ...(values.task === undefined ? {} : { task: values.task }),
        },
      });
    case 'stop':
      return request(url, `/api/agents/${id()}/stop`, { method: 'POST', body: { from: env.MU_AGENT_ID ?? 'user' } });
    case 'configure':
      if (
        [values.adapter, values.model, values.cwd, values.effort, values['new-session']].every(
          (value) => value === undefined,
        )
      )
        throw new Error('Pass --adapter, --model, --cwd, --effort or --new-session.');
      return request(url, `/api/agents/${id()}`, {
        method: 'PATCH',
        body: {
          from: env.MU_AGENT_ID ?? 'user',
          ...(values.adapter === undefined ? {} : { adapter: values.adapter }),
          ...(values.model === undefined ? {} : { model: values.model === 'default' ? null : values.model }),
          ...(values['new-session'] ? { newSession: true } : {}),
          ...(values.cwd === undefined ? {} : { cwd: resolve(values.cwd) }),
          ...(values.effort === undefined ? {} : { effort: values.effort === 'default' ? null : values.effort }),
        },
      });
    case 'state':
      return request(url, '/api/state');
    case 'service':
      return request(url, '/api/service');
    // No launchctl fallback: only the service can check the new code, wait for the calling turn and authorize
    // the caller, so a service that does not answer is reported, not restarted.
    case 'restart':
      try {
        return await request(url, '/api/service/restart', {
          method: 'POST',
          signal: AbortSignal.timeout(restartTimeoutMs),
          body: {
            from: env.MU_AGENT_ID ?? 'user',
            ...((selectedConversation ?? env.MU_CONVERSATION_ID) === undefined
              ? {}
              : { conversationId: selectedConversation ?? env.MU_CONVERSATION_ID }),
          },
        });
      } catch (error) {
        // Only a refused connection proves that no service received the request; after a timeout the service may still restart.
        if (['ECONNREFUSED', 'ENOENT'].includes(error.cause?.code))
          throw new Error(
            `${error.message}. Nothing was restarted. If Mu runs as a launchd agent, the user can restart it with: launchctl kickstart -k gui/$(id -u)/LABEL, and read its log (see docs/launchd.md).`,
            { cause: error },
          );
        if (['TimeoutError', 'AbortError'].includes(error.cause?.name))
          throw new Error(
            `Mu did not answer the restart request within ${restartTimeoutMs / 1000} seconds, so its outcome is unknown: Mu may still restart. Do not request it again yet; check node src/cli.mjs service and the conversation for the restart notice.`,
            { cause: error },
          );
        throw error;
      }
    case 'agents': {
      // The registry keeps every retired agent, so the full list outgrows what an agent CLI shows of a command's output.
      const ids = members(values.id);
      const statuses = members(values.status);
      const agents = await request(url, '/api/agents');
      if (!ids.length && !statuses.length) return agents;
      return agents.filter(
        (agent) => (!ids.length || ids.includes(agent.id)) && (!statuses.length || statuses.includes(agent.status)),
      );
    }
    case 'chat':
      if (values.to && selectedConversation) throw new Error('Use either --to or --conversation.');
      if (values.to && !/^[a-z][a-z0-9-]{0,23}$/.test(values.to)) throw new Error('Invalid chat recipient.');
      await terminalChat(url, selectedConversation ?? `dm-${values.to ?? 'lead'}`, token);
      return undefined;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => {
      if (result !== undefined)
        process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`mu: ${error.message}\n`);
      process.exitCode = 1;
    });
}
