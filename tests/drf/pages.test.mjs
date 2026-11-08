import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runtimeFiles } from '../../tools/pages-manifest.mjs';

test('Pages ships the original simulator with all dependencies and no design preview', () => {
  const root = new URL('../../', import.meta.url), output = new URL('_site/', root);
  execFileSync(process.execPath, ['build-pages.mjs'], { cwd: root });
  const files = readdirSync(output, { recursive: true }).filter(path => existsSync(new URL(path, output)) && /\.[a-z]+$/.test(path));
  assert.deepEqual(files.filter(path => path.endsWith('.html')).sort(), ['drf.html']);
  assert.deepEqual(files.sort(), [...runtimeFiles].sort());
  for (const path of ['server-client.mjs', 'simulation-codec.mjs', 'run-engine.mjs', 'run.worker.mjs', 'baseline.mjs', 'comparison.mjs', 'compare.worker.mjs', 'scenario.worker.mjs', 'field.worker.mjs', 'eval.worker.mjs', 'sweep.worker.mjs', 'pspt.worker.mjs', 'pspt.mjs', 'pspt-math.mjs', 'pspt-ridges.mjs', 'pspt-evaluate.mjs',
    'statistics.mjs', 'reflection-diagnostics.mjs', 'provenance.json', 'reference/octave/fixtures.json', 'offline.bundle.js', 'style.css'])
    assert.ok(existsSync(new URL(`drf/${path}`, output)), `Dynamic runtime asset: ${path}`);
  for (const path of ['index.html', 'legacy.html', 'surf/app.mjs', 'surf/engine.worker.mjs', 'tests', 'README.md', 'drf/evaluate.mjs', 'preview', 'design-preview', 'drf-design-preview.html', 'preview-cache', 'preview-evidence', 'node_modules', '.git', 'tools'])
    assert.equal(existsSync(new URL(path, output)), false, path);
  const html = readFileSync(new URL('drf.html', output), 'utf8');
  assert.match(html, /<meta name="echomap-compute" content="browser"\s*\/?>/);
  // Static publication uses isolated browser workers, never a visitor's localhost.
  assert.ok(!html.includes('127.0.0.1'));
  for (const match of html.matchAll(/(?:href|src)=["']([^"'#]+)["']|runtime\.src=['"]([^'"]+)['"]/g)) {
    const reference = match[1] ?? match[2];
    if (/^[a-z]+:/i.test(reference)) continue;
    assert.ok(!reference.startsWith('/'), 'GitHub Pages is served under /corridor-mapper/');
    assert.ok(existsSync(new URL(reference.split('?')[0], output)), `drf.html: ${reference}`);
  }
  assert.ok(!/href="(?:\.\/|index\.html|legacy\.html)"/.test(html));
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
});
