// The list of agents that opens while the user types an `@name` in the message box, as in a code editor: ↑/↓ move,
// Enter or Tab pick, Esc closes. The textarea keeps the focus throughout and is the combobox; the list is its
// listbox, and `aria-activedescendant` names the highlighted option.
//
// The list never takes a key it has no use for. It owns Enter, Tab, Esc and the vertical arrows only while it is open,
// so with the list closed Enter still sends and Tab still moves on. Only typing opens it; moving the caret into a name
// updates or closes an open list but never opens one.

import { filterMentionEntries, mentionTrigger } from './model.js';

let nextId = 0;

/**
 * @param {{
 *   input: HTMLTextAreaElement,
 *   list: HTMLElement,
 *   entries: () => { id: string, hint: string }[],
 *   name: (id: string) => HTMLElement,
 *   accept?: (value: string) => boolean,
 *   onOpen?: () => void,
 * }} options
 *   `entries` lists everyone that can be mentioned at the moment. `name` draws the mention of an agent or `@all` as an element. `accept` may refuse the
 *   text a pick would produce, and must tell the user why. `onOpen` runs when the list opens.
 */
export function createMentionAutocomplete({ input, list, entries, name, accept = () => true, onOpen = () => {} }) {
  const doc = input.ownerDocument;
  const uid = `mention-suggestions-${(nextId += 1)}`;
  let shown = [];
  let active = 0;
  let trigger = null;

  list.id = list.id || uid;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Mention suggestions');
  list.hidden = true;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  // Pressing the list, its scrollbar included, must not take the focus from the text.
  list.addEventListener('mousedown', (event) => event.preventDefault());

  const isOpen = () => !list.hidden;

  function close() {
    shown = [];
    trigger = null;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function highlight(index) {
    active = (index + shown.length) % shown.length;
    list.querySelectorAll('[role="option"]').forEach((option, position) => {
      option.setAttribute('aria-selected', String(position === active));
    });
    const option = list.children[active];
    input.setAttribute('aria-activedescendant', option.id);
    option.scrollIntoView?.({ block: 'nearest' });
  }

  function pick(index) {
    const entry = shown[index];
    const { start, end } = trigger;
    const value = input.value;
    const spaced = /^\s/.test(value.slice(end));
    const inserted = `@${entry.id}${spaced ? '' : ' '}`;
    const next = value.slice(0, start) + inserted + value.slice(end);
    if (!accept(next)) {
      close();
      return;
    }
    input.value = next;
    const caret = start + inserted.length + (spaced ? 1 : 0);
    input.setSelectionRange(caret, caret);
    close();
    // The page counts the bytes and keeps the draft on `input`.
    input.dispatchEvent(
      new /** @type {Window & typeof globalThis} */ (doc.defaultView).Event('input', { bubbles: true }),
    );
  }

  function show(found, query) {
    const opening = !isOpen();
    shown = filterMentionEntries(found, query);
    if (!shown.length) {
      close();
      return;
    }
    list.replaceChildren(
      ...shown.map((entry, index) => {
        const option = doc.createElement('div');
        option.className = 'mention-option';
        option.id = `${list.id}-${entry.id}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', 'false');
        const label = name(entry.id);
        const hint = doc.createElement('span');
        hint.textContent = entry.hint;
        option.append(label, hint);
        option.addEventListener('click', () => pick(index));
        // The pointer moves the highlight, so that the list never shows two rows lit: one for the mouse, one for the keys.
        option.addEventListener('mousemove', () => active === index || highlight(index));
        return option;
      }),
    );
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlight(Math.min(active, shown.length - 1));
    if (opening) onOpen();
  }

  // `opening` is true after typing, which may open the list, and false after a caret move, which may only change or
  // close an open one.
  function refresh(opening) {
    if (!opening && !isOpen()) return;
    const found =
      input.selectionStart === input.selectionEnd ? mentionTrigger(input.value, input.selectionStart) : null;
    if (!found) {
      close();
      return;
    }
    // A new word starts at the top of the list; the same word keeps the highlight while it is narrowed or widened.
    if (!trigger || trigger.start !== found.start) active = 0;
    trigger = found;
    show(entries(), found.query);
  }

  input.addEventListener('input', (event) => {
    if (/** @type {InputEvent} */ (event).isComposing) return;
    refresh(true);
  });
  input.addEventListener('compositionend', () => refresh(true));
  input.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) refresh(false);
  });
  input.addEventListener('click', () => refresh(false));
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (event) => {
    if (!isOpen() || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') highlight(active + (event.key === 'ArrowDown' ? 1 : -1));
    else if (event.key === 'Enter' && !event.shiftKey) pick(active);
    else if (event.key === 'Tab' && !event.shiftKey) pick(active);
    else if (event.key === 'Escape') close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  return { close, isOpen, refresh: () => refresh(false) };
}
