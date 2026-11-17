import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { lineRow, locate } from '../public/visual/anchor.js';
import { createSheen, linesPath, placeOf } from '../public/visual/sheen.js';

const QUOTE = { text: 'cache', prefix: 'the ', suffix: ' is' };

// The frame's page with two sections. JSDOM lays nothing out, so the boxes come from `boxes`, by element ID, and a
// range gets two lines.
function page(t) {
  const { window } = new JSDOM(
    `<main id="document">
      <section class="visual-section" id="section-a" data-section="a" data-rev="a1">
        <h2>A</h2>
        <div id="a-0" data-block="0"><p>Here the cache is filled.</p></div>
        <figure id="a-1" data-block="1"></figure>
        <figure id="a-2" data-block="2" class="visual-patch"><table><tr id="a-2-row" class="patch-line add" data-path="x.js" data-new="7"></tr></table></figure>
      </section>
      <section class="visual-section" id="section-b" data-section="b" data-rev="b1"><div id="b-0" data-block="0"><p>B</p></div></section>
    </main>`,
    { pretendToBeVisual: true },
  );
  t.after(() => window.close());
  const { document } = window;
  const container = document.getElementById('document');
  const boxes = {
    document: [40, 30, 800, 2000],
    'section-a': [20, 30, 840, 600],
    'a-0': [40, 90, 800, 120],
    'a-1': [40, 220, 800, 300],
    'a-2': [40, 530, 800, 90],
    'a-2-row': [40, 560, 800, 24],
    'section-b': [20, 640, 840, 400],
    'b-0': [40, 660, 800, 60],
  };
  const rect = ([left, top, width, height]) => ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  });
  window.Element.prototype.getBoundingClientRect = function () {
    return rect(boxes[this.id] ?? [0, 0, 0, 0]);
  };
  const lines = [
    [300, 100, 200, 24],
    [40, 126, 90, 24],
  ];
  window.Range.prototype.getClientRects = () => lines.map(rect);
  window.Range.prototype.getBoundingClientRect = () => rect([40, 100, 460, 50]);
  window.ResizeObserver = class {
    observe() {}
  };
  const sheen = createSheen({ document, window, container, locate, lineRow });
  const lights = () =>
    [...document.querySelectorAll('.working-layer > .working-sheen')].map((light) => [
      light.dataset.comment,
      light.className.replace('working-sheen ', ''),
      [light.style.left, light.style.top, light.style.width, light.style.height].join(' '),
    ]);
  const frames = () => new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve)));
  return { document, container, boxes, sheen, lights, frames };
}

test('a target is the whole visual, a section, a block or quoted text, on the content the comment was made on', (t) => {
  const { document, container } = page(t);
  const place = (target) => placeOf(document, container, target, { locate, lineRow });
  assert.deepEqual(place({ sectionId: null }), { kind: 'whole', place: container });
  assert.deepEqual(place({ sectionId: 'a', sectionRev: 'a1', block: null }), {
    kind: 'section',
    place: document.getElementById('section-a'),
  });
  assert.deepEqual(place({ sectionId: 'a', sectionRev: 'a1', block: 1, quote: null }), {
    kind: 'block',
    place: document.getElementById('a-1'),
  });
  const text = place({ sectionId: 'a', sectionRev: 'a1', block: 0, quote: QUOTE });
  assert.deepEqual([text.kind, text.place.toString()], ['text', 'cache']);
  // Text that the block does not hold any more leaves the block.
  assert.equal(place({ sectionId: 'a', sectionRev: 'a1', block: 0, quote: { ...QUOTE, text: 'index' } }).kind, 'block');
  // A section that was drawn from other content, or that is gone, has nothing to show.
  assert.equal(place({ sectionId: 'a', sectionRev: 'a0', block: null }), null);
  assert.equal(place({ sectionId: 'gone', sectionRev: 'x', block: null }), null);
  assert.equal(place({ sectionId: 'a', sectionRev: 'a1', block: 7 }), null);
  // A line of a patch is its row; a line that the patch does not draw leaves the block.
  const line = { path: 'x.js', side: 'new', number: 7 };
  assert.deepEqual(place({ sectionId: 'a', sectionRev: 'a1', block: 2, quote: null, line }), {
    kind: 'line',
    place: document.getElementById('a-2-row'),
  });
  assert.equal(
    place({ sectionId: 'a', sectionRev: 'a1', block: 2, quote: null, line: { ...line, number: 8 } }).kind,
    'block',
  );
});

test('the lines of a quote make one clip path around the box of the quote', () => {
  assert.equal(
    linesPath(
      [
        { left: 300, top: 100, width: 200, height: 24 },
        { left: 40, top: 126, width: 90.26, height: 24 },
        { left: 40, top: 150, width: 0, height: 24 },
      ],
      { left: 38, top: 98 },
    ),
    'M260 0h204v28h-204ZM0 26h94.3v28h-94.3Z',
  );
  assert.equal(linesPath([], { left: 0, top: 0 }), '');
});

test('every target gets one light in a layer over the document, which follows the layout and goes with the target', async (t) => {
  const { document, container, boxes, sheen, lights, frames } = page(t);
  const layer = document.querySelector('.working-layer');
  assert.equal(layer.getAttribute('aria-hidden'), 'true');
  // The layer is no section: the document holds what the dashboard sent, and nothing else.
  assert.equal(layer.parentElement, container.parentElement);
  assert.equal(container.querySelector('.working-layer'), null);
  assert.deepEqual(lights(), []);

  sheen.set([
    { id: 'vc-1', sectionId: 'a', sectionRev: 'a1', block: 0, quote: QUOTE },
    { id: 'vc-2', sectionId: 'b', sectionRev: 'b1', block: null, quote: null },
    { id: 'vc-3', sectionId: null, sectionRev: null, block: null, quote: null },
    { id: 'vc-4', sectionId: 'a', sectionRev: 'a0', block: null, quote: null },
    { id: 'vc-5', sectionId: 'a', sectionRev: 'a1', block: 1, quote: null },
    {
      id: 'vc-6',
      sectionId: 'a',
      sectionRev: 'a1',
      block: 2,
      quote: null,
      line: { path: 'x.js', side: 'new', number: 7 },
    },
  ]);
  assert.deepEqual(lights(), [
    // The light of a quote reaches a little beyond its text, and is cut to its lines.
    ['vc-1', 'text', '38px 98px 464px 54px'],
    ['vc-2', 'section', '20px 640px 840px 400px'],
    // The whole visual is lit as far as its sections reach, which is beyond the element that holds them.
    ['vc-3', 'whole', '20px 30px 840px 2000px'],
    ['vc-5', 'block', '40px 220px 800px 300px'],
    ['vc-6', 'line', '40px 560px 800px 24px'],
  ]);
  const [onText, onSection] = document.querySelectorAll('.working-sheen');
  assert.equal(onText.style.clipPath, 'path("M260 0h204v28h-204ZM0 26h94v28h-94Z")');
  assert.equal(onSection.style.clipPath, '');
  // The sections are as the renderer made them.
  assert.equal(document.getElementById('section-a').className, 'visual-section');

  // A diagram is drawn and moves the second section: the same light moves, so its motion goes on.
  boxes['section-b'] = [20, 940, 840, 400];
  document.getElementById('a-1').append(document.createElement('svg'));
  await frames();
  assert.equal(document.querySelectorAll('.working-sheen')[1], onSection);
  assert.equal(lights()[1][2], '20px 940px 840px 400px');

  // The author changed section b in this version: the comment is not on that content.
  document.getElementById('section-b').dataset.rev = 'b2';
  sheen.apply();
  assert.deepEqual(
    lights().map(([id]) => id),
    ['vc-1', 'vc-3', 'vc-5', 'vc-6'],
  );
  // The turn ended, or wrote its version: the dashboard names nothing.
  sheen.set([]);
  assert.deepEqual(lights(), []);
  // What is not a list of targets lights nothing.
  for (const wrong of [null, 'all', [{ sectionId: null }], [{ id: 'vc-9', sectionId: 'a' }]]) {
    sheen.set(wrong);
    assert.deepEqual(lights(), [], JSON.stringify(wrong));
  }
});
