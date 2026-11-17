// Draws a `scene` block and plays its steps. The picture is built from the checked scene with shapes that are
// defined here; every label is text written by an agent and is set as text. What the scene shows after a step is
// the state that the format computes: a motion only leads to it, and when a step ends, is skipped or is jumped to,
// the state is drawn anew. The animation library keeps time; it never sees a word of the author. See "Visuals" in
// docs/architecture.md.

const SVG = 'http://www.w3.org/2000/svg';
const CELL = [160, 104];
const PAD = 20;
// Between a node and the end of a link.
const GAP = 6;
const LINE = 16;
const HEAD = 9;
// The size of the text in the picture, and the text size of the page at which a unit of the picture is one pixel.
// The picture is as wide as its units in em of the page, so it grows with the text size that the reader chose.
const TEXT = 13;
const SMALL_TEXT = 12;
const PAGE_TEXT = 18;
// A picture is not drawn smaller than this part of its size, or than this many em when it is wider than that.
const LEAST_SCALE = 0.75;
const LEAST_WIDTH = 30;
// How far a link bows for one unit of "bend", and how far two links between the same nodes stand apart.
const BEND = CELL[1];
const SIBLING_BEND = 0.5;
// Between two actions that play one after the other, in milliseconds.
const BREATH = 90;
const DURATIONS = { show: 420, hide: 300, highlight: 320, focus: 320, pulse: 560, send: 950, move: 750, set: 380 };

/**
 * @typedef {import('../../src/visual-scene.mjs').Scene} Scene
 * @typedef {import('../../src/visual-scene.mjs').SceneState} SceneState
 * @typedef {import('../../src/visual-scene.mjs').SceneAction} SceneAction
 * @typedef {[number, number]} Point
 * @typedef {{ start: number, duration: number, frame: (progress: number) => void }} Track One action of a step:
 *   when it starts in the step, how long it takes, and what it draws at a progress from 0 to 1.
 * @typedef {{ pause: () => void, resume: () => void, cancel: () => void }} Playing
 * @typedef {{ play: (tracks: Track[], done: () => void) => Playing }} Motion
 */

// Every shape: the box it takes, how much text a line of its label holds, and where the label stands. `oval` and
// `pointed` say how a link meets it. A new shape is one more entry here, its outline below and its name in the
// format.
/**
 * @type {Record<string, {
 *   size: [number, number], chars: number, lines: number, labelY?: number, labelFrom?: 'top', oval?: boolean,
 *   pointed?: boolean,
 * }>}
 */
const SHAPES = {
  box: { size: [124, 56], chars: 16, lines: 3 },
  pill: { size: [124, 48], chars: 14, lines: 2 },
  disk: { size: [108, 68], chars: 13, lines: 2, labelY: 5 },
  circle: { size: [76, 76], chars: 9, lines: 3, oval: true },
  diamond: { size: [140, 78], chars: 10, lines: 2, pointed: true },
  person: { size: [84, 88], chars: 14, lines: 2, labelY: 26, labelFrom: 'top' },
  note: { size: [140, 52], chars: 20, lines: 3 },
  token: { size: [20, 20], chars: 24, lines: 1, labelY: -19, oval: true },
};

/**
 * The lines of a label that fits a shape: broken at spaces, a longer word broken where the line ends, and cut with
 * an ellipsis when the lines are used up.
 * @param {string} label
 * @param {number} chars
 * @param {number} lines
 */
export function wrap(label, chars, lines) {
  const out = [];
  let line = '';
  for (const word of label.split(/\s+/).filter(Boolean)) {
    let rest = [...word];
    for (;;) {
      const room = chars - [...line].length - (line ? 1 : 0);
      if (rest.length <= room) {
        line += `${line ? ' ' : ''}${rest.join('')}`;
        break;
      }
      if (line) {
        out.push(line);
        line = '';
      } else {
        out.push(rest.slice(0, chars).join(''));
        rest = rest.slice(chars);
      }
    }
  }
  if (line) out.push(line);
  if (out.length <= lines) return out;
  const last = [...out[lines - 1]];
  return [...out.slice(0, lines - 1), `${last.slice(0, chars - 1).join('')}…`];
}

/** @param {[number, number]} cell @returns {Point} */
const cellPoint = ([column, row]) => [PAD + (column + 0.5) * CELL[0], PAD + (row + 0.5) * CELL[1]];

const along = (from, to, t) =>
  /** @type {Point} */ ([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
/** A point of the curve from `p0` to `p1` that is drawn toward `c`. */
const curvePoint = ({ p0, c, p1 }, t) => along(along(p0, c, t), along(c, p1, t), t);
const curveDirection = ({ p0, c, p1 }, t) => {
  const [x, y] = along([c[0] - p0[0], c[1] - p0[1]], [p1[0] - c[0], p1[1] - c[1]], t);
  const length = Math.hypot(x, y) || 1;
  return /** @type {Point} */ ([x / length, y / length]);
};

/** Whether a point is on a node or nearer to it than a link comes. */
function covers(shape, [centerX, centerY], [x, y]) {
  const { size, oval, pointed } = SHAPES[shape];
  const dx = Math.abs(x - centerX) / (size[0] / 2 + GAP);
  const dy = Math.abs(y - centerY) / (size[1] / 2 + GAP);
  if (oval) return dx * dx + dy * dy <= 1;
  return pointed ? dx + dy <= 1 : dx <= 1 && dy <= 1;
}

/**
 * Where everything of a scene stands: the size of the picture, the middle of each standing node, and the curve of
 * each link between the edges of its two nodes.
 * @param {Scene} scene
 */
export function sceneLayout(scene) {
  const places = new Map(
    scene.nodes
      .filter((node) => node.shape !== 'token')
      .map((node) => [node.id, cellPoint(/** @type {any} */ (node.at))]),
  );
  const shapes = new Map(scene.nodes.map((node) => [node.id, node.shape]));
  const cells = [
    ...scene.nodes.map((node) => node.at),
    ...scene.steps.flatMap((step) => step.actions.map((action) => action.to)),
  ].filter(Array.isArray);
  const size = [0, 1].map(
    (axis) => PAD * 2 + (Math.max(...cells.map((cell) => /** @type {number} */ (cell[axis]))) + 1) * CELL[axis],
  );

  // Links between the same two nodes bow apart, each to its own side whatever its direction.
  const pairs = new Map();
  for (const link of scene.links) {
    const key = [link.from, link.to].sort().join(' ');
    pairs.set(key, [...(pairs.get(key) ?? []), link]);
  }
  const links = new Map(
    scene.links.map((link) => {
      const siblings = pairs.get([link.from, link.to].sort().join(' '));
      const side = link.from < link.to ? 1 : -1;
      const bend =
        link.bend ??
        (siblings.indexOf(link) - (siblings.length - 1) / 2) * SIBLING_BEND * side * (siblings.length > 1 ? 1 : 0);
      const from = places.get(link.from);
      const to = places.get(link.to);
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
      // A positive bend bows to the right of the direction of the link.
      const normal = [-(to[1] - from[1]) / length, (to[0] - from[0]) / length];
      const middle = along(from, to, 0.5);
      const whole = {
        p0: from,
        c: /** @type {Point} */ ([middle[0] + normal[0] * bend * BEND, middle[1] + normal[1] * bend * BEND]),
        p1: to,
      };
      // The part of the curve between the two nodes: where it leaves the first and where it reaches the second.
      const edge = (inside, outside, shape, center) => {
        for (let halving = 0; halving < 20; halving += 1) {
          const t = (inside + outside) / 2;
          if (covers(shape, center, curvePoint(whole, t))) inside = t;
          else outside = t;
        }
        return outside;
      };
      const t0 = edge(0, 0.5, shapes.get(link.from), from);
      const t1 = edge(1, 0.5, shapes.get(link.to), to);
      const p0 = curvePoint(whole, t0);
      const p1 = curvePoint(whole, t1);
      // The curve leaves `p0` the way the whole curve passes it.
      const leaving = along(
        [whole.c[0] - whole.p0[0], whole.c[1] - whole.p0[1]],
        [whole.p1[0] - whole.c[0], whole.p1[1] - whole.c[1]],
        t0,
      );
      const curve = {
        p0,
        c: /** @type {Point} */ ([p0[0] + leaving[0] * (t1 - t0), p0[1] + leaving[1] * (t1 - t0)]),
        p1,
      };
      let measured = 0;
      for (let step = 1; step <= 16; step += 1) {
        const [ax, ay] = curvePoint(curve, (step - 1) / 16);
        const [bx, by] = curvePoint(curve, step / 16);
        measured += Math.hypot(bx - ax, by - ay);
      }
      return [link.id, { curve, length: measured }];
    }),
  );
  return { size, places, links };
}

/**
 * The engine that plays the tracks of a step on a timeline of anime.js.
 * @param {{ createTimeline: (options: object) => any }} anime
 * @returns {Motion}
 */
export function createMotion({ createTimeline }) {
  return {
    play(tracks, done) {
      const timeline = createTimeline({ autoplay: false, defaults: { ease: 'inOutQuad' }, onComplete: done });
      for (const track of tracks) {
        const progress = { value: 0 };
        timeline.add(
          progress,
          { value: 1, duration: track.duration, onUpdate: () => track.frame(progress.value) },
          track.start,
        );
      }
      timeline.play();
      return {
        pause: () => timeline.pause(),
        resume: () => timeline.resume(),
        cancel: () => timeline.cancel(),
      };
    },
  };
}

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {(text: string) => Scene} options.parseScene
 * @param {(scene: Scene) => { start: SceneState, steps: SceneState[][] }} options.sceneStates
 * @param {(scene: Scene, state: SceneState, id: string) => boolean} options.sceneVisible
 * @param {Motion} options.motion
 * @param {() => boolean} [options.reducedMotion] Whether the reader asked for less motion: a step then shows its
 *   result at once.
 * @param {(work: () => void, delay: number) => any} [options.later]
 */
export function createScenes({
  document,
  parseScene,
  sceneStates,
  sceneVisible,
  motion,
  reducedMotion = () => false,
  later = (work, delay) => setTimeout(work, delay),
}) {
  const html = (tag, className, text) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };
  /** @param {string} tag @param {Record<string, string | number>} [attributes] @param {Element[]} children */
  const svg = (tag, attributes = {}, ...children) => {
    const created = /** @type {SVGElement} */ (document.createElementNS(SVG, tag));
    for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, String(value));
    created.append(...children);
    return created;
  };
  const round = (number) => Math.round(number * 10) / 10;
  const curvePath = ({ p0, c, p1 }) =>
    `M ${round(p0[0])} ${round(p0[1])} Q ${round(c[0])} ${round(c[1])} ${round(p1[0])} ${round(p1[1])}`;
  const headPath = (curve, t) => {
    const [x, y] = curvePoint(curve, t);
    const [dx, dy] = curveDirection(curve, t).map((part) => part * (t ? 1 : -1));
    const back = [x - dx * HEAD, y - dy * HEAD];
    const wing = [-dy * HEAD * 0.5, dx * HEAD * 0.5];
    return `M ${round(x)} ${round(y)} L ${round(back[0] + wing[0])} ${round(back[1] + wing[1])} L ${round(back[0] - wing[0])} ${round(back[1] - wing[1])} Z`;
  };

  function outline(shape) {
    const [width, height] = SHAPES[shape].size;
    const [w, h] = [width / 2, height / 2];
    if (shape === 'box' || shape === 'pill')
      return [svg('rect', { x: -w, y: -h, width, height, rx: shape === 'box' ? 10 : h, class: 'scene-shape' })];
    if (shape === 'circle') return [svg('circle', { r: w, class: 'scene-shape' })];
    if (shape === 'token') return [svg('circle', { r: 9, class: 'scene-shape' })];
    if (shape === 'diamond')
      return [svg('path', { d: `M 0 ${-h} L ${w} 0 L 0 ${h} L ${-w} 0 Z`, class: 'scene-shape' })];
    if (shape === 'disk') {
      const rim = 9;
      return [
        svg('path', {
          d: `M ${-w} ${rim - h} A ${w} ${rim} 0 0 1 ${w} ${rim - h} V ${h - rim} A ${w} ${rim} 0 0 1 ${-w} ${h - rim} Z`,
          class: 'scene-shape',
        }),
        svg('path', { d: `M ${-w} ${rim - h} A ${w} ${rim} 0 0 0 ${w} ${rim - h}`, class: 'scene-shape scene-rim' }),
      ];
    }
    if (shape === 'person')
      return [
        svg('circle', { cy: -26, r: 11, class: 'scene-shape' }),
        svg('path', { d: 'M -21 14 Q -21 -9 0 -9 Q 21 -9 21 14 Z', class: 'scene-shape' }),
      ];
    return [];
  }

  // The label of a node or of a token: lines of text around a point of the shape.
  function labelOf(shape) {
    const { chars, lines, labelY = 0, labelFrom } = SHAPES[shape];
    const text = svg('text', {
      class: 'scene-label',
      'text-anchor': 'middle',
      'font-size': shape === 'token' ? SMALL_TEXT : TEXT,
    });
    let written = null;
    return {
      text,
      write(label) {
        if (label === written) return;
        written = label;
        const wrapped = wrap(label, chars, lines);
        text.replaceChildren(
          ...wrapped.map((line, index) => {
            const y = labelY + (labelFrom === 'top' ? index : index - (wrapped.length - 1) / 2) * LINE;
            const span = svg('tspan', { x: 0, y: round(y) });
            span.textContent = line;
            return span;
          }),
        );
      },
    };
  }

  /** The renderer of `scene` blocks. */
  function render(figure, block) {
    const scene = parseScene(block.text);
    const states = sceneStates(scene);
    const layout = sceneLayout(scene);
    const count = scene.steps.length;
    const stateAt = (position) => (position === 0 ? states.start : states.steps[position - 1].at(-1));
    const placeOf = (/** @type {SceneState} */ state, id) => {
      const { at } = state.parts.get(id);
      if (typeof at !== 'string') return cellPoint(at);
      // A token on a node stands at the node's upper right corner, where it hides no label.
      const [x, y] = layout.places.get(at);
      const [width, height] = SHAPES[scene.nodes.find((node) => node.id === at).shape].size;
      return /** @type {Point} */ ([x + width / 2 - 8, y - height / 2 + 4]);
    };

    /**
     * What is drawn for each part and how it changes.
     * @type {Map<string, {
     *   group: SVGElement, write: (state: SceneState) => void, rest: () => void, fade: (shown: number) => void,
     *   pulse: (strength: number) => void, relabel: (label: string, progress: number) => void,
     *   place?: (point: Point) => void, yield?: (amount: number) => void,
     * }>}
     */
    const parts = new Map();
    const linkLayer = svg('g', { class: 'scene-links' });
    const nodeLayer = svg('g', { class: 'scene-nodes' });
    const tokenLayer = svg('g', { class: 'scene-tokens' });

    for (const link of scene.links) {
      const { curve, length } = layout.links.get(link.id);
      const line = svg('path', { d: curvePath(curve), class: 'scene-link-line', fill: 'none' });
      const heads = [
        ...(link.arrow === 'none' ? [] : [svg('path', { d: headPath(curve, 1), class: 'scene-link-head' })]),
        ...(link.arrow === 'both' ? [svg('path', { d: headPath(curve, 0), class: 'scene-link-head' })] : []),
      ];
      const [x, y] = curvePoint(curve, 0.5);
      const label = svg('text', {
        class: 'scene-link-label',
        'text-anchor': 'middle',
        'font-size': SMALL_TEXT,
        x: round(x),
        y: round(y - 11),
      });
      const group = svg('g', { class: `scene-link${link.dashed ? ' dashed' : ''}` }, line, ...heads, label);
      group.dataset.part = link.id;
      linkLayer.append(group);
      parts.set(link.id, {
        group,
        write(state) {
          label.textContent = state.parts.get(link.id).label;
        },
        rest() {
          for (const drawn of [line, label, ...heads]) drawn.removeAttribute('style');
        },
        // A link is drawn from its first node to its second; a dashed one, whose dashes are its pattern, fades in.
        fade(shown) {
          if (link.dashed) line.style.opacity = String(shown);
          else line.style.strokeDasharray = `${round(length * shown)} ${Math.ceil(length) + 1}`;
          for (const head of heads) head.style.opacity = String(shown < 0.8 ? 0 : (shown - 0.8) * 5);
          label.style.opacity = String(shown);
        },
        pulse(strength) {
          line.style.strokeWidth = String(round(1.6 + 2.4 * strength));
        },
        relabel(text, progress) {
          if (progress >= 0.5) label.textContent = text;
          label.style.opacity = String(Math.abs(progress * 2 - 1));
        },
        yield(amount) {
          label.style.opacity = String(round(1 - amount));
        },
      });
    }

    for (const node of scene.nodes) {
      const label = labelOf(node.shape);
      const body = svg('g', { class: 'scene-body' }, ...outline(node.shape), label.text);
      const group = svg('g', { class: `scene-node shape-${node.shape}` }, body);
      group.dataset.part = node.id;
      const place = ([x, y]) => group.setAttribute('transform', `translate(${round(x)} ${round(y)})`);
      (node.shape === 'token' ? tokenLayer : nodeLayer).append(group);
      parts.set(node.id, {
        group,
        place,
        write(state) {
          label.write(state.parts.get(node.id).label);
          place(placeOf(state, node.id));
        },
        rest() {
          body.removeAttribute('style');
          label.text.removeAttribute('style');
        },
        fade(shown) {
          body.style.opacity = String(shown);
          body.style.transform = `scale(${0.86 + 0.14 * shown})`;
        },
        pulse(strength) {
          body.style.transform = `scale(${1 + 0.16 * strength})`;
        },
        relabel(text, progress) {
          if (progress >= 0.5) label.write(text);
          label.text.style.opacity = String(Math.abs(progress * 2 - 1));
        },
      });
    }

    const picture = svg(
      'svg',
      {
        class: 'scene-picture',
        viewBox: `0 0 ${layout.size[0]} ${layout.size[1]}`,
        width: layout.size[0],
        height: layout.size[1],
        role: 'img',
      },
      linkLayer,
      nodeLayer,
      tokenLayer,
    );
    picture.setAttribute('aria-label', scene.title || 'Animated explainer');
    const width = layout.size[0] / PAGE_TEXT;
    picture.style.width = `${round(width)}em`;
    picture.style.minWidth = `${round(Math.min(width, Math.max(LEAST_WIDTH, width * LEAST_SCALE)))}em`;

    /** Draws a state as it is, without a motion. */
    function show(/** @type {SceneState} */ state) {
      for (const message of tokenLayer.querySelectorAll('.scene-message')) message.remove();
      for (const [id, part] of parts) {
        part.group.classList.toggle('hidden', !sceneVisible(scene, state, id));
        part.group.classList.toggle('lit', state.lit.has(id));
        part.group.classList.toggle('dimmed', state.focus !== null && !state.focus.has(id));
        part.group.dataset.tone = state.parts.get(id).tone;
        part.rest();
        part.write(state);
      }
    }

    const ids = [...parts.keys()];
    // How each verb moves the picture from the state before its action to the state after it. The format has
    // checked the action; a verb without a motion here still ends in its state.
    /** @type {Record<string, (action: SceneAction, before: SceneState, after: SceneState) => (progress: number) => void>} */
    const motions = {
      show(action, before, after) {
        const appearing = ids.filter((id) => !sceneVisible(scene, before, id) && sceneVisible(scene, after, id));
        return (progress) => {
          for (const id of appearing) {
            parts.get(id).fade(progress);
            parts.get(id).group.classList.remove('hidden');
          }
        };
      },
      hide(action, before, after) {
        const leaving = ids.filter((id) => sceneVisible(scene, before, id) && !sceneVisible(scene, after, id));
        return (progress) => {
          for (const id of leaving) {
            parts.get(id).fade(1 - progress);
            parts.get(id).group.classList.toggle('hidden', progress === 1);
          }
        };
      },
      highlight: (action) => () => {
        for (const id of action.ids) parts.get(id).group.classList.add('lit');
      },
      focus: (action, before, after) => () => {
        for (const id of ids) parts.get(id).group.classList.toggle('dimmed', !after.focus.has(id));
      },
      pulse: (action) => (progress) => {
        for (const id of action.ids) parts.get(id).pulse(Math.sin(Math.PI * progress));
      },
      send(action) {
        const { curve } = layout.links.get(action.id);
        const label = svg('text', { class: 'scene-label', 'text-anchor': 'middle', 'font-size': SMALL_TEXT, y: -14 });
        label.textContent = action.label;
        const message = svg(
          'g',
          { class: 'scene-node shape-token scene-message' },
          svg('circle', { r: 7, class: 'scene-shape' }),
          label,
        );
        message.dataset.tone = action.tone;
        return (progress) => {
          if (!message.isConnected) tokenLayer.append(message);
          const [x, y] = curvePoint(curve, action.back ? 1 - progress : progress);
          message.setAttribute('transform', `translate(${round(x)} ${round(y)})`);
          const shown = Math.min(1, progress * 8, (1 - progress) * 8);
          message.style.opacity = String(shown);
          // The label of a message travels where the label of its link stands, so the link gives way to it.
          if (action.label) parts.get(action.id).yield(shown);
        };
      },
      move(action, before, after) {
        const from = placeOf(before, action.id);
        const to = placeOf(after, action.id);
        return (progress) => parts.get(action.id).place(along(from, to, progress));
      },
      set(action, before, after) {
        const part = parts.get(action.id);
        const { label, tone } = after.parts.get(action.id);
        return (progress) => {
          part.group.dataset.tone = tone;
          if (label !== before.parts.get(action.id).label) part.relabel(label, progress);
        };
      },
    };

    const title = scene.title ? [html('figcaption', 'scene-title', scene.title)] : [];
    const stage = html('div', 'scene-stage');
    stage.append(picture);
    const button = (className, text, label) => {
      const created = /** @type {HTMLButtonElement} */ (html('button', className, text));
      created.type = 'button';
      if (label) created.setAttribute('aria-label', label);
      return created;
    };
    const back = button('scene-back', '‹', 'Previous step');
    const play = button('scene-play', 'Play');
    const next = button('scene-next', '›', 'Next step');
    const progress = html('span', 'scene-progress');
    progress.setAttribute('aria-live', 'polite');
    const controls = html('div', 'scene-controls');
    controls.append(back, play, next, progress);
    const list = html('ol', 'scene-steps');
    const items = scene.steps.map((step, index) => {
      const item = html('li', 'scene-step');
      item.append(
        button('scene-jump', String(index + 1), `Play step ${index + 1}`),
        html('span', 'scene-caption', step.caption),
      );
      list.append(item);
      return item;
    });

    // The steps that have played; the step that plays now, if one does; and whether the next one follows by itself.
    let position = 0;
    /** @type {{ step: number, playing: Playing, paused: boolean } | null} */
    let running = null;
    let auto = false;
    let waiting = null;

    function refresh() {
      const current = running ? running.step : position - 1;
      items.forEach((item, index) => {
        item.classList.toggle('current', index === current);
        item.classList.toggle('played', index < position);
        if (index === current) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
      });
      const moving = auto && !running?.paused;
      play.textContent = moving ? 'Pause' : position === count && !running ? 'Replay' : 'Play';
      figure.classList.toggle('playing', moving);
      back.disabled = position === 0 && !running;
      next.disabled = position === count;
      progress.textContent =
        current < 0 ? `${count} ${count === 1 ? 'step' : 'steps'}` : `Step ${current + 1} of ${count}`;
      // The caption of the step that plays stays in sight in a list that is longer than its box.
      const item = items[current];
      if (item && list.scrollHeight > list.clientHeight) {
        const top = item.offsetTop - list.offsetTop;
        if (top < list.scrollTop || top + item.offsetHeight > list.scrollTop + list.clientHeight)
          list.scrollTop = top - list.clientHeight / 3;
      }
    }

    /** Stops what plays and shows the scene after `steps` steps. */
    function settle(steps) {
      running?.playing.cancel();
      running = null;
      waiting = null;
      position = steps;
      show(stateAt(position));
      refresh();
    }

    function finished(step) {
      running = null;
      position = step + 1;
      show(stateAt(position));
      if (auto && position < count && figure.isConnected) {
        const mine = {};
        waiting = mine;
        // Time to read the caption before the next step starts.
        later(
          () => waiting === mine && auto && run(position),
          Math.min(5000, 900 + 40 * scene.steps[step].caption.length),
        );
      } else auto = false;
      refresh();
    }

    /** Plays one step from the state before it. */
    function run(step) {
      waiting = null;
      const moments = states.steps[step];
      show(moments[0]);
      let cursor = 0;
      let lastStart = 0;
      const tracks = scene.steps[step].actions.map((action, index) => {
        const start = action.together ? lastStart : cursor;
        const duration = DURATIONS[action.verb];
        lastStart = start;
        cursor = Math.max(cursor, start + duration + BREATH);
        const frame = Object.hasOwn(motions, action.verb)
          ? motions[action.verb](action, moments[index], moments[index + 1])
          : () => {};
        return { start, duration, frame };
      });
      if (!tracks.length || reducedMotion()) {
        finished(step);
        return;
      }
      running = { step, paused: false, playing: motion.play(tracks, () => running?.step === step && finished(step)) };
      refresh();
    }

    play.addEventListener('click', () => {
      if (auto && !running?.paused) {
        auto = false;
        waiting = null;
        if (running) {
          running.playing.pause();
          running.paused = true;
        }
      } else {
        auto = true;
        if (running?.paused) {
          running.paused = false;
          running.playing.resume();
        } else if (!running) {
          if (position === count) settle(0);
          run(position);
          return;
        }
      }
      refresh();
    });
    next.addEventListener('click', () => {
      auto = false;
      // A step that plays is brought to its end.
      if (running) settle(running.step + 1);
      else if (position < count) run(position);
    });
    back.addEventListener('click', () => {
      auto = false;
      settle(running ? running.step : Math.max(0, position - 1));
    });
    items.forEach((item, index) =>
      item.querySelector('.scene-jump').addEventListener('click', () => {
        auto = false;
        settle(index);
        run(index);
      }),
    );

    figure.replaceChildren(...title, stage, controls, list);
    show(states.start);
    refresh();
  }

  return { render };
}
