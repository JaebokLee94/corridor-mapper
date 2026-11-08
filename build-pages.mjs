import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { runtimeFiles } from './tools/pages-manifest.mjs';

// Public runtime only: keep historical research sources out of the Pages artifact.
const root = new URL('./', import.meta.url), output = new URL('_site/', root);
rmSync(output, { recursive: true, force: true });
for (const path of runtimeFiles) {
  const target = new URL(path, output);
  mkdirSync(new URL('./', target), { recursive: true });
  copyFileSync(new URL(path, root), target);
}
console.log(`Built simulator Pages artifact: ${runtimeFiles.length} files.`);
