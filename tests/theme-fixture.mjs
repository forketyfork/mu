import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

export const themeSource = readFileSync(new URL('../public/themes.js', import.meta.url), 'utf8');

export function themeFixture(saved) {
  const { window } = new JSDOM(
    '<!doctype html><meta name="theme-color"><link rel="icon"><select id="theme-picker" aria-label="Theme"></select>',
    {
      url: 'http://localhost',
      runScripts: 'outside-only',
    },
  );
  if (saved != null) window.localStorage.setItem('mu-theme', saved);
  const api = window.eval(themeSource);
  return { window, ...api };
}
