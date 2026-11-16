// The text format of a visual: one Markdown document, split into sections at level-2 headings, in which a fenced
// block with a registered info string is a rich block. These are pure text functions without Node or DOM APIs: the
// service validates with them, and it serves this file to the visual frame, which renders with them, so the two
// cannot disagree about where a section or a block ends. See "Visuals" in docs/architecture.md.

export const LIMITS = Object.freeze({
  titleBytes: 160,
  sectionBytes: 128 * 1024,
  sections: 200,
  // All sections of one version together: what the dashboard loads and the frame draws at once.
  documentBytes: 1024 * 1024,
});

// A comment quotes the text it is about with a little of what stands before and after it, which tells one occurrence
// of the same words in a block from another.
export const COMMENT_LIMITS = Object.freeze({
  textBytes: 4000,
  quoteChars: 600,
  contextChars: 32,
  perVersion: 200,
});

export const SECTION_ID = /^[a-z][a-z0-9-]{0,47}$/;
// The section that holds the text before the first heading.
export const LEAD_SECTION = 'intro';

/**
 * @typedef {{ id: string, title: string, body: string }} Section
 * @typedef {{ type: string, text: string, info: string }} Block
 */

/** @type {Record<string, { validate: (block: Block) => void }>} */
export const RICH_BLOCKS = {
  mermaid: {
    validate(block) {
      if (!block.text.trim()) throw new Error('A mermaid block needs a diagram');
    },
  },
};

// The languages a code block is highlighted in, by the name of their highlight.js grammar, and other names authors
// use for them. A block in any other language is shown as plain code.
export const CODE_LANGUAGES = Object.freeze([
  'bash',
  'c',
  'cpp',
  'css',
  'diff',
  'dockerfile',
  'go',
  'ini',
  'java',
  'javascript',
  'json',
  'kotlin',
  'markdown',
  'python',
  'ruby',
  'rust',
  'shell',
  'sql',
  'swift',
  'typescript',
  'xml',
  'yaml',
]);
const LANGUAGE_ALIASES = Object.freeze({
  'c++': 'cpp',
  console: 'shell',
  docker: 'dockerfile',
  golang: 'go',
  html: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  kt: 'kotlin',
  md: 'markdown',
  mjs: 'javascript',
  patch: 'diff',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  svg: 'xml',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
});

/** The highlight.js grammar for a fence's language name, or null when Mu has none. */
export function codeLanguage(name) {
  const lower = String(name).toLowerCase();
  const language = Object.hasOwn(LANGUAGE_ALIASES, lower) ? LANGUAGE_ALIASES[lower] : lower;
  return CODE_LANGUAGES.includes(language) ? language : null;
}

const bytes = (text) => new TextEncoder().encode(text).length;
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// Calls `visit(line, fence)` for each line, where `fence` describes the fenced block the line belongs to, if any.
// A fence line itself is part of its block; `fence.opening` or `fence.closing` marks it.
function walk(text, visit) {
  let open = null;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (open) {
      const closing = new RegExp(`^ {0,3}${open.marker[0]}{${open.marker.length},}[ \\t]*$`).test(line);
      visit(line, { ...open, closing }, index);
      if (closing) open = null;
      continue;
    }
    const match = OPENING_FENCE.exec(line);
    // A backtick fence cannot have a backtick in its info string; such a line is inline code.
    if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
      open = { marker: match[1], info: match[2].trim(), line: index + 1 };
      visit(line, { ...open, opening: true }, index);
      continue;
    }
    visit(line, null, index);
  }
  return open;
}

function slug(title) {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (!base) return 'section';
  return /^[a-z]/.test(base) ? base : `s-${base}`;
}

const isBlank = (char) => char === ' ' || char === '\t';

// The text of a heading line of the given level, or null when the line is not one. A closing run of `#` counts only
// after white space, as in CommonMark, so a title can end in `C#`. The scans are written out because a pattern with
// two adjacent optional runs takes quadratic or cubic time on a long line of spaces, and this text comes from any
// agent, parsed on the service's only thread.
function headingText(line, level) {
  if (!line.startsWith('#'.repeat(level)) || !isBlank(line[level])) return null;
  let start = level;
  while (start < line.length && isBlank(line[start])) start += 1;
  let end = line.length;
  while (end > start && isBlank(line[end - 1])) end -= 1;
  if (end === start) return null;
  let closing = end;
  while (closing > start && line[closing - 1] === '#') closing -= 1;
  if (closing < end && closing > start && isBlank(line[closing - 1])) {
    end = closing;
    while (end > start && isBlank(line[end - 1])) end -= 1;
  }
  return line.slice(start, end);
}

// Splits `Title {#id}` into its parts. The ID ends the heading and holds no closing brace and no white space; of
// several `{#` that fit, the first one starts it.
function headingId(heading) {
  if (!heading.endsWith('}')) return { title: heading, id: null };
  let from = heading.length - 1;
  while (from > 0 && heading[from - 1] !== '}' && !/\s/.test(heading[from - 1])) from -= 1;
  const at = heading.indexOf('{#', from);
  if (at === -1) return { title: heading, id: null };
  return { title: heading.slice(0, at).trim(), id: heading.slice(at + 2, -1) };
}

const trimBlankLines = (lines) => {
  let start = 0,
    end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end).join('\n');
};

/**
 * Splits a document, or a fragment of one, into its title and sections. A first line `# Title` names the visual.
 * A heading `## Title {#id}` starts a section; without `{#id}` the ID is a slug of the title. Text before the first
 * heading is the lead section.
 * @param {string} source
 * @returns {{ title: string | null, sections: Section[] }}
 */
export function parseDocument(source) {
  if (typeof source !== 'string') throw new Error('The source of a visual is Markdown text');
  const text = source.replace(/\r\n?/g, '\n');
  let title = null;
  /** @type {{ id: string | null, title: string, lines: string[], line: number }[]} */
  const drafts = [{ id: LEAD_SECTION, title: '', lines: [], line: 1 }];
  let seenContent = false;
  const unclosed = walk(text, (line, fence, index) => {
    if (!fence) {
      const documentTitle = seenContent ? null : headingText(line, 1);
      if (documentTitle !== null) {
        title = documentTitle;
        seenContent = true;
        return;
      }
      const heading = headingText(line, 2);
      if (heading !== null) {
        seenContent = true;
        const { title: headingTitle, id } = headingId(heading);
        if (id !== null && !SECTION_ID.test(id))
          throw new Error(
            `Line ${index + 1}: section ID {#${id}} must start with a lowercase letter and use at most 48 lowercase letters, digits or hyphens`,
          );
        drafts.push({ id, title: headingTitle, lines: [], line: index + 1 });
        return;
      }
    }
    if (line.trim()) seenContent = true;
    drafts.at(-1).lines.push(line);
  });
  if (unclosed)
    throw new Error(
      `Line ${unclosed.line}: the fenced block opened here is never closed, so every section after it would be part of it`,
    );
  const lead = drafts.shift();
  const sections = [];
  const used = new Set();
  const leadBody = trimBlankLines(lead.lines);
  if (leadBody) {
    sections.push({ id: LEAD_SECTION, title: '', body: leadBody });
    used.add(LEAD_SECTION);
  }
  for (const draft of drafts)
    if (draft.id !== null) {
      if (used.has(draft.id)) throw new Error(`Line ${draft.line}: section ID {#${draft.id}} is used twice`);
      used.add(draft.id);
    }
  for (const draft of drafts) {
    let id = draft.id;
    if (id === null) {
      const base = slug(draft.title);
      id = base;
      for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
      used.add(id);
    }
    sections.push({ id, title: draft.title, body: trimBlankLines(draft.lines) });
  }
  return { title, sections };
}

/**
 * Splits a section's body into Markdown and rich blocks, in order. Only a fence at the top level whose info string
 * starts with a registered type is a rich block; every other fence stays in its Markdown block as code.
 * @param {string} body
 * @returns {Block[]}
 */
export function parseBlocks(body) {
  /** @type {Block[]} */
  const blocks = [];
  let markdown = [];
  let rich = null;
  const flush = () => {
    const text = trimBlankLines(markdown);
    if (text) blocks.push({ type: 'markdown', text, info: '' });
    markdown = [];
  };
  walk(body, (line, fence) => {
    const [type = '', ...rest] = fence ? fence.info.split(/\s+/) : [];
    if (!fence || !Object.hasOwn(RICH_BLOCKS, type)) {
      markdown.push(line);
      return;
    }
    if (fence.opening) {
      flush();
      rich = { type, text: [], info: rest.join(' ') };
    } else if (fence.closing) {
      blocks.push({ type: rich.type, text: rich.text.join('\n'), info: rich.info });
      rich = null;
    } else rich.text.push(line);
  });
  flush();
  return blocks;
}

/** Checks what the service stores: sizes, and each rich block against its type. Throws with the section named. */
export function validateSection(section) {
  if (bytes(section.title) > LIMITS.titleBytes)
    throw new Error(`Section ${section.id}: the title is longer than ${LIMITS.titleBytes} UTF-8 bytes`);
  if (bytes(section.body) > LIMITS.sectionBytes)
    throw new Error(`Section ${section.id}: the body is larger than ${LIMITS.sectionBytes / 1024} KiB`);
  for (const block of parseBlocks(section.body)) {
    if (block.type === 'markdown') continue;
    try {
      RICH_BLOCKS[block.type].validate(block);
    } catch (error) {
      throw new Error(`Section ${section.id}: ${error.message}`, { cause: error });
    }
  }
}

/** A section as its author wrote it, with its ID in the heading. */
export function sectionSource(section) {
  const heading =
    section.id === LEAD_SECTION && !section.title
      ? ''
      : `## ${section.title}${section.title ? ' ' : ''}{#${section.id}}\n\n`;
  return `${heading}${section.body}\n`;
}

export function documentSource(title, sections) {
  return [`# ${title}\n`, ...sections.map(sectionSource)].join('\n');
}
