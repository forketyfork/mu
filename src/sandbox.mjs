import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathIsWithin } from './paths.mjs';

// Entries that hold code other programs run outside the sandbox: git metadata and hooks, and the
// project settings of agent CLIs, which can define hooks and extensions. They are protected at any
// depth, because git and the CLIs also discover them in subdirectories, such as a nested repository.
/**
 * @typedef {{localPorts?: number[], writableRoots?: string[]}} PiSandbox
 * @typedef {{writableRoots?: string[]}} CodexSandbox
 */

export const PROTECTED_ENTRY_NAMES = ['.git', '.pi', '.claude', '.codex'];

// eslint-disable-next-line no-control-regex -- the pattern is about control characters
const CONTROL_CHARACTERS = /[\0-\x1f\x7f]/;

function quote(path) {
  if (CONTROL_CHARACTERS.test(path))
    throw new Error(`Cannot sandbox a path with control characters: ${JSON.stringify(path)}`);
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// Volumes are usually case-insensitive, so .GIT names the same directory as .git.
const entryPattern = (name) =>
  [...name.slice(1)].map((char) => (/[a-z]/.test(char) ? `[${char}${char.toUpperCase()}]` : char)).join('');
const PROTECTED_ENTRY_REGEX = `/\\.(${PROTECTED_ENTRY_NAMES.map(entryPattern).join('|')})(/|$)`;

// Storage that holds other conversations or the user's credential: the state of every agent CLI, which
// records prompts and transcripts in databases, logs and histories, and browser profiles, where the
// dashboard keeps its sign-in credential and history. Sandboxed agents cannot read it. Whole CLI
// directories are listed, so a new store in a later release stays covered. pi itself runs inside the
// sandbox and loads its extensions from ~/.pi/agent, so only pi's sessions are listed. Paths are listed
// whether or not they exist.
export function privateUserPaths(home = homedir(), uid = process.getuid()) {
  const support = join(home, 'Library/Application Support');
  return [
    join(home, '.claude'),
    join(home, '.claude.json'),
    join('/tmp', `claude-${uid}`),
    join(home, '.codex'),
    join(home, '.pi/agent/sessions'),
    ...[
      'Google',
      'Chromium',
      'BraveSoftware',
      'Microsoft Edge',
      'Arc',
      'Vivaldi',
      'Firefox',
      'com.operasoftware.Opera',
    ].map((name) => join(support, name)),
    join(home, 'Library/Safari'),
    join(home, 'Library/Containers/com.apple.Safari'),
    join(home, 'Library/WebKit'),
  ].map(realTarget);
}

// A macOS Seatbelt profile, closed by default like the one Codex uses for workspace-write.
// Reads are unrestricted except unreadableRoots, which readableRoots reopen in part. Writes are limited to writableRoots, minus readOnlyRoots, plus reopenedRoots, minus
// protectedPaths and the protected entries. The fixedEntries cannot be created, removed or renamed,
// though the directories among them stay writable inside. The last matching rule wins, so the order of the
// file-write rules matters. Network access is limited to the given loopback ports and Unix sockets:
// Seatbelt cannot filter by host name. Seatbelt resolves symbolic links before it matches a socket path.
export function seatbeltProfile({
  writableRoots,
  readOnlyRoots = [],
  reopenedRoots = [],
  protectedPaths,
  localPorts,
  unixSockets = [],
  unreadableRoots = [],
  readableRoots = [],
  fixedEntries = [],
}) {
  return `(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(allow file-read*)
${unreadableRoots.map((path) => `(deny file-read* (subpath ${quote(path)}))`).join('\n')}
${readableRoots.map((path) => `(allow file-read* (subpath ${quote(path)}))`).join('\n')}
(allow file-ioctl)
(allow pseudo-tty)
(allow ipc-posix-sem ipc-posix-shm)
(allow user-preference-read)
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.logd")
  (global-name "com.apple.diagnosticd")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.mDNSResponder")
  (global-name "com.apple.dnssd.service")
  (global-name "com.apple.networkd")
  (global-name "com.apple.FSEvents")
  (global-name "com.apple.PowerManagement.control"))
(allow file-write*
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/ptmx")
  (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd")
${writableRoots.map((path) => `  (subpath ${quote(path)})`).join('\n')})
${readOnlyRoots.map((path) => `(deny file-write* (subpath ${quote(path)}))`).join('\n')}
${reopenedRoots.map((path) => `(allow file-write* (subpath ${quote(path)}))`).join('\n')}
${protectedPaths.map((path) => `(deny file-write* (literal ${quote(path)}) (subpath ${quote(path)}))`).join('\n')}
(deny file-write* (regex #"${PROTECTED_ENTRY_REGEX}"))
${fixedEntries.length ? `(deny file-write-create file-write-unlink\n${fixedEntries.map((path) => `  (literal ${quote(path)})`).join('\n')})` : ''}
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
${localPorts.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`).join('\n')}
${unixSockets.map((path) => `(allow network-outbound (remote unix-socket (path-literal ${quote(path)})))`).join('\n')}
`;
}

// Seatbelt matches real paths, and a protected path must stay protected before anything creates it.
const realTarget = (path) => resolution(path).target;

// Resolves an absolute path the way the kernel does, also through missing entries, and lists the real
// location of every directory entry on the way: each component and, for a symbolic link, the entries
// of its target. Replacing any of these entries redirects the path.
function resolution(path, entries = [], depth = 0) {
  if (depth > 32) throw new Error(`Too many symbolic links in ${path}`);
  let target = '/';
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      target = dirname(target);
      continue;
    }
    const entry = join(target, part);
    entries.push(entry);
    let link = null;
    try {
      if (lstatSync(entry).isSymbolicLink()) link = readlinkSync(entry);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    target = link === null ? entry : resolution(resolve(target, link), entries, depth + 1).target;
  }
  return { target, entries };
}

// Git runs hooks and reads configuration from places that the configuration chooses, such as
// core.hooksPath = .githooks or an include.path inside the work tree. Git reports them, so they stay
// read-only wherever they are, not only under .git.
// Variables such as GIT_DIR, which git exports to its hooks, would make git describe another repository.
let localGitVariables = null;
function repositoryNeutralEnv() {
  localGitVariables ??= new Set(
    execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n').filter(Boolean),
  );
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !localGitVariables.has(name)));
}

// Implicit bare repositories are refused, so files planted in the directory cannot pose as a repository.
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'safe.bareRepository=explicit', '-C', cwd, ...args], {
    encoding: 'utf8',
    env: repositoryNeutralEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function gitProtectedPaths(directory) {
  let location;
  try {
    location = git(directory, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-path', 'hooks');
  } catch (error) {
    if (error.status === 128 && /not a git repository/.test(error.stderr)) return [];
    throw new Error(
      `Cannot determine the git hooks and configuration to protect for ${directory}: ${(error.stderr || error.message).trim()}`,
      { cause: error },
    );
  }
  const [toplevel, hooks] = location.trimEnd().split('\n');
  // With -z, each entry is an origin and then the name and value, separated by a newline. Relative
  // origins are relative to the top level. An included file without entries has no origin of its own,
  // so include paths are protected as written, relative to the file that includes them.
  const fields = git(toplevel, 'config', '--list', '--show-origin', '--includes', '-z').split('\0');
  const files = new Set();
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (!fields[index].startsWith('file:')) continue;
    const origin = resolve(toplevel, fields[index].slice('file:'.length));
    files.add(origin);
    const [name, value] = fields[index + 1].split(/\n(.*)/s);
    if (/^include(if\..*)?\.path$/i.test(name) && value)
      files.add(value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(dirname(origin), value));
  }
  return [hooks, ...files].map(realTarget);
}

// Entries of a repository's common git directory that fetching, creating branches and worktrees, and
// committing in a linked worktree write. Everything else there stays read-only: the directory entry
// itself, so a worker cannot replace it with one that holds its own hooks, and the config, hooks, index
// and HEAD, so a worker cannot change the configuration or commit in and check out the main work tree.
export const GIT_COMMON_WRITABLE = [
  'objects',
  'refs',
  'logs',
  'worktrees',
  'reftable',
  'FETCH_HEAD',
  'packed-refs',
  'packed-refs.lock',
  'shallow',
  'shallow.lock',
  'gc.pid',
  'gc.log',
  'gc.log.lock',
];
// Entries that make another program run code or read configuration as soon as it starts in a directory.
const STARTUP_ENTRY_NAMES = [...PROTECTED_ENTRY_NAMES, '.agents'];

function gitLayout(directory) {
  let location;
  try {
    location = git(
      directory,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
      '--git-dir',
      '--show-toplevel',
    );
  } catch (error) {
    if (error.status === 128 && /not a git repository/.test(error.stderr)) return null;
    throw new Error(`Cannot determine the git directories of ${directory}: ${(error.stderr || error.message).trim()}`, {
      cause: error,
    });
  }
  const [common, gitDir, toplevel] = location
    .trimEnd()
    .split('\n')
    .map((path) => realpathSync(path));
  let linked = [];
  try {
    linked = readdirSync(join(common, 'worktrees'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(common, 'worktrees', entry.name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { common, gitDir, toplevel, linked };
}

// The work tree that a linked worktree's administrative directory points at, read without running git
// there, or null when its gitdir file is missing. A work tree that no longer exists keeps its recorded path.
function linkedWorkTree(admin) {
  let pointer;
  try {
    pointer = readFileSync(join(admin, 'gitdir'), 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const tree = dirname(resolve(admin, pointer));
  return existsSync(tree) ? realpathSync(tree) : tree;
}

const isWithin = (path, parent) => path === parent || path.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

// The Mu home holds every agent's instructions and the lead's memory, which become prompts on later turns.
// Sandboxed agents read the instructions and write nothing there; memory/ is unreadable, and only the lead
// gets memory/lead back, readable and writable. Paths are real paths, also through entries that are missing.
/** @param {string} home @param {string} role */
export function homeAccess(home, role) {
  if (!['lead', 'worker'].includes(role)) throw new Error(`Unknown role ${role} for the Mu home sandbox rules`);
  const root = realTarget(resolve(home));
  return {
    home: root,
    readOnly: [root],
    unreadable: [join(root, 'memory')],
    writable: role === 'lead' ? [join(root, 'memory/lead')] : [],
  };
}

// A working directory inside the home would be writable for Codex, and the CLIs load instructions from it.
/** @returns {string|null} */
export function homeWorkspaceError(cwd, home, what = 'The working directory') {
  const target = realTarget(resolve(cwd)),
    root = realTarget(resolve(home));
  return pathIsWithin(root, target)
    ? `${what} ${target} is inside the Mu home ${root}, which sandboxed agents may not write`
    : null;
}

// A writable root that contains the home would keep it read-only only through an exception inside a broad grant.
/** @returns {string|null} */
export function homeRootError(path, home, what) {
  const inside = homeWorkspaceError(path, home, what);
  if (inside) return inside;
  const target = realTarget(resolve(path)),
    root = realTarget(resolve(home));
  return pathIsWithin(target, root)
    ? `${what} ${target} contains the Mu home ${root}; choose a narrower directory, such as the one that holds your worktrees`
    : null;
}

// Entries on the way from a writable directory to the home: renaming one, or replacing a symbolic link among
// them, would let the agent put a home of its own at the home's path, which the next turn would read. An entry
// counts by the directory that holds it, because a link is judged by where it lives, not where it points. The
// walk follows the configured path, the one the runner reads, so that the links on it are entries too.
function homeAncestorsWithin(home, directories) {
  return resolution(home)
    .entries.slice(0, -1)
    .filter((entry) => directories.some((directory) => pathIsWithin(directory, dirname(entry))));
}

// How deep below the working directory Mu looks for nested repositories, such as submodules or the
// checkouts of a monorepo. Deeper repositories keep writable hooks and configuration.
export const NESTED_REPOSITORY_DEPTH = 3;

// Directories at most `depth` levels below `base` that hold a .git entry. Dependency and hidden
// directories are not entered, nor symbolic links: a link grants nothing, because the sandbox matches
// the path that a link resolves to. A directory this process cannot read is skipped; the agent runs as
// the same user, so it cannot create a repository there either.
function nestedRepositories(base, depth = NESTED_REPOSITORY_DEPTH) {
  let entries;
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return [];
    throw error;
  }
  const found = entries.some((entry) => entry.name === '.git') ? [base] : [];
  if (depth === 0) return found;
  return [
    ...found,
    ...entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .flatMap((entry) => nestedRepositories(join(base, entry.name), depth - 1)),
  ];
}

// What a Codex agent may write beyond its working directory, and what stays read-only inside that.
// writableRoots come from the configuration. The agent's repository, found from its working directory,
// gets the git entries that fetching, creating a worktree, and committing in a linked worktree need.
// Kept read-only: the git hooks and configuration files that git reports, submodule git directories,
// the commondir, gitdir and config.worktree files of the agent's own linked worktree and of every linked
// worktree outside the writable roots, which decide where git reads its configuration there, the .git
// entry of every repository found up to NESTED_REPOSITORY_DEPTH below the working directory, and the
// entries named in STARTUP_ENTRY_NAMES in the working directory, its repository's top level and each
// writable root, and the Mu home with the directories that lead to it from a writable one; memory/ in the
// home is unreadable, and the lead gets memory/lead writable. Codex itself keeps only the working directory's .git, .agents and .codex read-only.
// Inside a writable root Mu lists nothing more: everything there, other worktrees included, is writable
// work, and Codex builds each command's sandbox in time that grows faster than the number of listed
// paths, so listing each directory of a root cost seconds per command. Paths are real paths, because
// the sandbox matches those.
export function codexAccess({ cwd, writableRoots = [], dataDir, home, role, privatePaths = privateUserPaths() }) {
  if (!home) throw new Error('The Codex sandbox needs the Mu home');
  const roots = writableRoots.map((path) => realpathSync(path));
  const directory = realpathSync(cwd);
  const misplaced = [
    homeWorkspaceError(directory, home, 'The Codex working directory'),
    ...roots.map((root) => homeRootError(root, home, 'The Codex writable root')),
  ].find(Boolean);
  if (misplaced) throw new Error(misplaced);
  const homeRules = homeAccess(home, role);
  for (const root of roots) {
    const reserved = [dataDir, ...privatePaths].find((path) => pathIsWithin(path, root));
    if (reserved) throw new Error(`The Codex writable root ${root} is inside ${reserved}, which agents may not read`);
    // A deny still wins inside such a root, but it would open the home directory or more to writes.
    const contained = privatePaths.find((path) => pathIsWithin(root, path));
    if (contained)
      throw new Error(
        `The Codex writable root ${root} contains ${contained}; choose a narrower directory, such as the one that holds your worktrees`,
      );
  }
  const writable = [...roots];
  const readOnly = [];
  const repository = gitLayout(cwd);
  if (repository) {
    writable.push(...GIT_COMMON_WRITABLE.map((name) => join(repository.common, name)));
    if (repository.gitDir !== repository.common) writable.push(repository.gitDir);
    readOnly.push(...gitProtectedPaths(cwd), join(repository.common, 'modules'));
    for (const admin of repository.linked) {
      const tree = linkedWorkTree(admin);
      const insideRoot = tree !== null && roots.some((root) => isWithin(tree, root));
      if (admin === repository.gitDir || !insideRoot)
        readOnly.push(...['commondir', 'gitdir', 'config.worktree'].map((name) => join(admin, name)));
    }
  }
  // Only the lead's memory may be writable in the home, such as git's directories if the home were a repository.
  const intruding = writable.find((path) => pathIsWithin(homeRules.home, path));
  if (intruding)
    throw new Error(
      `The Codex sandbox would make ${intruding} writable, which is inside the Mu home ${homeRules.home}`,
    );
  readOnly.push(...nestedRepositories(directory).map((path) => join(path, '.git')));
  const startupDirectories = [directory, repository?.toplevel, ...roots].filter(Boolean);
  readOnly.push(...startupDirectories.flatMap((path) => STARTUP_ENTRY_NAMES.map((name) => join(path, name))));
  // An explicit entry, so that no broader writable entry decides for the home.
  readOnly.push(...homeRules.readOnly, ...homeAncestorsWithin(resolve(home), [directory, ...roots]));
  writable.push(...homeRules.writable);
  return {
    writable: [...new Set(writable)],
    readOnly: [...new Set(readOnly)],
    unreadable: homeRules.unreadable,
  };
}

// Mu creates the pi home and its temporary directory outside the sandbox and must not follow a symbolic
// link that a sandboxed turn could have put in their place. The profile denies such a replacement; this
// check refuses one that happened anyway, such as under an earlier profile.
function plainDirectory(path) {
  try {
    mkdirSync(path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (!lstatSync(path).isDirectory())
    throw new Error(`The pi sandbox directory ${path} is not a plain directory; inspect and remove it`);
  return realpathSync(path);
}

// Wraps a pi invocation in Seatbelt. pi gets its own configuration directory per agent instead of
// ~/.pi/agent: pi writes lock files and sessions there, and a writable ~/.pi/agent would let the
// agent install an extension that a later unsandboxed pi process loads.
// The Mu checkout, the Mu home and the data directory stay read-only even inside a writable root: every
// agent runs the checkout's CLI and the home's instructions, and the data directory holds the database and
// the other agents' pi homes. pi reaches Mu only through its own socket. It cannot read the data directory,
// apart from its own pi home, socket and credential, the home's memory, apart from the lead's own memory
// for the lead, nor the storage in privateUserPaths.
// Mu resolves each path again at the next launch, so the agent may not replace any directory entry
// that the resolution of a granted or protected path passes through: that would redirect the grant.
export function sandboxPi({
  agent,
  args,
  root,
  home: muHome,
  dataDir,
  localPorts,
  socket,
  credentialFile,
  writableRoots = [],
  platform = process.platform,
  privatePaths = privateUserPaths(),
}) {
  if (platform !== 'darwin')
    throw new Error(`The pi adapter runs pi inside a macOS Seatbelt sandbox, which is not available on ${platform}`);
  if (!dataDir) throw new Error('The pi sandbox needs the Mu data directory');
  if (!root) throw new Error('The pi sandbox needs the Mu checkout directory');
  if (!muHome) throw new Error('The pi sandbox needs the Mu home');
  if (!socket || !credentialFile) throw new Error('The pi sandbox needs the agent socket and its credential file');
  mkdirSync(dataDir, { recursive: true });
  const home = plainDirectory(join(plainDirectory(join(dataDir, 'pi')), agent.id));
  const tmp = plainDirectory(join(home, 'tmp'));
  const roots = [realpathSync(agent.cwd), ...writableRoots.map((path) => realpathSync(path))];
  const misplaced = [
    homeWorkspaceError(roots[0], muHome, 'The pi working directory'),
    ...roots.slice(1).map((path) => homeRootError(path, muHome, 'The pi writable root')),
  ].find(Boolean);
  if (misplaced) throw new Error(misplaced);
  const homeRules = homeAccess(muHome, agent.role);
  const protectedPaths = [...new Set(roots.flatMap(gitProtectedPaths))];
  const granted = [
    agent.cwd,
    ...writableRoots,
    home,
    tmp,
    root,
    // The configured path too: the runner reads the instructions through it, links on the way included.
    resolve(muHome),
    homeRules.home,
    ...homeRules.unreadable,
    ...homeRules.writable,
    dataDir,
    socket,
    credentialFile,
    ...protectedPaths,
    ...privatePaths,
  ];
  const profile = seatbeltProfile({
    writableRoots: roots,
    readOnlyRoots: [realpathSync(root), ...homeRules.readOnly, realpathSync(dataDir)],
    reopenedRoots: [home, ...homeRules.writable],
    protectedPaths,
    localPorts,
    unixSockets: [realpathSync(socket)],
    unreadableRoots: [realpathSync(dataDir), ...homeRules.unreadable, ...privatePaths],
    readableRoots: [home, ...homeRules.writable, realpathSync(socket), realpathSync(credentialFile)],
    fixedEntries: [...new Set(granted.flatMap((path) => resolution(resolve(path)).entries))],
  });
  return {
    command: 'sandbox-exec',
    args: ['-p', profile, 'pi', ...args],
    // Network access outside the allowed ports would fail anyway; offline mode skips pi's catalog and version requests.
    env: { PI_CODING_AGENT_DIR: home, TMPDIR: tmp, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
  };
}
