import test from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { decorateMarkdown, sanitizeMarkdown } from '../public/markdown-core.js';

function render(source) {
  const window = new JSDOM('').window;
  const purifier = createDOMPurify(window);
  const html = sanitizeMarkdown(source, { parse: marked.parse, sanitize: purifier.sanitize });
  const container = window.document.createElement('div');
  container.innerHTML = html;
  return { window, container };
}

test('Markdown preserves headings, lists, tables, links and literal code', () => {
  const { window, container } = render(
    '## Findings\n\n- **Fixed** routing\n- See [issue](https://example.com/42)\n\n| Agent | State |\n| --- | --- |\n| lead | ready |\n\n```html\n<script>alert(1)</script>\n```',
  );
  try {
    assert.equal(container.querySelector('h2').textContent, 'Findings');
    assert.equal(container.querySelectorAll('li').length, 2);
    assert.equal(container.querySelector('strong').textContent, 'Fixed');
    assert.equal(container.querySelector('a').getAttribute('href'), 'https://example.com/42');
    assert.equal(container.querySelector('td').textContent, 'lead');
    assert.equal(container.querySelector('pre code').textContent.trim(), '<script>alert(1)</script>');
    assert.equal(container.querySelector('script'), null);
  } finally {
    window.close();
  }
});

test('untrusted Markdown removes executable HTML, unsafe links, forms, and overlay styling', () => {
  const { window, container } = render(
    '[unsafe](javascript:alert%281%29)\n\n<img src=x onerror=alert(1)><script>alert(2)</script><iframe src="https://example.com"></iframe><form><input name="id"></form><div id="agent-grid" style="position:fixed;inset:0" onclick="alert(3)">safe text</div>',
  );
  try {
    assert.equal(container.querySelector('a').hasAttribute('href'), false);
    assert.equal(container.querySelector('script, iframe, form, input'), null);
    assert.equal(container.querySelector('[onerror], [onclick], [style]'), null);
    assert.equal(container.querySelector('#agent-grid'), null);
    assert.match(container.textContent, /safe text/);
  } finally {
    window.close();
  }
});

test('Markdown cannot create controls recognized by application event delegation', () => {
  const { window, container } = render(
    '<span data-agent="lead"><span data-action="stop" role="button">Stop lead</span></span><div data-task="task-42"><a href="#" data-verify="task-42">Mark verified</a></div>',
  );
  try {
    assert.equal(container.querySelector('[data-agent], [data-action], [data-task], [data-verify], [role]'), null);
    assert.match(container.textContent, /Stop lead/);
    assert.match(container.textContent, /Mark verified/);
  } finally {
    window.close();
  }
});

function referenceResolver(document, known) {
  return (text) => {
    if (!known.includes(text)) return null;
    const reference = document.createElement('button');
    reference.className = 'reference';
    reference.textContent = `@${text}`;
    return reference;
  };
}

test('known inline code identifiers become references while blocks, links, and other code stay literal', () => {
  const { window, container } = render(
    'Ask `ci-investigator` about `task-1`, not `ci-investigator2` or `npm test`.\n\n[`ci-investigator`](https://example.com)\n\n```\nci-investigator\n```',
  );
  try {
    decorateMarkdown(container, { resolveCode: referenceResolver(window.document, ['ci-investigator', 'task-1']) });
    assert.deepEqual(
      [...container.querySelectorAll('.reference')].map((element) => element.textContent),
      ['@ci-investigator', '@task-1'],
    );
    assert.deepEqual(
      [...container.querySelectorAll('p > code')].map((element) => element.textContent),
      ['ci-investigator2', 'npm test'],
    );
    assert.equal(container.querySelector('a code').textContent, 'ci-investigator');
    assert.equal(container.querySelector('a .reference'), null);
    assert.equal(container.querySelector('pre code').textContent.trim(), 'ci-investigator');
    assert.equal(container.querySelector('a').target, '_blank');
  } finally {
    window.close();
  }
});

test('reference labels are not highlighted again as mentions', () => {
  const { window, container } = render('@lead see `lead`');
  try {
    decorateMarkdown(container, { recipients: ['lead'], resolveCode: referenceResolver(window.document, ['lead']) });
    assert.deepEqual(
      [...container.querySelectorAll('.message-mention')].map((element) => element.textContent),
      ['@lead'],
    );
    assert.equal(container.querySelector('.reference').textContent, '@lead');
    assert.equal(container.querySelector('.reference .message-mention'), null);
  } finally {
    window.close();
  }
});
