import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FORM_LIMITS, parseBlocks, parseForm } from '../src/visual-format.mjs';
import { createForms } from '../public/visual/form.js';
import { createRenderer } from '../public/visual/render.js';

const FIELDS = [
  {
    id: 'database',
    type: 'choice',
    label: 'Which database? <img src=x onerror="window.injected = true">',
    help: 'One store for all sessions.',
    options: [
      { id: 'sqlite', label: 'SQLite', hint: 'One file' },
      { id: 'postgres', label: '<b>Postgres</b>' },
    ],
    default: 'sqlite',
  },
  {
    id: 'extras',
    type: 'multi',
    label: 'Extras',
    options: [
      { id: 'backup', label: 'Backup' },
      { id: 'metrics', label: 'Metrics' },
    ],
  },
  { id: 'notes', type: 'text', label: 'Notes', multiline: true, placeholder: 'Anything else' },
  { id: 'workers', type: 'number', label: 'Workers', min: 1, max: 8, unit: 'workers', default: 2 },
  { id: 'dry-run', type: 'toggle', label: 'Dry run first?' },
];
const form = (fields = FIELDS) => `\`\`\`form\n${JSON.stringify({ fields })}\n\`\`\``;
const settle = () => new Promise((resolve) => setImmediate(resolve));

// The frame's page with a form drawn in it; `told` holds what it reports to the dashboard, and `pause` ends the
// wait after the reader stopped typing.
async function drawn(t, body = form()) {
  const { window } = new JSDOM('<main id="document"></main>', { runScripts: 'outside-only' });
  t.after(() => window.close());
  const told = [];
  const timers = [];
  const forms = createForms({
    document: window.document,
    parseForm,
    answerChars: FORM_LIMITS.answerChars,
    tell: (message) => told.push(message),
    later: (work) => timers.push(work),
  });
  const reported = [];
  const renderer = createRenderer({
    document: window.document,
    parseBlocks,
    markdownHtml: (source) => source,
    richBlocks: { form: forms.render },
    onProblems: (problems) => reported.push(problems),
  });
  const container = window.document.getElementById('document');
  const render = async (text = body, rev = 'ask-1') => {
    renderer.render(container, { sections: [{ id: 'ask', title: 'Ask', rev, body: text }] });
    await settle();
  };
  await render();
  const field = (id) => container.querySelector(`.form-field[data-field="${id}"]`);
  const inputs = (id) => [...field(id).querySelectorAll('input, textarea')];
  const fire = (target, type) => target.dispatchEvent(new window.Event(type, { bubbles: true }));
  const choose = (id, value, checked = true) => {
    const input = inputs(id).find((item) => item.value === value);
    input.checked = checked;
    fire(input, 'change');
  };
  const pause = () => timers.splice(0).forEach((work) => work());
  return { window, container, forms, told, reported, render, field, inputs, fire, choose, pause };
}

test('a form is drawn as controls, with the author’s words as text, and waits for the dashboard', async (t) => {
  const { window, container, reported, field, inputs } = await drawn(t);
  assert.deepEqual(reported.at(-1), []);
  assert.equal(window.injected, undefined);
  assert.equal(container.querySelector('img, b, form, script'), null);
  assert.equal(
    field('database').querySelector('.form-label').textContent,
    'Which database? <img src=x onerror="window.injected = true">',
  );
  assert.deepEqual(
    [...field('database').querySelectorAll('.form-option')].map((option) => option.textContent),
    ['SQLiteOne filesuggested', '<b>Postgres</b>'],
  );
  assert.deepEqual(
    FIELDS.map(({ id }) => [id, inputs(id).map((input) => input.type)]),
    [
      ['database', ['radio', 'radio']],
      ['extras', ['checkbox', 'checkbox']],
      ['notes', ['textarea']],
      ['workers', ['number']],
      ['dry-run', ['radio', 'radio']],
    ],
  );
  assert.deepEqual((({ min, max, placeholder }) => [min, max, placeholder])(inputs('workers')[0]), ['1', '8', '']);
  assert.equal(inputs('notes')[0].maxLength, FORM_LIMITS.answerChars);
  // Each question is a group of its own, so the radios of two questions do not exclude each other.
  assert.notEqual(inputs('database')[0].name, inputs('dry-run')[0].name);
  // Until the dashboard says that this version can be answered, nothing can be changed.
  assert.equal(
    container.querySelectorAll('input:disabled, textarea:disabled').length,
    container.querySelectorAll('input, textarea').length,
  );
});

test('the controls show what the dashboard holds, and a redrawn form shows it again', async (t) => {
  const { container, forms, render, field, inputs } = await drawn(t);
  forms.set(container, {
    readOnly: false,
    fields: {
      database: { value: 'sqlite', state: 'suggested', own: false },
      extras: { value: ['metrics'], state: 'unsent', own: true },
      notes: { value: 'Keep the files', state: 'sent', own: true },
      workers: { value: 2, state: 'suggested', own: false },
      'dry-run': { state: 'open', own: false },
      // A name that is no question of this form, and one that every object has.
      constructor: { value: 'x' },
    },
  });
  const shown = () =>
    FIELDS.map(({ id }) => [
      id,
      inputs(id).map((input) => (['radio', 'checkbox'].includes(input.type) ? input.checked : input.value)),
      field(id).dataset.state,
      field(id).querySelector('.form-state').textContent,
      field(id).querySelector('.form-reset').hidden,
    ]);
  const expected = [
    ['database', [true, false], 'suggested', 'Suggestion of the author, not sent yet', true],
    ['extras', [false, true], 'unsent', 'Not sent yet', false],
    ['notes', ['Keep the files'], 'sent', 'Sent', false],
    ['workers', ['2'], 'suggested', 'Suggestion of the author, not sent yet', true],
    ['dry-run', [false, false], 'open', '', true],
  ];
  assert.deepEqual(shown(), expected);
  assert.equal(container.querySelector('input:disabled, textarea:disabled'), null);
  assert.deepEqual(
    [field('extras').querySelector('.form-reset').textContent, field('notes').querySelector('.form-reset').textContent],
    ['Clear', 'Clear'],
  );

  // The author changed the section: the form is drawn again and shows the same answers.
  const before = field('database');
  await render(`${form()}\n\nMore text.`, 'ask-2');
  assert.notEqual(field('database'), before);
  assert.deepEqual(shown(), expected);

  // An earlier version shows its answers and takes no change.
  forms.set(container, { fields: { database: { value: 'postgres', state: 'sent', own: true } } });
  assert.deepEqual(
    inputs('database').map((input) => [input.checked, input.disabled]),
    [
      [false, true],
      [true, true],
    ],
  );
  assert.equal(field('database').querySelector('.form-reset').hidden, true);
});

test('the frame reports each answer to the dashboard and keeps none', async (t) => {
  const { window, container, forms, told, field, inputs, fire, choose, pause } = await drawn(t);
  forms.set(container, { readOnly: false, fields: { database: { value: 'sqlite', state: 'suggested' } } });
  choose('database', 'postgres');
  choose('extras', 'metrics');
  choose('extras', 'backup');
  choose('extras', 'backup', false);
  choose('extras', 'metrics', false);
  choose('dry-run', 'no');
  assert.deepEqual(told.splice(0), [
    { type: 'answer', field: 'database', value: 'postgres' },
    { type: 'answer', field: 'extras', value: ['metrics'] },
    // In the order of the options, whatever the order of the clicks.
    { type: 'answer', field: 'extras', value: ['backup', 'metrics'] },
    { type: 'answer', field: 'extras', value: ['metrics'] },
    { type: 'answer', field: 'extras', value: [] },
    { type: 'answer', field: 'dry-run', value: false },
  ]);

  // Text goes out when the reader pauses or leaves the control, once for each text.
  const [notes] = inputs('notes');
  notes.focus();
  notes.value = 'Keep';
  fire(notes, 'input');
  notes.value = '  Keep the files  ';
  fire(notes, 'input');
  assert.deepEqual(told, []);
  pause();
  fire(notes, 'change');
  assert.deepEqual(told.splice(0), [{ type: 'answer', field: 'notes', value: 'Keep the files' }]);
  // What the dashboard sends back does not replace the text that the reader is still at.
  forms.set(container, { readOnly: false, fields: { notes: { value: 'Keep the files', state: 'unsent', own: true } } });
  assert.equal(notes.value, '  Keep the files  ');
  assert.equal(window.document.activeElement, notes);
  notes.blur();
  forms.set(container, { readOnly: false, fields: { notes: { value: 'Keep the files', state: 'unsent', own: true } } });
  assert.equal(notes.value, 'Keep the files');
  notes.value = ' ';
  fire(notes, 'change');
  assert.deepEqual(told.splice(0), [{ type: 'answer', field: 'notes', value: null }]);

  // A number outside its range is said in place and not reported.
  const [workers] = inputs('workers');
  const error = field('workers').querySelector('.form-error');
  workers.value = '12';
  fire(workers, 'change');
  assert.deepEqual(
    [told.length, error.hidden, error.textContent],
    [0, false, 'Enter a number, at least 1 and at most 8'],
  );
  workers.value = '4';
  fire(workers, 'change');
  assert.deepEqual([told.splice(0), error.hidden], [[{ type: 'answer', field: 'workers', value: 4 }], true]);

  // Taking an answer back is an answer too: the dashboard decides what the question shows then.
  forms.set(container, { readOnly: false, fields: { database: { value: 'postgres', state: 'unsent', own: true } } });
  const reset = field('database').querySelector('.form-reset');
  assert.deepEqual([reset.hidden, reset.textContent], [false, 'Back to the suggestion']);
  reset.click();
  assert.deepEqual(told.splice(0), [{ type: 'answer', field: 'database', value: null }]);
});

test('a form that does not parse is reported in its place like any block that cannot be drawn', async (t) => {
  const { container, reported } = await drawn(t, form([{ id: 'x', type: 'slider', label: 'Speed' }]));
  assert.match(container.querySelector('.visual-block-error p').textContent, /Form field 1 \(x\)/);
  assert.equal(reported.at(-1).length, 1);
  assert.equal(container.querySelector('input'), null);
});
