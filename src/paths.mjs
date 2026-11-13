import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

// Containment by file identity, not by spelling. On macOS one directory has many names: another case on a
// case-insensitive volume, or the /System/Volumes/Data firmlink prefix. realpath resolves symbolic links but
// keeps both kinds of alias, while Seatbelt matches paths regardless of case, so a string comparison would
// let an alias of a protected directory pass as an unrelated path.

function physicalPath(path) {
  let candidate = resolve(path);
  const suffix = [];
  while (true) {
    try {
      const anchor = realpathSync(candidate);
      return { anchor, info: statSync(anchor), suffix };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

// Whether the volume that holds an existing directory ignores case: the path with one letter's case
// flipped names the same file.
function caseInsensitivePath(anchor, info) {
  if (process.platform !== 'darwin') return false;
  const parts = anchor.split(sep).filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const match = /[a-z]/i.exec(parts[index]);
    if (!match) continue;
    const letter = match[0];
    parts[index] = `${parts[index].slice(0, match.index)}${
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()
    }${parts[index].slice(match.index + 1)}`;
    try {
      const alternate = statSync(resolve(sep, ...parts));
      return alternate.dev === info.dev && alternate.ino === info.ino;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return false;
}

// Whether targetPath is parentPath or lies inside it. Entries that do not exist yet compare by name below
// the deepest existing ancestor, ignoring case where that ancestor's volume does.
export function pathIsWithin(parentPath, targetPath) {
  const parent = physicalPath(parentPath);
  const target = physicalPath(targetPath);
  const targetSuffix = [];
  let candidate = target.anchor;
  while (true) {
    const info = statSync(candidate);
    if (info.dev === parent.info.dev && info.ino === parent.info.ino) break;
    const next = dirname(candidate);
    if (next === candidate) return false;
    targetSuffix.unshift(basename(candidate));
    candidate = next;
  }
  const targetParts = [...targetSuffix, ...target.suffix];
  if (parent.suffix.length > targetParts.length) return false;
  const caseInsensitive = parent.suffix.length > 0 && caseInsensitivePath(parent.anchor, parent.info);
  return parent.suffix.every((part, index) => {
    const targetPart = targetParts[index];
    return caseInsensitive ? part.toLowerCase() === targetPart.toLowerCase() : part === targetPart;
  });
}

export const pathsOverlap = (first, second) => pathIsWithin(first, second) || pathIsWithin(second, first);
