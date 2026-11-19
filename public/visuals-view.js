// The Visuals view: the list of visuals, and the viewer around the sandboxed frame that draws one. The frame shows
// content written by agents and is not trusted, so everything here that names the author, switches versions or opens
// a link is drawn by the dashboard, and a message from the frame is checked before it is used. See "Visuals" in
// docs/architecture.md.

import { createAnswersPanel } from './visual-answers.js';
import { createCommentsPanel } from './visual-comments.js';

export const FRAME_PAGE = '/visual/frame.html';
const LEAD_TITLE = 'Introduction';
const MAX_LINK = 2000;
const MAX_PROBLEMS = 50;

/** The theme's tokens, as the theme script set them on the root element. */
export function themeTokens(root) {
  const tokens = {};
  for (const name of root.style) if (name.startsWith('--')) tokens[name.slice(2)] = root.style.getPropertyValue(name);
  return tokens;
}

/**
 * The sections that the reader sees: the service names those that the user's answers hide, and the frame never gets
 * their text.
 */
export const visibleSections = (shown) =>
  shown.sections.filter((section) => !(shown.hidden ?? []).includes(section.id));

/** The sections of `next` to mark as just changed, given the sections shown before it. */
export function changedSections(previous, next) {
  const before = new Map(previous.map((section) => [section.id, section.rev]));
  return next.filter((section) => before.get(section.id) !== section.rev).map((section) => section.id);
}

// A link from a visual opens only as a web page or a mail address, and only after the user saw where it leads.
export function safeLink(href) {
  if (typeof href !== 'string' || href.length > MAX_LINK) return null;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
}

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {Window} options.window
 * @param {(path: string, options?: object) => Promise<any>} options.request
 * @param {() => any} options.getState
 * @param {(id: string, className?: string) => HTMLElement} options.agentReference
 * @param {(task: object) => HTMLElement} options.taskReference
 * @param {(id: string, version?: number | null) => void} options.navigate Shows a visual, or the list for a null ID.
 * @param {(id: string, version?: number | null) => string} options.hashOf
 * @param {(agent: object) => boolean} options.isBusy
 * @param {() => boolean} options.showArchived Whether the user asked to see archived items; the dashboard's one switch.
 * @param {(show: boolean) => void} options.setShowArchived
 * @param {(message: string) => void} options.notify Tells the user something that was done for them, for a few seconds.
 * @param {(key: any) => void} options.onKey Receives a key that the frame took from the browser, as the frame sent it.
 */
export function createVisualsView({
  document,
  window,
  request,
  getState,
  agentReference,
  taskReference,
  navigate,
  hashOf,
  isBusy,
  showArchived,
  setShowArchived,
  notify,
  onKey,
}) {
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const time = (at) =>
    new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
      new Date(at),
    );
  const plainClick = (event) =>
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

  // What the viewer shows: the visual, the version the user pinned (null follows the newest), the content last
  // loaded, and whether the frame has asked for content.
  /** @type {{ id: string, pinned: number | null, data: any, ready: boolean, loads: number, active: string | null, turn: number | null } | null} */
  let open = null;
  /** @type {HTMLIFrameElement | null} */
  let frame = null;
  let indexSignature = null;

  const record = (id) => (getState()?.visuals ?? []).find((visual) => visual.id === id);
  // The author as the comments need it: its status, the message that its running turn is on, and who takes the
  // feedback when it cannot run: a lead of the visual's conversation that can.
  /** @returns {import('./visual-delivery.js').Author} */
  const authorOf = (/** @type {any} */ visual) => {
    const { agents, conversations } = getState();
    const agent = agents.find((item) => item.id === visual.agentId);
    const members = conversations?.find((item) => item.id === visual.conversationId)?.members ?? [];
    const lead = agents.find(
      (item) =>
        item.role === 'lead' &&
        item.id !== visual.agentId &&
        members.includes(item.id) &&
        !['stopped', 'error'].includes(item.status),
    );
    return {
      id: visual.agentId,
      status: agent?.status ?? 'missing',
      turn: agent?.activeMessageId ?? null,
      error: agent?.lastError ?? null,
      lead: lead?.id ?? null,
    };
  };
  const post = (message) => frame?.contentWindow?.postMessage(message, '*');

  function visualLink(visual, className) {
    const link = node('a', className);
    link.href = hashOf(visual.id);
    link.addEventListener('click', (event) => {
      if (!plainClick(event)) return;
      event.preventDefault();
      navigate(visual.id);
    });
    return link;
  }

  async function setArchived(visual, archived) {
    try {
      await request(`/api/visuals/${encodeURIComponent(visual.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ archived }),
      });
      notify(archived ? `Archived “${visual.title}”.` : `Restored “${visual.title}”.`);
    } catch (error) {
      notify(error.message);
    }
  }
  // Both buttons name the visual they act on for assistive technology, since a list holds one of each.
  function archiveButton(visual, className) {
    const archived = Boolean(visual.archivedAt);
    const button = node('button', className, archived ? 'Restore' : 'Archive');
    button.type = 'button';
    button.setAttribute('aria-label', `${archived ? 'Restore' : 'Archive'} ${visual.title}`);
    button.addEventListener('click', () => setArchived(visual, !archived));
    return button;
  }

  function renderIndex() {
    const state = getState();
    if (!state) return;
    const all = [...(state.visuals ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const archivedTotal = all.filter((visual) => visual.archivedAt).length;
    const visuals = showArchived() ? all : all.filter((visual) => !visual.archivedAt);
    const signature = JSON.stringify([
      showArchived(),
      visuals.map((visual) => [
        visual.id,
        visual.archivedAt,
        visual.revision,
        visual.commentRevision,
        visual.answerRevision,
        visual.title,
      ]),
      state.tasks.map((task) => [task.id, task.title]),
    ]);
    if (signature === indexSignature) return;
    indexSignature = signature;
    $('visuals-count').textContent = String(visuals.length);
    const cards = visuals.map((visual) => {
      const card = node('article', `visual-card${visual.archivedAt ? ' archived' : ''}`);
      card.dataset.visual = visual.id;
      const title = visualLink(visual, 'visual-card-link');
      title.append(node('strong', 'visual-card-title', visual.title));
      const meta = node('span', 'visual-card-meta');
      if (visual.archivedAt) meta.append(node('span', 'archived-tag', 'Archived'));
      meta.append(
        node('span', 'visual-card-author', `@${visual.agentId}`),
        node('span', 'visual-version-pill', `v${visual.version}`),
        node(
          'span',
          '',
          `${visual.sectionCount} ${visual.sectionCount === 1 ? 'section' : 'sections'} · ${time(visual.updatedAt)}`,
        ),
      );
      // What waits for somebody: questions and drafts for the user, sent comments for the author to answer.
      if (visual.openQuestions)
        meta.append(
          node(
            'span',
            'visual-card-drafts',
            `${visual.openQuestions} ${visual.openQuestions === 1 ? 'question' : 'questions'}`,
          ),
        );
      if (visual.draftComments)
        meta.append(
          node(
            'span',
            'visual-card-drafts',
            `${visual.draftComments} ${visual.draftComments === 1 ? 'draft' : 'drafts'}`,
          ),
        );
      if (visual.openComments)
        meta.append(
          node(
            'span',
            'visual-card-open',
            `${visual.openComments} ${visual.openComments === 1 ? 'comment' : 'comments'} sent`,
          ),
        );
      card.append(title, meta);
      if (visual.taskId) {
        const task = state.tasks.find((item) => item.id === visual.taskId);
        const reference = node('p', 'visual-card-task');
        reference.append(node('span', 'visual-card-task-label', 'Task'), ' ');
        reference.append(task ? taskReference(task) : document.createTextNode(visual.taskId));
        card.append(reference);
      }
      card.append(archiveButton(visual, 'text-button visual-card-archive'));
      return card;
    });
    $('visuals-list').replaceChildren(
      ...(cards.length
        ? cards
        : [
            node(
              'p',
              'visuals-empty',
              archivedTotal
                ? 'Every visual is archived.'
                : 'No visuals yet. An agent makes one with `visual create` when a plan, a review or an explanation is clearer as a document than as chat.',
            ),
          ]),
    );
    const toggle = $('visuals-archive-toggle');
    toggle.hidden = !archivedTotal;
    toggle.textContent = showArchived()
      ? 'Hide archived visuals'
      : `Show ${archivedTotal} archived ${archivedTotal === 1 ? 'visual' : 'visuals'}`;
  }

  function showError(message) {
    $('visual-error').textContent = message;
    $('visual-error').hidden = !message;
  }

  function hideLink() {
    $('visual-link').hidden = true;
    $('visual-link-open').removeAttribute('href');
  }

  function renderHeader() {
    const visual = record(open.id);
    const shown = open.data?.shown;
    $('visual-title').textContent = shown?.title ?? visual?.title ?? open.id;
    const meta = $('visual-meta');
    meta.replaceChildren();
    const state = getState();
    const agentId = open.data?.agentId ?? visual?.agentId;
    if (agentId) {
      const agent = state.agents.find((item) => item.id === agentId);
      meta.append(node('span', '', 'by'), agent ? agentReference(agentId) : node('span', '', `@${agentId}`));
      if (agent && isBusy(agent)) meta.append(node('span', 'visual-working', 'working'));
    }
    if (visual?.archivedAt) meta.append(node('span', 'archived-tag', 'Archived'));
    const task = state.tasks.find((item) => item.id === (open.data?.taskId ?? visual?.taskId));
    if (task) meta.append(node('span', '', 'for'), taskReference(task));
    if (shown) meta.append(node('span', 'visual-updated', `updated ${time(shown.updatedAt)}`));

    const latest = visual?.version ?? open.data?.version ?? 1;
    const number = shown?.number ?? open.pinned ?? latest;
    $('visual-version-label').textContent = `Version ${number} of ${latest}`;
    $('visual-version-previous').disabled = number <= 1;
    $('visual-version-next').disabled = number >= latest;
    const following = open.pinned === null;
    $('visual-version-latest').hidden = following;
    $('visual-version-latest').classList.toggle('has-news', !following && latest > number);
    $('visual-version-latest').textContent = !following && latest > number ? `Newest: v${latest}` : 'Follow newest';
    $('visual-following').hidden = !following;
    $('visual-archive').textContent = visual?.archivedAt ? 'Restore' : 'Archive';
    $('visual-archive').hidden = !visual;
  }

  function renderOutline() {
    const shown = open.data?.shown;
    const items = (shown ? visibleSections(shown) : []).map((section) => {
      const button = node('button', 'visual-outline-item');
      button.type = 'button';
      button.dataset.section = section.id;
      button.append(node('span', 'visual-outline-title', section.title || LEAD_TITLE));
      const commented = shown.comments.filter((comment) => comment.sectionId === section.id).length;
      if (commented) {
        const count = node('span', 'visual-outline-comments', String(commented));
        count.title = `${commented} ${commented === 1 ? 'comment' : 'comments'}`;
        button.append(count);
      }
      const asked = shown.forms
        .filter((form) => form.sectionId === section.id)
        .flatMap((form) => form.fields)
        .filter((field) => !field.answer || field.unsent).length;
      if (asked) {
        const mark = node('span', 'visual-outline-questions', '?');
        mark.title = `${asked} ${asked === 1 ? 'question waits' : 'questions wait'} for your answer`;
        button.append(mark);
      }
      const change = shown.added.includes(section.id) ? 'new' : shown.changed.includes(section.id) ? 'changed' : null;
      if (change && shown.number > 1) {
        const mark = node('span', `visual-outline-mark ${change}`, change);
        mark.title = `${change === 'new' ? 'Added' : 'Changed'} in version ${shown.number}`;
        button.append(mark);
      }
      if (section.id === open.active) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => post({ type: 'scrollTo', sectionId: section.id }));
      return button;
    });
    $('visual-outline').replaceChildren(...items);
    const removed = shown?.number > 1 ? shown.removed : [];
    $('visual-removed').hidden = !removed?.length;
    $('visual-removed').textContent = removed?.length ? `Removed in this version: ${removed.join(', ')}` : '';
  }

  function sendContent(flash = [], top = false) {
    if (!open?.ready || !open.data) return;
    post({
      type: 'render',
      sections: visibleSections(open.data.shown),
      flash,
      top,
      tokens: themeTokens(document.documentElement),
    });
  }

  async function load({ flash = false } = {}) {
    const target = open;
    target.loads += 1;
    const load = target.loads;
    const previous = target.data;
    try {
      const query = target.pinned === null ? '' : `?version=${target.pinned}`;
      const data = await request(`/api/visuals/${encodeURIComponent(target.id)}${query}`);
      // The user moved on, or a newer request for the same visual is under way.
      if (open !== target || target.loads !== load) return;
      target.data = data;
      // What was loaded knows this turn of the author, so its start is no news.
      if (data.working) target.turn = data.working.turn;
      showError('');
      renderHeader();
      renderOutline();
      comments.show(data, authorOf(data));
      // A change that arrives is marked in place: a new version for a user who follows the newest one, or new content
      // of the version on screen. A version the user switched to starts at its top.
      const live = flash && previous && (target.pinned === null || previous.shown.number === data.shown.number);
      // A section that an answer of the user shows is new on the screen.
      const same = previous?.shown.number === data.shown.number;
      const seen = new Set(same ? visibleSections(previous.shown).map((section) => section.id) : []);
      const appeared = same
        ? visibleSections(data.shown)
            .map((section) => section.id)
            .filter((id) => !seen.has(id) && previous.shown.sections.some((section) => section.id === id))
        : [];
      sendContent(
        [...new Set([...(live ? changedSections(previous.shown.sections, data.shown.sections) : []), ...appeared])],
        !live && !same,
      );
      answers.show(data);
    } catch (error) {
      if (open !== target || target.loads !== load) return;
      showError(error.message);
    }
  }

  function close() {
    open = null;
    comments.close();
    answers.close();
    frame?.remove();
    frame = null;
    hideLink();
    $('visual-viewer').hidden = true;
    $('visuals-index').hidden = false;
  }

  function show(route) {
    if (!route) {
      close();
      indexSignature = null;
      renderIndex();
      return;
    }
    if (open?.id === route.id) {
      if (open.pinned === route.version) return;
      open.pinned = route.version;
      renderHeader();
      void load();
      return;
    }
    close();
    open = { id: route.id, pinned: route.version, data: null, ready: false, loads: 0, active: null, turn: null };
    $('visuals-index').hidden = true;
    $('visual-viewer').hidden = false;
    $('visual-problems').hidden = true;
    showError('');
    renderHeader();
    renderOutline();
    // The sandbox attribute alone, without allow-same-origin, puts the page into an opaque origin.
    frame = document.createElement('iframe');
    frame.className = 'visual-frame';
    frame.title = 'Content of the visual';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = FRAME_PAGE;
    $('visual-stage').prepend(frame);
    void load();
  }

  function onMessage(event) {
    if (!open || !frame || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (typeof message !== 'object' || message === null) return;
    if (message.type === 'ready') {
      open.ready = true;
      sendContent([], true);
      comments.marks();
      answers.frame();
    } else if (message.type === 'active') {
      if (typeof message.sectionId !== 'string') return;
      open.active = message.sectionId;
      comments.reading(message.sectionId);
      for (const item of $('visual-outline').children) {
        if (item.dataset.section === open.active) item.setAttribute('aria-current', 'true');
        else item.removeAttribute('aria-current');
      }
    } else if (message.type === 'link') {
      const href = safeLink(message.href);
      if (!href) return;
      $('visual-link-url').textContent = href;
      $('visual-link-open').href = href;
      $('visual-link').hidden = false;
    } else if (message.type === 'selection') comments.selection(message);
    else if (message.type === 'key') onKey(message);
    else if (message.type === 'comment') comments.focus(message.id);
    else if (message.type === 'answer') answers.answer(message);
    else if (message.type === 'problems') {
      if (!Array.isArray(message.problems)) return;
      const problems = message.problems
        .slice(0, MAX_PROBLEMS)
        .filter((problem) => typeof problem?.sectionId === 'string' && typeof problem.message === 'string');
      $('visual-problems').hidden = !problems.length;
      // The frame shows each failure in place; this line says that there are some, since they may be out of view.
      const sections = [...new Set(problems.map((problem) => problem.sectionId.slice(0, 48)))];
      $('visual-problems').textContent = problems.length
        ? `${problems.length === 1 ? 'One block' : `${problems.length} blocks`} could not be drawn, in ${sections.join(', ')}. The reason is shown in its place.`
        : '';
    }
  }
  window.addEventListener('message', onMessage);
  document.addEventListener('mu-theme-change', () =>
    post({ type: 'theme', tokens: themeTokens(document.documentElement) }),
  );

  const comments = createCommentsPanel({
    document,
    request,
    notify,
    post,
    showVersion: (number) => navigate(open.id, number === (record(open.id)?.version ?? number) ? null : number),
    reload: () => load(),
    time,
  });

  const answers = createAnswersPanel({ document, request, notify, post, reload: () => load() });

  const step = (delta) => {
    const latest = record(open.id)?.version ?? open.data?.version ?? 1;
    const number = (open.data?.shown.number ?? latest) + delta;
    if (number < 1 || number > latest) return;
    navigate(open.id, number === latest ? null : number);
  };
  $('visual-version-previous').addEventListener('click', () => step(-1));
  $('visual-version-next').addEventListener('click', () => step(1));
  $('visual-version-latest').addEventListener('click', () => navigate(open.id, null));
  $('visual-back').addEventListener('click', () => navigate(null));
  $('visuals-archive-toggle').addEventListener('click', () => setShowArchived(!showArchived()));
  $('visual-archive').addEventListener('click', () => {
    const visual = record(open.id);
    if (visual) void setArchived(visual, !visual.archivedAt);
  });
  $('visual-link-dismiss').addEventListener('click', hideLink);
  $('visual-link-open').addEventListener('click', () => setTimeout(hideLink));

  return {
    show,
    /** Draws what a change of the workspace state touches: the list, and the open visual when its content changed. */
    update() {
      if (!open) {
        renderIndex();
        return;
      }
      const visual = record(open.id);
      renderHeader();
      if (!visual || !open.data) return;
      // The comments that the author works on are those of its running turn, so a turn that starts is news for
      // them; a turn that ends needs no request, because the comments compare the turn with what was loaded.
      const author = authorOf(open.data);
      const turn = author?.turn ?? null;
      const started = turn !== null && turn !== open.turn;
      open.turn = turn;
      comments.author(author);
      // The newest version changes for as long as the turn that made it runs, so a user who pinned it sees those
      // changes too. A version before it never changes.
      if (visual.revision !== open.data.revision && (open.pinned === null || open.pinned >= open.data.version))
        void load({ flash: true });
      // A comment changes on the version it belongs to, which may be an earlier one that the user looks at.
      // An answer changes on the newest version, and shows on every version that asks the same question.
      // What the author works on ends with the turn's first write, which is a change of the visual.
      else if (
        visual.commentRevision !== open.data.commentRevision ||
        visual.answerRevision !== open.data.answerRevision ||
        started ||
        (open.data.working && visual.revision !== open.data.revision)
      )
        void load();
    },
    /** The visuals of a task, as links for its card; null when it has none. */
    taskVisuals(taskId) {
      const visuals = (getState()?.visuals ?? []).filter(
        (visual) => visual.taskId === taskId && (showArchived() || !visual.archivedAt),
      );
      if (!visuals.length) return null;
      const row = node('div', 'task-visuals');
      row.setAttribute('aria-label', 'Visuals');
      for (const visual of visuals) {
        const link = visualLink(visual, 'visual-chip');
        link.append(
          node('span', 'visual-chip-title', visual.title),
          node('span', 'visual-version-pill', `v${visual.version}`),
        );
        link.title = `Visual by @${visual.agentId}`;
        row.append(link);
      }
      return row;
    },
    /** A link to a visual for a reference in text. */
    reference(visual) {
      const link = visualLink(visual, 'visual-ref');
      link.textContent = visual.title;
      link.title = `Visual ${visual.id} by @${visual.agentId}`;
      return link;
    },
  };
}
