import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';
import { mentions } from '../src/store.mjs';
import { FORM_LIMITS, answerOf, parseBlocks, parseForm } from '../src/visual-format.mjs';
import { team } from './visuals-fixture.mjs';

const fence = (fields) => `\`\`\`form\n${JSON.stringify({ fields }, null, 2)}\n\`\`\``;
const DATABASE = {
  id: 'database',
  type: 'choice',
  label: 'Which database?',
  options: [
    { id: 'sqlite', label: 'SQLite', hint: 'One file, no server' },
    { id: 'postgres', label: 'PostgreSQL' },
  ],
  default: 'sqlite',
};
const EXTRAS = {
  id: 'extras',
  type: 'multi',
  label: 'What else belongs in the first step?',
  options: [
    { id: 'tests', label: 'Migration tests' },
    { id: 'backup', label: 'A backup command' },
  ],
};
const NOTES = { id: 'notes', type: 'text', label: 'Anything I should know?', multiline: true };
const WORKERS = { id: 'workers', type: 'number', label: 'How many workers?', min: 1, max: 16, default: 4 };
const DRY_RUN = { id: 'dry-run', type: 'toggle', label: 'Start with a dry run?' };
const PLAN = `# Storage plan

Why we move.

## Storage {#storage}

Two candidates.

${fence([DATABASE, EXTRAS])}

## Rollout {#rollout}

${fence([NOTES, WORKERS, DRY_RUN])}
`;

// A visual with two forms that the worker wrote in a turn that has ended.
async function asked(t, source = PLAN) {
  const context = await team(t);
  context.startTurn('worker');
  const visual = (await context.worker('POST', '/api/visuals', { source })).body;
  context.app.runner.active.clear();
  const path = `/api/visuals/${visual.id}`;
  const shown = async (who = context.user, version = '') =>
    (await who('GET', `${path}${version ? `?version=${version}` : ''}`)).body.shown;
  const fields = async (who, version) => (await shown(who, version)).forms.flatMap((form) => form.fields);
  const keys = async () => Object.fromEntries((await fields()).map((field) => [field.id, field.key]));
  // What the dashboard does when the user changes a control.
  const answer = async (values, version = 1) => {
    const key = await keys();
    return context.user('PATCH', `${path}/answers`, {
      version,
      answers: Object.entries(values).map(([id, value]) => ({ key: key[id], value })),
    });
  };
  // What the dashboard sends for review: the answer of every question that has one.
  const reviewed = async () =>
    Object.fromEntries(
      (await fields()).filter((field) => field.answer).map((field) => [field.key, field.answer.value]),
    );
  const send = async (version = 1) => context.user('POST', `${path}/feedback`, { version, answers: await reviewed() });
  const messages = async () => (await context.user('GET', '/api/conversations/work/messages?limit=50')).body.messages;
  // The chat message of a send; a notice about its delivery may follow it.
  const sentText = async (sent) => (await messages()).find((message) => message.id === sent.body.messageId).text;
  const record = async () => (await context.user('GET', '/api/visuals')).body.find((item) => item.id === visual.id);
  const read = async (who = context.worker, version = '') =>
    (await who('GET', `${path}/answers${version ? `?version=${version}` : ''}`)).body;
  return { ...context, visual, path, shown, fields, keys, answer, reviewed, send, messages, sentText, record, read };
}

test('a form block is JSON with typed fields, and every mistake names the field', () => {
  const { fields } = parseForm(JSON.stringify({ fields: [DATABASE, EXTRAS, NOTES, WORKERS, DRY_RUN] }));
  assert.deepEqual(fields, [DATABASE, EXTRAS, NOTES, WORKERS, DRY_RUN]);
  // The same question has the same text whatever the order of its properties, so its answer finds it again.
  const shuffled = {
    default: 'sqlite',
    options: DATABASE.options,
    label: '  Which database?  ',
    type: 'choice',
    id: 'database',
  };
  assert.equal(JSON.stringify(parseForm(JSON.stringify({ fields: [shuffled] })).fields[0]), JSON.stringify(DATABASE));
  assert.deepEqual(
    parseBlocks(`Text\n\n${fence([DRY_RUN])}`).map((block) => block.type),
    ['markdown', 'form'],
  );

  const refused = (fieldsOrText, pattern) =>
    assert.throws(
      () => parseForm(typeof fieldsOrText === 'string' ? fieldsOrText : JSON.stringify({ fields: fieldsOrText })),
      pattern,
    );
  refused('{"fields": [', /A form block is JSON, and this one does not parse/);
  refused('[]', /JSON object with a list "fields"/);
  refused('{"fields": [], "title": "x"}', /A form has no property "title"; it takes fields/);
  refused([], /A form has 1–30 fields/);
  refused(
    Array.from({ length: FORM_LIMITS.fields + 1 }, (_, index) => ({ ...DRY_RUN, id: `f${index}` })),
    /1–30 fields/,
  );
  refused([{ ...DRY_RUN, id: 'Dry Run' }], /Form field 1 \(Dry Run\): "id" must start with a lowercase letter/);
  refused([DRY_RUN, DRY_RUN], /Form field 2 \(dry-run\): this ID is used twice in the form/);
  refused([{ ...DRY_RUN, type: 'date' }], /"type" is one of choice, multi, text, number, toggle/);
  refused([{ ...DRY_RUN, label: ' ' }], /"label" must be text of 1–300 characters/);
  refused([{ ...DRY_RUN, label: 'a\u0007b' }], /"label" must be text/);
  refused(
    [{ ...DRY_RUN, required: true }],
    /a toggle field has no property "required"; it takes id, type, label, help, default/,
  );
  refused([{ ...DATABASE, options: [DATABASE.options[0]] }], /"options" must be a list of 2–12 options/);
  refused(
    [
      {
        ...DATABASE,
        options: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'B' },
        ],
      },
    ],
    /option ID a is used twice/,
  );
  refused(
    [
      {
        ...DATABASE,
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', onclick: 'x' },
        ],
      },
    ],
    /option 2 has no property "onclick"/,
  );
  refused(
    [{ ...DATABASE, default: 'mysql' }],
    /"default" is not an answer to this field: the answer is one of sqlite, postgres/,
  );
  refused([{ ...WORKERS, min: 5, max: 1, default: undefined }], /"min" must not be larger than "max"/);
  refused(
    [{ ...WORKERS, default: 99 }],
    /"default" is not an answer to this field: the answer is a number from 1 to 16/,
  );
  refused([{ ...WORKERS, step: 0 }], /"step" must be larger than 0/);
  refused([{ ...NOTES, maxLength: 5000 }], /"maxLength" must be a whole number from 1 to 2000/);
});

test('an answer has one shape per field type', () => {
  assert.equal(answerOf(DATABASE, 'postgres'), 'postgres');
  assert.throws(() => answerOf(DATABASE, 'mysql'), /one of sqlite, postgres/);
  assert.throws(() => answerOf(DATABASE, ['sqlite']), /one of sqlite, postgres/);
  // The order of the options, whatever the order of the clicks.
  assert.deepEqual(answerOf(EXTRAS, ['backup', 'tests', 'backup']), ['tests', 'backup']);
  assert.deepEqual(answerOf(EXTRAS, []), []);
  assert.throws(() => answerOf(EXTRAS, ['tests', 'more']), /a list of tests, backup/);
  assert.equal(answerOf(NOTES, '  two\r\nlines  '), 'two\nlines');
  assert.throws(() => answerOf(NOTES, '   '), /text of 1–2000 characters/);
  assert.throws(() => answerOf({ ...NOTES, multiline: false }, 'two\nlines'), /on one line/);
  assert.throws(() => answerOf({ ...NOTES, maxLength: 3 }, 'four'), /1–3 characters/);
  assert.throws(() => answerOf(NOTES, 'a\u0001b'), /text of/);
  assert.equal(answerOf(WORKERS, 16), 16);
  assert.throws(() => answerOf(WORKERS, 17), /a number from 1 to 16/);
  assert.throws(() => answerOf(WORKERS, '4'), /the answer is a number/);
  assert.throws(() => answerOf(WORKERS, Number.NaN), /the answer is a number/);
  assert.equal(answerOf(DRY_RUN, false), false);
  assert.throws(() => answerOf(DRY_RUN, 'yes'), /true or false/);
});

test('the service checks a form when the visual is written, and a field ID names one question in the visual', async (t) => {
  const { worker, startTurn, visual, record } = await asked(t);
  // Five questions, none of which the author has an answer to.
  assert.equal((await record()).openQuestions, 5);
  startTurn('worker');
  const broken = await worker('POST', '/api/visuals', {
    source: `# X\n\n## Ask {#ask}\n\n${fence([{ ...DRY_RUN, type: 'date' }])}`,
  });
  assert.equal(broken.status, 400);
  assert.match(broken.body.error, /Invalid visual source: Section ask: Form field 1 \(dry-run\): "type" is one of/);
  const twice = await worker('PATCH', `/api/visuals/${visual.id}`, {
    source: `## More {#more}\n\n${fence([{ ...DRY_RUN, label: 'Again?' }])}`,
  });
  assert.equal(twice.status, 400);
  assert.match(twice.body.error, /Field ID dry-run is used in section rollout and in section more/);
  assert.equal((await record()).version, 1);
});

test("an answer is the user's until it is sent: only the user answers, and the author reads what was sent", async (t) => {
  const { user, worker, outsider, path, fields, keys, answer, read, record } = await asked(t);
  const key = await keys();
  assert.match(key.database, /^[0-9a-f]{16}$/);
  const refused = await worker('PATCH', `${path}/answers`, {
    version: 1,
    answers: [{ key: key.database, value: 'postgres' }],
  });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Only the user answers the questions of a visual/);
  assert.equal((await worker('POST', `${path}/feedback`, { version: 1, answers: {} })).status, 403);

  const { status, body } = await answer({ database: 'postgres', extras: ['backup'], notes: 'Keep the old files.' });
  assert.equal(status, 200);
  assert.deepEqual(
    body.flatMap((form) => form.fields).map((field) => [field.id, field.answer, field.unsent, field.sent]),
    [
      ['database', { value: 'postgres', source: 'user' }, true, null],
      ['extras', { value: ['backup'], source: 'user' }, true, null],
      ['notes', { value: 'Keep the old files.', source: 'user' }, true, null],
      // The author's suggestion stands until the user chooses.
      ['workers', { value: 4, source: 'default' }, true, null],
      ['dry-run', null, false, null],
    ],
  );
  assert.deepEqual(
    (await fields()).map((field) => field.answer?.value ?? null),
    ['postgres', ['backup'], 'Keep the old files.', 4, null],
  );
  // The author sees its questions, and nothing of an answer that was not sent.
  for (const field of await fields(worker)) {
    assert.equal('answer' in field, false);
    assert.equal('unsent' in field, false);
    assert.equal(field.sent, null);
  }
  // Nor how many questions wait for the user's click: those counters are not in the record that an agent reads.
  const [listed] = (await worker('GET', '/api/visuals?agent=worker')).body;
  for (const seen of [listed, (await worker('GET', path)).body])
    assert.deepEqual([seen.openQuestions, seen.answerRevision, seen.version], [undefined, undefined, 1]);
  assert.deepEqual(await read(), {
    version: 1,
    answers: {},
    unanswered: ['database', 'extras', 'notes', 'workers', 'dry-run'],
    fields: (await read()).fields,
  });
  assert.equal((await outsider('GET', `${path}/answers`)).status, 403);
  assert.equal((await record()).openQuestions, 5);

  // Bad answers are refused whole, with the question named.
  const bad = await answer({ workers: 3, database: 'mysql' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /Question database: the answer is one of sqlite, postgres/);
  assert.equal((await fields()).find((field) => field.id === 'workers').answer.value, 4);
  const mention = await answer({ notes: 'Ask @outsider about it' });
  assert.equal(mention.status, 400);
  assert.match(mention.body.error, /An answer goes to the author of the visual only\. Write @outsider in a code span/);
  assert.equal(
    (await user('PATCH', `${path}/answers`, { version: 1, answers: [{ key: 'nope', value: 1 }] })).status,
    400,
  );
  assert.equal((await user('PATCH', `${path}/answers`, { version: 1, answers: [] })).status, 400);
  assert.equal((await user('PUT', `${path}/answers`, { version: 1, answers: [] })).status, 405);

  // Null takes an answer back; the suggestion shows again where there is one.
  await answer({ notes: null, database: null });
  assert.deepEqual(
    (await fields()).map((field) => field.answer),
    [
      { value: 'sqlite', source: 'default' },
      { value: ['backup'], source: 'user' },
      null,
      { value: 4, source: 'default' },
      null,
    ],
  );
});

test('the user sends the reviewed answers as one chat message to the author, which reads them back', async (t) => {
  const { app, url, visual, answer, send, messages, sentText, read, record, fields, worker } = await asked(t);
  await answer({ extras: ['tests', 'backup'], notes: 'Keep the old files.\nAsk `@outsider` first.', 'dry-run': true });
  const { status, body } = await send();
  assert.equal(status, 200);
  assert.equal(body.answers, true);
  const message = (await messages()).find((item) => item.id === body.messageId);
  assert.equal(message.from, 'user');
  assert.equal(message.conversationId, 'work');
  assert.equal(
    message.text,
    [
      `@worker Answers on visual \`${visual.id}\` \`Storage plan\`, version 1:`,
      [
        'Answers:',
        '- `database` `Which database?` (your suggestion, kept): `sqlite` `SQLite`',
        '- `extras` `What else belongs in the first step?`: `tests` `Migration tests`, `backup` `A backup command`',
        '- `notes` `Anything I should know?`:\n> Keep the old files.\n> Ask `@outsider` first.',
        '- `workers` `How many workers?` (your suggestion, kept): 4',
        '- `dry-run` `Start with a dry run?`: yes',
      ].join('\n'),
      `Read the answers with \`visual answers --id ${visual.id}\`.`,
    ].join('\n\n'),
  );
  assert.deepEqual(mentions(message.text), ['worker']);
  assert.equal((await record()).openQuestions, 0);
  for (const field of await fields()) assert.equal(field.unsent, false);

  // The author reads the answers by field ID, with the HTTP API and with the CLI.
  const report = await read();
  assert.deepEqual(report.answers, {
    database: 'sqlite',
    extras: ['tests', 'backup'],
    notes: 'Keep the old files.\nAsk `@outsider` first.',
    workers: 4,
    'dry-run': true,
  });
  assert.deepEqual(report.unanswered, []);
  assert.deepEqual(report.fields[0], {
    id: 'database',
    sectionId: 'storage',
    type: 'choice',
    label: 'Which database?',
    options: [
      { id: 'sqlite', label: 'SQLite' },
      { id: 'postgres', label: 'PostgreSQL' },
    ],
    answered: true,
    value: 'sqlite',
    source: 'default',
    sentAt: report.fields[0].sentAt,
  });
  assert.deepEqual(
    (await fields(worker)).map((field) => field.sent?.value),
    Object.values(report.answers),
  );
  const env = { MU_URL: url, MU_AGENT_ID: 'worker', MU_TOKEN: app.identity.issue('worker') };
  assert.deepEqual(await main(['visual', 'answers', '--id', visual.id], env), report);
  assert.deepEqual(await main(['visual', 'answers', '--id', visual.id, '--version', '1'], env), report);

  // Nothing new to send; then a change, an answer taken back, and a question that stays open.
  const again = await send();
  assert.equal(again.status, 400);
  assert.match(again.body.error, /Version 1 has nothing to send/);
  await answer({ database: 'postgres', notes: null, extras: [] });
  assert.equal((await record()).openQuestions, 3);
  const second = await send();
  assert.equal(second.status, 200);
  assert.equal(
    (await sentText(second)).split('\n\n')[1],
    [
      'Answers:',
      '- `database` `Which database?` (changed): `postgres` `PostgreSQL`',
      '- `extras` `What else belongs in the first step?` (changed): none of the options',
      '- `workers` `How many workers?` (your suggestion, kept): 4',
      '- `dry-run` `Start with a dry run?`: yes',
      'Taken back: `notes`',
    ].join('\n'),
  );
  assert.deepEqual((await read()).answers, { database: 'postgres', extras: [], workers: 4, 'dry-run': true });
  assert.deepEqual((await read()).unanswered, ['notes']);
  assert.equal((await record()).openQuestions, 1);
});

test('the user sends what the dashboard showed for review, and nothing that changed since', async (t) => {
  const { user, worker, startTurn, path, keys, answer, reviewed, send, messages, record } = await asked(t);
  await answer({ 'dry-run': true });
  const before = (await messages()).length;
  const seen = await reviewed();
  // Another window changes an answer after this one showed the review.
  await answer({ 'dry-run': false });
  const stale = await user('POST', `${path}/feedback`, { version: 1, answers: seen });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /The questions or your answers changed since you reviewed them/);
  // A suggestion that the user never saw is not sent as the user's answer either.
  const partial = await user('POST', `${path}/feedback`, { version: 1, answers: {} });
  assert.equal(partial.status, 409);
  assert.equal((await user('POST', `${path}/feedback`, { version: 1, answers: [] })).status, 400);

  // The author asks the question differently while its turn runs: the old key names no question any more.
  const old = await keys();
  startTurn('worker');
  const changed = await worker('PATCH', path, {
    source: `## Rollout {#rollout}\n\n${fence([NOTES, WORKERS, { ...DRY_RUN, label: 'Skip the dry run?' }])}`,
  });
  assert.equal(changed.body.version, 2);
  const raced = await user('PATCH', `${path}/answers`, { version: 2, answers: [{ key: old['dry-run'], value: true }] });
  assert.equal(raced.status, 409);
  assert.match(raced.body.error, /A question of version 2 changed while you answered\. Read it again, then answer\./);
  // Version 1 is history: its questions are not answered any more, and nothing of it is sent.
  const earlier = await user('PATCH', `${path}/answers`, {
    version: 1,
    answers: [{ key: old.database, value: 'postgres' }],
  });
  assert.equal(earlier.status, 409);
  assert.match(
    earlier.body.error,
    /Version 1 is not the newest version of this visual; answer the questions of version 2/,
  );
  assert.equal((await send(1)).status, 409);
  assert.equal((await messages()).length, before);
  assert.equal((await record()).openQuestions, 5);
});

test('answers whose message is on its way are not sent a second time', async (t) => {
  const { chat, user, path, answer, reviewed, messages } = await asked(t);
  await answer({ database: 'postgres' });
  const body = { version: 1, answers: await reviewed() };
  // The chat holds the first message until the test lets it go, and says when it has it.
  const send = chat.send.bind(chat);
  const held = Promise.withResolvers();
  const reached = Promise.withResolvers();
  let calls = 0;
  chat.send = async (...args) => {
    if (calls++ === 0) {
      reached.resolve();
      await held.promise;
    }
    return send(...args);
  };
  const first = user('POST', `${path}/feedback`, body);
  await reached.promise;
  try {
    // Another browser reviewed the same answers and sends them too.
    const second = await user('POST', `${path}/feedback`, body);
    assert.deepEqual(
      [second.status, second.body.error],
      [409, 'This feedback is being sent. Wait for the result, then read the visual again.'],
    );
  } finally {
    held.resolve();
  }
  assert.equal((await first).status, 200);
  assert.equal((await messages()).filter((message) => message.from === 'user').length, 1);
  assert.match((await user('POST', `${path}/feedback`, body)).body.error, /Version 1 has nothing to send/);
});

test('answers that are in the chat are sent, whatever happened to the delivery notice', async (t) => {
  const { chat, answer, send, read, record, messages } = await asked(t);
  await answer({ database: 'postgres' });
  // The author is stopped, so the message gets a notice for the user; the broker fails on that notice.
  const chatSend = chat.send.bind(chat);
  chat.send = async (from, ...rest) => {
    if (from === 'system') throw new Error('IRC confirmation failed');
    return chatSend(from, ...rest);
  };
  const failed = await send();
  const fromUser = (await messages()).filter((message) => message.from === 'user');
  assert.equal(fromUser.length, 1);
  assert.deepEqual(
    [failed.status, failed.body.error],
    [503, `Message #${fromUser[0].id} was saved, but its delivery notice could not be posted: IRC confirmation failed`],
  );
  // The author has the answers, so nothing waits to be sent a second time.
  assert.deepEqual((await read()).answers, { database: 'postgres', workers: 4 });
  assert.equal((await record()).openQuestions, 3);
  assert.match((await send()).body.error, /Version 1 has nothing to send/);
  assert.equal((await messages()).filter((message) => message.from === 'user').length, 1);
});

test('an answer stays with its question across versions, and a changed question starts without one', async (t) => {
  const { worker, startTurn, path, fields, answer, send, read, record } = await asked(t);
  await answer({ database: 'postgres', 'dry-run': true });
  assert.equal((await send()).status, 200);
  startTurn('worker');
  const patched = await worker('PATCH', path, {
    source: `## Storage {#storage}\n\nDecided: PostgreSQL.\n\n## Rollout {#rollout}\n\nThe questions that are left.\n\n${fence(
      [
        NOTES,
        { ...WORKERS, default: 6 },
        { ...DRY_RUN, label: 'Start with a dry run on staging?' },
        // The same question in another section, explained in other words and without a suggestion.
        {
          ...DATABASE,
          default: undefined,
          help: 'Both are installed.',
          options: DATABASE.options.map((option) => ({ ...option, hint: 'Ready' })),
        },
      ],
    )}`,
  });
  assert.equal(patched.body.version, 2);
  const state = async (who, version) =>
    Object.fromEntries((await fields(who, version)).map((field) => [field.id, field.sent?.value ?? null]));
  // `database` and `workers` are asked as before, whatever their help and suggestion say now; the reworded `dry-run`
  // is a new question.
  assert.deepEqual(await state(undefined, '2'), { notes: null, workers: 4, 'dry-run': null, database: 'postgres' });
  assert.deepEqual((await read()).answers, { workers: 4, database: 'postgres' });
  assert.deepEqual((await read()).unanswered, ['notes', 'dry-run']);
  // The user's own choice stays; the new suggestion for `workers` is not what the author was sent, so it waits.
  assert.deepEqual(
    (await fields(undefined, '2')).map((field) => [field.id, field.answer, field.unsent]),
    [
      ['notes', null, false],
      ['workers', { value: 6, source: 'default' }, true],
      ['dry-run', null, false],
      ['database', { value: 'postgres', source: 'user' }, false],
    ],
  );
  assert.equal((await record()).openQuestions, 3);
  // The earlier version still shows what was answered to the questions as it asked them.
  assert.deepEqual(await state(undefined, '1'), {
    database: 'postgres',
    extras: null,
    notes: null,
    workers: 4,
    'dry-run': true,
  });
  assert.deepEqual((await read(worker, '1')).answers, { database: 'postgres', workers: 4, 'dry-run': true });
});

test('answers and draft comments of a version go out together, in one message and one turn', async (t) => {
  const { user, worker, startTurn, visual, path, shown, answer, send, messages, sentText } = await asked(
    t,
    `# Plan\n\n## Ask {#ask}\n\nRead \`this\`.\n\n${fence([{ ...DRY_RUN, label: 'Ping @outsider `now`?' }])}`,
  );
  const { rev } = (await shown()).sections.find((section) => section.id === 'ask');
  const comment = (
    await user('POST', `${path}/comments`, {
      version: 1,
      sectionId: 'ask',
      sectionRev: rev,
      text: 'Say why a dry run helps.',
    })
  ).body;
  await answer({ 'dry-run': false });
  const before = (await messages()).length;
  const sent = await send();
  assert.deepEqual(
    [sent.body.comments.map((item) => [item.id, item.status]), sent.body.answers],
    [[[comment.id, 'sent']], true],
  );
  // One message from the user: the author gets its answers and the comment in one turn.
  assert.equal((await messages()).slice(before).filter((message) => message.from === 'user').length, 1);
  const text = await sentText(sent);
  assert.equal(
    text,
    [
      `@worker Answers and a comment on visual \`${visual.id}\` \`Plan\`, version 1:`,
      // A label is the author's text: it can neither end its code span nor start another agent.
      "Answers:\n- `dry-run` `Ping @ outsider 'now'?`: no",
      `1. \`${comment.id}\` on section \`ask\` as a whole:\n> Say why a dry run helps.`,
      `Read the answers with \`visual answers --id ${visual.id}\`. Change the sections the comments concern with \`visual patch --id ${visual.id}\`, and name the comments a change answers with \`--resolves\`. \`visual comments --id ${visual.id}\` shows each comment with its whole quote.`,
    ].join('\n\n'),
  );
  assert.deepEqual(mentions(text), ['worker']);
  // Without answers in the request, only the drafts go out.
  await user('POST', `${path}/comments`, { version: 1, text: 'One more.' });
  startTurn('worker');
  assert.equal((await worker('GET', `${path}/comments`)).body.length, 1);
  const only = await user('POST', `${path}/feedback`, { version: 1 });
  assert.equal(only.body.answers, false);
  assert.match(await sentText(only), /^@worker A comment on visual/);
  assert.equal((await user('POST', `${path}/feedback`, { version: 1 })).status, 400);
  assert.equal((await user('POST', `${path}/feedback/x`, { version: 1 })).status, 405);
});
