import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { runtimeFiles, previewFiles } from './tools/pages-manifest.mjs';

// Public runtime only: keep historical research sources out of the Pages artifact.
const root = new URL('./', import.meta.url), output = new URL('_site/', root);
rmSync(output, { recursive: true, force: true });
for (const [prefix, files] of [['', runtimeFiles], ['preview/', previewFiles]]) {
  for (const path of files) {
    const target = new URL(prefix + path, output);
    mkdirSync(new URL('./', target), { recursive: true });
    copyFileSync(new URL(prefix + path, root), target);
  }
}
console.log(`Built original and preview Pages artifact: ${runtimeFiles.length + previewFiles.length} files.`);
