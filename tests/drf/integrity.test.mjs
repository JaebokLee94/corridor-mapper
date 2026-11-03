import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../../', import.meta.url);
const read = path => fs.readFileSync(new URL(path, root));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
test('approved display changes preserve all 43 other protected source/artifact files', () => {
  const baseline = JSON.parse(read('tests/drf/baseline-hashes.json'));
  const allowed = new Set(['index.html', 'surf/style.css', 'surf/map.mjs']);
  // Python bytecode is ignored, runtime-specific output, not a protected source.
  assert.equal(Object.keys(baseline.sha256).length, 46);
  for (const path of Object.keys(baseline.sha256)) assert.doesNotMatch(path, /(^|\/)__pycache__\/|\.pyc$/);
  for (const [path, hash] of Object.entries(baseline.sha256)) if (!allowed.has(path)) assert.equal(sha(read(path)), hash, path);
});
test('displayed frozen DRF core hash matches the actual worker estimator source', () => {
  const provenance = JSON.parse(read('drf/provenance.json')), hash = createHash('sha256');
  for (const path of ['drf/field.mjs', 'drf/wire.mjs']) {
    assert.equal(sha(read(path)), provenance.coreFiles[path], path);
    hash.update(path).update('\0').update(read(path)).update('\0');
  }
  assert.equal(hash.digest('hex'), provenance.coreHash);
});

test('historical 160-run evidence matches archived numerical sources and unchanged estimator sources', () => {
  const report = JSON.parse(read('tests/drf/validation-results.json'));
  // Exact bytes from Git commit 7ab64cf915b9a4f95a8e1265eaa2d9c419f5c5ec.
  // These historical fixtures do not validate the new two-layer wall model.
  const archived = new Set(['drf/wall.mjs', 'drf/scenario.mjs', 'drf/sweep.mjs', 'drf/evaluate.mjs', 'drf/specular.mjs']);
  for (const [path, hash] of Object.entries(report.integrity.initialSHA256)) {
    const source = archived.has(path) ? `tests/drf/legacy-source/${path.slice(4)}` : path;
    assert.equal(sha(read(source)), hash, source);
    assert.equal(report.integrity.finalSHA256[path], hash, path);
  }
  assert.equal(report.execution.completed, 160);
  assert.equal(report.execution.errors, 0);
  assert.equal(report.acceptance.referenceWithinTolerance, report.acceptance.failed === 0);
  assert.equal(report.acceptance.passed + report.acceptance.failed, report.acceptance.comparisons);
});
