#!/usr/bin/env node
/** Opt-in core benchmark; excluded from the *.test.mjs suite.
 * Usage:
 *   node tests/drf/background-performance.mjs --input /tmp/echomap-input.json \
 *     --source /absolute/checkout --output /tmp/echomap-before.json
 *   node tests/drf/background-performance.mjs --input /tmp/echomap-input.json \
 *     --output /tmp/echomap-after.json --expected /tmp/echomap-before.json
 * Input: scenario settings JSON, normalized by the selected checkout.
 * Output: phase timings, memory samples, and exact numerical prefix digests.
 * Same-input digest equality checks behavior preservation, not mathematical
 * correctness. This measures core computation without UI, message transport,
 * full history retention, or browser scheduling; it cannot establish UI latency.
 * Complexity and memory match the causal kernels plus one frame for hashing.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import assert from 'node:assert/strict';

const usage = 'Usage: node tests/drf/background-performance.mjs --input SETTINGS.json [--source CHECKOUT] [--output REPORT.json] [--expected BASELINE.json] [--repeats 1..10]';
const args = process.argv.slice(2), options = {};
if (args.includes('--help')) { console.log(usage); process.exit(0); }
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  if (!['--input', '--source', '--output', '--expected', '--repeats'].includes(key)
      || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, key)) throw new Error(usage);
  options[key] = args[i + 1];
}
if (!options['--input']) throw new Error(`An explicit input file is required; no implicit large run. ${usage}`);
const repeats = Number(options['--repeats'] ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('--repeats must be an integer from 1 to 10');
const source = resolve(options['--source'] ?? fileURLToPath(new URL('../../', import.meta.url)));
const load = name => import(pathToFileURL(resolve(source, 'drf', name)).href);
const [{ generateScenario, normalizeInput }, { createGrid, createField }, { MethodComparison, METHOD_PROTOCOL }, { createPSPTEvaluator }] = await Promise.all([
  load('scenario.mjs'), load('field.mjs'), load('comparison.mjs'), load('pspt-evaluate.mjs'),
]);
const input = normalizeInput(JSON.parse(await readFile(resolve(options['--input']), 'utf8')));
if (!(input.sigmaD > 0)) throw new Error('Range SD must be greater than zero');

// Timing fields do not participate. Preserve typed-array bytes, signed zero and
// nonfinite metrics so failures cannot silently compare equal to missing values.
const timingKeys = new Set(['ms', 'psptMs', 'simulatorMs']);
function numericalJSON(value) {
  return JSON.stringify(value, (_key, item) => {
    if (ArrayBuffer.isView(item)) return { $typed: item.constructor.name,
      bytes: Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('base64') };
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0)))
      return { $number: Object.is(item, -0) ? '-0' : String(item) };
    if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(
      Object.keys(item).filter(key => !timingKeys.has(key)).sort().map(key => [key, item[key]]));
    return item;
  });
}
const digest = value => createHash('sha256').update(numericalJSON(value)).digest('hex');
const runs = [];
for (let repeat = 0; repeat < repeats; repeat++) {
  const totalStart = performance.now(), rssStartBytes = process.memoryUsage().rss;
  let rssPeakBytes = rssStartBytes, start = performance.now();
  const scene = await generateScenario(input), generationMs = performance.now() - start;
  start = performance.now();
  const grid = createGrid(input.grid, input.grid, scene.domain),
    field = createField(grid, { band: input.band, perimeter: input.perimeter }),
    estimator = new MethodComparison({ sigmaR: input.sigmaD }),
    guardedEvaluator = createPSPTEvaluator(scene, grid), baselineEvaluator = createPSPTEvaluator(scene, grid);
  const setupMs = performance.now() - start;
  start = performance.now();
  const scenarioDigest = digest({ scene, grid, protocol: METHOD_PROTOCOL }), prefixes = [];
  let verificationMs = performance.now() - start, fieldMs = 0, estimatorMs = 0, evaluationMs = 0;
  const estimatorReportedMs = { guarded: 0, baseline: 0 };
  for (const wire of scene.wire) {
    start = performance.now(); const frame = field.step(wire); fieldMs += performance.now() - start;
    start = performance.now(); frame.methods = estimator.step(wire); estimatorMs += performance.now() - start;
    for (const method of ['guarded', 'baseline']) estimatorReportedMs[method] += frame.methods[method].ms;
    frame.candidates = frame.methods.guarded.candidates;
    frame.psptMs = frame.methods.guarded.ms; frame.method = 'guarded-tuned';
    start = performance.now();
    const guarded = guardedEvaluator.step(frame), baseline = baselineEvaluator.step({ ...frame,
      candidates: frame.methods.baseline.candidates, method: 'baseline-b' }, guarded);
    const evaluation = { ...guarded, methods: { guarded, baseline } };
    evaluationMs += performance.now() - start;
    start = performance.now();
    prefixes.push({ t: frame.t, frameDigest: digest(frame), evaluationDigest: digest(evaluation) });
    verificationMs += performance.now() - start;
    rssPeakBytes = Math.max(rssPeakBytes, process.memoryUsage().rss);
  }
  const elapsedMs = performance.now() - totalStart;
  runs.push({ repeat: repeat + 1, scenarioDigest, prefixes,
    numericalDigest: digest({ scenarioDigest, prefixes }),
    timing: { generationMs, setupMs, fieldMs, estimatorMs, estimatorReportedMs, evaluationMs, verificationMs,
      coreMs: generationMs + setupMs + fieldMs + estimatorMs + evaluationMs, elapsedMs },
    memory: { rssStartBytes, rssPeakBytes, rssEndBytes: process.memoryUsage().rss } });
}
for (const run of runs.slice(1)) assert.equal(run.numericalDigest, runs[0].numericalDigest, 'Repeated runs changed numerical outputs');
let commit = null;
try { commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const median = values => { const ordered = [...values].sort((a, b) => a - b); return ordered.length % 2 ? ordered[(ordered.length - 1) / 2] : (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2; };
const report = { schema: 'echomap-core-benchmark/1', input, source, commit,
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model },
  scope: 'Core kernels only. Exact prefix parity excludes timing; CPU timing excludes rendering and message transport. RSS peak is sampled once per snapshot.',
  runs, medianMs: Object.fromEntries(['generationMs', 'setupMs', 'fieldMs', 'estimatorMs', 'evaluationMs', 'verificationMs', 'coreMs', 'elapsedMs']
    .map(key => [key, median(runs.map(run => run.timing[key]))])) };
if (options['--expected']) {
  const expected = JSON.parse(await readFile(resolve(options['--expected']), 'utf8'));
  assert.equal(numericalJSON(report.input), numericalJSON(expected.input), 'Benchmark inputs differ');
  for (const run of report.runs) assert.equal(run.numericalDigest, expected.runs[0].numericalDigest,
    'Numerical output differs; inspect per-snapshot frame/evaluation digests before comparing speed');
  report.expected = { path: resolve(options['--expected']), numericalEquality: true };
}
const output = JSON.stringify(report, null, 2) + '\n';
if (options['--output']) await writeFile(resolve(options['--output']), output);
process.stdout.write(output);
