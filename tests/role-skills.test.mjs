import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS } from '../src/home.mjs';
import { ROOT } from '../src/server.mjs';

const ROLES = ['team-lead', 'worker'];
const sectionNames = (text) => new Set([...text.matchAll(/`([a-z][a-z0-9-]*\.md)`/g)].map(([, name]) => name));

// init installs only the files in DEFAULTS, and the runner reads only those, so a section that is shipped but not
// listed would be missing from every home, and one listed but not named in SKILL.md would never be read.
test('every section of a role skill is installed, named in its SKILL.md, and names only existing sections', async () => {
  for (const role of ROLES) {
    const directory = join(ROOT, 'skills', role);
    const shipped = (await readdir(directory)).filter((name) => name.endsWith('.md')).sort();
    const listed = DEFAULTS.filter((path) => path.startsWith(`skills/${role}/`))
      .map((path) => path.slice(`skills/${role}/`.length))
      .sort();
    assert.deepEqual(listed, shipped, `${role}: DEFAULTS lists exactly the shipped files`);
    const core = await readFile(join(directory, 'SKILL.md'), 'utf8');
    assert.deepEqual(
      [...sectionNames(core)].sort(),
      shipped.filter((name) => name !== 'SKILL.md'),
      `${role}: SKILL.md names each section`,
    );
    for (const name of shipped) {
      const text = await readFile(join(directory, name), 'utf8');
      for (const named of sectionNames(text)) assert.ok(shipped.includes(named), `${role}/${name} names ${named}`);
      if (name === 'SKILL.md') assert.match(text, new RegExp(`^---\\nname: ${role}\\ndescription: .+\\n---\\n`));
      else assert.match(text, /^# \S/, `${role}/${name} starts with its title and has no front matter`);
    }
  }
});
