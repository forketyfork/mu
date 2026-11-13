import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import * as model from '../public/model.js';
import { decorateMarkdown, sanitizeMarkdown } from '../public/markdown-core.js';
import { createMotion, stateChanges, themeValue } from '../public/motion.js';
import * as tools from '../public/tools.js';
import * as picker from '../public/picker.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const themes = await readFile(new URL('../public/themes.js', import.meta.url), 'utf8');
export const createdAt = '2026-11-04T10:00:00Z';
export const message = (id, conversationId = 'dm-lead') => ({
  id,
  conversationId,
  from: 'lead',
  text: `Message ${id}`,
  createdAt,
});
export const initialState = () => ({
  agents: [
    { id: 'lead', role: 'lead', adapter: 'manual', status: 'idle', task: 'Coordinate', cwd: '/project', createdAt },
  ],
  tasks: [
    {
      id: 'task-a',
      title: 'Review changes',
      status: 'active',
      agentIds: ['lead'],
      retiredAgentIds: [],
      conversationId: 'room-a',
      createdAt,
    },
  ],
  conversations: [
    { id: 'dm-lead', kind: 'direct', members: ['user', 'lead'] },
    { id: 'room-a', name: 'Review changes', kind: 'room', members: ['user', 'lead'] },
  ],
  messages: [message(1), message(2, 'room-a')],
  transport: { connected: true },
  adapters: ['manual'],
});

const lastMessageIds = (messages) => {
  const ids = {};
  for (const message of messages) ids[message.conversationId] = Math.max(ids[message.conversationId] ?? 0, message.id);
  return ids;
};

// The snapshot that Mu's event stream starts with, for a workspace given in the shape of GET /api/state.
export function snapshotOf(full, seq = 0) {
  return {
    epoch: 'fixture0',
    seq,
    ...Object.fromEntries(model.recordKinds.map((kind) => [kind, full[kind] ?? []])),
    lastMessageIds: lastMessageIds(full.messages ?? []),
    transport: full.transport,
    adapters: full.adapters,
  };
}

// The changes of one stream batch that turn one workspace into the next, as Mu's stream sends them: whole records that
// differ, null for removed records, and new messages.
export function changesBetween(previous, next) {
  const changes = [];
  for (const kind of model.recordKinds) {
    const before = new Map((previous[kind] ?? []).map((item) => [item.id, JSON.stringify(item)]));
    const after = next[kind] ?? [];
    const present = new Set(after.map((item) => item.id));
    for (const id of before.keys()) if (!present.has(id)) changes.push({ kind, id, value: null });
    for (const item of after)
      if (before.get(item.id) !== JSON.stringify(item)) changes.push({ kind, id: item.id, value: item });
  }
  const known = new Set((previous.messages ?? []).map((message) => message.id));
  for (const message of next.messages ?? [])
    if (!known.has(message.id)) changes.push({ kind: 'messages', id: String(message.id), value: message });
  if (JSON.stringify(previous.transport) !== JSON.stringify(next.transport))
    changes.push({ kind: 'transport', value: next.transport });
  return changes;
}

const reply = (status, body) => ({ ok: status < 400, status, json: async () => structuredClone(body) });

// Answers the history requests of the dashboard from a workspace in the shape of GET /api/state.
export function historyReply(full, path) {
  const url = new URL(path, 'http://localhost');
  const single = /^\/api\/messages\/(\d+)$/.exec(url.pathname);
  if (single) {
    const message = full.messages.find((item) => item.id === Number(single[1]));
    return message ? reply(200, message) : reply(404, { error: `Unknown message ${single[1]}` });
  }
  const history = /^\/api\/conversations\/([^/]+)\/messages$/.exec(url.pathname);
  if (!history) return null;
  const limit = Number(url.searchParams.get('limit') ?? 300);
  const before = Number(url.searchParams.get('before') ?? Infinity);
  const after = Number(url.searchParams.get('after') ?? -1);
  const messages = full.messages.filter(
    (message) => message.conversationId === decodeURIComponent(history[1]) && message.id < before && message.id > after,
  );
  return reply(200, { messages: url.searchParams.has('after') ? messages.slice(0, limit) : messages.slice(-limit) });
}

// Lets pending requests and the renders that follow them finish.
export async function settle() {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Runs the dashboard in JSDOM against a server state and a controllable event stream. `initial` and every `push` take
// the whole workspace in the shape of GET /api/state; the fixture sends it as Mu's stream would, a snapshot first and then
// the changes, and answers history requests from the workspace last pushed.
export async function fixture(t, { reduced = false, hash = '', initial = initialState() } = {}) {
  const { window } = new JSDOM(html, {
    url: `http://localhost/?token=${'b'.repeat(64)}${hash}`,
    runScripts: 'outside-only',
  });
  t.after(() => window.close());
  window.eval(themes);
  const preference = new window.EventTarget();
  preference.matches = reduced;
  const animations = [];
  const scrolls = [];
  window.CSS = {
    escape(value) {
      assert.match(value, /^[a-z0-9-]+$/);
      return value;
    },
  };
  window.Element.prototype.scrollIntoView = function (options) {
    scrolls.push({ element: this, options });
  };
  window.Element.prototype.animate = function (frames, options) {
    const animation = new window.EventTarget();
    animation.effect = { target: this };
    animation.id = options.id;
    animation.cancel = () => {
      animation.cancelled = true;
      animation.dispatchEvent(new window.Event('cancel'));
    };
    animations.push(animation);
    return animation;
  };
  window.matchMedia = () => preference;
  let events;
  let current = structuredClone(initial);
  let seq = 0;
  const requests = [];
  const streams = [];
  const Target = /** @type {typeof EventTarget} */ (window.EventTarget);
  class FakeEventSource extends Target {
    static CLOSED = 2;
    readyState = 0;
    constructor(url) {
      super();
      events = this;
      streams.push(this);
      requests.push({ path: url, stream: true });
      // Like Mu, a stream that names no earlier batch starts with a snapshot.
      setImmediate(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.dispatchEvent(new window.Event('open'));
        this.dispatchEvent(new window.MessageEvent('snapshot', { data: JSON.stringify(snapshotOf(current, seq)) }));
      });
    }
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = /** @type {any} */ (FakeEventSource);
  window.fetch = async (path, options) => {
    requests.push({ path, options });
    return historyReply(current, path) ?? reply(200, initial);
  };
  window.TextEncoder = TextEncoder;
  const purifier = createDOMPurify(window);
  // JSDOM has no module loader. Execute the application with its real module dependencies supplied here.
  Object.assign(window, model, tools, picker, {
    stateChanges,
    themeValue,
    createMotion: () => createMotion(preference),
    markdownElement(className, source, options) {
      const element = window.document.createElement('div');
      element.className = `markdown-body ${className}`;
      element.innerHTML = sanitizeMarkdown(source, { parse: marked.parse, sanitize: purifier.sanitize });
      decorateMarkdown(element, options);
      return element;
    },
  });
  window.eval(app.replace(/^import [^;]+;$/gm, ''));
  await settle();
  const $ = (selector) => window.document.querySelector(selector);
  assert.equal($('#page-error').hidden, true, $('#page-error').textContent);
  // A push that changes nothing sends no batch, as on Mu's stream.
  const push = (next) => {
    const changes = changesBetween(current, next);
    current = structuredClone(next);
    if (!changes.length) return;
    seq += 1;
    events.dispatchEvent(new window.MessageEvent('changes', { data: JSON.stringify({ seq, changes }) }));
  };
  return {
    window,
    $,
    preference,
    animations,
    scrolls,
    requests,
    streams,
    push,
    settle,
    // Changes the workspace that history requests read, without sending a batch, as while the stream is down.
    serve(next) {
      current = structuredClone(next);
    },
    // Sends a batch as it is, for tests of the stream itself.
    send(event, data) {
      events.dispatchEvent(new window.MessageEvent(event, { data: JSON.stringify(data) }));
    },
    click: (selector) => $(selector).click(),
    update(next) {
      push(next);
      assert.equal($('#page-error').hidden, true, $('#page-error').textContent);
    },
  };
}
