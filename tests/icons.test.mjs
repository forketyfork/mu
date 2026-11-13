import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

test('every vendored glyph that the stylesheet references exists and is a static SVG', async () => {
  const files = [...css.matchAll(/--glyph: url\(['"]?(icons\/[a-z-]+\.svg)['"]?\)/g)].map((match) => match[1]);
  assert.ok(files.length >= 6);
  for (const file of files) {
    await access(new URL(`../public/${file}`, import.meta.url));
    const svg = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(svg, /<svg[\s>]/);
    assert.doesNotMatch(svg, /<script|onload|href=/i, `${file} stays static`);
  }
});
