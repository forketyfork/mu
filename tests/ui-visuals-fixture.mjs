// What the tests of the Visuals view share: the records of a visual as the service sends them, and a dashboard whose
// requests for a visual and its comments are answered here.
import { createdAt, fixture, initialState } from './ui-fixture.mjs';

export const ID = 'vis-0a1b2c3d';
export const record = (overrides = {}) => ({
  id: ID,
  title: 'Storage plan',
  agentId: 'lead',
  conversationId: 'room-a',
  sessionId: 'session-1',
  taskId: 'task-a',
  version: 2,
  revision: 3,
  commentRevision: 0,
  draftComments: 0,
  openComments: 0,
  sectionCount: 2,
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});
export const section = (id, rev, title = id) => ({ id, title, rev, body: `Text of ${id}` });
export const versionOf = (visual, number, sections, changes = {}) => ({
  ...visual,
  shown: {
    number,
    title: visual.title,
    createdAt,
    updatedAt: createdAt,
    sections,
    changed: [],
    added: [],
    removed: [],
    comments: [],
    answers: [],
    ...changes,
  },
  versions: Array.from({ length: visual.version }, (_, index) => ({
    number: index + 1,
    createdAt,
    updatedAt: createdAt,
    comments: 0,
  })),
});
export const withVisuals = (...visuals) => ({ ...initialState(), visuals });

// The dashboard with a service that answers the requests for a visual, and a frame whose messages the test reads
// and writes: JSDOM does not load the frame's page.
export async function viewer(t, { hash = '', visuals = [record()], versions }) {
  const ui = await fixture(t, { initial: withVisuals(...visuals) });
  // `comments` holds the comments as the service would; `failSend` makes the next send fail with that message.
  const served = { versions, comments: [], failSend: null };
  const fetch = ui.window.fetch;
  const asked = [];
  // The requests that change comments, as `[method, path, body]`.
  const calls = [];
  const answer = (status, body) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
  const now = '2026-11-04T11:00:00Z';
  function commentRequest(method, id, input) {
    if (method === 'POST' && id === undefined) {
      const comment = {
        id: `vc-${String(served.comments.length + 1).padStart(8, '0')}`,
        visualId: ID,
        version: input.version,
        sectionId: input.sectionId,
        sectionRev: input.sectionRev ?? null,
        block: input.block,
        quote: input.quote,
        text: input.text,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        sentAt: null,
        messageId: null,
        answeredIn: null,
      };
      served.comments.push(comment);
      return answer(201, comment);
    }
    if (method === 'POST' && id === 'send') {
      if (served.failSend) return answer(503, { error: served.failSend });
      const sent = served.comments.filter(
        (comment) =>
          comment.status === 'draft' && comment.version === input.version && (input.ids?.includes(comment.id) ?? true),
      );
      for (const comment of sent) Object.assign(comment, { status: 'sent', sentAt: now, messageId: 7 });
      return answer(200, { messageId: 7, comments: sent });
    }
    const comment = served.comments.find((item) => item.id === id);
    if (method === 'PATCH') {
      comment.text = input.text;
      return answer(200, comment);
    }
    served.comments.splice(served.comments.indexOf(comment), 1);
    return answer(200, { removed: id });
  }
  ui.window.fetch = async (path, options = {}) => {
    const comment = /^\/api\/visuals\/vis-[0-9a-f]{8}\/comments(?:\/([^/]+))?$/.exec(path);
    if (comment) {
      const input = JSON.parse(options.body);
      calls.push([options.method, path.replace(`/api/visuals/${ID}`, ''), input]);
      return commentRequest(options.method, comment[1], input);
    }
    const match = /^\/api\/visuals\/(vis-[0-9a-f]{8})(?:\?version=(\d+))?$/.exec(path);
    if (!match) return fetch(path, options);
    asked.push(path);
    const body = served.versions[match[2] ?? 'latest'];
    if (!body) return answer(404, { error: `${match[1]} has no version ${match[2]}` });
    // The comments that the test put into the version itself, and those made through the requests above.
    const made = served.comments.filter((item) => item.version === body.shown.number);
    return answer(200, { ...body, shown: { ...body.shown, comments: [...body.shown.comments, ...made] } });
  };
  const frame = () => ui.window.document.querySelector('iframe.visual-frame');
  // What the dashboard sends to the frame: the content and the like in `posted`, the marks of the comments apart.
  const posted = [];
  const marks = [];
  const attach = () => {
    frame().contentWindow.postMessage = (data, targetOrigin) =>
      (data.type === 'comments' ? marks : posted).push({ ...data, targetOrigin });
  };
  const fromFrame = (data, source = frame().contentWindow) =>
    ui.window.dispatchEvent(new ui.window.MessageEvent('message', { data, source }));
  if (hash) {
    ui.window.location.hash = hash;
    await new Promise((resolve) => ui.window.addEventListener('hashchange', resolve, { once: true }));
  }
  return { ...ui, served, asked, calls, frame, posted, marks, attach, fromFrame };
}
