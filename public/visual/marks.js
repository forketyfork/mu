// The frame's part of commenting: it tells the dashboard what the reader selected, and marks the text that comments
// are about. The comment field, the list of comments and the buttons that send them are the dashboard's. Marks are
// CSS highlights, ranges painted without a change of the document, so drawing a section anew stays the only thing
// that changes its elements.
import { lineRow, locate, quoteOf } from '/visual/anchor.js';

const STATES = ['answered', 'sent', 'draft', 'active'];
const MARKED = 'commented';
const ACTIVE = 'comment-active';

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {Window & typeof globalThis} options.window
 * @param {HTMLElement} options.container The element that holds the sections.
 * @param {{ quoteChars: number, contextChars: number }} options.limits
 * @param {(message: object) => void} options.tell
 */
export function createMarks({ document, window, container, limits, tell }) {
  // Listed from the weakest: where two marks overlap, the later one is painted.
  const highlights = Object.fromEntries(
    STATES.map((state, priority) => {
      const highlight = new window.Highlight();
      highlight.priority = priority;
      window.CSS.highlights.set(`comment-${state}`, highlight);
      return [state, highlight];
    }),
  );
  /** @type {{ id: string, sectionId: string, sectionRev: string, block: number | null, quote: object | null, line?: object | null, state: string }[]} */
  let comments = [];
  let active = null;
  /** @type {Map<string, Range | Element>} */
  let placed = new Map();

  const blockOf = (section, node) =>
    /** @type {HTMLElement | undefined} */ (
      [...section.children].find(
        (child) => child instanceof window.HTMLElement && child.dataset.block && child.contains(node),
      )
    );

  /** Marks what the comments are about in the document as it is drawn now. */
  function apply() {
    for (const highlight of Object.values(highlights)) highlight.clear();
    for (const element of container.querySelectorAll(`.${MARKED}`)) element.classList.remove(MARKED, ACTIVE);
    placed = new Map();
    for (const comment of comments) {
      const section = document.getElementById(`section-${comment.sectionId}`);
      // A comment belongs to the content it was made on; a section drawn from other content is not marked.
      if (!section || section.dataset.rev !== comment.sectionRev) continue;
      const block =
        comment.block === null
          ? null
          : [...section.children].find(
              (child) => /** @type {HTMLElement} */ (child).dataset.block === String(comment.block),
            );
      const range = block && comment.quote ? locate(block, comment.quote) : null;
      const row = block && comment.line ? lineRow(block, /** @type {any} */ (comment.line)) : null;
      if (range) {
        highlights[comment.id === active ? 'active' : comment.state].add(range);
        placed.set(comment.id, range);
      } else {
        const element = row ?? block ?? section;
        element.classList.add(MARKED);
        if (comment.id === active) element.classList.add(ACTIVE);
        placed.set(comment.id, element);
      }
    }
  }

  // What the reader selected, as the target of a comment, and where its end is on the screen.
  function selected() {
    const selection = document.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const start =
      range.startContainer instanceof window.Element ? range.startContainer : range.startContainer.parentElement;
    const section = /** @type {HTMLElement | null} */ (start?.closest('.visual-section'));
    if (!section || section.parentElement !== container) return null;
    const rects = range.getClientRects();
    const { left, top, right, bottom } = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    const target = { sectionId: section.dataset.section, sectionRev: section.dataset.rev };
    const block = blockOf(section, start);
    // A selection that starts in the heading is about the section.
    if (!block) return { target: { ...target, block: null, quote: null }, rect: { left, top, right, bottom } };
    const quote = quoteOf(block, range, limits);
    if (!quote) return null;
    return { target: { ...target, block: Number(block.dataset.block), quote }, rect: { left, top, right, bottom } };
  }

  let told = null;
  function report() {
    const now = selected();
    const signature = JSON.stringify(now);
    if (signature === told) return;
    told = signature;
    tell({ type: 'selection', ...(now ?? { target: null }) });
  }
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      report();
    });
  };
  document.addEventListener('selectionchange', schedule);
  // The place of the selection on the screen changes with a scroll.
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  // A click on a line or a diagram offers a comment that no selection stands behind, so the next click elsewhere has
  // to end the offer. The event whose handler made the offer is kept, because the click on the line also reaches
  // the document.
  let clickOffer = false;
  let offeredBy = null;
  const endOffer = () => {
    if (!clickOffer) return;
    clickOffer = false;
    told = null;
    report();
  };
  document.addEventListener('click', (event) => {
    if (event !== offeredBy) endOffer();
  });
  // The dashboard puts the button where the offer was made and is not told when the place moves, so a scroll or a new
  // size of the frame ends the offer, as a click elsewhere does.
  window.addEventListener('scroll', endOffer, { passive: true });
  window.addEventListener('resize', endOffer);

  // A click on marked text names its comment; a click on a diagram or another drawn block offers a comment on it.
  container.addEventListener('click', (event) => {
    // A line number of a patch offers a comment on its line; with the keyboard, the click has no place on the screen.
    const gutter = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest?.('.patch-gutter'));
    if (gutter) {
      lineChosen(gutter);
      offeredBy = event;
      return;
    }
    if (!document.getSelection().isCollapsed) return;
    const inside = (rect) =>
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    for (const [id, place] of placed)
      if (place instanceof window.Range && [...place.getClientRects()].some(inside)) {
        tell({ type: 'comment', id });
        return;
      }
    const figure = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest('.visual-rich'));
    const section = /** @type {HTMLElement | null} */ (figure?.closest('.visual-section'));
    // A click on a link, also on the link of a diagram, is about the link, and one on a control of a form answers
    // a question.
    if (!figure || !section || /** @type {Element} */ (event.target).closest('a, label, input, textarea, button'))
      return;
    const { left, top, right } = figure.getBoundingClientRect();
    tell({
      type: 'selection',
      target: {
        sectionId: section.dataset.section,
        sectionRev: section.dataset.rev,
        block: Number(figure.dataset.block),
        quote: null,
      },
      rect: { left, top, right, bottom: top },
    });
    // The click ended whatever was selected; that end is not news after this.
    told = JSON.stringify(null);
    clickOffer = true;
    offeredBy = event;
  });

  function lineChosen(gutter) {
    const row = /** @type {HTMLElement | null} */ (gutter.closest('.patch-line'));
    const figure = /** @type {HTMLElement | null} */ (gutter.closest('.visual-patch'));
    const section = /** @type {HTMLElement | null} */ (figure?.closest('.visual-section'));
    if (!row || !figure || !section || section.parentElement !== container) return;
    // The button of the offer goes under the line, at its code: the hand is on the number, and the numbers of the
    // lines below stay free to press. A patch that is scrolled sideways shows the code from the edge of its box.
    const { top, bottom } = row.getBoundingClientRect();
    const view = /** @type {HTMLElement} */ (gutter.closest('.patch-scroll')).getBoundingClientRect();
    const code = /** @type {HTMLElement} */ (row.querySelector('.patch-code')).getBoundingClientRect();
    const left = Math.min(Math.max(code.left, view.left), view.right);
    tell({
      type: 'selection',
      target: {
        sectionId: section.dataset.section,
        sectionRev: section.dataset.rev,
        block: Number(figure.dataset.block),
        quote: null,
        line: { path: row.dataset.path, side: gutter.dataset.side, number: Number(gutter.dataset.number) },
      },
      rect: { left, top, right: left, bottom },
    });
    told = JSON.stringify(null);
    clickOffer = true;
  }

  // Code that is highlighted and a diagram that is drawn replace the text nodes that a mark stands on.
  let pending = false;
  new window.MutationObserver(() => {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(() => {
      pending = false;
      apply();
    });
  }).observe(container, { childList: true, subtree: true, characterData: true });

  return {
    /** Sets the comments to mark, and the one that the reader looks at. */
    set(next, activeId) {
      comments = next;
      active = activeId;
      apply();
    },
    /** Brings what a comment is about into view. */
    reveal(id) {
      const place = placed.get(id);
      if (!place) return;
      const element = place instanceof window.Range ? place.startContainer.parentElement : place;
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    apply,
  };
}
