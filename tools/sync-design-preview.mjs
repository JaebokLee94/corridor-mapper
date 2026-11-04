#!/usr/bin/env node
import { copyFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { previewFiles } from './pages-manifest.mjs';

/** Copy only the browser runtime, never local jobs, screenshots or research files.
 * The original preview folder is read-only; existing unrelated target files are
 * left untouched and are not included by build-pages.mjs.
 */
export function syncDesignPreview(sourceDirectory, destinationDirectory = new URL('../preview/', import.meta.url)) {
  const source = realpathSync(sourceDirectory);
  const destination = resolve(destinationDirectory instanceof URL ? fileURLToPath(destinationDirectory) : destinationDirectory);
  if (source === destination) throw new Error('Preview source and destination must differ');
  // Validate the whole source before replacing any snapshot files.
  const sources = previewFiles.map(path => {
    const filename = realpathSync(resolve(source, path));
    if (!filename.startsWith(source + sep) || !statSync(filename).isFile()) throw new Error(`Invalid preview runtime file: ${path}`);
    return filename;
  });
  for (let i = 0; i < previewFiles.length; i++) {
    const target = resolve(destination, previewFiles[i]);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(sources[i], target);
  }
  return previewFiles.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node tools/sync-design-preview.mjs <source-directory>');
    process.exitCode = 1;
  } else {
    console.log(`Synced ${syncDesignPreview(process.argv[2])} public preview files into preview/.`);
  }
}
