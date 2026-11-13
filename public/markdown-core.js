import { splitMentions } from './model.js';

export function sanitizeMarkdown(source, { parse, sanitize, forbidTags = [] }) {
  return sanitize(parse(source, { gfm: true, breaks: true }), {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'del',
      's',
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
    ],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'start', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: forbidTags,
  });
}

// Adds application-built decorations to sanitized Markdown. Code blocks and links stay literal, so a decoration
// never nests a control inside another control. `resolveCode` returns an element for a known identifier or null.
export function decorateMarkdown(root, { recipients = [], resolveCode = undefined } = {}) {
  const document = root.ownerDocument;
  for (const link of root.querySelectorAll('a[href]')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  const walker = document.createTreeWalker(root, document.defaultView.NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement.closest('pre, code, a')) textNodes.push(walker.currentNode);
  }
  for (const text of textNodes) {
    const parts = splitMentions(text.textContent, recipients);
    if (!parts.some((part) => part.mention)) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (part.mention) {
        const span = document.createElement('span');
        span.className = 'message-mention';
        span.textContent = part.text;
        fragment.append(span);
      } else fragment.append(document.createTextNode(part.text));
    }
    text.replaceWith(fragment);
  }
  // Runs after mention highlighting so the `@name` label of an agent reference is not wrapped as a mention.
  if (!resolveCode) return;
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre, a')) continue;
    const reference = resolveCode(code.textContent);
    if (reference) code.replaceWith(reference);
  }
}
