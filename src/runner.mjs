import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { NO_REPLY, commandFor, emptyTurn, foldTurn, muCommand, turnReply } from './adapters.mjs';
import { MAX_MESSAGE_BYTES } from './chat.mjs';
import { memoryPrompt, readLeadMemoryIndex } from './memory.mjs';
import { mentions } from './store.mjs';
import { CodexRollouts } from './codex-rollout.mjs';
import { codexAccess, privateUserPaths } from './sandbox.mjs';
import { LAUNCHD_VARIABLES, withoutVariables } from './service.mjs';

const LIVE_USAGE_INTERVAL_MS = 5000;
// A text adapter's whole stdout is its reply, which chat caps at 64 KiB anyway.
const MAX_TEXT_OUTPUT_BYTES = 4 * 1024 * 1024;
// A JSON adapter's output is unbounded, because Mu folds it event by event; only one unfinished event line
// is held at a time. The largest real lines carry a whole tool result, such as a screenshot or a PDF in base64, or,
// for pi, every message of the run in agent_end. The bound stops a process that writes without newlines.
const MAX_EVENT_LINE_BYTES = 64 * 1024 * 1024;
const mebibytes = (bytes) => `${bytes / 1024 / 1024} MiB`;
const KILL_DELAY_MS = 2000;
// A failure notice must fit in one chat message; the agent's last error keeps the full text.
const MAX_NOTICE_DIAGNOSTIC_CHARS = 4000;
// A turn takes every queued message of one conversation up to this much text, and always at least one message.
const MAX_BATCH_BYTES = 4 * MAX_MESSAGE_BYTES;
// From this size on a worker's turn prompt names the size of its session: every model call re-reads the whole session,
// and two workers that took follow-ups at 300k–730k tokens cost $124 in one day (2026-11-10). The worker skill says what
// to do; the lead compacts by its own configuration, so it gets no notice.
const LARGE_CONTEXT_TOKENS = 300000;
const MAX_LEAD_TASK_REMINDERS = 20;
const MAX_CARRIED_DIRECT_MESSAGES = 20;
const MAX_CARRIED_DIRECT_MESSAGE_CHARS = 400;

/** @typedef {{tasks: Array<{id: string, title: string, status: string, agentIds: string[]}>, waiting: Array<{taskId: string|null}>}} LeadTaskContext */

const describeMessages = (ids) =>
  ids.length === 1 ? `message #${ids[0]}` : `messages ${ids.map((id) => '#' + id).join(', ')}`;
const senderName = (from) => (from === 'user' ? 'the user (@user)' : '@' + from);
const QUIET_WORKER_STATUSES = new Set(['idle', 'done', 'stopped']);

function quietActiveTasks(context, agents) {
  const statuses = new Map(agents.map((agent) => [agent.id, agent.status]));
  const waitingTasks = new Set(context.waiting.map((card) => card.taskId).filter(Boolean));
  const eligibleTasks = context.tasks.filter(
    (task) =>
      task.status === 'active' &&
      !waitingTasks.has(task.id) &&
      task.agentIds.every((id) => QUIET_WORKER_STATUSES.has(statuses.get(id))),
  );
  if (!eligibleTasks.length) return '';
  const tasks = eligibleTasks.slice(0, MAX_LEAD_TASK_REMINDERS);
  const omitted = eligibleTasks.length - tasks.length;
  const listing = tasks.map((task) => `${task.id} — ${task.title.replace(/\s+/g, ' ').trim()}`).join('\n');
  const omittedNote = omitted
    ? `\n${omitted} more active tasks meet this condition. Use the Mu CLI task list command to inspect them.`
    : '';
  return `Active tasks with no waiting card whose workers are all idle, done or stopped:\n${listing}${omittedNote}\nReview these task records and update them if the work is complete.\n`;
}

function shortenDirectMessage(text) {
  const plain = text.replace(/\s+/g, ' ').trim();
  const characters = Array.from(plain);
  return characters.length > MAX_CARRIED_DIRECT_MESSAGE_CHARS
    ? `${characters.slice(0, MAX_CARRIED_DIRECT_MESSAGE_CHARS - 1).join('')}…`
    : plain;
}

export function sessionFor(agent, conversationId) {
  return agent.sessionIds?.[conversationId] || null;
}

export class Runner {
  constructor({
    store,
    chat,
    root,
    home,
    url,
    identity,
    sockets = null,
    custom = {},
    cliArgs = {},
    roleCliArgs = {},
    codexRollouts = new CodexRollouts(),
    pricing = null,
    dataDir = null,
    piSandbox = /** @type {import('./sandbox.mjs').PiSandbox} */ ({}),
    codexSandbox = /** @type {import('./sandbox.mjs').CodexSandbox} */ ({}),
    privatePaths = null,
    leadTaskContext = () => ({ tasks: [], waiting: [] }),
  }) {
    if (!identity) throw new Error('The runner needs the identity service that issues turn credentials');
    if (!home) throw new Error('The runner needs the initialized Mu home');
    this.store = store;
    this.chat = chat;
    this.root = root;
    this.home = home;
    this.url = url;
    this.identity = identity;
    this.sockets = sockets;
    this.custom = custom;
    this.cliArgs = cliArgs;
    this.roleCliArgs = roleCliArgs;
    this.codexRollouts = codexRollouts;
    this.pricing = pricing;
    this.dataDir = dataDir;
    this.piSandbox = piSandbox;
    this.codexSandbox = codexSandbox;
    // Tests pass their own list; without one, each sandboxed turn resolves the real list.
    this.privatePathsGiven = privatePaths;
    /** @type {() => LeadTaskContext} */
    this.leadTaskContext = leadTaskContext;
    this.active = new Map();
    this.closed = false;
    // A scheduled restart pauses new turns: one started now would only be interrupted.
    this.paused = false;
    this.repricing = null;
    pricing?.on('update', () => this.reprice());
  }
  // Role arguments come after the adapter-wide ones, so they can override them.
  cliArgsFor(agent) {
    const extra = this.roleCliArgs[agent.role]?.[agent.adapter];
    return extra
      ? { ...this.cliArgs, [agent.adapter]: [...(this.cliArgs[agent.adapter] || []), ...extra] }
      : this.cliArgs;
  }

  get privatePaths() {
    return this.privatePathsGiven ?? privateUserPaths();
  }
  codexOptions(agent, credentialFile) {
    const dataDir = realpathSync(this.identity.dataDir),
      privatePaths = this.privatePaths;
    return {
      dataDir,
      credentialFile: realpathSync(credentialFile),
      privatePaths,
      ...codexAccess({
        cwd: agent.cwd,
        dataDir,
        home: this.home,
        role: agent.role,
        privatePaths,
        writableRoots: this.codexSandbox.writableRoots || [],
      }),
    };
  }

  kick() {
    if (this.closed || this.paused || !this.chat.state.connected) return;
    for (const agent of this.store.agents()) {
      if (agent.adapter === 'manual' || ['error', 'stopped'].includes(agent.status) || this.active.has(agent.id))
        continue;
      const batch = this.batch(agent);
      if (batch.length) {
        const entry = { child: null, stopped: false, conversationId: batch[0].conversationId || 'common' };
        this.active.set(agent.id, entry);
        // Settles once the turn has ended: its reply is posted and its messages acknowledged, or its failure recorded.
        entry.done = this.turn(agent, batch, entry)
          .catch((error) => this.failed(agent, batch, entry, error))
          .finally(() => {
            if (entry.shutdown) this.markInterrupted(agent.id);
            this.active.delete(agent.id);
            // The dashboard shows the process ID of a running turn, which lives here and not in the agent's record.
            this.store.changed(['agents', agent.id]);
            this.kick();
          });
      }
    }
  }
  // The messages of the agent's next turn: the oldest pending message and the pending messages of its conversation
  // that follow it, in order. A saved result covers exactly the messages of the turn that produced it.
  batch(agent) {
    const inbox = this.store.inbox(agent.id);
    if (!inbox.length) return [];
    const conversationId = inbox[0].conversationId || 'common';
    const queued = inbox.filter((message) => (message.conversationId || 'common') === conversationId);
    if (agent.pendingResult) return queued.slice(0, agent.pendingResult.messageIds.length);
    const batch = [];
    let bytes = 0;
    for (const message of queued) {
      bytes += Buffer.byteLength(message.text);
      if (batch.length && bytes > MAX_BATCH_BYTES) break;
      batch.push(message);
    }
    return batch;
  }
  async turn(agent, batch, entry) {
    // The newest message stands for the turn in MU_MESSAGE_ID and activeMessageId.
    const message = batch.at(-1);
    const ids = batch.map((item) => item.id);
    const interrupted = ids.filter((id) => id <= agent.interruptedMessageId);
    const resumedAfterShutdown = ids.includes(agent.interruptedMessageId);
    this.store.updateAgent(agent.id, {
      status: 'working',
      activeMessageId: message.id,
      interruptedMessageId: null,
      lastError: null,
    });
    const conversationId = message.conversationId || 'common';
    const conversation = this.store.conversation(conversationId);
    if (!conversation) throw new Error(`Unknown conversation ${conversationId}`);
    if (agent.pendingResult) {
      if (agent.pendingResult.conversationId !== conversationId || agent.pendingResult.messageIds.join() !== ids.join())
        throw new Error(
          'Saved result does not match the next inbox messages; inspect the saved result before resuming.',
        );
      return this.deliver(agent, agent.pendingResult);
    }
    agent = { ...agent, sessionId: sessionFor(agent, conversationId) };
    const skillName = agent.role === 'lead' ? 'team-lead' : 'worker';
    const skillPath = join(this.home, 'skills', skillName, 'SKILL.md');
    const skillText = await readFile(skillPath, 'utf8');
    const skillHash = createHash('sha256').update(skillText).digest('hex');
    await this.noticeRoleFileChange(skillName, skillPath, skillHash);
    // A resumed session keeps the skill text from an earlier turn, so repeating it on every turn only grows the context.
    const delivered = agent.skillDelivered?.[conversationId];
    const skillKnown = Boolean(
      agent.sessionId && delivered?.sessionId === agent.sessionId && delivered.hash === skillHash,
    );
    const contextBefore =
      agent.usage?.[conversationId]?.sessionId === agent.sessionId
        ? (agent.usage[conversationId].contextTokens ?? null)
        : null;
    // Only the lead has a memory. It is read on every turn, so an edit by the user or by another session applies at once.
    const memory = agent.role === 'lead' ? await readLeadMemoryIndex(this.home) : null;
    const memoryDelivered = agent.memoryDelivered?.[conversationId];
    const memoryKnown = Boolean(
      memory &&
      agent.sessionId &&
      memoryDelivered?.sessionId === agent.sessionId &&
      memoryDelivered.hash === memory.hash,
    );
    const largeContext =
      agent.role !== 'lead' && contextBefore !== null && contextBefore >= LARGE_CONTEXT_TOKENS
        ? `Your session for this conversation holds about ${Math.round(contextBefore / 1000)}k tokens, and every model call re-reads all of it. Before you start a new phase of work in it, apply the large-context rule of your skill.\n`
        : '';
    const taskReminder = agent.role === 'lead' ? quietActiveTasks(this.leadTaskContext(), this.store.agents()) : '';
    const skill = skillKnown
      ? `Your ${skillName} skill is unchanged since an earlier turn of this session gave you its full text; keep following it. If that text is no longer in your context, read ${skillPath}.\n`
      : skillText;
    const assignment =
      agent.conversationId === conversationId
        ? agent.task || '(assigned in chat)'
        : '(use this conversation; run task list for its task records)';
    // Each turn gets a fresh credential, revoked when the turn's process exits. pi reaches Mu only through its own socket.
    const socket = agent.adapter === 'pi' ? await this.agentSocket(agent.id) : null;
    const access = {
      url: socket ? `unix:${socket}` : this.url,
      ...this.identity.issueFile(agent.id, { socket: Boolean(socket) }),
    };
    const directChatContext =
      agent.role === 'lead' && conversationId === 'dm-lead' ? this.directChatContext(agent, batch) : null;
    const memoryText = memory ? memoryPrompt(memory, { known: memoryKnown }) : '';
    const prompt = `${skill}\n${memoryText}${agent.sessionId ? 'Continue your existing session for this conversation.\n' : 'This is a new session for this conversation.\n'}${largeContext}${taskReminder}${directChatContext?.text || ''}Mu's projects and local clones are listed in ${join(this.home, 'projects.md')}.\n${resumedAfterShutdown ? `The Mu service shut down while you were handling ${describeMessages(interrupted)} and terminated that turn before it finished. Inspect the state of the work you had started, such as files, branches, processes, and messages already posted, then complete the request without repeating effects that already happened.\n` : ''}\nYour identity: @${agent.id}; role: ${agent.role}. Workspace: ${agent.cwd}. Task: ${assignment}.\nConversation: ${conversationId} (${conversation.kind}, ${conversation.name}). Members: ${conversation.members.map((id) => '@' + id).join(', ')}.${conversation.sourceConversationId ? ` The request originated in ${conversation.sourceConversationId}; the lead should send the user a final summary there using Mu chat.` : ''}\nMu CLI: ${join(this.root, 'src/cli.mjs')}. Service: ${access.url}. Environment MU_CLI, MU_AGENT_ID, MU_LEAD_ID, MU_URL, MU_TOKEN_FILE and MU_CONVERSATION_ID are available; the file named by MU_TOKEN_FILE holds your credential for this turn, and Mu accepts nothing you send as another identity.\nThis managed runner delivers the queued chat messages of this conversation together in one turn, oldest first, and acknowledges them after you finish; answer them in one final reply, and do not call inbox or ack yourself. All communication, assignments and follow-ups must use Mu chat. Your final reply is automatically posted to ${conversationId}; do not duplicate it with a say command. Keep it focused, but retain necessary evidence. The transport accepts up to ${MAX_MESSAGE_BYTES} UTF-8 bytes per message. The user has identity @user. In a direct conversation, reply to the user; do not move private content to a task room or common chat. Do not reply merely to acknowledge another agent's acknowledgement: return exactly NO_REPLY when no response is needed.\n${batch.length > 1 ? `${batch.length} chat messages are queued for you in this conversation, oldest first.\n\n` : ''}${batch.map((item) => `Incoming chat message #${item.id} from ${senderName(item.from)}:\n${item.text}`).join('\n\n')}`;
    let result, command;
    try {
      command = commandFor(agent, this.root, this.custom, this.cliArgsFor(agent), {
        pi:
          agent.adapter === 'pi'
            ? {
                dataDir: this.dataDir,
                home: this.home,
                localPorts: this.piSandbox.localPorts || [],
                writableRoots: this.piSandbox.writableRoots || [],
                socket,
                credentialFile: access.file,
                privatePaths: this.privatePaths,
              }
            : undefined,
        codex: agent.adapter === 'codex' ? this.codexOptions(agent, access.file) : undefined,
      });
      command = { ...command, env: { ...command.env, MU_URL: access.url, MU_TOKEN_FILE: access.file } };
      result = await this.execute(
        command,
        agent,
        message,
        `${prompt}\nUse this literal Mu command for every coordination tool call: ${muCommand(this.root)}. Append the subcommand and arguments. Use this concrete path instead of shell variables so the native CLI permission rule can match it. Run each Mu command as a standalone shell tool call. Do not combine it with other commands using semicolons, pipes, &&, or ||; the native permission rule applies to the whole tool call.`,
        entry,
      );
    } finally {
      this.identity.revoke(access.token);
    }
    if (entry.stopped) return;
    let usage = result.usage ?? null;
    // Codex exec output omits the model, current context and per-call tokens, which its session log records.
    if (command.format === 'codex' && usage?.sessionId) {
      let rollout;
      try {
        rollout = await this.codexRollouts.read(usage.sessionId);
      } catch (error) {
        usage = {
          ...usage,
          usageError: `Codex session log unavailable: ${error.message}`,
          costUsd: null,
          costPending: false,
          costError: `Codex session log unavailable: ${error.message}`,
        };
      }
      if (rollout) {
        const { calls, ...facts } = rollout;
        usage = { ...usage, ...facts, ...this.priceCodex(calls) };
      }
    }
    let parsed;
    try {
      parsed = turnReply(command.format, result);
    } finally {
      if (usage) this.recordUsage(agent.id, agent.adapter, conversationId, usage, { final: true });
    }
    if (parsed.sessionId) this.recordSession(agent.id, conversationId, parsed.sessionId);
    this.recordSkillDelivery(agent.id, conversationId, {
      sessionId: parsed.sessionId,
      hash: skillHash,
      memoryHash: memory ? await this.memoryHashAfterTurn(agent.id) : undefined,
      contextBefore,
      contextAfter: usage?.contextTokens ?? null,
    });
    let reply = parsed.text;
    // An unaddressed reply reaches every recipient that a reply to each of the turn's messages alone would reach.
    const routed =
      reply === NO_REPLY
        ? []
        : [...new Set(batch.map((item) => this.routeReply(agent, item, conversation, reply)).filter(Boolean))];
    if (routed.length) reply = `${routed.map((id) => '@' + id).join(' ')}\n\n${reply}`;
    const taskStatus = this.store.agent(agent.id).status;
    const pendingResult = {
      messageIds: ids,
      conversationId,
      text: reply,
      autoRouted: routed.length > 0,
      sessionId: parsed.sessionId,
      status: taskStatus === 'working' ? 'idle' : taskStatus,
      completedAt: new Date().toISOString(),
      ...(directChatContext && {
        leadDirectChatCursor: directChatContext.cursor,
        leadDirectChatOwnMessageIds: directChatContext.ownMessageIds,
      }),
    };
    this.store.updateAgent(agent.id, { pendingResult });
    await this.deliver(agent, pendingResult);
  }
  // The index as the turn left it. Mu runs one turn per identity at a time, so a change during the lead's turn is its own,
  // and its session already holds it; only the lead's other sessions need it. A defect that appeared during the turn
  // must not discard the reply of work that is done: the turn records no delivery, and the next turn's read fails with
  // the same diagnosis before it starts.
  async memoryHashAfterTurn(id) {
    try {
      return (await readLeadMemoryIndex(this.home)).hash;
    } catch (error) {
      console.error(
        `@${id}'s memory index is unreadable after its turn; its next turn will fail on it: ${error.message}`,
      );
      return null;
    }
  }
  // A role file is a prompt for every agent of its role, including unsandboxed ones, so each change gets one notice
  // for the user: a planted change and a forgotten init both show up. It mentions no agent, so it wakes none.
  // A notice that cannot be posted gives the record back, so that the next turn tries again.
  async noticeRoleFileChange(skillName, skillPath, hash) {
    const { changed, previous } = this.store.observeRoleFile(skillName, hash);
    if (!changed) return;
    let notice;
    try {
      const { mtime } = await stat(skillPath);
      notice = `@user Mu runtime: the ${skillName} role file ${skillPath} changed; it was last modified at ${mtime.toISOString()}. Agents with that role follow the new text from their next turn. If neither you nor init changed it, inspect the file.`;
      await this.chat.send('system', notice, 'common');
    } catch (error) {
      this.store.restoreRoleFile(skillName, hash, previous);
      if (notice === undefined) throw error;
      console.error(
        `Could not post the role file notice in common; the next turn tries again: ${error.message}\n${notice}`,
      );
    }
  }
  directChatContext(agent, batch) {
    const ownMessageIds = new Set(agent.leadDirectChatOwnMessageIds || []);
    const highWater = this.store.messages(1, 'dm-lead').at(-1)?.id ?? 0;
    const cursor =
      agent.leadDirectChatCursor ??
      this.store
        .messages(300, 'dm-lead', batch[0].id)
        .filter((message) => message.from === 'user')
        .at(-1)?.id ??
      0;
    const latest = this.store.messagesFromAfter(
      'dm-lead',
      'lead',
      cursor,
      MAX_CARRIED_DIRECT_MESSAGES + ownMessageIds.size + 1,
    );
    const newMessages = latest.filter((message) => message.id <= highWater && !ownMessageIds.has(message.id));
    const messages = newMessages.slice(-MAX_CARRIED_DIRECT_MESSAGES);
    const omitted = newMessages.length > MAX_CARRIED_DIRECT_MESSAGES;
    const text = messages.length
      ? `Messages from your other sessions posted in this direct chat since your last turn (shortened):\n${messages
          .map((message) => `#${message.id}: ${shortenDirectMessage(message.text)}`)
          .join('\n')}${omitted ? '\nSome earlier messages may be omitted.' : ''}\n`
      : '';
    return {
      text,
      cursor: highWater,
      ownMessageIds: (agent.leadDirectChatOwnMessageIds || []).filter((id) => id > highWater),
    };
  }
  // Returns the agent that an unaddressed final reply must reach, or null when the reply already addresses someone.
  // The requester is the agent whose message started the turn; a turn that covers several messages asks once per message. A reply that mentions no other member or `@all` goes to it; a reply that does is the agent's
  // own routing choice, such as a reviewer sending findings to the implementer instead of the lead whose message started its turn. A request from the user keeps
  // the fallback, which sends a worker's report to the lead. A reply to a message that was itself routed automatically goes to the fallback recipient instead,
  // so two agents cannot answer each other indefinitely. A stopped agent never runs a turn, so a mention of one addresses nobody, and a stopped requester or lead is skipped for the next live recipient; otherwise the report is lost.
  routeReply(agent, message, conversation, reply) {
    const mentioned = mentions(reply).filter((id) => this.store.agent(id)?.status !== 'stopped');
    const fallback =
      agent.role !== 'lead' && conversation.members.includes('lead') && this.store.agent('lead')?.status !== 'stopped'
        ? 'lead'
        : 'user';
    const requester = message.from;
    const requesterStopped = this.store.agent(requester)?.status === 'stopped';
    const requesterIsMember =
      requester !== agent.id &&
      Boolean(this.store.agent(requester)) &&
      !requesterStopped &&
      conversation.members.includes(requester);
    const addressesMember = mentioned.some(
      (id) => id === 'all' || (id !== agent.id && conversation.members.includes(id)),
    );
    if (requesterIsMember && !message.autoRouted) return addressesMember ? null : requester;
    // A stopped requester is skipped, so the reply must address a live member to keep its own routing; any other mention would swallow the report.
    return (requesterStopped ? addressesMember : mentioned.length) ? null : fallback;
  }
  async deliver(agent, result) {
    if (Buffer.byteLength(result.text) > MAX_MESSAGE_BYTES)
      throw new Error(
        `Agent response exceeds the ${MAX_MESSAGE_BYTES}-byte chat limit. The full response is retained in pendingResult; the turn's messages remain unacknowledged.`,
      );
    const sent =
      result.text !== NO_REPLY
        ? await this.chat.send(agent.id, result.text, result.conversationId, { autoRouted: Boolean(result.autoRouted) })
        : null;
    // A posted reply is acknowledged even when a stop or shutdown arrived during the send, so that resuming does not post it again;
    // a stopped agent keeps its status.
    const latest = this.store.agent(agent.id);
    const patch = {
      status: latest.status === 'working' ? result.status || 'idle' : latest.status,
      activeMessageId: null,
      pendingResult: null,
      lastError: null,
    };
    if (Object.hasOwn(result, 'leadDirectChatCursor')) {
      patch.leadDirectChatCursor = result.leadDirectChatCursor;
      patch.leadDirectChatOwnMessageIds = [
        ...result.leadDirectChatOwnMessageIds,
        ...(sent?.conversationId === 'dm-lead' && sent.from === 'lead' && Number.isSafeInteger(sent.id)
          ? [sent.id]
          : []),
      ];
    }
    this.store.completeTurn(agent.id, result.messageIds, patch);
  }
  recordSession(id, conversationId, sessionId) {
    const agent = this.store.agent(id);
    const sessionIds = agent.sessionIds || {};
    if (sessionIds[conversationId] !== sessionId || agent.sessionId !== sessionId)
      this.store.updateAgent(id, { sessionId, sessionIds: { ...sessionIds, [conversationId]: sessionId } });
  }
  // The skill and the lead's memory index count as delivered only while the CLI reports its context size and that size
  // never shrinks: a smaller context means the CLI compacted the session and may have dropped the earlier text.
  // memoryHash is undefined for a role without memory, and null when the index could not be read after the turn.
  recordSkillDelivery(id, conversationId, { sessionId, hash, memoryHash, contextBefore, contextAfter }) {
    const agent = this.store.agent(id);
    const compacted = contextBefore !== null && contextAfter !== null && contextAfter < contextBefore;
    const delivered = Boolean(sessionId) && contextAfter !== null && !compacted;
    const record = (previous, value) => {
      const next = { ...previous };
      if (delivered && value) next[conversationId] = { sessionId, hash: value };
      else delete next[conversationId];
      return next;
    };
    this.store.updateAgent(id, {
      skillDelivered: record(agent.skillDelivered, hash),
      ...(memoryHash !== undefined && { memoryDelivered: record(agent.memoryDelivered, memoryHash) }),
    });
  }
  recordUsage(id, adapter, conversationId, usage, { final }) {
    if (!usage.sessionId) return;
    const agent = this.store.agent(id);
    const previous = agent.usage?.[conversationId];
    const current = previous?.sessionId === usage.sessionId ? previous : {};
    const sessions = { ...previous?.sessions };
    // Claude Code reports a cumulative cost for a resumed session, so the latest value replaces the earlier one.
    // Mu prices a Codex session from its whole rollout after every turn, so that result replaces the entry outright.
    // pi reports each turn's spend separately, so a resumed session adds it to the earlier turns.
    const previousSession = sessions[usage.sessionId];
    if (final && adapter === 'pi')
      sessions[usage.sessionId] = {
        adapter,
        costUsd:
          usage.costUsd === null || previousSession?.costUsd === null
            ? null
            : (previousSession?.costUsd || 0) + usage.costUsd,
        totalTokens: (previousSession?.totalTokens || 0) + (usage.totalTokens || 0),
      };
    else if (final)
      sessions[usage.sessionId] =
        adapter === 'codex'
          ? {
              adapter,
              costUsd: usage.costUsd ?? null,
              costError: usage.costError ?? null,
              costPending: usage.costPending ?? false,
              pricesFetchedAt: usage.pricesFetchedAt ?? null,
              totalTokens: usage.totalTokens ?? sessions[usage.sessionId]?.totalTokens ?? null,
            }
          : {
              adapter,
              costUsd: usage.costUsd ?? sessions[usage.sessionId]?.costUsd ?? null,
              totalTokens: usage.totalTokens ?? sessions[usage.sessionId]?.totalTokens ?? null,
            };
    const next = {
      adapter,
      sessionId: usage.sessionId,
      model: usage.model ?? current.model ?? null,
      contextTokens: usage.contextTokens ?? current.contextTokens ?? null,
      contextWindow: usage.contextWindow ?? current.contextWindow ?? null,
      usageError: usage.usageError ?? null,
      sessions,
      updatedAt: new Date().toISOString(),
    };
    this.store.updateAgent(id, { usage: { ...agent.usage, [conversationId]: next } });
  }
  priceCodex(calls, options) {
    if (!this.pricing) throw new Error('Mu was started without a price catalog');
    return this.pricing.price(calls, options);
  }
  // Prices Codex sessions without a cost again from their rollouts: on start, and after each price fetch attempt.
  // Repricing after a fetch does not fetch again, so a model that LiteLLM never lists cannot cause a fetch loop.
  // An entry changed by a finishing turn meanwhile is newer, so it is left alone.
  reprice({ fetchMissing = false } = {}) {
    this.repriceFetchMissing ||= fetchMissing;
    if (this.repricing) {
      this.repriceAgain = true;
      return this.repricing;
    }
    this.repricing = (async () => {
      do {
        if (this.closed) return;
        const options = { fetchMissing: this.repriceFetchMissing };
        this.repriceAgain = false;
        this.repriceFetchMissing = false;
        const unpriced = this.store.agents().flatMap((agent) =>
          Object.entries(agent.usage ?? {}).flatMap(([conversationId, usage]) =>
            Object.entries(usage.sessions ?? {})
              .filter(([, session]) => session.adapter === 'codex' && session.costUsd === null)
              .map(([sessionId, session]) => ({ id: agent.id, conversationId, sessionId, session })),
          ),
        );
        for (const { id, conversationId, sessionId, session } of unpriced) {
          if (this.closed) return;
          let rollout, cost;
          try {
            rollout = await this.codexRollouts.read(sessionId);
          } catch (error) {
            cost = {
              costUsd: null,
              costPending: false,
              costError: `Codex session log unavailable: ${error.message}`,
              pricesFetchedAt: null,
            };
          }
          if (rollout) cost = this.priceCodex(rollout.calls, options);
          const agent = this.store.agent(id);
          const usage = agent?.usage?.[conversationId];
          if (JSON.stringify(usage?.sessions?.[sessionId]) !== JSON.stringify(session)) continue;
          this.store.updateAgent(id, {
            usage: {
              ...agent.usage,
              [conversationId]: { ...usage, sessions: { ...usage.sessions, [sessionId]: { ...session, ...cost } } },
            },
          });
        }
      } while (this.repriceAgain);
    })()
      .catch((error) => console.error(`Repricing Codex sessions failed: ${error.message}`))
      .finally(() => {
        this.repricing = null;
      });
    return this.repricing;
  }
  async failed(agent, batch, entry, error) {
    if (entry.stopped) return;
    this.store.updateAgent(agent.id, { status: 'error', activeMessageId: null, lastError: error.message });
    const conversationId = batch[0].conversationId || 'common';
    const conversation = this.store.conversation(conversationId);
    const recipients = ['user'];
    if (agent.id !== 'lead' && conversation?.members.includes('lead')) recipients.unshift('lead');
    for (const { from } of batch)
      if (from !== agent.id && conversation?.members.includes(from) && !recipients.includes(from))
        recipients.push(from);
    // Whole code points, so that the cut cannot leave half of a surrogate pair.
    const characters = Array.from(error.message);
    const shown =
      characters.length > MAX_NOTICE_DIAGNOSTIC_CHARS
        ? `${characters.slice(0, MAX_NOTICE_DIAGNOSTIC_CHARS).join('')}… (cut to ${MAX_NOTICE_DIAGNOSTIC_CHARS} characters; the agent's last error has the full text)`
        : error.message;
    const diagnostic = shown.replaceAll('@', '＠');
    const notice = `${recipients.map((id) => '@' + id).join(' ')} Mu runtime: agent ${agent.id} could not complete ${describeMessages(batch.map((item) => item.id))}: ${diagnostic}\n${batch.length === 1 ? 'The message remains' : 'The messages remain'} pending; no automatic retry was started.${this.store.agent(agent.id).pendingResult ? ' Its completed response is saved; explicitly resuming delivers that response without running the task again.' : ''}`;
    try {
      await this.chat.send('system', notice, conversationId);
    } catch (notificationError) {
      this.store.updateAgent(agent.id, {
        lastError: `${error.message}\nCould not post the failure notice in ${conversationId}: ${notificationError.message}`,
      });
    }
  }
  agentSocket(id) {
    if (!this.sockets) throw new Error('A pi agent needs the Mu socket service; start it through createApp');
    return this.sockets.ensure(id);
  }
  execute(command, agent, message, prompt, entry) {
    return new Promise((resolve, reject) => {
      if (entry.stopped) return resolve(null);
      // Any sandboxed process can read another process's environment, so it carries no credential and
      // no prompt; only custom adapters, which may not read stdin, also get the prompt there.
      // Claude Code's cross-session messaging takes user messages from anyone who reads its socket and
      // token from a process environment, so it is off, and a messaging socket the service inherited is not passed on.
      // The launchd job's variables stay with the service, so that a Mu instance a turn starts is not taken for the job.
      const {
        MU_TOKEN: _token,
        MU_TOKEN_FILE: _tokenFile,
        CLAUDE_CODE_MESSAGING_SOCKET: _socket,
        CLAUDE_CODE_MESSAGING_TOKEN: _messagingToken,
        ...inherited
      } = withoutVariables(process.env, LAUNCHD_VARIABLES);
      const child = spawn(command.command, command.args, {
        cwd: agent.cwd,
        detached: true,
        env: {
          ...inherited,
          CLAUDE_CODE_HARBOR_KITE: '0',
          MU_URL: this.url,
          MU_AGENT_ID: agent.id,
          MU_LEAD_ID: 'lead',
          MU_ROLE: agent.role,
          MU_CLI: join(this.root, 'src/cli.mjs'),
          MU_SESSION_ID: agent.sessionId || '',
          MU_MESSAGE_ID: String(message.id),
          MU_CONVERSATION_ID: message.conversationId || 'common',
          ...(this.custom[agent.adapter] ? { MU_PROMPT: prompt } : {}),
          ...command.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      entry.child = child;
      this.store.changed(['agents', agent.id]);
      let stdout = '',
        stdoutBytes = 0,
        stdoutTail = '',
        stderr = '',
        failure = null,
        line = '',
        lineBytes = 0,
        turn = emptyTurn();
      // A running process is terminated on failure; once it has exited, its process group ID may belong to another process.
      const fail = (error) => {
        if (failure) return;
        failure = error;
        this.terminate(entry);
      };
      const handle = (text, report = fail) => {
        if (!text.trim()) return;
        let event;
        try {
          event = JSON.parse(text);
        } catch (error) {
          return report(new Error(`Invalid ${command.format} event: ${error.message}`));
        }
        try {
          const sessionBefore = turn.sessionId;
          turn = foldTurn(command.format, turn, event);
          if (turn.sessionId && turn.sessionId !== sessionBefore)
            this.recordSession(agent.id, message.conversationId || 'common', turn.sessionId);
          if (
            command.format === 'claude' &&
            event.type === 'assistant' &&
            !event.parent_tool_use_id &&
            Date.now() - (entry.usageRecordedAt || 0) >= LIVE_USAGE_INTERVAL_MS
          ) {
            entry.usageRecordedAt = Date.now();
            this.recordUsage(agent.id, agent.adapter, message.conversationId || 'common', turn.usage, { final: false });
          }
        } catch (error) {
          report(new Error(`Could not record ${command.format} session state: ${error.message}`));
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (data) => {
        stdoutTail = (stdoutTail + data).slice(-1000);
        // The process is being terminated; holding more of its output would only let it grow memory.
        if (failure) return;
        if (command.format === 'text') {
          stdout += data;
          stdoutBytes += Buffer.byteLength(data);
          if (stdoutBytes > MAX_TEXT_OUTPUT_BYTES)
            fail(
              new Error(
                `Agent output exceeded the ${mebibytes(MAX_TEXT_OUTPUT_BYTES)} limit for a text adapter's reply`,
              ),
            );
          return;
        }
        let start = 0;
        for (let end = data.indexOf('\n'); end !== -1; start = end + 1, end = data.indexOf('\n', start)) {
          handle(line + data.slice(start, end));
          line = '';
          lineBytes = 0;
        }
        const rest = data.slice(start);
        line += rest;
        lineBytes += Buffer.byteLength(rest);
        if (lineBytes > MAX_EVENT_LINE_BYTES)
          fail(
            new Error(
              `A single ${command.format} event line exceeded the ${mebibytes(MAX_EVENT_LINE_BYTES)} limit without a newline`,
            ),
          );
      });
      child.stderr.on('data', (data) => {
        stderr = (stderr + data).slice(-16000);
      });
      child.stdin.on('error', (/** @type {NodeJS.ErrnoException} */ error) => {
        if (error.code !== 'EPIPE') failure = error;
      });
      child.on('error', (error) => {
        failure = error;
      });
      child.on('close', (code, signal) => {
        if (entry.killTimer) clearTimeout(entry.killTimer);
        if (entry.stopped) return resolve(null);
        if (failure) return reject(failure);
        // The last event may end without a newline, and the CLI has exited, so the process group gets no signal. After a nonzero exit the line
        // may also be cut off; the exit is then the failure to report.
        let lastLineError = null;
        if (command.format !== 'text')
          handle(line, (error) => {
            lastLineError = error;
          });
        // A CLI that exits nonzero after reporting the turn's failure as an event, as Codex and Claude Code do, may leave only unrelated noise, such as MCP connection errors, on stderr.
        if (code !== 0)
          return reject(
            new Error(
              `${command.command} exited ${code ?? signal}: ${turn.failure || stderr.trim().slice(-3000) || stdoutTail.trim() || 'no diagnostic output'}`,
            ),
          );
        if (lastLineError) return reject(lastLineError);
        resolve(command.format === 'text' ? { stdout } : turn);
      });
      child.stdin.end(prompt);
    });
  }
  signal(entry, signal) {
    if (!entry.child?.pid) return;
    try {
      process.kill(-entry.child.pid, signal);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      if (error.code !== 'EPERM') throw error;
      // macOS refuses a group signal with EPERM when the group holds only its leader, exited but not yet reaped (Node
      // reaps it on the next turn of the event loop); a group with a live member takes the signal. An unreaped leader
      // still accepts one, so it gets the signal directly. A reaped leader's process ID may belong to another process now.
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
      try {
        process.kill(entry.child.pid, signal);
      } catch (direct) {
        if (direct.code !== 'ESRCH') throw direct;
      }
    }
  }
  // SIGKILL follows SIGTERM unless the process exits first, so a process that ignores SIGTERM cannot keep its turn running.
  terminate(entry) {
    this.signal(entry, 'SIGTERM');
    entry.killTimer ??= setTimeout(() => this.signal(entry, 'SIGKILL'), KILL_DELAY_MS);
    entry.killTimer.unref();
  }
  stop(id) {
    const entry = this.active.get(id);
    if (entry) {
      entry.stopped = true;
      this.terminate(entry);
    }
    return this.store.updateAgent(id, { status: 'stopped', activeMessageId: null });
  }
  // Shutdown terminates running turns without pausing their agents; the next service start resumes the interrupted message.
  // Every running turn is terminated even when one signal fails, so that each is recorded as interrupted and resumes.
  close() {
    this.closed = true;
    const failures = [];
    for (const [id, entry] of this.active) {
      Object.assign(entry, { stopped: true, shutdown: true });
      try {
        this.terminate(entry);
      } catch (error) {
        failures.push(new Error(`Could not terminate the turn of @${id}: ${error.message}`, { cause: error }));
      }
    }
    if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join('; '));
  }
  markInterrupted(id) {
    const agent = this.store.agent(id);
    if (!agent.activeMessageId) return;
    this.store.updateAgent(id, {
      status: agent.status === 'working' ? 'idle' : agent.status,
      activeMessageId: null,
      interruptedMessageId: agent.activeMessageId,
    });
  }
}
