import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { themeFixture } from './theme-fixture.mjs';
import { fixture, settle } from './ui-fixture.mjs';
import { themeValue } from '../public/motion.js';

const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

function expanded(value, tokens, seen = new Set()) {
  return value.replace(/var\(--([a-z0-9-]+)\)/g, (_, name) => {
    assert.ok(Object.hasOwn(tokens, name), `undefined token ${name}`);
    assert.ok(!seen.has(name), `cyclic token ${name}`);
    return expanded(tokens[name], tokens, new Set([...seen, name]));
  });
}

test('every registered theme defines the whole token contract, without unresolved or cyclic references', (t) => {
  const { window, themes } = themeFixture();
  t.after(() => window.close());
  assert.ok(themes.length >= 4);
  assert.equal(new Set(themes.map((theme) => theme.id)).size, themes.length);
  assert.equal(new Set(themes.map((theme) => theme.name)).size, themes.length);
  const required = new Set([...styles.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((match) => match[1]));
  required.delete('glyph'); // Each harness icon supplies its own mask URL; it inherits the theme's color.
  for (const name of ['canvas', 'surface', 'accent', 'muted', 'ink', 'font']) required.delete(`theme-swatch-${name}`);
  for (const kind of ['panel', 'conversation', 'message', 'status', 'expand', 'agent'])
    required.add(`motion-${kind}-duration`);
  for (const name of [
    'panel-opacity',
    'conversation-opacity',
    'message-opacity',
    'message-offset',
    'status-start',
    'status-peak',
    'status-end',
    'easing',
    'origin-radius',
    'dialog-radius',
  ])
    required.add(`motion-${name}`);
  const contract = Object.keys(themes[0].tokens).sort();
  for (const theme of themes) {
    assert.deepEqual(Object.keys(theme.tokens).sort(), contract, theme.name);
    for (const name of required) assert.ok(Object.hasOwn(theme.tokens, name), `${theme.name}: ${name}`);
    for (const [name, value] of Object.entries(theme.tokens)) {
      assert.equal(typeof value, 'string', `${theme.name}: ${name}`);
      assert.ok(value.trim(), `${theme.name}: empty ${name}`);
      expanded(value, theme.tokens);
    }
  }
});

test('component styles get colors, typography, corners, shadows and spacing accents from tokens', () => {
  assert.doesNotMatch(styles, /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
  assert.doesNotMatch(
    styles,
    /(?:font-family|font-size|font-weight|letter-spacing|box-shadow|text-shadow):\s*(?!var\(|inherit|none|normal|0[;\s])[\w'-]/,
  );
  assert.doesNotMatch(styles, /border-radius:\s*\d+(?:\.\d+)?px/);
  assert.doesNotMatch(styles.replace(/var\(--[a-z0-9-]+\)/g, 'TOKEN'), /(?:padding|margin|gap)(?:-[a-z]+)?:[^;]*\d+px/);
  assert.doesNotMatch(html, /#[\da-f]{6}\b/i);
});

test('the saved theme and text size apply in the head before styles or application startup', (t) => {
  const { window, themes } = themeFixture('seed-2533678612', 'largest');
  t.after(() => window.close());
  const root = window.document.documentElement;
  assert.equal(root.dataset.theme, 'seed-2533678612');
  assert.equal(root.dataset.fontSize, 'largest');
  assert.equal(root.style.getPropertyValue('--accent'), themes[1].tokens.accent);
  assert.equal(
    root.style.getPropertyValue('--font-size-16px'),
    `${Number((Number.parseFloat(themes[1].tokens['font-size-16px']) * 1.2).toFixed(3))}px`,
  );
  assert.equal(
    window.document.getElementById('reader-font-size-options').children.length,
    0,
    'body initialization has not run',
  );
  const script = /<script src="\/themes.js"><\/script>/.exec(html);
  assert.ok(script, 'a synchronous external script works under the service CSP');
  assert.ok(script.index < html.indexOf('rel="stylesheet"'));
  assert.ok(script.index < html.indexOf('<body>'));
});

test('missing or obsolete saved preferences use the original theme and smaller text', (t) => {
  for (const [savedTheme, savedFontSize] of [
    [undefined, undefined],
    ['removed-theme', 'not-a-size'],
    ['constructor', '__proto__'],
  ]) {
    const { window } = themeFixture(savedTheme, savedFontSize);
    t.after(() => window.close());
    assert.equal(window.document.documentElement.dataset.theme, 'original');
    assert.equal(window.document.documentElement.dataset.fontSize, 'smaller');
    assert.equal(window.document.documentElement.style.getPropertyValue('--accent'), '#75f6db');
    assert.equal(window.document.documentElement.style.getPropertyValue('--font-size-16px'), '14.4px');
  }
});

test('theme swatches apply and persist every theme while retaining its saved text size', async (t) => {
  const { window, themes, storageKey, fontSizeStorageKey } = themeFixture(undefined, 'largest');
  t.after(() => window.close());
  await settle();
  const radios = Array.from(window.document.querySelectorAll('#reader-theme-options input[type="radio"]'));
  assert.deepEqual(
    radios.map((radio) => radio.value),
    Array.from(themes, (theme) => theme.id),
  );
  assert.deepEqual(
    radios.map((radio) => radio.getAttribute('aria-label')),
    Array.from(themes, (theme) => theme.name),
  );
  assert.deepEqual(
    radios.map((radio) => radio.title),
    Array.from(themes, (theme) => theme.name),
  );
  const document = window.document;
  const location = window.location.href;
  for (const theme of themes) {
    const radio = radios.find((choice) => choice.value === theme.id);
    radio.checked = true;
    radio.dispatchEvent(new window.Event('change'));
    assert.equal(window.document, document);
    assert.equal(window.location.href, location);
    assert.equal(document.documentElement.dataset.theme, theme.id);
    assert.equal(document.documentElement.dataset.fontSize, 'largest');
    assert.equal(window.localStorage.getItem(storageKey), theme.id);
    assert.equal(document.querySelector('meta[name="theme-color"]').content, theme.tokens['browser-surface']);
    assert.ok(
      decodeURIComponent(document.querySelector('link[rel="icon"]').href).includes(theme.tokens['favicon-surface']),
    );
    for (const [name, value] of Object.entries(theme.tokens)) {
      const expected = name.startsWith('font-size-')
        ? value.replace(
            /^(\d+(?:\.\d+)?)(px|em)$/,
            (_, amount, unit) => `${Number((Number(amount) * 1.2).toFixed(3))}${unit}`,
          )
        : value;
      assert.equal(document.documentElement.style.getPropertyValue(`--${name}`), expected);
    }
    const restored = themeFixture(
      window.localStorage.getItem(storageKey),
      window.localStorage.getItem(fontSizeStorageKey),
    );
    assert.equal(restored.window.document.documentElement.dataset.theme, theme.id);
    assert.equal(restored.window.document.documentElement.dataset.fontSize, 'largest');
    restored.window.close();
  }
});

test('text size buttons apply, persist and restore a readable dashboard scale', async (t) => {
  const { window, fontSizes, fontSizeStorageKey } = themeFixture();
  t.after(() => window.close());
  await settle();
  const buttons = Array.from(window.document.querySelectorAll('#reader-font-size-options button'));
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    Array.from(fontSizes, () => 'A'),
  );
  assert.deepEqual(
    buttons.map((button) => button.dataset.fontSize),
    Array.from(fontSizes, (size) => size.id),
  );
  assert.deepEqual(
    buttons.map((button) => button.getAttribute('aria-label')),
    Array.from(fontSizes, (size) => `${size.label} text size`),
  );
  for (const size of fontSizes) {
    const button = buttons.find((choice) => choice.dataset.fontSize === size.id);
    button.click();
    assert.equal(window.document.documentElement.dataset.fontSize, size.id);
    assert.equal(window.localStorage.getItem(fontSizeStorageKey), size.id);
    assert.equal(
      window.document.documentElement.style.getPropertyValue('--font-size-16px'),
      `${Number((16 * size.scale).toFixed(3))}px`,
    );
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(buttons.filter((choice) => choice.getAttribute('aria-pressed') === 'true').length, 1);
    const restored = themeFixture(
      window.localStorage.getItem('mu-theme'),
      window.localStorage.getItem(fontSizeStorageKey),
    );
    assert.equal(restored.window.document.documentElement.dataset.fontSize, size.id);
    restored.window.close();
  }
});

test('the native settings popup exposes keyboard controls and cancels motion on theme changes', async (t) => {
  const { window, $, click, animations } = await fixture(t);
  const trigger = $('#reader-settings-trigger');
  assert.equal(trigger.getAttribute('aria-label'), 'Reading settings');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal($('#reader-settings').getAttribute('popover'), 'auto');
  const radios = Array.from(window.document.querySelectorAll('#reader-theme-options input[type="radio"]'));
  assert.equal(radios.length, 4);
  assert.ok(radios.every((radio) => radio.tabIndex >= 0));
  click('[data-view="chat"]');
  assert.equal(animations.length, 1);
  radios[1].checked = true;
  radios[1].dispatchEvent(new window.Event('change'));
  assert.equal(window.document.documentElement.dataset.theme, 'seed-2533678612');
  assert.equal(animations[0].cancelled, true);
  radios[3].checked = true;
  radios[3].dispatchEvent(new window.Event('change'));
  assert.equal(window.document.documentElement.dataset.theme, 'seed-7024703569');
  assert.equal(window.localStorage.getItem('mu-theme'), 'seed-7024703569');
  assert.equal(radios[3].checked, true);
});

test('theme and font size changes in another tab and storage clears update the dashboard', async (t) => {
  const { window, storageKey, fontSizeStorageKey } = themeFixture();
  t.after(() => window.close());
  await settle();
  const setStored = (key, newValue) => {
    if (newValue === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, newValue);
    window.dispatchEvent(new window.StorageEvent('storage', { key, newValue, storageArea: window.localStorage }));
  };
  setStored(storageKey, 'seed-7024703569');
  assert.equal(window.document.documentElement.dataset.theme, 'seed-7024703569');
  setStored(fontSizeStorageKey, 'largest');
  assert.equal(window.document.documentElement.dataset.fontSize, 'largest');
  setStored(storageKey, null);
  assert.equal(window.document.documentElement.dataset.theme, 'original');
  assert.equal(window.document.documentElement.dataset.fontSize, 'largest');
  window.localStorage.clear();
  window.dispatchEvent(
    new window.StorageEvent('storage', { key: null, newValue: null, storageArea: window.localStorage }),
  );
  assert.equal(window.document.documentElement.dataset.theme, 'original');
  assert.equal(window.document.documentElement.dataset.fontSize, 'smaller');
});

function luminance(hex) {
  const linear = hex
    .slice(1, 7)
    .match(/../g)
    .map((part) => parseInt(part, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return linear.reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function oklab(hex) {
  const [red, green, blue] = hex
    .slice(1, 7)
    .match(/../g)
    .map((part) => parseInt(part, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

test('all six status color families remain perceptually separated while meeting AA contrast', (t) => {
  const { window, themes } = themeFixture();
  t.after(() => window.close());
  const statuses = ['idle', 'working', 'blocked', 'done', 'stopped', 'error'];
  for (const theme of themes.slice(1)) {
    for (const status of statuses) {
      assert.ok(
        contrast(theme.tokens[`status-${status}-ink`], theme.tokens[`status-${status}-surface`]) >= 4.5,
        `${theme.name} ${status}: AA contrast`,
      );
    }
    for (const group of [
      statuses.map((status) => `status-${status}-ink`),
      ['task-status-ink', 'task-status-ready-ink', 'task-status-verified-ink'],
      ['green', 'task-square-ready-surface', 'task-square-archived-surface'],
    ]) {
      for (const [index, first] of group.entries()) {
        for (const second of group.slice(index + 1)) {
          const one = oklab(theme.tokens[first]);
          const two = oklab(theme.tokens[second]);
          const distance = Math.hypot(...one.map((channel, at) => channel - two[at]));
          // A 0.1 OKLab distance excludes nearby shades that differ only numerically.
          assert.ok(distance >= 0.1, `${theme.name} ${first}/${second}: OKLab distance ${distance.toFixed(3)}`);
        }
      }
    }
  }
});

test('new themes keep text, controls, statuses and transcript colors at AA contrast', (t) => {
  const { window, themes } = themeFixture();
  t.after(() => window.close());
  const pairs = [
    ['ink', 'canvas'],
    ['muted', 'surface'],
    ['subtle', 'surface'],
    ['accent', 'canvas'],
    ['button-primary-ink', 'accent'],
    ['send-button-ink', 'send-button-surface'],
    ['button-secondary-ink', 'button-secondary-surface'],
    ['rail-badge-ink', 'rail-badge-surface'],
    ['conversation-browser-summary-ink', 'conversation-browser-summary-surface'],
    ['conversation-option-selected-ink', 'conversation-option-selected-surface'],
    ['message-id-ink', 'chat-pane-surface'],
    ['message-time-ink', 'chat-pane-surface'],
    ['metric-list-task-ref-ink', 'markdown-body-code-surface'],
    ['transcript-pre-ink', 'transcript-pre-surface'],
    ['amber', 'transcript-pre-surface'],
    ['green', 'transcript-pre-surface'],
    ['red', 'transcript-pre-surface'],
    ['agent-dialog-input-ink', 'agent-dialog-input-surface'],
    ['task-status-ink', 'task-status-surface'],
    ['task-status-ready-ink', 'task-status-ready-surface'],
    ['task-status-verified-ink', 'task-status-verified-surface'],
  ];
  for (const status of ['idle', 'working', 'blocked', 'done', 'stopped', 'error'])
    pairs.push([`status-${status}-ink`, `status-${status}-surface`]);
  for (const theme of themes.slice(1)) {
    for (const [foreground, background] of pairs) {
      const ratio = contrast(theme.tokens[foreground], theme.tokens[background]);
      assert.ok(ratio >= 4.5, `${theme.name} ${foreground}/${background}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test('motion reads the active theme and reports a missing token explicitly', (t) => {
  const { window, apply, themes } = themeFixture();
  t.after(() => window.close());
  const root = window.document.documentElement;
  assert.equal(themeValue(root, 'motion-message-duration'), '220ms');
  apply(themes[1].id);
  assert.equal(themeValue(root, 'motion-message-duration'), themes[1].tokens['motion-message-duration']);
  assert.notEqual(themeValue(root, 'motion-message-duration'), '220ms');
  root.style.removeProperty('--motion-message-duration');
  assert.throws(() => themeValue(root, 'motion-message-duration'), /Missing theme token: motion-message-duration/);
});
