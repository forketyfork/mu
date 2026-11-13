import { periodLabel } from './brag.js';

// Builds the pages of the brag view. A page embeds task and agent references, which need the workspace state;
// without it nothing is built, so the caller renders again once the state arrives.
// `pageElement(source)` returns the rendered Markdown of one page.
export function bragSections({ document, state, data, scale, pageElement }) {
  if (!state || !data) return null;
  return data[scale].map((page) => {
    const section = document.createElement('section');
    section.className = 'brag-period';
    const heading = document.createElement('h3');
    heading.className = 'brag-heading';
    heading.textContent = periodLabel(scale, page.key);
    section.append(heading, pageElement(page.source));
    return section;
  });
}
