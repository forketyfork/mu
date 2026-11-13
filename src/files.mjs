import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Lists the entries under directory that are not directories, relative to it and at most `depth` levels deep,
// descending only into real directories. Symbolic links are listed, not followed, so that a caller can refuse them
// explicitly. readdir's recursive option follows links to directories, so a link to `.` or `/` that an agent plants
// in a directory it can write would make the service walk forever or across the whole disk.
export async function listFiles(directory, depth = Infinity) {
  const files = [];
  const walk = async (relative, level) => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (!entry.isDirectory()) files.push(path);
      else if (level < depth) await walk(path, level + 1);
    }
  };
  await walk('', 1);
  return files;
}
