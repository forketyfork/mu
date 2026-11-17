import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { SCENE_LIMITS, parseBlocks, parseScene, sceneStates, sceneVisible } from '../src/visual-format.mjs';
import { createRenderer } from '../public/visual/render.js';
import { createScenes, sceneLayout, wrap } from '../public/visual/scene.js';
import { team } from './visuals-fixture.mjs';

const HOSTILE = 'Mu <img src=x onerror="window.injected = true">';
const SCENE = {
  title: 'How a patch is stored',
  nodes: [
    { id: 'worker', at: [0, 0], label: 'Worker' },
    { id: 'mu', shape: 'pill', at: [2, 0], label: HOSTILE },
    { id: 'store', shape: 'disk', at: [2, 1], label: 'SQLite', hidden: true },
    { id: 'job', shape: 'token', at: 'worker', label: 'job' },
  ],
  links: [
    { from: 'worker', to: 'mu', label: 'patch' },
    { id: 'answer', from: 'mu', to: 'worker', dashed: true, arrow: 'both' },
    { from: 'mu', to: 'store' },
  ],
  steps: [
    {
      caption: 'The worker sends a patch. <b>bold</b>',
      do: [{ send: 'worker-mu', label: 'PATCH' }, { highlight: 'mu', together: true }, { pulse: 'mu' }],
    },
    {
      caption: 'Mu stores it.',
      do: [
        { show: 'store' },
        { move: 'job', to: 'store' },
        { set: 'store', label: 'version 2', tone: 'good' },
        { focus: ['store', 'mu-store'] },
      ],
    },
    { caption: 'Nothing moves here.' },
    { caption: 'The job leaves.', do: [{ hide: ['job', 'answer'] }] },
  ],
};
const fence = (scene) => `\`\`\`scene\n${JSON.stringify(scene)}\n\`\`\``;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const scene = (change = {}) => parseScene(JSON.stringify({ ...SCENE, ...change }));

test('a scene block is JSON with nodes, links and steps, in one fixed shape', () => {
  const parsed = scene();
  assert.equal(parsed.title, 'How a patch is stored');
  assert.deepEqual(parsed.nodes[0], {
    id: 'worker',
    shape: 'box',
    at: [0, 0],
    label: 'Worker',
    tone: 'plain',
    hidden: false,
  });
  assert.deepEqual(parsed.nodes[3], {
    id: 'job',
    shape: 'token',
    at: 'worker',
    label: 'job',
    tone: 'accent',
    hidden: false,
  });
  // A link without an ID is named after its ends.
  assert.deepEqual(
    parsed.links.map((link) => [link.id, link.arrow, link.dashed, link.bend]),
    [
      ['worker-mu', 'end', false, null],
      ['answer', 'both', true, null],
      ['mu-store', 'end', false, null],
    ],
  );
  assert.deepEqual(parsed.steps[0].actions, [
    { verb: 'send', together: false, id: 'worker-mu', label: 'PATCH', back: false, tone: 'accent' },
    { verb: 'highlight', together: true, ids: ['mu'] },
    { verb: 'pulse', together: false, ids: ['mu'] },
  ]);
  assert.deepEqual(parsed.steps[1].actions[1], { verb: 'move', together: false, id: 'job', to: 'store' });
  assert.deepEqual(parsed.steps[2], { caption: 'Nothing moves here.', actions: [] });
  // The same scene in another spelling is the same scene.
  assert.deepEqual(
    parseScene(
      JSON.stringify({
        ...SCENE,
        nodes: SCENE.nodes.map((node) => ({
          shape: 'box',
          tone: node.shape === 'token' ? 'accent' : 'plain',
          ...node,
        })),
      }),
    ),
    parsed,
  );
});

test('every mistake in a scene names its place and what is allowed', () => {
  const A = { id: 'a', at: [0, 0] };
  const B = { id: 'b', at: [1, 0] };
  const one = [{ caption: 'One.' }];
  const refused = (spec, message) => assert.throws(() => parseScene(JSON.stringify(spec)), { message });
  assert.throws(() => parseScene('{'), /^Error: A scene block is JSON, and this one does not parse/);
  refused([], 'A scene block is a JSON object with a list "nodes" and a list "steps"');
  refused(
    { nodes: [A], steps: one, script: 'x' },
    'A scene has no property "script"; it takes title, nodes, links, steps',
  );
  refused({ nodes: [], steps: one }, `A scene has 1–${SCENE_LIMITS.nodes} nodes`);
  refused({ nodes: [A], steps: [] }, `A scene has 1–${SCENE_LIMITS.steps} steps`);
  refused(
    { nodes: [{ ...A, onclick: 'alert(1)' }], steps: one },
    'Scene node 1 (a) has no property "onclick"; it takes id, shape, at, label, tone, hidden',
  );
  refused(
    { nodes: [{ ...A, id: 'A b' }], steps: one },
    'Scene node 1 (A b): "id" must start with a lowercase letter and use at most 48 lowercase letters, digits or hyphens',
  );
  refused({ nodes: [A, A], steps: one }, 'Scene node 2 (a): this ID is used twice in the scene');
  refused(
    { nodes: [{ ...A, shape: 'star' }], steps: one },
    'Scene node 1 (a): "shape" is one of box, pill, disk, circle, diamond, person, note, token',
  );
  for (const at of [[0, 8], [12, 0], [-1, 0], [0], ['0', 0], 'b', null])
    refused(
      { nodes: [{ id: 'a', at }], steps: one },
      'Scene node 1 (a): "at" is a cell [column, row] with a column from 0 to 11 and a row from 0 to 7',
    );
  refused(
    { nodes: [A, { id: 't', shape: 'token', at: 't' }], steps: one },
    'Scene node 2 (t): "at" is a cell [column, row] or the ID of a node that is not a token',
  );
  refused(
    { nodes: [{ ...A, label: 'x'.repeat(SCENE_LIMITS.labelChars + 1) }], steps: one },
    `Scene node 1 (a): "label" must be text of at most ${SCENE_LIMITS.labelChars} characters on one line`,
  );
  refused(
    { nodes: [{ ...A, label: 'two\nlines' }], steps: one },
    /"label" must be text of at most 60 characters on one line$/,
  );
  refused(
    { nodes: [{ ...A, tone: 'red' }], steps: one },
    'Scene node 1 (a): "tone" is one of plain, accent, good, warn, bad, muted',
  );
  refused({ nodes: [{ ...A, hidden: 'yes' }], steps: one }, 'Scene node 1 (a): "hidden" must be true or false');
  // Text that a browser draws nothing for, and a model still reads, is in no label, caption or title.
  const tagged = `ok${String.fromCodePoint(0xe0049)}`;
  refused(
    { nodes: [{ ...A, label: tagged }], steps: one },
    'Scene node 1 (a): "label" holds a character that is not shown (U+E0049)',
  );
  refused(
    { nodes: [A, { id: 't', shape: 'token', at: 'a', label: 'a\u200bb' }], steps: one },
    'Scene node 2 (t): "label" holds a character that is not shown (U+200B)',
  );
  refused(
    { nodes: [A, B], links: [{ from: 'a', to: 'b', label: 'safe\u202e' }], steps: one },
    'Scene link 1: "label" holds a character that is not shown (U+202E)',
  );
  refused(
    { title: `T${tagged}`, nodes: [A], steps: one },
    'A scene: "title" holds a character that is not shown (U+E0049)',
  );
  refused(
    { nodes: [A], steps: [{ caption: tagged }] },
    'Scene step 1: "caption" holds a character that is not shown (U+E0049)',
  );
  refused(
    { nodes: [A], steps: [{ caption: 'two\nlines' }] },
    `Scene step 1: "caption" must be text of 1–${SCENE_LIMITS.captionChars} characters on one line`,
  );
  // The joiner that an emoji is written with is shown.
  assert.equal(
    parseScene(JSON.stringify({ nodes: [{ ...A, label: '👩‍💻 writes' }], steps: one })).nodes[0].label,
    '👩‍💻 writes',
  );
  refused(
    { nodes: [A, { id: 'b', at: [0.5, 0.25] }], steps: one },
    'Scene nodes a and b would be drawn over each other; move one to another cell',
  );

  const links = (link, more = []) => ({
    nodes: [A, B, { id: 't', shape: 'token', at: 'a' }],
    links: [...more, link],
    steps: one,
  });
  refused(links({ from: 'a', to: 'c' }), 'Scene link 1: "to" is the ID of a node that is not a token');
  refused(links({ from: 't', to: 'a' }), 'Scene link 1: "from" is the ID of a node that is not a token');
  refused(links({ from: 'a', to: 'a' }), 'Scene link 1: a link joins two different nodes');
  refused(
    links({ from: 'a', to: 'b' }, [{ from: 'a', to: 'b' }]),
    'Scene link 2: the ID a-b that it would get is in use; give the link an "id"',
  );
  refused(links({ id: 'a', from: 'a', to: 'b' }), 'Scene link 1 (a): this ID is used twice in the scene');
  refused(links({ from: 'a', to: 'b', arrow: 'start' }), 'Scene link 1: "arrow" is one of end, both, none');
  refused(links({ from: 'a', to: 'b', bend: 3 }), 'Scene link 1: "bend" is a number from −2 to 2');
  refused(links({ from: 'a', to: 'b', href: 'https://example.com' }), /^Scene link 1 has no property "href"/);

  const steps = (step, nodes = [A, { ...B, hidden: true }, { id: 't', shape: 'token', at: 'a' }]) => ({
    nodes,
    links: [{ from: 'a', to: 'b' }],
    steps: [{ caption: 'One.' }, step],
  });
  refused(
    steps({ do: [] }),
    `Scene step 2: "caption" must be text of 1–${SCENE_LIMITS.captionChars} characters on one line`,
  );
  refused(steps({ caption: 'x', then: [] }), 'Scene step 2 has no property "then"; it takes caption, do');
  refused(
    steps({ caption: 'x', do: Array.from({ length: SCENE_LIMITS.actions + 1 }, () => ({ pulse: 'a' })) }),
    `Scene step 2: "do" is a list of at most ${SCENE_LIMITS.actions} actions`,
  );
  const action = (wrong, message) => refused(steps({ caption: 'x', do: [{ pulse: 'a' }, wrong] }), message);
  action(
    {},
    'Scene step 2, action 2: an action is an object with one of show, hide, highlight, focus, pulse, send, move, set',
  );
  action({ show: 'b', hide: 'a' }, /^Scene step 2, action 2: an action is an object with one of show/);
  action({ run: 'alert(1)' }, /^Scene step 2, action 2: an action is an object with one of show/);
  action(
    { show: 'b', ease: 'x' },
    'Scene step 2, action 2: a show action has no property "ease"; it takes show, together',
  );
  action({ show: 'c' }, 'Scene step 2, action 2 (show): the scene has no part "c"');
  action(
    { show: [] },
    `Scene step 2, action 2 (show): it names one part of the scene, or a list of 1–${SCENE_LIMITS.targets} parts`,
  );
  action({ show: ['b', 'b'] }, 'Scene step 2, action 2 (show): it names a part twice');
  action({ show: 'b', together: 1 }, 'Scene step 2, action 2 (show): "together" must be true or false');
  action({ send: 'a' }, 'Scene step 2, action 2 (send): it names the link that the message travels');
  action(
    { send: 'a-b', label: 'x'.repeat(SCENE_LIMITS.tokenLabelChars + 1) },
    /"label" must be text of at most 24 characters/,
  );
  action({ move: 'a', to: [1, 1] }, 'Scene step 2, action 2 (move): it names a node of the shape "token"');
  action(
    { move: 't' },
    'Scene step 2, action 2 (move): "to" is a cell [column, row] or the ID of a node that is not a token',
  );
  action({ move: 't', to: 't' }, /"to" is a cell \[column, row\] or the ID of a node that is not a token$/);
  action({ set: 'a' }, 'Scene step 2, action 2 (set): it gives a new "label", a new "tone" or both');
  action(
    { set: 'a', label: 'new\u2060' },
    'Scene step 2, action 2 (set): "label" holds a character that is not shown (U+2060)',
  );
  action(
    { send: 'a-b', label: 'go\u200d' },
    'Scene step 2, action 2 (send): "label" holds a character that is not shown (U+200D)',
  );
  action(
    { set: 'a', tone: 'pink' },
    'Scene step 2, action 2 (set): "tone" is one of plain, accent, good, warn, bad, muted',
  );
  // An action that the scene cannot play at that moment.
  action({ show: 'a' }, 'Scene step 2, action 2 (show): a is shown already');
  action({ hide: 'b' }, 'Scene step 2, action 2 (hide): b is hidden already');
  action({ highlight: 'b' }, 'Scene step 2, action 2 (highlight): b is hidden; show it first');
  action(
    { send: 'a-b' },
    'Scene step 2, action 2 (send): link a-b is not drawn while one of its ends is hidden; show the end first',
  );
  // The name of a property that every object has is no part of a scene.
  action({ pulse: 'constructor' }, 'Scene step 2, action 2 (pulse): the scene has no part "constructor"');
  assert.doesNotThrow(() =>
    parseScene(
      JSON.stringify({
        nodes: [{ id: 'constructor', at: [0, 0] }],
        steps: [{ caption: 'x', do: [{ pulse: 'constructor' }] }],
      }),
    ),
  );
});

test('what a scene shows after each step is computed from its text', () => {
  const parsed = scene();
  const { start, steps } = sceneStates(parsed);
  const shown = (state) => [...state.parts.keys()].filter((id) => sceneVisible(parsed, state, id));
  // A link is drawn only while both its ends are.
  assert.equal(start.parts.get('mu-store').shown, true);
  assert.deepEqual(shown(start), ['worker', 'mu', 'job', 'worker-mu', 'answer']);
  // One state before the step and one after each action.
  assert.deepEqual(
    steps.map((moments) => moments.length),
    [4, 5, 1, 2],
  );
  assert.deepEqual([...steps[0][1].lit], []);
  assert.deepEqual([...steps[0][2].lit], ['mu']);
  const stored = steps[1].at(-1);
  assert.deepEqual(shown(stored), ['worker', 'mu', 'store', 'job', 'worker-mu', 'answer', 'mu-store']);
  assert.deepEqual(stored.parts.get('store'), { shown: true, label: 'version 2', tone: 'good', at: [2, 1] });
  assert.equal(stored.parts.get('job').at, 'store');
  assert.deepEqual([...stored.focus], ['store', 'mu-store']);
  // What a step points at lasts for that step; what it changed stays.
  assert.deepEqual([...steps[1][0].lit], []);
  assert.equal(steps[2][0].focus, null);
  assert.equal(steps[2][0].parts.get('store').label, 'version 2');
  assert.deepEqual(shown(steps[3].at(-1)), ['worker', 'mu', 'store', 'worker-mu', 'mu-store']);
  // A state is not changed by the steps after it.
  assert.equal(start.parts.get('store').shown, false);
  assert.equal(steps[0].at(-1).parts.get('job').at, 'worker');
});

test('the service checks a scene when the visual is written', async (t) => {
  const { worker, startTurn } = await team(t);
  startTurn('worker');
  const broken = { ...SCENE, steps: [{ caption: 'Too early.', do: [{ send: 'mu-store' }] }] };
  const refused = await worker('POST', '/api/visuals', { source: `# Plan\n\n## Flow {#flow}\n\n${fence(broken)}\n` });
  assert.equal(refused.status, 400);
  assert.equal(
    refused.body.error,
    'Invalid visual source: Section flow: Scene step 1, action 1 (send): link mu-store is not drawn while one of its ends is hidden; show the end first',
  );
  const created = await worker('POST', '/api/visuals', { source: `# Plan\n\n## Flow {#flow}\n\n${fence(SCENE)}\n` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const patched = await worker('PATCH', `/api/visuals/${created.body.id}`, {
    source: `## Flow {#flow}\n\n${fence({ ...SCENE, nodes: [...SCENE.nodes, { id: 'mu', at: [5, 5] }] })}\n`,
  });
  assert.equal(patched.status, 400);
  assert.match(patched.body.error, /Section flow: Scene node 5 \(mu\): this ID is used twice in the scene$/);
});

test('a label is broken into the lines of its shape', () => {
  assert.deepEqual(wrap('Mu service', 16, 3), ['Mu service']);
  assert.deepEqual(wrap('The session store of Mu', 10, 3), ['The', 'session', 'store of…']);
  assert.deepEqual(wrap('The session store', 10, 3), ['The', 'session', 'store']);
  assert.deepEqual(wrap('Supercalifragilistic', 8, 2), ['Supercal', 'ifragil…']);
  assert.deepEqual(wrap('Supercalifragilistic', 8, 3), ['Supercal', 'ifragili', 'stic']);
  assert.deepEqual(wrap('a  b', 8, 1), ['a b']);
  assert.deepEqual(wrap('', 8, 1), []);
  // A character outside the basic plane counts once and is never cut in two.
  assert.deepEqual(wrap('🙂🙂🙂🙂🙂', 4, 1), ['🙂🙂🙂…']);
});

test('links run between the edges of their nodes, and two links between the same nodes bow apart', () => {
  const parsed = scene();
  const layout = sceneLayout(parsed);
  // Three columns and two rows of cells, with the space around them.
  assert.deepEqual(layout.size, [520, 248]);
  assert.deepEqual(layout.places.get('worker'), [100, 72]);
  assert.deepEqual(layout.places.get('store'), [420, 176]);
  const straight = layout.links.get('mu-store').curve;
  // Below the pill and above the disk, on the line between their middles.
  assert.equal(Math.round(straight.p0[0]), 420);
  assert.ok(straight.p0[1] > 72 + 24 && straight.p0[1] < 72 + 34, String(straight.p0));
  assert.ok(straight.p1[1] < 176 - 34 && straight.p1[1] > 176 - 44, String(straight.p1));
  assert.equal(Math.round(layout.links.get('mu-store').length), Math.round(straight.p1[1] - straight.p0[1]));
  // The patch and its answer join the same two nodes: one bows up and one down, each from edge to edge.
  const there = layout.links.get('worker-mu').curve;
  const back = layout.links.get('answer').curve;
  assert.ok(there.p0[0] > 162 && there.p0[0] < 175 && there.p1[0] < 358 && there.p1[0] > 345, JSON.stringify(there));
  assert.ok(back.p0[0] > there.p1[0] - 1 && back.p1[0] < there.p0[0] + 1, JSON.stringify(back));
  assert.ok(Math.sign(there.c[1] - 72) === -Math.sign(back.c[1] - 72) && there.c[1] !== 72, `${there.c} ${back.c}`);
  // A bend that the author gave is kept.
  const bent = sceneLayout(
    scene({ links: [{ from: 'worker', to: 'mu', bend: -1 }], steps: [{ caption: 'One.' }] }),
  ).links.get('worker-mu').curve;
  assert.ok(bent.c[1] < 72 - 60, 'a negative bend bows to the left of the direction, which is up here');
});

// The frame's page with a scene drawn in it. `played` holds what the scene gave to the animation engine: the tracks
// of each step, with what the test does to them.
async function drawn(t, { body = fence(SCENE), reduced = false } = {}) {
  const { window } = new JSDOM('<main id="document"></main>', { runScripts: 'outside-only' });
  t.after(() => window.close());
  const played = [];
  const timers = [];
  const scenes = createScenes({
    document: window.document,
    parseScene,
    sceneStates,
    sceneVisible,
    motion: {
      play(tracks, done) {
        const record = { tracks, calls: [], done };
        played.push(record);
        return {
          pause: () => record.calls.push('pause'),
          resume: () => record.calls.push('resume'),
          cancel: () => record.calls.push('cancel'),
        };
      },
    },
    reducedMotion: () => reduced,
    later: (work, delay) => timers.push({ work, delay }),
  });
  const problems = [];
  const renderer = createRenderer({
    document: window.document,
    parseBlocks,
    markdownHtml: (source) => source,
    richBlocks: { scene: scenes.render },
    onProblems: (list) => problems.push(list),
  });
  const container = window.document.getElementById('document');
  renderer.render(container, { sections: [{ id: 'flow', title: 'Flow', rev: 'flow-1', body }] });
  await settle();
  const figure = container.querySelector('.visual-scene');
  const part = (id) => figure.querySelector(`[data-part="${id}"]`);
  const press = (selector) => figure.querySelector(selector).click();
  // What the picture shows, as a reader would say it.
  const seen = () => ({
    progress: figure.querySelector('.scene-progress').textContent,
    play: figure.querySelector('.scene-play').textContent,
    current: [...figure.querySelectorAll('.scene-step')].findIndex((step) => step.classList.contains('current')),
    played: figure.querySelectorAll('.scene-step.played').length,
    hidden: [...figure.querySelectorAll('[data-part].hidden')].map((item) => item.dataset.part),
    lit: [...figure.querySelectorAll('[data-part].lit')].map((item) => item.dataset.part),
    dimmed: [...figure.querySelectorAll('[data-part].dimmed')].map((item) => item.dataset.part),
    store: [part('store').dataset.tone, part('store').textContent],
    job: part('job').getAttribute('transform'),
    messages: figure.querySelectorAll('.scene-message').length,
    styled: figure.querySelectorAll('.scene-picture [style]').length,
  });
  // Plays the tracks of the step that runs to their end, in the order of their start, as the engine does.
  const finish = (record = played.at(-1)) => {
    for (const track of [...record.tracks].sort((a, b) => a.start - b.start)) track.frame(1);
    record.done();
  };
  return { window, figure, part, press, seen, played, timers, finish, problems };
}

const START = {
  progress: '4 steps',
  play: 'Play',
  current: -1,
  played: 0,
  hidden: ['mu-store', 'store'],
  lit: [],
  dimmed: [],
  store: ['plain', 'SQLite'],
  job: 'translate(154 48)',
  messages: 0,
  styled: 0,
};
const AFTER_1 = { ...START, progress: 'Step 1 of 4', current: 0, played: 1, lit: ['mu'] };
const AFTER_2 = {
  ...START,
  progress: 'Step 2 of 4',
  current: 1,
  played: 2,
  hidden: [],
  dimmed: ['worker-mu', 'answer', 'worker', 'mu', 'job'],
  store: ['good', 'version 2'],
  job: 'translate(466 146)',
};

test('a scene is drawn from the shapes that Mu defines, and every label and caption is text', async (t) => {
  const { window, figure, part, seen, problems } = await drawn(t);
  assert.deepEqual(problems.at(-1), []);
  assert.equal(figure.classList.contains('pending'), false);
  assert.equal(window.injected, undefined);
  assert.equal(figure.querySelector('img, b, script, a, foreignObject'), null);
  assert.equal(figure.querySelector('.scene-title').textContent, 'How a patch is stored');
  const picture = figure.querySelector('.scene-picture');
  assert.equal(picture.getAttribute('viewBox'), '0 0 520 248');
  assert.equal(picture.getAttribute('role'), 'img');
  assert.equal(picture.getAttribute('aria-label'), 'How a patch is stored');
  // The label of a pill takes two lines of 14 characters, and the rest is cut.
  assert.deepEqual(
    [...part('mu').querySelectorAll('tspan')].map((line) => line.textContent),
    ['Mu <img src=x', 'onerror="wind…'],
  );
  assert.deepEqual(
    [...figure.querySelectorAll('.scene-caption')].map((caption) => caption.textContent),
    SCENE.steps.map((step) => step.caption),
  );
  // Only the elements of the shapes, with the attributes that the renderer writes.
  const names = new Set([...picture.querySelectorAll('*')].map((element) => element.tagName));
  assert.deepEqual([...names].sort(), ['circle', 'g', 'path', 'rect', 'text', 'tspan']);
  const attributes = new Set([...picture.querySelectorAll('*')].flatMap((element) => element.getAttributeNames()));
  for (const name of attributes)
    assert.match(name, /^(class|d|fill|x|y|cy|r|rx|width|height|transform|text-anchor|font-size|data-part|data-tone)$/);
  assert.deepEqual(part('worker').getAttribute('transform'), 'translate(100 72)');
  assert.equal(part('answer').classList.contains('dashed'), true);
  assert.equal(part('answer').querySelectorAll('.scene-link-head').length, 2);
  assert.equal(part('worker-mu').querySelector('.scene-link-label').textContent, 'patch');
  assert.deepEqual(seen(), START);
  assert.deepEqual(
    [figure.querySelector('.scene-back').disabled, figure.querySelector('.scene-next').disabled],
    [true, false],
  );

  const broken = await drawn(t, { body: fence({ ...SCENE, steps: [{ caption: 'x', do: [{ show: 'worker' }] }] }) });
  assert.match(broken.figure.textContent, /This scene block could not be drawn/);
  assert.match(broken.figure.textContent, /Scene step 1, action 1 \(show\): worker is shown already/);
  assert.equal(broken.problems.at(-1).length, 1);
});

test('a step plays its actions on a timeline and ends in the state that the format computed', async (t) => {
  const { figure, part, press, seen, played, finish } = await drawn(t);
  press('.scene-next');
  assert.equal(played.length, 1);
  // The highlight starts together with the message; the pulse follows when both have ended.
  assert.deepEqual(
    played[0].tracks.map(({ start, duration }) => [start, duration]),
    [
      [0, 950],
      [0, 320],
      [1040, 560],
    ],
  );
  assert.deepEqual(seen(), { ...START, progress: 'Step 1 of 4', current: 0 });
  const [send, highlight, pulse] = played[0].tracks;
  send.frame(0.5);
  const message = figure.querySelector('.scene-message');
  assert.equal(message.textContent, 'PATCH');
  assert.equal(message.dataset.tone, 'accent');
  // Half way along the link, which bows away from the link that answers it: to the right of its direction.
  const [, x, y] = /translate\(([\d.]+) ([\d.]+)\)/.exec(message.getAttribute('transform')).map(Number);
  assert.ok(Math.abs(x - 260) < 1 && y > 72 + 5 && y < 72 + 25, `${x} ${y}`);
  assert.equal(message.style.opacity, '1');
  // The label of the message travels where the label of its link stands, so the link gives way while it passes.
  const linkLabel = part('worker-mu').querySelector('.scene-link-label');
  assert.equal(linkLabel.style.opacity, '0');
  send.frame(0.95);
  assert.equal(linkLabel.style.opacity, '0.6');
  highlight.frame(0.1);
  assert.deepEqual(seen().lit, ['mu']);
  pulse.frame(0.5);
  assert.match(part('mu').querySelector('.scene-body').style.transform, /^scale\(1\.16\)$/);
  finish();
  // The message is gone and no motion left a style behind.
  assert.deepEqual(seen(), AFTER_1);

  press('.scene-next');
  assert.deepEqual(
    played[1].tracks.map(({ start }) => start),
    [0, 510, 1350, 1820],
  );
  // The step starts without what the step before pointed at.
  assert.deepEqual(seen().lit, []);
  const [show, move, set] = played[1].tracks;
  show.frame(0.5);
  // The node comes with the link that had waited for it.
  assert.deepEqual(seen().hidden, []);
  assert.equal(part('store').querySelector('.scene-body').style.opacity, '0.5');
  assert.match(part('mu-store').querySelector('.scene-link-line').style.strokeDasharray, /^\d+(\.\d)? \d+$/);
  move.frame(0.5);
  assert.equal(part('job').getAttribute('transform'), 'translate(310 97)');
  set.frame(0.25);
  assert.deepEqual(seen().store, ['good', 'SQLite']);
  set.frame(0.75);
  assert.deepEqual(seen().store, ['good', 'version 2']);
  finish();
  assert.deepEqual(seen(), AFTER_2);
});

test('the reader steps forward and back, jumps to a step and lets the scene play on', async (t) => {
  const { press, seen, played, timers, finish } = await drawn(t);
  // Next during a step brings the step to its end.
  press('.scene-next');
  press('.scene-next');
  assert.deepEqual(played[0].calls, ['cancel']);
  assert.deepEqual(seen(), AFTER_1);
  assert.equal(played.length, 1);
  // Back during a step returns to the state before it; Back again goes one step back.
  press('.scene-next');
  press('.scene-back');
  assert.deepEqual(played[1].calls, ['cancel']);
  assert.deepEqual(seen(), AFTER_1);
  press('.scene-back');
  assert.deepEqual(seen(), START);
  // A callback of a step that was left changes nothing.
  played[1].done();
  assert.deepEqual(seen(), START);

  // A number plays its step from the state before it.
  press('.scene-step:nth-child(2) .scene-jump');
  assert.deepEqual(seen(), { ...AFTER_1, progress: 'Step 2 of 4', current: 1, lit: [] });
  finish();
  assert.deepEqual(seen(), AFTER_2);
  assert.equal(timers.length, 0, 'one step, not the rest');

  // Play goes on by itself, with time to read each caption; a step without actions only waits.
  press('.scene-play');
  assert.deepEqual(timers.at(-1).delay, 900 + 40 * 'Nothing moves here.'.length);
  assert.deepEqual([seen().progress, seen().play], ['Step 3 of 4', 'Pause']);
  assert.equal(played.length, 3);
  timers.at(-1).work();
  assert.equal(played.length, 4);
  // Pause holds the step where it is, and Play takes it up again.
  press('.scene-play');
  assert.deepEqual([played[3].calls, seen().play], [['pause'], 'Play']);
  press('.scene-play');
  assert.deepEqual([played[3].calls, seen().play], [['pause', 'resume'], 'Pause']);
  finish();
  const end = {
    ...AFTER_2,
    progress: 'Step 4 of 4',
    play: 'Replay',
    current: 3,
    played: 4,
    hidden: ['answer', 'job'],
    dimmed: [],
  };
  assert.deepEqual(seen(), end);
  assert.equal(timers.length, 1, 'nothing follows the last step');

  // A pause between two steps stops the scene there.
  press('.scene-play');
  assert.deepEqual([seen().progress, seen().play, played.length], ['Step 1 of 4', 'Pause', 5]);
  finish();
  press('.scene-play');
  timers.at(-1).work();
  assert.equal(played.length, 5);
  assert.deepEqual(seen(), AFTER_1);
});

test('a reader who asked for less motion gets the result of each step at once', async (t) => {
  const { press, seen, played, timers } = await drawn(t, { reduced: true });
  press('.scene-next');
  assert.deepEqual(seen(), AFTER_1);
  press('.scene-play');
  assert.deepEqual(seen(), { ...AFTER_2, play: 'Pause' });
  timers.at(-1).work();
  timers.at(-1).work();
  assert.deepEqual([seen().progress, seen().play], ['Step 4 of 4', 'Replay']);
  assert.equal(played.length, 0);
});
