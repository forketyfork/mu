// Draws a patch block: the files of a `git diff`, each with its hunks, as rows with the old and the new line number.
// Every path and every line is an author's text, so all of it is set as text, element by element; a character that a
// reader would not see is drawn as a badge with its code point. A line number is a button that offers a comment on
// that line; the frame's marks module reports it. See "Code reviews" in docs/architecture.md.

/**
 * @typedef {import('../../src/visual-patch.mjs').Patch} Patch
 * @typedef {import('../../src/visual-patch.mjs').PatchFile} PatchFile
 * @typedef {import('../../src/visual-patch.mjs').PatchLine} PatchLine
 */

const SIGNS = { context: ' ', add: '+', delete: '-' };

/** What the head of a file says besides its path. */
export function fileNotes(file) {
  const notes = [];
  if (file.status === 'added') notes.push('new file');
  else if (file.status === 'deleted') notes.push('deleted');
  else if (file.status === 'renamed') notes.push(`renamed from ${file.oldPath}`);
  else if (file.status === 'copied') notes.push(`copied from ${file.oldPath}`);
  if (file.oldMode !== undefined) notes.push(`mode ${file.oldMode} → ${file.newMode}`);
  if (file.binary) notes.push('binary, not shown');
  return notes;
}

/**
 * @param {object} options
 * @param {Document} options.document
 * @param {(text: string) => Patch} options.parsePatch
 * @param {(text: string) => { text: string, unseen: boolean }[]} options.visibleParts
 */
export function createPatches({ document, parsePatch, visibleParts }) {
  const element = (tag, className, text) => {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };
  // Text of the author with every unseen character as a badge.
  const visible = (target, text) => {
    for (const part of visibleParts(text))
      target.append(part.unseen ? element('span', 'patch-unseen', part.text) : document.createTextNode(part.text));
  };

  /**
   * @param {PatchFile} file
   * @param {PatchLine} line
   * @param {'old' | 'new'} side
   */
  function gutter(file, line, side) {
    const cell = element('td', `patch-number ${side}`);
    const number = line[side];
    if (number === null) return cell;
    // The number is drawn by the style sheet from the attribute, so it is no text of the block: a quote of selected
    // lines holds only their code.
    const button = element('button', 'patch-gutter');
    button.type = 'button';
    button.dataset.side = side;
    button.dataset.number = String(number);
    button.setAttribute('aria-label', `Comment on ${side === 'old' ? 'old ' : ''}line ${number} of ${file.path}`);
    cell.append(button);
    return cell;
  }

  /** @param {PatchFile} file */
  function fileElement(file) {
    const item = element('section', 'patch-file');
    item.dataset.status = file.status;
    const head = element('header', 'patch-file-head');
    head.append(element('span', 'patch-path', file.path));
    for (const note of fileNotes(file)) head.append(element('span', 'patch-note', note));
    item.append(head);
    if (!file.hunks.length) return item;
    const table = element('table', 'patch-lines');
    const body = element('tbody');
    for (const hunk of file.hunks) {
      const row = element('tr', 'patch-hunk-head');
      const cell = element('td');
      cell.colSpan = 3;
      cell.append(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
      if (hunk.heading) {
        const heading = element('span', 'patch-heading');
        visible(heading, hunk.heading);
        cell.append(' ', heading);
      }
      row.append(cell);
      body.append(row);
      for (const line of hunk.lines) {
        const lineRow = element('tr', `patch-line ${line.kind}`);
        lineRow.dataset.path = file.path;
        if (line.old !== null) lineRow.dataset.old = String(line.old);
        if (line.new !== null) lineRow.dataset.new = String(line.new);
        const code = element('td', `patch-code${line.noNewline ? ' no-newline' : ''}`);
        code.dataset.sign = SIGNS[line.kind];
        visible(code, line.text);
        // A line ends in a line break, so a quote of several lines keeps them apart.
        code.append('\n');
        lineRow.append(gutter(file, line, 'old'), gutter(file, line, 'new'), code);
        body.append(lineRow);
      }
    }
    table.append(body);
    const scroll = element('div', 'patch-scroll');
    scroll.append(table);
    item.append(scroll);
    return item;
  }

  return {
    /**
     * @param {HTMLElement} figure
     * @param {{ text: string }} block
     */
    render(figure, block) {
      const { files } = parsePatch(block.text);
      figure.replaceChildren(...files.map(fileElement));
    },
  };
}
