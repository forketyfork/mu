// The format of a `scene` block: an animated explainer as data. The author names the parts of a picture on a grid
// and the steps that change it; Mu draws the picture and plays the steps. Nothing in a scene is code, markup or a
// style, so an author cannot make the reader's browser do anything but draw the shapes Mu knows.
//
// What a scene shows after each step is computed here, from the text alone. The service checks every step with it
// when a scene is written, and the frame draws exactly these states, so a scene that was stored always plays. A
// state is computed when it is asked for and never kept: a scene that is cheap to write must be cheap to hold.
// See "Visuals" in docs/architecture.md.
import { ID, isObject, onlyKeys, unseen } from './visual-spec.mjs';

export const SCENE_LIMITS = Object.freeze({
  nodes: 40,
  links: 60,
  steps: 40,
  // In one step.
  actions: 12,
  // Parts that one action names.
  targets: 20,
  labelChars: 60,
  tokenLabelChars: 24,
  captionChars: 400,
  titleChars: 120,
  cols: 12,
  rows: 8,
  bend: 2,
});
// A token is a small mark that moves; every other shape stands still and can be an end of a link.
export const SCENE_SHAPES = Object.freeze(['box', 'pill', 'disk', 'circle', 'diamond', 'person', 'note', 'token']);
export const SCENE_TONES = Object.freeze(['plain', 'accent', 'good', 'warn', 'bad', 'muted']);
const ARROWS = Object.freeze(['end', 'both', 'none']);
// Two standing nodes stand at least this far apart, in cells, in one direction. No shape is larger than a cell, so
// no two are drawn over each other.
const APART = Object.freeze([1, 1]);

/**
 * @typedef {[number, number]} Cell A place on the grid: column and row, counted from 0. Halves are fine.
 * @typedef {{ id: string, shape: string, at: Cell | string, label: string, tone: string, hidden: boolean }} SceneNode
 *   A token can stand on a node, which `at` then names.
 * @typedef {{
 *   id: string, from: string, to: string, label: string, tone: string, dashed: boolean, arrow: string,
 *   bend: number | null, hidden: boolean,
 * }} SceneLink
 * @typedef {{
 *   verb: string, together: boolean, ids?: string[], id?: string, label?: string, tone?: string, back?: boolean,
 *   to?: Cell | string,
 * }} SceneAction
 * @typedef {{ caption: string, actions: SceneAction[] }} SceneStep
 * @typedef {{ title: string, nodes: SceneNode[], links: SceneLink[], steps: SceneStep[] }} Scene
 * @typedef {{ shown: boolean, label: string, tone: string, at?: Cell | string }} PartState
 * @typedef {{ parts: Map<string, PartState>, lit: Set<string>, focus: Set<string> | null }} SceneState
 *   `lit` and `focus` hold what a step points at; they last for that step.
 */

/**
 * @typedef {object} Reading What the reader of an action knows.
 * @property {Map<string, 'node' | 'token' | 'link'>} kinds
 * @property {(message: string) => never} fail
 * @property {(value: unknown, name: string, max: number) => string | undefined} text
 * @property {(value: unknown) => string | undefined} tone
 * @property {(value: unknown, name: string) => Cell} cell
 */

/** @returns {{ ids: string[] }} */
function targets(value, { kinds, fail }) {
  const ids = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(ids) || !ids.length || ids.length > SCENE_LIMITS.targets)
    fail(`it names one part of the scene, or a list of 1–${SCENE_LIMITS.targets} parts`);
  for (const id of ids) if (typeof id !== 'string' || !kinds.has(id)) fail(`the scene has no part ${shortened(id)}`);
  if (new Set(ids).size !== ids.length) fail('it names a part twice');
  return { ids };
}

const shortened = (value) => JSON.stringify(typeof value === 'string' ? value.slice(0, 48) : value)?.slice(0, 60);

/** @param {SceneState} state @param {Map<string, SceneLink>} links @param {string} id */
function visible(state, links, id) {
  const link = links.get(id);
  return state.parts.get(id).shown && (!link || (state.parts.get(link.from).shown && state.parts.get(link.to).shown));
}

function needVisible(state, links, ids) {
  for (const id of ids)
    if (!visible(state, links, id))
      throw new Error(
        state.parts.get(id).shown
          ? `link ${id} is not drawn while one of its ends is hidden; show the end first`
          : `${id} is hidden; show it first`,
      );
}

// Every verb of an action: the options it takes, how it reads its value, and what it changes in the scene. `apply`
// changes the state it gets. A new verb is one more entry here and its motion in public/visual/scene.js.
/**
 * @type {Record<string, {
 *   options: string[],
 *   read: (value: unknown, raw: Record<string, unknown>, reading: Reading) => Partial<SceneAction>,
 *   apply: (state: SceneState, action: SceneAction, links: Map<string, SceneLink>) => void,
 * }>}
 */
const VERBS = {
  show: {
    options: [],
    read: (value, raw, reading) => targets(value, reading),
    apply(state, { ids }) {
      for (const id of ids) {
        if (state.parts.get(id).shown) throw new Error(`${id} is shown already`);
        state.parts.get(id).shown = true;
      }
    },
  },
  hide: {
    options: [],
    read: (value, raw, reading) => targets(value, reading),
    apply(state, { ids }) {
      for (const id of ids) {
        if (!state.parts.get(id).shown) throw new Error(`${id} is hidden already`);
        state.parts.get(id).shown = false;
      }
    },
  },
  highlight: {
    options: [],
    read: (value, raw, reading) => targets(value, reading),
    apply(state, { ids }, links) {
      needVisible(state, links, ids);
      for (const id of ids) state.lit.add(id);
    },
  },
  focus: {
    options: [],
    read: (value, raw, reading) => targets(value, reading),
    apply(state, { ids }, links) {
      needVisible(state, links, ids);
      state.focus = new Set([...(state.focus ?? []), ...ids]);
    },
  },
  pulse: {
    options: [],
    read: (value, raw, reading) => targets(value, reading),
    apply(state, { ids }, links) {
      needVisible(state, links, ids);
    },
  },
  send: {
    options: ['label', 'back', 'tone'],
    read(value, raw, { kinds, fail, text, tone }) {
      if (typeof value !== 'string' || kinds.get(value) !== 'link') fail('it names the link that the message travels');
      if (raw.back !== undefined && typeof raw.back !== 'boolean') fail('"back" must be true or false');
      return {
        id: /** @type {string} */ (value),
        label: text(raw.label, 'label', SCENE_LIMITS.tokenLabelChars) ?? '',
        back: raw.back === true,
        tone: tone(raw.tone) ?? 'accent',
      };
    },
    apply(state, { id }, links) {
      needVisible(state, links, [id]);
    },
  },
  move: {
    options: ['to'],
    read(value, raw, { kinds, fail, cell }) {
      if (typeof value !== 'string' || kinds.get(value) !== 'token') fail('it names a node of the shape "token"');
      if (typeof raw.to === 'string' ? kinds.get(raw.to) !== 'node' : raw.to === undefined)
        fail('"to" is a cell [column, row] or the ID of a node that is not a token');
      return {
        id: /** @type {string} */ (value),
        to: typeof raw.to === 'string' ? raw.to : cell(raw.to, 'to'),
      };
    },
    apply(state, { id, to }) {
      state.parts.get(id).at = to;
    },
  },
  set: {
    options: ['label', 'tone'],
    read(value, raw, { kinds, fail, text, tone }) {
      if (typeof value !== 'string' || !kinds.has(value)) fail(`the scene has no part ${shortened(value)}`);
      if (raw.label === undefined && raw.tone === undefined) fail('it gives a new "label", a new "tone" or both');
      const id = /** @type {string} */ (value);
      const max = kinds.get(id) === 'token' ? SCENE_LIMITS.tokenLabelChars : SCENE_LIMITS.labelChars;
      return {
        id,
        ...(raw.label === undefined ? {} : { label: text(raw.label, 'label', max) ?? '' }),
        ...(raw.tone === undefined ? {} : { tone: tone(raw.tone) }),
      };
    },
    apply(state, { id, label, tone }) {
      const part = state.parts.get(id);
      if (label !== undefined) part.label = label;
      if (tone !== undefined) part.tone = tone;
    },
  },
};
export const SCENE_VERBS = Object.freeze(Object.keys(VERBS));

/**
 * The scene of a block, checked and in one fixed shape. The block is JSON:
 * `{"nodes": [{"id": "a", "at": [0, 0], "label": "A"}], "links": [{"from": "a", "to": "b"}],
 *   "steps": [{"caption": "A calls B.", "do": [{"send": "a-b"}]}]}`.
 * @param {string} source
 * @returns {Scene}
 */
export function parseScene(source) {
  let spec;
  try {
    spec = JSON.parse(source);
  } catch (error) {
    throw new Error(`A scene block is JSON, and this one does not parse: ${error.message}`, { cause: error });
  }
  if (!isObject(spec) || !Array.isArray(spec.nodes) || !Array.isArray(spec.steps))
    throw new Error('A scene block is a JSON object with a list "nodes" and a list "steps"');
  onlyKeys(spec, ['title', 'nodes', 'links', 'steps'], 'A scene');
  const within = (list, name, max, least = 1) => {
    if (!Array.isArray(list) || list.length < least || list.length > max)
      throw new Error(`A scene has ${least}–${max} ${name}`);
    return list;
  };
  const reader = (where) => {
    const fail = (message) => {
      throw new Error(`${where}: ${message}`);
    };
    /** @type {Pick<Reading, 'fail' | 'text' | 'tone' | 'cell'>} */
    const read = {
      fail,
      text(value, name, max) {
        if (value === undefined) return undefined;
        const trimmed = typeof value === 'string' ? value.trim() : null;
        if (trimmed === null || [...trimmed].length > max || /[\r\n]/.test(trimmed))
          fail(`"${name}" must be text of at most ${max} characters on one line`);
        const hidden = unseen(trimmed);
        if (hidden) fail(`"${name}" holds a character that is not shown (${hidden})`);
        return trimmed;
      },
      tone(value) {
        if (value === undefined) return undefined;
        if (typeof value !== 'string' || !SCENE_TONES.includes(value))
          fail(`"tone" is one of ${SCENE_TONES.join(', ')}`);
        return /** @type {string} */ (value);
      },
      cell(value, name) {
        const inside = (number, count) => typeof number === 'number' && number >= 0 && number <= count - 1;
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          !inside(value[0], SCENE_LIMITS.cols) ||
          !inside(value[1], SCENE_LIMITS.rows)
        )
          fail(
            `"${name}" is a cell [column, row] with a column from 0 to ${SCENE_LIMITS.cols - 1} and a row from 0 to ${SCENE_LIMITS.rows - 1}`,
          );
        return [value[0], value[1]];
      },
    };
    return read;
  };
  const named = (raw) => (isObject(raw) && typeof raw.id === 'string' ? ` (${raw.id.slice(0, 48)})` : '');
  const flag = (raw, name, fail) => {
    if (raw[name] !== undefined && typeof raw[name] !== 'boolean') fail(`"${name}" must be true or false`);
    return raw[name] === true;
  };

  /** @type {Map<string, 'node' | 'token' | 'link'>} */
  const kinds = new Map();
  const nodes = within(spec.nodes, 'nodes', SCENE_LIMITS.nodes).map((raw, index) => {
    const { fail, text, tone, cell } = reader(`Scene node ${index + 1}${named(raw)}`);
    if (!isObject(raw)) fail('a node is an object');
    onlyKeys(raw, ['id', 'shape', 'at', 'label', 'tone', 'hidden'], `Scene node ${index + 1}${named(raw)}`);
    if (typeof raw.id !== 'string' || !ID.test(raw.id))
      fail('"id" must start with a lowercase letter and use at most 48 lowercase letters, digits or hyphens');
    if (kinds.has(raw.id)) fail('this ID is used twice in the scene');
    const shape = raw.shape === undefined ? 'box' : raw.shape;
    if (!SCENE_SHAPES.includes(shape)) fail(`"shape" is one of ${SCENE_SHAPES.join(', ')}`);
    kinds.set(raw.id, shape === 'token' ? 'token' : 'node');
    /** @type {SceneNode} */
    const node = {
      id: raw.id,
      shape,
      // A token may stand on a node, which is checked when all nodes are known.
      at: shape === 'token' && typeof raw.at === 'string' ? raw.at : cell(raw.at, 'at'),
      label: text(raw.label, 'label', shape === 'token' ? SCENE_LIMITS.tokenLabelChars : SCENE_LIMITS.labelChars) ?? '',
      tone: tone(raw.tone) ?? (shape === 'token' ? 'accent' : 'plain'),
      hidden: flag(raw, 'hidden', fail),
    };
    return node;
  });
  nodes.forEach((node, index) => {
    if (typeof node.at === 'string' && kinds.get(node.at) !== 'node')
      throw new Error(
        `Scene node ${index + 1} (${node.id}): "at" is a cell [column, row] or the ID of a node that is not a token`,
      );
  });
  const standing = nodes
    .filter((node) => node.shape !== 'token')
    .map((node) => ({ id: node.id, at: /** @type {Cell} */ (node.at) }));
  for (const [index, node] of standing.entries())
    for (const other of standing.slice(0, index))
      if (Math.abs(node.at[0] - other.at[0]) < APART[0] && Math.abs(node.at[1] - other.at[1]) < APART[1])
        throw new Error(
          `Scene nodes ${other.id} and ${node.id} would be drawn over each other; put them a whole column or a whole row apart`,
        );

  const links = within(spec.links === undefined ? [] : spec.links, 'links', SCENE_LIMITS.links, 0).map((raw, index) => {
    const where = `Scene link ${index + 1}${named(raw)}`;
    const { fail, text, tone } = reader(where);
    if (!isObject(raw)) fail('a link is an object');
    onlyKeys(raw, ['id', 'from', 'to', 'label', 'tone', 'dashed', 'arrow', 'bend', 'hidden'], where);
    for (const end of ['from', 'to'])
      if (typeof raw[end] !== 'string' || kinds.get(raw[end]) !== 'node')
        fail(`"${end}" is the ID of a node that is not a token`);
    if (raw.from === raw.to) fail('a link joins two different nodes');
    const id = raw.id === undefined ? `${raw.from}-${raw.to}` : raw.id;
    if (typeof id !== 'string' || !ID.test(id))
      fail(
        raw.id === undefined
          ? `the ID ${raw.from}-${raw.to} that it would get is too long; give the link an "id"`
          : '"id" must start with a lowercase letter and use at most 48 lowercase letters, digits or hyphens',
      );
    if (kinds.has(id))
      fail(
        raw.id === undefined
          ? `the ID ${id} that it would get is in use; give the link an "id"`
          : 'this ID is used twice in the scene',
      );
    kinds.set(id, 'link');
    const arrow = raw.arrow === undefined ? 'end' : raw.arrow;
    if (!ARROWS.includes(arrow)) fail(`"arrow" is one of ${ARROWS.join(', ')}`);
    if (raw.bend !== undefined && (typeof raw.bend !== 'number' || !(Math.abs(raw.bend) <= SCENE_LIMITS.bend)))
      fail(`"bend" is a number from −${SCENE_LIMITS.bend} to ${SCENE_LIMITS.bend}`);
    /** @type {SceneLink} */
    const link = {
      id,
      from: raw.from,
      to: raw.to,
      label: text(raw.label, 'label', SCENE_LIMITS.labelChars) ?? '',
      tone: tone(raw.tone) ?? 'plain',
      dashed: flag(raw, 'dashed', fail),
      arrow,
      bend: raw.bend ?? null,
      hidden: flag(raw, 'hidden', fail),
    };
    return link;
  });

  const steps = within(spec.steps, 'steps', SCENE_LIMITS.steps).map((raw, index) => {
    const where = `Scene step ${index + 1}`;
    const { fail } = reader(where);
    if (!isObject(raw)) fail('a step is an object');
    onlyKeys(raw, ['caption', 'do'], where);
    const caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
    if (!caption || [...caption].length > SCENE_LIMITS.captionChars || /[\r\n]/.test(caption))
      fail(`"caption" must be text of 1–${SCENE_LIMITS.captionChars} characters on one line`);
    const hidden = unseen(caption);
    if (hidden) fail(`"caption" holds a character that is not shown (${hidden})`);
    const list = raw.do === undefined ? [] : raw.do;
    if (!Array.isArray(list) || list.length > SCENE_LIMITS.actions)
      fail(`"do" is a list of at most ${SCENE_LIMITS.actions} actions`);
    const actions = list.map((action, at) => {
      const verbs = isObject(action) ? Object.keys(action).filter((key) => Object.hasOwn(VERBS, key)) : [];
      const reading = reader(`${where}, action ${at + 1}${verbs.length === 1 ? ` (${verbs[0]})` : ''}`);
      if (verbs.length !== 1) reading.fail(`an action is an object with one of ${SCENE_VERBS.join(', ')}`);
      const [verb] = verbs;
      onlyKeys(action, [verb, ...VERBS[verb].options, 'together'], `${where}, action ${at + 1}: a ${verb} action`);
      const together = flag(action, 'together', reading.fail);
      return /** @type {SceneAction} */ ({
        verb,
        // The first action of a step has none before it to start with.
        together: at > 0 && together,
        ...VERBS[verb].read(action[verb], action, { ...reading, kinds }),
      });
    });
    return { caption, actions };
  });

  const title = reader('A scene').text(spec.title, 'title', SCENE_LIMITS.titleChars) ?? '';
  const scene = { title, nodes, links, steps };
  // Every action plays, or the scene is refused.
  sceneState(scene, steps.length);
  return scene;
}

/** @param {SceneState} state @param {SceneAction} action @param {Map<string, SceneLink>} links */
function play(state, action, links, step, at) {
  try {
    VERBS[action.verb].apply(state, action, links);
  } catch (error) {
    throw new Error(`Scene step ${step + 1}, action ${at + 1} (${action.verb}): ${error.message}`, { cause: error });
  }
}

const linksOf = (/** @type {Scene} */ scene) => new Map(scene.links.map((link) => [link.id, link]));

/**
 * What the scene shows when its first `steps` steps have played; with 0, before the first. What the last of them
 * points at is in `lit` and `focus`. The steps play on one state, so the work and the memory are those of one
 * state, however many actions the scene has. Throws when an action cannot be played, with the step and the action
 * named.
 * @param {Scene} scene
 * @param {number} steps
 * @returns {SceneState}
 */
export function sceneState(scene, steps) {
  const links = linksOf(scene);
  /** @type {SceneState} */
  const state = {
    parts: new Map([
      ...scene.nodes.map(
        (node) =>
          /** @type {[string, PartState]} */ ([
            node.id,
            { shown: !node.hidden, label: node.label, tone: node.tone, at: node.at },
          ]),
      ),
      ...scene.links.map(
        (link) =>
          /** @type {[string, PartState]} */ ([link.id, { shown: !link.hidden, label: link.label, tone: link.tone }]),
      ),
    ]),
    lit: new Set(),
    focus: null,
  };
  scene.steps.slice(0, steps).forEach((step, index) => {
    state.lit = new Set();
    state.focus = null;
    step.actions.forEach((action, at) => play(state, action, links, index, at));
  });
  return state;
}

/**
 * The moments of one step that the player can stop at: the state that the step begins with, and the state after
 * each of its actions. The last is what stays when the step has played. These are states of their own, one per
 * action, so the player asks for them when a step plays and lets them go when it ends.
 * @param {Scene} scene
 * @param {number} step The step, counted from 0.
 * @returns {SceneState[]}
 */
export function sceneMoments(scene, step) {
  const links = linksOf(scene);
  const begin = sceneState(scene, step);
  begin.lit = new Set();
  begin.focus = null;
  const moments = [begin];
  scene.steps[step].actions.forEach((action, at) => {
    const before = moments.at(-1);
    /** @type {SceneState} */
    const state = {
      parts: new Map([...before.parts].map(([id, part]) => [id, { ...part }])),
      lit: new Set(before.lit),
      focus: before.focus && new Set(before.focus),
    };
    play(state, action, links, step, at);
    moments.push(state);
  });
  return moments;
}

/**
 * Whether a part is drawn in a state. A link is drawn only while both its ends are.
 * @param {Scene} scene
 * @param {SceneState} state
 * @param {string} id
 */
export function sceneVisible(scene, state, id) {
  const link = scene.links.find((candidate) => candidate.id === id);
  return visible(state, new Map(link ? [[id, link]] : []), id);
}
