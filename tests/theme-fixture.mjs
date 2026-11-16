import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

export const themeSource = readFileSync(new URL('../public/themes.js', import.meta.url), 'utf8');

export function themeFixture(savedTheme, savedFontSize) {
  const { window } = new JSDOM(
    '<!doctype html><meta name="theme-color"><link rel="icon"><button id="reader-settings-trigger"></button><div id="reader-settings" popover="auto"><div id="reader-font-size-options"></div><div id="reader-theme-options"></div></div>',
    {
      url: 'http://localhost',
      runScripts: 'outside-only',
    },
  );
  if (savedTheme != null) window.localStorage.setItem('mu-theme', savedTheme);
  if (savedFontSize != null) window.localStorage.setItem('mu-font-size', savedFontSize);
  const api = window.eval(themeSource);
  return { window, ...api };
}
