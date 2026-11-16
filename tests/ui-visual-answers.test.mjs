import test from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './ui-fixture.mjs';
import { ID, record, section, versionOf, viewer, withVisuals } from './ui-visuals-fixture.mjs';
import { answerState, answerText, reportedAnswer } from '../public/visual-answers.js';

const SECTIONS = [section('a', 'a1'), section('ask', 'ask1')];
const DATABASE = {
  id: 'database',
  key: '00000000000000aa',
  type: 'choice',
  label: 'Which database? <img src=x onerror="window.injected = true">',
  options: [
    { id: 'sqlite', label: 'SQLite' },
    { id: 'postgres', label: 'Postgres' },
  ],
  default: 'sqlite',
};
const NOTES = { id: 'notes', key: '00000000000000bb', type: 'text', label: 'Notes' };
const WORKERS = { id: 'workers', key: '00000000000000cc', type: 'number', label: 'Workers', unit: 'workers' };
// The questions as the service sends them to the user: the suggestion counts as the answer until the user changes it.
const forms = () => [
  {
    sectionId: 'ask',
    block: 1,
    fields: [
      { ...DATABASE, answer: { value: 'sqlite', source: 'default' }, unsent: true, sent: null },
      { ...NOTES, answer: null, unsent: false, sent: null },
      { ...WORKERS, answer: null, unsent: false, sent: null },
    ],
  },
];

/** @param {any} t @param {{ visual?: any, versions?: Record<string, any> }} [options] */
async function answering(t, { visual = record({ openQuestions: 3 }), versions } = {}) {
  const ui = await viewer(t, {
    hash: `#visuals/${ID}`,
    visuals: [visual],
    versions: versions ?? { latest: versionOf(visual, 2, SECTIONS, { forms: forms() }) },
  });
  await settle();
  ui.attach();
  ui.fromFrame({ type: 'ready' });
  const rows = () =>
    [...ui.window.document.querySelectorAll('#visual-questions-list .visual-question')].map((row) => [
      row.querySelector('.visual-question-label').textContent,
      row.querySelector('.visual-question-state').textContent,
      row.querySelector('.visual-question-value').textContent,
    ]);
  const report = async (field, value) => {
    ui.fromFrame({ type: 'answer', field, value });
    await settle();
  };
  return { ...ui, rows, report };
}

test('the dashboard lists the questions with what would be sent, and tells the frame what to show', async (t) => {
  const ui = await answering(t);
  const { $ } = ui;
  assert.equal(ui.window.injected, undefined);
  assert.equal($('#visual-questions').hidden, false);
  assert.equal($('#visual-questions img'), null);
  assert.equal($('#visual-questions-count').textContent, '1 of 3');
  assert.deepEqual(ui.rows(), [
    ['Which database? <img src=x onerror="window.injected = true">', 'Suggested', 'SQLite'],
    ['Notes', 'No answer', '—'],
    ['Workers', 'No answer', '—'],
  ]);
  assert.equal(
    $('#visual-questions-note').textContent,
    '@lead reads your answers when you send them. A suggestion that you keep is sent as your answer.',
  );
  assert.deepEqual(
    [$('#visual-questions-send').hidden, $('#visual-questions-send').textContent],
    [false, 'Send answers'],
  );
  assert.deepEqual(
    [$('#visual-questions-bar').hidden, $('#visual-questions-bar-text').textContent],
    [false, '1 answer not sent'],
  );
  // The frame draws the controls from this, and the outline says where a question waits.
  assert.deepEqual(ui.answers.at(-1), {
    type: 'answers',
    readOnly: false,
    fields: {
      database: { value: 'sqlite', state: 'suggested', own: false },
      notes: { state: 'open', own: false },
      workers: { state: 'open', own: false },
    },
    targetOrigin: '*',
  });
  const marks = [...ui.window.document.querySelectorAll('.visual-outline-item')].map(
    (item) => item.querySelector('.visual-outline-questions')?.title ?? null,
  );
  assert.deepEqual(marks, [null, '3 questions wait for your answer']);
  // A click on a question shows it in the visual.
  ui.window.document.querySelector('.visual-question').click();
  assert.deepEqual(ui.posted.at(-1), { type: 'scrollTo', sectionId: 'ask', targetOrigin: '*' });
});

test('an answer that the frame reports is stored by its question, and nothing else the frame says is', async (t) => {
  const ui = await answering(t);
  await ui.report('database', 'postgres');
  await ui.report('notes', 'Keep the files');
  await ui.report('workers', 4);
  assert.deepEqual(ui.calls, [
    ['PATCH', '/answers', { version: 2, answers: [{ key: DATABASE.key, value: 'postgres' }] }],
    ['PATCH', '/answers', { version: 2, answers: [{ key: NOTES.key, value: 'Keep the files' }] }],
    ['PATCH', '/answers', { version: 2, answers: [{ key: WORKERS.key, value: 4 }] }],
  ]);
  assert.deepEqual(ui.rows(), [
    ['Which database? <img src=x onerror="window.injected = true">', 'Not sent', 'Postgres'],
    ['Notes', 'Not sent', 'Keep the files'],
    ['Workers', 'Not sent', '4 workers'],
  ]);
  assert.equal(ui.$('#visual-questions-bar-text').textContent, '3 answers not sent');
  assert.deepEqual(ui.answers.at(-1).fields.database, { value: 'postgres', state: 'unsent', own: true });

  // Taking an answer back returns to the suggestion.
  await ui.report('database', null);
  assert.deepEqual(ui.calls.at(-1), [
    'PATCH',
    '/answers',
    { version: 2, answers: [{ key: DATABASE.key, value: null }] },
  ]);
  assert.deepEqual(ui.rows()[0].slice(1), ['Suggested', 'SQLite']);

  const before = ui.calls.length;
  for (const [field, value] of [
    ['missing', 'x'],
    ['constructor', 'x'],
    [{ toString: () => 'database' }, 'sqlite'],
    ['database', 'mysql'],
    ['database', ['sqlite']],
    ['database', undefined],
    ['notes', 7],
    ['notes', 'x'.repeat(2001)],
    ['workers', '4'],
    ['workers', Number.NaN],
    ['workers', Infinity],
  ])
    await ui.report(field, value);
  // A page that is not the frame of this visual reports nothing.
  ui.fromFrame({ type: 'answer', field: 'database', value: 'postgres' }, ui.window);
  await settle();
  assert.equal(ui.calls.length, before);

  // The service has the last word on an answer, and the panel says why it kept the earlier one.
  ui.served.failAnswer = 'Question notes: an answer goes to the author of the visual only.';
  await ui.report('notes', 'ask @worker');
  assert.equal(ui.$('#visual-questions-error').textContent, ui.served.failAnswer);
  assert.equal(ui.rows()[1][2], 'Keep the files');
});

test('Send answers sends the list that the panel shows, with the draft comments of the version', async (t) => {
  const ui = await answering(t);
  await ui.report('notes', 'Keep the files');
  ui.served.comments.push({
    id: 'vc-00000001',
    visualId: ID,
    version: 2,
    sectionId: null,
    sectionRev: null,
    block: null,
    quote: null,
    text: 'Shorter',
    status: 'draft',
    createdAt: '2026-11-04T11:00:00Z',
    updatedAt: '2026-11-04T11:00:00Z',
    sentAt: null,
    messageId: null,
    answeredIn: null,
  });
  ui.update(withVisuals(record({ openQuestions: 3, commentRevision: 1 })));
  await settle();
  assert.equal(ui.$('#visual-questions-send').textContent, 'Send answers and 1 comment');

  ui.click('#visual-questions-send');
  await settle();
  // The suggestion that the user kept and the answer that the user gave; a question without an answer is left out.
  assert.deepEqual(ui.calls.at(-1), [
    'POST',
    '/feedback',
    { version: 2, answers: { [DATABASE.key]: 'sqlite', [NOTES.key]: 'Keep the files' } },
  ]);
  assert.deepEqual(
    ui.rows().map(([, state, value]) => [state, value]),
    [
      ['Sent', 'SQLite'],
      ['Sent', 'Keep the files'],
      ['No answer', '—'],
    ],
  );
  assert.deepEqual(
    [
      ui.$('#visual-questions-send').hidden,
      ui.$('#visual-questions-bar').hidden,
      ui.$('#visual-questions-note').textContent,
    ],
    [true, true, '@lead has your answers so far.'],
  );
  assert.equal(ui.answers.at(-1).fields.notes.state, 'sent');

  // A refusal is shown, and the list is the service's again.
  await ui.report('workers', 2);
  ui.served.failAnswer = 'The questions or your answers changed since you reviewed them. Review them again, then send.';
  ui.click('#visual-questions-send');
  await settle();
  assert.equal(ui.$('#visual-questions-error').textContent, ui.served.failAnswer);
  assert.equal(ui.$('#visual-questions-send').disabled, false);
});

test('an earlier version shows its answers and takes none; a visual without questions shows no panel', async (t) => {
  const visual = record();
  const sent = { value: 'postgres', source: 'user', at: '2026-11-04T11:00:00Z' };
  const earlier = [
    {
      sectionId: 'ask',
      block: 1,
      fields: [{ ...DATABASE, answer: { value: 'postgres', source: 'user' }, unsent: false, sent }],
    },
  ];
  const ui = await answering(t, {
    visual,
    versions: {
      latest: versionOf(visual, 2, SECTIONS),
      1: versionOf(visual, 1, SECTIONS, { forms: earlier }),
    },
  });
  assert.equal(ui.$('#visual-questions').hidden, true);
  assert.equal(ui.$('#visual-questions-bar').hidden, true);
  assert.deepEqual(ui.answers.at(-1), { type: 'answers', readOnly: false, fields: {}, targetOrigin: '*' });

  ui.click('#visual-version-previous');
  await settle();
  assert.deepEqual(ui.rows(), [[DATABASE.label, 'Sent', 'Postgres']]);
  assert.equal(
    ui.$('#visual-questions-note').textContent,
    'These are the questions of version 1. Answer them on the newest version.',
  );
  assert.equal(ui.$('#visual-questions-send').hidden, true);
  assert.deepEqual(
    [ui.answers.at(-1).readOnly, ui.answers.at(-1).fields.database],
    [true, { value: 'postgres', state: 'sent', own: true }],
  );
  await ui.report('database', 'sqlite');
  assert.deepEqual(ui.calls, []);
});

test('the list of visuals says how many questions wait, and an answer from elsewhere is loaded', async (t) => {
  const visual = record({ openQuestions: 2 });
  const ui = await viewer(t, { hash: '#visuals', visuals: [visual], versions: {} });
  await settle();
  assert.equal(ui.$('.visual-card .visual-card-drafts').textContent, '2 questions');

  const open = await answering(t, { visual });
  const loads = open.asked.length;
  open.served.versions.latest.shown.forms[0].fields[1].answer = { value: 'From the phone', source: 'user' };
  open.update(withVisuals({ ...visual, answerRevision: 1 }));
  await settle();
  assert.equal(open.asked.length, loads + 1);
  assert.equal(open.rows()[1][2], 'From the phone');
});

test('an answer is put into words and a state by its question', () => {
  const multi = { type: 'multi', options: DATABASE.options };
  assert.deepEqual(
    [
      answerText(DATABASE, 'postgres'),
      answerText(multi, ['sqlite', 'postgres']),
      answerText(multi, []),
      answerText({ type: 'toggle' }, false),
      answerText(WORKERS, 3),
      answerText({ type: 'number' }, 3),
      // The whole text: what the user sends is what the list shows.
      answerText(NOTES, 'x'.repeat(2000)).length,
    ],
    ['Postgres', 'SQLite, Postgres', 'None of them', 'No', '3 workers', '3', 2000],
  );
  assert.deepEqual(
    [
      answerState({ answer: null, unsent: false }),
      // The author has an answer that the user took back.
      answerState({ answer: null, unsent: true }),
      answerState({ answer: { source: 'default' }, unsent: true }),
      answerState({ answer: { source: 'user' }, unsent: true }),
      answerState({ answer: { source: 'default' }, unsent: false }),
    ],
    ['open', 'unsent', 'suggested', 'unsent', 'sent'],
  );
  assert.deepEqual(
    [reportedAnswer(multi, ['postgres']), reportedAnswer(multi, ['x']), reportedAnswer({ type: 'toggle' }, true)],
    [['postgres'], undefined, true],
  );
  assert.equal(reportedAnswer({ type: 'toggle' }, 'true'), undefined);
  assert.equal(reportedAnswer({ type: 'range' }, 1), undefined);
});

test('a question whose sent answer was taken back says what the author still has', async (t) => {
  const visual = record({ openQuestions: 1 });
  const sent = { value: 'Keep the files', source: 'user', at: '2026-01-01T00:00:00.000Z' };
  const ui = await answering(t, {
    visual,
    versions: {
      latest: versionOf(visual, 2, SECTIONS, {
        forms: [{ sectionId: 'ask', block: 1, fields: [{ ...NOTES, answer: null, unsent: true, sent }] }],
      }),
    },
  });
  assert.deepEqual(ui.rows(), [['Notes', 'Not sent', 'No answer now; sent before: Keep the files']]);
  assert.equal(ui.$('#visual-questions-send').hidden, false);
  assert.deepEqual(ui.answers.at(-1).fields, { notes: { state: 'unsent', own: false } });
});
