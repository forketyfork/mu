import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.mjs';
import { parseDocument } from '../src/visual-format.mjs';
import { sectionRev } from '../src/visuals.mjs';
import { team } from './visuals-fixture.mjs';

const PLAN = '# Storage plan\n\nWhy we move.\n\n## Overview {#overview}\n\nText with `code`.\n';

// A visual that the worker wrote in a turn that has ended.
async function written(t) {
  const context = await team(t);
  context.startTurn('worker');
  const visual = (await context.worker('POST', '/api/visuals', { source: PLAN })).body;
  context.app.runner.active.clear();
  const ids = async (path = '/api/visuals') => (await context.user('GET', path)).body.map((item) => item.id);
  return { ...context, visual, path: `/api/visuals/${visual.id}`, ids };
}

test('an archived visual leaves the default list, stays readable, and comes back when restored', async (t) => {
  const { user, visual, path, ids, app } = await written(t);
  const archived = await user('PATCH', path, { archived: true });
  assert.equal(archived.status, 200);
  assert.match(archived.body.archivedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(await ids(), []);
  assert.deepEqual(await ids('/api/visuals?include=archived'), [visual.id]);
  assert.deepEqual(await ids('/api/visuals?include=archived&task=nothing'), []);
  assert.deepEqual(
    app.visuals.list().map((item) => item.id),
    [visual.id],
    'the dashboard stream still names it, so that the viewer and the links keep working',
  );
  const read = (await user('GET', path)).body;
  assert.equal(read.archivedAt, archived.body.archivedAt);
  assert.equal(read.shown.sections[1].body, 'Text with `code`.');

  // Archiving again keeps the time of the first.
  assert.equal((await user('PATCH', path, { archived: true })).body.archivedAt, archived.body.archivedAt);

  const restored = await user('PATCH', path, { archived: false });
  assert.equal(restored.status, 200);
  assert.equal('archivedAt' in restored.body, false);
  assert.deepEqual(await ids(), [visual.id]);
});

test('the user still comments on an archived visual, and its author still changes it', async (t) => {
  const { user, worker, startTurn, visual, path, ids } = await written(t);
  await user('PATCH', path, { archived: true });
  const comment = await user('POST', `${path}/comments`, {
    version: 1,
    sectionId: 'overview',
    sectionRev: sectionRev(parseDocument(PLAN).sections[1]),
    block: 0,
    quote: { text: 'code', prefix: 'Text with ', suffix: '.' },
    text: 'Explain',
  });
  assert.equal(comment.status, 201);
  startTurn('worker');
  const patched = await worker('PATCH', path, { source: '## Overview {#overview}\n\nChanged.' });
  assert.equal(patched.status, 200);
  assert.deepEqual(await ids(), [], 'a new version does not bring an archived visual back');
  assert.equal(typeof (await user('GET', path)).body.archivedAt, 'string');
  assert.equal((await user('GET', path)).body.id, visual.id);
});

test('the user and a lead archive; a worker, including the author, does not', async (t) => {
  const { app, user, startTurn, worker, outsider, lead, visual, path, ids } = await written(t);
  for (const caller of [worker, outsider]) {
    const refused = await caller('PATCH', path, { archived: true });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /Only the user, and a lead/);
  }
  assert.deepEqual(await ids(), [visual.id], 'a refused request changes nothing');
  // A lead that is not in the visual's conversation does not archive it either.
  const room = await user('POST', '/api/conversations', {
    kind: 'room',
    id: 'apart',
    name: 'Apart',
    from: 'user',
    members: ['outsider'],
  });
  assert.equal(room.status, 201, JSON.stringify(room.body));
  assert.equal(app.store.conversation('apart').members.includes('lead'), false);
  startTurn('outsider', 'apart');
  const apart = await outsider('POST', '/api/visuals', { source: PLAN, conversationId: 'apart' });
  assert.equal(apart.status, 201, JSON.stringify(apart.body));
  app.runner.active.clear();
  const refusedLead = await lead('PATCH', `/api/visuals/${apart.body.id}`, { archived: true });
  assert.equal(refusedLead.status, 403);
  assert.equal((await user('GET', `/api/visuals/${apart.body.id}`)).body.archivedAt, undefined);
  assert.equal((await lead('PATCH', path, { archived: true })).status, 200);
  assert.deepEqual(await ids('/api/visuals?conversation=work'), []);
  assert.equal((await worker('PATCH', path, { archived: false })).status, 403);
  assert.equal((await lead('PATCH', path, { archived: false })).status, 200);
  assert.deepEqual(await ids('/api/visuals?conversation=work'), [visual.id]);
});

test('archiving takes a boolean and nothing else, and names a visual that exists', async (t) => {
  const { user, path } = await written(t);
  assert.match((await user('PATCH', path, { archived: 'yes' })).body.error, /archived must be true or false/);
  const mixed = await user('PATCH', path, { archived: true, title: 'Other' });
  assert.equal(mixed.status, 400);
  assert.match(mixed.body.error, /Unknown field title/);
  assert.equal((await user('PATCH', '/api/visuals/vis-missing', { archived: true })).status, 404);
});

test('the CLI archives, lists and restores a visual', async (t) => {
  const { app, url, visual } = await written(t);
  const env = { MU_URL: url, MU_TOKEN: app.identity.token };
  const listed = async (...flags) => (await main(['visual', 'list', ...flags], env)).map((item) => item.id);
  assert.match((await main(['visual', 'archive', '--id', visual.id], env)).archivedAt, /^\d{4}-/);
  assert.deepEqual(await listed(), []);
  assert.deepEqual(await listed('--include-archived'), [visual.id]);
  assert.equal('archivedAt' in (await main(['visual', 'unarchive', '--id', visual.id], env)), false);
  assert.deepEqual(await listed(), [visual.id]);
});
