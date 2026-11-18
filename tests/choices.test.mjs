import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp, ROOT } from '../src/server.mjs';
import { answerText, splitChoices } from '../src/choices.mjs';
import { readTurn, turnReply } from '../src/adapters.mjs';
import { mentions } from '../src/store.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';

// Records a message as IRC confirms it, after `delay` milliseconds, with the metadata the service gave it.
class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
    this.delay = 0;
  }
  async start() {}
  async connect() {}
  close() {}
  async syncConversation() {}
  async send(from, text, conversationId, meta) {
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId, meta);
  }
}

const agent = (id) => ({ id, role: id === 'lead' ? 'lead' : 'worker', adapter: 'manual', cwd: ROOT, task: '' });

async function startApp(t) {
  const port = await freePort();
  /** @type {FakeChat} */
  let chat;
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'choices'),
    chatFactory: (options) => (chat = new FakeChat(options)),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const post = async (path, data) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: userHeaders(app),
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  await post('/api/agents', agent('lead'));
  await post('/api/agents', agent('worker'));
  await post('/api/conversations', { kind: 'room', id: 'issue-7', name: 'Issue 7', from: 'lead', members: ['worker'] });
  return { app, post, chat };
}

test('an agent offers choices with a message, and the user picks one with a reply that only the asker receives', async (t) => {
  const { app, post } = await startApp(t);
  const asked = await post('/api/messages', {
    from: 'worker',
    conversationId: 'issue-7',
    text: 'The plan is in the visual.\n\nShall I start with @lead watching?',
    choices: [' Yes ', 'No'],
  });
  assert.equal(asked.status, 201);
  assert.deepEqual(asked.body.choices, ['Yes', 'No']);
  assert.deepEqual(app.store.message(asked.body.id).choices, ['Yes', 'No'], 'the choices are stored with the message');
  app.store.ack('lead', app.store.inbox('lead')[0].id);

  const answered = await post(`/api/messages/${asked.body.id}/choice`, { choice: 'Yes' });
  assert.equal(answered.status, 201, JSON.stringify(answered.body));
  assert.equal(answered.body.from, 'user');
  assert.equal(answered.body.conversationId, 'issue-7');
  assert.equal(answered.body.text, `@worker\n\n> Re: \`#${asked.body.id}\` Shall I start with lead watching?\n\nYes`);
  assert.equal(answered.body.answers, asked.body.id);
  assert.equal(answered.body.choice, 'Yes');
  assert.deepEqual(answered.body.mentions, ['worker']);
  assert.deepEqual(
    app.store.inbox('worker').map((message) => message.id),
    [answered.body.id],
    'the answer starts a turn of the asker',
  );
  assert.equal(app.store.inbox('lead').length, 0, 'the quote wakes nobody that the question mentioned');
  assert.equal(app.store.answerTo(app.store.message(asked.body.id)).id, answered.body.id);

  const again = await post(`/api/messages/${asked.body.id}/choice`, { choice: 'No' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already answered; write a reply/);
});

test('in a direct chat the answer needs no mention', async (t) => {
  const { app, post } = await startApp(t);
  const asked = await post('/api/messages', {
    from: 'lead',
    conversationId: 'dm-lead',
    text: 'Merge it?',
    choices: ['Merge', 'Wait'],
  });
  const answered = await post(`/api/messages/${asked.body.id}/choice`, { choice: 'Wait' });
  assert.equal(answered.body.text, `> Re: \`#${asked.body.id}\` Merge it?\n\nWait`);
  assert.deepEqual(
    app.store.inbox('lead').map((message) => message.id),
    [answered.body.id],
  );
});

test('two clicks while the first answer is on its way send one answer', async (t) => {
  const { app, post, chat } = await startApp(t);
  const asked = await post('/api/messages', {
    from: 'lead',
    conversationId: 'dm-lead',
    text: 'Go?',
    choices: ['Yes', 'No'],
  });
  chat.delay = 100;
  const results = await Promise.all([
    post(`/api/messages/${asked.body.id}/choice`, { choice: 'Yes' }),
    post(`/api/messages/${asked.body.id}/choice`, { choice: 'No' }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(app.store.messages(300, 'dm-lead').filter((message) => message.answers === asked.body.id).length, 1);
});

test('only the user answers, and only with one of the offered labels', async (t) => {
  const { post } = await startApp(t);
  const plain = await post('/api/messages', { from: 'lead', conversationId: 'issue-7', text: 'FYI' });
  const asked = await post('/api/messages', {
    from: 'lead',
    conversationId: 'issue-7',
    text: 'Which one?',
    choices: ['A', 'B'],
  });
  /** @type {[string, Record<string, string>, number, RegExp][]} */
  const cases = [
    [`/api/messages/${plain.body.id}/choice`, { choice: 'A' }, 400, /offers no choices/],
    [`/api/messages/${asked.body.id}/choice`, { choice: 'C' }, 400, /one of the labels .*: A, B/],
    [`/api/messages/${asked.body.id}/choice`, { choice: 'a' }, 400, /one of the labels/],
    [`/api/messages/${asked.body.id}/choice`, { from: 'worker', choice: 'A' }, 403, /Only the user answers/],
    ['/api/messages/999999/choice', { choice: 'A' }, 404, /Unknown message/],
  ];
  for (const [path, input, status, error] of cases) {
    const result = await post(path, input);
    assert.equal(result.status, status, `${path} ${JSON.stringify(input)}`);
    assert.match(result.body.error, error);
  }
});

test('choices are checked when they are offered', async (t) => {
  const { post } = await startApp(t);
  /** @type {[Record<string, unknown>, RegExp][]} */
  const cases = [
    [{ from: 'lead', choices: ['Only'] }, /2–6 labels/],
    [{ from: 'lead', choices: ['1', '2', '3', '4', '5', '6', '7'] }, /2–6 labels/],
    [{ from: 'lead', choices: 'Yes|No' }, /2–6 labels/],
    [{ from: 'lead', choices: ['Yes', ' '] }, /1–60 characters/],
    [{ from: 'lead', choices: ['Yes', 'x'.repeat(61)] }, /1–60 characters/],
    [{ from: 'lead', choices: ['Yes', 'yes'] }, /offered twice/],
    [{ from: 'lead', choices: ['Yes', 'Ask @worker'] }, /mentions an agent/],
    [{ from: 'lead', choices: ['Yes', 'N​o'] }, /U\+200B/],
    [{ choices: ['Yes', 'No'] }, /Only an agent offers choices/],
  ];
  for (const [input, error] of cases) {
    const result = await post('/api/messages', { conversationId: 'issue-7', text: 'Go?', ...input });
    assert.equal(result.status, 400, JSON.stringify(input));
    assert.match(result.body.error, error);
  }
});

test('the answer quotes the last line of the question, without fences, quote marks or mentions, and cut short', () => {
  const question = (text) => ({ id: 5, from: 'lead', text });
  assert.equal(answerText(question('Here:\n\n```sh\nnpm test\n```\n'), 'Yes', true), '> Re: `#5` npm test\n\nYes');
  assert.equal(
    answerText(question('> > Ask @worker-one or email a@b.c?'), 'Yes', true),
    '> Re: `#5` Ask worker-one or email a@b.c?\n\nYes',
  );
  // Only what counts as a mention loses its @: a scoped package and a handle in code read as written.
  const quoted = answerText(question('Ask @worker-one: install @scope/package, or ping `@lead` (@all)?'), 'Yes', true);
  assert.equal(quoted, '> Re: `#5` Ask worker-one: install @scope/package, or ping `@lead` (all)?\n\nYes');
  assert.deepEqual(mentions(quoted), []);
  const long = answerText(question('x'.repeat(300)), 'Yes', true);
  assert.equal(long, `> Re: \`#5\` ${'x'.repeat(199)}…\n\nYes`);
});

test('a final reply offers choices on a last line `Choices: A | B`', () => {
  assert.deepEqual(splitChoices('Merge it now?\nChoices: Merge | Wait'), {
    text: 'Merge it now?',
    choices: ['Merge', 'Wait'],
  });
  // Blank lines above, trailing space and CRLF line ends belong to the framing, not to the choices.
  assert.deepEqual(splitChoices('Report.\n\nMerge it now?\n\nChoices:   Merge|  Wait  \r'), {
    text: 'Report.\n\nMerge it now?',
    choices: ['Merge', 'Wait'],
  });
  assert.deepEqual(splitChoices('Which?\nChoices: A | B | C | D | E | F').choices, ['A', 'B', 'C', 'D', 'E', 'F']);
  // A fence that was closed above does not hide the line.
  assert.deepEqual(splitChoices('Run:\n```sh\nnpm test\n```\nChoices: Yes | No').choices, ['Yes', 'No']);
  assert.deepEqual(splitChoices('Run:\n~~~\n```\n~~~\nChoices: Yes | No').choices, ['Yes', 'No']);
});

test('a reply that merely looks like it offers choices stays text', () => {
  const plain = [
    // Quoted, indented, bulleted, emphasised or in inline code: not the bare last line.
    'Write the last line like this:\n\n`Choices: Yes | No`',
    'Write it like this:\n> Choices: Yes | No',
    'Write it like this:\n    Choices: Yes | No',
    'Write it like this:\n- Choices: Yes | No',
    'Ok?\n**Choices:** Yes | No',
    'Ok?\nchoices: Yes | No',
    'Ok?\nChoices:Yes | No',
    // The line is not last, or is only part of a sentence.
    'Choices: Yes | No\nWhat now?',
    'Ok? Choices: Yes | No',
    'Ok?\nChoices: Yes | No.\nThanks',
    // In a code block, closed or not, with either fence character and a longer closing fence.
    'Write:\n```\nChoices: Yes | No',
    'Write:\n```md\nChoices: Yes | No\n```',
    'Write:\n~~~\nChoices: Yes | No',
    'Write:\n````\n```\nChoices: Yes | No',
    'Write:\n   ```\nChoices: Yes | No',
    // No words above it.
    'Choices: Yes | No',
    '\n\nChoices: Yes | No\n',
    'NO_REPLY\nChoices: Yes | No',
  ];
  for (const text of plain) assert.deepEqual(splitChoices(text), { text }, JSON.stringify(text));
});

test('a last line that validChoices refuses is text, not a half-offered list', () => {
  const refused = [
    'Ok?\nChoices: Yes',
    'Ok?\nChoices: Yes |',
    'Ok?\nChoices: Yes | | No',
    'Ok?\nChoices: Yes | yes',
    'Ok?\nChoices: 1 | 2 | 3 | 4 | 5 | 6 | 7',
    `Ok?\nChoices: Yes | ${'x'.repeat(61)}`,
    'Ok?\nChoices: Yes | Ask @worker',
    'Ok?\nChoices: Yes | N\u200Bo',
  ];
  for (const text of refused) assert.deepEqual(splitChoices(text), { text }, JSON.stringify(text));
});

test('every runner format takes the choices off the final reply, and NO_REPLY keeps its meaning', () => {
  const reply = '@user Merge it now?\nChoices: Merge | Wait';
  const expected = { text: '@user Merge it now?', choices: ['Merge', 'Wait'] };
  const claude = JSON.stringify({ type: 'result', session_id: 's', is_error: false, result: reply });
  const codex = [
    { type: 'thread.started', thread_id: 's' },
    { type: 'item.completed', item: { type: 'agent_message', text: reply } },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  const pi = [
    { type: 'session', id: 's' },
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop' },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  for (const [format, stdout] of [
    ['claude', claude],
    ['codex', codex],
    ['pi', pi],
  ]) {
    assert.deepEqual(turnReply(format, readTurn(format, stdout)), { ...expected, sessionId: 's' }, format);
  }
  assert.deepEqual(turnReply('text', { stdout: `${reply}\n` }), { ...expected, sessionId: null });
  // A trailing NO_REPLY line is dropped first, so the choices line is the last line again.
  assert.deepEqual(turnReply('text', { stdout: `${reply}\n\nNO_REPLY\n` }).choices, ['Merge', 'Wait']);
  // NO_REPLY alone, or above a choices line, is not a reply with choices.
  assert.deepEqual(turnReply('text', { stdout: 'NO_REPLY\n' }), { text: 'NO_REPLY', sessionId: null });
  assert.equal(turnReply('text', { stdout: 'NO_REPLY\nChoices: A | B' }).choices, undefined);
  // A reply without the line has no `choices` key at all.
  assert.equal(Object.hasOwn(turnReply('text', { stdout: 'Done.' }), 'choices'), false);
});
