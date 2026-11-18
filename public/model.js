export const statusLabels = Object.freeze({
  idle: 'Ready',
  working: 'Working',
  blocked: 'Blocked',
  done: 'Done',
  stopped: 'Stopped',
  error: 'Error',
});

export const taskStatusLabels = Object.freeze({ active: 'Active', ready: 'Ready to verify', verified: 'Verified' });

export const adapterLabels = Object.freeze({
  codex: 'Codex',
  claude: 'Claude Code',
  pi: 'pi',
  manual: 'External / manual',
  demo: 'Simulated demo',
});

export function summarizeAgents(agents) {
  return {
    active: agents.filter((agent) => ['idle', 'working', 'blocked'].includes(agent.status)).length,
    working: agents.filter((agent) => agent.status === 'working').length,
    attention: agents.filter((agent) => ['blocked', 'error'].includes(agent.status)).length,
    total: agents.length,
  };
}

// Tasks that still run (not verified) and have an assigned agent in one of the statuses.
export function tasksOfAgents(tasks, agents, statuses) {
  const ids = new Set(agents.filter((agent) => statuses.includes(agent.status)).map((agent) => agent.id));
  return tasks.filter((task) => task.status !== 'verified' && task.agentIds.some((id) => ids.has(id)));
}

export function filterAgents(agents, filter, query) {
  const search = query.trim().toLowerCase();
  return agents
    .filter((agent) => {
      const matchesStatus =
        filter === 'all' ||
        (filter === 'working' && agent.status === 'working') ||
        (filter === 'attention' && ['blocked', 'error'].includes(agent.status)) ||
        (filter === 'finished' && ['done', 'stopped'].includes(agent.status));
      const matchesSearch =
        !search ||
        [agent.id, agent.task, agent.cwd, agent.adapter].some((value) => value.toLowerCase().includes(search));
      return matchesStatus && matchesSearch;
    })
    .sort((left, right) => {
      if (left.role !== right.role) return left.role === 'lead' ? -1 : 1;
      return left.createdAt.localeCompare(right.createdAt);
    });
}

// Archived items belong only to work the user has verified. Anything still tied to unverified work stays visible,
// and the lead, its private chat, and the common room are never archived.
export function archivedItems({ agents = [], tasks, conversations = [] }) {
  const taskList = Array.isArray(tasks) ? tasks : [];
  const verified = taskList.filter((task) => task.status === 'verified');
  // Task records alone decide: a stopped worker's stale queued messages or a skipped retirement do not keep it visible.
  const agentIds = new Set(
    agents
      .filter((agent) => {
        if (agent.role === 'lead') return false;
        const assigned = taskList.filter(
          (task) => task.agentIds.includes(agent.id) || task.retiredAgentIds.includes(agent.id),
        );
        return assigned.length > 0 && assigned.every((task) => task.status === 'verified');
      })
      .map((agent) => agent.id),
  );
  const conversationIds = new Set(
    conversations
      .filter((conversation) => {
        if (conversation.kind === 'direct') return agentIds.has(conversation.members.find((id) => id !== 'user'));
        if (conversation.kind !== 'room') return false;
        const related = taskList.filter(
          (task) => task.conversationId === conversation.id || task.sourceConversationId === conversation.id,
        );
        return related.length > 0 && related.every((task) => task.status === 'verified');
      })
      .map((conversation) => conversation.id),
  );
  return { tasks: new Set(verified.map((task) => task.id)), agents: agentIds, conversations: conversationIds };
}

export function splitMentions(text, recipients) {
  const known = new Set(recipients);
  const parts = [];
  const expression = /(?<![A-Za-z0-9_@])@([a-z][a-z0-9-]{0,23})(?![A-Za-z0-9_-])/g;
  let cursor = 0;
  for (const match of text.matchAll(expression)) {
    if (!known.has(match[1])) continue;
    if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index), mention: false });
    parts.push({ text: match[0], mention: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), mention: false });
  return parts;
}

// Only an exact identifier, or a message ID written as `#123`, becomes a reference; any other inline code, including near misses, stays literal.
// The dashboard holds only the messages of the chats it opened, so a message it does not hold is a reference when Mu has
// issued its ID: message IDs count up from 1 without gaps, and no message is deleted. Its conversation is then unknown.
const VISUAL_ID = /^vis-[0-9a-f]{8}$/;

export function codeReference(text, { agents = [], tasks = [], visuals = [], messages = [], lastMessageId = 0 }) {
  const messageId = /^#([1-9]\d*)$/.exec(text);
  if (messageId) {
    const id = Number(messageId[1]);
    const message = messages.find((item) => item.id === id);
    if (message) return { kind: 'message', id, conversationId: message.conversationId };
    return id <= lastMessageId ? { kind: 'message', id, conversationId: null } : null;
  }
  if (agents.some((agent) => agent.id === text)) return { kind: 'agent', id: text };
  const visual = VISUAL_ID.test(text) ? visuals.find((item) => item.id === text) : undefined;
  if (visual) return { kind: 'visual', id: visual.id, title: visual.title, agentId: visual.agentId };
  const task = Array.isArray(tasks) ? tasks.find((item) => item.id === text) : undefined;
  return task ? { kind: 'task', id: task.id, title: task.title } : null;
}

export function initials(name) {
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function conversationMessages(messages, conversationId) {
  return messages.filter((message) => message.conversationId === conversationId);
}

// The user's message that picked one of a question's choices. It follows the question in its conversation, so a
// dashboard that holds the question holds its answer too.
export function choiceAnswer(messages, question) {
  return (
    messages.find(
      (message) =>
        message.answers === question.id &&
        message.conversationId === question.conversationId &&
        message.id > question.id,
    ) ?? null
  );
}

export function defaultConversationId(conversations) {
  return (
    conversations.find((conversation) => conversation.id === 'dm-lead')?.id ??
    conversations.find((conversation) => conversation.kind === 'direct')?.id ??
    conversations.find((conversation) => conversation.kind === 'common')?.id ??
    null
  );
}

export function conversationName(conversation) {
  return conversation.kind === 'direct'
    ? conversation.members.filter((id) => id !== 'user').join(', ')
    : conversation.name;
}

export function unreadCount(messages, conversationId, readThrough = 0) {
  return messages.filter(
    (message) => message.conversationId === conversationId && message.id > readThrough && message.from !== 'user',
  ).length;
}

// Where the user had read each conversation, kept in the browser: `{ [conversationId]: lastMessageId }`. Null means there
// is no record yet. A stored text that is not such a record throws, so that the page can report it instead of reading
// the browser's state as "nothing was ever read".
export function parseViewed(raw) {
  if (raw === null) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the stored text is not JSON (${error.message})`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('the stored value is not an object of conversation positions');
  for (const [id, position] of Object.entries(value))
    if (!Number.isSafeInteger(position) || position < 0)
      throw new Error(`the position of "${id}" is not a message ID: ${JSON.stringify(position)}`);
  return value;
}

// A first record treats everything that exists now as seen, so a new browser does not tint the whole history.
// `lastMessageIds` maps a conversation to its newest message ID.
export function baselineViewed(lastMessageIds, conversations) {
  return Object.fromEntries(
    conversations.map((conversation) => [conversation.id, lastMessageIds[conversation.id] ?? 0]),
  );
}

// A conversation missing from the record appeared after it began, so none of its messages was seen. A position beyond the
// conversation's newest message belongs to another history, such as a Mu that started again with an empty database on the
// same port; it cannot hide messages that do not exist yet, so it counts as the newest one.
export function newMessageBoundary(viewed, conversationId, newest = Infinity) {
  return Number.isInteger(viewed[conversationId]) ? Math.min(viewed[conversationId], newest) : 0;
}

// The record after the user read a conversation through `position`. `conversations` are those worth remembering: a
// conversation that is gone or archived is dropped, so rooms do not accumulate. The stored position stays if it is
// known to be genuine: a position beyond `newest`, the newest message that exists, belongs to another history and is
// replaced, so it cannot hide messages that arrive later.
export function advanceViewed(viewed, conversationId, position, conversations, newest = Infinity) {
  const kept = new Set(conversations.map((conversation) => conversation.id));
  const next = Object.fromEntries(Object.entries(viewed).filter(([id]) => kept.has(id)));
  const stored = next[conversationId];
  next[conversationId] = stored !== undefined && stored <= newest ? Math.max(stored, position) : position;
  return next;
}

// Two tabs that write the record at the same moment each replace the whole of it, so one can erase the other's advance.
// A tab keeps what it wrote and puts it back, never lowering a position, when it sees a record that lacks it.
export function restorePositions(viewed, written, conversations) {
  const kept = new Set(conversations.map((conversation) => conversation.id));
  const next = { ...viewed };
  for (const [id, position] of written) if (kept.has(id)) next[id] = Math.max(next[id] ?? 0, position);
  return next;
}

export function isNewMessage(message, boundary) {
  return message.id > boundary && message.from !== 'user';
}

export const viewHashes = Object.freeze({
  workspace: '#workspace',
  chat: '#team-chat',
  brag: '#brag-doc',
  evals: '#evals',
  visuals: '#visuals',
});

export function viewFromHash(hash) {
  if (visualFromHash(hash)) return 'visuals';
  return Object.keys(viewHashes).find((view) => viewHashes[view] === hash) ?? 'workspace';
}

// A visual has its own address, so that the browser's history steps through the visuals and versions the user opened.
// Without a version the address follows the newest one.
export const visualHash = (id, version = null) => `${viewHashes.visuals}/${id}${version ? `/v${version}` : ''}`;

export function visualFromHash(hash) {
  const match = /^#visuals\/(vis-[0-9a-f]{8})(?:\/v([1-9]\d{0,8}))?$/.exec(hash);
  return match ? { id: match[1], version: match[2] ? Number(match[2]) : null } : null;
}

// The history is read one page at a time, so a count at the page size may stand for more messages.
export const UNREAD_PAGE = 100;

export function unreadLabel(count) {
  return count >= UNREAD_PAGE ? '99+' : String(count);
}

export function totalUnread(messages, conversations, readThrough) {
  return conversations.reduce(
    (total, conversation) => total + unreadCount(messages, conversation.id, readThrough.get(conversation.id)),
    0,
  );
}

// Only an explicit `@user` asks for the user's attention. `@all` is a broadcast that Mu delivers to the agents of a
// room, and a private chat has no one else to write to, so neither says "this one is for you".
export function isMention(message) {
  return message.from !== 'user' && message.mentions.includes('user');
}

// The unread messages that mention the user, newest first, in the conversations given. A mention is read by the same
// position as its message: `readThrough` is the map that the unread counts use.
export function unreadMentions(messages, conversations, readThrough) {
  const listed = new Set(conversations.map((conversation) => conversation.id));
  return messages
    .filter(
      (message) =>
        listed.has(message.conversationId) &&
        message.id > (readThrough.get(message.conversationId) ?? 0) &&
        isMention(message),
    )
    .sort((a, b) => b.id - a.id);
}

export function mentionCount(messages, conversationId, readThrough = 0) {
  return messages.filter(
    (message) => message.conversationId === conversationId && message.id > readThrough && isMention(message),
  ).length;
}

// One line of a message for a list, so that line breaks do not take the room.
export function snippet(text, limit = 110) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

// A managed turn can be running while the agent has already reported a final status such as `done`.
export function isAgentBusy(agent) {
  return agent.status === 'working' || Boolean(agent.activeMessageId);
}

// A stopped agent runs no turn until it is set idle, so its card offers Resume where Stop would do nothing. A failed
// agent keeps Stop too: stopping it parks its queued messages for good instead of retrying them.
export function agentLifecycleActions(agent) {
  if (agent.status === 'stopped') return ['resume'];
  if (agent.status === 'error') return ['resume', 'stop'];
  return ['stop'];
}

export const activityVerbs = [
  'following the white rabbit', // The Matrix
  'bending the spoon. There is no spoon', // The Matrix
  'consulting the Oracle', // The Matrix
  'going one level deeper', // Inception
  'spinning the top', // Inception
  'planting an idea', // Inception
  'tattooing the context', // Memento
  'remembering Sammy Jankis', // Memento
  'opening the pod bay doors', // 2001: A Space Odyssey
  'enhancing... enhancing', // Blade Runner
  'turning the tortoise over', // Blade Runner
  'watching C-beams glitter', // Blade Runner
  'building a bigger boat', // Jaws
  'phoning home', // E.T.
  'hitting 88 miles per hour', // Back to the Future
  'generating 1.21 gigawatts', // Back to the Future
  'fluxing the capacitor', // Back to the Future
  'tying the room together', // The Big Lebowski
  'abiding', // The Big Lebowski
  'rounding up the usual suspects', // Casablanca
  'leaving the gun, taking the cannoli', // The Godfather
  'making an offer you can’t refuse', // The Godfather
  'not talking about it', // Fight Club
  'crossing the streams', // Ghostbusters
  'feeding the Mogwai after midnight', // Gremlins
  'doing. There is no try', // The Empire Strikes Back
  'making the Kessel Run in 12 parsecs', // Star Wars
  'reprogramming the Kobayashi Maru', // Star Trek II
  'holding on to your butts', // Jurassic Park
  'it’s a UNIX system, I know this', // Jurassic Park
  'finding a way, uh', // Jurassic Park
  'seeing dead code', // The Sixth Sense
  'wondering what’s in the briefcase', // Pulp Fiction
  'solving problems, Wolf-style', // Pulp Fiction
  'crawling through 500 yards of pipe', // The Shawshank Redemption
  'getting busy living', // The Shawshank Redemption
  'choosing wisely', // Indiana Jones and the Last Crusade
  'swapping the idol for a bag of sand', // Raiders of the Lost Ark
  'building it so they will come', // Field of Dreams
  'opening the box of chocolates', // Forrest Gump
  'running, Forrest, running', // Forrest Gump
  'handling the truth', // A Few Good Men
  'showing you the money', // Jerry Maguire
  'letting the spice flow', // Dune
  'walking without rhythm', // Dune
  'combing the desert', // Spaceballs
  'going to Ludicrous Speed', // Spaceballs
  'turning it up to eleven', // This Is Spinal Tap
  'asking: is it safe?', // Marathon Man
  'looking for the only winning move', // WarGames
  'having fun storming the castle', // The Princess Bride
  'being only mostly dead', // The Princess Bride
  'not simply walking into Mordor', // The Fellowship of the Ring
  'searching for Rosebud', // Citizen Kane
  'getting ready for the close-up', // Sunset Boulevard
  'fastening seatbelts, bumpy night ahead', // All About Eve
  'ignoring the man behind the curtain', // The Wizard of Oz
  'clicking heels three times', // The Wizard of Oz
  'being back', // The Terminator
  'on a mission from God', // The Blues Brothers
  'hacking the Gibson', // Hackers
  'counting toothpicks', // Rain Man
  'talking to you?', // Taxi Driver
  'keeping the change, ya filthy animal', // Home Alone
];

export function conversationActivity(agents, conversation, conversations = []) {
  if (!conversation) return [];
  const members = new Set(conversation.members);
  const current = [];
  const elsewhere = [];
  for (const agent of agents) {
    if (
      !members.has(agent.id) ||
      agent.activeMessageId === null ||
      agent.activeMessageId === undefined ||
      !agent.activeConversationId
    )
      continue;
    if (agent.activeConversationId === conversation.id) {
      let hash = 0;
      for (const character of `${agent.id}:${agent.activeMessageId}`)
        hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
      current.push({ id: agent.id, type: 'current', verb: activityVerbs[hash % activityVerbs.length] });
      continue;
    }
    const activeConversation = conversations.find(({ id }) => id === agent.activeConversationId);
    const visibleConversation = activeConversation?.members.includes('user') ? activeConversation : null;
    elsewhere.push({
      id: agent.id,
      type: 'elsewhere',
      conversationName:
        visibleConversation && visibleConversation.kind !== 'direct' ? conversationName(visibleConversation) : null,
      conversationKind: visibleConversation?.kind ?? null,
    });
  }
  return [...current, ...elsewhere];
}

// Values that Mu can show for each harness. Claude Code reports its cost; Mu prices Codex token usage with LiteLLM.
const runtimeSupport = Object.freeze({
  claude: { model: true, context: true, spend: true },
  codex: { model: true, context: true, spend: true },
  pi: { model: true, context: true, spend: true },
});
const noRuntimeSupport = Object.freeze({ model: false, context: false, spend: false });
export const runtimeSymbols = Object.freeze({ absent: '—', pending: '…' });

function harnessName(adapter) {
  return adapterLabels[adapter] || adapter;
}

function compactNumber(value) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function usd(value) {
  return value > 0 && value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
}

function costSource(session) {
  if (session.adapter === 'codex')
    return `computed by Mu from Codex token usage at LiteLLM list prices${session.pricesFetchedAt ? ` fetched ${session.pricesFetchedAt}` : ''}`;
  return `estimated by ${harnessName(session.adapter)} at list prices`;
}

function unpricedReason(session) {
  if (session.costError) return session.costError;
  return session.adapter === 'codex'
    ? 'Codex session not priced yet'
    : `cost not reported by ${harnessName(session.adapter)}`;
}

// Compact footer indicators. `text` is the visible value or symbol; `title` explains it in full.
export function agentRuntime(agent) {
  const harness = harnessName(agent.adapter);
  const support = runtimeSupport[agent.adapter] ?? noRuntimeSupport;
  const usage = Object.entries(agent.usage ?? {});
  const [latestConversation, latest] =
    usage
      .filter(([, entry]) => entry.adapter === agent.adapter)
      .sort(([, left], [, right]) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? [];
  const inCurrentSession = Boolean(latest) && agent.sessionIds?.[latestConversation] === latest.sessionId;
  const missing = (label, supported, prefix) => {
    if (!supported)
      return {
        text: `${prefix}${runtimeSymbols.absent}`,
        title: `${label}: not reported by ${harness}`,
        state: 'absent',
      };
    if (inCurrentSession && latest.usageError)
      return { text: `${prefix}${runtimeSymbols.absent}`, title: `${label}: ${latest.usageError}`, state: 'absent' };
    return { text: `${prefix}${runtimeSymbols.pending}`, title: `${label}: no turn reported yet`, state: 'pending' };
  };

  const model = latest?.model
    ? { key: 'model', text: latest.model, title: `Model: ${latest.model}`, state: 'ok' }
    : { key: 'model', ...missing('Model', support.model, 'model ') };

  // Mu sets the effort itself, so it is shown from the agent record rather than from the CLI's usage report.
  const effort = agent.effort
    ? [
        {
          key: 'effort',
          text: `effort ${agent.effort}`,
          title: `Reasoning effort: ${agent.effort}, passed to ${harness} on every turn`,
          state: 'ok',
        },
      ]
    : [];

  let context;
  if (support.context && inCurrentSession && latest.contextTokens !== null) {
    const where = ` in ${latestConversation}`;
    if (latest.contextWindow) {
      const percent = Math.min(100, Math.round((latest.contextTokens / latest.contextWindow) * 100));
      context = {
        key: 'context',
        text: `${percent}%`,
        title: `Context: ${compactNumber(latest.contextTokens)} of ${compactNumber(latest.contextWindow)} tokens${where}`,
        state: 'ok',
        percent,
      };
    } else
      context = {
        key: 'context',
        text: `${compactNumber(latest.contextTokens)} tok`,
        title: `Context: ${compactNumber(latest.contextTokens)} tokens${where}; window not reported`,
        state: 'ok',
      };
  } else context = { key: 'context', ...missing('Context', support.context, 'ctx ') };

  // An assigned worker's task conversation is its assignment conversation; agents without a task show all their spend.
  const spendLabel = agent.taskId ? 'Task spend' : 'Spend';
  const scoped = agent.taskId ? usage.filter(([conversationId]) => conversationId === agent.conversationId) : usage;
  const sessions = scoped.flatMap(([, entry]) => Object.values(entry.sessions ?? {}));
  const priced = sessions.filter((session) => session.costUsd !== null);
  const unpriced = sessions.filter((session) => session.costUsd === null);
  const unknown = unpriced.filter((session) => !session.costPending);
  const unpricedTokens = unpriced.reduce((total, session) => total + (session.totalTokens ?? 0), 0);
  const tokenNote = unpricedTokens ? `; ${compactNumber(unpricedTokens)} tokens processed` : '';
  const reasons = [...new Set(unpriced.map(unpricedReason))].join('; ');
  let spend;
  if (priced.length) {
    const total = usd(priced.reduce((sum, session) => sum + session.costUsd, 0));
    const sources = [...new Set(priced.map(costSource))].join('; ');
    // A partial total is marked as a lower bound rather than presented as the full spend.
    spend = unpriced.length
      ? {
          key: 'spend',
          text: `${total}+`,
          title: `${spendLabel}: at least ${total}, ${sources}; excludes ${unpriced.length} unpriced session${unpriced.length === 1 ? '' : 's'}: ${reasons}${tokenNote}`,
          state: 'partial',
        }
      : { key: 'spend', text: total, title: `${spendLabel}: ${sources}`, state: 'ok' };
  } else if (unknown.length) {
    spend = {
      key: 'spend',
      text: `$${runtimeSymbols.absent}${unpricedTokens ? ` ${compactNumber(unpricedTokens)} tok` : ''}`,
      title: `${spendLabel}: price unknown: ${reasons}${tokenNote}`,
      state: 'partial',
    };
  } else if (unpriced.length) {
    spend = {
      key: 'spend',
      text: `$${runtimeSymbols.pending}`,
      title: `${spendLabel}: ${reasons}${tokenNote}`,
      state: 'pending',
    };
  } else spend = { key: 'spend', ...missing(spendLabel, support.spend, '$') };

  return { harness, indicators: [model, ...effort, context, spend] };
}

export const TRANSCRIPT_ADAPTERS = Object.freeze(['claude', 'codex', 'pi']);

// Conversations in which the agent has a harness session whose transcript Mu can show.
export function transcriptConversations(agent) {
  return TRANSCRIPT_ADAPTERS.includes(agent.adapter) ? Object.keys(agent.sessionIds ?? {}) : [];
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

// Lists what the viewer leaves out, most frequent first, so that missing records are visible.
export function transcriptNote(page) {
  const skipped = Object.entries(page.skipped ?? {})
    .sort(([, left], [, right]) => right - left)
    .map(([type, count]) => `${type} ×${count}`);
  return [
    skipped.length ? `Not shown: ${skipped.join(', ')}.` : '',
    page.masked ? `${page.masked} secret${page.masked === 1 ? '' : 's'} masked for display.` : '',
    page.pendingBytes ? `${formatBytes(page.pendingBytes)} at the end of the file is still being written.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// A linked task shows as one square. Mu has no "inactive" status, so the square follows the task's own status:
// verified is archived, active is being worked on, and ready is idle until the user verifies it.
export const taskSquareStates = {
  verified: { state: 'archived', label: 'Archived' },
  active: { state: 'active', label: 'Active' },
  ready: { state: 'inactive', label: 'Inactive' },
};

export function taskSquare(task) {
  return taskSquareStates[task.status] ?? taskSquareStates.active;
}

export const activityLanes = { focus: 'Focus', control: 'Control' };

export function activityOfTask(activities, taskId) {
  return (activities ?? []).find((activity) => activity.taskIds.includes(taskId));
}

// Open activities of one lane, top first; checked-off ones belong to the archive.
export function laneActivities(activities, lane) {
  return (activities ?? [])
    .filter((activity) => activity.lane === lane && !activity.checkedAt)
    .sort((a, b) => a.position - b.position);
}

// The archive lists the most recently checked off first.
export function archivedActivities(activities) {
  return (activities ?? [])
    .filter((activity) => activity.checkedAt)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt));
}

// The result of moving an activity to a position (1 is the top) in a lane, as the server will store it: the lane's open
// activities stay numbered from 1 without gaps. Used to show a drop at once, before the server has answered.
export function moveActivity(activities, id, lane, position) {
  const moved = activities.find((activity) => activity.id === id);
  if (!moved || moved.checkedAt) return activities;
  const order = (name) => laneActivities(activities, name).filter((activity) => activity.id !== id);
  const target = order(lane);
  target.splice(Math.min(position, target.length + 1) - 1, 0, { ...moved, lane });
  const positions = new Map(target.map((activity, index) => [activity.id, index + 1]));
  if (moved.lane !== lane) order(moved.lane).forEach((activity, index) => positions.set(activity.id, index + 1));
  return activities.map((activity) =>
    positions.has(activity.id)
      ? { ...activity, lane: activity.id === id ? lane : activity.lane, position: positions.get(activity.id) }
      : activity,
  );
}

// Merges messages into a list sorted by ID, once each. New messages arrive in ID order, so they are usually appended.
export function mergeMessages(messages, incoming) {
  if (!incoming.length) return messages;
  const last = messages.at(-1)?.id ?? 0;
  if (incoming.every((message, index) => message.id > (index ? incoming[index - 1].id : last)))
    return [...messages, ...incoming];
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// Adds the newest page of a conversation's history. When older history remains on the server, a message held from before
// that page would sit above a gap, so it is dropped; the page then starts the conversation's contiguous run.
export function mergeLatestPage(messages, conversationId, page, complete) {
  const start = page[0]?.id ?? Infinity;
  const kept = complete
    ? messages
    : messages.filter((message) => message.conversationId !== conversationId || message.id >= start);
  return mergeMessages(kept, page);
}

// The record kinds of the dashboard stream that are lists of records with IDs.
export const recordKinds = Object.freeze(['agents', 'tasks', 'waiting', 'activities', 'conversations', 'visuals']);

// Applies one batch of the dashboard stream: whole records keyed by ID, a null value for a removed record, new messages,
// and the chat transport. Returns the new state and the kinds the batch touched; the input state is not modified.
export function applyChanges(state, changes) {
  const next = { ...state };
  const touched = new Set();
  const arrived = [];
  for (const change of changes) {
    touched.add(change.kind);
    if (change.kind === 'transport') next.transport = change.value;
    else if (change.kind === 'messages') arrived.push(change.value);
    else if (recordKinds.includes(change.kind)) {
      if (next[change.kind] === state[change.kind]) next[change.kind] = [...state[change.kind]];
      const list = next[change.kind];
      const index = list.findIndex((item) => item.id === change.id);
      if (change.value === null) {
        if (index !== -1) list.splice(index, 1);
      } else if (index === -1) list.push(change.value);
      else list[index] = change.value;
    } else throw new Error(`The dashboard stream sent an unknown change kind: ${change.kind}`);
  }
  if (arrived.length) {
    next.lastMessageIds = { ...state.lastMessageIds };
    for (const message of arrived)
      next.lastMessageIds[message.conversationId] = Math.max(
        next.lastMessageIds[message.conversationId] ?? 0,
        message.id,
      );
    next.lastMessageId = Math.max(state.lastMessageId, ...arrived.map((message) => message.id));
    next.messages = mergeMessages(
      state.messages,
      [...arrived].sort((a, b) => a.id - b.id),
    );
  }
  return { state: next, touched };
}

// Cmd+L on a Mac, Ctrl+L elsewhere. On a Mac, Ctrl+L belongs to the text fields (it centers the cursor line), and
// elsewhere the Windows or Super key with L locks or opens the system, so each platform answers to one modifier.
// A layout without a Latin L, such as Cyrillic, is matched by its physical key.
/**
 * @param {{ key: string, code?: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean, altKey?: boolean, repeat?: boolean, isComposing?: boolean }} event
 * @param {boolean} mac
 */
export function isLeadChatShortcut(event, mac) {
  if (event.repeat || event.isComposing || event.shiftKey || event.altKey) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  const key = String(event.key);
  return key.toLowerCase() === 'l' || (!/^[a-z]$/i.test(key) && event.code === 'KeyL');
}

export function leadChatShortcutLabel(mac) {
  return mac ? '⌘L' : 'Ctrl+L';
}

// Code spans and fences become spaces of the same length, so that an offset in the result is an offset in the text.
// It reads code as `mentions` in src/store.mjs does, which the dashboard cannot import; a test holds the two together.
// One difference is deliberate: a backtick that nothing closes yet opens a span that runs to the end, because the
// user who has just typed one is writing code, and a list of agents there would only be in the way.
function withoutCode(text) {
  const blank = (match) => ' '.repeat(match.length);
  const closed = text.replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, blank).replace(/(`+)[\s\S]*?\1/g, blank);
  const open = closed.indexOf('`');
  return open === -1 ? closed : closed.slice(0, open) + blank(closed.slice(open));
}

// The `@name` being typed at the caret, or null where Mu would not count a mention: inside a word (an e-mail
// address), after another `@` or a slash, in code, or with anything but the start of an agent ID after the `@`.
// `end` reaches over the rest of the name that the caret stands in, so a pick replaces all of it.
/**
 * @param {string} text
 * @param {number} caret
 * @returns {{ start: number, end: number, query: string } | null}
 */
export function mentionTrigger(text, caret) {
  const prose = withoutCode(text);
  const before = prose.slice(0, caret);
  const start = before.lastIndexOf('@');
  if (start === -1) return null;
  const query = before.slice(start + 1);
  if (!/^(?:[a-z][a-z0-9-]{0,23})?$/i.test(query)) return null;
  if (start > 0 && /[\w@/]/.test(before[start - 1])) return null;
  let end = caret;
  while (end < prose.length && /[a-z0-9-]/i.test(prose[end])) end += 1;
  if (/^\/[\w@.-]/.test(prose.slice(end))) return null;
  return { start, end, query };
}

// Who the user can mention in a conversation: `@all` where a mention routes at all, and every member that can still
// run a turn. The user is no mention target, and a stopped agent is rejected as a recipient.
/**
 * @param {{ kind: string, members: string[] }} conversation
 * @param {{ id: string, role: string, status: string }[]} agents
 * @returns {{ id: string, hint: string }[]}
 */
export function mentionEntries(conversation, agents) {
  const entries = conversation.kind === 'direct' ? [] : [{ id: 'all', hint: 'Everyone in this conversation' }];
  for (const agent of agents) {
    if (!conversation.members.includes(agent.id) || agent.status === 'stopped') continue;
    entries.push({
      id: agent.id,
      hint: `${agent.role === 'lead' ? 'Team lead' : 'Worker'} · ${statusLabels[agent.status]}`,
    });
  }
  return entries;
}

// The entries whose ID starts with the query come first, then the ones that contain it, each in their own order.
export function filterMentionEntries(entries, query) {
  const needle = query.toLowerCase();
  const starts = entries.filter((entry) => entry.id.startsWith(needle));
  const contains = entries.filter((entry) => !entry.id.startsWith(needle) && entry.id.includes(needle));
  return [...starts, ...contains];
}
