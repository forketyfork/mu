// Where a comment points inside a block: the quoted text, with a little of what stands before and after it. The frame
// makes a quote from the reader's selection and finds a quote again in a block that was drawn anew. Both read the
// text of a block the same way, as its text nodes in order, so a quote taken from a block is found in it.

const HIGH_SURROGATE = /[\uD800-\uDBFF]$/;
const LOW_SURROGATE = /^[\uDC00-\uDFFF]/;

/**
 * The text of an element and where each of its text nodes starts in it. The style sheet inside a drawn diagram is
 * text of the document, but not text that a reader sees.
 * @param {Element} root
 */
export function textIndex(root) {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const nodes = [];
  let text = '';
  for (
    let node = /** @type {Text | null} */ (walker.nextNode());
    node;
    node = /** @type {Text} */ (walker.nextNode())
  ) {
    if (node.parentElement?.closest('style, script')) continue;
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  return { text, nodes };
}

/**
 * The part of a block that a range covers, as a quote; null when the range holds no text of the block.
 * @param {Element} block
 * @param {Range} range
 * @param {{ quoteChars: number, contextChars: number }} limits
 */
export function quoteOf(block, range, limits) {
  const { text, nodes } = textIndex(block);
  let start = null;
  let end = null;
  for (const { node, start: at } of nodes) {
    if (!range.intersectsNode(node)) continue;
    start ??= at + (node === range.startContainer ? range.startOffset : 0);
    end = at + (node === range.endContainer ? range.endOffset : node.length);
  }
  if (start === null) return null;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (start === end) return null;
  const quoted = [...text.slice(start, end)].slice(0, limits.quoteChars).join('');
  return {
    text: quoted,
    prefix: text.slice(Math.max(0, start - limits.contextChars), start).replace(LOW_SURROGATE, ''),
    suffix: text.slice(start + quoted.length, start + quoted.length + limits.contextChars).replace(HIGH_SURROGATE, ''),
  };
}

/**
 * The range of a quote in a block: the occurrence of its text whose surroundings fit best. Null when the block does
 * not hold the text.
 * @param {Element} block
 * @param {{ text: string, prefix: string, suffix: string }} quote
 */
export function locate(block, quote) {
  const { text, nodes } = textIndex(block);
  let best = null;
  for (let at = text.indexOf(quote.text); at !== -1; at = text.indexOf(quote.text, at + 1)) {
    const score =
      Number(text.slice(0, at).endsWith(quote.prefix)) +
      Number(text.slice(at + quote.text.length).startsWith(quote.suffix));
    if (!best || score > best.score) best = { at, score };
    if (score === 2) break;
  }
  if (!best) return null;
  const point = (offset, last) => {
    // The end of a quote belongs to the node that holds its last character, not to the node after it.
    const found = nodes.findLast(({ start }) => (last ? start < offset : start <= offset));
    return /** @type {[Text, number]} */ ([found.node, offset - found.start]);
  };
  const range = block.ownerDocument.createRange();
  range.setStart(...point(best.at, false));
  range.setEnd(...point(best.at + quote.text.length, true));
  return range;
}

/**
 * The row of a patch block that a comment on a line names, or null. The values are compared with the attributes that
 * the patch renderer set; no selector is built from them.
 * @param {Element} block
 * @param {{ path: string, side: 'old' | 'new', number: number }} line
 * @returns {HTMLElement | null}
 */
export function lineRow(block, line) {
  const rows = /** @type {NodeListOf<HTMLElement>} */ (block.querySelectorAll('.patch-line'));
  return (
    [...rows].find((row) => row.dataset.path === line.path && row.dataset[line.side] === String(line.number)) ?? null
  );
}
