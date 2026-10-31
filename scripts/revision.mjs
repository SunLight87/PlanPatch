import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export async function revisionManifest() {
  const files = ['package.json', 'package-lock.json', 'server.mjs', 'CONTRACT.md'];
  async function walk(dir) {
    for (const item of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir + '/' + item.name;
      if (item.isDirectory()) await walk(rel);
      else if (item.isFile()) files.push(rel);
    }
  }
  for (const dir of ['src', 'public', 'samples', 'scripts', 'test']) await walk(dir);
  files.sort();
  const hashes = {};
  for (const file of files) hashes[file] = sha256(await readFile(path.join(root, file)));
  return { algorithm: 'sha256', productRevision: sha256(JSON.stringify(hashes)), files: hashes };
}
