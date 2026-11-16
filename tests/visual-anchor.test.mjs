import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { locate, quoteOf, textIndex } from '../public/visual/anchor.js';

const LIMITS = { quoteChars: 600, contextChars: 32 };
const blockOf = (html) => {
  const { window } = new JSDOM(`<div id="block">${html}</div>`);
  const block = window.document.getElementById('block');
  // A range from the `from`-th character of one text node to the `to`-th of another.
  const range = ([startNode, from], [endNode, to]) => {
    const texts = textIndex(block).nodes.map(({ node }) => node);
    const made = window.document.createRange();
    made.setStart(texts[startNode], from);
    made.setEnd(texts[endNode], to);
    return made;
  };
  return { block, range, window };
};

test('the text of a block is what a reader sees, in order, without the style sheet of a diagram', () => {
  const { block } = blockOf('<p>One <b>two</b></p><svg><style>.a{fill:red}</style><text>three</text></svg>');
  const { text, nodes } = textIndex(block);
  assert.equal(text, 'One twothree');
  assert.deepEqual(
    nodes.map(({ node, start }) => [node.data, start]),
    [
      ['One ', 0],
      ['two', 4],
      ['three', 7],
    ],
  );
});

test('a selection becomes a quote with a little of the text around it', () => {
  const { block, range } = blockOf('<p>The <code>rev</code> of a section is a <em>hash</em> of its content.</p>');
  // From inside one element to inside another, with white space at both ends.
  assert.deepEqual(quoteOf(block, range([0, 3], [3, 2]), LIMITS), {
    text: 'rev of a section is a ha',
    prefix: 'The ',
    suffix: 'sh of its content.',
  });
  assert.deepEqual(quoteOf(block, range([2, 0], [2, 6]), LIMITS), {
    text: 'of a',
    prefix: 'The rev ',
    suffix: ' section is a hash of its conten',
  });
  assert.equal(quoteOf(block, range([0, 3], [0, 4]), LIMITS), null, 'white space alone is no quote');
  // A long selection is cut to the limit, and the text after the cut is its suffix.
  const long = blockOf(`<p>${'word '.repeat(300)}</p>`);
  const quote = quoteOf(long.block, long.range([0, 0], [0, 1500]), { quoteChars: 20, contextChars: 8 });
  assert.deepEqual(quote, { text: 'word word word word ', prefix: '', suffix: 'word wor' });
});

test('a quote never cuts a character in two', () => {
  const { block, range } = blockOf('<p>a😀b😀c😀d</p>');
  const quote = quoteOf(block, range([0, 3], [0, 9]), { quoteChars: 2, contextChars: 2 });
  assert.deepEqual(quote, { text: 'b😀', prefix: '😀', suffix: 'c' });
  for (const part of Object.values(quote)) assert.equal(part.isWellFormed(), true, part);
});

test('a quote is found again in a block that was drawn anew, by its surroundings', () => {
  const html = '<p>Run <code>init</code> first, then run <code>init</code> again, and <b>init</b> once more.</p>';
  const { block, range } = blockOf(html);
  const second = quoteOf(block, range([3, 0], [3, 4]), LIMITS);
  assert.deepEqual(second, {
    text: 'init',
    prefix: 'Run init first, then run ',
    suffix: ' again, and init once more.',
  });

  // The same content, drawn with other elements, as after the highlighter ran.
  const redrawn = blockOf(
    '<p>Run <span>in</span><span>it</span> first, then run <code>in<i>i</i>t</code> again, and init once more.</p>',
  );
  const found = locate(redrawn.block, second);
  assert.equal(found.toString(), 'init');
  assert.equal(found.startContainer.parentElement.localName, 'code');
  assert.equal(found.endContainer.textContent, 't', 'the end is in the node of the last character');
  assert.equal(found.endOffset, 1);

  // Without surroundings that fit, the first occurrence is taken; text that is not there is not found.
  assert.equal(locate(redrawn.block, { text: 'init', prefix: 'x', suffix: 'y' }).startContainer.textContent, 'in');
  assert.equal(locate(redrawn.block, { text: 'missing', prefix: '', suffix: '' }), null);
  // One fitting side is better than none.
  const last = locate(redrawn.block, { text: 'init', prefix: 'zzz', suffix: ' once more.' });
  assert.equal(last.startContainer.textContent, ' again, and init once more.');
});
