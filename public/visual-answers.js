// The user's answers to the questions of a visual, beside the frame that draws the controls. The frame is not
// trusted: it only reports what the reader chose. The dashboard stores each answer with the service, shows here what
// the service holds, and sends exactly that list when the user clicks Send, so a hostile visual can neither answer
// for the user nor send anything. See "Visuals" in docs/architecture.md.

const TEXT_CHARS = 2000;
// The user sends what the list shows, so an answer must have stood in the list for this long before a click on Send
// sends it. The frame can report an answer while the pointer is on its way to the button, or during the click.
const READ_MS = 1500;
// How long the list stays marked after the user asked for it with the button over the document.
const REVEAL_MS = 2400;

/**
 * What the frame reports as the answer to a question, when it has the form of an answer to it; undefined otherwise.
 * The service checks the answer itself.
 */
export function reportedAnswer(field, value) {
  if (value === null) return null;
  const option = (id) => typeof id === 'string' && field.options.some((item) => item.id === id);
  if (field.type === 'choice') return option(value) ? value : undefined;
  if (field.type === 'multi')
    return Array.isArray(value) && value.length <= field.options.length && value.every(option) ? value : undefined;
  if (field.type === 'text') return typeof value === 'string' && value.length <= TEXT_CHARS ? value : undefined;
  if (field.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  if (field.type === 'toggle') return typeof value === 'boolean' ? value : undefined;
  return undefined;
}

/** Where a question stands for the user: `open`, `suggested`, `unsent` or `sent`. */
export function answerState(field) {
  if (!field.answer) return field.unsent ? 'unsent' : 'open';
  if (!field.unsent) return 'sent';
  return field.answer.source === 'default' ? 'suggested' : 'unsent';
}

/**
 * An answer as words. A text answer is shown whole: the user sends what this list shows, and the frame, which
 * reported the text, could hide an instruction for the author behind a cut.
 */
export function answerText(field, value) {
  const label = (id) => field.options.find((option) => option.id === id)?.label ?? id;
  if (field.type === 'choice') return label(value);
  if (field.type === 'multi') return value.length ? value.map(label).join(', ') : 'None of them';
  if (field.type === 'toggle') return value ? 'Yes' : 'No';
  if (field.type === 'number') return `${value}${field.unit ? ` ${field.unit}` : ''}`;
  return String(value);
}

const CHIPS = { open: 'No answer', suggested: 'Suggested', unsent: 'Not sent', sent: 'Sent' };

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {(path: string, options?: object) => Promise<any>} options.request
 * @param {(message: object) => void} options.post Sends a message to the frame.
 * @param {() => Promise<void>} options.reload Loads the visual again, after an answer changed.
 * @param {() => number} [options.now] The time in milliseconds.
 */
export function createAnswersPanel({ document, request, post, reload, now = () => Date.now() }) {
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  /** @type {any} What the service answered for the version shown. */
  let data = null;
  let busy = false;
  // One change at a time, in the order the reader made them.
  let queue = Promise.resolve();
  // What the list showed last for each question of one version of one visual, and when that last changed.
  let listed = { scope: '', answers: new Map(), changedAt: new Map() };
  // The questions whose answer was too new in the list when the user clicked Send; that click sent nothing.
  let unread = new Set();

  const fieldsOf = (shown) =>
    shown.forms.flatMap((form) => form.fields.map((field) => ({ ...field, sectionId: form.sectionId })));
  function noteChanges(next) {
    const scope = `${next.id} ${next.shown.number}`;
    const answers = new Map(fieldsOf(next.shown).map((field) => [field.key, JSON.stringify(field.answer ?? null)]));
    // In another version every answer is new to the list, also one that the version before had.
    const before = scope === listed.scope ? listed : { answers: new Map(), changedAt: new Map() };
    if (scope !== listed.scope) unread = new Set();
    const changedAt = new Map();
    for (const [key, answer] of answers)
      changedAt.set(key, before.answers.get(key) === answer ? before.changedAt.get(key) : now());
    listed = { scope, answers, changedAt };
  }

  const fields = () => (data ? fieldsOf(data.shown) : []);
  const answerable = () => Boolean(data) && data.shown.number === data.version;
  const drafts = () => (data?.shown.comments ?? []).filter((comment) => comment.status === 'draft').length;

  function showError(message) {
    $('visual-questions-error').textContent = message;
    $('visual-questions-error').hidden = !message;
  }

  /** Tells the frame what each control shows. */
  function sendState() {
    if (!data) return;
    post({
      type: 'answers',
      readOnly: !answerable(),
      fields: Object.fromEntries(
        fields().map((field) => [
          field.id,
          {
            ...(field.answer ? { value: field.answer.value } : {}),
            state: answerState(field),
            own: field.answer?.source === 'user',
          },
        ]),
      ),
    });
  }

  function render() {
    const all = fields();
    $('visual-questions').hidden = !all.length;
    $('visual-questions-bar').hidden = true;
    if (!all.length) return;
    const answered = all.filter((field) => field.answer).length;
    const waiting = all.filter((field) => field.unsent).length;
    $('visual-questions-count').textContent = `${answered} of ${all.length}`;
    $('visual-questions-list').replaceChildren(
      ...all.map((field) => {
        const state = answerState(field);
        const late = unread.has(field.key);
        const row = node('button', `visual-question ${state}${late ? ' unread' : ''}`);
        row.type = 'button';
        row.title = 'Show the question in the visual';
        const head = node('span', 'visual-question-head');
        head.append(
          node('span', 'visual-question-label', field.label),
          node('span', 'visual-question-state', late ? 'Changed just now' : CHIPS[state]),
        );
        row.append(
          head,
          node(
            'span',
            'visual-question-value',
            field.answer
              ? answerText(field, field.answer.value)
              : field.sent
                ? `No answer now; sent before: ${answerText(field, field.sent.value)}`
                : '—',
          ),
        );
        row.addEventListener('click', () => post({ type: 'scrollTo', sectionId: field.sectionId, field: field.id }));
        return row;
      }),
    );
    const count = drafts();
    const withDrafts = count ? ` and ${count} ${count === 1 ? 'comment' : 'comments'}` : '';
    const send = $('visual-questions-send');
    send.hidden = !answerable() || !waiting;
    send.disabled = busy;
    send.textContent = `Send answers${withDrafts}`;
    $('visual-questions-note').textContent = !answerable()
      ? `These are the questions of version ${data.shown.number}. Answer them on the newest version.`
      : waiting
        ? `@${data.agentId} reads your answers when you send them. A suggestion that you keep is sent as your answer.`
        : answered === all.length
          ? `@${data.agentId} has your answers.`
          : `@${data.agentId} has your answers so far.`;
    $('visual-questions-bar').hidden = send.hidden;
    $('visual-questions-bar-text').textContent = `${waiting} ${waiting === 1 ? 'answer' : 'answers'} not sent`;
  }

  async function act(work) {
    let failure = '';
    try {
      await work();
    } catch (error) {
      failure = error.message;
    }
    await reload();
    showError(failure);
  }

  const path = (part) => `/api/visuals/${encodeURIComponent(data.id)}/${part}`;

  $('visual-questions-send').addEventListener('click', () => {
    if (busy || !data) return;
    const at = now();
    const late = fields().filter((field) => at - listed.changedAt.get(field.key) < READ_MS);
    unread = new Set(late.map((field) => field.key));
    if (late.length) {
      showError(
        `${late.length === 1 ? 'One line' : `${late.length} lines`} of this list changed just before you pressed Send, so nothing was sent. Read what is marked, then send again.`,
      );
      render();
      return;
    }
    busy = true;
    render();
    // What the list above shows: the answer of every question that has one.
    const reviewed = Object.fromEntries(
      fields()
        .filter((field) => field.answer)
        .map((field) => [field.key, field.answer.value]),
    );
    const version = data.shown.number;
    queue = queue.then(() =>
      act(() =>
        request(path('feedback'), { method: 'POST', body: JSON.stringify({ version, answers: reviewed }) }),
      ).then(() => {
        busy = false;
        render();
      }),
    );
  });
  let revealTimer;
  function reveal(on) {
    clearTimeout(revealTimer);
    $('visual-questions').classList.toggle('revealed', on);
    if (on) revealTimer = setTimeout(() => reveal(false), REVEAL_MS);
  }
  // The button sends nothing: the user sends from the list, after reading it. The focus therefore goes to the list
  // and not to Send, where a key that is held on this button, or pressed twice, would send. In a wide window the list
  // is in view already, so nothing scrolls, and a focus that a script gives after a click of the pointer has no ring.
  // The mark is what shows where the click led.
  $('visual-questions-review').addEventListener('click', () => {
    const list = $('visual-questions');
    list.scrollIntoView({ block: 'start' });
    list.focus({ preventScroll: true });
    reveal(true);
  });

  return {
    /** Shows the questions of a version; `data` is the service's answer for it. */
    show(next) {
      noteChanges(next);
      data = next;
      render();
      sendState();
    },
    /** The frame is new: it knows no answer. */
    frame: sendState,
    /** A report of the frame that the reader answered a question. */
    answer(message) {
      if (!data || !answerable() || typeof message.field !== 'string') return;
      const field = fields().find((item) => item.id === message.field);
      if (!field) return;
      const value = reportedAnswer(field, message.value);
      if (value === undefined) return;
      const { id, shown } = data;
      queue = queue.then(() => {
        // The reader moved on to another visual or version while an earlier change was stored.
        if (data?.id !== id || data.shown.number !== shown.number) return undefined;
        return act(() =>
          request(path('answers'), {
            method: 'PATCH',
            body: JSON.stringify({ version: shown.number, answers: [{ key: field.key, value }] }),
          }),
        );
      });
    },
    close() {
      data = null;
      busy = false;
      // The list is off the screen: what it shows next, the user has not read.
      listed = { scope: '', answers: new Map(), changedAt: new Map() };
      unread = new Set();
      reveal(false);
      showError('');
      render();
    },
  };
}
