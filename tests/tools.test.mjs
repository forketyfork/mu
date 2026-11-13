import test from 'node:test';
import assert from 'node:assert/strict';
import { findHeredocs, layoutShell, rawInput, shellScript, shellView, toolView } from '../public/tools.js';

const text = (view) => (typeof view === 'string' ? view : view.children.map(text).join(''));
const laidOut = (command) =>
  layoutShell(command)
    ?.map((line) => `${'  '.repeat(line.indent)}${line.code}${line.separator}`)
    .join('\n') ?? null;
const find = (view, className) => {
  if (typeof view === 'string') return [];
  return [
    ...(view.className?.split(' ').includes(className) ? [view] : []),
    ...view.children.flatMap((child) => find(child, className)),
  ];
};
const summary = (view) => view.summary.map(text).join(' ');
const body = (view) => view.body.map(text).join('\n');
// Every leaf of a view is a string and every node has only a tag, a class and children: nothing can carry markup.
function assertInert(view) {
  if (typeof view === 'string') return;
  assert.deepEqual(Object.keys(view).sort(), ['children', 'className', 'tag']);
  assert.match(view.tag, /^(?:pre|code|span|div|ul|li)$/);
  view.children.forEach(assertInert);
}

test('a one-line shell command with several statements is laid out one statement per line', () => {
  assert.equal(
    laidOut('cd ..; for d in a b; do for env in x y; do f=$(fd -p "$env.conf" $d | head -1); echo "$f"; done; done'),
    [
      'cd ..;',
      'for d in a b;',
      'do',
      '  for env in x y;',
      '  do',
      '    f=$(fd -p "$env.conf" $d | head -1);',
      '    echo "$f";',
      '  done;',
      'done',
    ].join('\n'),
  );
  assert.equal(
    laidOut('if [ -f x ]; then echo yes; else echo no; fi'),
    ['if [ -f x ];', 'then', '  echo yes;', 'else', '  echo no;', 'fi'].join('\n'),
  );
  assert.equal(
    laidOut('case "$1" in start) run;; *) echo usage;; esac'),
    ['case "$1" in', '  start) run;;', '  *) echo usage;;', 'esac'].join('\n'),
  );
});

test('separators inside quotes, substitutions, expansions, subshells and comments do not split a command', () => {
  assert.equal(
    laidOut(
      "echo \"a; b\"; echo 'c; d'; echo $(a; b); x=${y//;/,}; find . -exec rm {} \\;; (cd a; make); echo `a; b`; echo $'x;y' # trailing; comment",
    ),
    [
      'echo "a; b";',
      "echo 'c; d';",
      'echo $(a; b);',
      'x=${y//;/,};',
      'find . -exec rm {} \\;;',
      '(cd a; make);',
      'echo `a; b`;',
      "echo $'x;y' # trailing; comment",
    ].join('\n'),
  );
  assert.equal(layoutShell("git commit -m 'a; b'"), null);
  assert.equal(layoutShell('ls -la; '), null);
  assert.equal(layoutShell('cd a\nmake; make test'), null, 'a multi-line command is shown as written');
});

test('here-documents are found in command text only, and their frame is dimmed', () => {
  const command = [
    'cat <<-EOF > a.py',
    '\tx = 1',
    '\tEOF',
    'diff <(cat <<A) <(cat <<B)',
    '1',
    'A',
    '2',
    'B',
    'echo done',
  ].join('\n');
  assert.deepEqual(
    findHeredocs(command).map((doc) => [doc.line, doc.start, doc.delimiter, doc.bodyFrom, doc.bodyTo, doc.terminator]),
    [
      [0, 4, 'EOF', 1, 2, 2],
      [3, 11, 'A', 4, 5, 5],
      [3, 22, 'B', 6, 7, 7],
    ],
  );
  assert.deepEqual(findHeredocs('python3 - <<< "print(1)"\necho $((1<<2))\necho "a <<EOF"\nEOF'), []);
  assert.deepEqual(findHeredocs('cat <<EOF'), []);
  assert.deepEqual(
    findHeredocs("python3 - <<'EOF'\nprint(1)").map((doc) => [doc.bodyFrom, doc.bodyTo, doc.terminator]),
    [[1, 2, null]],
  );
  const heredoc = ["git commit -m \"$(cat <<'EOF'", 'Fix <b>it</b>', 'EOF', ')"'].join('\n');
  const view = shellView(heredoc);
  assert.equal(text(view), heredoc, 'the laid-out text is still the command');
  assert.deepEqual(find(view, 'tool-dim').map(text), ["<<'EOF'", 'EOF']);
  assert.deepEqual(find(view, 'tool-heredoc').map(text), ['Fix <b>it</b>']);
  assert.deepEqual(find(shellView('cd x; ls'), 'tool-dim').map(text), [';']);
});

test('a Codex argv is shown as the script its shell runs', () => {
  assert.equal(shellScript(['/bin/zsh', '-lc', 'cd a; ls']), 'cd a; ls');
  assert.equal(shellScript(['bash', '-c', 'pwd']), 'pwd');
  assert.equal(shellScript(['cat', 'README.md']), 'cat README.md');
  assert.equal(shellScript(['bash', '-lc', 'x', 'extra']), 'bash -lc x extra');
});

test('Claude Code tools show their paths, ranges, commands and changes', () => {
  const bash = toolView('Bash', { command: 'npm test; npm run lint', description: 'Run the checks', timeout: 600000 });
  assert.equal(summary(bash), 'Run the checks');
  assert.equal(text(bash.body[0]), 'npm test;\nnpm run lint');
  assert.match(body(bash), /timeout600000/, 'arguments without a place in the view are listed');
  assert.equal(summary(toolView('Read', { file_path: '/p/a.js', offset: 10, limit: 51 })), '/p/a.js lines 10–60');
  assert.equal(summary(toolView('Read', { file_path: '/p/a.js', limit: 20 })), '/p/a.js lines 1–20');
  assert.equal(summary(toolView('Read', { file_path: '/p/a.js', offset: 30 })), '/p/a.js from line 30');
  const writeView = toolView('Write', { file_path: '/p/a.md', content: '# A\nb\n' });
  assert.deepEqual([summary(writeView), body(writeView)], ['/p/a.md 2 lines', '# A\nb\n']);
  assert.equal(
    summary(toolView('Write', { file_path: '/p/a.md', content: '# A\nb\n' }, { partial: true })),
    '/p/a.md',
    'a cut input has no line count',
  );
  const editView = toolView('Edit', { file_path: '/p/a.js', old_string: 'a\nb', new_string: 'c', replace_all: true });
  assert.equal(summary(editView), '/p/a.js every occurrence');
  assert.deepEqual(find(editView.body[0], 'tool-del').map(text), ['-a', '-b']);
  assert.deepEqual(find(editView.body[0], 'tool-add').map(text), ['+c']);
  assert.equal(
    summary(
      toolView('MultiEdit', {
        file_path: '/p/a.js',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      }),
    ),
    '/p/a.js 2 replacements',
  );
  const grep = toolView('Grep', { pattern: 'TODO', path: 'src', output_mode: 'content' });
  assert.deepEqual([summary(grep), body(grep)], ['TODO in src', 'output_modecontent']);
  assert.equal(summary(toolView('Glob', { pattern: '**/*.mjs' })), '**/*.mjs');
  const agentView = toolView('Agent', {
    subagent_type: 'Explore',
    description: 'Find callers',
    prompt: 'Find every caller.',
  });
  assert.deepEqual([summary(agentView), body(agentView)], ['Explore · Find callers', 'Find every caller.']);
  assert.equal(summary(toolView('Skill', { skill: 'ship', args: '--draft' })), 'ship');
  assert.equal(
    summary(
      toolView('TodoWrite', {
        todos: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'in_progress' },
        ],
      }),
    ),
    '1 of 2 done',
  );
  assert.equal(
    body(
      toolView('TodoWrite', {
        todos: [
          { content: 'A', status: 'completed' },
          { content: 'B', status: 'pending' },
        ],
      }),
    ),
    '☑ A☐ B',
  );
});

test('Codex commands, file changes and MCP calls are laid out', () => {
  assert.equal(text(toolView('command', 'cd a && ls; pwd').body[0]), 'cd a && ls;\npwd');
  const change = toolView('apply_patch', {
    '/p/a.txt': { type: 'add', content: 'hello\n' },
    '/p/b.txt': { type: 'update', unified_diff: '@@ -1 +1 @@\n-x\n+y', move_path: '/p/c.txt' },
  });
  assert.equal(summary(change), '2 files');
  assert.deepEqual(find(change.body[1], 'tool-file-head').map(text), ['update/p/b.txt→/p/c.txt']);
  assert.deepEqual(
    [
      find(change.body[1], 'tool-hunk').map(text),
      find(change.body[1], 'tool-del').map(text),
      find(change.body[1], 'tool-add').map(text),
    ],
    [['@@ -1 +1 @@'], ['-x'], ['+y']],
  );
  assert.equal(text(change.body[0]), 'add/p/a.txthello\n');
  assert.equal(
    body(toolView('issue_tracker.get_issue', { id: 'ISSUE-1', fields: ['summary'] })),
    'idISSUE-1fields[\n  "summary"\n]',
  );
});

test('pi tools are laid out, including several replacements in one edit', () => {
  assert.equal(text(toolView('bash', { command: 'ls | wc -l' }).body[0]), 'ls | wc -l');
  assert.equal(text(toolView('bash (user)', 'make').body[0]), 'make');
  assert.equal(summary(toolView('read', { path: 'a.md', offset: 5, limit: 1 })), 'a.md line 5');
  assert.equal(summary(toolView('write', { path: 'a.md', content: 'x' })), 'a.md 1 line');
  const editView = toolView('edit', {
    path: 'a.md',
    edits: [
      { oldText: 'a', newText: 'b' },
      { oldText: 'c', newText: 'd' },
    ],
  });
  assert.equal(summary(editView), 'a.md 2 replacements');
  assert.equal(editView.body.length, 2);
  assert.equal(summary(toolView('find', { pattern: '*.ts', path: 'src' })), '*.ts in src');
});

test('unknown tools and unexpected arguments fall back to key-value rows, and strings to text', () => {
  const malformed = toolView('edit', { path: 'a.md', edits: '[{"oldText":"a"}]' });
  assert.deepEqual([malformed.summary, body(malformed)], [[], 'patha.mdedits[{"oldText":"a"}]']);
  assert.equal(body(toolView('Read', { file_path: 7 })), 'file_path7');
  assert.equal(body(toolView('mystery', 'plain text')), 'plain text');
  assert.equal(body(toolView('mystery', null)), '');
  const long = toolView('mcp__x__y', { note: 'n'.repeat(200) });
  assert.equal(long.body[0].children[0].children[1].tag, 'pre', 'a long value gets a block of its own');
});

test('input from a service that sent JSON text is parsed, except a shell command', () => {
  const legacy = toolView('Read', '{\n  "file_path": "/p/a.js",\n  "limit": 2\n}');
  assert.equal(summary(legacy), '/p/a.js lines 1–2');
  assert.deepEqual(legacy.input, { file_path: '/p/a.js', limit: 2 });
  assert.equal(
    text(toolView('Bash', '{ a; b; }').body[0]),
    '{\n  a;\n  b;\n}',
    'a shell group is not mistaken for JSON',
  );
  assert.equal(
    body(toolView('Read', '{"file_path": "/p/a.js", "con')),
    '{"file_path": "/p/a.js", "con',
    'cut JSON text is shown as it is',
  );
  assert.equal(rawInput({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(rawInput('ls'), 'ls');
});

test('markup in tool input stays text in every view', () => {
  const hostile = '<img src=x onerror="window.injected=true">';
  const views = [
    toolView('Bash', { command: `echo '${hostile}'; cat <<EOF\n${hostile}\nEOF`, description: hostile }),
    toolView('Write', { file_path: hostile, content: hostile }),
    toolView('Edit', { file_path: '/p', old_string: hostile, new_string: hostile }),
    toolView('apply_patch', { [hostile]: { type: hostile, unified_diff: `+${hostile}` } }),
    toolView('TodoWrite', { todos: [{ content: hostile, status: hostile }] }),
    toolView('mystery', { [hostile]: { [hostile]: hostile } }),
  ];
  for (const view of views) {
    [...view.summary, ...view.body].forEach(assertInert);
    assert.ok([...view.summary, ...view.body].map(text).join('').includes(hostile));
  }
});

test('a tool name that is an inherited property is an unknown tool, not a view', () => {
  const forged = {
    summary: [{ tag: 'button', className: 'primary-button', children: ['Approve deploy'] }],
    body: [{ tag: 'script', className: '', children: ['window.ran = true'] }],
  };
  for (const name of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    const view = toolView(name, structuredClone(forged));
    assert.deepEqual(view.summary, [], name);
    [...view.summary, ...view.body].forEach(assertInert);
    assert.match(body(view), /Approve deploy/, `${name}: the forged view is shown as key-value text`);
  }
  assert.equal(
    body(toolView('TodoWrite', { todos: [{ content: 'A', status: 'constructor' }] })),
    '• A',
    'an inherited status is no mark',
  );
});

test('counts are left out while the input is cut, since they would count only its shown part', () => {
  const partial = { partial: true };
  const edits = {
    file_path: '/p/a.js',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' },
    ],
  };
  assert.equal(summary(toolView('MultiEdit', edits)), '/p/a.js 2 replacements');
  assert.equal(summary(toolView('MultiEdit', edits, partial)), '/p/a.js');
  const todos = {
    todos: [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'pending' },
    ],
  };
  assert.equal(summary(toolView('TodoWrite', todos, partial)), '');
  const changes = { '/p/a': { type: 'add', content: 'x' }, '/p/b': { type: 'add', content: 'y' } };
  assert.equal(summary(toolView('apply_patch', changes)), '2 files');
  assert.equal(summary(toolView('apply_patch', changes, partial)), '');
});
