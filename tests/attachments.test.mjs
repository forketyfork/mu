import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Chat } from '../src/chat.mjs';
import { createApp, ROOT } from '../src/server.mjs';
import { MAX_HTML_BYTES, attachmentPlaceholder, plainMessageText, validateAttachment } from '../src/attachments.mjs';
import { ATTACHMENT_POLICY } from '../src/browser-policy.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { userHeaders } from './identity-fixture.mjs';
import { freePort, shortTempDir, temporaryMuHome } from './isolation.mjs';

const PONG = '<!doctype html><title>Pong</title><canvas></canvas><script>let ball = 1;</script>';
const pong = { type: 'html', title: 'Pong', html: PONG };

test('an attachment is checked before Mu keeps it, and every refusal says why', () => {
  assert.deepEqual(validateAttachment({ ...pong, title: '  Pong  ' }), pong);
  const refused = (input, pattern) =>
    assert.throws(
      () => validateAttachment(input),
      (/** @type {any} */ error) => error.status === 400 && pattern.test(error.message),
      JSON.stringify(input).slice(0, 80),
    );
  refused('<p>hi</p>', /must be an object/);
  refused([pong], /must be an object/);
  refused({ ...pong, src: 'x' }, /no field "src"/);
  refused({ ...pong, type: 'svg' }, /type "html"/);
  refused({ ...pong, title: ' ' }, /title must contain 1–80 characters/);
  refused({ ...pong, title: 'x'.repeat(81) }, /title must contain 1–80 characters/);
  refused({ ...pong, title: 'Po‮ng' }, /not shown \(U\+202E\)/);
  refused({ ...pong, html: ' \n' }, /must contain HTML/);
  refused({ ...pong, html: 42 }, /must contain HTML/);
  refused({ ...pong, html: '<p>\uD800</p>' }, /valid Unicode/);
  refused({ ...pong, html: '<p>\0</p>' }, /control character U\+0000/);
  refused({ ...pong, html: '<p>\x1b]52;c;cHduZWQ=\x07</p>' }, /control character U\+001B/);
  refused({ ...pong, html: '<p>\x9b2J</p>' }, /control character U\+009B/);
  refused({ ...pong, html: '<p>\x7f</p>' }, /control character U\+007F/);
  assert.ok(validateAttachment({ ...pong, html: '<pre>\ta\r\n\fb</pre>' }));
  refused({ ...pong, html: 'é'.repeat(MAX_HTML_BYTES / 2 + 1) }, /at most 256 KiB; this one has 262146 bytes/);
  assert.equal(validateAttachment({ ...pong, html: 'a'.repeat(MAX_HTML_BYTES) }).html.length, MAX_HTML_BYTES);
});

test('where an attachment cannot run, its message reads as its text and one placeholder line', () => {
  const attachment = { type: 'html', title: 'Pong', bytes: 4500 };
  assert.equal(
    attachmentPlaceholder(attachment),
    '[HTML attachment "Pong", 4.4 KiB: open the message in the Mu dashboard to see it]',
  );
  assert.equal(
    plainMessageText({ text: '@lead Ready.', attachment }),
    `@lead Ready.\n${attachmentPlaceholder(attachment)}`,
  );
  assert.equal(plainMessageText({ text: '@lead Ready.' }), '@lead Ready.');
});

test('the store keeps the page apart from its message, in the transaction of the message', async (t) => {
  const filename = join(await shortTempDir(t, 'attachments'), 'store.sqlite');
  let store = new Store(filename);
  store.createAgent({ id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  const message = store.addMessage('one', 'user', '@lead look', 'common', { attachment: pong });
  const plain = store.addMessage('two', 'user', '@lead plain');
  assert.deepEqual(message.attachment, { type: 'html', title: 'Pong', bytes: Buffer.byteLength(PONG) });
  assert.equal(plain.attachment, undefined);
  store.close();
  store = new Store(filename);
  assert.equal(store.attachmentHtml(message.id), PONG);
  assert.equal(store.attachmentHtml(plain.id), null);
  // The state, the history and an inbox carry the attachment's name and size, never the page.
  for (const read of [store.messages(), store.inbox('lead'), [store.message(message.id)]])
    assert.doesNotMatch(JSON.stringify(read), /canvas/);
  assert.deepEqual(store.message(message.id).attachment, message.attachment);
  // A message that IRC confirms twice is recorded once, with one page.
  store.addMessage('one', 'user', '@lead look', 'common', { attachment: pong });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM attachments').get().count, 1);
  store.close();
});

test('the IRC line of a message with an attachment carries the placeholder, and Mu records the page', async () => {
  const lines = [];
  /** @type {any[]} */
  const recorded = [];
  const chat = new Chat({
    onMessage: (_id, from, text, conversationId, meta) => {
      recorded.push({ from, text, conversationId, meta });
      return { text };
    },
  });
  chat.state.connected = true;
  chat.syncConversation = async () => {};
  chat.getConversation = () => ({ id: 'common', kind: 'common', channel: '#mu', members: ['user'] });
  chat.getConversations = () => [chat.getConversation()];
  // A fake IRC client that only says lines.
  chat.connect = async () => ({
    say: (_channel, text, tags) => {
      lines.push(text);
      queueMicrotask(() => chat.receive({ nick: 'user', target: '#mu', tags, message: text }));
    },
  });
  await chat.send('user', 'Here it is.', 'common', { attachment: pong });
  assert.equal(
    lines.join(''),
    `Here it is.↵${attachmentPlaceholder({ type: 'html', title: 'Pong', bytes: Buffer.byteLength(PONG) })}`,
  );
  assert.deepEqual(recorded, [
    { from: 'user', text: 'Here it is.', conversationId: 'common', meta: { attachment: pong } },
  ]);
});

class FakeChat extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.state = { connected: true };
  }
  async start() {}
  async connect() {}
  close() {}
  async syncConversation() {}
  async send(from, text, conversationId, meta = {}) {
    return this.options.onMessage(crypto.randomUUID(), from, text, conversationId, meta);
  }
}

async function team(t) {
  const port = await freePort();
  const app = await createApp({
    home: await temporaryMuHome(t),
    port,
    dataDir: await shortTempDir(t, 'attachments-api'),
    chatFactory: (options) => new FakeChat(options),
    pricing: offlinePricing(),
  });
  await app.start();
  t.after(() => app.close());
  const url = `http://127.0.0.1:${port}`;
  const as = (headers) => async (method, path, data) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const user = as(userHeaders(app));
  const agentAs = (id) => as({ 'Content-Type': 'application/json', Authorization: `Bearer ${app.identity.issue(id)}` });
  const created = async (path, body) => assert.equal((await user('POST', path, body)).status, 201, path);
  await created('/api/agents', { id: 'lead', role: 'lead', adapter: 'manual', cwd: ROOT, task: '' });
  await created('/api/conversations', { kind: 'room', id: 'work', name: 'Work', from: 'lead', members: [] });
  for (const id of ['worker', 'outsider'])
    await created('/api/agents', { id, role: 'worker', adapter: 'manual', cwd: ROOT, task: '', from: 'lead' });
  assert.equal(
    (await user('POST', '/api/conversations/work/members', { members: ['worker'], from: 'lead' })).status,
    200,
  );
  return { app, url, user, worker: agentAs('worker'), lead: agentAs('lead'), outsider: agentAs('outsider') };
}

test('an agent posts a message with an attachment, and only members of its conversation read the page', async (t) => {
  const { app, user, worker, lead, outsider } = await team(t);
  // Quotes double in JSON, so the largest page needs a body larger than other requests may be.
  const largest = `<p>page-marker${'"'.repeat(MAX_HTML_BYTES - 18)}</p>`;
  const posted = await worker('POST', '/api/messages', {
    conversationId: 'work',
    text: '@lead The game is ready.',
    attachment: { type: 'html', title: 'Pong', html: largest },
  });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.deepEqual(posted.body.attachment, { type: 'html', title: 'Pong', bytes: MAX_HTML_BYTES });
  assert.equal(posted.body.text, '@lead The game is ready.');
  assert.doesNotMatch(JSON.stringify(posted.body), /page-marker/);
  const id = posted.body.id;

  const read = await lead('GET', `/api/messages/${id}/attachment`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { type: 'html', title: 'Pong', bytes: MAX_HTML_BYTES, html: largest });
  assert.equal((await user('GET', `/api/messages/${id}/attachment`)).body.html, largest);
  assert.deepEqual(await outsider('GET', `/api/messages/${id}/attachment`), {
    status: 404,
    body: { error: `Unknown message ${id}` },
  });
  const plain = await worker('POST', '/api/messages', { conversationId: 'work', text: 'No page here.' });
  assert.deepEqual(await lead('GET', `/api/messages/${plain.body.id}/attachment`), {
    status: 404,
    body: { error: `Message ${plain.body.id} has no attachment` },
  });

  // The state, the history and the inbox name the attachment and leave the page out.
  const history = await lead('GET', '/api/conversations/work/messages');
  assert.deepEqual(history.body.messages.find((message) => message.id === id).attachment, posted.body.attachment);
  const inbox = await lead('GET', '/api/agents/lead/inbox');
  assert.equal(inbox.body.messages.at(-1).id, id);
  for (const body of [history.body, (await user('GET', '/api/state')).body, inbox.body])
    assert.doesNotMatch(JSON.stringify(body), /page-marker/);

  // A refused attachment posts nothing.
  const before = app.store.messages(1000).length;
  const refused = await worker('POST', '/api/messages', {
    conversationId: 'work',
    text: 'Too big.',
    attachment: { type: 'html', title: 'Big', html: 'a'.repeat(MAX_HTML_BYTES + 1) },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /at most 256 KiB/);
  assert.equal(
    (await worker('POST', '/api/messages', { conversationId: 'work', text: 'Hi', attachment: '<p>' })).status,
    400,
  );
  assert.equal(app.store.messages(1000).length, before);
});

test('the attachment frame is sandboxed without network, and only its own files answer cross-site', async (t) => {
  const { url, app } = await team(t);
  const crossSite = { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' };
  const page = await fetch(`${url}/attachment/frame.html`, { headers: crossSite });
  assert.equal(page.status, 200);
  // The whole policy, word for word: the page runs agent script, so this policy is what keeps it from the network.
  assert.equal(
    page.headers.get('content-security-policy'),
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts",
  );
  assert.equal(ATTACHMENT_POLICY, page.headers.get('content-security-policy'));
  const html = await page.text();
  for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const response = await fetch(`${url}${asset}`, { headers: crossSite });
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', asset);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, asset);
  }
  for (const path of [
    '/attachment//frame.html',
    '//attachment/frame.html',
    '/ATTACHMENT/frame.html',
    '/Attachment/frame.js',
  ])
    assert.equal((await fetch(`${url}${path}`)).status, 404, path);
  // The page is read through the API, which keeps its credential and origin checks.
  assert.equal(
    (await fetch(`${url}/api/messages/1/attachment`, { headers: { ...userHeaders(app), ...crossSite } })).status,
    403,
  );
  assert.equal((await fetch(`${url}/api/messages/1/attachment`)).status, 401);
});
