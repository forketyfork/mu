// The text format of a visual: one Markdown document, split into sections at level-2 headings, in which a fenced
// block with a registered info string is a rich block. These are pure text functions without Node or DOM APIs: the
// service validates with them, and it serves this file to the visual frame, which renders with them, so the two
// cannot disagree about where a section or a block ends. See "Visuals" in docs/architecture.md.
import { parsePatch } from './visual-patch.mjs';
import { parseScene } from './visual-scene.mjs';
import { ID, isObject, onlyKeys, unseen } from './visual-spec.mjs';

export { PATCH_LIMITS, parsePatch, patchLine } from './visual-patch.mjs';
export { SCENE_LIMITS, parseScene, sceneMoments, sceneState, sceneVisible } from './visual-scene.mjs';
export { unseen, visibleParts } from './visual-spec.mjs';

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

export const SECTION_ID = ID;
// The section that holds the text before the first heading.
export const LEAD_SECTION = 'intro';

/**
 * @typedef {{ id: string, title: string, body: string }} Section
 * @typedef {{ type: string, text: string, info: string }} Block
 */

// A form asks the user questions; the answers go back to the author.
export const FORM_LIMITS = Object.freeze({
  fields: 30,
  options: 12,
  labelChars: 300,
  helpChars: 600,
  unitChars: 20,
  answerChars: 2000,
  // All forms of one version together.
  visualFields: 100,
});
export const FIELD_TYPES = Object.freeze(['choice', 'multi', 'text', 'number', 'toggle']);

/**
 * @typedef {{ id: string, label: string, hint?: string }} FormOption
 * @typedef {{
 *   id: string, type: string, label: string, help?: string, options?: FormOption[],
 *   default?: string | string[] | number | boolean, min?: number, max?: number, step?: number, unit?: string,
 *   multiline?: boolean, placeholder?: string, maxLength?: number,
 * }} FormField
 */

const FIELD_KEYS = {
  choice: ['options', 'default'],
  multi: ['options', 'default'],
  text: ['default', 'multiline', 'placeholder', 'maxLength'],
  number: ['default', 'min', 'max', 'step', 'unit'],
  toggle: ['default'],
};

/**
 * The fields of a form block, checked and in one fixed shape, so that the same question always has the same text.
 * The block is JSON: `{"fields": [{"id": "db", "type": "choice", "label": "Which database?", "options": [...]}]}`.
 * @param {string} text
 * @returns {{ fields: FormField[] }}
 */
export function parseForm(text) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch (error) {
    throw new Error(`A form block is JSON, and this one does not parse: ${error.message}`, { cause: error });
  }
  if (!isObject(spec) || !Array.isArray(spec.fields))
    throw new Error('A form block is a JSON object with a list "fields"');
  onlyKeys(spec, ['fields'], 'A form');
  if (!spec.fields.length || spec.fields.length > FORM_LIMITS.fields)
    throw new Error(`A form has 1–${FORM_LIMITS.fields} fields`);
  const used = new Set();
  const fields = spec.fields.map((raw, index) => {
    const named = isObject(raw) && typeof raw.id === 'string' ? ` (${raw.id.slice(0, 48)})` : '';
    const where = `Form field ${index + 1}${named}`;
    const fail = (message) => {
      throw new Error(`${where}: ${message}`);
    };
    if (!isObject(raw)) fail('a field is an object');
    if (typeof raw.id !== 'string' || !SECTION_ID.test(raw.id))
      fail('"id" must start with a lowercase letter and use at most 48 lowercase letters, digits or hyphens');
    if (used.has(raw.id)) fail('this ID is used twice in the form');
    used.add(raw.id);
    if (!FIELD_TYPES.includes(raw.type)) fail(`"type" is one of ${FIELD_TYPES.join(', ')}`);
    onlyKeys(raw, ['id', 'type', 'label', 'help', ...FIELD_KEYS[raw.type]], `${where}: a ${raw.type} field`);
    const textOf = (value, name, max, { lines = false, needed = false } = {}) => {
      if (value === undefined && !needed) return undefined;
      const trimmed = typeof value === 'string' ? value.trim() : null;
      if (trimmed === null || (needed && !trimmed) || [...trimmed].length > max)
        fail(`"${name}" must be text of ${needed ? '1–' : 'at most '}${max} characters`);
      const hidden = unseen(trimmed, lines);
      if (hidden) fail(`"${name}" holds a character that is not shown (${hidden})`);
      return trimmed;
    };
    const numberOf = (value, name) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(`"${name}" must be a number`);
      return value;
    };
    /** @type {FormField} */
    const field = {
      id: raw.id,
      type: raw.type,
      label: textOf(raw.label, 'label', FORM_LIMITS.labelChars, { needed: true }),
    };
    const help = textOf(raw.help, 'help', FORM_LIMITS.helpChars);
    if (help) field.help = help;
    if (raw.type === 'choice' || raw.type === 'multi') {
      const least = raw.type === 'choice' ? 2 : 1;
      if (!Array.isArray(raw.options) || raw.options.length < least || raw.options.length > FORM_LIMITS.options)
        fail(`"options" must be a list of ${least}–${FORM_LIMITS.options} options`);
      const optionIds = new Set();
      field.options = raw.options.map((option, at) => {
        if (!isObject(option) || typeof option.id !== 'string' || !SECTION_ID.test(option.id))
          fail(`option ${at + 1} needs an "id" like a field's and a "label"`);
        onlyKeys(option, ['id', 'label', 'hint'], `${where}: option ${at + 1}`);
        if (optionIds.has(option.id)) fail(`option ID ${option.id} is used twice`);
        optionIds.add(option.id);
        const hint = textOf(option.hint, `options[${at}].hint`, FORM_LIMITS.helpChars);
        return {
          id: option.id,
          label: textOf(option.label, `options[${at}].label`, FORM_LIMITS.labelChars, { needed: true }),
          ...(hint ? { hint } : {}),
        };
      });
    } else if (raw.type === 'text') {
      if (raw.multiline !== undefined && typeof raw.multiline !== 'boolean') fail('"multiline" must be true or false');
      if (raw.multiline) field.multiline = true;
      const placeholder = textOf(raw.placeholder, 'placeholder', FORM_LIMITS.labelChars);
      if (placeholder) field.placeholder = placeholder;
      if (raw.maxLength !== undefined) {
        if (!Number.isInteger(raw.maxLength) || raw.maxLength < 1 || raw.maxLength > FORM_LIMITS.answerChars)
          fail(`"maxLength" must be a whole number from 1 to ${FORM_LIMITS.answerChars}`);
        field.maxLength = raw.maxLength;
      }
    } else if (raw.type === 'number') {
      for (const name of ['min', 'max', 'step']) {
        const value = numberOf(raw[name], name);
        if (value !== undefined) field[name] = value;
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max)
        fail('"min" must not be larger than "max"');
      if (field.step !== undefined && field.step <= 0) fail('"step" must be larger than 0');
      const unit = textOf(raw.unit, 'unit', FORM_LIMITS.unitChars);
      if (unit) field.unit = unit;
    }
    if (raw.default !== undefined) {
      try {
        field.default = answerOf(field, raw.default);
      } catch (error) {
        fail(`"default" is not an answer to this field: ${error.message}`);
      }
    }
    return field;
  });
  return { fields };
}

/**
 * An answer to a field, checked and in one fixed shape: an option ID for a choice, a list of option IDs in the order
 * of the options for a multi, text, a number, or true or false.
 * @param {FormField} field
 * @param {unknown} value
 */
export function answerOf(field, value) {
  if (field.type === 'choice') {
    if (typeof value !== 'string' || !field.options.some((option) => option.id === value))
      throw new Error(`the answer is one of ${field.options.map((option) => option.id).join(', ')}`);
    return value;
  }
  if (field.type === 'multi') {
    const ids = field.options.map((option) => option.id);
    if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && ids.includes(id)))
      throw new Error(`the answer is a list of ${ids.join(', ')}`);
    return ids.filter((id) => value.includes(id));
  }
  if (field.type === 'text') {
    const max = field.maxLength ?? FORM_LIMITS.answerChars;
    const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : null;
    if (text === null || !text || [...text].length > max || (!field.multiline && text.includes('\n')))
      throw new Error(`the answer is text of 1–${max} characters${field.multiline ? '' : ' on one line'}`);
    // The user sends what the list beside the visual shows, and it cannot show these.
    const hidden = unseen(text, field.multiline === true);
    if (hidden) throw new Error(`the answer holds a character that is not shown (${hidden}); write it without it`);
    return text;
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('the answer is a number');
    if ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))
      throw new Error(`the answer is a number from ${field.min ?? '−∞'} to ${field.max ?? '∞'}`);
    return value;
  }
  if (typeof value !== 'boolean') throw new Error('the answer is true or false');
  return value;
}

/** @type {Record<string, { validate: (block: Block) => void }>} */
export const RICH_BLOCKS = {
  mermaid: {
    validate(block) {
      if (!block.text.trim()) throw new Error('A mermaid block needs a diagram');
    },
  },
  form: {
    validate(block) {
      parseForm(block.text);
    },
  },
  scene: {
    validate(block) {
      parseScene(block.text);
    },
  },
  patch: {
    validate(block) {
      parsePatch(block.text);
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
