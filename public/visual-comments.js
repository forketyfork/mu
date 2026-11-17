// The user's comments on a visual: the field that takes a comment, the list of the comments on the version shown, and
// the buttons that send them. All of it is the dashboard's, outside the frame: what a comment says and when it is
// sent is decided here, by the user. The frame only reports what the reader selected, and a report is checked before
// it is used; the quote in it is shown as text and sent as a quote. See "Visuals" in docs/architecture.md.

// The limits of a quote; `COMMENT_LIMITS` of the visual format holds the same numbers for the service and the frame.
export const QUOTE_CHARS = 600;
export const CONTEXT_CHARS = 32;
// The limits of a line of a patch; `PATCH_LIMITS` of the visual format holds the same numbers.
const PATH_CHARS = 400;
const LINE_NUMBER = 1_000_000_000;
const MAX_BLOCKS = 10_000;
const PENDING = 'pending';
const LEAD_TITLE = 'Introduction';
const QUICK = [
  ['Simpler', 'This is not clear. Explain it in simple words.'],
  ['More detail', 'Explain this in more detail.'],
  ['Example', 'Give an example.'],
  ['Shorter', 'Make this shorter.'],
  ['Why?', 'Why this and not an alternative? Give the reasons.'],
];

/**
 * What the frame says the reader selected, checked against the sections that are shown: the target of a comment and
 * its place in the frame, `null` for "nothing is selected", and `undefined` for a report that names no shown content.
 */
export function selectionOf(message, sections) {
  const { target, rect } = message;
  if (target === null) return null;
  if (typeof target !== 'object' || target === undefined) return undefined;
  const section = sections.find((item) => item.id === target.sectionId);
  if (!section || target.sectionRev !== section.rev) return undefined;
  const text = (value, max, needed) =>
    typeof value === 'string' && [...value].length <= max && (!needed || Boolean(value.trim()));
  let quote = null;
  if (target.quote !== null) {
    if (typeof target.quote !== 'object' || !Number.isInteger(target.block)) return undefined;
    const { text: quoted, prefix, suffix } = target.quote;
    if (!text(quoted, QUOTE_CHARS, true) || !text(prefix, CONTEXT_CHARS) || !text(suffix, CONTEXT_CHARS))
      return undefined;
    quote = { text: quoted, prefix, suffix };
  }
  if (target.block !== null && !(Number.isInteger(target.block) && target.block >= 0 && target.block < MAX_BLOCKS))
    return undefined;
  let line = null;
  if (target.line !== undefined && target.line !== null) {
    const { path, side, number } = target.line;
    if (
      quote !== null ||
      target.block === null ||
      !text(path, PATH_CHARS, true) ||
      (side !== 'old' && side !== 'new') ||
      !(Number.isInteger(number) && number >= 1 && number <= LINE_NUMBER)
    )
      return undefined;
    line = { path, side, number };
  }
  const sides = ['left', 'top', 'right', 'bottom'];
  if (typeof rect !== 'object' || rect === null || !sides.every((side) => Number.isFinite(rect[side])))
    return undefined;
  return {
    target: { sectionId: section.id, sectionRev: section.rev, block: target.block, quote, ...(line ? { line } : {}) },
    rect: Object.fromEntries(sides.map((side) => [side, rect[side]])),
  };
}

/** A line of a patch as the user reads it: `src/a.js:12`, or `src/a.js:12 (old)` for a line that was removed. */
export const lineLabel = (line) => `${line.path}:${line.number}${line.side === 'old' ? ' (old)' : ''}`;

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {(path: string, options?: object) => Promise<any>} options.request
 * @param {(message: object) => void} options.post Sends a message to the frame.
 * @param {(version: number) => void} options.showVersion
 * @param {() => Promise<void>} options.reload Loads the visual again, after a comment changed.
 * @param {(at: string) => string} options.time
 */
export function createCommentsPanel({ document, request, post, showVersion, reload, time }) {
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (className, text, onClick) => {
    const element = node('button', className, text);
    element.type = 'button';
    element.addEventListener('click', onClick);
    return element;
  };

  /** @type {any} What the service answered for the version shown. */
  let data = null;
  /** @type {{ id: string, status: string, turn: number | null } | null} The author, and the message its turn is on. */
  let author = null;
  let workingSent = '[]';
  // What the reader selected last, and the selection the comment field is about. The field follows the selection
  // until it holds text; after that, only the user moves it.
  let selection = null;
  // The selected text that a saved comment used up, a heading included. The frame tells about a selected text again
  // whenever it moves on the screen, so the same text is not offered again until the selection ends or changes. A click
  // on a line or a diagram is no text: it is told once, and a second click is a new offer.
  let used = null;
  let base = null;
  let offered = null;
  /** @type {'narrow' | 'section' | 'visual'} */
  let scope = 'narrow';
  let reading = null;
  let editing = null;
  let active = null;
  let busy = false;

  const field = () => /** @type {HTMLTextAreaElement} */ ($('visual-composer-text'));
  const held = () => Boolean(field().value.trim()) || editing !== null;
  const sectionOf = (id) => data?.shown.sections.find((section) => section.id === id) ?? null;
  const titleOf = (id) => {
    const section = sectionOf(id);
    return section ? section.title || LEAD_TITLE : id;
  };

  // The target of the comment in the field: the selection, or the section or the visual around it.
  function target() {
    if (scope === 'visual') return null;
    const sectionId = base?.sectionId ?? reading;
    const section = sectionId ? sectionOf(sectionId) : null;
    if (scope === 'section')
      return section ? { sectionId: section.id, sectionRev: section.rev, block: null, quote: null } : null;
    return base;
  }

  function showError(message) {
    $('visual-composer-error').textContent = message;
    $('visual-composer-error').hidden = !message;
  }

  function hideBubble() {
    offered = null;
    $('visual-comment-bubble').hidden = true;
  }

  // The frame gets nothing of a section that the user's answers hide, not even where a comment on it stands.
  const hiddenSection = (id) => (data?.shown.hidden ?? []).includes(id);

  function sendMarks() {
    if (!data) return;
    const state = (comment) =>
      comment.status === 'draft' ? 'draft' : comment.answeredIn === null ? 'sent' : 'answered';
    const marks = data.shown.comments
      .filter((comment) => comment.sectionId !== null && comment.id !== editing && !hiddenSection(comment.sectionId))
      .map(({ id, sectionId, sectionRev, block, quote, line, ...comment }) => ({
        id,
        sectionId,
        sectionRev,
        block,
        quote,
        ...(line ? { line } : {}),
        state: state(comment),
      }));
    const pending = target();
    // The mark of the comment that is being written shows where it will stand, also after the selection is gone.
    if (pending && (held() || document.activeElement === field()))
      marks.push({ id: PENDING, ...pending, state: 'draft' });
    post({ type: 'comments', comments: marks, active: marks.some((mark) => mark.id === PENDING) ? PENDING : active });
  }

  // The comments that the author works on now. The service says which comments the author's running turn holds;
  // the agent's record in the dashboard's state says whether that turn still runs. So the light goes out with the
  // turn, whatever ended it, without another request.
  const inWork = () =>
    new Set(data?.working && author && author.turn === data.working.turn ? data.working.comments : []);

  /** Tells the frame what to put the moving light on. */
  function sendWorking(always = false) {
    const ids = inWork();
    const targets = (data?.shown.comments ?? [])
      .filter((comment) => ids.has(comment.id) && !hiddenSection(comment.sectionId))
      .map(({ id, sectionId, sectionRev, block, quote, line }) => ({
        id,
        sectionId,
        sectionRev,
        block,
        quote,
        ...(line ? { line } : {}),
      }));
    const signature = JSON.stringify(targets);
    if (!always && signature === workingSent) return;
    workingSent = signature;
    post({ type: 'working', targets });
  }

  function whereOf(comment) {
    if (comment.sectionId === null) return 'Whole visual';
    // The comment stays the user's to send; the section is back when the answers show it.
    return `${placeOf(comment)}${hiddenSection(comment.sectionId) ? ' (hidden by your answers)' : ''}`;
  }
  function placeOf(comment) {
    const title = titleOf(comment.sectionId);
    if (comment.block === null) return `Section “${title}”`;
    if (comment.line) return `${title}, ${lineLabel(comment.line)}`;
    return comment.quote ? title : `${title}, block ${comment.block + 1}`;
  }

  function renderComposer() {
    const current = target();
    const options = [];
    if (base?.block !== null && base?.block !== undefined)
      options.push([
        'narrow',
        base.line ? `Line ${lineLabel(base.line)}` : base.quote ? 'Selected text' : `Block ${base.block + 1}`,
      ]);
    const sectionId = base?.sectionId ?? reading;
    if (sectionId && sectionOf(sectionId)) options.push(['section', `Section “${titleOf(sectionId)}”`]);
    options.push(['visual', 'Whole visual']);
    const chosen = current === null ? 'visual' : current.block === null ? 'section' : 'narrow';
    $('visual-composer-scope').replaceChildren(
      ...options.map(([value, label]) => {
        const option = button('filter visual-scope', label, () => {
          scope = /** @type {'narrow' | 'section' | 'visual'} */ (value);
          renderComposer();
          sendMarks();
          field().focus();
        });
        option.setAttribute('aria-pressed', String(value === chosen));
        return option;
      }),
    );
    const quote = current?.quote?.text ?? '';
    $('visual-composer-quote').textContent = quote;
    $('visual-composer-quote').hidden = !quote;
    $('visual-composer-send').textContent = editing ? 'Send' : 'Send now';
    $('visual-composer-draft').textContent = editing ? 'Save' : 'Save draft';
    $('visual-composer-cancel').hidden = !editing && !field().value;
    for (const id of ['visual-composer-send', 'visual-composer-draft']) $(id).disabled = busy || !field().value.trim();
  }

  function card(comment, { answer = false, working = false } = {}) {
    const state = comment.status === 'draft' ? 'draft' : comment.answeredIn === null ? 'sent' : 'answered';
    const item = node('article', `visual-comment ${answer ? 'answer' : state}${working ? ' working' : ''}`);
    item.dataset.comment = comment.id;
    if (comment.id === active) item.setAttribute('aria-current', 'true');
    const head = node('header', 'visual-comment-head');
    head.append(
      node('span', 'visual-comment-where', whereOf(comment)),
      node(
        'span',
        'visual-comment-state',
        answer
          ? `On v${comment.version}`
          : working
            ? 'In work'
            : { draft: 'Draft', sent: 'Sent', answered: 'Answered' }[state],
      ),
    );
    if (working) head.lastElementChild.title = `@${author.id} is working on this comment`;
    item.append(head);
    if (comment.quote) item.append(node('blockquote', 'visual-comment-quote', comment.quote.text));
    item.append(node('p', 'visual-comment-text', comment.text));
    // The author can change this version while its turn runs; the comment stays with the content it was written on.
    if (!answer && comment.sectionId !== null && sectionOf(comment.sectionId)?.rev !== comment.sectionRev)
      item.append(
        node(
          'p',
          'visual-comment-moved',
          sectionOf(comment.sectionId)
            ? 'This section changed after the comment was written.'
            : 'This section was removed after the comment was written.',
        ),
      );
    const foot = node('footer', 'visual-comment-foot');
    if (answer)
      foot.append(button('text-button', `See it on version ${comment.version}`, () => showVersion(comment.version)));
    else if (state === 'draft')
      foot.append(
        button('text-button', 'Send', () => act(() => send([comment.id]))),
        button('text-button', 'Edit', () => edit(comment)),
        button('text-button', 'Delete', () =>
          act(() =>
            request(`/api/visuals/${encodeURIComponent(data.id)}/comments/${comment.id}`, {
              method: 'DELETE',
              body: '{}',
            }),
          ),
        ),
      );
    else {
      foot.append(node('span', '', `Sent ${time(comment.sentAt)}`));
      if (state === 'answered')
        foot.append(
          button('text-button', `Answered in version ${comment.answeredIn}`, () => showVersion(comment.answeredIn)),
        );
    }
    item.append(foot);
    item.addEventListener('click', (event) => {
      if (/** @type {Element} */ (event.target).closest('button')) return;
      if (answer) {
        if (comment.sectionId && sectionOf(comment.sectionId)) post({ type: 'scrollTo', sectionId: comment.sectionId });
        return;
      }
      active = comment.id;
      renderList();
      sendMarks();
      post({ type: 'reveal', id: comment.id });
    });
    return item;
  }

  function renderList() {
    const comments = data?.shown.comments ?? [];
    const order = new Map((data?.shown.sections ?? []).map((section, index) => [section.id, index]));
    const place = (comment) => (comment.sectionId === null ? -1 : (order.get(comment.sectionId) ?? order.size));
    const sorted = [...comments].sort(
      (a, b) => place(a) - place(b) || (a.block ?? -1) - (b.block ?? -1) || a.createdAt.localeCompare(b.createdAt),
    );
    const drafts = sorted.filter((comment) => comment.status === 'draft');
    $('visual-comments-count').textContent = String(comments.length);
    $('visual-comments-send-all').hidden = drafts.length < 2;
    $('visual-comments-send-all').textContent = `Send all ${drafts.length}`;
    $('visual-comments-send-all').disabled = busy;
    const working = inWork();
    $('visual-comments-list').replaceChildren(
      ...(sorted.length
        ? sorted.map((comment) => card(comment, { working: working.has(comment.id) }))
        : [
            node(
              'p',
              'visual-comments-empty',
              'No comments on this version. Select text in the visual to comment on it.',
            ),
          ]),
    );
    const answers = data?.shown.answers ?? [];
    $('visual-answers').hidden = !answers.length;
    $('visual-answers-list').replaceChildren(...answers.map((comment) => card(comment, { answer: true })));

    const notes = [];
    if (author && ['stopped', 'error'].includes(author.status) && comments.length)
      notes.push(
        node(
          'span',
          '',
          `@${author.id} is ${author.status === 'stopped' ? 'stopped' : 'in an error state'}; it reads comments when it is resumed.`,
        ),
      );
    const elsewhere = (data?.versions ?? []).filter(
      (version) => version.comments && version.number !== data.shown.number,
    );
    if (elsewhere.length) {
      const other = node('span', 'visual-comments-elsewhere', 'Comments on other versions:');
      for (const version of elsewhere)
        other.append(
          button('text-button', `v${version.number} (${version.comments})`, () => showVersion(version.number)),
        );
      notes.push(other);
    }
    $('visual-comments-note').hidden = !notes.length;
    $('visual-comments-note').replaceChildren(...notes);
  }

  function reset() {
    field().value = '';
    editing = null;
    base = selection;
    scope = 'narrow';
    showError('');
  }

  function edit(comment) {
    editing = comment.id;
    field().value = comment.text;
    base =
      comment.sectionId === null
        ? null
        : {
            sectionId: comment.sectionId,
            sectionRev: comment.sectionRev,
            block: comment.block,
            quote: comment.quote,
            ...(comment.line ? { line: comment.line } : {}),
          };
    scope = comment.sectionId === null ? 'visual' : comment.block === null ? 'section' : 'narrow';
    showError('');
    renderComposer();
    sendMarks();
    field().focus();
  }

  const commentsPath = () => `/api/visuals/${encodeURIComponent(data.id)}/comments`;
  const send = (ids) =>
    request(`${commentsPath()}/send`, {
      method: 'POST',
      body: JSON.stringify({ version: data.shown.number, ...(ids ? { ids } : {}) }),
    });

  // One request at a time; whatever it did, the list is loaded again, so that it shows what the service holds.
  async function act(work) {
    if (busy || !data) return;
    busy = true;
    renderComposer();
    renderList();
    let failure = null;
    try {
      await work();
    } catch (error) {
      failure = error;
    }
    busy = false;
    await reload();
    // A send can fail after the message reached the chat, so the list that was just loaded says what the comment is.
    const kept = failure?.unsent && data?.shown.comments.some((c) => c.id === failure.unsent && c.status === 'draft');
    showError(failure ? `${kept ? 'The comment is saved as a draft. ' : ''}${failure.message}` : '');
    renderComposer();
  }

  // Saves the comment in the field, as a new draft or as the draft that is edited, and sends it when asked to. A
  // comment that is saved leaves the field, also when its message could not be sent: it is then a draft in the list.
  function submit(andSend) {
    const text = field().value.trim();
    if (!text) return;
    return act(async () => {
      const current = target();
      const edited = editing !== null;
      const saved = editing
        ? await request(`${commentsPath()}/${editing}`, { method: 'PATCH', body: JSON.stringify({ text }) })
        : await request(commentsPath(), {
            method: 'POST',
            body: JSON.stringify({
              version: data.shown.number,
              sectionId: current?.sectionId ?? null,
              ...(current ? { sectionRev: current.sectionRev } : {}),
              block: current?.block ?? null,
              quote: current?.quote ?? null,
              ...(current?.line ? { line: current.line } : {}),
              text,
            }),
          });
      // A new comment uses up the selection it was written on: the frame cannot say that a click on a line or a diagram
      // ended, so nothing else would. A change to a draft leaves the selection that is shown as it is.
      if (!edited) {
        used = selection && (selection.quote || selection.block === null) ? JSON.stringify(selection) : null;
        selection = null;
        hideBubble();
      }
      reset();
      active = saved.id;
      if (!andSend) return;
      try {
        await send([saved.id]);
      } catch (error) {
        throw Object.assign(error, { unsent: saved.id });
      }
    });
  }

  $('visual-composer-chips').replaceChildren(
    ...QUICK.map(([label, text]) =>
      button('filter visual-quick', label, () => {
        // A phrase replaces another phrase, and is added to what the user wrote.
        const value = field().value.trim();
        field().value = !value || QUICK.some(([, phrase]) => phrase === value) ? text : `${value} ${text}`;
        renderComposer();
        sendMarks();
        field().focus();
      }),
    ),
  );
  $('visual-composer').addEventListener('submit', (event) => {
    event.preventDefault();
    void submit(true);
  });
  $('visual-composer-draft').addEventListener('click', () => void submit(false));
  $('visual-composer-cancel').addEventListener('click', () => {
    reset();
    renderComposer();
    sendMarks();
  });
  field().addEventListener('input', () => {
    renderComposer();
    sendMarks();
  });
  field().addEventListener('focus', sendMarks);
  field().addEventListener('blur', sendMarks);
  field().addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit(true);
    }
  });
  $('visual-comment-bubble').addEventListener('click', () => {
    if (offered) {
      base = offered;
      scope = 'narrow';
    }
    hideBubble();
    renderComposer();
    field().focus();
    sendMarks();
  });
  // The offer is for the click that made it: a click anywhere else in the dashboard takes it back. A click in the frame
  // reaches the frame's own document, which tells the end of the offer.
  document.addEventListener('click', (event) => {
    if (!$('visual-comment-bubble').contains(/** @type {Node} */ (event.target))) hideBubble();
  });
  $('visual-comments-send-all').addEventListener('click', () => void act(() => send()));

  return {
    /** Shows the comments of a version; `data` is the service's answer for it. */
    show(next, nextAuthor) {
      const moved = data?.id !== next.id || data.shown.number !== next.shown.number;
      data = next;
      author = nextAuthor;
      const current = (value) => (value && sectionOf(value.sectionId)?.rev === value.sectionRev ? value : null);
      // A selection belongs to the content it was made in.
      selection = current(selection);
      base = current(base);
      if (moved) hideBubble();
      if (editing && !data.shown.comments.some((comment) => comment.id === editing && comment.status === 'draft'))
        reset();
      if (active && !data.shown.comments.some((comment) => comment.id === active)) active = null;
      renderComposer();
      renderList();
      sendMarks();
      sendWorking();
    },
    /** The state of the workspace changed: the author's turn may have started or ended. */
    author(nextAuthor) {
      if (!data || JSON.stringify(nextAuthor) === JSON.stringify(author)) return;
      author = nextAuthor;
      renderList();
      sendWorking();
    },
    /** The frame is new or drew everything again: it has no marks. */
    marks() {
      sendMarks();
      sendWorking(true);
    },
    /** A report of the frame about what the reader selected. */
    selection(message) {
      if (!data) return;
      const reported = selectionOf(message, data.shown.sections);
      if (reported === undefined) return;
      if (reported === null || JSON.stringify(reported.target) !== used) used = null;
      if (used !== null) return;
      if (reported === null) {
        selection = null;
        hideBubble();
        // The field keeps its place while the user writes in it; a click into the field must not lose the selection.
        if (held() || document.activeElement === field()) return;
        base = null;
      } else {
        selection = reported.target;
        const stage = $('visual-stage');
        const bubble = $('visual-comment-bubble');
        const visible = reported.rect.bottom >= 0 && reported.rect.top <= stage.clientHeight;
        offered = reported.target;
        bubble.hidden = !visible;
        bubble.style.left = `${Math.max(0, Math.min(reported.rect.right, stage.clientWidth - bubble.offsetWidth))}px`;
        bubble.style.top = `${Math.max(0, Math.min(reported.rect.bottom, stage.clientHeight - bubble.offsetHeight))}px`;
        if (held()) return;
        base = reported.target;
        scope = 'narrow';
      }
      renderComposer();
      sendMarks();
    },
    /** The reader clicked the marked text of a comment. */
    focus(id) {
      if (typeof id !== 'string' || !data?.shown.comments.some((comment) => comment.id === id)) return;
      active = id;
      renderList();
      sendMarks();
      $('visual-comments-list').querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
    },
    /** The section the reader is at; a comment without a selection can be about it. */
    reading(sectionId) {
      reading = sectionId;
      if (!base) renderComposer();
    },
    close() {
      data = null;
      author = null;
      workingSent = '[]';
      selection = null;
      used = null;
      reading = null;
      active = null;
      reset();
      hideBubble();
    },
  };
}
