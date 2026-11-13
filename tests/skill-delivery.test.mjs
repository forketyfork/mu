import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Runner } from '../src/runner.mjs';
import { readTurn } from '../src/adapters.mjs';
import { CodexRollouts } from '../src/codex-rollout.mjs';
import { Store } from '../src/store.mjs';
import { ROOT } from '../src/server.mjs';
import { offlinePricing } from './offline-pricing.mjs';
import { testIdentity } from './identity-fixture.mjs';
import { temporaryMuHome } from './isolation.mjs';

const lines = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const claudeTurn = ({ session = 'claude-session', context = 40000 } = {}) =>
  lines([
    { type: 'system', subtype: 'init', session_id: session, model: 'claude-opus-5-5' },
    {
      type: 'assistant',
      session_id: session,
      parent_tool_use_id: null,
      message: {
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: context - 1000,
          output_tokens: 0,
        },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      session_id: session,
      is_error: false,
      result: 'NO_REPLY',
      total_cost_usd: 0.1,
      modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 } },
    },
  ]);
const SKILL_MARKER = '# Worker';

async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Each test uses its own copy of the skills so that it can change the worker skill.
async function setup(t, adapter = 'claude') {
  await mkdir(join(ROOT, '.tmp'), { recursive: true });
  const root = await mkdtemp(join(ROOT, '.tmp/skill-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(ROOT, 'skills'), join(root, 'skills'), { recursive: true });
  const home = await temporaryMuHome(t, root);
  const store = new Store();
  store.createAgent({ id: 'worker', role: 'worker', adapter, cwd: ROOT, task: 'Measure' });
  const runner = new Runner({
    home,
    identity: testIdentity(t),
    store,
    chat: { state: { connected: true }, async send() {} },
    root,
    url: 'http://127.0.0.1:4310',
    codexRollouts: new CodexRollouts(join(ROOT, '.tmp/no-codex-home')),
    pricing: offlinePricing(),
  });
  const prompts = [],
    outputs = [];
  runner.execute = async (command, agent, message, prompt) => {
    prompts.push(prompt);
    return readTurn(command.format, outputs.shift());
  };
  t.after(async () => {
    runner.close();
    await until(() => !runner.active.size);
    store.close();
  });
  let count = 0;
  const turn = async (output, conversationId = 'dm-worker') => {
    outputs.push(output);
    store.addMessage(`turn-${++count}`, 'user', 'Report', conversationId);
    runner.kick();
    await until(() => !runner.active.size);
    return prompts.at(-1);
  };
  return { home, root, prompts, store, turn };
}

test('a resumed session gets the full skill once and a short reference afterwards', async (t) => {
  const { home, turn } = await setup(t);
  const first = await turn(claudeTurn({ context: 40000 }));
  assert.ok(first.startsWith('---\nname: worker'));
  assert.match(first, new RegExp(`Mu's projects and local clones are listed in ${home}/projects\\.md`));
  const second = await turn(claudeTurn({ context: 52000 }));
  assert.ok(!second.includes(SKILL_MARKER));
  assert.match(second, /^Your worker skill is unchanged since an earlier turn of this session gave you its full text/);
  assert.match(second, /Incoming chat message #2 from the user \(@user\)/);
});

test('a changed skill, a new native session, or another conversation gets the full skill again', async (t) => {
  const { home, store, turn } = await setup(t);
  await turn(claudeTurn({ context: 40000 }));
  await writeFile(
    join(home, 'skills/worker/SKILL.md'),
    `---\nname: worker\n---\n\n${SKILL_MARKER}\n\nEdited instructions.\n`,
  );
  assert.match(await turn(claudeTurn({ context: 50000 })), /Edited instructions/);
  assert.ok(!(await turn(claudeTurn({ context: 60000 }))).includes('Edited instructions'));
  store.updateAgent('worker', { sessionIds: { 'dm-worker': 'replaced-session' } });
  assert.match(await turn(claudeTurn({ session: 'replaced-session', context: 30000 })), /Edited instructions/);
  store.createConversation({
    id: 'task-room',
    kind: 'room',
    name: 'Task',
    members: ['user', 'worker'],
    createdBy: 'user',
  });
  assert.match(await turn(claudeTurn({ context: 30000 }), 'task-room'), /Edited instructions/);
});

test('a missing home skill fails the turn instead of falling back to the checkout', async (t) => {
  const { home, root, prompts, store, turn } = await setup(t);
  await rm(join(home, 'skills/worker/SKILL.md'));
  assert.match(await readFile(join(root, 'skills/worker/SKILL.md'), 'utf8'), /# Worker/);

  await turn(claudeTurn());

  assert.equal(prompts.length, 0);
  assert.equal(store.agent('worker').status, 'error');
  assert.match(store.agent('worker').lastError, /SKILL\.md/);
});

test('a shrinking context means compaction, so the next turn gets the full skill again', async (t) => {
  const { turn } = await setup(t);
  await turn(claudeTurn({ context: 400000 }));
  assert.ok(
    !(await turn(claudeTurn({ context: 90000 }))).includes(SKILL_MARKER),
    'this turn could not know about the compaction yet',
  );
  assert.ok((await turn(claudeTurn({ context: 95000 }))).includes(SKILL_MARKER));
  assert.ok(!(await turn(claudeTurn({ context: 99000 }))).includes(SKILL_MARKER));
});

test('an adapter that reports no context size always gets the full skill', async (t) => {
  const { turn } = await setup(t, 'demo');
  const plain = 'NO_REPLY\n';
  assert.ok((await turn(plain)).includes(SKILL_MARKER));
  assert.ok((await turn(plain)).includes(SKILL_MARKER));
});

test('a worker whose session holds 300k tokens or more is told its size; the lead and smaller sessions are not', async (t) => {
  const { store, turn } = await setup(t);
  const notice = /Your session for this conversation holds about (\d+)k tokens/;
  assert.doesNotMatch(await turn(claudeTurn({ context: 299000 })), notice);
  assert.doesNotMatch(await turn(claudeTurn({ context: 434000 })), notice, 'the size before this turn was 299k');
  const large = await turn(claudeTurn({ context: 450000 }));
  assert.equal(large.match(notice)?.[1], '434');
  assert.match(large, /apply the large-context rule of your skill/);
  store.updateAgent('worker', { sessionIds: { 'dm-worker': 'fresh-session' } });
  assert.doesNotMatch(await turn(claudeTurn({ session: 'fresh-session', context: 30000 })), notice, 'a new session');
  store.updateAgent('worker', { role: 'lead' });
  await turn(claudeTurn({ session: 'fresh-session', context: 400000 }));
  assert.doesNotMatch(await turn(claudeTurn({ session: 'fresh-session', context: 410000 })), notice, 'the lead');
});
