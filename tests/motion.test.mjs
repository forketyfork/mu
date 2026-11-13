import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotion, stateChanges } from '../public/motion.js';
import { themeFixture } from './theme-fixture.mjs';

const snapshot = () => ({
  messages: [
    { id: 8, conversationId: 'dm-lead' },
    { id: 10, conversationId: 'room-a' },
  ],
  agents: [
    { id: 'lead', status: 'idle' },
    { id: 'worker', status: 'working' },
  ],
  tasks: [
    { id: 'task-a', status: 'active' },
    { id: 'task-b', status: 'ready' },
  ],
});

test('initial state, duplicate updates, and reordered cards do not trigger motion', () => {
  const before = snapshot();
  const empty = { messages: new Set(), agents: new Set(), tasks: new Set() };
  assert.deepEqual(stateChanges(null, before), empty);
  assert.deepEqual(stateChanges(before, structuredClone(before)), empty);
  assert.deepEqual(
    stateChanges(before, { ...before, agents: before.agents.toReversed(), tasks: before.tasks.toReversed() }),
    empty,
  );
});

test('only newer messages and changes to existing statuses trigger motion', () => {
  const next = snapshot();
  next.messages = [{ id: 4, conversationId: 'room-b' }, next.messages[1], { id: 11, conversationId: 'dm-lead' }];
  next.agents = [
    { id: 'lead', status: 'idle', pending: 2 },
    { id: 'worker', status: 'blocked' },
    { id: 'new-worker', status: 'working' },
  ];
  next.tasks = [
    { id: 'task-a', status: 'ready' },
    { id: 'task-b', status: 'verified' },
    { id: 'task-c', status: 'active' },
  ];
  assert.deepEqual(stateChanges(snapshot(), next), {
    messages: new Set([11]),
    agents: new Set(['worker']),
    tasks: new Set(['task-a', 'task-b']),
  });
  assert.deepEqual(stateChanges({ ...snapshot(), tasks: undefined }, next).tasks, new Set());
});

function fixture(t, reduced = false) {
  const { window } = themeFixture();
  t.after(() => window.close());
  // Stands in for a MediaQueryList.
  const preference = /** @type {any} */ (new EventTarget());
  preference.matches = reduced;
  const animations = [];
  const element = () => ({
    ownerDocument: window.document,
    animate(frames, options) {
      const animation = /** @type {any} */ (new EventTarget());
      Object.assign(animation, { frames, options, effect: { target: this }, cancelled: false, currentTime: 0 });
      animation.cancel = () => {
        animation.cancelled = true;
        animation.dispatchEvent(new Event('cancel'));
      };
      animations.push(animation);
      return animation;
    },
  });
  return { preference, animations, element, motion: createMotion(preference) };
}

test('status motion continues at the same time through a redraw and replaces a superseded change', (t) => {
  const { motion, animations, element } = fixture(t);
  motion.play(element(), 'status', 'agent:worker');
  const animation = animations[0];
  animation.currentTime = 125;
  const replacement = element();
  motion.retarget(replacement, 'agent:worker');
  assert.equal(animations.length, 1);
  assert.equal(animation.effect.target, replacement);
  assert.equal(animation.currentTime, 125);
  motion.play(replacement, 'status', 'agent:worker');
  assert.equal(animation.cancelled, true);
  assert.equal(animations.length, 2);
  // A queued finish from the replaced animation must not release its successor.
  animation.dispatchEvent(new Event('finish'));
  const third = element();
  motion.retarget(third, 'agent:worker');
  assert.equal(animations[1].effect.target, third);
  animations[1].dispatchEvent(new Event('finish'));
  motion.retarget(element(), 'agent:worker');
  assert.equal(animations[1].effect.target, third);
});

test('navigation cancels running effects and repeated navigation does not stack them', (t) => {
  const { motion, animations, element } = fixture(t);
  const panel = element();
  motion.play(panel, 'panel');
  motion.play(panel, 'panel');
  assert.equal(animations[0].cancelled, true);
  assert.equal(animations[1].cancelled, false);
  motion.play(element(), 'message');
  motion.cancelAll();
  assert.ok(animations.every((animation) => animation.cancelled));
});

test('reduced motion suppresses all effects and cancels in-flight motion when the preference changes', (t) => {
  const { motion, preference, animations, element } = fixture(t, true);
  for (const kind of ['panel', 'conversation', 'message', 'status']) motion.play(element(), kind);
  assert.equal(animations.length, 0);
  preference.matches = false;
  preference.dispatchEvent(new Event('change'));
  motion.play(element(), 'message');
  motion.play(element(), 'status', 'task:a');
  preference.matches = true;
  preference.dispatchEvent(new Event('change'));
  assert.ok(animations.every((animation) => animation.cancelled));
  motion.play(element(), 'panel');
  assert.equal(animations.length, 2);
  preference.matches = false;
  preference.dispatchEvent(new Event('change'));
  assert.equal(animations.length, 2, 'enabling motion does not replay old effects');
  motion.play(element(), 'conversation');
  assert.equal(animations.length, 3);
});
