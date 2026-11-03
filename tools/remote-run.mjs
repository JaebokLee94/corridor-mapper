#!/usr/bin/env node
import { Worker } from 'node:worker_threads';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRunEngine } from '../drf/run-engine.mjs';
import { METHOD_PROTOCOL } from '../drf/comparison.mjs';
import { normalizeRemoteRequest, remoteJobs, stringifyRemoteResult } from '../drf/remote-format.mjs';

const compress = promisify(gzip);
const now = () => new Date().toISOString();

/** Execute a repository validation request without any browser dependency.
 * Input: validated request, optional AbortSignal and bounded worker count (1–3).
 * Output: completed comparison history or completed sweep seed records; partial
 * output never claims that unfinished jobs/snapshots have been evaluated.
 * Comparison memory is O(T * (grid + candidates + evaluation)); sweep memory is
 * O(workers * estimator state + completed summaries), not all snapshot histories.
 */
export async function runRemoteRequest(raw, {
  concurrency = 2, signal, onProgress = () => {}, onCheckpoint = async () => {}, provenance = {},
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3)
    throw new Error('Remote worker count must be an integer from 1 to 3.');
  const request = normalizeRemoteRequest(raw), jobs = remoteJobs(request);
  const result = { schema: 'echomap-remote/1', request, status: 'partial',
    provenance: { ...provenance, node: process.version, platform: process.platform, arch: process.arch,
      workers: request.mode === 'sweep' ? Math.min(concurrency, jobs.length) : 1, startedAt: now() }, protocol: METHOD_PROTOCOL };
  let error;
  try {
    if (request.mode === 'comparison') {
      const comparison = result.comparison = { scenario: null, grid: null, frames: [], evaluations: [] };
      let failure, finished = false;
      const engine = createRunEngine({ emit(message) {
        if (message.type === 'progress') onProgress({ mode: 'comparison', phase: 'generating', snapshot: message.t, total: message.total });
        if (message.type === 'prepared') Object.assign(comparison, structuredClone({ scenario: message.scenario, grid: message.grid }));
        if (message.type === 'frame') {
          // Browser workers clone/transfer these payloads. Match that ownership
          // here so later estimator/evaluator updates cannot mutate past frames.
          comparison.frames.push(structuredClone(message.frame));
          comparison.evaluations.push(structuredClone(message.evaluation));
          onProgress({ mode: 'comparison', phase: 'evaluating', snapshot: message.next, total: request.input.snapshots });
        }
        if (message.type === 'error') failure = new Error(message.message);
        if (message.type === 'status' && message.mode === 'done') finished = true;
      } });
      const abort = () => engine.command({ type: 'cancel', requestId: 1 });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        if (!signal?.aborted) await engine.command({ type: 'start', requestId: 1, input: request.input });
      } finally { signal?.removeEventListener('abort', abort); }
      if (failure) throw failure;
      if (finished) {
        result.status = 'complete';
        const frame = comparison.frames.at(-1), hash = createHash('sha256');
        for (const values of [frame.Dbar, frame.betaHat]) hash.update(Buffer.from(values.buffer, values.byteOffset, values.byteLength));
        result.provenance.finalFieldSha256 = hash.digest('hex');
      }
    } else {
      result.sweep = { runs: [], total: jobs.length };
      const completed = new Map();
      let checkpointQueue = Promise.resolve(), checkpointError;
      await new Promise((resolvePool, rejectPool) => {
        const workers = []; let next = 0, settled = false;
        const snapshot = () => ({ ...result, provenance: { ...result.provenance },
          sweep: { runs: [...completed].sort(([a], [b]) => a - b).map(([, run]) => run), total: jobs.length } });
        const finish = failure => {
          if (settled) return; settled = true;
          signal?.removeEventListener('abort', abort);
          Promise.allSettled(workers.map(worker => worker.terminate())).then(() => failure ? rejectPool(failure) : resolvePool());
        };
        const abort = () => finish();
        const dispatch = worker => {
          if (settled || next >= jobs.length) return;
          const id = next++; worker.postMessage({ id, input: jobs[id] });
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted || !jobs.length) { finish(); return; }
        for (let k = 0; k < Math.min(concurrency, jobs.length); k++) {
          const worker = new Worker(new URL('./remote-sweep.worker.mjs', import.meta.url)); workers.push(worker);
          worker.on('message', message => {
            if (settled) return;
            if (message.type === 'progress') onProgress({ mode: 'sweep', completed: completed.size,
              jobs: jobs.length, input: jobs[message.id], ...message });
            if (message.type === 'error') finish(new Error(`Job ${message.id + 1}: ${message.message}`));
            if (message.type === 'result') {
              completed.set(message.id, message.run); result.sweep.runs = snapshot().sweep.runs;
              onProgress({ mode: 'sweep', phase: 'completed', id: message.id, input: jobs[message.id],
                completed: completed.size, jobs: jobs.length, snapshot: jobs[message.id].snapshots, total: jobs[message.id].snapshots });
              const checkpoint = snapshot();
              checkpointQueue = checkpointQueue.then(() => onCheckpoint(checkpoint)).catch(failure => {
                checkpointError = failure; finish(failure);
              });
              if (completed.size === jobs.length) finish(); else dispatch(worker);
            }
          });
          worker.on('error', finish);
          worker.on('exit', code => { if (!settled) finish(new Error(`Simulation worker exited before completion (code ${code}).`)); });
          dispatch(worker);
        }
      }).finally(async () => { await checkpointQueue; });
      if (checkpointError) throw checkpointError;
      if (completed.size === jobs.length) result.status = 'complete';
    }
  } catch (failure) { error = failure; }
  result.provenance.finishedAt = now();
  await onCheckpoint(result);
  if (error) { error.result = result; throw error; }
  return result;
}

export async function saveRemoteResult(result, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const target = join(outputDirectory, 'result.json.gz'), temporary = `${target}.tmp`;
  const bytes = await compress(stringifyRemoteResult(result));
  await writeFile(temporary, bytes); await rename(temporary, target);
  const completed = result.request.mode === 'sweep' ? result.sweep.runs.length : result.comparison.frames.length;
  const total = result.request.mode === 'sweep' ? result.sweep.total : result.request.input.snapshots;
  const summary = [`# EchoMap ${result.request.mode}`, '', `Status: ${result.status}`,
    `Completed: ${completed} / ${total} ${result.request.mode === 'sweep' ? 'seed/condition jobs' : 'snapshots'}`,
    `Commit: ${result.provenance.commit ?? 'unknown'}`, `Node: ${result.provenance.node}`,
    `Started: ${result.provenance.startedAt}`, `Finished: ${result.provenance.finishedAt ?? 'still running'}`, '',
    'Download the result artifact, unzip it, and load result.json.gz in EchoMap.',
    'Only completed work is included. Thresholds and estimator inputs are unchanged.', ''].join('\n');
  const summaryPath = join(outputDirectory, 'summary.md');
  await writeFile(`${summaryPath}.tmp`, summary); await rename(`${summaryPath}.tmp`, summaryPath);
}

async function main(argv) {
  const args = { output: 'remote-results', workers: 2 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--request', '--output', '--workers'].includes(flag) || !argv[i + 1]) throw new Error('Usage: node tools/remote-run.mjs [--request request.json] [--output directory] [--workers 1..3]');
    args[flag.slice(2)] = argv[++i];
  }
  const raw = args.request ? await readFile(resolve(args.request), 'utf8') : process.env.ECHOMAP_REQUEST;
  if (!raw) throw new Error('Provide --request request.json or ECHOMAP_REQUEST JSON.');
  let commit = process.env.GITHUB_SHA;
  if (!commit) try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim(); } catch { commit = 'unknown'; }
  const provenance = { commit };
  if (process.env.GITHUB_RUN_ID) {
    provenance.runId = process.env.GITHUB_RUN_ID;
    provenance.runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  }
  const abort = new AbortController();
  const stop = () => { console.error('Stopping; completed work will be saved as partial.'); abort.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const request = normalizeRemoteRequest(JSON.parse(raw));
    console.log(`Starting ${request.mode}: ${remoteJobs(request).length} job(s), ${request.input.snapshots} snapshots per job; commit ${commit}`);
    const result = await runRemoteRequest(request, { concurrency: Number(args.workers), signal: abort.signal, provenance,
      onCheckpoint: value => saveRemoteResult(value, resolve(args.output)),
      onProgress(progress) {
        if (progress.snapshot !== 0 && progress.snapshot !== 1 && progress.snapshot !== progress.total && progress.snapshot % 10 !== 0 && progress.phase !== 'completed') return;
        const job = progress.mode === 'sweep' ? `job ${progress.id + 1}/${progress.jobs}, seed ${progress.input.seed}, σd ${progress.input.sigmaD}, roughness ${progress.input.roughness}; ` : '';
        console.log(`${now()} ${job}${progress.phase} ${progress.snapshot}/${progress.total}${progress.mode === 'sweep' ? `; ${progress.completed}/${progress.jobs} jobs complete` : ''}`);
      },
    });
    console.log(`Saved ${result.status} result to ${resolve(args.output, 'result.json.gz')}`);
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, await readFile(resolve(args.output, 'summary.md')), { flag: 'a' });
    if (result.status !== 'complete') process.exitCode = 130;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv.slice(2)).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
