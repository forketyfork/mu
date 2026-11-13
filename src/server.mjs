import http from 'node:http';
import { startEventLoopMonitor } from './event-loop-monitor.mjs';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store, STATUSES, mentions } from './store.mjs';
import { Chat, MAX_MESSAGE_BYTES } from './chat.mjs';
import { Runner } from './runner.mjs';
import { MODEL_REQUIRED_ADAPTERS, SANDBOXED_ADAPTERS, claudeLeadArgs, effortError, modelError } from './adapters.mjs';
import { AgentSockets, Identity, bearer } from './identity.mjs';
import { createTasks } from './tasks.mjs';
import { createWaiting } from './waiting.mjs';
import { createActivities } from './activities.mjs';
import { createDashboardStream } from './dashboard.mjs';
import { PricingCatalog } from './pricing.mjs';
import { readBrag } from './brag.mjs';
import { Transcripts } from './transcripts.mjs';
import {
  DEFAULTS,
  homeState,
  initializeHome,
  leftoverError,
  resolveConfigFile,
  resolveDataDir,
  resolveHome,
} from './home.mjs';
import { lockDataDir } from './lock.mjs';
import { homeRootError, homeWorkspaceError } from './sandbox.mjs';
import {
  RESTART_EXIT_CODE,
  codeDigest,
  codeSnapshot,
  codeState,
  launchdJob,
  readRestartRecord,
  removeRestartRecord,
  startCheck,
  writeRestartRecord,
} from './service.mjs';
import { httpError as bad } from './http-error.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// NUL and the CTCP marker would corrupt the IRC line that carries a message.
// eslint-disable-next-line no-control-regex -- the pattern is about control characters
const IRC_CONTROL = /[\0\x01]/;
function object(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw bad('Expected a JSON object');
  return value;
}
async function body(request) {
  request.setEncoding('utf8');
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 512 * 1024) throw bad('Request exceeds 512 KiB', 413);
  }
  try {
    return object(JSON.parse(text));
  } catch (error) {
    if (error.status) throw error;
    throw bad('Invalid JSON body');
  }
}
function send(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}
export async function createApp({
  root = ROOT,
  home = '',
  port = 4310,
  dataDir = join(resolve(home), 'data'),
  configFile = '',
  ircHost = '127.0.0.1',
  ircPort = 6667,
  channel = '#mu',
  custom = {},
  cliArgs = {},
  roleCliArgs = {},
  piSandbox = /** @type {import('./sandbox.mjs').PiSandbox} */ ({}),
  codexSandbox = /** @type {import('./sandbox.mjs').CodexSandbox} */ ({}),
  privatePaths = null,
  platform = process.platform,
  chatFactory = null,
  database = null,
  pricingEnabled = true,
  pricingFetch = globalThis.fetch,
  pricing = new PricingCatalog({
    cacheFile: join(dataDir, 'litellm-prices.json'),
    enabled: pricingEnabled,
    fetch: pricingFetch,
  }),
  transcriptHomes = {},
  launchd = null,
  requireIrc = false,
  exit = /** @type {(code: number) => void} */ ((code) => process.exit(code)),
  env = process.env,
  restartWaitMs = 15 * 60_000,
  reconnectDelayMs = 5000,
} = {}) {
  if (!home) throw new Error('createApp needs the initialized Mu home');
  const resolvedHome = resolve(home);
  const homeEnv = { ...env, MU_DATA_DIR: dataDir };
  try {
    const installedHome = await homeState({ home: resolvedHome, root, env: homeEnv });
    const missingRoleFiles = installedHome.defaults.filter(({ state }) => state === 'missing').map(({ path }) => path);
    if (missingRoleFiles.length) throw new Error(`Missing required role files: ${missingRoleFiles.join(', ')}`);
  } catch (error) {
    throw new Error(
      `Mu home at ${resolvedHome} is missing or invalid: ${error.message}. Run node src/cli.mjs init from the user’s shell and resolve any reported conflicts.`,
      { cause: error },
    );
  }
  for (const [name, roots] of [
    ['piSandbox', piSandbox.writableRoots || []],
    ['codexSandbox', codexSandbox.writableRoots || []],
  ])
    for (const root of roots) {
      const error = homeRootError(root, resolvedHome, `The ${name}.writableRoots entry`);
      if (error) throw new Error(error);
    }
  // Checked when an agent is created or changed, so the refusal comes before the turn that would fail on it.
  const sandboxedWorkspaceError = (adapter, cwd) =>
    SANDBOXED_ADAPTERS.includes(adapter) ? homeWorkspaceError(cwd, resolvedHome, `The ${adapter} agent's cwd`) : null;
  // A pi agent reaching Mu's port or the IRC broker could bypass its socket-bound identity.
  for (const reserved of [port, ircPort])
    if ((piSandbox.localPorts || []).includes(reserved))
      throw new Error(
        `piSandbox.localPorts cannot include ${reserved}: pi agents reach Mu only through their own socket, and the IRC broker accepts any nickname`,
      );
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  // The file the entry point loaded the configuration from; a change to it makes the running code stale.
  configFile ||= resolveConfigFile(env, resolvedHome);
  // Taken before anything else starts, so it describes the code this process loaded; a later change makes it stale.
  const loadedCode = await codeSnapshot(root, { configFile });
  const startedAt = new Date().toISOString();
  const lock = lockDataDir(dataDir, { pid: process.pid, root, port, startedAt });
  /** @type {Store} */
  let store;
  /** @type {Identity} */
  let identity;
  // The database and the user credential are what a damaged data directory breaks; the lock must not outlive them.
  try {
    store = new Store(database || join(dataDir, 'mu.sqlite'), { commonChannel: channel });
    identity = new Identity({ dataDir });
  } catch (error) {
    store?.close();
    lock.release();
    throw error;
  }
  const options = {
    host: ircHost,
    port: ircPort,
    channel,
    onMessage: (...args) => store.addMessage(...args),
    getConversation: (id) => store.conversation(id),
    getConversations: () => store.conversations(),
  };
  const chat = chatFactory ? chatFactory(options) : new Chat(options);
  const url = `http://127.0.0.1:${port}`;
  const sockets = new AgentSockets({
    dataDir,
    handler: (request, response, binding) => handle(request, response, binding),
  });
  /** @type {{tasks: ReturnType<typeof createTasks>|null, waiting: ReturnType<typeof createWaiting>|null}} */
  const leadPromptState = { tasks: null, waiting: null };
  const runner = new Runner({
    store,
    chat,
    root,
    home: resolvedHome,
    url,
    custom,
    cliArgs,
    roleCliArgs,
    pricing,
    dataDir,
    piSandbox,
    codexSandbox,
    privatePaths,
    identity,
    sockets,
    leadTaskContext: () => {
      const { tasks, waiting } = leadPromptState;
      if (!tasks || !waiting) throw new Error('Lead task context is not ready');
      return { tasks: tasks.list(), waiting: waiting.list() };
    },
  });
  const tasks = createTasks({ store, chat, runner });
  leadPromptState.tasks = tasks;
  // Masking hides the user credential and every live turn credential wherever a transcript shows one.
  const transcripts = new Transcripts({
    dataDir,
    ...transcriptHomes,
    credentials: () => [identity.token, ...identity.agentTokens.keys()],
  });
  const waiting = createWaiting({ store, tasks });
  leadPromptState.waiting = waiting;
  const activities = createActivities({ store, tasks });
  let stopEventLoopMonitor = null;
  const adapters = ['codex', 'claude', 'pi', 'manual', 'demo', ...Object.keys(custom)];
  const withPid = (agent) => {
    const active = runner.active.get(agent.id);
    return {
      ...agent,
      pid: active?.child?.pid || null,
      activeConversationId: active?.conversationId ?? null,
    };
  };
  const agentState = () => store.agents().map(withPid);
  const memberOf = (caller, conversationId) =>
    caller === 'user' || Boolean(store.conversation(conversationId)?.members.includes(caller));
  // An agent sees every identity and status, but assignments, errors and usage only from its own conversations.
  const registryFor = (caller) =>
    agentRegistry().map((agent) =>
      caller === 'user'
        ? agent
        : {
            ...agent,
            task: memberOf(caller, agent.conversationId) ? agent.task : null,
            lastError: memberOf(caller, agent.conversationId) ? agent.lastError : null,
            usage: Object.fromEntries(
              Object.entries(agent.usage).filter(([conversationId]) => memberOf(caller, conversationId)),
            ),
          },
    );
  const agentRegistry = () =>
    agentState().map(
      ({
        id,
        role,
        adapter,
        model,
        effort,
        cwd,
        task,
        taskId,
        conversationId,
        status,
        pid,
        pending,
        createdAt,
        updatedAt,
        lastError,
        pendingResult,
        usage,
      }) => ({
        id,
        role,
        adapter,
        model: model ?? null,
        effort: effort ?? null,
        cwd,
        task,
        taskId,
        conversationId,
        status,
        pid,
        pending,
        createdAt,
        updatedAt,
        lastError,
        hasPendingResult: Boolean(pendingResult),
        usage: usage || {},
      }),
    );
  const state = () => ({
    agents: agentState(),
    tasks: tasks.list(),
    waiting: waiting.list(),
    activities: activities.list(),
    conversations: store.conversations(),
    messages: store
      .conversations()
      .flatMap((conversation) => store.messages(300, conversation.id))
      .sort((a, b) => a.id - b.id),
    transport: { ...chat.state },
    adapters,
  });
  // The credential decides who calls; see "Caller identity" in docs/architecture.md.
  // On an agent's socket only that agent's turn credential is accepted. On TCP, a socket-bound
  // credential is refused, so a sandboxed agent's credential is useless outside its socket.
  const authenticate = (request, binding, parsed) => {
    const presented =
      bearer(request) ??
      (request.method === 'GET' && parsed.pathname === '/api/events' ? parsed.searchParams.get('token') : null);
    const caller = identity.resolve(presented);
    if (binding) {
      if (caller?.agentId !== binding.agentId || caller.socket !== true)
        throw bad(`This socket accepts only the turn credential of @${binding.agentId}`, 401);
      return caller.agentId;
    }
    if (!caller)
      throw bad(
        presented
          ? 'Unknown or expired Mu credential. Managed agents receive one per turn in the file named by MU_TOKEN_FILE; the user credential is in the data directory, and the dashboard needs the sign-in link that the service prints at start.'
          : 'Mu needs a credential: the CLI sends the turn credential from MU_TOKEN_FILE or the user credential from the data directory, and the dashboard needs the sign-in link that the service prints at start.',
        401,
      );
    if (caller.socket) throw bad(`The credential of @${caller.agentId} is valid only on its own socket`, 401);
    return caller.agentId ?? 'user';
  };
  // An agent always acts as itself. The user credential acts as the user, or as a manual agent,
  // whose interactive CLI the user runs; a managed agent acts only through its own turn credential.
  const actor = (request, input) => {
    const caller = request.caller;
    if (caller !== 'user') {
      if (input.from !== undefined && input.from !== caller)
        throw bad(`This credential belongs to @${caller}; it cannot act as @${input.from}`, 403);
      return caller;
    }
    // The dashboard always speaks as the user.
    const from = request.headers.origin ? 'user' : (input.from ?? 'user');
    if (from === 'user') return from;
    const agent = store.agent(from);
    if (!agent) throw bad(`Unknown sender @${from}`);
    if (agent.adapter !== 'manual')
      throw bad(`@${from} is a managed ${agent.adapter} agent; it acts only through its own turn credential`, 403);
    return from;
  };
  // A restart is a clean shutdown with RESTART_EXIT_CODE, after which launchd starts the checkout's code again.
  // It waits until the requesting turn has ended, so that turn's message is acknowledged and does not run again.
  let restart = null,
    closing = null;
  const digest = () => codeDigest(root, { configFile });
  const shutdown = (code) => {
    if (!closing)
      app.close().then(
        () => exit(code),
        (error) => {
          console.error(error);
          exit(1);
        },
      );
    return closing;
  };
  const notify = async (conversationId, text) => {
    try {
      await chat.send('system', text, conversationId);
    } catch (error) {
      console.error(`Could not post in ${conversationId}: ${error.message}\n${text}`);
    }
  };
  const working = (except) =>
    store
      .agents()
      .filter((agent) => agent.id !== except && runner.active.has(agent.id))
      .map((agent) => agent.id);
  const finishRestart = async (ended) => {
    // A shutdown for another reason, such as a signal, ended the requesting turn; that is not the requested restart.
    if (closing) return;
    const { requestedBy, conversationId } = restart;
    const mention = requestedBy === 'user' ? '@user' : `@${requestedBy}`;
    let reason = ended === 'timeout' ? `the requesting turn did not end within ${restartWaitMs / 1000} seconds` : null;
    if (!reason)
      try {
        if ((await digest()) !== restart.digest)
          reason = 'its code or configuration changed after the start check passed';
      } catch (error) {
        reason = `its code could not be read again: ${error.message}`;
      }
    if (!reason) {
      try {
        await writeRestartRecord(dataDir, {
          requestedBy,
          conversationId,
          requestedAt: restart.requestedAt,
          previous: { pid: process.pid, startedAt },
        });
      } catch (error) {
        reason = `the restart record could not be written: ${error.message}`;
      }
    }
    if (reason) {
      console.error(`Restart cancelled: ${reason}`);
      restart = null;
      runner.paused = false;
      runner.kick();
      if (conversationId)
        await notify(
          conversationId,
          `${mention} Mu did not restart: ${reason}. It keeps running the code of its last start, and turns run again. Request the restart again to check the current code.`,
        );
      return;
    }
    console.log(`${new Date().toISOString()} Restarting at the request of ${mention}`);
    shutdown(RESTART_EXIT_CODE);
  };
  const scheduleRestart = async (from, conversationId) => {
    if (from !== 'user' && from !== 'lead')
      throw bad('Only the lead and the user restart Mu; workers never restart, stop or signal the service', 403);
    if (!launchd)
      throw bad(
        'This Mu instance was not started by launchd, so nothing would start it again after it exits. Restart it where it runs, or install the launchd agent (see "Run Mu as a launchd agent" in README.md).',
        409,
      );
    if (restart)
      throw bad(`A restart requested by @${restart.requestedBy} at ${restart.requestedAt} is already in progress`, 409);
    restart = {
      requestedBy: from,
      conversationId,
      requestedAt: new Date().toISOString(),
      checking: true,
      digest: null,
    };
    try {
      restart.digest = await digest();
      await startCheck({
        root,
        store,
        dataDir,
        env: { ...env, MU_HOME: resolvedHome, MU_DATA_DIR: dataDir },
        home: resolvedHome,
      });
    } catch (error) {
      restart = null;
      throw bad(`Restart refused: ${error.message}`, 409);
    }
    restart.checking = false;
    runner.paused = true;
    // A managed lead asks from inside its own turn, which is a child of this process.
    const requestingTurn = from === 'user' ? null : (runner.active.get(from) ?? null);
    // Turns stay paused while Mu waits, so the wait has a limit; a turn that outlives it cancels the restart.
    let timer;
    const waited = requestingTurn
      ? Promise.race([
          requestingTurn.done.then(() => 'ended'),
          new Promise((resolveWait) => {
            timer = setTimeout(resolveWait, restartWaitMs, 'timeout');
          }),
        ])
      : Promise.resolve('ended');
    waited
      .then((ended) => {
        clearTimeout(timer);
        return finishRestart(ended);
      })
      .catch((error) => {
        console.error(`Restart failed: ${error.stack || error.message}`);
        shutdown(1);
      });
    return {
      scheduled: true,
      waitingFor: requestingTurn ? `the current turn of @${from}` : null,
      interrupts: working(from),
      conversationId: conversationId ?? null,
    };
  };
  const userOnly = (request, what) => {
    if (request.caller !== 'user') throw bad(`Only the user ${what}`, 403);
  };
  const selfOrUser = (request, id) => {
    if (request.caller !== 'user' && request.caller !== id)
      throw bad(`@${request.caller} cannot use the inbox of @${id}`, 403);
  };
  // A sandboxed agent may start only agents with its own adapter inside its own workspace, so the
  // new agent's sandbox grants nothing its creator lacks.
  const guardCreation = async (from, input) => {
    if (from === 'user') return;
    const creator = store.agent(from);
    if (!SANDBOXED_ADAPTERS.includes(creator.adapter)) return;
    if (input.adapter !== creator.adapter)
      throw bad(`A ${creator.adapter} lead runs in a sandbox and can create only ${creator.adapter} agents`, 403);
    const [workspace, target] = await Promise.all([realpath(creator.cwd), realpath(input.cwd)]);
    if (target !== workspace && !target.startsWith(`${workspace}/`))
      throw bad(`A ${creator.adapter} lead can create agents only inside its own workspace ${workspace}`, 403);
  };
  const conversationFor = (id, from = 'user') => {
    if (typeof id !== 'string') throw bad('conversationId must be a string');
    const conversation = store.conversation(id);
    if (!conversation) throw bad(`Unknown conversation ${id}`, 404);
    if (from !== 'user' && !conversation.members.includes(from)) throw bad(`@${from} is not a member of ${id}`, 403);
    return conversation;
  };
  const validateMembers = (members) => {
    if (!Array.isArray(members) || members.length > 50 || !members.every((member) => typeof member === 'string'))
      throw bad('members must be an array of at most 50 agent IDs');
    for (const member of members)
      if (member !== 'user' && !store.agent(member)) throw bad(`Unknown member @${member}; register the agent first`);
    return [...new Set(members)];
  };
  // A user message that no agent will process gets a visible notice instead of silence.
  // The notice names agents without @ so that it does not wake anyone.
  const deliveryNotice = (conversation, message) => {
    const members = conversation.members.filter((id) => id !== 'user');
    const recipients =
      conversation.kind === 'direct' || message.mentions.includes('all')
        ? members
        : members.filter((id) => message.mentions.includes(id));
    if (!recipients.length)
      return `@user Message #${message.id} reached no agent. In a room, only the members it mentions receive a message. Send it again and mention a member, for example the lead, or all members.`;
    const paused = recipients
      .map((id) => store.agent(id))
      .filter((agent) => agent && ['stopped', 'error'].includes(agent.status));
    if (!paused.length) return null;
    const names = paused.map((agent) => `${agent.id} (${agent.status})`).join(', ');
    return `@user Message #${message.id} is queued, but nobody will process it now: ${names} ${paused.length === 1 ? 'does' : 'do'} not run turns until resumed. Ask the lead to take over the request, or resume the agent from its card.`;
  };
  const syncConversation = async (conversation) => {
    try {
      await chat.syncConversation(conversation);
    } catch (error) {
      throw bad(
        `Conversation ${conversation.id} is saved, but IRC membership could not be established: ${error.message}`,
        503,
      );
    }
  };
  const dashboard = createDashboardStream({
    sources: {
      agents: {
        list: agentState,
        get: (id) => {
          const agent = store.agent(id);
          return agent && withPid(agent);
        },
      },
      tasks: { list: () => tasks.list(), get: (id) => tasks.find(id) },
      // Both lists are short. An activity change always names the whole list, because a move renumbers its lane.
      waiting: { list: () => waiting.list(), get: (id) => waiting.list().find((card) => card.id === id) ?? null },
      activities: {
        list: () => activities.list(),
        get: (id) => activities.list().find((activity) => activity.id === id) ?? null,
      },
      conversations: { list: () => store.conversations(), get: (id) => store.conversation(id) },
    },
    lastMessageIds: () => store.lastMessageIds(),
    transport: () => ({ ...chat.state }),
    adapters,
  });
  store.on('change', (changes) => dashboard.change(changes));
  store.on('message', (message) => {
    dashboard.message(message);
    runner.kick();
  });
  chat.on('change', () => dashboard.transportChanged());
  const handle = async (request, response, binding = null) => {
    try {
      if (binding) {
        if (request.headers.origin) throw bad('Browser requests are not accepted on an agent socket', 403);
      } else {
        const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (!allowedHosts.includes(request.headers.host)) throw bad('Host must be the local Mu address', 403);
        if (request.headers.origin && !allowedHosts.map((host) => `http://${host}`).includes(request.headers.origin))
          throw bad('Requests from other browser origins are not allowed', 403);
        if (request.headers['sec-fetch-site'] === 'cross-site') throw bad('Cross-site requests are not allowed', 403);
      }
      const parsed = new URL(request.url, url);
      const pathname = parsed.pathname;
      if (pathname.startsWith('/api/')) request.caller = authenticate(request, binding, parsed);
      else if (binding) throw bad('Not found', 404);
      if (request.method === 'GET' && (pathname === '/api/state' || pathname === '/api/events'))
        userOnly(
          request,
          'reads the whole workspace state, which includes every private chat; agents use agents, task list, room list and history',
        );
      if (request.method === 'GET' && pathname === '/api/state') return send(response, 200, state());
      if (request.method === 'GET' && pathname === '/api/agents')
        return send(response, 200, registryFor(request.caller));
      if (request.method === 'GET' && pathname === '/api/conversations')
        return send(
          response,
          200,
          store.conversations().filter((conversation) => memberOf(request.caller, conversation.id)),
        );
      if (request.method === 'POST' && pathname === '/api/conversations') {
        const input = await body(request),
          from = actor(request, input);
        const members = validateMembers(input.members || []);
        if (input.kind === 'direct') {
          const other = members.filter((member) => member !== 'user');
          if (other.length !== 1 || from !== 'user')
            throw bad('A direct conversation contains the user and one registered agent');
          const conversation = store.ensureDirect(other[0]);
          await syncConversation(conversation);
          return send(response, 200, conversation);
        }
        if (input.kind !== 'room') throw bad('kind must be room or direct');
        const id = input.id || `room-${randomUUID().slice(0, 8)}`;
        if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || id === 'common' || id.startsWith('dm-'))
          throw bad('Room id must use 1–32 lowercase letters, digits or hyphens; common and dm- IDs are reserved');
        if (store.conversation(id)) throw bad(`Conversation ${id} already exists`, 409);
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)
          throw bad('Room name must contain 1–80 characters');
        if (input.sourceConversationId !== undefined) conversationFor(input.sourceConversationId, from);
        if (!chat.state.connected) throw bad(chat.state.error || 'IRC unavailable', 503);
        const conversation = store.createConversation({
          id,
          kind: 'room',
          name: input.name.trim(),
          members: [...members, from],
          createdBy: from,
          ...(input.sourceConversationId !== undefined ? { sourceConversationId: input.sourceConversationId } : {}),
        });
        await syncConversation(conversation);
        return send(response, 201, conversation);
      }
      const conversationMatch = pathname.match(/^\/api\/conversations\/([a-z][a-z0-9-]{0,31})\/(members|messages)$/);
      if (conversationMatch) {
        const [, id, action] = conversationMatch;
        if (request.method === 'GET' && action === 'messages') {
          conversationFor(id, request.caller);
          const limit = Number(parsed.searchParams.get('limit') || 300);
          const before = parsed.searchParams.has('before') ? Number(parsed.searchParams.get('before')) : undefined;
          const after = parsed.searchParams.has('after') ? Number(parsed.searchParams.get('after')) : undefined;
          if (
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 1000 ||
            (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) ||
            (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) ||
            (before !== undefined && after !== undefined)
          )
            throw bad(
              'limit must be 1–1000; before must be a positive message ID, or after a message ID or 0, not both',
            );
          return send(response, 200, {
            messages: after === undefined ? store.messages(limit, id, before) : store.messagesAfter(id, after, limit),
          });
        }
        if (request.method === 'POST' && action === 'members') {
          const input = await body(request),
            from = actor(request, input);
          const conversation = conversationFor(id, from);
          if (conversation.kind !== 'room') throw bad('Only task rooms can invite additional members');
          const updated = store.addMembers(id, validateMembers(input.members));
          await syncConversation(updated);
          return send(response, 200, updated);
        }
      }
      if (request.method === 'GET' && pathname === '/api/events') {
        const lastEventId = request.headers['last-event-id'];
        dashboard.connect(response, Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
        return;
      }
      const messageMatch = pathname.match(/^\/api\/messages\/([1-9]\d{0,15})$/);
      if (request.method === 'GET' && messageMatch) {
        const message = store.message(Number(messageMatch[1]));
        if (!message || !memberOf(request.caller, message.conversationId))
          throw bad(`Unknown message ${messageMatch[1]}`, 404);
        return send(response, 200, message);
      }
      if (request.method === 'POST' && pathname === '/api/messages') {
        const input = await body(request);
        const from = actor(request, input);
        if (request.headers.origin && input.conversationId === undefined)
          throw bad('Select a conversation before sending. Refresh the dashboard if it is out of date.');
        const conversation = conversationFor(input.conversationId ?? 'common', from);
        if (
          typeof input.text !== 'string' ||
          !input.text.trim() ||
          Buffer.byteLength(input.text) > MAX_MESSAGE_BYTES ||
          IRC_CONTROL.test(input.text)
        )
          throw bad(
            `Chat text must contain 1–${MAX_MESSAGE_BYTES} UTF-8 bytes and cannot contain IRC control delimiters`,
          );
        for (const mention of mentions(input.text)) {
          if (!['user', 'all'].includes(mention) && !store.agent(mention))
            throw bad(`Unknown mention @${mention}; register the agent first`);
          if (!['user', 'all'].includes(mention) && !conversation.members.includes(mention))
            throw bad(`@${mention} is not in this conversation; invite the agent to the room first`);
          // A stopped (retired) agent never runs a turn, so a report that mentions it reaches nobody. Failed agents can be resumed, so they stay mentionable.
          if (from !== 'user' && store.agent(mention)?.status === 'stopped')
            throw bad(
              `@${mention} is stopped and cannot receive messages; address a live agent, such as the agent that assigned the work, or write the agent's id in a code span`,
            );
        }
        if (!chat.state.connected) throw bad(chat.state.error || 'IRC unavailable', 503);
        let message;
        try {
          message = await chat.send(from, input.text.trim(), conversation.id);
        } catch (error) {
          if (!chat.state.connected) throw bad(chat.state.error || error.message || 'IRC unavailable', 503);
          throw error;
        }
        const notice = from === 'user' ? deliveryNotice(conversation, message) : null;
        if (notice) {
          try {
            await chat.send('system', notice, conversation.id);
          } catch (error) {
            throw bad(
              `Message #${message.id} was saved, but its delivery notice could not be posted: ${error.message}`,
              503,
            );
          }
        }
        return send(response, 201, message);
      }
      if (request.method === 'POST' && pathname === '/api/agents') {
        const input = await body(request);
        const from = actor(request, input);
        if (request.headers.origin && input.conversationId === undefined)
          throw bad('Select an assignment conversation before launching. Refresh the dashboard if it is out of date.');
        if (from !== 'user' && store.agent(from).role !== 'lead')
          throw bad('Only the user and the team lead can create agents', 403);
        if (
          typeof input.id !== 'string' ||
          !/^[a-z][a-z0-9-]{0,23}$/.test(input.id) ||
          ['user', 'all', 'system', 'mu-observer'].includes(input.id)
        )
          throw bad(
            'Agent id must start with a lowercase letter, contain lowercase letters, digits or hyphens, and be at most 24 characters',
          );
        if (!['lead', 'worker'].includes(input.role)) throw bad('Role must be lead or worker');
        if ((input.role === 'lead') !== (input.id === 'lead'))
          throw bad('The team lead must have id lead; workers must use a different id');
        if (!adapters.includes(input.adapter)) throw bad(`Unknown adapter ${input.adapter}`);
        if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd))
          throw bad('cwd must be an absolute directory path');
        try {
          if (!(await stat(input.cwd)).isDirectory()) throw new Error('not a directory');
        } catch {
          throw bad('cwd must be an existing directory');
        }
        if (input.model !== undefined) {
          const error = modelError(input.adapter, input.model);
          if (error) throw bad(error);
        }
        if (input.effort !== undefined) {
          const error = effortError(input.adapter, input.effort);
          if (error) throw bad(error);
        }
        if (input.adapter === 'pi' && platform !== 'darwin')
          throw bad(`The pi adapter needs the macOS Seatbelt sandbox, which is not available on ${platform}`);
        if (input.model === undefined && MODEL_REQUIRED_ADAPTERS.includes(input.adapter))
          throw bad(`The ${input.adapter} adapter needs a model; pass one such as provider/model-id`);
        const misplaced = sandboxedWorkspaceError(input.adapter, input.cwd);
        if (misplaced) throw bad(misplaced);
        const task = input.task || '';
        if (typeof task !== 'string' || task.length > 1800)
          throw bad('Task must be a string of at most 1800 characters');
        if (store.agent(input.id)) throw bad(`Agent @${input.id} already exists`, 409);
        await guardCreation(from, input);
        const conversationId = input.conversationId ?? (from === 'user' ? `dm-${input.id}` : 'common');
        let conversation;
        if (conversationId === `dm-${input.id}`) {
          if (from !== 'user')
            throw bad('Create a task room before assigning a worker; its direct chat belongs to the user');
        } else {
          conversation = conversationFor(conversationId, from);
          if (conversation.kind === 'direct')
            throw bad(
              'Create a task room to assign work to another agent; direct chats contain only the user and their agent',
            );
        }
        if (input.taskId !== undefined && input.taskTitle !== undefined)
          throw bad('Choose an existing taskId or a new taskTitle, not both');
        const trackedAssignment = input.taskId !== undefined || input.taskTitle !== undefined;
        if (input.role === 'worker' && task.trim() && !trackedAssignment)
          throw bad('Create or select a task before assigning initial work');
        let existingTask;
        if (trackedAssignment) {
          if (
            input.role !== 'worker' ||
            !conversation ||
            conversation.kind !== 'room' ||
            !conversation.members.includes('lead')
          )
            throw bad('Tracked initial work requires a task room containing the team lead');
          if (
            input.taskTitle !== undefined &&
            (typeof input.taskTitle !== 'string' || !input.taskTitle.trim() || Buffer.byteLength(input.taskTitle) > 160)
          )
            throw bad('Task title must contain 1–160 UTF-8 bytes');
          if (input.taskId !== undefined) {
            if (typeof input.taskId !== 'string') throw bad('taskId must be a string');
            existingTask = tasks.get(input.taskId);
            if (existingTask.conversationId !== conversationId || existingTask.status !== 'active')
              throw bad('Select an active task in the assignment room');
          }
        }
        if (!chat.state.connected) throw bad(chat.state.error || 'IRC unavailable', 503);
        try {
          await chat.connect(input.id);
        } catch (error) {
          if (!chat.state.connected) throw bad(chat.state.error || error.message || 'IRC unavailable', 503);
          throw error;
        }
        store.transaction(() => {
          store.createAgent({
            id: input.id,
            role: input.role,
            adapter: input.adapter,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.effort === undefined ? {} : { effort: input.effort }),
            cwd: resolve(input.cwd),
            task,
            conversationId,
          });
          if (conversation?.kind === 'room') conversation = store.addMembers(conversationId, [input.id]);
          else conversation = store.conversation(conversationId);
          if (trackedAssignment) {
            const tracked = existingTask
              ? tasks.update(existingTask.id, { agentIds: [...existingTask.agentIds, input.id] }, from)
              : tasks.create({ title: input.taskTitle, description: task, conversationId, agentIds: [input.id] }, from);
            store.updateAgent(input.id, { taskId: tracked.id });
          }
        });
        await syncConversation(store.conversation(`dm-${input.id}`));
        await syncConversation(conversation);
        if (task.trim()) {
          try {
            await chat.send(from, `@${input.id}\n\n${task}`, conversationId);
          } catch (error) {
            store.updateAgent(input.id, {
              status: 'error',
              lastError: `Registered, but assignment was not confirmed: ${error.message}`,
            });
            throw bad(
              `Agent @${input.id} was registered but assignment failed. Inspect its status before retrying.`,
              503,
            );
          }
        }
        return send(response, 201, store.agent(input.id));
      }
      const transcriptMatch = pathname.match(/^\/api\/agents\/([a-z][a-z0-9-]{0,23})\/transcript(\/entry)?$/);
      if (transcriptMatch) {
        // A sandboxed lead or worker must not read, through Mu, the harness files its sandbox denies; see "Agent transcripts" in docs/architecture.md.
        userOnly(request, 'reads agent transcripts, which hold every prompt, tool call and command output of an agent');
        if (request.method !== 'GET') throw bad('Transcripts are read-only', 405);
        const agent = store.agent(transcriptMatch[1]);
        if (!agent) throw bad(`Unknown agent @${transcriptMatch[1]}`, 404);
        const conversationId = parsed.searchParams.get('conversation');
        if (!conversationId) throw bad('conversation is required');
        if (!store.conversation(conversationId)) throw bad(`Unknown conversation ${conversationId}`, 404);
        const integer = (name, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = undefined } = {}) => {
          const raw = parsed.searchParams.get(name);
          if (raw === null) {
            if (fallback === undefined) throw bad(`${name} is required`);
            return fallback;
          }
          if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max)
            throw bad(`${name} must be an integer from ${min} to ${max}`);
          return Number(raw);
        };
        if (transcriptMatch[2])
          return send(
            response,
            200,
            await transcripts.entry(
              agent,
              conversationId,
              integer('turn'),
              integer('entry'),
              parsed.searchParams.get('ref'),
            ),
          );
        return send(
          response,
          200,
          await transcripts.page(agent, conversationId, {
            before: integer('before', { fallback: null }),
            limit: integer('limit', { min: 1, max: 50, fallback: 5 }),
          }),
        );
      }
      if (request.method === 'GET' && pathname === '/api/brag') {
        userOnly(request, 'reads the brag doc');
        return send(response, 200, await readBrag(join(dataDir, 'brag')));
      }
      if (request.method === 'POST' && pathname === '/api/home/init') {
        const input = await body(request);
        for (const key of Object.keys(input))
          if (!['from', 'dryRun', 'accept', 'adopt'].includes(key)) throw bad(`Unknown home init option ${key}`);
        if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') throw bad('dryRun must be a boolean');
        if (input.accept !== undefined && typeof input.accept !== 'string') throw bad('accept must be a string');
        if (input.adopt !== undefined && typeof input.adopt !== 'boolean') throw bad('adopt must be a boolean');
        if (input.accept !== undefined && !DEFAULTS.includes(input.accept))
          throw bad('--accept must name a shipped role file');
        const from = actor(request, input);
        if (from !== 'user' && store.agent(from)?.role !== 'lead')
          throw bad('Only the user and the team lead may initialize Mu home; workers are refused', 403);
        if (from !== 'user' && (input.accept !== undefined || input.adopt === true))
          throw bad('Only the user may use --accept or --adopt when initializing Mu home', 403);
        try {
          return send(
            response,
            200,
            await initializeHome({
              env: homeEnv,
              home: resolvedHome,
              root,
              dryRun: Boolean(input.dryRun),
              accept: input.accept,
              adopt: Boolean(input.adopt),
            }),
          );
        } catch (error) {
          throw bad(`Mu home initialization failed: ${error.message}`, 409);
        }
      }
      if (request.method === 'GET' && pathname === '/api/service') {
        let homeStatus;
        try {
          homeStatus = await homeState({ home: resolvedHome, root, env: homeEnv });
        } catch (error) {
          homeStatus = { error: error.message };
        }
        return send(response, 200, {
          pid: process.pid,
          startedAt,
          root,
          home: homeStatus,
          launchd,
          code: codeState(loadedCode, await codeSnapshot(root, { configFile })),
          restart: restart && {
            requestedBy: restart.requestedBy,
            requestedAt: restart.requestedAt,
            conversationId: restart.conversationId ?? null,
            checking: restart.checking,
          },
        });
      }
      if (request.method === 'POST' && pathname === '/api/service/restart') {
        const input = await body(request),
          from = actor(request, input);
        const conversationId =
          input.conversationId === undefined ? undefined : conversationFor(input.conversationId, from).id;
        return send(response, 202, await scheduleRestart(from, conversationId));
      }
      if (await tasks.handle({ request, response, pathname, body, send, actor })) return;
      if (await waiting.handle({ request, response, pathname, body, send, actor })) return;
      if (await activities.handle({ request, response, pathname, body, send, actor })) return;
      const match = pathname.match(/^\/api\/agents\/([a-z][a-z0-9-]{0,23})(?:\/(stop|inbox|ack))?$/);
      if (match) {
        const [, id, action] = match;
        if (!store.agent(id)) throw bad(`Unknown agent @${id}`, 404);
        if (request.method === 'PATCH' && !action) {
          const input = await body(request),
            patch = {};
          const from = actor(request, input);
          for (const key of Object.keys(input))
            if (!['from', 'status', 'task', 'adapter', 'model', 'cwd', 'effort', 'newSession'].includes(key))
              throw bad(`Agent field ${key} cannot be changed`);
          if (from !== 'user' && from !== id && !(from === 'lead' && id !== 'lead'))
            throw bad(`@${from} cannot change @${id}; agents update themselves, and the lead updates workers`, 403);
          if (['adapter', 'model', 'cwd', 'effort', 'newSession'].some((key) => input[key] !== undefined)) {
            if (from !== 'user')
              throw bad(
                "Only the user can change an agent's adapter, model, working directory, reasoning effort or session",
                403,
              );
            const current = store.agent(id);
            if (!['stopped', 'error'].includes(current.status) || runner.active.has(id))
              throw bad(
                'Stop the agent before changing its adapter, model, working directory, reasoning effort or session',
                409,
              );
            if (current.pendingResult)
              throw bad(
                'Deliver the saved result before changing the adapter, model, working directory, reasoning effort or session',
                409,
              );
            if (input.adapter !== undefined) {
              if (!adapters.includes(input.adapter)) throw bad(`Unknown adapter ${input.adapter}`);
              patch.adapter = input.adapter;
              if (input.adapter !== current.adapter) {
                patch.sessionId = null;
                patch.sessionIds = {};
              }
            }
            if (input.cwd !== undefined) {
              if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd))
                throw bad('cwd must be an absolute directory path');
              try {
                if (!(await stat(input.cwd)).isDirectory()) throw new Error('not a directory');
              } catch {
                throw bad('cwd must be an existing directory');
              }
              patch.cwd = resolve(input.cwd);
              if (patch.cwd !== current.cwd) {
                patch.sessionId = null;
                patch.sessionIds = {};
              }
            }
            if (input.newSession !== undefined) {
              if (input.newSession !== true) throw bad('newSession must be true');
              patch.sessionId = null;
              patch.sessionIds = {};
            }
            // null returns the agent to the model that the configuration or the CLI selects. A kept model is not checked
            // against a new adapter: a manual or demo adapter ignores it, and another CLI rejects an unknown one on its first turn.
            const adapter = patch.adapter ?? current.adapter,
              model = input.model === undefined ? (current.model ?? null) : input.model;
            if (model === null && MODEL_REQUIRED_ADAPTERS.includes(adapter))
              throw bad(`The ${adapter} adapter needs a model; pass one such as provider/model-id`);
            if (input.model !== undefined && input.model !== null) {
              const error = modelError(adapter, input.model);
              if (error) throw bad(error);
            }
            if (input.model !== undefined) patch.model = input.model;
            const misplaced = sandboxedWorkspaceError(adapter, patch.cwd ?? current.cwd);
            if (misplaced) throw bad(misplaced);
            // null returns the agent to its CLI's default effort. A kept effort must suit a new adapter too.
            const effort = input.effort === undefined ? (current.effort ?? null) : input.effort;
            if (effort !== null) {
              const error = effortError(patch.adapter ?? current.adapter, effort);
              if (error)
                throw bad(
                  input.effort === undefined ? `${error}; pass an effort for the new adapter, or clear it` : error,
                );
            }
            if (input.effort !== undefined) patch.effort = input.effort;
          }
          if (input.status !== undefined) {
            if (!STATUSES.includes(input.status)) throw bad('Invalid status');
            patch.status = input.status;
            if (store.agent(id).status === 'error' && input.status !== 'error' && !runner.active.has(id))
              patch.lastError = null;
          }
          if (input.task !== undefined) {
            if (typeof input.task !== 'string' || input.task.length > 1800)
              throw bad('Task must be a string of at most 1800 characters');
            patch.task = input.task;
          }
          if (input.status === 'stopped') {
            tasks.guardAgentStop(from, id);
            runner.stop(id);
          }
          const agent = store.updateAgent(id, patch);
          runner.kick();
          return send(response, 200, agent);
        }
        if (request.method === 'POST' && action === 'stop') {
          const input = await body(request);
          tasks.guardAgentStop(actor(request, input), id);
          return send(response, 200, runner.stop(id));
        }
        if (request.method === 'POST' && action === 'ack') {
          selfOrUser(request, id);
          const input = await body(request);
          if (!Number.isSafeInteger(input.id) || input.id < 1) throw bad('id must be a positive message integer');
          if (runner.active.has(id))
            throw bad('Managed turns acknowledge their own messages; manual ack is unavailable while running', 409);
          if (store.agent(id).pendingResult?.messageIds.includes(input.id))
            throw bad(
              'This message has a saved managed result. Set the agent idle to deliver it before acknowledgement.',
              409,
            );
          store.ack(id, input.id);
          return send(response, 200, { ok: true });
        }
        if (request.method === 'GET' && action === 'inbox') {
          selfOrUser(request, id);
          const wait = Number(parsed.searchParams.get('wait') || 0);
          if (!Number.isFinite(wait) || wait < 0 || wait > 25) throw bad('wait must be between 0 and 25 seconds');
          if (!store.inbox(id).length && wait > 0) {
            await new Promise((resolveWait) => {
              const finish = () => {
                clearTimeout(timer);
                store.off('change', check);
                response.off('close', finish);
                resolveWait();
              };
              const check = () => {
                if (store.inbox(id).length) finish();
              };
              const timer = setTimeout(finish, wait * 1000);
              store.on('change', check);
              response.on('close', finish);
            });
          }
          if (!response.destroyed) return send(response, 200, { messages: store.inbox(id) });
          return;
        }
      }
      if (request.method === 'GET' && !pathname.startsWith('/api/')) {
        const file = pathname === '/' ? 'index.html' : pathname.slice(1);
        if (file.includes('..') || !/^[a-zA-Z0-9_./-]+$/.test(file)) throw bad('Not found', 404);
        const vendors = {
          '/vendor/marked.js': join(root, 'node_modules/marked/lib/marked.esm.js'),
          '/vendor/purify.js': join(root, 'node_modules/dompurify/dist/purify.es.mjs'),
        };
        const full = vendors[pathname] || join(root, 'public', file);
        let contents;
        try {
          contents = await readFile(full);
        } catch {
          throw bad('Not found', 404);
        }
        const mime =
          { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[
            extname(file)
          ] || 'application/octet-stream';
        response.writeHead(200, {
          'Content-Type': `${mime}; charset=utf-8`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'",
        });
        response.end(contents);
        return;
      }
      throw bad('Not found', 404);
    } catch (error) {
      if (!response.headersSent) send(response, error.status || 500, { error: error.message });
      else response.destroy(error);
    }
  };
  // handle answers every error with a response, so its promise does not reject.
  const server = http.createServer((request, response) => void handle(request, response));
  const app = {
    server,
    store,
    chat,
    runner,
    tasks,
    waiting,
    activities,
    pricing,
    transcripts,
    state,
    dashboard,
    identity,
    sockets,
    signInUrl: `${url}/?token=${identity.token}`,
    async start() {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolveListen());
      });
      stopEventLoopMonitor = startEventLoopMonitor();
      await pricing.start();
      // Prices Codex sessions that are still unpriced, including those recorded before Mu priced Codex usage.
      runner.reprice({ fetchMissing: true });
      try {
        await chat.start();
      } catch (error) {
        if (requireIrc)
          throw Object.assign(
            new Error(
              `IRC unavailable at ${ircHost}:${ircPort}: ${error.message}. Mu exits so that launchd starts it again; start the broker with npm run chat:up.`,
              { cause: error },
            ),
            { expected: true },
          );
        console.error(`IRC unavailable: ${error.message}. Dashboard remains available; start IRC, then restart Mu.`);
        return url;
      }
      // A broker lost after the start is reconnected in this process. Exiting instead would make launchd start whatever
      // main holds then, without the start check.
      let reconnecting = false;
      const reconnect = async () => {
        reconnecting = true;
        console.error(
          `${new Date().toISOString()} ${chat.state.error || 'IRC disconnected'}. Reconnecting every ${reconnectDelayMs / 1000} seconds.`,
        );
        let lastError = null;
        while (!closing && !chat.state.connected) {
          await new Promise((resolveWait) => setTimeout(resolveWait, reconnectDelayMs).unref());
          if (closing) break;
          try {
            await chat.start();
          } catch (error) {
            if (error.message !== lastError)
              console.error(`${new Date().toISOString()} IRC reconnect failed: ${error.message}`);
            lastError = error.message;
          }
        }
        reconnecting = false;
        if (!closing && chat.state.connected) {
          console.log(`${new Date().toISOString()} IRC reconnected`);
          runner.kick();
        }
      };
      chat.on('change', () => {
        if (!chat.state.connected && !closing && !reconnecting) void reconnect();
      });
      runner.kick();
      // The record only words a notice, so an unreadable one is reported and removed instead of stopping the start.
      let record = null;
      try {
        record = await readRestartRecord(dataDir);
      } catch (error) {
        console.error(`${error.message}. It is removed; the restart notice is not posted.`);
        await removeRestartRecord(dataDir);
      }
      if (record) {
        await removeRestartRecord(dataDir);
        const mention = record.requestedBy === 'user' ? '@user' : `@${record.requestedBy}`;
        const text = `${mention} Mu restarted as requested at ${record.requestedAt}. It runs again as process ${process.pid}, started at ${startedAt}; the previous process was ${record.previous.pid}. Confirm it with the service command.`;
        if (record.conversationId && store.conversation(record.conversationId))
          await notify(record.conversationId, text);
        else console.log(text);
      }
      return url;
    },
    close() {
      return (closing ??= (async () => {
        stopEventLoopMonitor?.();
        stopEventLoopMonitor = null;
        // The rest of the shutdown still runs, so turns that were terminated are recorded as interrupted.
        let failure = null;
        try {
          runner.close();
        } catch (error) {
          failure = error;
        }
        pricing.close();
        dashboard.close();
        await new Promise((resolveClose) => server.close(resolveClose));
        await sockets.close();
        while (runner.active.size) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        await runner.repricing;
        chat.close();
        store.close();
        lock.release();
        if (failure) throw failure;
      })());
    },
    shutdown,
  };
  return app;
}

export async function loadConfig(filename, { required = false } = {}) {
  let raw;
  try {
    raw = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return {};
    throw error;
  }
  const config = object(JSON.parse(raw));
  if (config.pricing !== undefined) {
    const pricing = object(config.pricing);
    if (Object.keys(pricing).some((key) => key !== 'enabled'))
      throw new Error(
        `Invalid pricing: unknown keys ${Object.keys(pricing)
          .filter((key) => key !== 'enabled')
          .join(', ')}`,
      );
    if (pricing.enabled !== undefined && typeof pricing.enabled !== 'boolean')
      throw new Error('Invalid pricing.enabled: expected a boolean');
  }
  if (config.adapters !== undefined) {
    object(config.adapters);
    for (const [name, adapter] of Object.entries(config.adapters)) {
      object(adapter);
      if (
        !/^[a-z][a-z0-9-]*$/.test(name) ||
        ['codex', 'claude', 'pi', 'manual', 'demo'].includes(name) ||
        typeof adapter.command !== 'string' ||
        !adapter.command ||
        !Array.isArray(adapter.args) ||
        !adapter.args.every((arg) => typeof arg === 'string')
      )
        throw new Error(`Invalid custom adapter ${name}: expected {command: string, args: string[]}`);
    }
  }
  if (config.cliArgs !== undefined) {
    object(config.cliArgs);
    for (const [name, args] of Object.entries(config.cliArgs)) {
      if (
        !['codex', 'claude', 'pi'].includes(name) ||
        !Array.isArray(args) ||
        !args.every((arg) => typeof arg === 'string')
      )
        throw new Error(`Invalid cliArgs.${name}: expected an array of strings for codex, claude or pi`);
    }
  }
  if (config.roleCliArgs !== undefined) {
    for (const [role, byAdapter] of Object.entries(object(config.roleCliArgs))) {
      if (!['lead', 'worker'].includes(role))
        throw new Error(`Invalid roleCliArgs.${role}: the role must be lead or worker`);
      for (const [name, args] of Object.entries(object(byAdapter))) {
        if (
          !['codex', 'claude', 'pi'].includes(name) ||
          !Array.isArray(args) ||
          !args.every((arg) => typeof arg === 'string')
        )
          throw new Error(`Invalid roleCliArgs.${role}.${name}: expected an array of strings for codex, claude or pi`);
      }
    }
  }
  // Mu merges the lead's memory switch into the last --settings, so a value it cannot merge is refused at the start,
  // not at the lead's first turn.
  claudeLeadArgs([...(config.cliArgs?.claude || []), ...(config.roleCliArgs?.lead?.claude || [])]);
  if (config.piSandbox !== undefined) {
    const { localPorts = [], writableRoots = [], ...unknown } = object(config.piSandbox);
    if (Object.keys(unknown).length)
      throw new Error(`Invalid piSandbox: unknown keys ${Object.keys(unknown).join(', ')}`);
    if (!Array.isArray(localPorts) || !localPorts.every((port) => Number.isInteger(port) && port > 0 && port < 65536))
      throw new Error('Invalid piSandbox.localPorts: expected an array of TCP port numbers');
    if (!Array.isArray(writableRoots) || !writableRoots.every((path) => typeof path === 'string' && isAbsolute(path)))
      throw new Error('Invalid piSandbox.writableRoots: expected an array of absolute paths');
  }
  if (config.codexSandbox !== undefined) {
    const { writableRoots = [], ...unknown } = object(config.codexSandbox);
    if (Object.keys(unknown).length)
      throw new Error(`Invalid codexSandbox: unknown keys ${Object.keys(unknown).join(', ')}`);
    if (!Array.isArray(writableRoots) || !writableRoots.every((path) => typeof path === 'string' && isAbsolute(path)))
      throw new Error('Invalid codexSandbox.writableRoots: expected an array of absolute paths');
  }
  return config;
}

/** @param {{pricing?: {enabled?: boolean}}} config */
export function pricingEnabledFromConfig(config) {
  return config.pricing?.enabled !== false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app;
  try {
    const home = resolveHome(process.env);
    const leftover = await leftoverError({ root: ROOT, env: process.env, home });
    if (leftover) throw Object.assign(new Error(leftover), { expected: true });
    const configFile = resolveConfigFile(process.env, home);
    const config = await loadConfig(configFile, { required: process.env.MU_CONFIG !== undefined });
    const launchd = launchdJob();
    app = await createApp({
      launchd,
      home,
      configFile,
      requireIrc: process.env.MU_REQUIRE_IRC === '1',
      port: Number(process.env.MU_PORT || 4310),
      dataDir: resolveDataDir(process.env, home),
      ircHost: process.env.MU_IRC_HOST || '127.0.0.1',
      ircPort: Number(process.env.MU_IRC_PORT || 6667),
      channel: process.env.MU_IRC_CHANNEL || '#mu',
      custom: config.adapters || {},
      pricingEnabled: pricingEnabledFromConfig(config),
      cliArgs: config.cliArgs || {},
      roleCliArgs: config.roleCliArgs || {},
      piSandbox: config.piSandbox || {},
      codexSandbox: config.codexSandbox || {},
    });
    const url = await app.start();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => app.shutdown(0));
    // Readiness is announced only after a signal can trigger the clean shutdown.
    // A launchd job's output goes to a log file, which must not hold the user credential.
    console.log(
      `Mu dashboard: ${url}\n${launchd ? `Running as launchd job ${launchd.label}. Print the sign-in link with: node src/cli.mjs dashboard` : `Sign in this browser once with: ${app.signInUrl}`}`,
    );
  } catch (error) {
    // launchd repeats an expected failure every ThrottleInterval, so it gets one dated line instead of a stack.
    console.error(error.expected ? `${new Date().toISOString()} ${error.message}` : error);
    if (app) await app.close().catch((closeError) => console.error(closeError));
    process.exit(1);
  }
}
