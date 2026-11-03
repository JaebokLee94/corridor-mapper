import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runRemoteRequest, saveRemoteResult } from '../../tools/remote-run.mjs';
import { parseRemoteResult } from '../../drf/remote-format.mjs';
import { createRunEngine } from '../../drf/run-engine.mjs';
import { runExperiment } from '../../drf/sweep.mjs';

const input = { scene: 'reference', vehicles: 3, snapshots: 3, grid: 100,
  roughness: 2, cellStep: .2, seed: 42, sigmaP: .1, sigmaD: .1 };
const request = { schema: 'echomap-request/1', mode: 'comparison', input };
const numerical = value => {
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(numerical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['ms', 'psptMs', 'simulatorMs', 'timing', 'provenance'].includes(key))
    .map(([key, item]) => [key, numerical(item)]));
  return value;
};

test('remote comparison preserves every causal prefix and its binary field hash', async () => {
  const remote = await runRemoteRequest(request), messages = [];
  await createRunEngine({ emit: message => messages.push(structuredClone(message)) })
    .command({ type: 'start', requestId: 7, input });
  assert.equal(remote.status, 'complete');
  const prepared = messages.find(message => message.type === 'prepared');
  assert.deepEqual(numerical(remote.comparison.scenario), numerical(prepared.scenario));
  assert.deepEqual(remote.comparison.grid, prepared.grid);
  const frames = messages.filter(message => message.type === 'frame');
  assert.deepEqual(numerical(remote.comparison.frames), numerical(frames.map(message => message.frame)));
  assert.deepEqual(numerical(remote.comparison.evaluations), numerical(frames.map(message => message.evaluation)));
  const hash = createHash('sha256');
  for (const values of [frames.at(-1).frame.Dbar, frames.at(-1).frame.betaHat]) hash.update(Buffer.from(values.buffer));
  assert.equal(remote.provenance.finalFieldSha256, hash.digest('hex'));
});

test('bounded Node sweep preserves original job order, summaries and intermediate progress', async () => {
  const sweep = { schema: 'echomap-request/1', mode: 'sweep', input,
    sweep: { noise: [.1, .2], roughness: [2], seeds: [9, 3] } };
  const updates = [], checkpoints = [];
  const result = await runRemoteRequest(sweep, { concurrency: 2,
    onProgress: value => updates.push(value), onCheckpoint: value => checkpoints.push(structuredClone(value)) });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.sweep.runs.map(run => [run.input.sigmaD, run.input.seed]), [[.1, 9], [.1, 3], [.2, 9], [.2, 3]]);
  assert.ok(updates.some(value => value.phase === 'generating' && value.snapshot > 0 && value.completed === 0), 'measurement generation progress is visible before evaluation starts');
  assert.ok(updates.some(value => value.phase === 'evaluating' && value.snapshot === 1 && value.completed === 0), 'first seed progress is visible before any job completes');
  assert.equal(checkpoints.filter(value => value.status === 'partial').length, 4);
  for (const run of result.sweep.runs) {
    const { final, ...expected } = await runExperiment(run.input);
    assert.deepEqual(numerical(run), numerical(expected));
    assert.equal('final' in run, false, 'sweep results do not retain dense display fields');
  }
});

test('cancelling comparison keeps only completed snapshots and labels the result partial', async () => {
  const abort = new AbortController();
  const result = await runRemoteRequest(request, { signal: abort.signal,
    onProgress: update => { if (update.phase === 'evaluating' && update.snapshot === 2) abort.abort(); } });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.comparison.frames.map(frame => frame.t), [1, 2]);
  assert.equal(result.comparison.evaluations.length, 2);
  assert.equal(result.provenance.finalFieldSha256, undefined);
});

test('cancelling sweep keeps fully completed jobs and does not invent unfinished results', async () => {
  const abort = new AbortController(), checkpoints = [];
  const result = await runRemoteRequest({ ...request, mode: 'sweep', sweep: { noise: [.1], roughness: [2], seeds: [1, 2, 3] } }, {
    concurrency: 1, signal: abort.signal,
    onProgress: update => { if (update.phase === 'completed') abort.abort(); },
    onCheckpoint: value => checkpoints.push(structuredClone(value)),
  });
  assert.equal(result.status, 'partial'); assert.equal(result.sweep.total, 3);
  assert.deepEqual(result.sweep.runs.map(run => run.input.seed), [1]);
  assert.ok(checkpoints.length >= 2); assert.ok(checkpoints.every(value => value.status === 'partial'));
});

test('checkpoint gzip roundtrip preserves typed arrays, nonfinite metrics and partial status', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'echomap-remote-result-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const abort = new AbortController();
  const result = await runRemoteRequest({ ...request, input: { ...input, roughness: 0, specular: false } }, {
    signal: abort.signal, onProgress: update => { if (update.phase === 'evaluating' && update.snapshot === 1) abort.abort(); },
  });
  await saveRemoteResult(result, directory);
  const restored = parseRemoteResult(gunzipSync(await readFile(join(directory, 'result.json.gz'))).toString('utf8'));
  assert.equal(restored.status, 'partial');
  assert.ok(restored.comparison.frames[0].Dbar instanceof Float32Array);
  assert.deepEqual(restored, result);
  assert.match(await readFile(join(directory, 'summary.md'), 'utf8'), /Completed: 1 \/ 3 snapshots/);
});

test('CLI accepts a JSON environment input and produces a reloadable artifact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'echomap-remote-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = new URL('../../tools/remote-run.mjs', import.meta.url);
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(executable), '--output', directory], {
    env: { ...process.env, ECHOMAP_REQUEST: JSON.stringify({ ...request, input: { ...input, snapshots: 1 } }) },
  });
  assert.match(stdout, /evaluating 1\/1/);
  const restored = parseRemoteResult(gunzipSync(await readFile(join(directory, 'result.json.gz'))).toString('utf8'));
  assert.equal(restored.status, 'complete'); assert.equal(restored.comparison.frames.length, 1);
  assert.match(restored.provenance.commit, /^[a-f0-9]{40}$/);
});

test('invalid requests and unbounded worker counts are rejected before execution', async () => {
  await assert.rejects(runRemoteRequest(request, { concurrency: 4 }), /worker count/);
  await assert.rejects(runRemoteRequest({ ...request, input: { ...input, sigmaD: 0 } }));
});

test('Actions dispatch keeps request text out of shell interpolation and bounds retained resources', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/simulation.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /contents: read/);
  assert.match(workflow, /ECHOMAP_REQUEST: \$\{\{ inputs\.request \}\}/);
  assert.doesNotMatch(workflow, /run:.*\$\{\{.*inputs\./);
  assert.match(workflow, /runs-on: ubuntu-latest/); assert.match(workflow, /retention-days: 3/);
  assert.match(workflow, /if: always\(\)/); assert.match(workflow, /timeout-minutes: 330/);
});
