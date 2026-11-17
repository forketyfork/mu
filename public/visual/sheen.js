// The frame's part of showing what the author works on: a soft light that moves over the text, the block, the
// section or the whole visual that a comment is about, for as long as the dashboard names it. The light is drawn in
// a layer of its own over the document, so no element of a section changes, like the marks of comments. The
// dashboard decides what is worked on; this page only draws it.

// How far the light reaches beyond the text of a quote, in pixels of the layout.
const TEXT_MARGIN = 2;

/**
 * Where a target is in the document as it is drawn now: the element or the range, and what it is. Null when the
 * content that the comment was written on is not on the page.
 * @param {Document} document
 * @param {HTMLElement} container The element that holds the sections.
 * @param {{ sectionId: string | null, sectionRev?: string, block?: number | null, quote?: object | null }} target
 * @param {(block: Element, quote: any) => Range | null} locate Finds a quote in a block, as for the marks.
 * @returns {{ kind: 'whole' | 'section' | 'block' | 'text', place: Element | Range } | null}
 */
export function placeOf(document, container, target, locate) {
  if (target.sectionId === null) return { kind: 'whole', place: container };
  const section = document.getElementById(`section-${target.sectionId}`);
  // A comment belongs to the content it was made on, as for its mark.
  if (!section || section.parentElement !== container || section.dataset.rev !== target.sectionRev) return null;
  if (target.block === null || target.block === undefined) return { kind: 'section', place: section };
  const block = [...section.children].find(
    (child) => /** @type {HTMLElement} */ (child).dataset.block === String(target.block),
  );
  if (!block) return null;
  const range = target.quote ? locate(block, target.quote) : null;
  return range ? { kind: 'text', place: range } : { kind: 'block', place: block };
}

/**
 * The box of the whole document. A section reaches beyond the element that holds the sections, so that its
 * background has room around the text; the light on the whole visual is as wide as the lights on its sections.
 * @param {HTMLElement} container
 */
function wholeBox(container) {
  const boxes = [container, ...container.children]
    .map((element) => element.getBoundingClientRect())
    .filter((box) => box.width && box.height);
  if (!boxes.length) return { left: 0, top: 0, width: 0, height: 0 };
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  return {
    left,
    top,
    width: Math.max(...boxes.map((box) => box.left + box.width)) - left,
    height: Math.max(...boxes.map((box) => box.top + box.height)) - top,
  };
}

/**
 * The lines of a quote as one clip path, in the coordinates of the box around them.
 * @param {{ left: number, top: number, width: number, height: number }[]} rects
 * @param {{ left: number, top: number }} box
 */
export function linesPath(rects, box) {
  const number = (value) => String(Math.round(value * 10) / 10);
  return rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map(
      (rect) =>
        `M${number(rect.left - box.left - TEXT_MARGIN)} ${number(rect.top - box.top - TEXT_MARGIN)}h${number(rect.width + 2 * TEXT_MARGIN)}v${number(rect.height + 2 * TEXT_MARGIN)}h${number(-rect.width - 2 * TEXT_MARGIN)}Z`,
    )
    .join('');
}

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {Window & typeof globalThis} options.window
 * @param {HTMLElement} options.container The element that holds the sections.
 * @param {(block: Element, quote: any) => Range | null} options.locate
 */
export function createSheen({ document, window, container, locate }) {
  const layer = document.createElement('div');
  layer.className = 'working-layer';
  layer.setAttribute('aria-hidden', 'true');
  container.after(layer);
  /** @type {{ id: string, sectionId: string | null, sectionRev?: string, block?: number | null, quote?: object | null }[]} */
  let targets = [];
  /** @type {Map<string, HTMLElement>} The light of each target; it keeps moving while its place is measured anew. */
  const drawn = new Map();

  /** Puts a light on every target that is on the page, and takes away the others. */
  function apply() {
    const origin = layer.getBoundingClientRect();
    const kept = new Set();
    for (const target of targets) {
      const found = placeOf(document, container, target, locate);
      if (!found) continue;
      const box = found.kind === 'whole' ? wholeBox(container) : found.place.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const margin = found.kind === 'text' ? TEXT_MARGIN : 0;
      let light = drawn.get(target.id);
      if (!light) {
        light = document.createElement('div');
        light.dataset.comment = target.id;
        layer.append(light);
        drawn.set(target.id, light);
      }
      kept.add(target.id);
      light.className = `working-sheen ${found.kind}`;
      light.style.left = `${box.left - origin.left - margin}px`;
      light.style.top = `${box.top - origin.top - margin}px`;
      light.style.width = `${box.width + 2 * margin}px`;
      light.style.height = `${box.height + 2 * margin}px`;
      light.style.clipPath =
        found.kind === 'text'
          ? `path("${linesPath([.../** @type {Range} */ (found.place).getClientRects()], {
              left: box.left - margin,
              top: box.top - margin,
            })}")`
          : '';
    }
    for (const [id, light] of drawn)
      if (!kept.has(id)) {
        light.remove();
        drawn.delete(id);
      }
  }

  // A diagram that is drawn, code that is highlighted, a new width or text size: all move what the light is on.
  let pending = false;
  const schedule = () => {
    if (pending || !targets.length) return;
    pending = true;
    window.requestAnimationFrame(() => {
      pending = false;
      apply();
    });
  };
  new window.MutationObserver(schedule).observe(container, { childList: true, subtree: true, characterData: true });
  new window.ResizeObserver(schedule).observe(container);
  window.addEventListener('resize', schedule);

  return {
    /**
     * Sets what the author works on. A target is what a comment is about: the whole visual for a null `sectionId`,
     * else a section, one of its blocks, or quoted text in a block.
     */
    set(next) {
      targets = Array.isArray(next)
        ? next.filter((target) => typeof target?.id === 'string' && (target.sectionId === null || target.sectionRev))
        : [];
      apply();
    },
    apply,
  };
}
