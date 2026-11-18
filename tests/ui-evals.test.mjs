import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createEvalsView } from '../public/evals-view.js';
import { settle } from './ui-fixture.mjs';

test('a changed selection invalidates a paid preview and different versions never occupy the same comparison row', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
  t.after(() => dom.window.close());
  const { document, Event } = dom.window;
  const by = (id) => document.getElementById(`eval-${id}`);
  const item = { id: 'review', digest: 'revision-one', title: 'Review', skill: 'Find a race', weight: 1 };
  const target = { adapter: 'claude', model: 'baseline', effort: 'high' };
  const base = {
    id: 1,
    startedAt: '2026-01-01T00:00:00Z',
    target,
    cases: [item],
    status: 'complete',
    graded: 1,
    image: 'sha256:image',
    budgetUsd: 0.5,
    costUsd: 0.11,
    knownUsd: 0.11,
    results: [
      {
        ...item,
        status: 'graded',
        score: { earned: 1, possible: 1, checks: [{ label: 'Evidence', passed: true }] },
        reply: '<h1>untrusted</h1>',
        costUsd: 0.11,
        tokens: 20,
        durationMs: 1000,
      },
    ],
  };
  const changed = { ...item, digest: 'revision-two' };
  const candidate = {
    ...base,
    id: 2,
    cases: [changed],
    results: [],
    status: 'stopped',
    graded: 0,
    reason: 'Cost unavailable',
    costUsd: null,
    knownUsd: 0,
    target: { ...target, model: 'candidate' },
  };
  const posts = [];
  const request = async (path, options) => {
    if (options) {
      const data = JSON.parse(options.body);
      posts.push({ path, data });
      return path.endsWith('/estimate') ? [{ usd: 0.11 }] : candidate;
    }
    if (path === '/api/evals') return { cases: [changed], efforts: { claude: ['high'], codex: ['medium', 'high'] } };
    if (path.endsWith('/runs')) return [candidate, base];
    return path.endsWith('/1') ? base : candidate;
  };
  const view = createEvalsView(document, request);
  view.show();
  await settle();
  assert.equal(by('comparison').querySelectorAll('tbody tr').length, 2);
  assert.match(by('comparison').textContent, /Different suites/);
  assert.match(by('comparison').textContent, /Not in this run/);
  assert.match(by('comparison').textContent, /unknown/);
  assert.equal(by('comparison').querySelector('h1'), null);
  by('model').value = 'candidate';
  by('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  assert.equal(by('confirm').hidden, false);
  assert.match(by('estimate').textContent, /\$0\.11 for 1 of 1 cases/);
  assert.match(by('estimate').textContent, /\$0\.50 budget/);
  assert.equal(posts.length, 1);
  by('model').value = 'different';
  by('model').dispatchEvent(new Event('input', { bubbles: true }));
  by('start').click();
  assert.equal(posts.length, 1);
  assert.equal(by('confirm').hidden, true);
  by('adapter').value = 'codex';
  by('adapter').dispatchEvent(new Event('change', { bubbles: true }));
  assert.equal(by('effort').value, 'medium');
  by('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  by('start').click();
  await settle();
  assert.deepEqual(posts.at(-1), {
    path: '/api/evals/runs',
    data: { adapter: 'codex', model: 'different', effort: 'medium', budgetUsd: 0.5, cases: ['revision-two'] },
  });
  view.hide();
});

test('a refresh keeps the cases the user cleared and selects a case version it has not offered before', async (t) => {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const by = (id) => document.getElementById(`eval-${id}`);
  const item = (id, digest) => ({ id, digest, title: id, skill: id, weight: 1 });
  let cases = [item('cleared', 'cleared-one'), item('edited', 'edited-one')];
  const request = async (path) => {
    if (path === '/api/evals') return { cases, efforts: { claude: ['high'] } };
    if (path.endsWith('/runs')) return [];
    throw new Error(`Unexpected request ${path}`);
  };
  const view = createEvalsView(document, request);
  view.show();
  await settle();
  const checked = () =>
    Object.fromEntries([...by('cases').querySelectorAll('input')].map((box) => [box.value, box.checked]));
  assert.deepEqual(checked(), { 'cleared-one': true, 'edited-one': true });
  by('cases').querySelector('input[value="cleared-one"]').click();
  cases = [item('cleared', 'cleared-one'), item('edited', 'edited-two'), item('added', 'added-one')];
  by('refresh').click();
  await settle();
  assert.deepEqual(checked(), { 'cleared-one': false, 'edited-two': true, 'added-one': true });
  view.hide();
});
