import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathIsWithin, pathsOverlap } from './paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MANIFEST_VERSION = 1;

export const DEFAULTS = Object.freeze(['skills/team-lead/SKILL.md', 'skills/worker/SKILL.md']);

export const SEEDS = Object.freeze({
  'projects.md': '# Projects\n\nList the project checkouts and local clones used by this Mu home.\n',
  'memory/lead/MEMORY.md':
    '# Lead memory\n\nRecord durable facts here, including the user’s name and preferences, and link to one file per fact.\n',
});
const SEED_PATHS = Object.freeze([...Object.keys(SEEDS), 'config.json']);

function errorCode(error) {
  return /** @type {NodeJS.ErrnoException} */ (error).code;
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function assertText(bytes, path) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${path} is not valid UTF-8 text`);
  return text;
}

/** Resolve the separate Mu home without consulting or changing the runtime data directory. */
export function resolveHome(env = process.env, userHome = homedir()) {
  if (env.MU_HOME !== undefined && !env.MU_HOME.trim()) throw new Error('MU_HOME must not be empty.');
  return resolve(env.MU_HOME ?? join(env.HOME || userHome, '.mu'));
}

function overridden(env, name) {
  if (env[name] !== undefined && !env[name].trim()) throw new Error(`${name} must not be empty.`);
  return env[name] !== undefined;
}

// The service's runtime state: the database, credentials, sockets, pi directories, dreams and brag pages.
export function resolveDataDir(env = process.env, home = resolveHome(env)) {
  return resolve(overridden(env, 'MU_DATA_DIR') ? env.MU_DATA_DIR : join(home, 'data'));
}

export function resolveConfigFile(env = process.env, home = resolveHome(env)) {
  return resolve(overridden(env, 'MU_CONFIG') ? env.MU_CONFIG : join(home, 'config.json'));
}

// The entries that the home itself holds. The data directory may lie in the home, as it does by default, but
// beside these entries: init and the sandbox rules treat each of them on its own.
const HOME_ENTRIES = Object.freeze(['skills', 'memory', 'projects.md', 'config.json', '.install', '.backup']);

function placementError(home, sourceCheckout, dataDir) {
  if (pathsOverlap(home, sourceCheckout)) return 'MU_HOME must be separate from the Mu checkout.';
  if (pathIsWithin(dataDir, home)) return `The data directory ${dataDir} must not hold the Mu home ${home}.`;
  const entry = HOME_ENTRIES.map((name) => join(home, name)).find((path) => pathsOverlap(path, dataDir));
  return entry ? `The data directory ${dataDir} overlaps ${entry}, which belongs to the Mu home.` : null;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

const shellQuote = (path) => `'${path.replaceAll("'", "'\\''")}'`;

/**
 * The checkout held the data directory and the configuration before they moved into the home. A start on the
 * default places while the checkout still holds them would run on an empty database, or without the configured
 * permission arguments, and look healthy. An explicit MU_DATA_DIR or MU_CONFIG is the caller's choice.
 * @param {{root: string, env?: NodeJS.ProcessEnv, home?: string}} options
 * @returns {Promise<string|null>} the refusal, which names the steps of the move
 */
export async function leftoverError({ root, env = process.env, home = resolveHome(env) }) {
  const steps = [];
  const found = [];
  const dataDir = join(home, 'data'),
    configFile = join(home, 'config.json');
  if (
    !overridden(env, 'MU_DATA_DIR') &&
    (await exists(join(root, '.mu/mu.sqlite'))) &&
    !(await exists(join(dataDir, 'mu.sqlite')))
  ) {
    found.push(`the database ${join(root, '.mu/mu.sqlite')}`);
    if (await exists(dataDir)) steps.push(`inspect and remove ${dataDir}, which exists without a database`);
    steps.push(`mv ${shellQuote(join(root, '.mu'))} ${shellQuote(dataDir)}`);
  }
  if (!overridden(env, 'MU_CONFIG') && (await exists(join(root, 'mu.config.json'))) && !(await exists(configFile))) {
    found.push(`the configuration ${join(root, 'mu.config.json')}`);
    steps.push(`mv ${shellQuote(join(root, 'mu.config.json'))} ${shellQuote(configFile)}`);
  }
  if (!found.length) return null;
  return `Mu keeps its data directory in ${dataDir} and its configuration in ${configFile}, but the checkout still holds ${found.join(' and ')}. Move them with Mu stopped: npm run service:uninstall, then ${steps.join(', then ')}, then npm run service:install.`;
}

function homePath(home, path) {
  const target = resolve(home, path);
  const fromHome = relative(home, target);
  if (fromHome === '..' || fromHome.startsWith(`..${sep}`) || resolve(home) === target)
    throw new Error(`Invalid Mu home path ${path}`);
  return target;
}

async function inspectDirectory(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Mu home directory ${path} must not be a symbolic link`);
  if (!info.isDirectory()) throw new Error(`Mu home path ${path} is not a directory`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    throw new Error(`Mu home directory ${path} is not owned by the current user`);
  if ((info.mode & 0o022) !== 0) throw new Error(`Mu home directory ${path} is writable by another user`);
  return info;
}

async function inspectFile(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Mu home file ${path} must not be a symbolic link`);
  if (!info.isFile()) throw new Error(`Mu home path ${path} is not a regular file`);
  if (info.nlink > 1) throw new Error(`Mu home file ${path} has multiple hard links`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid())
    throw new Error(`Mu home file ${path} is not owned by the current user`);
  if ((info.mode & 0o022) !== 0) throw new Error(`Mu home file ${path} is writable by another user`);
  const bytes = await readFile(path);
  return { bytes, info };
}

async function readHomeText(home, path) {
  const absolute = homePath(home, path);
  const file = await inspectFile(absolute);
  return file === null ? null : assertText(file.bytes, absolute);
}

function requiredDirectories(home) {
  return [
    home,
    homePath(home, 'skills'),
    homePath(home, 'skills/team-lead'),
    homePath(home, 'skills/worker'),
    homePath(home, 'memory'),
    homePath(home, 'memory/lead'),
    homePath(home, '.install'),
    homePath(home, '.install/base'),
    homePath(home, '.install/base/skills'),
    homePath(home, '.install/base/skills/team-lead'),
    homePath(home, '.install/base/skills/worker'),
    homePath(home, '.backup'),
  ];
}

function requiredFiles() {
  return [...DEFAULTS, ...SEED_PATHS, '.install/manifest.json', ...DEFAULTS.map((path) => `.install/base/${path}`)];
}

async function validateDirectories(home) {
  const states = [];
  for (const path of requiredDirectories(home)) states.push({ path, info: await inspectDirectory(path) });
  return states;
}

async function validateFiles(home) {
  const states = [];
  for (const path of requiredFiles()) states.push({ path, info: await inspectFile(homePath(home, path)) });
  return states;
}

async function ensurePrivateDirectory(path) {
  let info = await inspectDirectory(path);
  if (info === null) {
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    info = await inspectDirectory(path);
    if (info === null) throw new Error(`Could not create Mu home directory ${path}`);
  }
  if ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function ensureDirectories(home) {
  for (const path of requiredDirectories(home)) await ensurePrivateDirectory(path);
}

async function ensurePrivateFiles(home) {
  for (const path of requiredFiles()) {
    const file = await inspectFile(homePath(home, path));
    if (file && (file.info.mode & 0o777) !== PRIVATE_FILE_MODE) await chmod(homePath(home, path), PRIVATE_FILE_MODE);
  }
}

async function atomicWrite(path, text) {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await open(temporary, 'wx', PRIVATE_FILE_MODE);
    created = true;
    await handle.writeFile(text, 'utf8');
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    const cleanupErrors = [];
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (created) {
      try {
        await rm(temporary, { force: true });
      } catch (removeError) {
        cleanupErrors.push(removeError);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError([error, ...cleanupErrors], `Could not write ${path} and clean up its temporary file`, {
        cause: error,
      });
    throw error;
  }
}

async function readDefaults(root) {
  const files = new Map();
  for (const path of DEFAULTS) {
    const absolute = join(root, path);
    const bytes = await readFile(absolute);
    files.set(path, assertText(bytes, absolute));
  }
  return files;
}

function validateManifest(value, path) {
  if (
    !value ||
    value.version !== MANIFEST_VERSION ||
    typeof value.sourceCheckout !== 'string' ||
    !value.sourceCheckout ||
    !value.files ||
    typeof value.files !== 'object' ||
    Array.isArray(value.files) ||
    !value.installedAt ||
    typeof value.installedAt !== 'object' ||
    Array.isArray(value.installedAt)
  )
    throw new Error(`Mu home manifest ${path} has an unsupported format`);
  for (const [name, digest] of Object.entries(value.files)) {
    if (!DEFAULTS.includes(name) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error(`Mu home manifest ${path} has an invalid entry for ${name}`);
  }
  for (const [name, installedAt] of Object.entries(value.installedAt)) {
    if (
      !DEFAULTS.includes(name) ||
      !(name in value.files) ||
      typeof installedAt !== 'string' ||
      !Number.isFinite(Date.parse(installedAt))
    )
      throw new Error(`Mu home manifest ${path} has an invalid install time for ${name}`);
  }
  if (Object.keys(value.files).some((name) => !(name in value.installedAt)))
    throw new Error(`Mu home manifest ${path} is missing an install time`);
  return /** @type {{version: number, sourceCheckout: string, files: Record<string, string>, installedAt: Record<string, string>}} */ (
    value
  );
}

async function readManifest(home) {
  const path = homePath(home, '.install/manifest.json');
  const text = await readHomeText(home, '.install/manifest.json');
  if (text === null) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Mu home manifest ${path} is not valid JSON`, { cause: error });
  }
  return validateManifest(value, path);
}

async function readBase(home, path, digest) {
  const relativePath = `.install/base/${path}`;
  const text = await readHomeText(home, relativePath);
  if (text === null) throw new Error(`Mu home merge base ${homePath(home, relativePath)} is missing`);
  if (hash(text) !== digest)
    throw new Error(`Mu home merge base ${homePath(home, relativePath)} does not match its manifest`);
  return text;
}

async function mergeText(current, base, updated) {
  const directory = await mkdtemp(join(tmpdir(), 'mu-merge-'));
  const currentFile = join(directory, 'current');
  const baseFile = join(directory, 'base');
  const updatedFile = join(directory, 'updated');
  try {
    await Promise.all([
      atomicWrite(currentFile, current),
      atomicWrite(baseFile, base),
      atomicWrite(updatedFile, updated),
    ]);
    const result = spawnSync(
      'git',
      [
        'merge-file',
        '--stdout',
        '-p',
        '-L',
        'home',
        '-L',
        'installed default',
        '-L',
        'shipped default',
        currentFile,
        baseFile,
        updatedFile,
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.error) throw new Error(`Could not run git merge-file: ${result.error.message}`, { cause: result.error });
    if (result.status === 0) return { text: result.stdout, conflict: false, conflictLines: [] };
    if (result.status === 1)
      return { text: result.stdout, conflict: true, conflictLines: conflictLines(result.stdout) };
    throw new Error(`git merge-file failed with exit status ${result.status}: ${(result.stderr ?? '').trim()}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function conflictLines(text) {
  const lines = text.split('\n');
  const ranges = [];
  let start;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('<<<<<<<')) start = index + 1;
    else if (start !== undefined && lines[index].startsWith('>>>>>>>')) {
      ranges.push(`${start}-${index + 1}`);
      start = undefined;
    }
  }
  return ranges;
}

function acceptedPath(value) {
  if (value === undefined) return undefined;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!DEFAULTS.includes(normalized)) throw new Error(`--accept must name a shipped role file: ${DEFAULTS.join(', ')}`);
  return normalized;
}

function backupName() {
  return `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`;
}

async function createBackup(home, updates) {
  const directory = homePath(home, `.backup/${backupName()}`);
  await ensurePrivateDirectory(directory);
  for (const { path, previous } of updates) {
    if (previous === null) continue;
    let parent = directory;
    for (const part of dirname(path).split('/').filter(Boolean)) {
      parent = join(parent, part);
      await ensurePrivateDirectory(parent);
    }
    await atomicWrite(homePath(directory, path), previous);
  }
}

/**
 * Read the installed state without changing the home.
 * @param {{env?: NodeJS.ProcessEnv, home?: string, root?: string}} [options]
 */
export async function homeState({ env = process.env, home = resolveHome(env), root = ROOT } = {}) {
  const absoluteHome = resolve(home);
  const sourceCheckout = await realpath(root);
  const placement = placementError(absoluteHome, sourceCheckout, resolveDataDir(env, absoluteHome));
  if (placement) throw new Error(placement);
  await validateDirectories(absoluteHome);
  await validateFiles(absoluteHome);

  const manifest = await readManifest(absoluteHome);
  const shipped = await readDefaults(sourceCheckout);
  const defaults = [];
  for (const [path, updated] of shipped) {
    const current = await readHomeText(absoluteHome, path);
    if (current === null) {
      defaults.push({ path, state: 'missing' });
      continue;
    }
    const digest = manifest?.files[path];
    if (digest === undefined) {
      defaults.push({ path, state: 'unmanaged' });
      continue;
    }
    const base = await readBase(absoluteHome, path, digest);
    const currentHash = hash(current);
    const baseHash = hash(base);
    const updatedHash = hash(updated);
    if (currentHash === baseHash && updatedHash === baseHash) {
      defaults.push({ path, state: 'current', installedAt: manifest.installedAt[path] });
    } else if (currentHash === baseHash) {
      defaults.push({ path, state: 'outdated', installedAt: manifest.installedAt[path] });
    } else if (updatedHash === baseHash) {
      defaults.push({ path, state: 'edited', installedAt: manifest.installedAt[path] });
    } else {
      const merged = await mergeText(current, base, updated);
      defaults.push({
        path,
        state: merged.conflict ? 'conflict' : 'mergeable',
        installedAt: manifest.installedAt[path],
      });
    }
  }

  const seeds = [];
  for (const path of SEED_PATHS)
    seeds.push({ path, state: (await readHomeText(absoluteHome, path)) === null ? 'missing' : 'present' });
  return {
    home: absoluteHome,
    sourceCheckout,
    installedFrom: manifest?.sourceCheckout ?? null,
    initialized: manifest !== null,
    defaults,
    seeds,
  };
}

/**
 * Plan or install the defaults and one-time seeds for a Mu home.
 * @param {{env?: NodeJS.ProcessEnv, home?: string, root?: string, dryRun?: boolean, accept?: string, adopt?: boolean}} [options]
 */
export async function initializeHome({
  env = process.env,
  home = resolveHome(env),
  root = ROOT,
  dryRun = false,
  accept,
  adopt = false,
} = {}) {
  const absoluteHome = resolve(home);
  const sourceCheckout = await realpath(root);
  const placement = placementError(absoluteHome, sourceCheckout, resolveDataDir(env, absoluteHome));
  if (placement) throw new Error(placement);
  const accepted = acceptedPath(accept);
  const directoryStates = await validateDirectories(absoluteHome);
  const fileStates = await validateFiles(absoluteHome);

  const manifest = await readManifest(absoluteHome);
  if (manifest && manifest.sourceCheckout !== sourceCheckout && !adopt)
    throw new Error(
      `Mu home was installed from ${manifest.sourceCheckout}, not ${sourceCheckout}; rerun with --adopt to use this checkout's defaults.`,
    );

  const shipped = await readDefaults(sourceCheckout);
  const files = { ...(manifest?.files ?? {}) };
  const installedAt = { ...(manifest?.installedAt ?? {}) };
  const writes = [];
  const baseWrites = [];
  const actions = [];
  const conflicts = [];

  for (const [path, updated] of shipped) {
    const current = await readHomeText(absoluteHome, path);
    const updatedHash = hash(updated);

    if (accepted === path) {
      if (current === null) throw new Error(`Cannot accept missing Mu home file ${homePath(absoluteHome, path)}`);
      baseWrites.push({ path, text: updated });
      files[path] = updatedHash;
      installedAt[path] = new Date().toISOString();
      actions.push({ path, action: 'accept-current-edit' });
      continue;
    }

    if (current === null) {
      writes.push({ path, text: updated, previous: null });
      baseWrites.push({ path, text: updated });
      files[path] = updatedHash;
      installedAt[path] = new Date().toISOString();
      actions.push({ path, action: 'install' });
      continue;
    }

    const previousHash = files[path];
    if (previousHash === undefined) {
      actions.push({ path, action: 'keep-unmanaged' });
      continue;
    }

    const base = await readBase(absoluteHome, path, previousHash);
    const currentHash = hash(current);
    const baseHash = hash(base);
    if (currentHash === baseHash) {
      if (updatedHash === baseHash) {
        actions.push({ path, action: 'current' });
      } else {
        writes.push({ path, text: updated, previous: current });
        baseWrites.push({ path, text: updated });
        files[path] = updatedHash;
        installedAt[path] = new Date().toISOString();
        actions.push({ path, action: 'replace' });
      }
      continue;
    }

    if (updatedHash === baseHash) {
      actions.push({ path, action: 'keep-edit' });
      continue;
    }

    const merged = await mergeText(current, base, updated);
    if (merged.conflict) {
      conflicts.push({ path, lines: merged.conflictLines });
      continue;
    }
    writes.push({ path, text: merged.text, previous: current });
    baseWrites.push({ path, text: updated });
    files[path] = updatedHash;
    installedAt[path] = new Date().toISOString();
    actions.push({ path, action: 'merge' });
  }

  const seedEntries = { ...SEEDS };
  const legacyConfig = !overridden(env, 'MU_CONFIG') && (await exists(join(sourceCheckout, 'mu.config.json')));
  if (!legacyConfig) {
    const configExamplePath = join(sourceCheckout, 'mu.config.example.json');
    seedEntries['config.json'] = assertText(await readFile(configExamplePath), configExamplePath);
  }
  for (const [path, text] of Object.entries(seedEntries)) {
    if ((await readHomeText(absoluteHome, path)) === null) {
      writes.push({ path, text, previous: null });
      actions.push({ path, action: 'seed' });
    } else {
      actions.push({ path, action: 'keep-seed' });
    }
  }

  if (conflicts.length) {
    const details = conflicts
      .map(({ path, lines }) => `  ${path}${lines.length ? ` (conflict lines ${lines.join(', ')})` : ''}`)
      .join('\n');
    throw new Error(
      `Mu home upgrade has conflicts; no files were changed. Edit each live file, then run init --accept FILE:\n${details}`,
    );
  }

  const nextManifest = {
    version: MANIFEST_VERSION,
    sourceCheckout,
    files,
    installedAt,
  };
  const manifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;
  const oldManifest = await readHomeText(absoluteHome, '.install/manifest.json');
  const manifestChanged = oldManifest !== manifestText;
  if (manifestChanged) actions.push({ path: '.install/manifest.json', action: 'write-manifest' });
  for (const { path, info } of directoryStates) {
    const relativePath = relative(absoluteHome, path) || '.';
    if (info === null) actions.push({ path: relativePath, action: 'create-directory' });
    else if ((info.mode & 0o777) !== PRIVATE_DIRECTORY_MODE)
      actions.push({ path: relativePath, action: 'restrict-directory-mode' });
  }
  for (const { path, info } of fileStates) {
    if (info && (info.mode & 0o777) !== PRIVATE_FILE_MODE) actions.push({ path, action: 'restrict-file-mode' });
  }

  const result = { home: absoluteHome, sourceCheckout, dryRun, actions };
  if (dryRun) return result;

  await ensureDirectories(absoluteHome);
  await ensurePrivateFiles(absoluteHome);
  const replaced = writes.filter(({ previous }) => previous !== null);
  if (replaced.length) await createBackup(absoluteHome, replaced);
  for (const { path, text } of baseWrites) await atomicWrite(homePath(absoluteHome, `.install/base/${path}`), text);
  for (const { path, text } of writes) await atomicWrite(homePath(absoluteHome, path), text);
  if (manifestChanged) await atomicWrite(homePath(absoluteHome, '.install/manifest.json'), manifestText);
  return result;
}
