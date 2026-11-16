// Draws the sections of a visual. Everything it shows is text written by an agent, so it treats all of it as data:
// Markdown is sanitized against an allow-list, and a rich block is drawn by a renderer registered for its type from
// the block's text. The libraries are passed in, so the tests run this file in JSDOM. See "Visuals" in
// docs/architecture.md.

const TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  's',
  'sup',
  'sub',
  'mark',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'ul',
  'ol',
  'li',
  'pre',
  'code',
  'kbd',
  'a',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'img',
  'input',
  'details',
  'summary',
];
const ATTRIBUTES = [
  'href',
  'title',
  'src',
  'alt',
  'start',
  'colspan',
  'rowspan',
  'align',
  'class',
  'type',
  'checked',
  'open',
];
// A link names a web page, a mail address or a place in the visual; an image is carried in the document itself.
const LINK = /^(?:https?:\/\/|mailto:|#)/i;
const IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;
// The sanitizer tests every attribute value against this pattern, so it also passes a value without a scheme, as
// DOMPurify's own pattern does; `tidy` then holds links and images to the two patterns above.
const ATTRIBUTE_VALUES = /^(?:(?:https?|mailto):|data:image\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;
const LANGUAGE_CLASS = /^language-([a-z0-9+#-]{1,32})$/i;

/**
 * Sanitized HTML for a Markdown block of a visual.
 * @param {string} source
 * @param {{ parse: (source: string, options: object) => string, sanitize: (html: string, options: object) => string }} libraries
 */
export function visualMarkdown(source, { parse, sanitize }) {
  return sanitize(parse(source, { gfm: true, breaks: false }), {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRIBUTES,
    ALLOWED_URI_REGEXP: ATTRIBUTE_VALUES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}

/**
 * @typedef {{ id: string, title: string, rev: string, body: string }} ShownSection
 * @typedef {{ type: string, text: string, info: string }} Block
 * @typedef {{ sectionId: string, block: number, message: string }} Problem
 * @typedef {(element: HTMLElement, block: Block) => void | Promise<void>} RichRenderer
 */

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {(body: string) => Block[]} options.parseBlocks
 * @param {(source: string) => string} options.markdownHtml Sanitized HTML of a Markdown block.
 * @param {(code: HTMLElement, language: string) => void | Promise<void>} [options.highlight]
 * @param {Record<string, RichRenderer>} [options.richBlocks]
 * @param {(problems: Problem[]) => void} [options.onProblems] Called with every block that could not be drawn.
 */
export function createRenderer({
  document,
  parseBlocks,
  markdownHtml,
  highlight = undefined,
  richBlocks = {},
  onProblems = () => {},
}) {
  /** @type {Map<string, { rev: string, element: HTMLElement }>} */
  let drawn = new Map();
  /** @type {Map<string, Problem>} */
  const problems = new Map();

  const element = (tag, className, text) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };

  function report(sectionId, block, error) {
    problems.set(`${sectionId}/${block}`, { sectionId, block, message: error.message });
    onProblems([...problems.values()]);
  }

  // What the sanitizer cannot decide by tag and attribute alone.
  function tidy(root) {
    for (const classed of root.querySelectorAll('[class]')) {
      const language = classed.matches('pre > code') && LANGUAGE_CLASS.exec(classed.getAttribute('class'));
      if (language) classed.setAttribute('class', `language-${language[1].toLowerCase()}`);
      else classed.removeAttribute('class');
    }
    for (const input of root.querySelectorAll('input')) {
      if (input.getAttribute('type') === 'checkbox') input.disabled = true;
      else input.remove();
    }
    for (const image of root.querySelectorAll('img')) {
      if (IMAGE.test(image.getAttribute('src') ?? '')) continue;
      image.replaceWith(
        element(
          'span',
          'visual-image-missing',
          `Image not shown${image.alt ? ` (${image.alt})` : ''}: a visual carries its images as data: URLs`,
        ),
      );
    }
    for (const link of root.querySelectorAll('a')) {
      if (!LINK.test(link.getAttribute('href') ?? '')) link.replaceWith(...link.childNodes);
      else link.setAttribute('rel', 'noopener noreferrer');
    }
  }

  function markdownBlock(block, section, index) {
    const container = element('div', 'visual-block visual-markdown markdown-body');
    // A template's content belongs to a document without a window, where an image does not load before `tidy` ran.
    const template = document.createElement('template');
    template.innerHTML = markdownHtml(block.text);
    tidy(template.content);
    container.append(template.content);
    if (highlight)
      for (const code of container.querySelectorAll('pre > code[class]')) {
        const language = LANGUAGE_CLASS.exec(code.getAttribute('class'))[1];
        code.parentElement.dataset.language = language;
        Promise.resolve()
          .then(() => highlight(code, language))
          .catch((error) => {
            // A failure that arrives after the section was replaced says nothing about what is shown.
            if (drawn.get(section.id)?.rev === section.rev) report(section.id, index, error);
          });
      }
    return container;
  }

  function richBlock(block, section, index) {
    const figure = element('figure', `visual-block visual-rich visual-${block.type}`);
    figure.dataset.type = block.type;
    const renderer = Object.hasOwn(richBlocks, block.type) ? richBlocks[block.type] : null;
    const fail = (error) => {
      const failure = element('div', 'visual-block-error');
      failure.setAttribute('role', 'alert');
      failure.append(
        element('strong', '', `This ${block.type} block could not be drawn`),
        element('p', '', error.message),
        element('pre', '', block.text),
      );
      figure.replaceChildren(failure);
      figure.classList.add('failed');
      report(section.id, index, error);
    };
    if (!renderer) {
      fail(new Error(`This version of the dashboard has no renderer for ${block.type} blocks`));
      return figure;
    }
    figure.classList.add('pending');
    Promise.resolve()
      .then(() => renderer(figure, block))
      .then(
        () => figure.classList.remove('pending'),
        (error) => {
          figure.classList.remove('pending');
          fail(error);
        },
      );
    return figure;
  }

  function sectionElement(section) {
    const created = element('section', 'visual-section');
    created.dataset.section = section.id;
    created.dataset.rev = section.rev;
    created.id = `section-${section.id}`;
    if (section.title) created.append(element('h2', 'visual-section-title', section.title));
    parseBlocks(section.body).forEach((block, index) => {
      const drawnBlock =
        block.type === 'markdown' ? markdownBlock(block, section, index) : richBlock(block, section, index);
      drawnBlock.dataset.block = String(index);
      created.append(drawnBlock);
    });
    return created;
  }

  return {
    /**
     * Shows these sections in the container. A section whose content did not change keeps its element, with what was
     * drawn in it and the reader's selection; `flash` names the sections to mark as just changed.
     * @param {HTMLElement} container
     * @param {{ sections: ShownSection[], flash?: string[] }} shown
     */
    render(container, { sections, flash = [] }) {
      const next = new Map();
      for (const section of sections) {
        const kept = drawn.get(section.id);
        if (kept?.rev === section.rev) {
          next.set(section.id, kept);
          continue;
        }
        for (const key of [...problems.keys()]) if (key.startsWith(`${section.id}/`)) problems.delete(key);
        next.set(section.id, { rev: section.rev, element: sectionElement(section) });
      }
      for (const key of [...problems.keys()]) if (!next.has(key.slice(0, key.indexOf('/')))) problems.delete(key);
      drawn = next;
      const elements = sections.map((section) => next.get(section.id).element);
      const unchanged =
        container.children.length === elements.length &&
        elements.every((item, index) => container.children[index] === item);
      if (!unchanged) container.replaceChildren(...elements);
      for (const item of elements) {
        item.classList.remove('flash');
        if (flash.includes(item.dataset.section)) {
          // Reading the box restarts the animation when the same section changes twice in a row.
          void item.offsetWidth;
          item.classList.add('flash');
        }
      }
      onProblems([...problems.values()]);
    },
    /** Forgets what is drawn, so that the next render draws every section again, as after a theme change. */
    reset() {
      drawn = new Map();
      problems.clear();
    },
  };
}
