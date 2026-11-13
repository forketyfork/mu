import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { decorateMarkdown, sanitizeMarkdown } from './markdown-core.js';

export function markdownElement(className, source, options) {
  const element = document.createElement('div');
  element.className = `markdown-body ${className}`;
  element.innerHTML = sanitizeMarkdown(source, {
    parse: marked.parse,
    sanitize: DOMPurify.sanitize,
    forbidTags: options?.forbidTags,
  });
  decorateMarkdown(element, options);
  return element;
}
