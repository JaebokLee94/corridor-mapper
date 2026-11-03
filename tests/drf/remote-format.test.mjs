import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunEngine } from '../../drf/run-engine.mjs';
import { METHOD_PROTOCOL } from '../../drf/comparison.mjs';
import { normalizeRemoteRequest, remoteJobs, stringifyRemoteResult, parseRemoteResult } from '../../drf/remote-format.mjs';

const input = { scene: 'reference', vehicles: 2, snapshots: 2, grid: 100, cellStep: .2, seed: 42, roughness: 0, specular: false };
const request = mode => normalizeRemoteRequest({ schema: 'echomap-request/1', mode, input,
  ...(mode === 'sweep' ? { sweep: { noise: [.05, .1], roughness: [0], seeds: [42, 43] } } : {}) });
const result = (req, body) => ({ schema: 'echomap-remote/1', request: req, status: 'complete',
  provenance: { commit: 'fixture', node: process.version }, protocol: METHOD_PROTOCOL, ...body });

test('cloud requests retain the experiment settings and reject unknown executable or tuning input', () => {
  const req = request('sweep'), jobs = remoteJobs(req);
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs.map(p => [p.sigmaD, p.roughness, p.seed]), [[.05, 0, 42], [.05, 0, 43], [.1, 0, 42], [.1, 0, 43]]);
  for (const job of jobs) for (const key of Object.keys(req.input).filter(k => !['sigmaD', 'roughness', 'seed'].includes(k)))
    assert.equal(job[key], req.input[key]);
  assert.throws(() => normalizeRemoteRequest({ ...req, command: 'echo no' }), /unsupported field/);
  assert.throws(() => normalizeRemoteRequest({ ...req, input: { ...req.input, threshold: 1 } }), /unsupported field/);
  for (const noise of [[0], [-1], [NaN], [Infinity], [.1, .1]])
    assert.throws(() => normalizeRemoteRequest({ ...req, sweep: { ...req.sweep, noise } }));
  assert.throws(() => normalizeRemoteRequest({ ...req, sweep: { ...req.sweep, seeds: [-1] } }));
  assert.throws(() => normalizeRemoteRequest({ ...req, sweep: { noise: Array.from({ length: 20 }, (_, i) => (i + 1) / 100), roughness: [0, 2], seeds: Array.from({ length: 26 }, (_, i) => i) } }), /1,000/);
});

test('remote serialization preserves actual snapshot arrays and separates nonfinite failures from missing metrics', async () => {
  const req = request('comparison'), comparison = { scenario: null, grid: null, frames: [], evaluations: [] };
  const engine = createRunEngine({ emit(message) {
    if (message.type === 'error') throw new Error(message.message);
    if (message.type === 'prepared') Object.assign(comparison, { scenario: message.scenario, grid: message.grid });
    if (message.type === 'frame') { comparison.frames.push(message.frame); comparison.evaluations.push(message.evaluation); }
  } });
  await engine.command({ type: 'start', requestId: 1, input: req.input });
  const original = result(req, { comparison });
  original.provenance.check = { failed: Infinity, other: NaN, negative: -Infinity, missing: null };
  const decoded = parseRemoteResult(stringifyRemoteResult(original));
  assert.deepEqual(decoded, original, 'No numeric precision or nonfinite metric classification is lost in transit');
  assert.ok(decoded.comparison.frames[0].Dbar instanceof Float32Array);
  assert.ok(decoded.comparison.grid.x instanceof Float64Array);
  assert.throws(() => parseRemoteResult(stringifyRemoteResult({ ...original, comparison: { ...comparison, frames: comparison.frames.slice(1) } })), /snapshot/);
  const partial = { ...original, status: 'partial', comparison: { ...comparison, frames: comparison.frames.slice(0, 1), evaluations: comparison.evaluations.slice(0, 1) } };
  assert.equal(parseRemoteResult(stringifyRemoteResult(partial)).status, 'partial');
  assert.throws(() => parseRemoteResult(stringifyRemoteResult({ ...original, protocol: { ...METHOD_PROTOCOL, baseline: { threshold: 0 } } })), /protocol/);
});

test('sweep imports reject duplicate, foreign or incomplete completed results before they can be pooled', () => {
  const req = request('sweep');
  const summary = { precision: null, recall: 0, holdRate: 1, firstSupportPrecision: null,
    medianError: Infinity, p95: Infinity, offwall: null, f1: 0, observedFraction: 0 };
  const runs = remoteJobs(req).map(input => ({ input, protocol: METHOD_PROTOCOL,
    methods: { guarded: { summary }, baseline: { summary } } }));
  const original = result(req, { sweep: { runs, total: 4 } });
  const decoded = parseRemoteResult(stringifyRemoteResult(original));
  assert.equal(decoded.sweep.runs[0].methods.guarded.summary.p95, Infinity);
  assert.throws(() => parseRemoteResult(stringifyRemoteResult({ ...original, sweep: { runs: runs.slice(0, 2), total: 4 } })), /Incomplete/);
  assert.throws(() => parseRemoteResult(stringifyRemoteResult({ ...original, sweep: { runs: [runs[0], runs[0], runs[2], runs[3]], total: 4 } })), /duplicated/);
  assert.throws(() => parseRemoteResult(stringifyRemoteResult({ ...original, sweep: { runs: [{ ...runs[0], input: { ...runs[0].input, vehicles: 9 } }, ...runs.slice(1)], total: 4 } })), /Unexpected/);
  assert.equal(parseRemoteResult(stringifyRemoteResult({ ...original, status: 'partial', sweep: { runs: runs.slice(0, 2), total: 4 } })).sweep.runs.length, 2);
});
