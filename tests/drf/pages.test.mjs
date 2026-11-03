import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

test('Pages contains only the DRF page and its complete runtime dependencies', () => {
  const root = new URL('../../', import.meta.url), output = new URL('_site/', root);
  execFileSync(process.execPath, ['build-pages.mjs'], { cwd: root });
  const files = readdirSync(output, { recursive: true }).filter(path => existsSync(new URL(path, output)) && /\.[a-z]+$/.test(path));
  assert.deepEqual(files.filter(path => path.endsWith('.html')), ['drf.html']);
  assert.equal(files.length, 41);
  for (const path of ['server-client.mjs', 'simulation-codec.mjs', 'run-engine.mjs', 'run.worker.mjs', 'baseline.mjs', 'comparison.mjs', 'compare.worker.mjs', 'scenario.worker.mjs', 'field.worker.mjs', 'eval.worker.mjs', 'sweep.worker.mjs', 'pspt.worker.mjs', 'pspt.mjs', 'pspt-math.mjs', 'pspt-ridges.mjs', 'pspt-evaluate.mjs',
    'statistics.mjs', 'reflection-diagnostics.mjs', 'provenance.json', 'reference/octave/fixtures.json', 'offline.bundle.js', 'style.css'])
    assert.ok(existsSync(new URL(`drf/${path}`, output)), `Dynamic runtime asset: ${path}`);
  for (const path of ['index.html', 'legacy.html', 'surf/app.mjs', 'surf/engine.worker.mjs', 'tests', 'README.md', 'drf/evaluate.mjs'])
    assert.equal(existsSync(new URL(path, output)), false, path);
  for (const path of files) {
    const bytes = readFileSync(new URL(path, output));
    assert.ok(bytes.length > 0, path);
    assert.deepEqual(bytes, readFileSync(new URL(path, root)), path);
    if (!path.endsWith('.mjs')) continue;
    for (const match of bytes.toString().matchAll(/(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g))
      assert.ok(existsSync(new URL(match[1].split('?')[0], new URL(path, output))), `${path}: ${match[1]}`);
  }
  const html = readFileSync(new URL('drf.html', output), 'utf8');
  // Icons must survive the explicit deployment allowlist and use project-relative URLs.
  for (const match of html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)) {
    assert.ok(!match[1].startsWith('/'), 'GitHub Pages is served under /corridor-mapper/');
    assert.ok(existsSync(new URL(match[1].split('?')[0], output)), match[1]);
  }
  assert.ok(!/href="(?:\.\/|index\.html|legacy\.html)"/.test(html));
});
