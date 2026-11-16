import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Mu has no build step: the service imports its dependencies from node_modules and serves some of them to the
// dashboard as they are published. node_modules is untracked, so a merge that changes package-lock.json leaves it
// behind. Node reports a package that the service imports and cannot find. Nothing reports a package that only the
// browser loads, or one that is installed in another version: the service starts, and a part of the dashboard gets
// "not found" for its libraries. This check compares what is installed with the lockfile.

const read = async (file) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${file}: ${error.message}`, { cause: error });
  }
};

/**
 * A sentence that says what `npm ci` would change in a checkout, or null when the installed packages are the ones of
 * its lockfile. npm records what it installed in `node_modules/.package-lock.json`, in the format of the lockfile.
 * @param {string} root
 * @param {{ dev?: boolean }} [options] `dev` includes the packages that only development needs.
 */
export async function dependencyError(root, { dev = false } = {}) {
  const lock = await read(join(root, 'package-lock.json'));
  // A checkout without a lockfile declares nothing to install.
  if (!lock) return null;
  const installed = (await read(join(root, 'node_modules', '.package-lock.json')))?.packages ?? {};
  const wrong = [];
  for (const [path, wanted] of Object.entries(lock.packages ?? {})) {
    // Not installed packages: the checkout itself, a linked workspace, and a package for another platform.
    if (!path.startsWith('node_modules/') || wanted.link || wanted.optional) continue;
    if (!dev && (wanted.dev || wanted.devOptional)) continue;
    const found = installed[path]?.version;
    if (found !== wanted.version)
      wrong.push(`${path.slice('node_modules/'.length)} ${wanted.version}${found ? ` (installed: ${found})` : ''}`);
  }
  if (!wrong.length) return null;
  return `The packages in ${join(root, 'node_modules')} are not the ones of package-lock.json: ${wrong.length} ${wrong.length === 1 ? 'is' : 'are'} missing or in another version (${wrong.slice(0, 5).join(', ')}${wrong.length > 5 ? ', …' : ''}). Run \`npm ci\` in ${root}.`;
}
