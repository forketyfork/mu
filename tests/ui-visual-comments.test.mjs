import test from 'node:test';
import assert from 'node:assert/strict';
import { createdAt, initialState, settle } from './ui-fixture.mjs';
import { ID, record, section, versionOf, viewer, withVisuals } from './ui-visuals-fixture.mjs';
import { CONTEXT_CHARS, QUOTE_CHARS, selectionOf } from '../public/visual-comments.js';
import { COMMENT_LIMITS } from '../src/visual-format.mjs';

const SECTIONS = [section('a', 'a1'), section('b', 'b1')];
const QUOTE = { text: 'Text', prefix: '', suffix: ' of a' };
const ON_TEXT = { sectionId: 'a', sectionRev: 'a1', block: 0, quote: QUOTE };
// JSDOM lays nothing out, so every place is the top left corner of the stage.
const RECT = { left: 0, top: 0, right: 0, bottom: 0 };
const comment = (id, overrides = {}) => ({
  id,
  visualId: ID,
  version: 2,
  sectionId: 'a',
  sectionRev: 'a1',
  block: 0,
  quote: QUOTE,
  text: `Comment ${id}`,
  status: 'sent',
  createdAt,
  updatedAt: createdAt,
  sentAt: createdAt,
  messageId: 5,
  answeredIn: null,
  ...overrides,
});

// The viewer with version 2 of a visual open, and what a test does to the comment field.
async function commenting(t, options = {}) {
  const visual = record();
  const ui = await viewer(t, {
    hash: `#visuals/${ID}`,
    visuals: [visual],
    versions: { latest: versionOf(visual, 2, SECTIONS, options.shown), ...options.versions },
    ...options.viewer,
  });
  await settle();
  ui.attach();
  ui.fromFrame({ type: 'ready' });
  const field = ui.$('#visual-composer-text');
  const write = (text) => {
    field.value = text;
    field.dispatchEvent(new ui.window.Event('input'));
  };
  const submit = async () => {
    ui.$('#visual-composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
    await settle();
  };
  const press = async (selector) => {
    ui.click(selector);
    await settle();
  };
  const scopes = () =>
    [...ui.window.document.querySelectorAll('.visual-scope')].map(
      (option) => `${option.textContent}${option.getAttribute('aria-pressed') === 'true' ? '*' : ''}`,
    );
  const cards = (list = '#visual-comments-list') =>
    [...ui.window.document.querySelectorAll(`${list} .visual-comment`)].map((card) => [
      card.querySelector('.visual-comment-where').textContent,
      card.querySelector('.visual-comment-state').textContent,
      card.querySelector('.visual-comment-text').textContent,
    ]);
  return { ...ui, field, write, submit, press, scopes, cards };
}

test('the dashboard and the service agree on the size of a quote', () => {
  assert.deepEqual([QUOTE_CHARS, CONTEXT_CHARS], [COMMENT_LIMITS.quoteChars, COMMENT_LIMITS.contextChars]);
});

test('what the frame reports as selected is used only when it names shown content within the limits', () => {
  /** @type {(target: any, rect?: any) => any} */
  const report = (target, rect = RECT) => selectionOf({ target, rect }, SECTIONS);
  assert.deepEqual(report(ON_TEXT), { target: ON_TEXT, rect: RECT });
  assert.deepEqual(report({ ...ON_TEXT, quote: null, extra: 'dropped' }).target, { ...ON_TEXT, quote: null });
  assert.deepEqual(report({ sectionId: 'b', sectionRev: 'b1', block: null, quote: null }).target, {
    sectionId: 'b',
    sectionRev: 'b1',
    block: null,
    quote: null,
  });
  assert.equal(report(null), null, 'nothing is selected');
  /** @type {[string, any, any?][]} */
  const refused = [
    ['no target', undefined],
    ['a string', 'a'],
    ['a section that is not shown', { ...ON_TEXT, sectionId: 'c' }],
    ['content that is not shown any more', { ...ON_TEXT, sectionRev: 'a0' }],
    ['a quote without a block', { ...ON_TEXT, block: null }],
    ['a block that is no number', { ...ON_TEXT, block: '0', quote: null }],
    ['a negative block', { ...ON_TEXT, block: -1, quote: null }],
    ['a quote that is no object', { ...ON_TEXT, quote: 'Text' }],
    ['an empty quote', { ...ON_TEXT, quote: { ...QUOTE, text: '  ' } }],
    ['a long quote', { ...ON_TEXT, quote: { ...QUOTE, text: 'x'.repeat(QUOTE_CHARS + 1) } }],
    ['long surroundings', { ...ON_TEXT, quote: { ...QUOTE, prefix: 'x'.repeat(CONTEXT_CHARS + 1) } }],
    ['surroundings that are no text', { ...ON_TEXT, quote: { ...QUOTE, suffix: 7 } }],
    ['no place', ON_TEXT, null],
    ['a place that is no number', ON_TEXT, { ...RECT, top: 'NaN' }],
    ['an endless place', ON_TEXT, { ...RECT, right: Infinity }],
  ];
  for (const [why, target, rect] of refused)
    assert.equal(report(target, rect === undefined ? RECT : rect), undefined, why);
});

const LINE = { path: 'src/a.js', side: 'new', number: 12 };
const ON_LINE = { sectionId: 'a', sectionRev: 'a1', block: 1, quote: null, line: LINE };

test('a line of a patch that the frame reports is used only in the shape of a line, without a quote', () => {
  /** @type {(target: any) => any} */
  const report = (target) => selectionOf({ target, rect: RECT }, SECTIONS);
  assert.deepEqual(report(ON_LINE).target, ON_LINE);
  assert.deepEqual(report({ ...ON_LINE, line: { ...LINE, side: 'old', extra: 1 } }).target.line, {
    ...LINE,
    side: 'old',
  });
  assert.deepEqual(report({ ...ON_LINE, line: null }).target, {
    sectionId: 'a',
    sectionRev: 'a1',
    block: 1,
    quote: null,
  });
  /** @type {[string, any][]} */
  const refused = [
    ['a line and a quote', { ...ON_LINE, quote: QUOTE }],
    ['a line without a block', { ...ON_LINE, block: null }],
    ['a line that is no object', { ...ON_LINE, line: 'src/a.js:12' }],
    ['an empty path', { ...ON_LINE, line: { ...LINE, path: ' ' } }],
    ['a long path', { ...ON_LINE, line: { ...LINE, path: 'p'.repeat(401) } }],
    ['a path that is no text', { ...ON_LINE, line: { ...LINE, path: 7 } }],
    ['another side', { ...ON_LINE, line: { ...LINE, side: 'left' } }],
    ['a number that is no number', { ...ON_LINE, line: { ...LINE, number: '12' } }],
    ['line 0', { ...ON_LINE, line: { ...LINE, number: 0 } }],
    ['a fraction', { ...ON_LINE, line: { ...LINE, number: 1.5 } }],
    ['a line beyond the limit', { ...ON_LINE, line: { ...LINE, number: 1_000_000_001 } }],
  ];
  for (const [why, target] of refused) assert.equal(report(target), undefined, why);
});

test('a click on a line number of a patch makes a comment on that line', async (t) => {
  const ui = await commenting(t);
  ui.fromFrame({ type: 'selection', target: ON_LINE, rect: RECT });
  assert.deepEqual(ui.scopes(), ['Line src/a.js:12*', 'Section “a”', 'Whole visual']);
  assert.equal(ui.$('#visual-composer-quote').hidden, true);
  ui.click('#visual-comment-bubble');
  assert.deepEqual(ui.marks.at(-1).comments, [{ id: 'pending', ...ON_LINE, state: 'draft' }]);
  ui.write('Why here?');
  await ui.submit();
  assert.deepEqual(ui.calls.slice(0, 1), [['POST', '/comments', { version: 2, ...ON_LINE, text: 'Why here?' }]]);
  assert.deepEqual(ui.cards(), [['a, src/a.js:12', 'Sent', 'Why here?']]);
  // The comment used up the line; no click or selection ends it in the frame, so the field must not keep it.
  assert.deepEqual(ui.marks.at(-1).comments, [{ id: 'vc-00000001', ...ON_LINE, state: 'sent' }]);
  assert.deepEqual(ui.scopes(), ['Whole visual*']);
  // A removed line is named by its old number.
  ui.fromFrame({ type: 'selection', target: { ...ON_LINE, line: { ...LINE, side: 'old' } }, rect: RECT });
  assert.deepEqual(ui.scopes(), ['Line src/a.js:12 (old)*', 'Section “a”', 'Whole visual']);
});

test('a click elsewhere in the dashboard takes the offer to comment back, and the click on the offer takes it', async (t) => {
  const ui = await commenting(t);
  ui.fromFrame({ type: 'selection', target: ON_LINE, rect: RECT });
  assert.equal(ui.$('#visual-comment-bubble').hidden, false);
  ui.click('#visual-comments-list');
  assert.equal(ui.$('#visual-comment-bubble').hidden, true);
  // The line stays what the comment field is about until the frame says that it ended.
  assert.deepEqual(ui.scopes(), ['Line src/a.js:12*', 'Section “a”', 'Whole visual']);
  ui.fromFrame({ type: 'selection', target: null });
  assert.equal(ui.$('#visual-comment-bubble').hidden, true);
  assert.deepEqual(ui.scopes(), ['Whole visual*']);
  ui.fromFrame({ type: 'selection', target: ON_LINE, rect: RECT });
  assert.equal(ui.$('#visual-comment-bubble').hidden, false);
  ui.click('#visual-comment-bubble');
  assert.deepEqual(ui.scopes(), ['Line src/a.js:12*', 'Section “a”', 'Whole visual']);
});

test('a comment that is saved uses up the selection it was written on, as a draft and as a message', async (t) => {
  const ui = await commenting(t);
  ui.fromFrame({ type: 'active', sectionId: 'a' });
  for (const andSend of [false, true]) {
    ui.fromFrame({ type: 'selection', target: ON_LINE, rect: RECT });
    ui.click('#visual-comment-bubble');
    ui.write('Why here?');
    if (andSend) await ui.submit();
    else await ui.press('#visual-composer-draft');
    assert.equal(ui.field.value, '');
    // The Section button names the section that is read, not the one of the comment that was saved.
    ui.fromFrame({ type: 'active', sectionId: 'b' });
    assert.deepEqual(ui.scopes(), ['Section “b”', 'Whole visual*']);
    assert.equal(ui.$('#visual-comment-bubble').hidden, true);
    ui.fromFrame({ type: 'active', sectionId: 'a' });
  }
  // Selected text stays selected in the frame, and the frame tells about it again when it moves on the screen. The
  // text that a comment used up is not offered again; when the selection ends and is made again, it is.
  ui.fromFrame({ type: 'selection', target: ON_TEXT, rect: RECT });
  ui.click('#visual-comment-bubble');
  ui.write('Which store?');
  await ui.press('#visual-composer-draft');
  ui.fromFrame({ type: 'selection', target: ON_TEXT, rect: { ...RECT, top: -40, bottom: -20 } });
  assert.deepEqual(ui.scopes(), ['Section “a”', 'Whole visual*']);
  assert.equal(ui.$('#visual-comment-bubble').hidden, true);
  ui.fromFrame({ type: 'selection', target: null });
  ui.fromFrame({ type: 'selection', target: ON_TEXT, rect: RECT });
  assert.deepEqual(ui.scopes(), ['Selected text*', 'Section “a”', 'Whole visual']);
  assert.equal(ui.$('#visual-comment-bubble').hidden, false);
  ui.fromFrame({ type: 'selection', target: null });
  // The same holds for text of a heading, which is about the section; a click on a line is told once and offered anew.
  const heading = { sectionId: 'a', sectionRev: 'a1', block: null, quote: null };
  ui.fromFrame({ type: 'selection', target: heading, rect: RECT });
  ui.click('#visual-comment-bubble');
  ui.write('Why this name?');
  await ui.press('#visual-composer-draft');
  ui.fromFrame({ type: 'selection', target: heading, rect: { ...RECT, top: -40, bottom: -20 } });
  assert.deepEqual(ui.scopes(), ['Section “a”', 'Whole visual*']);
  assert.equal(ui.$('#visual-comment-bubble').hidden, true);
  ui.fromFrame({ type: 'selection', target: null });
  ui.fromFrame({ type: 'selection', target: ON_LINE, rect: RECT });
  ui.click('#visual-comment-bubble');
  ui.write('Why here?');
  await ui.press('#visual-composer-draft');
  ui.fromFrame({ type: 'selection', target: ON_LINE, rect: RECT });
  assert.deepEqual(ui.scopes(), ['Line src/a.js:12*', 'Section “a”', 'Whole visual']);
  ui.fromFrame({ type: 'selection', target: null });
  // A change to a draft is not a new comment: the selection that is shown stays.
  ui.fromFrame({ type: 'selection', target: ON_TEXT, rect: RECT });
  ui.click('.visual-comment.draft button:nth-child(2)');
  ui.write('Why this line?');
  await ui.press('#visual-composer-draft');
  assert.deepEqual(ui.scopes(), ['Selected text*', 'Section “a”', 'Whole visual']);
});

test('selected text is offered for a comment, and Send now makes it one message to the author', async (t) => {
  const ui = await commenting(t);
  const { $ } = ui;
  assert.deepEqual(ui.marks.at(-1).comments, []);
  assert.equal($('#visual-comment-bubble').hidden, true);
  assert.equal(
    $('#visual-comments-list').textContent,
    'No comments on this version. Select text in the visual to comment on it.',
  );

  // A report that names no shown content changes nothing.
  ui.fromFrame({ type: 'selection', target: { ...ON_TEXT, sectionRev: 'old' }, rect: RECT });
  assert.equal($('#visual-comment-bubble').hidden, true);

  ui.fromFrame({ type: 'selection', target: ON_TEXT, rect: RECT });
  assert.equal($('#visual-comment-bubble').hidden, false);
  assert.deepEqual(ui.scopes(), ['Selected text*', 'Section “a”', 'Whole visual']);
  assert.deepEqual([$('#visual-composer-quote').hidden, $('#visual-composer-quote').textContent], [false, 'Text']);
  assert.equal($('#visual-composer-send').disabled, true, 'an empty comment is not sent');

  ui.click('#visual-comment-bubble');
  assert.equal(ui.window.document.activeElement, ui.field);
  assert.equal($('#visual-comment-bubble').hidden, true);
  // The frame marks where the comment will stand while it is written.
  assert.deepEqual(ui.marks.at(-1).comments, [{ id: 'pending', ...ON_TEXT, state: 'draft' }]);
  assert.equal(ui.marks.at(-1).active, 'pending');

  // A phrase fills the field; another phrase replaces it; own words stay.
  ui.click('.visual-quick:nth-child(1)');
  assert.equal(ui.field.value, 'This is not clear. Explain it in simple words.');
  ui.click('.visual-quick:nth-child(2)');
  assert.equal(ui.field.value, 'Explain this in more detail.');
  ui.write('Which store?');
  ui.click('.visual-quick:nth-child(3)');
  assert.equal(ui.field.value, 'Which store? Give an example.');
  // The selection in the frame ends when the user clicks into the field; the comment keeps its place.
  ui.fromFrame({ type: 'selection', target: null });
  assert.deepEqual(ui.scopes(), ['Selected text*', 'Section “a”', 'Whole visual']);

  await ui.submit();
  assert.deepEqual(ui.calls, [
    ['POST', '/comments', { version: 2, ...ON_TEXT, text: 'Which store? Give an example.' }],
    ['POST', '/comments/send', { version: 2, ids: ['vc-00000001'] }],
  ]);
  assert.equal(ui.field.value, '');
  assert.equal($('#visual-composer-error').hidden, true);
  assert.deepEqual(ui.cards(), [['a', 'Sent', 'Which store? Give an example.']]);
  assert.equal($('.visual-comment .visual-comment-quote').textContent, 'Text');
  assert.equal($('.visual-comment').getAttribute('aria-current'), 'true');
  assert.equal($('#visual-comments-count').textContent, '1');
  assert.deepEqual(ui.marks.at(-1).comments, [{ id: 'vc-00000001', ...ON_TEXT, state: 'sent' }]);
  assert.equal(ui.marks.at(-1).active, 'vc-00000001');
  assert.equal($('.visual-outline-comments').textContent, '1');

  // Ctrl+Enter sends too.
  ui.write('And the cache?');
  ui.field.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, cancelable: true }));
  await settle();
  assert.deepEqual(ui.calls.at(-1), ['POST', '/comments/send', { version: 2, ids: ['vc-00000002'] }]);
  // Without a selection the comment is about the visual as a whole, or about the section that is read.
  assert.deepEqual(ui.calls.at(-2)[2], {
    version: 2,
    sectionId: null,
    block: null,
    quote: null,
    text: 'And the cache?',
  });
});

test('a draft is saved, changed, deleted and sent later; Send all sends the drafts together', async (t) => {
  const ui = await commenting(t);
  const { $ } = ui;
  // The frame says which section is at the reading line.
  ui.fromFrame({ type: 'active', sectionId: 'b' });
  assert.deepEqual(ui.scopes(), ['Section “b”', 'Whole visual*']);
  ui.write('Shorter, please');
  await ui.press('#visual-composer-draft');
  ui.click('.visual-scope:nth-child(1)');
  assert.deepEqual(ui.scopes(), ['Section “b”*', 'Whole visual']);
  ui.write('Add the rollback');
  await ui.press('#visual-composer-draft');
  assert.deepEqual(
    ui.calls.map(([method, path, body]) => [method, path, body.sectionId, body.sectionRev, body.text]),
    [
      ['POST', '/comments', null, undefined, 'Shorter, please'],
      ['POST', '/comments', 'b', 'b1', 'Add the rollback'],
    ],
  );
  assert.deepEqual(ui.cards(), [
    ['Whole visual', 'Draft', 'Shorter, please'],
    ['Section “b”', 'Draft', 'Add the rollback'],
  ]);
  assert.deepEqual(
    [$('#visual-comments-send-all').hidden, $('#visual-comments-send-all').textContent],
    [false, 'Send all 2'],
  );
  assert.deepEqual(
    ui.marks.at(-1).comments.map((mark) => [mark.id, mark.sectionId, mark.block, mark.state]),
    [['vc-00000002', 'b', null, 'draft']],
    'a comment on the whole visual has no place in the frame',
  );

  // Editing puts the draft into the field; saving changes its text only.
  const buttons = (card) => [...card.querySelectorAll('button')].map((button) => button.textContent);
  const [whole] = ui.window.document.querySelectorAll('.visual-comment');
  assert.deepEqual(buttons(whole), ['Send', 'Edit', 'Delete']);
  whole.querySelectorAll('button')[1].click();
  assert.equal(ui.field.value, 'Shorter, please');
  assert.deepEqual([$('#visual-composer-send').textContent, $('#visual-composer-draft').textContent], ['Send', 'Save']);
  ui.write('Much shorter, please');
  await ui.press('#visual-composer-draft');
  assert.deepEqual(ui.calls.at(-1), ['PATCH', '/comments/vc-00000001', { text: 'Much shorter, please' }]);
  assert.equal(ui.field.value, '');
  assert.equal($('#visual-composer-send').textContent, 'Send now');

  // A message that cannot be delivered leaves the comment as a draft, and says so.
  ui.served.failSend = 'IRC is not connected';
  ui.write('A third one');
  await ui.submit();
  assert.equal($('#visual-composer-error').textContent, 'The comment is saved as a draft. IRC is not connected');
  assert.equal(ui.field.value, '');
  assert.deepEqual(
    ui.cards().map(([, state, text]) => [state, text]),
    [
      ['Draft', 'Much shorter, please'],
      ['Draft', 'A third one'],
      ['Draft', 'Add the rollback'],
    ],
  );
  ui.served.failSend = null;

  const third = [...ui.window.document.querySelectorAll('.visual-comment')][1];
  third.querySelectorAll('button')[2].click();
  await settle();
  assert.deepEqual(ui.calls.at(-1), ['DELETE', '/comments/vc-00000003', {}]);
  assert.equal(ui.cards().length, 2);

  await ui.press('#visual-comments-send-all');
  assert.deepEqual(ui.calls.at(-1), ['POST', '/comments/send', { version: 2 }]);
  assert.deepEqual(
    ui.cards().map(([, state]) => state),
    ['Sent', 'Sent'],
  );
  assert.equal($('#visual-comments-send-all').hidden, true);
  assert.equal($('#visual-composer-error').hidden, true);

  // A send that fails after its message reached the chat leaves no draft, and the panel does not claim one.
  ui.served.failNotice = 'Message #7 was saved, but its delivery notice could not be posted: IRC is not connected';
  ui.write('A last one');
  await ui.submit();
  assert.equal($('#visual-composer-error').textContent, ui.served.failNotice);
  assert.deepEqual(
    ui.cards().map(([, state]) => state),
    ['Sent', 'Sent', 'Sent'],
  );
});

test('a click on marked text shows its comment, and a click on a comment shows its text in the visual', async (t) => {
  const ui = await commenting(t, {
    shown: {
      comments: [comment('vc-0000000a'), comment('vc-0000000b', { sectionId: 'b', sectionRev: 'b0', quote: null })],
    },
  });
  const cards = () => [...ui.window.document.querySelectorAll('#visual-comments-list .visual-comment')];
  assert.deepEqual(
    ui.marks.at(-1).comments.map((mark) => [mark.id, mark.sectionRev, mark.state]),
    [
      ['vc-0000000a', 'a1', 'sent'],
      ['vc-0000000b', 'b0', 'sent'],
    ],
  );
  // The author changed section b in the same turn, after the comment: the comment says so.
  assert.deepEqual(
    cards().map((card) => card.querySelector('.visual-comment-moved')?.textContent ?? null),
    [null, 'This section changed after the comment was written.'],
  );

  ui.fromFrame({ type: 'comment', id: 'vc-0000000b' });
  assert.equal(cards()[1].getAttribute('aria-current'), 'true');
  assert.equal(ui.marks.at(-1).active, 'vc-0000000b');
  ui.fromFrame({ type: 'comment', id: 'vc-unknown' });
  ui.fromFrame({ type: 'comment', id: { toString: () => 'vc-0000000a' } });
  assert.equal(ui.marks.at(-1).active, 'vc-0000000b', 'only a comment of this version is shown');

  cards()[0].click();
  assert.equal(cards()[0].getAttribute('aria-current'), 'true');
  assert.deepEqual(
    ui.posted.at(-1),
    { type: 'reveal', id: 'vc-0000000a', targetOrigin: '*' },
    'the frame brings the text into view',
  );
});

test('a version shows the comments it answers, where other comments are, and that a stopped author waits', async (t) => {
  const answered = comment('vc-0000000c', { version: 1, answeredIn: 2, text: 'Explain the cache' });
  const stopped = { ...withVisuals(record()), agents: [{ ...initialState().agents[0], status: 'stopped' }] };
  const visual = record();
  const latest = versionOf(visual, 2, SECTIONS, { comments: [comment('vc-0000000a')], answers: [answered] });
  latest.versions[0].comments = 3;
  latest.versions[1].comments = 1;
  const first = versionOf(visual, 1, [section('a', 'a0')], {
    comments: [answered, comment('vc-0000000d', { version: 1, sectionRev: 'a0', status: 'draft', sentAt: null })],
  });
  first.versions[0].comments = 3;
  const ui = await viewer(t, { hash: `#visuals/${ID}`, visuals: [visual], versions: { latest, 1: first } });
  ui.update(stopped);
  await settle();
  ui.attach();
  ui.fromFrame({ type: 'ready' });
  const { $ } = ui;
  const answers = [...ui.window.document.querySelectorAll('#visual-answers-list .visual-comment')];
  assert.equal($('#visual-answers').hidden, false);
  assert.deepEqual(
    answers.map((card) => [
      card.querySelector('.visual-comment-state').textContent,
      card.querySelector('.visual-comment-text').textContent,
    ]),
    [['On v1', 'Explain the cache']],
  );
  assert.equal(
    $('#visual-comments-note').textContent,
    '@lead is stopped; it reads comments when it is resumed.Comments on other versions:v1 (3)',
  );

  answers[0].querySelector('button').click();
  await settle();
  assert.equal(ui.window.location.hash, `#visuals/${ID}/v1`);
  // The comments of version 1 are there, each in its state; version 2 is named as the answer.
  const cards = [...ui.window.document.querySelectorAll('#visual-comments-list .visual-comment')];
  assert.deepEqual(
    cards.map((card) => card.querySelector('.visual-comment-state').textContent),
    ['Answered', 'Draft'],
  );
  assert.equal(cards[0].querySelector('footer button').textContent, 'Answered in version 2');
  assert.deepEqual(
    ui.marks.at(-1).comments.map((mark) => [mark.id, mark.state]),
    [
      ['vc-0000000c', 'answered'],
      ['vc-0000000d', 'draft'],
    ],
  );
  assert.equal($('#visual-answers').hidden, true);
});

test('the list of visuals shows the drafts that wait and the comments that were sent', async (t) => {
  const ui = await viewer(t, {
    visuals: [record({ draftComments: 2, openComments: 1 })],
    versions: {},
  });
  ui.click('.rail-link[data-view="visuals"]');
  await settle();
  assert.equal(ui.$('.visual-card-drafts').textContent, '2 drafts');
  assert.equal(ui.$('.visual-card-open').textContent, '1 comment sent');
});

test('a comment that changes on the service is loaded again, also on a pinned version', async (t) => {
  const visual = record({ version: 2, revision: 3 });
  const ui = await viewer(t, {
    hash: `#visuals/${ID}/v1`,
    visuals: [visual],
    versions: { 1: versionOf(visual, 1, [section('a', 'a0')]) },
  });
  await settle();
  ui.attach();
  ui.fromFrame({ type: 'ready' });
  assert.equal(ui.asked.length, 1);
  // The author answered a comment of version 1 in a new version: the record's comment counter moves.
  ui.served.versions[1] = versionOf(visual, 1, [section('a', 'a0')], {
    comments: [comment('vc-0000000c', { version: 1, sectionRev: 'a0', answeredIn: 3 })],
  });
  ui.update(withVisuals(record({ version: 3, revision: 4, commentRevision: 1 })));
  await settle();
  assert.equal(ui.asked.length, 2);
  assert.equal(ui.$('#visual-comments-list .visual-comment-state').textContent, 'Answered');
  assert.equal(ui.posted.at(-1).type, 'render', 'the content was not sent again as a change');
});

test('the comments that the author works on are lit for as long as its turn runs, and no longer', async (t) => {
  const visual = record();
  const state = (turn, overrides = visual) => ({
    ...withVisuals(overrides),
    agents: [{ ...initialState().agents[0], status: turn ? 'working' : 'idle', activeMessageId: turn }],
  });
  const onText = comment('vc-0000000a', { messageId: 7 });
  const onSection = comment('vc-0000000b', {
    messageId: 7,
    block: null,
    quote: null,
    sectionId: 'b',
    sectionRev: 'b1',
  });
  const onAll = comment('vc-0000000c', { messageId: 7, block: null, quote: null, sectionId: null, sectionRev: null });
  const later = comment('vc-0000000d', { messageId: 9 });
  const draft = comment('vc-0000000e', { status: 'draft', sentAt: null, messageId: null });
  const shown = { comments: [onText, onSection, onAll, later, draft] };
  const ui = await commenting(t, { shown });
  const lit = () => ui.working.at(-1).targets.map((target) => target.id);
  const states = () => ui.cards().map(([, cardState]) => cardState);

  // The comments are sent and nobody works on them.
  assert.deepEqual(ui.working.at(-1), { type: 'working', targets: [], targetOrigin: '*' });
  assert.deepEqual(states(), ['Sent', 'Sent', 'Sent', 'Draft', 'Sent']);
  assert.equal(ui.asked.length, 1);

  // The author's turn starts: the service is asked which comments it holds.
  ui.served.versions.latest = {
    ...versionOf(visual, 2, SECTIONS, shown),
    working: { turn: 7, comments: [onText.id, onSection.id, onAll.id] },
  };
  ui.update(state(7));
  await settle();
  assert.equal(ui.asked.length, 2);
  // The frame gets where each comment is, and nothing else of it.
  assert.deepEqual(ui.working.at(-1).targets, [
    { id: onText.id, ...ON_TEXT },
    { id: onSection.id, sectionId: 'b', sectionRev: 'b1', block: null, quote: null },
    { id: onAll.id, sectionId: null, sectionRev: null, block: null, quote: null },
  ]);
  assert.deepEqual(states(), ['In work', 'In work', 'Sent', 'Draft', 'In work']);
  const card = ui.$(`.visual-comment[data-comment="${onText.id}"]`);
  assert.equal(card.classList.contains('working'), true);
  assert.equal(card.querySelector('.visual-comment-state').title, '@lead is working on this comment');
  assert.equal(ui.posted.at(-1).type, 'render');
  assert.deepEqual(ui.posted.at(-1).flash, [], 'a turn that starts changes no content');

  // More news of the same turn asks for nothing and says nothing again.
  const told = ui.working.length;
  ui.update({ ...state(7), activities: [] });
  await settle();
  assert.deepEqual([ui.asked.length, ui.working.length], [2, told]);
  // A frame that drew everything again has no lights: it is told again.
  ui.fromFrame({ type: 'ready' });
  assert.equal(ui.working.length, told + 1);
  assert.deepEqual(lit(), [onText.id, onSection.id, onAll.id]);

  // The turn ends, by a reply, an error or a restart: the lights go out with the news, without a request.
  ui.update(state(null));
  await settle();
  assert.equal(ui.asked.length, 2);
  assert.deepEqual(lit(), []);
  assert.deepEqual(states(), ['Sent', 'Sent', 'Sent', 'Draft', 'Sent']);
  assert.equal(ui.window.document.querySelector('.visual-comment.working'), null);

  // The next turn holds the other message. What was loaded for the turn before lights nothing meanwhile.
  ui.served.versions.latest = { ...ui.served.versions.latest, working: { turn: 9, comments: [later.id] } };
  ui.update(state(9));
  assert.deepEqual(lit(), []);
  await settle();
  assert.equal(ui.asked.length, 3);
  assert.deepEqual(lit(), [later.id]);

  // The turn writes its version: the service names no comment for it, and the change is marked in place.
  const next = record({ version: 3, revision: 4 });
  ui.served.versions.latest = { ...versionOf(next, 3, [section('a', 'a2'), section('b', 'b1')]), working: null };
  ui.update(state(9, next));
  await settle();
  assert.deepEqual(lit(), []);
  assert.deepEqual(ui.posted.at(-1).flash, ['a']);

  // A turn on something else: one request, which finds no comment, and no light.
  const asked = ui.asked.length;
  ui.update(state(11, next));
  await settle();
  ui.update(state(11, next));
  await settle();
  assert.equal(ui.asked.length, asked + 1);
  assert.deepEqual(lit(), []);
});

test('the light on an earlier version that the user looks at goes out when the turn writes its version', async (t) => {
  const visual = record({ version: 2, revision: 3 });
  const onAll = comment('vc-0000000c', {
    version: 1,
    messageId: 7,
    block: null,
    quote: null,
    sectionId: null,
    sectionRev: null,
  });
  const first = versionOf(visual, 1, [section('a', 'a0')], { comments: [onAll] });
  const state = (shown) => ({
    ...withVisuals(shown),
    agents: [{ ...initialState().agents[0], status: 'working', activeMessageId: 7 }],
  });
  const ui = await viewer(t, {
    hash: `#visuals/${ID}/v1`,
    visuals: [visual],
    versions: { 1: { ...first, working: { turn: 7, comments: [onAll.id] } } },
  });
  ui.update(state(visual));
  await settle();
  ui.attach();
  ui.fromFrame({ type: 'ready' });
  const lit = () => ui.working.at(-1).targets.map((target) => target.id);
  assert.deepEqual(lit(), [onAll.id]);

  // The turn writes version 3. No comment and no answer changed, only the visual, and the turn goes on.
  const asked = ui.asked.length;
  const next = record({ version: 3, revision: 4 });
  ui.served.versions[1] = { ...versionOf(next, 1, [section('a', 'a0')], { comments: [onAll] }), working: null };
  ui.update(state(next));
  await settle();
  assert.equal(ui.asked.length, asked + 1);
  assert.deepEqual(lit(), []);
  assert.equal(ui.posted.at(-1).type, 'render', 'the content of the earlier version did not change');
  // Without a light, a later change of the visual does not concern the earlier version.
  ui.update(state(record({ version: 3, revision: 5 })));
  await settle();
  assert.equal(ui.asked.length, asked + 1);
});

test('a visual that is opened while its author works shows that at once', async (t) => {
  const visual = record();
  const onAll = comment('vc-0000000c', { messageId: 7, block: null, quote: null, sectionId: null, sectionRev: null });
  const latest = {
    ...versionOf(visual, 2, SECTIONS, { comments: [onAll] }),
    working: { turn: 7, comments: [onAll.id] },
  };
  const ui = await viewer(t, {
    hash: `#visuals/${ID}`,
    visuals: [visual],
    versions: { latest },
  });
  ui.update({
    ...withVisuals(visual),
    agents: [{ ...initialState().agents[0], status: 'working', activeMessageId: 7 }],
  });
  await settle();
  ui.attach();
  ui.fromFrame({ type: 'ready' });
  assert.deepEqual(
    ui.working.at(-1).targets.map((target) => target.id),
    [onAll.id],
  );
  assert.equal(ui.$('#visual-comments-list .visual-comment-state').textContent, 'In work');
  // The turn that was loaded is known: the next news of it asks for nothing.
  const asked = ui.asked.length;
  ui.update({
    ...withVisuals(visual),
    agents: [{ ...initialState().agents[0], status: 'working', activeMessageId: 7 }],
    activities: [],
  });
  await settle();
  assert.equal(ui.asked.length, asked);
});
