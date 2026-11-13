import test from 'node:test';
import assert from 'node:assert/strict';
import { createdAt, fixture, initialState, message } from './ui-fixture.mjs';

test('panel and conversation navigation animate once, while loading and selecting the current item stay still', async (t) => {
  const { $, click, animations } = await fixture(t);
  assert.equal(animations.length, 0);
  click('[data-view="chat"]');
  assert.equal($('#workspace').hidden, true);
  assert.equal($('#team-chat').hidden, false);
  assert.deepEqual(
    animations.map((animation) => animation.id),
    ['mu-panel'],
  );
  click('[data-view="chat"]');
  assert.equal(animations.length, 1);
  click('[data-conversation="room-a"]');
  assert.equal(animations[0].cancelled, true);
  assert.equal(animations.at(-1).id, 'mu-conversation');
  assert.equal(animations.at(-1).effect.target, $('#messages'));
  click('[data-conversation="room-a"]');
  assert.equal(animations.length, 2);
  click('[data-view="workspace"]');
  assert.equal(animations.at(-1).id, 'mu-panel');
  assert.equal(animations.at(-1).effect.target, $('#workspace'));
});

test('only new messages in the visible conversation animate, without replay on refresh or reference updates', async (t) => {
  const { $, update, animations } = await fixture(t, { hash: '#team-chat' });
  assert.equal(animations.length, 0);
  const next = initialState();
  next.messages.push(message(3), message(4, 'room-a'));
  update(next);
  assert.equal(animations.length, 1);
  assert.equal(animations[0].id, 'mu-message');
  assert.equal(animations[0].effect.target, $('#messages .message:last-child'));
  assert.match(animations[0].effect.target.textContent, /Message 3/);
  update(next);
  next.tasks[0].title = 'Renamed review';
  update(next);
  assert.equal(animations.length, 1);
  assert.equal(animations[0].effect.target.isConnected, true, 'reference redraw keeps an in-flight arrival attached');
  assert.match(animations[0].effect.target.textContent, /Message 3/);
  next.messages.push(message(5));
  update(next);
  assert.equal(animations.length, 2);
  assert.equal(animations[0].effect.target.isConnected, true, 'a second arrival preserves the first animation');
  assert.match(animations[1].effect.target.textContent, /Message 5/);
});

test('arrivals while reading history or another panel stay still and keep scroll position', async (t) => {
  const { $, update, click, animations } = await fixture(t, { hash: '#team-chat' });
  const log = $('#messages');
  Object.defineProperties(log, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } });
  log.scrollTop = 100;
  const next = initialState();
  next.messages.push(message(3));
  update(next);
  assert.equal(animations.length, 0);
  assert.equal(log.scrollTop, 100);
  assert.equal($('#new-messages').hidden, false);
  click('[data-view="workspace"]');
  next.messages.push(message(4));
  update(next);
  click('[data-view="chat"]');
  assert.equal(animations.filter((animation) => animation.id === 'mu-message').length, 0);
});

test('changed status badges animate once and retain their animation across unrelated redraws', async (t) => {
  const { $, update, click, animations } = await fixture(t);
  const next = initialState();
  next.agents[0].status = 'working';
  next.tasks[0].status = 'ready';
  update(next);
  assert.equal(animations.length, 2);
  assert.ok(animations.every((animation) => animation.id === 'mu-status'));
  const badges = animations.map((animation) => animation.effect.target);
  next.agents[0].pending = 3;
  next.tasks[0].description = 'Redrawn';
  update(next);
  assert.equal(animations.length, 2);
  for (const [index, animation] of animations.entries()) {
    assert.notEqual(animation.effect.target, badges[index]);
    assert.equal(animation.effect.target.isConnected, true);
  }
  click('[data-view="chat"]');
  next.agents[0].status = 'done';
  next.tasks[0].status = 'verified';
  next.tasks[0].verifiedAt = createdAt;
  update(next);
  assert.equal(animations.filter((animation) => animation.id === 'mu-status').length, 2);
  assert.equal($('.status-badge').textContent, 'Done');
  assert.equal($('.task-status'), null, 'a verified task is archived by default');
  click('#show-archived');
  assert.equal($('.task-status').title, 'Verified');
});

test('reduced motion keeps navigation, arrivals, and status updates immediate', async (t) => {
  const { $, update, click, animations } = await fixture(t, { reduced: true });
  const next = initialState();
  next.agents[0].status = 'working';
  next.tasks[0].status = 'ready';
  update(next);
  click('[data-view="chat"]');
  next.messages.push(message(3));
  update(next);
  assert.match($('#messages .message:last-child').textContent, /Message 3/);
  click('[data-conversation="room-a"]');
  assert.equal($('#chat-title').textContent, 'Review changes');
  assert.equal(animations.length, 0);
});

test('task references use instant scrolling under reduced motion and still reveal and focus the task', async (t) => {
  for (const reduced of [true, false]) {
    const { window, $, update, click, scrolls } = await fixture(t, { reduced, hash: '#team-chat' });
    const next = initialState();
    next.messages.push({ ...message(3), text: 'Review `task-a`.' });
    update(next);
    click('#messages .task-ref');
    assert.equal($('#workspace').hidden, false);
    assert.equal(scrolls.length, 1);
    assert.equal(scrolls[0].options.behavior, reduced ? 'instant' : 'smooth');
    assert.equal(window.document.activeElement, $('[data-task="task-a"]'));
    assert.equal(window.document.activeElement.classList.contains('revealed'), true);
  }
});
