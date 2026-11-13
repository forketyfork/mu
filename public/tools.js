// Readable views of tool calls in the transcript viewer, adapted from marginalia's transcript renderer.
// A view is a tree of plain objects, `{ tag, className, children }`, whose leaves are strings. The dashboard turns it
// into elements with text nodes only, so tool input, which comes from untrusted transcripts, can never become markup.

const h = (tag, className, ...children) => ({
  tag,
  className,
  children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== ''),
});
const INLINE_LIMIT = 120;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const field = (input, ...keys) => {
  if (!isObject(input)) return null;
  for (const key of keys) if (typeof input[key] === 'string') return input[key];
  return null;
};

// Before the service kept tool input structured it sent a JSON string, and a shell tool's bare command.
export function toolInputValue(name, input) {
  if (typeof input !== 'string' || SHELL_TOOLS.has(name)) return input;
  if (!/^\s*[[{]/.test(input)) return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

// ---- Shell commands -------------------------------------------------------------------------------------------
// One scanner tracks quotes, `$(...)`, backticks, `${...}`, `$((...))` and subshells, so nothing inside them is taken
// for a statement separator or a here-document operator.

const GROUPS = new Set(['paren', 'backtick']);
const inCommandText = (stack) => stack.length === 0 || GROUPS.has(stack.at(-1));
const isCommentStart = (text, i) => text[i] === '#' && (i === 0 || /\s/.test(text[i - 1]));

function advance(scan) {
  const { text, stack } = scan;
  const ch = text[scan.i];
  const context = stack.at(-1);
  if (context === 'sq' || context === 'ansi') {
    if (context === 'ansi' && ch === '\\') scan.i += 2;
    else {
      if (ch === "'") stack.pop();
      scan.i += 1;
    }
    return;
  }
  if (context === 'arith') {
    if (text.startsWith('))', scan.i)) {
      stack.pop();
      scan.i += 2;
    } else scan.i += 1;
    return;
  }
  if (ch === '\\') {
    scan.i += 2;
    return;
  }
  if (ch === '$') {
    for (const [opener, pushed] of [
      ['$((', 'arith'],
      ['$(', 'paren'],
      ['${', 'brace'],
    ]) {
      if (text.startsWith(opener, scan.i)) {
        stack.push(pushed);
        scan.i += opener.length;
        return;
      }
    }
    if (context !== 'dq' && text.startsWith("$'", scan.i)) {
      stack.push('ansi');
      scan.i += 2;
      return;
    }
  }
  if (context === 'dq') {
    if (ch === '"') stack.pop();
    else if (ch === '`') stack.push('backtick');
    scan.i += 1;
    return;
  }
  if (ch === "'") stack.push('sq');
  else if (ch === '"') stack.push('dq');
  else if (ch === '`') {
    if (context === 'backtick') stack.pop();
    else stack.push('backtick');
  } else if (ch === '(') stack.push('paren');
  else if (ch === ')' && context === 'paren') stack.pop();
  else if (ch === '}' && context === 'brace') stack.pop();
  scan.i += 1;
}

function splitStatements(command) {
  const scan = { text: command, stack: [], i: 0 };
  const statements = [];
  let start = 0;
  while (scan.i < command.length) {
    if (scan.stack.length === 0) {
      if (isCommentStart(command, scan.i)) break;
      if (command[scan.i] === ';') {
        const separator = command[scan.i + 1] === ';' ? ';;' : ';';
        statements.push({ code: command.slice(start, scan.i), separator });
        scan.i += separator.length;
        start = scan.i;
        continue;
      }
    }
    advance(scan);
  }
  statements.push({ code: command.slice(start), separator: '' });
  return statements;
}

const OPENERS = new Set(['do', 'then', 'else', '{']);
const CLOSERS = new Set(['done', 'fi', 'esac', 'else', 'elif', '}']);
const CASE_HEAD = /^case\s+(?:"[^"]*"|'[^']*'|\S)+\s+in(?=\s|$)/;
const firstWord = (text) => /^\S+/.exec(text)?.[0] ?? '';
function openingHead(text) {
  const word = firstWord(text);
  if (OPENERS.has(word)) return word;
  if (word === 'case') return CASE_HEAD.exec(text)?.[0] ?? null;
  return null;
}

// A one-line command with several statements, one statement per line, with compound bodies indented.
// Returns null for a multi-line command or a single statement, which are shown as written.
export function layoutShell(command) {
  if (command.includes('\n')) return null;
  const statements = splitStatements(command);
  if (statements.at(-1)?.code.trim() === '') statements.pop();
  if (statements.length < 2) return null;
  const lines = [];
  let indent = 0;
  for (const statement of statements) {
    const code = statement.code.trim();
    if (CLOSERS.has(firstWord(code))) indent = Math.max(0, indent - 1);
    const head = openingHead(code);
    const body = head === null ? '' : code.slice(head.length).trim();
    if (head === null || !body) lines.push({ indent, code, separator: statement.separator });
    else
      lines.push(
        { indent, code: head, separator: '' },
        { indent: indent + 1, code: body, separator: statement.separator },
      );
    if (head !== null) indent += 1;
  }
  return lines;
}

const HEREDOC_OPERATOR = /<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|\\?([^\s;|&<>()]+))/y;

// Here-documents in operator order: the operator's line and columns, the body lines [bodyFrom, bodyTo), and the
// terminator line, or null when the body runs to the end of the command.
export function findHeredocs(command) {
  const lines = command.split('\n');
  const lineStarts = [0];
  for (const line of lines.slice(0, -1)) lineStarts.push(lineStarts.at(-1) + line.length + 1);
  const lineOf = (offset) => {
    let line = 0;
    while ((lineStarts[line + 1] ?? Infinity) <= offset) line += 1;
    return line;
  };
  const docs = [];
  const pending = [];
  const scan = { text: command, stack: [], i: 0 };
  while (scan.i < command.length) {
    const ch = command[scan.i];
    if (ch === '\n') {
      scan.i += 1;
      if (!pending.length) continue;
      let next = lineOf(scan.i);
      for (const { doc, stripTabs } of pending) {
        doc.bodyFrom = next;
        let terminator = null;
        for (let k = next; k < lines.length; k += 1)
          if ((stripTabs ? lines[k].replace(/^\t+/, '') : lines[k]) === doc.delimiter) {
            terminator = k;
            break;
          }
        doc.bodyTo = terminator ?? lines.length;
        doc.terminator = terminator;
        next = terminator === null ? lines.length : terminator + 1;
      }
      pending.length = 0;
      scan.i = lineStarts[next] ?? command.length;
      continue;
    }
    if (inCommandText(scan.stack)) {
      if (isCommentStart(command, scan.i)) {
        const newline = command.indexOf('\n', scan.i);
        scan.i = newline < 0 ? command.length : newline;
        continue;
      }
      if (ch === '<' && command[scan.i - 1] !== '<') {
        HEREDOC_OPERATOR.lastIndex = scan.i;
        const match = HEREDOC_OPERATOR.exec(command);
        if (match) {
          const line = lineOf(scan.i);
          const start = scan.i - lineStarts[line];
          const doc = {
            line,
            start,
            end: start + match[0].length,
            delimiter: match[2] ?? match[3] ?? match[4] ?? '',
            bodyFrom: lines.length,
            bodyTo: lines.length,
            terminator: null,
          };
          docs.push(doc);
          pending.push({ doc, stripTabs: match[1] === '-' });
          scan.i += match[0].length;
          continue;
        }
      }
    }
    advance(scan);
  }
  const unfed = new Set(pending.map((item) => item.doc));
  return docs.filter((doc) => !unfed.has(doc));
}

// Codex records a command as `<shell> -c <script>`; the script is what the agent wrote.
export function shellScript(argv) {
  const [shell, flag, script, ...rest] = argv;
  if (
    typeof shell === 'string' &&
    /^(?:\/\S*\/)?(?:ba|z|da)?sh$/.test(shell) &&
    (flag === '-c' || flag === '-lc') &&
    typeof script === 'string' &&
    !rest.length
  )
    return script;
  return argv.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
}

const dim = (text) => h('span', 'tool-dim', text);

export function shellView(command) {
  const laidOut = layoutShell(command);
  if (laidOut)
    return h(
      'pre',
      'transcript-pre tool-code tool-shell',
      laidOut.flatMap((line, index) => [
        index ? '\n' : '',
        '  '.repeat(line.indent),
        line.code,
        line.separator ? dim(line.separator) : null,
      ]),
    );
  const docs = findHeredocs(command);
  if (!docs.length) return h('pre', 'transcript-pre tool-code tool-shell', command);
  // A here-document body is the content the command reads, not shell: its frame is dimmed and its lines set apart.
  const lines = command.split('\n');
  const roles = lines.map(() => 'shell');
  for (const doc of docs) {
    for (let k = doc.bodyFrom; k < doc.bodyTo; k += 1) roles[k] = 'body';
    if (doc.terminator !== null) roles[doc.terminator] = 'terminator';
  }
  const children = lines.flatMap((line, index) => {
    const separator = index ? '\n' : '';
    if (roles[index] === 'body') return [separator, h('span', 'tool-heredoc', line)];
    if (roles[index] === 'terminator') return [separator, dim(line)];
    const operators = docs.filter((doc) => doc.line === index);
    const parts = [];
    let at = 0;
    for (const doc of operators) {
      parts.push(line.slice(at, doc.start), dim(line.slice(doc.start, doc.end)));
      at = doc.end;
    }
    parts.push(line.slice(at));
    return [separator, ...parts];
  });
  return h('pre', 'transcript-pre tool-code tool-shell', children);
}

// ---- Shared pieces --------------------------------------------------------------------------------------------

const code = (text) => h('code', 'tool-inline', text);
const block = (text, className = '') => h('pre', `transcript-pre tool-code ${className}`.trim(), text);
const json = (value) => JSON.stringify(value, null, 2) ?? String(value);

function valueView(value) {
  if (typeof value === 'string')
    return value.length > INLINE_LIMIT || value.includes('\n') ? block(value) : code(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return code(String(value));
  return block(json(value));
}

// The arguments a tool's own view does not show, so a view never hides part of the input.
function keyValues(input, shown = []) {
  if (!isObject(input)) return input === null || input === undefined ? null : valueView(input);
  const rows = Object.entries(input)
    .filter(([key, value]) => !shown.includes(key) && value !== undefined)
    .map(([key, value]) => h('div', 'tool-kv', h('span', 'tool-key', key), valueView(value)));
  return rows.length ? h('div', 'tool-kvs', rows) : null;
}

function diffLines(text) {
  return text.split('\n').map((line, index) => {
    const kind = line.startsWith('@@')
      ? 'tool-hunk'
      : line.startsWith('+')
        ? 'tool-add'
        : line.startsWith('-')
          ? 'tool-del'
          : '';
    return [index ? '\n' : '', kind ? h('span', kind, line) : line];
  });
}
const diffView = (text) => h('pre', 'transcript-pre tool-code tool-diff', diffLines(text));
function replacementView(oldText, newText) {
  const lines = [...oldText.split('\n').map((line) => `-${line}`), ...newText.split('\n').map((line) => `+${line}`)];
  return diffView(lines.join('\n'));
}

function lineRange(input) {
  const offset = Number.isInteger(input.offset) ? input.offset : null;
  const limit = Number.isInteger(input.limit) ? input.limit : null;
  if (offset === null && limit === null) return '';
  const from = offset ?? 1;
  return limit === null ? `from line ${from}` : limit === 1 ? `line ${from}` : `lines ${from}–${from + limit - 1}`;
}

const countLines = (text) => {
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return `${lines} line${lines === 1 ? '' : 's'}`;
};

// ---- Tools ----------------------------------------------------------------------------------------------------
// Each view returns `{ summary, body }`: a one-line summary next to the tool name, and the formatted arguments.
// A view whose arguments do not have the expected types returns null, and the call is shown as key-value rows.

const SHELL_TOOLS = new Set([
  'Bash',
  'bash',
  'bash (user)',
  'command',
  'shell',
  'shell_command',
  'local_shell',
  'exec_command',
]);

function shell(input) {
  if (typeof input === 'string') return { summary: '', body: [shellView(input)] };
  const command = Array.isArray(input?.command) ? shellScript(input.command) : field(input, 'command', 'cmd');
  if (command === null) return null;
  return {
    summary: field(input, 'description') ?? '',
    body: [shellView(command), keyValues(input, ['command', 'cmd', 'description'])],
  };
}

function read(input) {
  const path = field(input, 'file_path', 'path');
  if (path === null) return null;
  return {
    summary: [code(path), lineRange(input)],
    body: [keyValues(input, ['file_path', 'path', 'offset', 'limit'])],
  };
}

// A count over a cut input would describe only its shown part, so views leave counts out while `partial`.
function write(input, { partial }) {
  const path = field(input, 'file_path', 'path');
  const content = field(input, 'content');
  if (path === null || content === null) return null;
  return {
    summary: [code(path), partial ? '' : countLines(content)],
    body: [block(content), keyValues(input, ['file_path', 'path', 'content'])],
  };
}

// Claude Code's Edit has one replacement; its MultiEdit and pi's edit have a list of them.
function edit(input, { partial }) {
  const path = field(input, 'file_path', 'path');
  if (path === null) return null;
  const single = field(input, 'old_string') !== null && field(input, 'new_string') !== null;
  const edits = single ? [input] : input.edits;
  if (!Array.isArray(edits) || !edits.length) return null;
  const pairs = edits.map((item) => [field(item, 'old_string', 'oldText'), field(item, 'new_string', 'newText')]);
  if (pairs.some(([oldText, newText]) => oldText === null || newText === null)) return null;
  const extra = edits.flatMap((item) =>
    Object.keys(item).filter((key) => !['old_string', 'new_string', 'oldText', 'newText', 'file_path'].includes(key)),
  );
  const summary = [
    code(path),
    input.replace_all === true ? 'every occurrence' : '',
    pairs.length > 1 && !partial ? `${pairs.length} replacements` : '',
  ];
  return {
    summary,
    body: [
      ...pairs.map(([oldText, newText]) => replacementView(oldText, newText)),
      keyValues(input, ['file_path', 'path', 'old_string', 'new_string', 'replace_all', 'edits']),
      extra.length ? keyValues({ edits: input.edits }) : null,
    ],
  };
}

function search(input) {
  const pattern = field(input, 'pattern', 'query');
  if (pattern === null) return null;
  const path = field(input, 'path');
  return {
    summary: [code(pattern), path === null ? '' : 'in', path === null ? null : code(path)],
    body: [keyValues(input, ['pattern', 'query', 'path'])],
  };
}

function list(input) {
  const path = field(input, 'path') ?? (isObject(input) && Object.keys(input).length === 0 ? '.' : null);
  if (path === null) return null;
  return { summary: [code(path)], body: [keyValues(input, ['path'])] };
}

function agent(input) {
  const prompt = field(input, 'prompt');
  if (prompt === null) return null;
  const head = [field(input, 'subagent_type'), field(input, 'description')].filter(Boolean).join(' · ');
  return { summary: head, body: [block(prompt), keyValues(input, ['prompt', 'subagent_type', 'description'])] };
}

const headline =
  (key, ...shown) =>
  (input) => {
    const value = field(input, key);
    if (value === null) return null;
    return { summary: [code(value)], body: [keyValues(input, [key, ...shown])] };
  };

function webFetch(input) {
  const url = field(input, 'url');
  if (url === null) return null;
  const prompt = field(input, 'prompt');
  return { summary: [code(url)], body: [prompt === null ? null : block(prompt), keyValues(input, ['url', 'prompt'])] };
}

const TODO_MARKS = { completed: '☑', in_progress: '◐', pending: '☐' };
function todos(input, { partial }) {
  if (!Array.isArray(input?.todos) || !input.todos.every((item) => typeof item?.content === 'string')) return null;
  const done = input.todos.filter((item) => item.status === 'completed').length;
  return {
    summary: partial ? '' : `${done} of ${input.todos.length} done`,
    body: [
      h(
        'ul',
        'tool-todos',
        input.todos.map((item) =>
          h(
            'li',
            `tool-todo ${item.status === 'completed' ? 'done' : ''}`.trim(),
            `${Object.hasOwn(TODO_MARKS, item.status) ? TODO_MARKS[item.status] : '•'} ${item.content}`,
          ),
        ),
      ),
    ],
  };
}

function notebook(input) {
  const path = field(input, 'notebook_path');
  if (path === null) return null;
  const source = field(input, 'new_source');
  return {
    summary: [code(path), field(input, 'edit_mode') ?? ''],
    body: [source === null ? null : block(source), keyValues(input, ['notebook_path', 'new_source', 'edit_mode'])],
  };
}

// Codex records a file change as an object keyed by path. A patch string comes from a service that flattened it,
// or from a harness whose patch tool takes the patch text.
function patch(input, { partial = false } = {}) {
  if (typeof input === 'string') {
    const files = [...input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]);
    return { summary: files.join(', '), body: [diffView(input)] };
  }
  const text = field(input, 'input', 'patch');
  if (text !== null) return patch(text);
  if (!isObject(input) || !Object.values(input).every((change) => typeof change?.type === 'string')) return null;
  const entries = Object.entries(input);
  return {
    summary: entries.length === 1 ? [code(entries[0][0])] : partial ? '' : `${entries.length} files`,
    body: entries.map(([path, change]) =>
      h(
        'div',
        'tool-file',
        h(
          'div',
          'tool-file-head',
          h('span', 'tool-change', change.type),
          code(path),
          typeof change.move_path === 'string' ? ['→', code(change.move_path)] : null,
        ),
        typeof change.unified_diff === 'string'
          ? diffView(change.unified_diff)
          : typeof change.content === 'string'
            ? block(change.content)
            : null,
        keyValues(change, ['type', 'unified_diff', 'content', 'move_path']),
      ),
    ),
  };
}

const TOOLS = {
  read,
  Read: read,
  write,
  Write: write,
  edit,
  Edit: edit,
  MultiEdit: edit,
  NotebookEdit: notebook,
  grep: search,
  Grep: search,
  Glob: search,
  find: search,
  glob: search,
  ls: list,
  LS: list,
  Agent: agent,
  Task: agent,
  Skill: headline('skill'),
  WebFetch: webFetch,
  WebSearch: headline('query'),
  web_search: headline('query'),
  ToolSearch: headline('query'),
  TodoWrite: todos,
  apply_patch: patch,
};

// The summary and body of a tool call's view; unknown tools and unexpected arguments show as key-value rows.
// `partial` says the service cut the input for display.
export function toolView(name, rawInput, { partial = false } = {}) {
  const input = toolInputValue(name, rawInput);
  // The name comes from the transcript: an inherited property such as `constructor` must not be taken for a view.
  const view = SHELL_TOOLS.has(name)
    ? shell(input)
    : Object.hasOwn(TOOLS, name)
      ? TOOLS[name](input, { partial })
      : null;
  if (view) return { summary: [view.summary].flat().filter(Boolean), body: view.body.filter(Boolean), input };
  if (typeof input === 'string') return { summary: [], body: [block(input)], input };
  return { summary: [], body: [keyValues(input)].filter(Boolean), input };
}

export const rawInput = (input) => (typeof input === 'string' ? input : json(input));
