import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import { codeLanguage, parseBlocks } from '../src/visual-format.mjs';
import { createRenderer, visualMarkdown } from '../public/visual/render.js';

hljs.registerLanguage('javascript', javascript);

function frame(t, options = {}) {
  const { window } = new JSDOM('<main id="document"></main>', { runScripts: 'outside-only' });
  t.after(() => window.close());
  const purifier = createDOMPurify(window);
  const reported = [];
  const renderer = createRenderer({
    document: window.document,
    parseBlocks,
    markdownHtml: (source) => visualMarkdown(source, { parse: marked.parse, sanitize: purifier.sanitize }),
    onProblems: (problems) => reported.push(problems),
    ...options,
  });
  const container = window.document.getElementById('document');
  return { window, container, renderer, reported, $: (selector) => container.querySelector(selector) };
}
const section = (id, body, rev = `${id}-1`, title = id) => ({ id, title, rev, body });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Markdown from an agent is drawn without scripts, handlers, remote images or unsafe links', (t) => {
  const { window, container, renderer, $ } = frame(t);
  renderer.render(container, {
    sections: [
      section(
        'hostile',
        [
          '<script>window.injected = true</script>',
          '<img src="x" onerror="window.injected = true">',
          '<img src="https://example.com/pixel.png" alt="pixel">',
          '<img alt="dot" src="data:image/png;base64,iVBORw0KGgo=">',
          '<img alt="vector" src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
          '<a href="javascript:window.injected = true">run</a>',
          '<a href="/api/state">relative</a>',
          '<a href="https://example.com/a" onclick="window.injected = true" target="_top">web</a>',
          '<iframe src="https://example.com"></iframe><form action="/api/messages"><button>go</button></form>',
          '<p style="position:fixed" class="visual-block-error" id="visual-title" data-section="other">styled</p>',
          '<input type="text" value="typed"><input type="checkbox" checked>',
          '',
          '- [x] done',
          '',
          '[steps](#steps) and <mark>marked</mark>',
        ].join('\n'),
      ),
    ],
  });
  assert.equal(window.injected, undefined);
  for (const forbidden of [
    'script',
    'iframe',
    'form',
    'button',
    '[onclick]',
    '[onerror]',
    '[style]',
    '[id]',
    '[target]',
  ])
    assert.equal(container.querySelector(`.visual-markdown ${forbidden}`), null, forbidden);
  assert.deepEqual(
    [...container.querySelectorAll('img')].map((image) => image.alt),
    ['dot'],
    'only an image carried as a raster data: URL is shown',
  );
  assert.match($('.visual-image-missing').textContent, /Image not shown/);
  assert.deepEqual(
    [...container.querySelectorAll('a')].map((link) => [link.getAttribute('href'), link.rel]),
    [
      ['https://example.com/a', 'noopener noreferrer'],
      ['#steps', 'noopener noreferrer'],
    ],
    'a link names a web page or a section; any other keeps its text only',
  );
  assert.match(container.textContent, /run/);
  assert.equal($('p[class]'), null, 'an author cannot borrow the classes of the frame');
  assert.equal($('[data-section="other"]'), null);
  const inputs = [...container.querySelectorAll('input')];
  assert.ok(inputs.length >= 2);
  assert.ok(inputs.every((input) => input.type === 'checkbox' && input.disabled));
  assert.equal($('mark').textContent, 'marked');
});

test('a section is drawn as a titled element whose blocks are numbered', (t) => {
  const { container, renderer, $ } = frame(t, { richBlocks: { mermaid: (figure) => figure.append('drawn') } });
  renderer.render(container, {
    sections: [
      { id: 'intro', title: '', rev: 'a', body: 'Lead text.' },
      section('flow', 'Before.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter.', 'b', 'The flow'),
    ],
  });
  assert.deepEqual(
    [...container.children].map((item) => [item.dataset.section, item.dataset.rev, item.id]),
    [
      ['intro', 'a', 'section-intro'],
      ['flow', 'b', 'section-flow'],
    ],
  );
  assert.equal($('#section-intro .visual-section-title'), null);
  assert.equal($('#section-flow .visual-section-title').textContent, 'The flow');
  assert.deepEqual(
    [...$('#section-flow').querySelectorAll('.visual-block')].map((block) => [block.dataset.block, block.className]),
    [
      ['0', 'visual-block visual-markdown markdown-body'],
      ['1', 'visual-block visual-rich visual-mermaid pending'],
      ['2', 'visual-block visual-markdown markdown-body'],
    ],
  );
});

test('a section whose content did not change keeps its element; changed ones are drawn again and marked', async (t) => {
  let diagrams = 0;
  const { container, renderer, $ } = frame(t, {
    richBlocks: {
      mermaid(figure) {
        diagrams += 1;
        figure.append(`diagram ${diagrams}`);
      },
    },
  });
  const flow = section('flow', '```mermaid\nflowchart LR\n```');
  renderer.render(container, { sections: [section('a', 'One'), flow, section('c', 'Three')] });
  await settle();
  const [a, drawnFlow] = container.children;
  renderer.render(container, {
    sections: [section('new', 'Added'), flow, section('a', 'One, rewritten', 'a-2')],
    flash: ['new', 'a'],
  });
  await settle();
  assert.deepEqual(
    [...container.children].map((item) => item.dataset.section),
    ['new', 'flow', 'a'],
  );
  assert.equal(container.children[1], drawnFlow, 'the diagram is not drawn again');
  assert.equal(diagrams, 1);
  assert.notEqual(container.children[2], a);
  assert.match($('#section-a').textContent, /rewritten/);
  assert.deepEqual(
    [...container.querySelectorAll('.flash')].map((item) => item.dataset.section),
    ['new', 'a'],
  );
  renderer.render(container, { sections: [flow] });
  assert.equal(container.querySelector('.flash'), null, 'a mark lasts until the next render');
  assert.equal(container.children.length, 1);

  renderer.reset();
  renderer.render(container, { sections: [flow] });
  await settle();
  assert.equal(diagrams, 2, 'after a reset, as on a theme change, everything is drawn again');
});

test('a block that cannot be drawn says so in its place and is reported, and stops being reported when it is fixed', async (t) => {
  const { container, renderer, reported, $ } = frame(t, {
    richBlocks: {
      async mermaid(figure, block) {
        if (block.text.includes('???')) throw new Error('Parse error on line 2');
        figure.append('ok');
      },
    },
  });
  renderer.render(container, {
    sections: [
      section('bad', 'Text.\n\n```mermaid\nflowchart ???\n```'),
      section('good', '```mermaid\nflowchart LR\n```'),
    ],
  });
  await settle();
  const failure = $('#section-bad .visual-rich');
  assert.ok(failure.classList.contains('failed'));
  assert.ok(!failure.classList.contains('pending'));
  assert.equal(failure.querySelector('[role="alert"] strong').textContent, 'This mermaid block could not be drawn');
  assert.match(failure.textContent, /Parse error on line 2/);
  assert.equal(failure.querySelector('pre').textContent, 'flowchart ???', 'the source is shown as text');
  assert.ok(!$('#section-good .visual-rich').classList.contains('failed'));
  assert.deepEqual(reported.at(-1), [{ sectionId: 'bad', block: 1, message: 'Parse error on line 2' }]);

  renderer.render(container, {
    sections: [
      section('bad', '```mermaid\nflowchart LR\n```', 'bad-2'),
      section('good', '```mermaid\nflowchart LR\n```'),
    ],
  });
  await settle();
  assert.deepEqual(reported.at(-1), []);
});

test('a rich block without a renderer is an error in its place, not an empty space', (t) => {
  const { container, renderer, reported, $ } = frame(t);
  renderer.render(container, { sections: [section('flow', '```mermaid\nflowchart LR\n```')] });
  assert.match($('.visual-rich.failed').textContent, /no renderer for mermaid blocks/);
  assert.equal(reported.at(-1).length, 1);
});

test('code is highlighted by the language of its fence, and stays plain text without a known one', async (t) => {
  const asked = [];
  const { container, renderer, $ } = frame(t, {
    highlight(code, name) {
      asked.push(name);
      const language = codeLanguage(name);
      if (!language) return;
      code.innerHTML = hljs.highlight(code.textContent, { language }).value;
      code.classList.add('hljs');
    },
  });
  const hostile = 'const tag = "<img src=x onerror=alert(1)>";';
  renderer.render(container, {
    sections: [
      section(
        'code',
        `\`\`\`js\n${hostile}\n\`\`\`\n\n\`\`\`weird-lang\nplain <b>text</b>\n\`\`\`\n\n\`\`\`\nno language\n\`\`\``,
      ),
    ],
  });
  await settle();
  assert.deepEqual(asked, ['js', 'weird-lang']);
  const [js, weird] = container.querySelectorAll('pre > code');
  assert.equal(js.parentElement.dataset.language, 'js');
  assert.ok(js.querySelector('.hljs-keyword'));
  assert.equal(js.textContent.trim(), hostile, 'highlighting keeps the code as text');
  assert.equal(container.querySelector('pre img'), null);
  assert.equal(weird.textContent.trim(), 'plain <b>text</b>');
  assert.equal(weird.querySelector('span'), null);
  assert.equal($('pre:not([data-language]) > code').textContent.trim(), 'no language');
});

test('language names map to the grammars Mu serves', () => {
  assert.equal(codeLanguage('JS'), 'javascript');
  assert.equal(codeLanguage('kotlin'), 'kotlin');
  assert.equal(codeLanguage('html'), 'xml');
  assert.equal(codeLanguage('constructor'), null);
  assert.equal(codeLanguage('../core'), null);
});
