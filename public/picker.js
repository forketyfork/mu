// A picker is the dashboard's replacement for a native <select>, drawn like the Conversations dropdown.
// The <select> stays in the document, visually hidden, and remains the form control: `value`, `disabled`, `required`,
// FormData, `form.reset()`, `labels` and the `input`/`change` events work exactly as before, so code written for a
// <select> needs no change. The picker is a view over it and follows every change made to the select.
//
// Keyboard follows the native control. Closed: Arrow Up/Down, Home/End and typing a letter change the value at once;
// Enter, Space and Alt+Arrow open the list. Open: the arrows, Home/End, Page Up/Down and typing move the highlight;
// Enter, Space and Tab choose it; Escape closes the list without a change. Focus never leaves the trigger.
// <optgroup> is not drawn: the dashboard has none.

const typeaheadReset = 700;
const pageStep = 10;
let nextId = 0;

function labelText(select) {
  const explicit = select.getAttribute('aria-label');
  if (explicit) return explicit;
  const label = select.labels?.[0];
  if (!label) throw new Error(`Select #${select.id} needs a label or an aria-label to become a picker`);
  const copy = label.cloneNode(true);
  copy.querySelectorAll('select, .picker, .field-hint').forEach((element) => element.remove());
  return copy.textContent.trim();
}

export function enhanceSelect(select) {
  const doc = select.ownerDocument;
  const view = doc.defaultView;
  if (!select.id) throw new Error('A select needs an id to become a picker');
  if (select.multiple || select.size > 1)
    throw new Error(`Select #${select.id} is a list box; a picker replaces a drop-down select only`);
  if (select.closest('.picker')) return;

  const uid = `${select.id}-${(nextId += 1)}`;
  const element = (tag, className) => Object.assign(doc.createElement(tag), { className });
  const root = element('span', 'picker');
  const trigger = element('button', 'picker-trigger');
  const valueLabel = element('span', 'picker-value');
  const list = element('div', 'picker-list');
  trigger.type = 'button';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${uid}-list`);
  trigger.setAttribute('aria-label', labelText(select));
  trigger.append(valueLabel);
  list.id = `${uid}-list`;
  list.hidden = true;
  // Pressing the list, its scrollbar included, must not take focus from the trigger.
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', labelText(select));

  select.before(root);
  select.classList.add('picker-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  root.append(select, trigger, list);

  const valueDescriptor = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value');
  const indexDescriptor = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'selectedIndex');
  let rows = [];
  let active = -1;
  let open = false;
  let typed = '';
  let typedTimer;

  const enabled = (index) => index >= 0 && index < select.options.length && !select.options[index].disabled;
  const firstEnabled = (from, step) => {
    for (let index = from; index >= 0 && index < select.options.length; index += step) if (enabled(index)) return index;
    return -1;
  };

  function setActive(index) {
    if (!enabled(index)) return;
    active = index;
    rows.forEach((row, at) => row.classList.toggle('active', at === index));
    trigger.setAttribute('aria-activedescendant', rows[index].id);
    rows[index].scrollIntoView({ block: 'nearest' });
  }

  function sync() {
    const selected = select.selectedIndex;
    valueLabel.textContent = selected >= 0 ? select.options[selected].text : '';
    trigger.disabled = select.disabled;
    rows = Array.from(select.options, (option, index) => {
      const row = element('div', 'picker-option');
      row.id = `${uid}-option-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === selected));
      row.classList.toggle('selected', index === selected);
      if (option.disabled) row.setAttribute('aria-disabled', 'true');
      row.textContent = option.text;
      row.addEventListener('click', () => {
        if (!enabled(index)) return;
        choose(index);
        close();
        trigger.focus();
      });
      row.addEventListener('mousemove', () => {
        if (active !== index) setActive(index);
      });
      return row;
    });
    list.replaceChildren(...rows);
    if (select.disabled && open) close();
    else if (open) setActive(enabled(active) ? active : selected);
  }

  function choose(index) {
    if (!enabled(index) || index === select.selectedIndex) return;
    indexDescriptor.set.call(select, index);
    sync();
    select.dispatchEvent(new view.Event('input', { bubbles: true }));
    select.dispatchEvent(new view.Event('change', { bubbles: true }));
  }

  function place() {
    const box = trigger.getBoundingClientRect();
    const room = { below: view.innerHeight - box.bottom - 16, above: box.top - 16 };
    const wanted = Math.min(list.scrollHeight + 2, 340);
    const below = room.below >= wanted || room.below >= room.above;
    // A list may be wider than its trigger (CSS min-width), and must still fit inside the window.
    const width = Math.max(box.width, Number.parseFloat(view.getComputedStyle(list).minWidth) || 0);
    const left = Math.max(8, Math.min(box.left, view.innerWidth - width - 8));
    Object.assign(list.style, {
      left: `${left}px`,
      width: `${width}px`,
      maxHeight: `${Math.max(120, Math.min(340, below ? room.below : room.above))}px`,
      top: below ? `${box.bottom + 6}px` : '',
      bottom: below ? '' : `${view.innerHeight - box.top + 6}px`,
    });
  }

  const reposition = (event) => {
    if (event.target !== list) place();
  };

  function show() {
    if (open || select.disabled) return;
    sync();
    open = true;
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    list.hidden = false;
    place();
    setActive(enabled(select.selectedIndex) ? select.selectedIndex : firstEnabled(0, 1));
    view.addEventListener('resize', reposition);
    view.addEventListener('scroll', reposition, true);
    doc.addEventListener('pointerdown', outside, true);
  }

  function close() {
    if (!open) return;
    open = false;
    root.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    list.hidden = true;
    view.removeEventListener('resize', reposition);
    view.removeEventListener('scroll', reposition, true);
    doc.removeEventListener('pointerdown', outside, true);
  }

  function outside(event) {
    if (!root.contains(event.target)) close();
  }

  // Typing matches option text by prefix; the same letter again steps through the options that start with it.
  function typeahead(character) {
    view.clearTimeout(typedTimer);
    typedTimer = view.setTimeout(() => {
      typed = '';
    }, typeaheadReset);
    typed += character;
    const cycling = [...typed].every((letter) => letter === typed[0]);
    const prefix = (cycling ? typed[0] : typed).toLowerCase();
    const current = open ? active : select.selectedIndex;
    const start = cycling ? current + 1 : current;
    const order = Array.from(select.options, (_, index) => index);
    const match = [...order.slice(start), ...order.slice(0, start)].find(
      (index) => enabled(index) && select.options[index].text.trim().toLowerCase().startsWith(prefix),
    );
    if (match === undefined) return;
    if (open) setActive(match);
    else choose(match);
  }

  function move(step) {
    const from = open ? active : select.selectedIndex;
    const target = firstEnabled(from + step, step);
    if (target < 0) return;
    if (open) setActive(target);
    else choose(target);
  }

  function jump(last) {
    const target = last ? firstEnabled(select.options.length - 1, -1) : firstEnabled(0, 1);
    if (target < 0) return;
    if (open) setActive(target);
    else choose(target);
  }

  trigger.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey) return;
    const { key } = event;
    if (key === 'Enter' || key === ' ') {
      if (key === ' ' && typed) {
        typeahead(' ');
        event.preventDefault();
        return;
      }
      event.preventDefault();
      if (!open) show();
      else {
        choose(active);
        close();
      }
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      if (event.altKey) {
        if (!open) show();
        else if (key === 'ArrowUp') {
          choose(active);
          close();
        }
      } else move(key === 'ArrowDown' ? 1 : -1);
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault();
      jump(key === 'End');
    } else if (key === 'PageDown' || key === 'PageUp') {
      event.preventDefault();
      if (open) move(key === 'PageDown' ? pageStep : -pageStep);
    } else if (key === 'Escape' && open) {
      // The dialog around the picker must stay open: this Escape only closes the list.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (key === 'Tab' && open) {
      choose(active);
      close();
    } else if (key.length === 1 && !event.altKey) {
      event.preventDefault();
      typeahead(key);
    }
  });
  // A button clicks on Space at key release; the keydown already acted, so the release must not act again.
  trigger.addEventListener('keyup', (event) => {
    if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
  });
  trigger.addEventListener('click', () => {
    if (open) close();
    else show();
  });
  trigger.addEventListener('blur', close);
  // A label or the form's focus handling reaches the hidden select; focus belongs on the visible trigger.
  select.addEventListener('focus', () => trigger.focus());
  // Browser validation reports an invalid control by focusing it.
  select.addEventListener('invalid', () => trigger.focus());
  select.form?.addEventListener('reset', () => view.setTimeout(sync));

  /** @type {[string, PropertyDescriptor][]} */
  const forwarded = [
    ['value', valueDescriptor],
    ['selectedIndex', indexDescriptor],
  ];
  for (const [name, descriptor] of forwarded) {
    Object.defineProperty(select, name, {
      configurable: true,
      get() {
        return descriptor.get.call(this);
      },
      set(next) {
        descriptor.set.call(this, next);
        sync();
      },
    });
  }
  new view.MutationObserver(sync).observe(select, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['disabled', 'label', 'selected', 'value'],
  });
  sync();
}

export function enhanceSelects(root) {
  for (const select of root.querySelectorAll('select')) enhanceSelect(select);
}

// A choice made at run time gets its select here, so no select is ever shown native. The select goes into `parent`,
// which must be able to hold the picker that replaces it.
export function createPicker(parent, { id, label, options, value }) {
  const doc = parent.ownerDocument;
  const select = doc.createElement('select');
  select.id = id;
  select.setAttribute('aria-label', label);
  for (const [optionValue, text] of options)
    select.append(Object.assign(doc.createElement('option'), { value: optionValue, textContent: text }));
  select.value = value;
  parent.append(select);
  enhanceSelect(select);
  return select;
}
