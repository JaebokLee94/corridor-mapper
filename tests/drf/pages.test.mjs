import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runtimeFiles, previewFiles } from '../../tools/pages-manifest.mjs';
import { syncDesignPreview } from '../../tools/sync-design-preview.mjs';

test('Pages isolates original and preview runtimes and includes their complete relative dependencies', () => {
  const root = new URL('../../', import.meta.url), output = new URL('_site/', root);
  execFileSync(process.execPath, ['build-pages.mjs'], { cwd: root });
  const files = readdirSync(output, { recursive: true }).filter(path => existsSync(new URL(path, output)) && /\.[a-z]+$/.test(path));
  assert.deepEqual(files.filter(path => path.endsWith('.html')).sort(), ['drf.html', 'preview/drf.html']);
  assert.deepEqual(files.sort(), [...runtimeFiles, ...previewFiles.map(path => `preview/${path}`)].sort());
  for (const prefix of ['', 'preview/']) {
  for (const path of ['server-client.mjs', 'simulation-codec.mjs', 'run-engine.mjs', 'run.worker.mjs', 'baseline.mjs', 'comparison.mjs', 'compare.worker.mjs', 'scenario.worker.mjs', 'field.worker.mjs', 'eval.worker.mjs', 'sweep.worker.mjs', 'pspt.worker.mjs', 'pspt.mjs', 'pspt-math.mjs', 'pspt-ridges.mjs', 'pspt-evaluate.mjs',
    'statistics.mjs', 'reflection-diagnostics.mjs', 'provenance.json', 'reference/octave/fixtures.json', 'offline.bundle.js', 'style.css'])
    assert.ok(existsSync(new URL(`${prefix}drf/${path}`, output)), `Dynamic runtime asset: ${prefix}${path}`);
  for (const path of ['index.html', 'legacy.html', 'surf/app.mjs', 'surf/engine.worker.mjs', 'tests', 'README.md', 'drf/evaluate.mjs', 'preview-cache', 'preview-evidence', 'node_modules', '.git', 'tools'])
    assert.equal(existsSync(new URL(prefix + path, output)), false, prefix + path);
  const html = readFileSync(new URL(prefix + 'drf.html', output), 'utf8');
  assert.match(html, /<meta name="echomap-compute" content="browser"\s*\/?>/);
  // Static publication uses isolated browser workers, never a visitor's localhost.
  assert.ok(!html.includes('127.0.0.1'));
  for (const match of html.matchAll(/(?:href|src)=["']([^"'#]+)["']|runtime\.src=['"]([^'"]+)['"]/g)) {
    const reference = match[1] ?? match[2];
    if (/^[a-z]+:/i.test(reference)) continue;
    assert.ok(!reference.startsWith('/'), 'GitHub Pages is served under /corridor-mapper/');
    assert.ok(existsSync(new URL(reference.split('?')[0], new URL(prefix, output))), `${prefix}drf.html: ${reference}`);
  }
  assert.ok(!/href="(?:\.\/|index\.html|legacy\.html)"/.test(html));
  }
  for (const path of files) {
    const bytes = readFileSync(new URL(path, output));
    assert.ok(bytes.length > 0, path);
    assert.deepEqual(bytes, readFileSync(new URL(path, root)), path);
    if (!path.endsWith('.mjs')) continue;
    for (const match of bytes.toString().matchAll(/(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))
      assert.ok(existsSync(new URL(match[1].split('?')[0], new URL(path, output))), `${path}: ${match[1]}`);
    for (const match of bytes.toString().matchAll(/new URL\(['"](\.{1,2}\/[^'"]+)['"]/g))
      assert.ok(existsSync(new URL(match[1].split('?')[0], new URL(path, output))), `${path}: ${match[1]}`);
  }
  for (const path of ['design-preview.css', 'design-preview.mjs', 'preview-run-control.mjs'])
    assert.ok(existsSync(new URL(`preview/drf/${path}`, output)), `Preview-only runtime: ${path}`);
});

test('preview sync copies only public dependencies without modifying the source or unrelated target files', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'echomap-preview-sync-'));
  try {
    const source = join(temporary, 'source'), destination = join(temporary, 'destination');
    for (const path of [...previewFiles, 'preview-cache/job.json', 'preview-evidence/screenshot.png', '.env', 'research-notes.md']) {
      const target = join(source, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, path);
    }
    mkdirSync(destination); writeFileSync(join(destination, 'unrelated.txt'), 'keep');
    assert.equal(syncDesignPreview(source, destination), previewFiles.length);
    for (const path of previewFiles) {
      assert.equal(readFileSync(join(destination, path), 'utf8'), path);
      assert.equal(readFileSync(join(source, path), 'utf8'), path);
    }
    for (const path of ['preview-cache', 'preview-evidence', '.env', 'research-notes.md'])
      assert.equal(existsSync(join(destination, path)), false, path);
    assert.equal(readFileSync(join(destination, 'unrelated.txt'), 'utf8'), 'keep');
    rmSync(join(source, previewFiles.at(-1)));
    writeFileSync(join(destination, previewFiles[0]), 'previous snapshot');
    assert.throws(() => syncDesignPreview(source, destination), /ENOENT/);
    assert.equal(readFileSync(join(destination, previewFiles[0]), 'utf8'), 'previous snapshot', 'Missing dependencies must fail before copying');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
