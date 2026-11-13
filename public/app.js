import {
  activityOfTask,
  moveActivity,
  adapterLabels,
  agentRuntime,
  archivedActivities,
  archivedItems,
  codeReference,
  conversationActivity,
  conversationMessages,
  conversationName,
  defaultConversationId,
  filterAgents,
  formatBytes,
  initials,
  isAgentBusy,
  baselineViewed,
  isNewMessage,
  laneActivities,
  applyChanges,
  mergeLatestPage,
  mergeMessages,
  newMessageBoundary,
  parseViewed,
  statusLabels,
  summarizeAgents,
  taskSquare,
  taskStatusLabels,
  tasksOfAgents,
  totalUnread,
  transcriptConversations,
  transcriptNote,
  unreadCount,
  viewFromHash,
  viewHashes,
} from './model.js';
import { markdownElement } from './markdown.js';
import { emptyMessages, groupBrag } from './brag.js';
import { bragSections } from './brag-view.js';
import { createMotion, stateChanges, themeValue } from './motion.js';
import { rawInput, toolView } from './tools.js';
import { createPicker, enhanceSelects } from './picker.js';

// An ID names an input, a dialog, a form or another element; the checker cannot tell which from the string.
/** @type {(id: string) => any} */
const $ = (id) => document.getElementById(id);
/** @type {(selector: string) => NodeListOf<HTMLElement>} */
const $$ = (selector) => document.querySelectorAll(selector);
const focusedElement = () => /** @type {HTMLElement | null} */ (document.activeElement);
const elements = {
  grid: $('agent-grid'),
  messages: $('messages'),
  input: $('message-input'),
  dialog: $('agent-dialog'),
  agentForm: $('agent-form'),
};
enhanceSelects(document);
let state = null;
let filter = 'all';
let taskFilter = 'all';
let streamConnected = false;
let sending = false;
let lastMessageSignature = '';
let lastReferenceSignature = '';
let revealedTask = null;
let revealTimer;
let forceScroll = true;
let toastTimer;
let conversationId = null;
let activitySignature = null;
let roomDialogMode = 'create';
let view = viewFromHash(location.hash);
const showArchivedKey = 'mu:show-archived';
let showArchived = localStorage.getItem(showArchivedKey) === 'true';
let archived = { tasks: new Set(), agents: new Set(), conversations: new Set() };
const readThrough = new Map();
const drafts = new Map();
const viewedKey = 'mu:chat-viewed';
// Per conversation: the boundary taken when the chat was opened. Messages above it stay tinted until the next open.
const newBoundaries = new Map();
let viewing = null;
const expandedAgentTasks = new Set();
const messageBytes = (text) => new TextEncoder().encode(text).length;
const currentConversation = () => state?.conversations.find((conversation) => conversation.id === conversationId);
const visible = (kind, item) => showArchived || !archived[kind].has(item.id);
// The selected conversation stays listed so that opening an archived chat through a reference keeps its context.
const listedConversations = () =>
  state.conversations.filter(
    (conversation) => conversation.id === conversationId || visible('conversations', conversation),
  );
const motion = createMotion();
document.addEventListener('mu-theme-change', () => {
  motion.cancelAll();
  for (const element of $$('[data-agent-name].agent-live')) setAgentLive(element, true);
});

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Name elements are live from creation, so partial re-renders (filters, search, navigation) keep the wave.
function agentName(tag, className, id, text = id) {
  const element = node(tag, className, text);
  element.dataset.agentName = id;
  const agent = state?.agents.find((item) => item.id === id);
  if (agent && isAgentBusy(agent)) setAgentLive(element, true);
  return element;
}

// The shared agent reference: `@name`, animated while the agent runs a turn, opening its private chat.
function agentReference(id, className = '') {
  const button = node('button', `agent-ref ${className}`.trim());
  button.type = 'button';
  button.append(agentName('span', '', id, `@${id}`));
  button.setAttribute('aria-label', `Open private chat with ${id}`);
  button.addEventListener('click', () => openConversation(`dm-${id}`));
  return button;
}

// A link rather than a button so that a long title wraps with the surrounding text.
function taskReference(task) {
  const link = node('a', 'task-ref', task.title);
  link.href = viewHashes.workspace;
  link.title = task.id;
  link.setAttribute('aria-label', `Show task: ${task.title}`);
  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    revealTask(task.id);
  });
  return link;
}

function messageReference(reference) {
  const link = node('a', 'message-ref', `#${reference.id}`);
  link.href = viewHashes.chat;
  link.setAttribute('aria-label', `Show message ${reference.id}`);
  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void revealMessage(reference.id, reference.conversationId);
  });
  return link;
}

function codeReferenceElement(text) {
  const reference = codeReference(text, state);
  if (!reference) return null;
  if (reference.kind === 'agent') return agentReference(reference.id);
  return reference.kind === 'message' ? messageReference(reference) : taskReference(reference);
}

// Rendered Markdown embeds references, so it must be rebuilt when the known agents or task titles change.
// Message references need no part: a message ID links once Mu has issued it, and text names only issued IDs.
function referenceSignature() {
  return `${state.agents.map((agent) => agent.id).join(',')}|${(state.tasks ?? []).map((task) => `${task.id}:${task.title}`).join('\n')}`;
}

function markdown(className, source, recipients) {
  return markdownElement(className, source, { recipients, resolveCode: codeReferenceElement });
}

// Names are re-rendered on every state update; a phase taken from a shared clock keeps the wave continuous and in step.
function setAgentLive(element, live) {
  element.classList.toggle('agent-live', live);
  const waveDuration = Number.parseFloat(themeValue(element, 'motion-agent-duration')) * 1000;
  element.style.animationDelay = live ? `-${Math.round(performance.now() % waveDuration)}ms` : '';
}

function refreshBusyAgents() {
  const busy = new Set(state.agents.filter(isAgentBusy).map((agent) => agent.id));
  for (const element of $$('[data-agent-name]')) {
    const live = busy.has(element.dataset.agentName);
    if (live === element.classList.contains('agent-live')) continue;
    setAgentLive(element, live);
  }
}

const harnessIcons = new Set(['claude', 'codex', 'pi']);

// Static, vendored marks in public/icons, painted as CSS masks; a harness without a mark shows its name.
function glyph(name) {
  const element = node('span', `glyph glyph-${name}`);
  element.setAttribute('aria-hidden', 'true');
  return element;
}

function harnessChip(adapter, label) {
  const chip = node('span', 'runtime-indicator harness-chip');
  chip.title = `Harness: ${label}`;
  if (harnessIcons.has(adapter)) {
    chip.setAttribute('role', 'img');
    chip.setAttribute('aria-label', `Harness: ${label}`);
    chip.append(glyph(adapter));
  } else chip.append(node('span', '', label));
  return chip;
}

function iconButton(name, title, label, className = '') {
  const button = node('button', `icon-action ${className}`.trim());
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', label);
  button.append(glyph(name));
  return button;
}

function icon(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 20 20',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(name, value);
  }
  for (const path of paths) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    element.setAttribute('d', path);
    svg.append(element);
  }
  return svg;
}

// A state update clears only an error about reading the state. An error of the user's own action stays until the next
// action: while any agent works, a state update arrives every few seconds and would otherwise hide the error at once.
let pageErrorFromState = false;
function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
  if (id === 'page-error') pageErrorFromState = false;
}
function showStateError(message) {
  showError('page-error', message);
  pageErrorFromState = true;
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 3500);
}

// The user credential arrives once in the sign-in link's query and is kept in this origin's storage.
// Unlike a cookie, that storage is not shared with other local ports, which agents can serve.
const TOKEN_KEY = 'mu-user-token';
const signInHelp =
  'Open the sign-in link that the Mu service prints when it starts, or print it with `node src/cli.mjs dashboard` in the Mu checkout.';
const linkToken = new URLSearchParams(location.search).get('token');
if (linkToken) {
  localStorage.setItem(TOKEN_KEY, linkToken);
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
}
const userToken = localStorage.getItem(TOKEN_KEY);

async function request(path, options = {}) {
  if (!userToken) throw new Error(`This browser is not signed in. ${signInHelp}`);
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}`, ...options.headers },
  });
  const body = await response.json();
  if (response.status === 401)
    throw new Error(`This browser's sign-in is not valid for this Mu service. ${signInHelp}`);
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

// The dashboard holds the messages of the conversations it opened, and those that arrived since the page loaded.
// A conversation's history is loaded when it is first shown; see "Dashboard updates" in docs/architecture.md.
const HISTORY_PAGE = 300;
const histories = new Map();

function historyPath(id, params) {
  return `/api/conversations/${encodeURIComponent(id)}/messages?${new URLSearchParams(params)}`;
}

function loadHistory(id) {
  const known = histories.get(id);
  if (known) return known.promise;
  const entry = { loaded: false, complete: false, promise: null };
  entry.promise = (async () => {
    const { messages } = await request(historyPath(id, { limit: HISTORY_PAGE }));
    entry.complete = messages.length < HISTORY_PAGE;
    state = { ...state, messages: mergeLatestPage(state.messages, id, messages, entry.complete) };
    entry.loaded = true;
    if (id === conversationId) {
      markConversationRead();
      renderConversations();
      renderMessages();
    }
  })();
  histories.set(id, entry);
  // A failed load is shown and forgotten, so opening the conversation again tries again.
  entry.promise.catch((error) => {
    histories.delete(id);
    if (id === conversationId) {
      showError('chat-error', `Could not load the messages: ${error.message}`);
      renderMessages();
    }
  });
  return entry.promise;
}

const historyLoaded = (id) => Boolean(histories.get(id)?.loaded);
const oldestHeld = (id) => conversationMessages(state.messages, id)[0]?.id ?? Infinity;

// Loads earlier pages until the message is held, so that a reference to an old message can show it.
async function loadThrough(id, messageId) {
  await loadHistory(id);
  const entry = histories.get(id);
  while (!entry.complete && oldestHeld(id) > messageId) {
    const { messages } = await request(historyPath(id, { limit: HISTORY_PAGE, before: oldestHeld(id) }));
    entry.complete = messages.length < HISTORY_PAGE;
    state = { ...state, messages: mergeMessages(state.messages, messages) };
  }
}

// After a resync, each conversation whose newest message moved on gets the messages it missed. An open history is
// caught up completely so that it stays contiguous; for any other conversation one page is enough to count unread messages.
async function catchUp(id, after) {
  const open = historyLoaded(id);
  for (;;) {
    const { messages } = await request(historyPath(id, { limit: open ? 1000 : 100, after }));
    state = { ...state, messages: mergeMessages(state.messages, messages) };
    if (!open || messages.length < 1000) break;
    after = messages.at(-1).id;
  }
  render(new Set(['messages']));
}

function renderConnection() {
  const connected = streamConnected && state?.transport.connected;
  const badge = $('connection-badge');
  badge.classList.toggle('connected', Boolean(connected));
  badge.classList.toggle('disconnected', !connected);
  $('connection-label').textContent = connected ? 'Connected locally' : state ? 'Connection interrupted' : 'Connecting';
  $('live-label').classList.toggle('offline', !streamConnected);
  $('live-label').lastChild.textContent = streamConnected ? ' Live updates' : ' Updates disconnected';
  if (state) {
    const transport = state.transport;
    badge.title = `IRC ${transport.host}:${transport.port} · ${transport.channel}`;
    showError(
      'transport-notice',
      transport.connected
        ? ''
        : `The team chat is disconnected. ${transport.error || 'Check that the IRC server is running.'}`,
    );
  }
  $('send-message').disabled =
    sending ||
    !connected ||
    !conversationId ||
    !elements.input.value.trim() ||
    messageBytes(elements.input.value) > 65536;
  $('new-agent').disabled = !state || !state.transport.connected;
  $('empty-new-agent').disabled = !state || !state.transport.connected;
  $('new-room').disabled = !state || !state.transport.connected;
}

function directAgent(conversation) {
  return conversation.members.find((id) => id !== 'user');
}

function renderConversations() {
  const selected = currentConversation();
  renderConversationActivity(selected);
  const listed = listedConversations();
  $('conversation-total').textContent = listed.length;
  const focused = focusedElement()?.dataset.conversation;
  const fragment = document.createDocumentFragment();
  for (const [kind, label] of [
    ['direct', 'Direct messages'],
    ['room', 'Task rooms'],
    ['common', 'Common'],
  ]) {
    const items = listed
      .filter((conversation) => conversation.kind === kind)
      .sort((a, b) =>
        a.id === 'dm-lead' ? -1 : b.id === 'dm-lead' ? 1 : conversationName(a).localeCompare(conversationName(b)),
      );
    if (!items.length) continue;
    fragment.append(node('h3', 'conversation-group', label));
    for (const conversation of items) {
      const isArchived = archived.conversations.has(conversation.id);
      const option = node(
        'button',
        `conversation-option${conversation.id === conversationId ? ' selected' : ''}${isArchived ? ' archived' : ''}`,
      );
      option.type = 'button';
      option.dataset.conversation = conversation.id;
      option.setAttribute('aria-current', conversation.id === conversationId ? 'true' : 'false');
      const label = node('span', 'conversation-option-name', kind === 'direct' ? '@' : '# ');
      label.append(
        kind === 'direct'
          ? agentName('span', '', directAgent(conversation), conversationName(conversation))
          : conversationName(conversation),
      );
      if (isArchived) label.append(node('span', 'archived-tag', 'Archived'));
      option.append(label);
      const unread = unreadCount(state.messages, conversation.id, readThrough.get(conversation.id));
      if (unread) option.append(node('span', 'unread-count', String(unread)));
      option.addEventListener('click', () => selectConversation(conversation.id));
      fragment.append(option);
    }
  }
  const hiddenCount = state.conversations.length - listed.length;
  if (hiddenCount || (showArchived && archived.conversations.size)) {
    const toggle = node(
      'button',
      'conversation-archive-toggle',
      showArchived
        ? 'Hide archived conversations'
        : `Show ${hiddenCount} archived ${hiddenCount === 1 ? 'conversation' : 'conversations'}`,
    );
    toggle.type = 'button';
    toggle.dataset.conversation = 'archive-toggle';
    // Re-rendering detaches this button, so the outside-click handler would otherwise close the list.
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      setShowArchived(!showArchived);
    });
    fragment.append(toggle);
  }
  $('conversation-list').replaceChildren(fragment);
  renderChatUnread();
  if (focused) $('conversation-list').querySelector(`[data-conversation="${focused}"]`)?.focus({ preventScroll: true });
  $('chat-title').textContent = selected ? conversationName(selected) : 'Conversations';
  if (selected?.kind === 'direct') $('chat-title').dataset.agentName = directAgent(selected);
  else delete $('chat-title').dataset.agentName;
  const isGroup = selected && selected.kind !== 'direct';
  $('conversation-symbol').hidden = !isGroup;
  $('conversation-meta').hidden = !isGroup;
  const members = isGroup
    ? selected.members.map((id) => (id === 'user' ? node('span', '', 'You') : agentReference(id)))
    : [];
  $('conversation-members').replaceChildren(
    ...members.flatMap((member, index) => (index ? [' · ', member] : [member])),
  );
  $('conversation-members').title = members.map((member) => member.textContent).join(' · ');
  $('invite-members').hidden = selected?.kind !== 'room';
  const prompt = selected
    ? `Message ${selected.kind === 'direct' ? '@' : '# '}${conversationName(selected)}${selected.kind === 'direct' ? ' privately' : ''}`
    : 'Choose a conversation';
  elements.input.placeholder = `${prompt}…`;
  $('message-label').textContent = prompt;
  elements.messages.setAttribute(
    'aria-label',
    selected ? `${conversationName(selected)} conversation` : 'Selected conversation',
  );
}

function renderConversationActivity(conversation) {
  const ticker = $('activity-ticker');
  const activity = conversationActivity(state.agents, conversation, state.conversations);
  const signature = activity
    .map(
      ({ id, type, verb, conversationName: busyIn, conversationKind }) =>
        `${id}:${type}:${type === 'current' ? verb : `${conversationKind || ''}:${busyIn || ''}`}`,
    )
    .join('|');
  if (signature === activitySignature) return;
  const atBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 70;
  activitySignature = signature;
  ticker.hidden = !activity.length;
  ticker.replaceChildren(
    ...activity.flatMap(({ id, type, verb, conversationName: busyIn, conversationKind }, index) => {
      const member = node('span', `activity-member${type === 'elsewhere' ? ' activity-member-elsewhere' : ''}`);
      member.append(agentName('span', 'activity-agent', id));
      if (type === 'elsewhere') {
        const location = conversationKind === 'direct' ? 'a direct chat' : busyIn;
        member.append(document.createTextNode(location ? ` busy in ${location}` : ' busy elsewhere'));
      } else {
        member.append(document.createTextNode(` ${verb}`));
        const dots = node('span', 'activity-dots', '···');
        dots.setAttribute('aria-hidden', 'true');
        member.append(dots);
      }
      return index ? [document.createTextNode(' '), member] : [member];
    }),
  );
  if (view === 'chat' && atBottom) scrollChat();
}

function renderChatUnread() {
  const unread = totalUnread(state.messages, listedConversations(), readThrough);
  for (const badge of [$('chat-unread'), $('conversation-unread')]) {
    badge.hidden = !unread;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  }
  document
    .querySelector('.rail-link[data-view="chat"]')
    .setAttribute('aria-label', unread ? `Team chat, ${unread} unread` : 'Team chat');
}

const viewLabels = { workspace: 'Overview', chat: 'Chat', brag: 'Brag doc' };
const viewPanes = { workspace: 'workspace', chat: 'team-chat', brag: 'brag-doc' };

function showView(next) {
  const changed = next !== view;
  if (changed) motion.cancelAll();
  view = next;
  const chat = view === 'chat';
  if (!chat) viewing = null;
  for (const [name, pane] of Object.entries(viewPanes)) $(pane).hidden = name !== view;
  for (const link of $$('.rail-link[data-view]')) {
    const active = link.dataset.view === view;
    link.classList.toggle('selected', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  $('view-label').textContent = viewLabels[view];
  if (chat && state) {
    markConversationRead();
    renderConversations();
    renderMessages();
    // A hidden log has no scroll extent, so its position must be restored once it is visible again.
    scrollChat();
  }
  if (view === 'brag') void loadBrag();
  if (changed) motion.play($(viewPanes[view]), 'panel');
}

let bragScale = 'day';
let bragData = null;
let bragVersion = 0;

async function loadBrag() {
  try {
    const files = await request('/api/brag');
    bragData = groupBrag(files);
    bragVersion += 1;
    $('brag-error').hidden = true;
    const skipped = files.skipped.map(({ file, reason }) => `${file}: ${reason}`);
    $('brag-skipped').hidden = !skipped.length;
    $('brag-skipped').textContent = skipped.length ? `Ignored files in the brag directory: ${skipped.join('; ')}` : '';
    renderBrag();
  } catch (error) {
    $('brag-error').textContent = error.message;
    $('brag-error').hidden = false;
  }
}

let renderedBrag = null;

// Pages embed references, so the view is rebuilt when the data, the scale or the known agents and tasks change,
// and not on other state updates, which would reset the scroll position.
function renderBrag() {
  if (!state || !bragData) return;
  const signature = `${bragScale}|${bragVersion}|${referenceSignature()}`;
  if (signature === renderedBrag) return;
  for (const button of $$('[data-brag-scale]')) {
    const active = button.dataset.bragScale === bragScale;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  $('brag-count').textContent = String(bragData[bragScale].length);
  // Pages come from agents: an image is not allowed, so a page cannot make the browser fetch anything.
  const pageElement = (source) =>
    markdownElement('brag-text', source, { resolveCode: codeReferenceElement, forbidTags: ['img'] });
  const sections = bragSections({ document, state, data: bragData, scale: bragScale, pageElement });
  $('brag-periods').replaceChildren(
    ...(sections.length ? sections : [node('p', 'brag-empty', emptyMessages[bragScale])]),
  );
  renderedBrag = signature;
}

for (const button of $$('[data-brag-scale]')) {
  button.addEventListener('click', () => {
    bragScale = button.dataset.bragScale;
    renderBrag();
  });
}

function navigate(next) {
  if (next === view) return;
  history.pushState(null, '', viewHashes[next]);
  showView(next);
}

// A reference inside a dialog brings its target to the page behind it, so the dialog gives way.
function closeDialogs() {
  for (const dialog of /** @type {NodeListOf<HTMLDialogElement>} */ (document.querySelectorAll('dialog[open]')))
    dialog.close();
}

function openConversation(id) {
  closeDialogs();
  selectConversation(id);
  navigate('chat');
  elements.input.focus();
}

// Messages arriving while the chat is hidden stay unread so the rail badge can surface them.
function markConversationRead() {
  if (view !== 'chat') {
    viewing = null;
    return;
  }
  const latest = Math.max(
    state.lastMessageIds[conversationId] ?? 0,
    conversationMessages(state.messages, conversationId).at(-1)?.id ?? 0,
  );
  readThrough.set(conversationId, latest);
  // The record lives in localStorage rather than on the server: it is the user's reading position in this browser,
  // tabs share it, and it needs no service restart. Another browser keeps its own position.
  const viewed =
    parseViewed(localStorage.getItem(viewedKey)) ?? baselineViewed(state.lastMessageIds, state.conversations);
  if (viewing !== conversationId) {
    viewing = conversationId;
    newBoundaries.set(conversationId, newMessageBoundary(viewed, conversationId));
    lastMessageSignature = '';
  }
  localStorage.setItem(viewedKey, JSON.stringify({ ...viewed, [conversationId]: latest }));
}

function selectConversation(id) {
  if (!state.conversations.some((conversation) => conversation.id === id)) {
    showError('chat-error', 'This conversation is unavailable.');
    return;
  }
  const changed = id !== conversationId;
  if (changed) motion.cancelAll();
  if (conversationId) drafts.set(conversationId, elements.input.value);
  conversationId = id;
  elements.input.value = drafts.get(id) ?? '';
  forceScroll = true;
  lastMessageSignature = '';
  $('mention-menu').hidden = true;
  $('mention-toggle').setAttribute('aria-expanded', 'false');
  showError('chat-error', '');
  void loadHistory(id);
  markConversationRead();
  renderConversations();
  renderMessages();
  updateInput();
  refreshBusyAgents();
  $('conversation-browser').open = false;
  if (changed && view === 'chat') motion.play(elements.messages, 'conversation');
}

function listItem(child) {
  const item = node('li');
  item.append(child);
  return item;
}

function inlineList(items) {
  return items.flatMap((item, index) => (index ? [document.createTextNode(', '), item] : [item]));
}

function taskItem(task) {
  return listItem(taskReference(task));
}

function renderMetrics() {
  const agents = state.agents.filter((agent) => visible('agents', agent));
  const summary = summarizeAgents(agents);
  $('active-count').textContent = summary.active;
  $('active-detail').textContent = `${summary.total} ${summary.total === 1 ? 'agent' : 'agents'} in your team`;
  const tasks = Array.isArray(state.tasks) ? state.tasks.filter((task) => visible('tasks', task)) : [];
  const working = tasksOfAgents(tasks, agents, ['working']);
  const attention = tasksOfAgents(tasks, agents, ['blocked', 'error']);
  $('active-list').replaceChildren(
    ...inlineList(
      agents
        .filter((agent) => ['idle', 'working', 'blocked'].includes(agent.status))
        .map((agent) => agentReference(agent.id)),
    ),
  );
  $('working-count').textContent = working.length;
  $('working-list').replaceChildren(...working.map(taskItem));
  $('attention-count').textContent = attention.length;
  $('attention-list').replaceChildren(...attention.map(taskItem));
  $('attention-detail').textContent = summary.attention ? 'Blocked or error' : 'No blockers';
  $('team-count').textContent = summary.total;
}

function runtimeIndicator(indicator) {
  const element = node('span', `runtime-indicator runtime-${indicator.key} runtime-${indicator.state}`);
  element.title = indicator.title;
  element.setAttribute('aria-label', indicator.title);
  if (indicator.percent !== undefined) {
    const meter = node('span', 'context-meter');
    const fill = node('span', indicator.percent >= 80 ? 'context-meter-fill high' : 'context-meter-fill');
    fill.style.width = `${indicator.percent}%`;
    meter.append(fill);
    element.append(meter);
  }
  element.append(node('span', '', indicator.text));
  return element;
}

function createAgentCard(agent) {
  const card = node('article', 'agent-card');
  card.dataset.agent = agent.id;
  const header = node('div', 'agent-card-header');
  const identity = node('div', 'agent-identity');
  identity.append(node('span', `agent-avatar ${agent.role}`, initials(agent.id)));
  const identityText = node('div');
  const name = agentName('h3', 'agent-name', agent.id);
  name.title = agent.id;
  identityText.append(name, node('p', 'agent-role', agent.role === 'lead' ? 'Team lead' : 'Worker agent'));
  identity.append(identityText);
  header.append(identity, node('span', `status-badge status-${agent.status}`, statusLabels[agent.status]));
  const task = node('details', 'agent-task-details');
  task.open = expandedAgentTasks.has(agent.id);
  task.append(node('summary', '', 'Task'), markdown('agent-task', agent.task || 'Ready for an assignment.'));
  task.addEventListener('toggle', () =>
    task.open ? expandedAgentTasks.add(agent.id) : expandedAgentTasks.delete(agent.id),
  );
  card.append(header, task);
  if (agent.lastError) card.append(markdown('agent-error', agent.lastError));
  const directory = node('p', 'agent-directory');
  directory.title = agent.cwd;
  directory.append(
    icon(['M2 5.5V15a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-7L8 4H3a1 1 0 0 0-1 1v.5Z']),
    node('span', '', agent.cwd),
  );
  card.append(directory);
  const footer = node('div', 'agent-card-footer');
  const runtime = agentRuntime(agent);
  const chips = [harnessChip(agent.adapter, runtime.harness), ...runtime.indicators.map(runtimeIndicator)];
  if (agent.pending > 0) chips.push(node('span', 'agent-note', `${agent.pending} queued`));
  if (agent.pid) chips.push(node('span', 'agent-note', `PID ${agent.pid}`));
  if (agent.sessionId) card.title = `Session ${agent.sessionId}`;
  const actions = node('div', 'agent-actions');
  const mention = iconButton('chat', 'Private chat', `Message ${agent.id}`);
  mention.dataset.action = 'mention';
  const stop = iconButton('stop', 'Stop', `Stop ${agent.id}`, 'stop');
  stop.dataset.action = 'stop';
  stop.disabled = agent.status === 'stopped';
  if (transcriptConversations(agent).length) {
    const transcript = iconButton('transcript', 'Transcript', `Show the transcript of ${agent.id}`);
    transcript.dataset.action = 'transcript';
    actions.append(transcript);
  }
  actions.append(mention, stop);
  footer.append(...chips, actions);
  card.append(footer);
  return card;
}

// The transcript viewer shows one harness session per conversation, newest turns first loaded.
// Everything from a transcript is untrusted: tool input and output are plain text, laid out by tools.js as text nodes only,
// and only assistant text is rendered as sanitized markdown.
let transcript = null;
const TRANSCRIPT_PAGE = 5;

function transcriptPath(suffix = '', params = {}) {
  const query = new URLSearchParams({ conversation: transcript.conversationId, ...params });
  return `/api/agents/${encodeURIComponent(transcript.agentId)}/transcript${suffix}?${query}`;
}

function formatTime(at) {
  if (!at) return '';
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
}

function plainText(className, text) {
  return node('pre', `transcript-pre ${className}`.trim(), text);
}

function truncation(entry, pre, turnIndex, entryIndex) {
  if (!entry.truncated) return [];
  const more = node('button', 'text-button transcript-more', `Show all ${entry.length.toLocaleString()} characters`);
  more.type = 'button';
  more.addEventListener('click', async () => {
    more.disabled = true;
    try {
      const full = await request(
        transcriptPath('/entry', {
          turn: turnIndex,
          entry: entryIndex,
          ...(entry.ref === undefined ? {} : { ref: entry.ref }),
        }),
      );
      pre.textContent = full.text;
      if (full.truncated)
        more.textContent = `Showing the first ${full.text.length.toLocaleString()} of ${full.length.toLocaleString()} characters`;
      else more.remove();
    } catch (error) {
      showError('transcript-error', `Could not load the full entry: ${error.message}`);
      more.disabled = false;
    }
  });
  return [more];
}

function collapsible(className, summary, entry, field, turnIndex, entryIndex, open = false) {
  const details = node('details', className);
  details.open = open;
  details.append(node('summary', '', summary));
  const pre = plainText('', entry[field]);
  details.append(pre, ...truncation(entry, pre, turnIndex, entryIndex));
  return details;
}

// Builds a view from tools.js. Every leaf is a text node; a view has no way to set markup or attributes.
// Only the tags tools.js uses are built, so a view that somehow carries transcript data fails instead of rendering it.
const VIEW_TAGS = new Set(['pre', 'code', 'span', 'div', 'ul', 'li']);
function viewElement(view) {
  if (typeof view === 'string') return document.createTextNode(view);
  if (!VIEW_TAGS.has(view.tag) || typeof view.className !== 'string' || !Array.isArray(view.children))
    throw new Error(`A tool view has an unexpected element: ${String(view.tag).slice(0, 40)}`);
  const element = node(view.tag, view.className);
  element.append(...view.children.map(viewElement));
  return element;
}

function toolCall(entry, turnIndex, entryIndex) {
  const call = node('div', 'transcript-entry transcript-call');
  call.title = formatTime(entry.at);
  const view = toolView(entry.name, entry.input, { partial: Boolean(entry.truncated) });
  const head = node('div', 'transcript-call-head');
  head.append(node('span', 'transcript-tool-name', entry.name));
  if (view.summary.length) {
    const summary = node('span', 'transcript-tool-summary');
    summary.append(
      ...view.summary.flatMap((part, index) =>
        [index ? document.createTextNode(' ') : null, viewElement(part)].filter(Boolean),
      ),
    );
    head.append(summary);
  }
  call.append(head, ...view.body.map(viewElement));
  if (entry.truncated) {
    call.append(
      node('p', 'transcript-hint', `Showing part of the input: ${entry.length.toLocaleString()} characters in total.`),
    );
    const more = node('button', 'text-button transcript-more', 'Show the full input');
    more.type = 'button';
    more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        const full = await request(
          transcriptPath('/entry', {
            turn: turnIndex,
            entry: entryIndex,
            ...(entry.ref === undefined ? {} : { ref: entry.ref }),
          }),
        );
        call.replaceWith(toolCall(full, turnIndex, entryIndex));
      } catch (error) {
        showError('transcript-error', `Could not load the full entry: ${error.message}`);
        more.disabled = false;
      }
    });
    call.append(more);
  }
  const raw = node('details', 'transcript-raw');
  raw.append(node('summary', '', 'Raw input'), plainText('', rawInput(view.input)));
  call.append(raw);
  return call;
}

function transcriptEntry(entry, turnIndex, entryIndex) {
  const time = formatTime(entry.at);
  if (entry.kind === 'prompt')
    return collapsible('transcript-entry transcript-prompt', 'Prompt', entry, 'text', turnIndex, entryIndex);
  if (entry.kind === 'text') {
    const wrapper = node(
      'div',
      `transcript-entry transcript-text${entry.role === 'user' ? ' transcript-user-text' : ''}`,
    );
    wrapper.title = time;
    wrapper.append(markdown('transcript-markdown', entry.text));
    if (entry.truncated)
      wrapper.append(
        node(
          'p',
          'transcript-hint',
          `Showing the first ${entry.text.length.toLocaleString()} of ${entry.length.toLocaleString()} characters.`,
        ),
      );
    return wrapper;
  }
  if (entry.kind === 'thinking') {
    if (entry.hidden)
      return node(
        'p',
        'transcript-entry transcript-thinking transcript-hint',
        'Thinking · the harness did not record its text',
      );
    return collapsible('transcript-entry transcript-thinking', 'Thinking', entry, 'text', turnIndex, entryIndex);
  }
  if (entry.kind === 'tool_call') return toolCall(entry, turnIndex, entryIndex);
  if (entry.kind === 'tool_result') {
    const size = entry.truncated ? entry.length : entry.text.length;
    return collapsible(
      `transcript-entry transcript-result${entry.isError ? ' error' : ''}`,
      `${entry.isError ? 'Error' : 'Result'}${entry.name ? ` · ${entry.name}` : ''} · ${size.toLocaleString()} characters`,
      entry,
      'text',
      turnIndex,
      entryIndex,
      entry.isError,
    );
  }
  if (entry.kind === 'compaction') {
    const marker = node('div', 'transcript-entry transcript-compaction');
    marker.append(node('span', '', `Context compacted${entry.detail ? ` · ${entry.detail}` : ''}`));
    if (entry.text) marker.append(collapsible('', 'Summary', entry, 'text', turnIndex, entryIndex));
    return marker;
  }
  return node('p', 'transcript-entry transcript-notice', entry.text);
}

function transcriptTurn(turn) {
  const section = node('section', 'transcript-turn');
  const heading = node('h3', 'transcript-turn-heading');
  heading.append(
    node(
      'span',
      '',
      turn.index === 0 && turn.messageId === null && turn.entries[0]?.kind !== 'prompt'
        ? 'Before the first prompt'
        : `Turn ${turn.index + 1}`,
    ),
  );
  if (turn.messageId !== null) heading.append(node('span', 'transcript-turn-message', `message #${turn.messageId}`));
  if (turn.at) heading.append(node('span', 'transcript-turn-time', formatTime(turn.at)));
  section.append(heading, ...turn.entries.map((entry, index) => transcriptEntry(entry, turn.index, index)));
  return section;
}

async function loadTranscript({ earlier = false } = {}) {
  const loading = transcript;
  showError('transcript-error', '');
  $('transcript-earlier').disabled = true;
  try {
    const params = { limit: TRANSCRIPT_PAGE };
    if (earlier) params.before = transcript.start;
    const page = await request(transcriptPath('', params));
    if (transcript !== loading) return;
    transcript.start = page.start;
    // The service counts masked secrets per page; the note counts them over every page shown.
    transcript.masked = (earlier ? transcript.masked : 0) + page.masked;
    const turns = page.turns.map(transcriptTurn);
    if (earlier) $('transcript-turns').prepend(...turns);
    else $('transcript-turns').replaceChildren(...turns);
    $('transcript-meta').textContent =
      `${adapterLabels[page.adapter] ?? page.adapter} · session ${page.sessionId} · ${page.turnCount} turn${page.turnCount === 1 ? '' : 's'} · ${formatBytes(page.bytes)} · ${page.file}`;
    const note = transcriptNote({ ...page, masked: transcript.masked });
    $('transcript-note').textContent = note;
    $('transcript-note').hidden = !note;
    $('transcript-earlier').hidden = page.start === 0;
    if (!page.turnCount)
      $('transcript-turns').replaceChildren(node('p', 'transcript-hint', 'This session has no turns yet.'));
    // Only the list scrolls: scrollIntoView would also scroll the page behind the dialog.
    const newest = $('transcript-turns').lastElementChild;
    if (!earlier && newest)
      $('transcript-turns').scrollTop +=
        newest.getBoundingClientRect().top - $('transcript-turns').getBoundingClientRect().top;
  } catch (error) {
    if (transcript !== loading) return;
    if (!earlier) {
      $('transcript-turns').replaceChildren();
      $('transcript-note').textContent = '';
      $('transcript-note').hidden = true;
      $('transcript-earlier').hidden = true;
    }
    showError('transcript-error', `Could not load the transcript: ${error.message}`);
  } finally {
    $('transcript-earlier').disabled = false;
  }
}

function openTranscript(agentId) {
  const agent = state.agents.find((item) => item.id === agentId);
  const conversations = transcriptConversations(agent);
  const conversationId = conversations.includes(agent.conversationId) ? agent.conversationId : conversations[0];
  transcript = { agentId, conversationId, start: 0 };
  $('transcript-title').textContent = `Transcript of ${agentId}`;
  $('transcript-meta').textContent = '';
  $('transcript-note').textContent = '';
  $('transcript-note').hidden = true;
  $('transcript-earlier').hidden = true;
  $('transcript-turns').replaceChildren();
  $('transcript-conversation').replaceChildren(
    ...conversations.map((id) => {
      const conversation = state.conversations.find((item) => item.id === id);
      const option = node('option', '', conversation ? conversationName(conversation) : id);
      option.value = id;
      return option;
    }),
  );
  $('transcript-conversation').value = conversationId;
  $('transcript-dialog').showModal();
  void loadTranscript();
}

// A batch replaces the records it changed and keeps the others, so a kept record keeps its card. Cards embed references,
// so they are all built again when the known agents or task titles change.
let agentCards = new WeakMap();
let agentCardsSignature = '';
function agentCard(agent) {
  const signature = referenceSignature();
  if (signature !== agentCardsSignature) {
    agentCards = new WeakMap();
    agentCardsSignature = signature;
  }
  let card = agentCards.get(agent);
  if (!card) {
    card = createAgentCard(agent);
    agentCards.set(agent, card);
  }
  return card;
}

function renderAgents() {
  const focused = /** @type {HTMLElement | null | undefined} */ (focusedElement()?.closest('[data-agent]'));
  const focusAction = focusedElement()?.dataset.action;
  const shown = filterAgents(
    state.agents.filter((agent) => visible('agents', agent)),
    filter,
    $('agent-search').value,
  );
  elements.grid.replaceChildren(...shown.map(agentCard));
  elements.grid.setAttribute('aria-busy', 'false');
  $('empty-state').hidden = shown.length > 0;
  const noAgents = state.agents.length === 0;
  $('empty-title').textContent = noAgents ? 'No agents yet' : 'No agents match this view';
  $('empty-description').textContent = noAgents
    ? 'Create a team lead or register an existing CLI agent to begin.'
    : !showArchived && archived.agents.size
      ? 'Try a different filter or search, or show archived agents retired after verified tasks.'
      : 'Try a different filter or search to see the rest of your team.';
  $('empty-new-agent').hidden = !noAgents;
  if (focused && focusAction) {
    elements.grid
      .querySelector(`[data-agent="${focused.dataset.agent}"] [data-action="${focusAction}"]`)
      ?.focus({ preventScroll: true });
  }
}

function renderWaiting() {
  const cards = Array.isArray(state.waiting) ? state.waiting : [];
  $('waiting-section').hidden = !cards.length;
  $('waiting-count').textContent = cards.length;
  $('waiting-list').replaceChildren(
    ...cards.map((card) => {
      const item = node('div', 'waiting-card');
      item.dataset.waiting = card.id;
      const reply = node('button', 'waiting-text', card.text);
      reply.type = 'button';
      reply.title = 'Reply to the lead about this';
      reply.addEventListener('click', () => replyToWaiting(card));
      item.append(reply);
      const task = state.tasks?.find((candidate) => candidate.id === card.taskId);
      if (task) {
        const open = node('button', 'waiting-task');
        open.type = 'button';
        open.title = task.title;
        open.setAttribute('aria-label', `Open task: ${task.title}`);
        open.innerHTML =
          '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 4H5a1.5 1.5 0 0 0-1.5 1.5v9A1.5 1.5 0 0 0 5 16h9a1.5 1.5 0 0 0 1.5-1.5V12M11 3.5h5.5V9M16.5 3.5 9 11"/></svg>';
        open.addEventListener('click', () => revealTask(task.id));
        item.append(open);
      }
      return item;
    }),
  );
}

const svgIcon = (paths) =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
// One icon per task status, and the expand and collapse arrows. The status name is the tooltip and the accessible name.
const taskIcons = {
  active: '<path d="m11.5 2-7 9h5l-1 7 7-10h-5l1-6Z"/>',
  ready: '<circle cx="10" cy="10" r="6.7"/><path d="M10 6.4V10l2.6 1.6"/>',
  verified:
    '<path d="M10 2.6 16 5v4.4c0 3.6-2.4 6.2-6 7.9-3.6-1.7-6-4.3-6-7.9V5l6-2.4Z"/><path d="m7.3 10 2 2 3.5-4"/>',
  expand: '<path d="M12 3h5v5M17 3l-5.5 5.5M8 17H3v-5M3 17l5.5-5.5"/>',
  collapse: '<path d="M17 8h-5V3M12 8l5.5-5.5M3 12h5v5M8 12l-5.5 5.5"/>',
};

const checkIcon =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 10.5 3.2 3.2L15 6.8"/></svg>';

// The focus list. Rendering is paused while the user types in a card or drags one, because a rebuilt list would drop the
// input or the dragged card; the next render after the gesture catches up.
const activityLaneNames = ['focus', 'control'];
let activityEditor = null;
let activityDrag = null;
let confirmingDelete = null;
let showActivityArchive = false;

// A dropped card moves on the page at once. The stream's next change of the list replaces the guess, and a failed
// request drops it, so a move that was not saved does not stay on screen.
let optimisticActivities = null;
const shownActivities = () => optimisticActivities ?? state.activities;

// Resolves to whether the change was saved; the stream then brings the saved list. A failure is shown on the page.
// Either way the list is drawn again, which closes the editor or the question that started the request.
async function activityRequest(path, method, body = {}) {
  try {
    await request(path, { method, body: JSON.stringify(body) });
    return true;
  } catch (error) {
    showError('page-error', `Could not update the focus list: ${error.message}`);
    optimisticActivities = null;
    return false;
  } finally {
    renderActivities();
  }
}

const changeActivity = (id, body) => activityRequest(`/api/activities/${encodeURIComponent(id)}`, 'PATCH', body);

function taskSquares(activity) {
  const squares = node('div', 'activity-squares');
  for (const taskId of activity.taskIds) {
    const task = state.tasks?.find((candidate) => candidate.id === taskId);
    if (!task) continue;
    const { state: kind, label } = taskSquare(task);
    const square = node('button', `task-square ${kind}`);
    square.type = 'button';
    square.dataset.task = task.id;
    square.setAttribute('aria-label', `${task.title} (${label.toLowerCase()})`);
    const tip = node('span', 'task-square-tip');
    tip.append(node('strong', '', task.title), node('span', '', label));
    square.append(tip);
    square.addEventListener('click', () => revealTask(task.id));
    squares.append(square);
  }
  return squares;
}

// Commits on Enter or blur, discards on Escape. An unchanged or empty entry makes no request.
function textEditor(initial, commit, cancel) {
  const input = node('input', 'activity-input');
  input.type = 'text';
  input.value = initial;
  input.maxLength = 200;
  input.setAttribute('aria-label', 'Activity text');
  let finished = false;
  const finish = (accept) => {
    if (finished) return;
    finished = true;
    activityEditor = null;
    const text = input.value.trim();
    if (accept && text && text !== initial) commit(text);
    else cancel();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
  return input;
}

function activityCard(activity) {
  const card = node('article', 'activity-card');
  card.dataset.activity = activity.id;
  card.draggable = true;
  const check = node('button', 'check-button activity-check');
  check.type = 'button';
  check.setAttribute('aria-label', `Check off: ${activity.text}`);
  check.title = 'Check off';
  check.innerHTML = checkIcon;
  check.addEventListener('click', async () => {
    if (await changeActivity(activity.id, { checked: true })) toast('Checked off. Find it in the archive.');
  });
  const body = node('div', 'activity-body');
  const text = node('span', 'activity-text', activity.text);
  text.title = 'Double-click to edit';
  text.addEventListener('dblclick', () => {
    activityEditor = { id: activity.id };
    card.draggable = false;
    const input = textEditor(activity.text, (value) => changeActivity(activity.id, { text: value }), renderActivities);
    text.replaceWith(input);
    input.focus();
    input.select();
  });
  body.append(text);
  if (activity.taskIds.length) body.append(taskSquares(activity));
  if (activity.id === confirmingDelete) {
    card.draggable = false;
    card.classList.add('confirming');
    body.append(deleteConfirmation(activity));
  }
  const remove = node('button', 'activity-delete', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Delete: ${activity.text}`);
  remove.title = 'Delete';
  remove.addEventListener('click', () => {
    confirmingDelete = activity.id;
    drawActivities();
    focusConfirmation('cancel');
  });
  card.append(check, body, remove);
  card.addEventListener('dragstart', (event) => {
    activityDrag = activity.id;
    card.classList.add('dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', activity.id);
    }
  });
  card.addEventListener('dragend', () => {
    activityDrag = null;
    clearDropMarks();
    renderActivities();
  });
  return card;
}

// Deleting asks first, on the card itself: a modal would take the user away from the list for a small action.
function deleteConfirmation(activity) {
  const box = node('div', 'activity-confirm');
  const cancel = node('button', 'text-button', 'Cancel');
  const confirm = node('button', 'text-button danger', 'Delete');
  cancel.dataset.confirm = 'cancel';
  confirm.dataset.confirm = 'delete';
  for (const button of [cancel, confirm]) button.type = 'button';
  cancel.addEventListener('click', () => {
    confirmingDelete = null;
    drawActivities();
  });
  confirm.addEventListener('click', async () => {
    confirmingDelete = null;
    await activityRequest(`/api/activities/${encodeURIComponent(activity.id)}`, 'DELETE');
  });
  box.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancel.click();
  });
  box.append(node('span', 'activity-confirm-text', 'Delete this activity?'), cancel, confirm);
  return box;
}

function focusConfirmation(which) {
  /** @type {HTMLElement | null} */ (document.querySelector(`.activity-confirm [data-confirm="${which}"]`))?.focus();
}

function newActivityCard(lane) {
  const card = node('article', 'activity-card editing');
  card.dataset.newActivity = lane;
  card.append(
    node('span', 'check-button activity-check placeholder'),
    textEditor('', (text) => activityRequest('/api/activities', 'POST', { text, lane }), renderActivities),
  );
  return card;
}

function clearDropMarks() {
  for (const element of $$('.activity-drop')) element.remove();
  for (const element of $$('.lane-cards.drop-target')) element.classList.remove('drop-target');
}

// Cards flow down each column in turn, like tasks and agents. A dropped card lands after every card in an earlier
// column and after every card above the pointer in its own column.
function dropTarget(container, clientX, clientY) {
  const columns = Number.parseInt(getComputedStyle(container).columnCount, 10) || 1;
  const area = container.getBoundingClientRect();
  const width = area.width / columns;
  const columnOf = (x) => (width > 0 ? Math.min(columns - 1, Math.max(0, Math.floor((x - area.left) / width))) : 0);
  const cards = [...container.querySelectorAll('.activity-card:not(.dragging)')];
  const column = columnOf(clientX);
  const index = cards.filter((card) => {
    const box = card.getBoundingClientRect();
    const cardColumn = columnOf(box.left + 1);
    return cardColumn < column || (cardColumn === column && clientY > box.top + box.height / 2);
  }).length;
  const next = cards[index]?.getBoundingClientRect();
  const previous = cards[index - 1]?.getBoundingClientRect();
  // The marker is a line above the card that follows the drop, or below the one before it.
  const line =
    next && columnOf(next.left + 1) === column
      ? { box: next, top: next.top - area.top - 6 }
      : previous
        ? { box: previous, top: previous.bottom - area.top + 4 }
        : { box: area, top: 0 };
  return { index, line: { top: line.top, left: line.box.left - area.left, width: line.box.width } };
}

function enableLaneDrop(container) {
  const lane = container.dataset.laneCards;
  container.addEventListener('dragover', (event) => {
    if (!activityDrag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    container.classList.add('drop-target');
    const { line } = dropTarget(container, event.clientX, event.clientY);
    const mark = node('div', 'activity-drop');
    Object.assign(mark.style, { top: `${line.top}px`, left: `${line.left}px`, width: `${line.width}px` });
    container.append(mark);
  });
  container.addEventListener('dragleave', (event) => {
    if (!container.contains(event.relatedTarget)) clearDropMarks();
  });
  container.addEventListener('drop', (event) => {
    if (!activityDrag) return;
    event.preventDefault();
    const id = activityDrag;
    const position = dropTarget(container, event.clientX, event.clientY).index + 1;
    activityDrag = null;
    clearDropMarks();
    const unchanged =
      laneActivities(shownActivities(), lane).findIndex((activity) => activity.id === id) + 1 === position;
    if (unchanged) {
      drawActivities();
      return;
    }
    optimisticActivities = moveActivity(shownActivities(), id, lane, position);
    drawActivities();
    // activityRequest reports its own failures, so the promise never rejects.
    void changeActivity(id, { lane, position });
  });
}

function renderActivities() {
  if (activityEditor || activityDrag) return;
  drawActivities();
}

function drawActivities() {
  const focusedConfirmation = focusedElement()?.closest('.activity-confirm') && focusedElement()?.dataset.confirm;
  const activities = shownActivities();
  if (!activities.some((activity) => activity.id === confirmingDelete && !activity.checkedAt)) confirmingDelete = null;
  const open = activities.filter((activity) => !activity.checkedAt);
  $('activities-count').textContent = open.length;
  for (const lane of activityLaneNames) {
    const container = document.querySelector(`[data-lane-cards="${lane}"]`);
    const cards = laneActivities(activities, lane).map(activityCard);
    if (activityEditor?.lane === lane) cards.push(newActivityCard(lane));
    container.replaceChildren(...cards);
    if (!cards.length)
      container.append(node('p', 'lane-empty', lane === 'focus' ? 'Nothing on you.' : 'Nothing to wait for.'));
  }
  if (focusedConfirmation) focusConfirmation(focusedConfirmation);
  const done = archivedActivities(activities);
  $('activity-archive-count').hidden = !done.length;
  $('activity-archive-count').textContent = String(done.length);
  $('activity-archive-toggle').setAttribute('aria-pressed', String(showActivityArchive));
  $('activity-archive').hidden = !showActivityArchive;
  $('activity-archive-empty').hidden = done.length > 0;
  $('activity-archive-list').replaceChildren(
    ...done.map((activity) => {
      const item = node('li', 'archive-item');
      item.dataset.archivedActivity = activity.id;
      const text = node('span', 'archive-text', activity.text);
      const when = node('time', 'archive-date', new Date(activity.checkedAt).toLocaleDateString());
      when.dateTime = activity.checkedAt;
      const restore = node('button', 'text-button', 'Restore');
      restore.type = 'button';
      restore.setAttribute('aria-label', `Restore: ${activity.text}`);
      restore.addEventListener('click', () => changeActivity(activity.id, { checked: false }));
      item.append(text, taskSquares(activity), when, restore);
      return item;
    }),
  );
}

for (const button of $$('[data-add-activity]')) {
  button.addEventListener('click', () => {
    if (activityEditor) return;
    activityEditor = { lane: button.dataset.addActivity };
    drawActivities();
    /** @type {HTMLElement | null} */ (document.querySelector('.activity-card.editing .activity-input'))?.focus();
  });
}
for (const container of $$('[data-lane-cards]')) enableLaneDrop(container);
$('activity-archive-toggle').addEventListener('click', () => {
  showActivityArchive = !showActivityArchive;
  renderActivities();
});

// The dropdown on a task card links the task to one open activity, or to none. A checked-off activity stays listed
// while the task is linked to it, so the picker never shows a value it has no option for.
let activityPickerId = 0;
function activityLink(task) {
  const current = activityOfTask(state.activities, task.id);
  const wrapper = node('span', 'activity-link');
  const select = createPicker(wrapper, {
    id: `activity-link-${(activityPickerId += 1)}`,
    label: `Activity of ${task.title}`,
    options: [
      ['', 'No activity'],
      ...(state.activities ?? [])
        .filter((activity) => !activity.checkedAt || activity.id === current?.id)
        .map((activity) => [activity.id, activity.checkedAt ? `${activity.text} (done)` : activity.text]),
    ],
    value: current?.id ?? '',
  });
  wrapper.querySelector('.picker-trigger').prepend(
    Object.assign(node('span', 'activity-link-icon'), {
      innerHTML:
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2l-.8.8M11.5 8.5a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l.8-.8"/></svg>',
    }),
  );
  // The trigger shows only the icon, so the linked activity is named by its tooltip and accessible name instead.
  const trigger = wrapper.querySelector('.picker-trigger');
  const named = current ? `Activity: ${current.text}` : 'Link to an activity';
  trigger.title = named;
  trigger.setAttribute('aria-label', `${named} (task: ${task.title})`);
  wrapper.classList.toggle('linked', Boolean(current));
  select.addEventListener('change', () => {
    if (select.value) void activityRequest(`/api/activities/${select.value}/tasks`, 'POST', { taskId: task.id });
    else void activityRequest(`/api/activities/${current.id}/tasks/${task.id}`, 'DELETE');
  });
  return wrapper;
}

// The quote tells the lead which decision the reply answers; the cursor waits on the line below it.
function replyToWaiting(card) {
  openConversation('dm-lead');
  if (conversationId !== 'dm-lead') return;
  const draft = elements.input.value.trimEnd();
  elements.input.value = `${draft ? `${draft}\n\n` : ''}> Re: ${card.text}\n\n`;
  elements.input.setSelectionRange(elements.input.value.length, elements.input.value.length);
  drafts.set('dm-lead', elements.input.value);
  updateInput();
}

function resultPreview(source) {
  return markdown('', source).textContent.replace(/\s+/g, ' ').trim();
}

let resultTaskId = null;
let resultOpener = '.task-expand';
let closingResult = false;

const resultControls = () => [...$('result-card').querySelectorAll('button, a[href]')];

// The dialog holds a second rendering of the card, rebuilt on every state update so it never goes stale.
// The card is rebuilt under the user's focus, so the focused control is found again by its position.
// A task that is no longer listed, deleted or filtered out, has no card to return to, so the dialog closes at once.
function renderResultDialog(listed) {
  if (!resultTaskId) return;
  const task = listed.find((item) => item.id === resultTaskId);
  if (!task) {
    $('result-dialog').close();
    // The card the browser would return focus to is gone; the task filters are the stable neighbours.
    /** @type {HTMLElement | null} */ (document.querySelector('[data-task-filter].active'))?.focus({
      preventScroll: true,
    });
    return;
  }
  const focused = resultControls().indexOf(document.activeElement);
  // Verify moves with the task's status, so it is found by name; the other controls by their position.
  const verifyFocused = /** @type {HTMLElement | null} */ (document.activeElement)?.classList.contains('task-verify');
  const scroll = $('result-card').scrollTop;
  $('result-card').replaceChildren(taskCard(task, true));
  $('result-card').scrollTop = scroll;
  // A control that an update removed, such as Verify after verification, hands focus to Collapse.
  if (focused >= 0) {
    const target = verifyFocused ? $('result-card').querySelector('.task-verify') : resultControls()[focused];
    (target ?? $('result-card').querySelector('.task-expand')).focus({ preventScroll: true });
  }
}

const cardRect = (id) =>
  $('task-list')
    .querySelector(`[data-task="${CSS.escape(id)}"]`)
    ?.getBoundingClientRect();

async function openResult(id, opener) {
  resultTaskId = id;
  resultOpener = opener;
  closingResult = false;
  const origin = cardRect(id);
  $('result-card').scrollTop = 0;
  renderResultDialog(state.tasks);
  $('result-dialog').showModal();
  await motion.expand($('result-dialog'), origin);
  $('result-card').querySelector('.task-expand')?.focus({ preventScroll: true });
}

async function closeResult() {
  if (!resultTaskId || closingResult) return;
  closingResult = true;
  const id = resultTaskId;
  await motion.expand($('result-dialog'), cardRect(id), { reverse: true });
  $('result-dialog').close();
  // The opener was replaced by state updates while the dialog was open, so the browser's own restoration has nothing to return to.
  $('task-list')
    .querySelector(`[data-task="${CSS.escape(id)}"] ${resultOpener}`)
    ?.focus({ preventScroll: true });
}

// Verifying also retries the lead's notification of a task that is already verified.
async function verifyTask(task, button) {
  button.disabled = true;
  showError('page-error', '');
  try {
    const result = await request(`/api/tasks/${encodeURIComponent(task.id)}/verify`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    toast(
      result.verificationNotice?.state === 'sent'
        ? 'Task verified. The lead has been notified.'
        : 'Task verified. Lead notification needs attention.',
    );
  } catch (error) {
    showError('page-error', `Could not verify task: ${error.message}`);
    button.disabled = false;
  }
}

// The same check mark as an activity's, so "done" looks alike on both.
function verifyIcon(task) {
  const button = node('button', 'check-button task-verify');
  button.type = 'button';
  button.title = 'Mark verified';
  button.setAttribute('aria-label', `Mark verified: ${task.title}`);
  button.innerHTML = checkIcon;
  button.addEventListener('click', () => verifyTask(task, button));
  return button;
}

function taskCard(task, expanded = false) {
  const card = node('article', expanded ? 'task-card expanded' : 'task-card');
  card.dataset.task = task.id;
  if (!expanded && task.id === revealedTask) {
    card.classList.add('revealed');
    card.tabIndex = -1;
  }
  const header = node('div', 'task-card-header');
  const toggle = node('button', 'task-expand');
  toggle.innerHTML = svgIcon(expanded ? taskIcons.collapse : taskIcons.expand);
  toggle.type = 'button';
  toggle.setAttribute('aria-label', expanded ? `Collapse ${task.title}` : `Expand ${task.title}`);
  toggle.title = expanded ? 'Collapse' : 'Expand';
  toggle.addEventListener('click', () => (expanded ? closeResult() : openResult(task.id, '.task-expand')));
  const title = node('h3', '', task.title);
  if (expanded) title.id = 'result-title';
  // Four circles in a fixed 2x2 grid: status and expand above, link and verify below. Each has its own cell, so a missing
  // control leaves its cell empty and the others stay put.
  const status = node('span', `task-status ${task.status}`);
  status.innerHTML = svgIcon(taskIcons[task.status]);
  status.title = taskStatusLabels[task.status];
  status.setAttribute('role', 'img');
  status.setAttribute('aria-label', `Status: ${taskStatusLabels[task.status]}`);
  const side = node('div', 'task-card-side');
  side.append(status, toggle);
  side.append(activityLink(task));
  if (task.status === 'ready') side.append(verifyIcon(task));
  header.append(title, side);
  card.append(header);
  if (task.description) card.append(markdown('task-description', task.description));
  if (task.result && expanded) {
    const result = node('section', 'task-result-full');
    result.append(node('h4', '', 'Result'), markdown('', task.result));
    card.append(result);
  } else if (task.result) {
    const open = node('button', 'task-result');
    open.type = 'button';
    open.setAttribute('aria-label', `Read the result of ${task.title}`);
    open.append(
      node('span', 'task-result-label', 'Result'),
      node('span', 'task-result-preview', resultPreview(task.result)),
      node('span', 'task-result-open', 'Read ↗'),
    );
    open.addEventListener('click', () => openResult(task.id, '.task-result'));
    card.append(open);
  }
  const assignment = node('div', 'task-assignment');
  const room = state.conversations.find((conversation) => conversation.id === task.conversationId);
  const roomButton = node('button', 'text-button', `# ${room?.name ?? task.conversationId}`);
  roomButton.type = 'button';
  roomButton.addEventListener('click', () => openConversation(task.conversationId));
  assignment.append(roomButton);
  for (const id of task.agentIds) assignment.append(agentReference(id, 'task-worker'));
  card.append(assignment);
  if (task.verificationNotice?.state === 'error')
    card.append(
      node('p', 'task-notification-error', `Verified, but the lead was not notified: ${task.verificationNotice.error}`),
    );
  const footer = node('div', 'task-card-footer');
  const retirement = node('p', 'task-retirement');
  if (task.status === 'verified') {
    retirement.textContent = `Verified ${new Date(task.verifiedAt).toLocaleString()}.`;
    if (task.retiredAgentIds.length)
      retirement.append(document.createTextNode(` Retired: ${task.retiredAgentIds.map((id) => `@${id}`).join(', ')}.`));
    for (const issue of task.retirementIssues ?? [])
      retirement.append(document.createTextNode(` @${issue.agentId}: ${issue.reason}.`));
    if (task.agentIds.length && !task.retiredAgentIds.length && !task.retirementIssues?.length)
      retirement.append(document.createTextNode(' Worker retirement is pending.'));
  } else if (task.status === 'active')
    retirement.textContent = `${task.agentIds.length} assigned ${task.agentIds.length === 1 ? 'worker' : 'workers'}`;
  if (retirement.textContent) footer.append(retirement);
  if (task.status === 'verified' && task.verificationNotice?.state !== 'sent') {
    const button = node('button', 'button primary', 'Retry lead notification');
    button.type = 'button';
    button.setAttribute('aria-label', `Retry lead notification for ${task.title}`);
    button.addEventListener('click', () => verifyTask(task, button));
    footer.append(button);
  }
  if (footer.children.length) card.append(footer);
  return card;
}

// A task card is rebuilt on every update, which would close an open activity dropdown under the pointer.
let tasksStale = false;
function renderTasks() {
  if (document.querySelector('.activity-link .picker.open')) {
    tasksStale = true;
    return;
  }
  tasksStale = false;
  $('task-section').hidden = false;
  if (!Array.isArray(state.tasks)) {
    $('task-count').textContent = '—';
    $('task-list').replaceChildren();
    $('task-notice').textContent = 'Task support is waiting for the server update.';
    return;
  }
  const listed = state.tasks.filter((task) => visible('tasks', task));
  $('task-count').textContent = listed.length;
  const tasks = listed
    .filter((task) => taskFilter === 'all' || task.status === taskFilter)
    .sort(
      (a, b) =>
        ({ ready: 0, active: 1, verified: 2 })[a.status] - { ready: 0, active: 1, verified: 2 }[b.status] ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const hiddenCount = state.tasks.length - listed.length;
  $('task-notice').textContent = tasks.length
    ? ''
    : !state.tasks.length
      ? 'No tasks yet. Send a request to the lead or start a worker with a task.'
      : hiddenCount && (taskFilter === 'all' || taskFilter === 'verified')
        ? `Verified tasks are archived. Turn on Show archived to see ${hiddenCount === 1 ? 'it' : `all ${hiddenCount}`}.`
        : 'No tasks match this view.';
  $('task-list').replaceChildren(...tasks.map((task) => taskCard(task)));
  renderResultDialog(tasks);
}

// Whatever closes the dropdown (a choice, Escape, a click elsewhere) is followed by one of these events.
for (const type of ['click', 'keydown', 'focusout'])
  $('task-list').addEventListener(type, () =>
    setTimeout(() => {
      if (tasksStale) renderTasks();
    }),
  );

function setTaskFilter(value) {
  taskFilter = value;
  for (const item of $$('[data-task-filter]')) {
    const active = item.dataset.taskFilter === value;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  }
  if (state) renderTasks();
}

function archivedCount() {
  return archived.tasks.size + archived.agents.size + archived.conversations.size;
}

function renderArchiveToggle() {
  const count = archivedCount();
  $('show-archived').checked = showArchived;
  $('archived-count').hidden = !count;
  $('archived-count').textContent = String(count);
  $('show-archived').setAttribute(
    'aria-label',
    count ? `Show archived (${count} ${count === 1 ? 'item' : 'items'})` : 'Show archived',
  );
}

function setShowArchived(value) {
  showArchived = value;
  localStorage.setItem(showArchivedKey, String(value));
  renderArchiveToggle();
  if (!state) return;
  renderMetrics();
  renderTasks();
  renderAgents();
  renderConversations();
  refreshBusyAgents();
}

function revealTask(id) {
  const task = state.tasks?.find((item) => item.id === id);
  if (!task) {
    toast(`Task ${id} is no longer available.`);
    return;
  }
  closeDialogs();
  revealedTask = id;
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    revealedTask = null;
    $('task-list').querySelector('.task-card.revealed')?.classList.remove('revealed');
  }, 2400);
  navigate('workspace');
  if (!visible('tasks', task)) setShowArchived(true);
  if (taskFilter !== 'all' && taskFilter !== task.status) setTaskFilter('all');
  else renderTasks();
  const card = $('task-list').querySelector(`[data-task="${CSS.escape(id)}"]`);
  card.scrollIntoView({ block: 'center', behavior: motion.scrollBehavior });
  card.focus({ preventScroll: true });
}

let revealedMessage = null;
let messageRevealTimer;

function applyMessageHighlight() {
  for (const [id, row] of messageRows) row.classList.toggle('revealed', id === revealedMessage);
}

// Opens the message's conversation when needed, then scrolls to the message and highlights it briefly.
// A reference to a message the dashboard does not hold names no conversation; Mu tells which one it is in.
async function revealMessage(id, targetConversationId) {
  closeDialogs();
  try {
    targetConversationId ??= (await request(`/api/messages/${id}`)).conversationId;
  } catch (error) {
    toast(`Message #${id} is not available: ${error.message}`);
    return;
  }
  if (targetConversationId !== conversationId) selectConversation(targetConversationId);
  if (conversationId !== targetConversationId) return;
  navigate('chat');
  try {
    await loadThrough(targetConversationId, id);
  } catch (error) {
    showError('chat-error', `Could not load message #${id}: ${error.message}`);
    return;
  }
  // The user may have moved on while the history loaded.
  if (conversationId !== targetConversationId) return;
  renderMessages();
  revealedMessage = id;
  applyMessageHighlight();
  clearTimeout(messageRevealTimer);
  messageRevealTimer = setTimeout(() => {
    revealedMessage = null;
    applyMessageHighlight();
  }, 2400);
  messageRows.get(id)?.scrollIntoView({ block: 'center', behavior: motion.scrollBehavior });
}

function dateLabel(date) {
  const today = new Date().toDateString();
  if (date.toDateString() === today) return 'Today';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

let messageRows = new Map();
let lastRenderedDay;

function messageRow(message, recipients) {
  const date = new Date(message.createdAt);
  const row = node(
    'article',
    isNewMessage(message, newBoundaries.get(conversationId) ?? Infinity) ? 'message new' : 'message',
  );
  const sender = message.from;
  const isUser = sender === 'user';
  row.append(
    node(
      'span',
      `message-avatar ${isUser ? 'user' : sender === 'system' ? 'system' : ''}`,
      isUser ? 'Y' : initials(sender),
    ),
  );
  const main = node('div', 'message-main');
  const header = node('div', 'message-header');
  header.append(
    isUser || sender === 'system'
      ? node('span', 'message-sender', isUser ? 'You' : sender)
      : agentName('span', 'message-sender', sender),
  );
  if (state.agents.some((agent) => agent.id === sender && agent.role === 'lead'))
    header.append(node('span', 'message-role', 'LEAD'));
  const time = node(
    'time',
    'message-time',
    new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date),
  );
  time.dateTime = message.createdAt;
  time.title = date.toLocaleString();
  header.append(time, node('span', 'message-id', `#${message.id}`));
  main.append(header, markdown('message-text', message.text, recipients));
  row.append(main);
  row.dataset.message = message.id;
  return row;
}

// Appends the rows of messages after those shown, each under its day; returns the new rows.
function appendMessageRows(parent, messages) {
  const recipients = ['all', ...(currentConversation()?.members ?? [])];
  /** @type {[number, HTMLElement][]} */
  const rows = [];
  for (const message of messages) {
    const day = new Date(message.createdAt).toDateString();
    if (day !== lastRenderedDay) {
      parent.append(node('div', 'message-day', dateLabel(new Date(message.createdAt))));
      lastRenderedDay = day;
    }
    const row = messageRow(message, recipients);
    rows.push([message.id, row]);
    parent.append(row);
  }
  return rows;
}

// A message that only follows those shown is appended; anything else rebuilds the log.
function renderMessages(arrivals = new Set()) {
  const messages = conversationMessages(state.messages, conversationId);
  const loading = Boolean(conversationId) && !historyLoaded(conversationId);
  const signature = `${conversationId}:${loading ? 'loading' : messages.map((message) => message.id).join(',')}`;
  const references = referenceSignature();
  $('chat-count').textContent = loading
    ? 'Loading messages'
    : `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`;
  if (signature === lastMessageSignature && references === lastReferenceSignature) return;
  const newMessages = signature !== lastMessageSignature;
  const atBottom = elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 70;
  const appending =
    references === lastReferenceSignature && messageRows.size > 0 && signature.startsWith(`${lastMessageSignature},`);
  /** @type {[number, HTMLElement][]} */
  let rows;
  if (appending) {
    rows = appendMessageRows(elements.messages, messages.slice(messageRows.size));
    for (const [id, row] of rows) messageRows.set(id, row);
  } else {
    const fragment = document.createDocumentFragment();
    lastRenderedDay = undefined;
    if (loading) fragment.append(node('div', 'chat-empty', 'Loading messages…'));
    else if (!messages.length) {
      const empty = node('div', 'chat-empty');
      empty.append(
        node('h3', '', 'No messages yet'),
        node(
          'p',
          '',
          currentConversation()?.kind === 'direct'
            ? 'Write directly to this agent.'
            : 'Mention a room member to start the conversation.',
        ),
      );
      fragment.append(empty);
    }
    rows = loading ? [] : appendMessageRows(fragment, messages);
    elements.messages.replaceChildren(fragment);
    messageRows = new Map(rows);
  }
  applyMessageHighlight();
  for (const [id, row] of rows) {
    const key = `message:${id}`;
    if (view === 'chat' && atBottom && arrivals.has(id)) motion.play(row, 'message', key);
    else motion.retarget(row, key);
  }
  lastMessageSignature = signature;
  lastReferenceSignature = references;
  if (atBottom || forceScroll) scrollChat();
  else if (newMessages) $('new-messages').hidden = false;
  if (!loading) forceScroll = false;
}

function scrollChat() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
  $('new-messages').hidden = true;
}

function renderStatusMotion(changes) {
  if (view !== 'workspace') return;
  for (const [kind, cardSelector, attribute, selector] of [
    ['agents', 'agent-card', 'agent', '.status-badge'],
    ['tasks', 'task-card', 'task', '.task-status'],
  ]) {
    for (const card of $$(`.${cardSelector}`)) {
      const id = card.dataset[attribute];
      const badge = card.querySelector(selector);
      const key = `${kind}:${id}`;
      if (changes[kind].has(id)) motion.play(badge, 'status', key);
      else motion.retarget(badge, key);
    }
  }
}

// Each part of the page is drawn again only when a batch touched the records it shows.
const allKinds = new Set(['agents', 'tasks', 'waiting', 'activities', 'conversations', 'messages', 'transport']);
function render(touched, changes = { messages: new Set(), agents: new Set(), tasks: new Set() }) {
  const has = (...kinds) => kinds.some((kind) => touched.has(kind));
  // Archiving follows verified tasks: their agents and rooms, and the private chats of those agents. Of an agent it
  // reads only the ID and role, which a status or usage update leaves as they were.
  const agentRoles = state.agents.map((agent) => `${agent.id}:${agent.role}`).join(',');
  if (has('tasks', 'conversations') || agentRoles !== archivedAgentRoles) {
    archivedAgentRoles = agentRoles;
    archived = archivedItems(state);
    renderArchiveToggle();
  }
  if (!conversationId) conversationId = defaultConversationId(state.conversations);
  if (conversationId && !histories.has(conversationId)) void loadHistory(conversationId);
  if (has('messages', 'conversations')) markConversationRead();
  if (has('waiting', 'tasks')) renderWaiting();
  if (has('activities', 'tasks')) renderActivities();
  if (has('agents', 'tasks')) renderMetrics();
  if (has('tasks', 'activities', 'conversations')) renderTasks();
  if (has('agents', 'tasks')) renderAgents();
  if (has('agents', 'tasks')) renderStatusMotion(changes);
  if (has('agents', 'tasks', 'conversations', 'messages')) renderConversations();
  if (has('agents', 'tasks', 'conversations', 'messages')) renderMessages(changes.messages);
  if (has('agents', 'tasks')) renderBrag();
  if (has('transport')) renderConnection();
  if (has('agents')) refreshBusyAgents();
  $('last-updated').textContent =
    `Updated ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date())}`;
  if (pageErrorFromState) showError('page-error', '');
  if (pendingSelection && state.conversations.some((conversation) => conversation.id === pendingSelection)) {
    const id = pendingSelection;
    pendingSelection = null;
    selectConversation(id);
  }
}

let archivedAgentRoles = null;

// A conversation created from this page is opened as soon as the stream lists it.
let pendingSelection = null;
function selectWhenListed(id) {
  pendingSelection = id;
  if (state) render(new Set());
}

let stream = { seq: 0 };
function applySnapshot(snapshot) {
  const previous = state;
  stream = { seq: snapshot.seq };
  state = {
    agents: snapshot.agents,
    tasks: snapshot.tasks,
    waiting: snapshot.waiting,
    activities: snapshot.activities,
    conversations: snapshot.conversations,
    transport: snapshot.transport,
    adapters: snapshot.adapters,
    lastMessageIds: snapshot.lastMessageIds,
    lastMessageId: Math.max(0, ...Object.values(snapshot.lastMessageIds)),
    messages: previous?.messages ?? [],
  };
  optimisticActivities = null;
  if (!previous)
    for (const conversation of state.conversations)
      readThrough.set(conversation.id, state.lastMessageIds[conversation.id] ?? 0);
  else
    for (const [id, last] of Object.entries(state.lastMessageIds)) {
      const held = Math.max(previous.lastMessageIds[id] ?? 0, readThrough.get(id) ?? 0);
      // A history that could not catch up would show a gap, so it is loaded again the next time it is shown.
      if (last > held)
        catchUp(id, held).catch((error) => {
          histories.delete(id);
          showStateError(`Could not load the missed messages: ${error.message}`);
        });
    }
  render(allKinds);
}

function applyBatch(batch) {
  // Batches are numbered without gaps on one stream; a gap means some were lost, and only a new snapshot can repair it.
  if (batch.seq !== stream.seq + 1) {
    resync();
    return;
  }
  stream.seq = batch.seq;
  const previous = state;
  const result = applyChanges(state, batch.changes);
  state = result.state;
  if (result.touched.has('activities')) optimisticActivities = null;
  render(result.touched, stateChanges(previous, state));
}

function updateInput() {
  const bytes = messageBytes(elements.input.value);
  $('message-length').textContent = `${bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`} / 64 KiB`;
  showError('message-size-error', bytes > 65536 ? 'This message exceeds the 64 KiB limit.' : '');
  renderConnection();
}

function insertMention(id) {
  const input = elements.input;
  const before = input.value.slice(0, input.selectionStart);
  const suffix = input.value.slice(input.selectionEnd);
  const prefix = before && !/\s$/.test(before) ? ' ' : '';
  const insertion = `${prefix}@${id} `;
  if (messageBytes(before + insertion + suffix) > 65536) {
    showError('chat-error', 'This message is too long to add another mention.');
    return;
  }
  input.value = before + insertion + suffix;
  input.focus();
  input.setSelectionRange(before.length + insertion.length, before.length + insertion.length);
  $('mention-menu').hidden = true;
  $('mention-toggle').setAttribute('aria-expanded', 'false');
  updateInput();
}

function openMentionMenu() {
  const menu = $('mention-menu');
  menu.hidden = !menu.hidden;
  $('mention-toggle').setAttribute('aria-expanded', String(!menu.hidden));
  if (menu.hidden) return;
  const entries = [
    { id: 'all', label: 'Everyone in this conversation' },
    ...state.agents
      .filter((agent) => currentConversation()?.members.includes(agent.id) && visible('agents', agent))
      .map((agent) => ({ id: agent.id, label: agent.role === 'lead' ? 'Team lead' : statusLabels[agent.status] })),
  ];
  menu.replaceChildren(
    ...entries.map((entry) => {
      const option = node('button', 'mention-option');
      option.type = 'button';
      option.append(entry.id === 'all' ? `@${entry.id}` : agentName('strong', '', entry.id, `@${entry.id}`));
      option.append(node('span', '', entry.label));
      option.addEventListener('click', () => insertMention(entry.id));
      return option;
    }),
  );
  menu.querySelector('button')?.focus();
}

const adapterHints = {
  codex: 'Runs Codex on this machine and resumes its session for follow-up messages.',
  claude: 'Runs Claude Code on this machine and resumes its session for follow-up messages.',
  manual: 'Registers an external agent. Start its CLI separately and use the chat commands in its skill.',
  demo: 'Runs a simulated agent for trying the dashboard. It does not use a model or change your code.',
};

function updateAdapterHint() {
  $('adapter-hint').textContent =
    adapterHints[$('agent-adapter').value] || 'Uses the configured command adapter on this machine.';
}

function updateRole() {
  const lead = $('agent-role').value === 'lead';
  $('agent-id').readOnly = lead;
  if (lead) $('agent-id').value = 'lead';
  else if ($('agent-id').value === 'lead') $('agent-id').value = '';
  $('agent-id').placeholder = lead ? 'lead' : 'e.g. api-worker';
  $('role-hint').textContent = lead ? 'Coordinates and delegates work.' : 'Works on a specific assignment.';
  updateTaskChoice();
}

function updateTaskChoice() {
  const lead = $('agent-role').value === 'lead';
  const task = state?.tasks?.find((item) => item.id === $('agent-task-record').value);
  $('agent-task-fields').hidden = lead;
  $('agent-task-record').disabled = lead;
  $('agent-task-title-label').hidden = lead || Boolean(task);
  $('agent-task-title').disabled = lead || Boolean(task);
  $('agent-conversation').disabled = lead || Boolean(task);
  if (task) $('agent-conversation').value = task.conversationId;
}

function openAgentDialog() {
  if (!state) return;
  elements.agentForm.reset();
  showError('agent-error', '');
  $('agent-role').value = state.agents.some((agent) => agent.role === 'lead') ? 'worker' : 'lead';
  $('agent-adapter').replaceChildren(
    ...state.adapters.map((adapter) => {
      const option = node('option', '', adapterLabels[adapter] || adapter);
      option.value = adapter;
      return option;
    }),
  );
  const newRoomOption = node('option', '', 'Create a task room');
  newRoomOption.value = '';
  $('agent-conversation').replaceChildren(
    newRoomOption,
    ...state.conversations
      .filter(
        (conversation) =>
          conversation.kind !== 'direct' &&
          conversation.members.includes('lead') &&
          visible('conversations', conversation),
      )
      .map((conversation) => {
        const option = node('option', '', `# ${conversation.name}`);
        option.value = conversation.id;
        return option;
      }),
  );
  const newTaskOption = node('option', '', 'Create a new task');
  newTaskOption.value = '';
  $('agent-task-record').replaceChildren(
    newTaskOption,
    ...(state.tasks ?? [])
      .filter((task) => task.status === 'active')
      .map((task) => {
        const option = node('option', '', task.title);
        option.value = task.id;
        return option;
      }),
  );
  if (currentConversation()?.kind === 'room') $('agent-conversation').value = conversationId;
  updateRole();
  updateAdapterHint();
  elements.dialog.showModal();
  ($('agent-id').readOnly ? $('agent-adapter') : $('agent-id')).focus();
}

function openRoomDialog(mode) {
  if (!state) return;
  roomDialogMode = mode;
  $('room-form').reset();
  showError('room-error', '');
  const inviting = mode === 'invite';
  const conversation = currentConversation();
  $('room-dialog-title').textContent = inviting ? `Invite to ${conversation.name}` : 'Create task room';
  $('room-dialog-description').textContent = inviting
    ? 'Selected agents will receive access to this room and its history.'
    : 'Choose the agents who will work together here. You can read and join every task room.';
  $('room-name-label').hidden = inviting;
  $('room-name').disabled = inviting;
  $('save-room').textContent = inviting ? 'Invite agents' : 'Create room';
  const available = state.agents.filter(
    (agent) => visible('agents', agent) && (!inviting || !conversation.members.includes(agent.id)),
  );
  $('room-member-options').replaceChildren(
    ...available.map((agent) => {
      const label = node('label', 'member-option');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'members';
      checkbox.value = agent.id;
      checkbox.checked = !inviting && agent.id === 'lead';
      label.append(checkbox, node('span', '', `@${agent.id}`), node('span', 'field-hint', statusLabels[agent.status]));
      return label;
    }),
  );
  $('room-members-hint').textContent = available.length
    ? 'You are included automatically. New workers can be assigned to this room when launched.'
    : inviting
      ? 'All registered agents are already members.'
      : 'No agents are registered yet. You can assign workers to this room later.';
  $('save-room').disabled = inviting && !available.length;
  $('room-dialog').showModal();
  (inviting ? ($('room-member-options').querySelector('input') ?? $('cancel-room-dialog')) : $('room-name')).focus();
}

$$('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    $$('[data-filter]').forEach((item) => {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    if (state) renderAgents();
  });
});
$$('[data-task-filter]').forEach((button) => {
  button.addEventListener('click', () => setTaskFilter(button.dataset.taskFilter));
});
$('agent-search').addEventListener('input', () => {
  if (state) renderAgents();
});
$('show-archived').addEventListener('change', () => setShowArchived($('show-archived').checked));
$('new-agent').addEventListener('click', openAgentDialog);
$('empty-new-agent').addEventListener('click', openAgentDialog);
$('close-dialog').addEventListener('click', () => elements.dialog.close());
$('cancel-dialog').addEventListener('click', () => elements.dialog.close());
$('agent-role').addEventListener('change', updateRole);
$('agent-task-record').addEventListener('change', updateTaskChoice);
$('agent-adapter').addEventListener('change', updateAdapterHint);
// The dialog has no padding of its own, so a click whose target is the dialog itself landed on the backdrop.
$('result-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget || event.target.closest('a.task-ref, a.message-ref')) void closeResult();
});
$('result-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  void closeResult();
});
$('result-dialog').addEventListener('close', () => {
  resultTaskId = null;
});
$('close-transcript').addEventListener('click', () => $('transcript-dialog').close());
$('transcript-dialog').addEventListener('close', () => {
  transcript = null;
});
$('transcript-reload').addEventListener('click', () => loadTranscript());
$('transcript-earlier').addEventListener('click', () => loadTranscript({ earlier: true }));
$('transcript-conversation').addEventListener('change', (event) => {
  transcript = { ...transcript, conversationId: event.target.value, start: 0 };
  $('transcript-turns').replaceChildren();
  void loadTranscript();
});
$('new-room').addEventListener('click', () => openRoomDialog('create'));
$('invite-members').addEventListener('click', () => openRoomDialog('invite'));
$('close-room-dialog').addEventListener('click', () => $('room-dialog').close());
$('cancel-room-dialog').addEventListener('click', () => $('room-dialog').close());
$('mention-toggle').addEventListener('click', () => {
  if (state) openMentionMenu();
});
for (const link of $$('.rail-link[data-view]')) {
  link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(link.dataset.view);
  });
}
window.addEventListener('hashchange', () => showView(viewFromHash(location.hash)));
$('new-messages').addEventListener('click', scrollChat);
elements.messages.addEventListener('scroll', () => {
  if (elements.messages.scrollHeight - elements.messages.scrollTop - elements.messages.clientHeight < 70)
    $('new-messages').hidden = true;
});
elements.input.addEventListener('input', updateInput);
elements.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!$('send-message').disabled) $('message-form').requestSubmit();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('conversation-browser').open) {
    $('conversation-browser').open = false;
    $('conversation-browser').querySelector('summary').focus();
  }
  if (event.key === 'Escape' && !$('mention-menu').hidden) {
    $('mention-menu').hidden = true;
    $('mention-toggle').setAttribute('aria-expanded', 'false');
    $('mention-toggle').focus();
  }
});
document.addEventListener('click', (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (!target.closest('#conversation-browser')) $('conversation-browser').open = false;
  if (!target.closest('.composer-box')) {
    $('mention-menu').hidden = true;
    $('mention-toggle').setAttribute('aria-expanded', 'false');
  }
});

elements.grid.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = button.closest('[data-agent]').dataset.agent;
  if (button.dataset.action === 'mention') {
    openConversation(`dm-${id}`);
    return;
  }
  if (button.dataset.action === 'transcript') {
    openTranscript(id);
    return;
  }
  button.disabled = true;
  showError('page-error', '');
  try {
    await request(`/api/agents/${encodeURIComponent(id)}/stop`, { method: 'POST', body: JSON.stringify({}) });
    toast(`${id} stopped.`);
  } catch (error) {
    showError('page-error', `Could not stop ${id}: ${error.message}`);
    button.disabled = false;
  }
});

$('message-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = elements.input.value;
  if (!text.trim() || sending || !conversationId || messageBytes(text) > 65536) return;
  const sentConversationId = conversationId;
  sending = true;
  renderConnection();
  showError('chat-error', '');
  try {
    await request('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ conversationId: sentConversationId, text }),
    });
    drafts.delete(sentConversationId);
    if (conversationId === sentConversationId) {
      elements.input.value = '';
      forceScroll = true;
    }
  } catch (error) {
    showError('chat-error', `Message not sent: ${error.message}`);
  } finally {
    sending = false;
    updateInput();
    elements.input.focus();
  }
});

elements.agentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('agent-error', '');
  const button = $('create-agent');
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(elements.agentForm));
    if (values.role === 'lead') {
      values.conversationId = `dm-${values.id}`;
      delete values.taskId;
      delete values.taskTitle;
    } else {
      if (!Array.isArray(state.tasks))
        throw new Error('Task support is not available from the server yet. Wait for the service update.');
      values.conversationId = $('agent-conversation').value;
      if (values.taskId) {
        delete values.taskTitle;
      } else {
        delete values.taskId;
        if (!values.conversationId) {
          const room = await request('/api/conversations', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'room',
              name: values.taskTitle.slice(0, 80),
              members: ['lead'],
              sourceConversationId: 'dm-lead',
            }),
          });
          values.conversationId = room.id;
          const option = node('option', '', `# ${room.name}`);
          option.value = room.id;
          $('agent-conversation').append(option);
          $('agent-conversation').value = room.id;
        }
      }
    }
    await request('/api/agents', { method: 'POST', body: JSON.stringify(values) });
    elements.dialog.close();
    toast(`${values.id} joined your team.`);
    selectWhenListed(values.conversationId ?? `dm-${values.id}`);
  } catch (error) {
    showError('agent-error', `Could not start agent: ${error.message}`);
  } finally {
    button.disabled = false;
  }
});

$('room-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('room-error', '');
  const button = $('save-room');
  button.disabled = true;
  const data = new FormData($('room-form'));
  const members = data.getAll('members');
  const inviting = roomDialogMode === 'invite';
  try {
    if (inviting && !members.length) throw new Error('Select at least one agent.');
    const path = inviting ? `/api/conversations/${encodeURIComponent(conversationId)}/members` : '/api/conversations';
    const body = inviting
      ? { members }
      : {
          kind: 'room',
          name: data.get('name'),
          members,
          ...(conversationId ? { sourceConversationId: conversationId } : {}),
        };
    const conversation = await request(path, { method: 'POST', body: JSON.stringify(body) });
    $('room-dialog').close();
    toast(inviting ? 'Agents invited.' : 'Room created.');
    selectWhenListed(conversation.id);
  } catch (error) {
    showError('room-error', error.message);
  } finally {
    button.disabled = false;
  }
});

showView(view);
renderArchiveToggle();
renderConnection();

function showUnavailable(message) {
  showStateError(message);
  $('empty-title').textContent = 'The workspace is unavailable';
  $('empty-description').textContent = userToken
    ? 'Check that the Mu server is running. This page will reconnect when it becomes available.'
    : signInHelp;
}

// The stream reconnects by itself and names the last batch it received, so Mu sends only what it missed. The browser
// gives up when Mu refuses the stream, for example for an unknown credential; the reason then comes from a plain request.
let events = null;
function connect() {
  events = new EventSource(`/api/events?token=${encodeURIComponent(userToken)}`);
  events.addEventListener('open', () => {
    streamConnected = true;
    renderConnection();
  });
  events.addEventListener('snapshot', (/** @type {MessageEvent} */ event) => {
    try {
      applySnapshot(JSON.parse(event.data));
    } catch (error) {
      showStateError(`Could not read the workspace: ${error.message}`);
    }
  });
  events.addEventListener('changes', (/** @type {MessageEvent} */ event) => {
    try {
      applyBatch(JSON.parse(event.data));
    } catch (error) {
      showStateError(`Could not read the workspace update: ${error.message}`);
    }
  });
  events.addEventListener('error', () => {
    streamConnected = false;
    renderConnection();
    if (events.readyState !== EventSource.CLOSED) return;
    request('/api/service').then(
      () => showUnavailable('Live updates stopped. Reload the page to connect again.'),
      (error) => showUnavailable(`Could not load the workspace: ${error.message}`),
    );
  });
}

// A new stream names no batch, so Mu starts it with a snapshot.
function resync() {
  events.close();
  connect();
}

// Without a credential the stream could only fail and retry, so it is not opened.
if (userToken) connect();
else showUnavailable(`Could not load the workspace: This browser is not signed in. ${signInHelp}`);
