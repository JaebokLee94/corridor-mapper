import { createMessageDecoder } from './simulation-codec.mjs';

const savedKey = 'echomap-server-job/1';
const savedJob = () => { try { return localStorage.getItem(savedKey); } catch { return null; } };
function remember(id) { try { id ? localStorage.setItem(savedKey, id) : localStorage.removeItem(savedKey); } catch {} }
const terminal = new Set(['done', 'cancelled', 'failed']);
const missing = error => [404, 410].includes(error.status);
const permanent = error => error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
async function requestError(response, description) {
  return Object.assign(new Error((await response.json().catch(() => null))?.error ?? `${description} (${response.status})`), { status: response.status });
}
async function json(url, body, { keepalive = false } = {}) {
  const response = await fetch(url, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive,
  });
  if (!response.ok) throw await requestError(response, 'Server request failed');
  return response.json();
}

export async function connectComputeServer() {
  const config = await json('/api/health');
  if (config.schema !== 'echomap-server/1') throw new Error('Unexpected compute server');
  let job = null;
  const id = savedJob();
  if (id) {
    try { job = await json(`/api/jobs/${encodeURIComponent(id)}`); }
    catch (error) { if (missing(error)) remember(null); else throw error; }
  }
  if (!job) {
    // A page can close before the creation response stores its job ID. The local
    // service has at most one active job, so recover that computation on reload.
    const active = (await json('/api/jobs')).jobs.find(item => !terminal.has(item.status));
    if (active) { job = active; remember(job.id); }
  }
  return { ...config, job };
}

/** The connection consumes results only. No acknowledgement or display timer
 * schedules computation. Detach means "stop viewing"; terminate means cancel.
 * Sequential retrieval is required because diagnostics use lossless deltas.
 */
export function createServerRunWorker(_config, { resumeId, mode = 'comparison', jobs } = {}) {
  const decoder = createMessageDecoder();
  let job, stream, creation, cancellation, closed = false, started = false, cancelSent = false,
    cursor = 0, newest = 0, pumping = false, retry, reconnect, probing = false, requestId, connected;
  const handle = { onmessage: null, onerror: null,
    postMessage(message) {
      if (closed) return;
      if (message.type === 'start') {
        if (started) return;
        started = true; requestId = message.requestId;
        creation = begin(message); void creation.catch(error => fatal(error));
      } else if (message.type === 'cancel') {
        void cancelJob().catch(error => commandError('cancel', error));
      } else if (job) {
        void json(`/api/jobs/${job.id}/command`, { type: message.type }, { keepalive: true })
          .catch(error => commandError(message.type, error));
      }
    },
    detach() { closed = true; clearTimeout(retry); clearTimeout(reconnect); stream?.close(); },
    terminate() {
      handle.detach(); return cancelJob();
    },
  };
  function connection(value) {
    if (closed || connected === value) return;
    connected = value; handle.onmessage?.({ data: { type: 'connection', connected: value, requestId } });
  }
  function fatal(error) {
    if (closed) return;
    if (missing(error) && savedJob() === job?.id) remember(null);
    handle.detach(); handle.onerror?.({ message: error.message });
  }
  async function commandError(command, error) {
    if (closed) return;
    // A failed response does not establish whether the command reached the
    // server. Recover its actual state without stopping the independent job.
    let current = null, recoveryError;
    try { current = await json(`/api/jobs/${job.id}`); }
    catch (error) { recoveryError = error.message; }
    if (!closed) handle.onmessage?.({ data: { type: 'command-error', command, message: error.message,
      requestId, job: current, ...(recoveryError ? { recoveryError } : {}) } });
  }
  function cancelJob() {
    if (cancelSent) return Promise.resolve();
    if (cancellation) return cancellation;
    const pending = (async () => {
      if (!job) { if (!creation) return; await creation; }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const current = await json(`/api/jobs/${job.id}/command`, { type: 'cancel' }, { keepalive: true });
          cancelSent = true;
          if (savedJob() === job.id) remember(null);
          return current;
        } catch (error) {
          if (missing(error)) {
            cancelSent = true;
            if (savedJob() === job.id) remember(null);
            return;
          }
          if (permanent(error) || attempt === 2) throw error;
          // Explicit cancellation belongs to the job, not its viewing stream.
          // Keep retrying after detach, but retain the saved ID if unconfirmed.
          await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        }
      }
    })();
    cancellation = pending;
    const clear = () => { if (cancellation === pending) cancellation = null; };
    void pending.then(clear, clear);
    return pending;
  }
  async function pump() {
    if (pumping || closed || retry) return;
    pumping = true;
    try {
      while (!closed && cursor < newest) {
        const response = await fetch(`${job.messagesUrl ?? `/api/jobs/${job.id}/messages`}/${cursor + 1}`, { cache: 'no-store' });
        if (!response.ok) throw await requestError(response, 'Result transfer failed');
        const bytes = await response.arrayBuffer();
        if (closed) return;
        let data;
        try { data = decoder.decode(bytes); }
        catch (error) { fatal(new Error(`Invalid simulation result: ${error.message}`)); return; }
        cursor++; data.requestId = requestId; connection(true);
        handle.onmessage?.({ data });
        if (data.type === 'error' || (data.type === 'status' && terminal.has(data.mode))) { handle.detach(); return; }
      }
    } catch (error) {
      if (!closed && permanent(error)) fatal(error);
      else if (!closed) {
        connection(false);
        retry = setTimeout(() => { retry = null; void pump(); }, 1500);
      }
    } finally { pumping = false; }
  }
  async function checkStream(source) {
    if (probing || closed || source !== stream) return;
    probing = true;
    try {
      const current = await json(`/api/jobs/${job.id}`);
      if (closed || source !== stream) return;
      if (current.status === 'failed' && (current.seq ?? 0) <= cursor) {
        fatal(new Error(current.error || 'The server job failed before a result could be stored.')); return;
      }
      newest = Math.max(newest, current.seq ?? 0); void pump();
    } catch (error) { if (permanent(error)) fatal(error); }
    finally {
      probing = false;
      if (!closed && source === stream && source.readyState === 2) reconnect = setTimeout(openStream, 1500);
    }
  }
  function openStream() {
    if (closed) return;
    stream?.close();
    const source = stream = new EventSource(`${job.eventsUrl ?? `/api/jobs/${job.id}/events`}?after=${cursor}`);
    source.addEventListener('open', () => source === stream && connection(true));
    source.addEventListener('error', () => {
      if (closed || source !== stream) return;
      connection(false); void checkStream(source);
    });
    source.addEventListener('server-error', event => {
      if (closed || source !== stream) return;
      let message;
      try { message = JSON.parse(event.data).message; } catch {}
      fatal(new Error(message || 'The compute server could not store the result.'));
    });
    source.addEventListener('notice', event => {
      if (closed || source !== stream) return;
      try {
        const notice = JSON.parse(event.data);
        if (!Number.isSafeInteger(notice.seq) || notice.seq < 1) throw new Error('Invalid simulation event sequence');
        newest = Math.max(newest, notice.seq); void pump();
      } catch (error) { fatal(error); }
    });
  }
  async function begin(message) {
    job = resumeId ? await json(`/api/jobs/${encodeURIComponent(resumeId)}`)
      : await json('/api/jobs', mode === 'sweep' ? { mode, jobs } : { input: message.input, single: !!message.single });
    // Retain the ID until an explicit cancellation is acknowledged, including
    // when creation finishes after the page has detached or requested cancel.
    remember(job.id);
    if (closed) return;
    openStream();
    newest = Math.max(newest, job.seq ?? 0); void pump();
  }
  return handle;
}

export function startServerSweep(config, jobs, onProgress, { resumeId } = {}) {
  const resultsById = new Map(), worker = createServerRunWorker(config, { mode: 'sweep', jobs, resumeId });
  let resolve, reject, settled = false, cancelling = false;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const results = () => [...resultsById].sort(([a], [b]) => a - b).map(([, run]) => run);
  const fail = message => { if (settled) return; settled = true; worker.detach(); reject(new Error(message)); };
  worker.onmessage = ({ data }) => {
    if (settled) return;
    if (data.type === 'error') { fail(data.message); return; }
    if (data.type === 'command-error' && data.command === 'cancel') cancelling = false;
    if (data.type === 'sweep-result') {
      if (!Number.isInteger(data.id) || data.id < 0 || data.id >= jobs.length || resultsById.has(data.id)) {
        fail('Invalid or duplicated sweep result'); return;
      }
      resultsById.set(data.id, data.result);
    }
    if (['sweep-result', 'sweep-progress', 'connection', 'command-error'].includes(data.type))
      onProgress({ completed: resultsById.size, total: jobs.length, results: results(), progress: data });
    if (data.type === 'status' && terminal.has(data.mode)) {
      if (data.mode === 'failed') { fail(data.message || 'Server sweep failed'); return; }
      if (data.mode === 'done' && resultsById.size !== jobs.length) { fail('The completed sweep is missing results'); return; }
      settled = true; resolve({ results: results(), cancelled: data.mode !== 'done' }); worker.detach();
    }
  };
  worker.onerror = event => fail(event.message);
  worker.postMessage({ type: 'start', requestId: 0 });
  return { promise, detach: () => worker.detach(), cancel() {
    if (settled || cancelling) return;
    cancelling = true;
    // Drain already completed records before resolving the cancelled prefix.
    worker.postMessage({ type: 'cancel' });
  } };
}
