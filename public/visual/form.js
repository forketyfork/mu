// Draws the questions of a `form` block as controls, and tells the dashboard what the reader chose. The frame keeps
// no answer: the dashboard stores each one with the service, shows it for review outside the frame, and sends the
// state back, which is what the controls show. Every label is text written by an agent and is set as text. See
// "Visuals" in docs/architecture.md.

const TYPING_PAUSE = 700;
const STATES = {
  suggested: 'Suggestion of the author, not sent yet',
  unsent: 'Not sent yet',
  sent: 'Sent',
};

/**
 * @typedef {{ value?: any, state?: string, own?: boolean }} FieldState What the dashboard holds for one question.
 * @typedef {{ readOnly: boolean, fields: Record<string, FieldState> }} AnswersState
 */

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {(text: string) => { fields: any[] }} options.parseForm
 * @param {number} options.answerChars The longest text answer.
 * @param {(message: object) => void} options.tell
 * @param {(work: () => void, delay: number) => any} [options.later]
 */
export function createForms({
  document,
  parseForm,
  answerChars,
  tell,
  later = (work, delay) => setTimeout(work, delay),
}) {
  /** @type {AnswersState} */
  let state = { readOnly: true, fields: {} };
  /** @type {WeakMap<Element, (state: AnswersState) => void>} */
  const appliers = new WeakMap();
  let serial = 0;

  const element = (tag, className, text) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };
  const answer = (field, value) => tell({ type: 'answer', field: field.id, value });

  // One or several of the options; a yes-or-no question is a choice of two.
  function options(field, name, multiple) {
    const list = element('div', 'form-options');
    list.setAttribute('role', multiple ? 'group' : 'radiogroup');
    const suggested = (id) =>
      field.type === 'toggle'
        ? field.default === (id === 'yes')
        : multiple
          ? field.default?.includes(id)
          : field.default === id;
    const items =
      field.type === 'toggle'
        ? [
            { id: 'yes', label: 'Yes' },
            { id: 'no', label: 'No' },
          ]
        : field.options;
    const inputs = items.map((option) => {
      const label = element('label', 'form-option');
      const input = /** @type {HTMLInputElement} */ (element('input'));
      input.type = multiple ? 'checkbox' : 'radio';
      input.name = name;
      input.value = option.id;
      const text = element('span', 'form-option-text');
      text.append(element('span', 'form-option-label', option.label));
      if (option.hint) text.append(element('span', 'form-option-hint', option.hint));
      label.append(input, text);
      if (suggested(option.id)) label.append(element('span', 'form-suggested', 'suggested'));
      list.append(label);
      return input;
    });
    const chosen = () => inputs.filter((input) => input.checked).map((input) => input.value);
    list.addEventListener('change', () => {
      const ids = chosen();
      answer(field, field.type === 'toggle' ? ids[0] === 'yes' : multiple ? ids : ids[0]);
    });
    return {
      control: list,
      inputs,
      show(value) {
        const ids =
          value === undefined ? [] : field.type === 'toggle' ? [value ? 'yes' : 'no'] : multiple ? value : [value];
        for (const input of inputs) {
          input.checked = ids.includes(input.value);
          input.closest('label').classList.toggle('chosen', input.checked);
        }
      },
    };
  }

  // A text or a number that the reader types. It goes to the dashboard after a pause, and at once when the reader
  // leaves the control; what the dashboard sends back does not replace what the reader is still typing.
  function typed(field, labelId, problem) {
    const number = field.type === 'number';
    const input = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (
      element(field.multiline ? 'textarea' : 'input', 'form-input')
    );
    if (number) {
      Object.assign(input, { type: 'number', inputMode: 'decimal' });
      for (const key of ['min', 'max', 'step'])
        if (field[key] !== undefined) input.setAttribute(key, String(field[key]));
    } else {
      if (!field.multiline) /** @type {HTMLInputElement} */ (input).type = 'text';
      input.maxLength = field.maxLength ?? answerChars;
      if (field.placeholder) input.placeholder = field.placeholder;
    }
    input.setAttribute('aria-labelledby', labelId);
    const control = element('div', 'form-typed');
    control.append(input);
    if (field.unit) control.append(element('span', 'form-unit', field.unit));
    if (field.default !== undefined) control.append(element('span', 'form-suggested', `suggested: ${field.default}`));
    let told = null;
    let waiting = null;
    const read = () => {
      const text = input.value.trim();
      if (!text) return { value: null };
      if (!number) return { value: text };
      const value = Number(text);
      const range = [
        field.min === undefined ? null : `at least ${field.min}`,
        field.max === undefined ? null : `at most ${field.max}`,
      ]
        .filter(Boolean)
        .join(' and ');
      if (!Number.isFinite(value) || value < (field.min ?? -Infinity) || value > (field.max ?? Infinity))
        return { error: `Enter a number${range ? `, ${range}` : ''}` };
      return { value };
    };
    const flush = () => {
      waiting = null;
      const { value, error } = read();
      problem(error ?? '');
      if (error) return;
      const next = JSON.stringify(value);
      if (next === told) return;
      told = next;
      answer(field, value);
    };
    input.addEventListener('input', () => {
      const mine = {};
      waiting = mine;
      later(() => waiting === mine && flush(), TYPING_PAUSE);
    });
    input.addEventListener('change', flush);
    return {
      control,
      inputs: [input],
      show(value, readOnly) {
        told = JSON.stringify(value ?? null);
        if (!readOnly && (document.activeElement === input || waiting)) return;
        input.value = value === undefined ? '' : String(value);
      },
    };
  }

  function fieldElement(field) {
    serial += 1;
    const wrap = element('div', 'form-field');
    wrap.dataset.field = field.id;
    wrap.dataset.kind = field.type;
    const labelId = `form-label-${serial}`;
    const label = element('div', 'form-label', field.label);
    label.id = labelId;
    wrap.append(label);
    if (field.help) wrap.append(element('p', 'form-help', field.help));
    const error = element('p', 'form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const problem = (message) => {
      error.textContent = message;
      error.hidden = !message;
    };
    const drawn = ['text', 'number'].includes(field.type)
      ? typed(field, labelId, problem)
      : options(field, `form-field-${serial}`, field.type === 'multi');
    if (!drawn.control.hasAttribute('aria-labelledby')) drawn.control.setAttribute('aria-labelledby', labelId);
    const foot = element('div', 'form-foot');
    const status = element('span', 'form-state');
    const reset = /** @type {HTMLButtonElement} */ (
      element('button', 'form-reset', field.default === undefined ? 'Clear' : 'Back to the suggestion')
    );
    reset.type = 'button';
    reset.addEventListener('click', () => {
      problem('');
      answer(field, null);
    });
    foot.append(status, reset);
    wrap.append(drawn.control, error, foot);
    appliers.set(wrap, ({ readOnly, fields }) => {
      const held = Object.hasOwn(fields, field.id) ? fields[field.id] : {};
      drawn.show(held.value, readOnly);
      for (const input of drawn.inputs) input.disabled = readOnly;
      status.textContent = Object.hasOwn(STATES, held.state) ? STATES[held.state] : '';
      wrap.dataset.state = Object.hasOwn(STATES, held.state) ? held.state : 'open';
      reset.hidden = readOnly || !held.own;
    });
    return wrap;
  }

  return {
    /** The renderer of `form` blocks. */
    render(figure, block) {
      const fields = parseForm(block.text).fields.map(fieldElement);
      figure.replaceChildren(...fields);
      for (const field of fields) appliers.get(field)(state);
    },
    /**
     * Shows what the dashboard holds: the answer of each question, and whether this version can still be answered.
     * @param {ParentNode} container
     * @param {{ readOnly?: boolean, fields: Record<string, FieldState> }} next A message of the dashboard; without
     *   `readOnly: false` nothing can be changed.
     */
    set(container, next) {
      const fields = typeof next.fields === 'object' && next.fields !== null ? next.fields : {};
      state = { readOnly: next.readOnly !== false, fields };
      for (const field of container.querySelectorAll('.form-field')) appliers.get(field)?.(state);
    },
  };
}
