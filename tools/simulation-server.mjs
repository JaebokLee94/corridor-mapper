#!/usr/bin/env node
import { experimentSettings as normalizeInput } from '../drf/experiment-settings.mjs';
/** Loopback-only computation service. Workers own jobs independently of clients.
 * SSE carries small availability notices; lossless binary packets are spooled to
 * disk once and fetched separately. Slow/disconnected viewers never pace CPU work.
 * Completed jobs expire after 24 h (at most 2 retained); a server restart does not
 * resume estimator internals. No sockets or filesystem paths come from requests.
 */
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { availableParallelism, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, rm, realpath, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';
import { encodePacket } from '../drf/simulation-codec.mjs';

const TERMINAL = new Set(['done', 'cancelled', 'failed']);
const MIME = { '.gz': 'application/gzip', '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

async function requestJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw fail(415, 'Use application/json');
  let length = 0; const chunks = [];
  for await (const chunk of request) {
    length += chunk.length; if (length > 1024 * 1024) throw fail(413, 'Request exceeds 1 MiB'); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Invalid JSON request'); }
}

function normalizeRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail(400, 'Expected an object');
  const mode = raw.mode ?? 'comparison';
  const check = input => { const normalized = normalizeInput(input); if (!(normalized.sigmaD > 0)) throw fail(400, 'Range SD must be positive'); return normalized; };
  if (mode === 'comparison') return { mode, input: check(raw.input), single: raw.single === true };
  if (mode !== 'sweep' || !Array.isArray(raw.jobs) || !raw.jobs.length || raw.jobs.length > 1000)
    throw fail(400, 'A sweep requires 1–1,000 jobs');
  const jobs = raw.jobs.map(check), signatures = jobs.map(value => JSON.stringify(value));
  if (new Set(signatures).size !== jobs.length) throw fail(400, 'Duplicate sweep jobs');
  return { mode, jobs };
}

export async function createSimulationServer({ root = defaultRoot, cacheDirectory, sweepWorkers = Math.min(4, Math.max(1, availableParallelism() - 1)),
  completedTtlMs = 24 * 60 * 60 * 1000, maxRetainedJobs = 2, maxJobBytes = 512 * 1024 ** 2,
  writePacket = writeFile } = {}) {
  if (!Number.isInteger(sweepWorkers) || sweepWorkers < 1 || sweepWorkers > 8) throw new Error('Use 1–8 sweep workers');
  if (!(completedTtlMs > 0) || !Number.isInteger(maxRetainedJobs) || maxRetainedJobs < 1) throw new Error('Invalid retention policy');
  if (typeof writePacket !== 'function') throw new Error('Packet writer must be a function');
  root = await realpath(root);
  const cacheRoot = cacheDirectory ? resolve(cacheDirectory) : tmpdir();
  await mkdir(cacheRoot, { recursive: true });
  // Only this service's marked, inactive session directories may be removed.
  // A crash/restart cannot leave unbounded old caches behind.
  if (cacheDirectory) for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^echomap-server-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const directory = join(cacheRoot, entry.name);
    try {
      const marker = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
      if (marker.schema !== 'echomap-local-cache/1' || !Number.isInteger(marker.pid)) continue;
      let live = true;
      try { process.kill(marker.pid, 0); } catch (error) { if (error.code === 'ESRCH') live = false; }
      if (!live) await rm(directory, { recursive: true, force: true });
    } catch { /* Unmarked directories are never owned by this service. */ }
  }
  const storage = await mkdtemp(join(cacheRoot, 'echomap-server-')), jobs = new Map();
  await writeFile(join(storage, 'session.json'), JSON.stringify({ schema: 'echomap-local-cache/1', pid: process.pid, createdAt: Date.now() }));
  let stopping = false, starting = false;
  const view = job => ({ id: job.id, mode: job.mode, status: job.status, next: job.next, total: job.total,
    input: job.request.input, jobs: job.request.jobs, seq: job.publishedSeq, createdAt: job.createdAt,
    completedAt: job.completedAt, bytes: job.bytes, error: job.error,
    eventsUrl: `/api/jobs/${job.id}/events`, statusUrl: `/api/jobs/${job.id}`, messagesUrl: `/api/jobs/${job.id}/messages` });
  async function flushClient(job, client) {
    if (client.pumping || client.response.destroyed) return;
    client.pumping = true;
    try {
      while (!client.response.destroyed && client.cursor < job.records.length) {
        const notice = job.records[client.cursor++];
        if (!client.response.write(`id: ${notice.seq}\nevent: notice\ndata: ${JSON.stringify(notice)}\n\n`)) {
          await new Promise(resolveDrain => {
            const cleanupDrain = () => { clearTimeout(timeout); client.response.off('drain', cleanupDrain); client.response.off('close', cleanupDrain); resolveDrain(); };
            const timeout = setTimeout(() => { client.response.destroy(); cleanupDrain(); }, 30000); timeout.unref();
            client.response.once('drain', cleanupDrain); client.response.once('close', cleanupDrain);
          });
        }
      }
    } finally { client.pumping = false; }
  }
  async function expire(job) {
    for (const client of job.clients) client.response.end();
    jobs.delete(job.id); await job.queue.catch(() => {}); await rm(job.directory, { recursive: true, force: true });
  }
  async function cleanup() {
    const completed = [...jobs.values()].filter(job => TERMINAL.has(job.status)).sort((a, b) => b.createdAt - a.createdAt);
    for (let i = 0; i < completed.length; i++) if (i >= maxRetainedJobs || Date.now() - completed[i].completedAt > completedTtlMs)
      await expire(completed[i]);
  }
  function stopWorkers(job) {
    for (const worker of job.workers) void worker.terminate(); job.workers.clear();
  }
  function append(job, metadata, bytes = encodePacket(metadata)) {
    if (job.storageFailed) return;
    if (job.bytes + bytes.byteLength > maxJobBytes && metadata.type !== 'error') {
      stopWorkers(job); job.terminalRequested = true;
      return append(job, { type: 'error', message: 'Job result exceeded the local storage limit. Reduce the workload.' }, encodePacket({ type: 'error', message: 'Job result exceeded the local storage limit. Reduce the workload.' }));
    }
    const seq = ++job.seq, notice = { seq, type: metadata.type, mode: metadata.mode, next: metadata.next,
      id: metadata.id, t: metadata.t, total: metadata.total };
    if (metadata.type === 'frame') job.receivedNext = metadata.next;
    else if (metadata.type === 'sweep-result') job.receivedNext++;
    job.bytes += bytes.byteLength;
    job.queue = job.queue.then(async () => {
      // These writes may already have been queued when an earlier write fails.
      // Never publish a gapped history or let a queued "done" erase that failure.
      if (job.storageFailed) return;
      await writePacket(join(job.directory, `${seq}.bin`), bytes);
      if (metadata.type === 'status') {
        job.status = metadata.mode; job.next = metadata.next ?? job.next;
        if (TERMINAL.has(job.status)) job.completedAt = Date.now();
      } else if (metadata.type === 'frame') job.next = metadata.next;
      else if (metadata.type === 'sweep-result') job.next++;
      else if (metadata.type === 'error') { job.status = 'failed'; job.error = metadata.message ?? 'Simulation worker failed'; job.completedAt = Date.now(); }
      job.records.push(notice); job.publishedSeq = seq;
      for (const client of job.clients) void flushClient(job, client);
    }).catch(error => {
      if (job.storageFailed) return;
      job.storageFailed = true; job.terminalRequested = true; stopWorkers(job);
      job.status = 'failed'; job.error = `Cannot store simulation result: ${error.message}`; job.completedAt = Date.now();
      for (const client of job.clients) { client.response.write(`event: server-error\ndata: ${JSON.stringify({ message: job.error })}\n\n`); client.response.end(); }
    });
  }
  function workerFailure(job, error) {
    if (job.terminalRequested || stopping) return;
    job.terminalRequested = true; stopWorkers(job); append(job, { type: 'error', message: error.message });
  }
  function addWorker(job, mode) {
    const worker = new Worker(new URL('./simulation-worker.mjs', import.meta.url), { workerData: { mode } });
    job.workers.add(worker);
    worker.on('error', error => workerFailure(job, error));
    worker.on('exit', code => { job.workers.delete(worker); if (!job.terminalRequested) workerFailure(job, new Error(`Calculation worker exited (${code})`)); });
    return worker;
  }
  async function createJob(request) {
    await cleanup();
    if ([...jobs.values()].some(job => !job.terminalRequested && !TERMINAL.has(job.status))) throw fail(409, 'Another simulation is already active');
    const id = randomUUID(), directory = join(storage, id); await mkdir(directory);
    const job = { id, directory, request, mode: request.mode, status: 'running', next: 0, receivedNext: 0,
      total: request.mode === 'sweep' ? request.jobs.length : request.input.snapshots,
      seq: 0, publishedSeq: 0, bytes: 0, records: [], queue: Promise.resolve(), workers: new Set(), clients: new Set(),
      terminalRequested: false, createdAt: Date.now(), completedAt: null };
    jobs.set(id, job);
    if (request.mode === 'comparison') {
      const worker = addWorker(job, request.mode);
      worker.on('message', message => {
        if (job.terminalRequested) return;
        append(job, message, message.bytes);
        if (message.type === 'error' || (message.type === 'status' && TERMINAL.has(message.mode))) {
          job.terminalRequested = true; stopWorkers(job);
        }
      });
      worker.postMessage({ type: 'start', requestId: id, input: request.input, single: request.single });
    } else {
      let cursor = 0, completed = 0;
      append(job, { type: 'status', mode: 'running', next: 0, total: request.jobs.length });
      const dispatch = worker => { if (cursor < request.jobs.length) { const index = cursor++; worker.postMessage({ type: 'run', id: index, input: request.jobs[index] }); } };
      for (let k = 0; k < Math.min(sweepWorkers, request.jobs.length); k++) {
        const worker = addWorker(job, request.mode);
        worker.on('message', message => {
          if (job.terminalRequested) return;
          append(job, message, message.bytes);
          if (message.type === 'error') { job.terminalRequested = true; stopWorkers(job); }
          else if (message.type === 'sweep-result') {
            completed++;
            if (completed === request.jobs.length) {
              job.terminalRequested = true; stopWorkers(job);
              append(job, { type: 'status', mode: 'done', next: completed, total: request.jobs.length });
            } else dispatch(worker);
          }
        });
        dispatch(worker);
      }
    }
    return job;
  }
  async function startJob(request) {
    if (starting) throw fail(409, 'Another simulation is starting');
    starting = true;
    try { return await createJob(request); } finally { starting = false; }
  }
  function command(job, type) {
    if (!['pause', 'resume', 'step', 'cancel'].includes(type)) throw fail(400, 'Unknown command');
    if (job.terminalRequested || TERMINAL.has(job.status)) return;
    if (type === 'cancel') {
      job.terminalRequested = true; stopWorkers(job);
      append(job, { type: 'status', mode: 'cancelled', next: job.receivedNext, total: job.total }); return;
    }
    if (job.mode === 'sweep') throw fail(400, 'Sweeps support cancellation only');
    for (const worker of job.workers) worker.postMessage({ type, requestId: job.id });
  }
  async function handler(request, response) {
    try {
      const port = server.address()?.port, allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(request.headers.host)) throw fail(403, 'Loopback Host required');
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}`) throw fail(403, 'Same-origin requests only');
      const url = new URL(request.url, `http://${request.headers.host}`), path = decodeURIComponent(url.pathname);
      // A link from another app/site may open the viewer itself. This exception
      // never covers API data, subresources, embedded frames, or write requests.
      const enteringViewer = request.method === 'GET' && ['/', '/drf.html'].includes(path)
        && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      if (request.headers['sec-fetch-site'] === 'cross-site' && !enteringViewer) throw fail(403, 'Cross-site requests are not allowed');
      if (path === '/api/health' && request.method === 'GET') return json(response, 200,
        { schema: 'echomap-server/1', service: 'echomap-local', maxConcurrent: 1, sweepWorkers, retentionHours: completedTtlMs / 3600000 });
      if (path === '/api/jobs') {
        if (request.method === 'GET') { await cleanup(); return json(response, 200, { jobs: [...jobs.values()].map(view).reverse() }); }
        if (request.method === 'POST') {
          const raw = await requestJson(request); let normalized;
          try { normalized = normalizeRequest(raw); } catch (error) { throw fail(error.status ?? 400, error.message); }
          return json(response, 201, view(await startJob(normalized)));
        }
      }
      const route = /^\/api\/jobs\/([a-f0-9-]+)(?:\/(events|command|messages)(?:\/(\d+))?)?$/.exec(path);
      if (route) {
        const job = jobs.get(route[1]); if (!job) throw fail(404, 'Job was not found or its retained results expired');
        if (!route[2] && request.method === 'GET') return json(response, 200, view(job));
        if (route[2] === 'command' && request.method === 'POST') { command(job, (await requestJson(request)).type); return json(response, 202, view(job)); }
        if (route[2] === 'messages' && request.method === 'GET') {
          const seq = Number(route[3]); if (!Number.isSafeInteger(seq) || seq < 1 || seq > job.publishedSeq) throw fail(404, 'Message unavailable');
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, max-age=3600',
            'Content-Encoding': 'gzip', 'X-Content-Type-Options': 'nosniff' });
          pipeline(createReadStream(join(job.directory, `${seq}.bin`)), createGzip({ level: 1 }), response, () => {}); return;
        }
        if (route[2] === 'events' && request.method === 'GET') {
          const after = Number(request.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(after) || after < 0 || after > job.publishedSeq) throw fail(400, 'Invalid event cursor');
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.flushHeaders(); const client = { response, cursor: after, pumping: false }; job.clients.add(client);
          void flushClient(job, client);
          const heartbeat = setInterval(() => { if (!client.pumping) response.write(': keepalive\n\n'); }, 15000);
          heartbeat.unref(); response.on('close', () => { clearInterval(heartbeat); job.clients.delete(client); }); return;
        }
        throw fail(405, 'Unsupported job endpoint or method');
      }
      if (path.startsWith('/api/')) throw fail(404, 'Unknown endpoint');
      if (!['GET', 'HEAD'].includes(request.method)) throw fail(405, 'Read-only static files');
      const relative = path === '/' ? 'drf.html' : path.slice(1);
      if (relative.split('/').some(part => part.startsWith('.') || part.includes('\\')) || !MIME[extname(relative)]) throw fail(404, 'File not found');
      const target = await realpath(resolve(root, relative)).catch(() => { throw fail(404, 'File not found'); });
      if (!target.startsWith(root + sep) || !(await stat(target)).isFile()) throw fail(404, 'File not found');
      response.writeHead(200, { 'Content-Type': MIME[extname(target)], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      if (request.method === 'HEAD') return response.end();
      if (target === join(root, 'drf.html')) {
        const html = (await readFile(target, 'utf8')).replace(/(<meta\s+name=["']echomap-compute["']\s+content=["'])browser(["']\s*\/?>)/i, '$1server$2');
        return response.end(html);
      }
      pipeline(createReadStream(target), response, () => {});
    } catch (error) {
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : 'Local server error' }); else response.destroy();
    }
  }
  const server = http.createServer((request, response) => { void handler(request, response); });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  const maintenance = setInterval(() => { void cleanup(); }, Math.min(completedTtlMs, 60000)); maintenance.unref();
  return { server, storage,
    async listen(port = 9174) {
      await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      stopping = true; clearInterval(maintenance);
      for (const job of jobs.values()) { job.terminalRequested = true; stopWorkers(job); for (const client of job.clients) client.response.end(); }
      await Promise.all([...jobs.values()].map(job => job.queue.catch(() => {})));
      server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose));
      await rm(storage, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!['--port', '--workers', '--root', '--cache-dir'].includes(key) || value == null) throw new Error('Options: --port 9174 --workers 4 --root /site/path --cache-dir /cache/path');
    options[key.slice(2)] = value;
  }
  const service = await createSimulationServer({ root: options.root, cacheDirectory: options['cache-dir'], ...(options.workers ? { sweepWorkers: Number(options.workers) } : {}) });
  console.log(`EchoMap local computation: ${await service.listen(Number(options.port ?? 9174))}/drf.html`);
  let exiting = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (exiting) return; exiting = true; await service.close(); process.exit(0); });
}
