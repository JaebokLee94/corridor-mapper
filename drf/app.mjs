import { DEFAULT_INPUT, LAYERED_DOMAIN, normalizeInput, createSceneGeometry } from './scenario.mjs?v=20261103-defaults1';
import { percentile } from './statistics.mjs';
import { psptSnapshotCsv } from './pspt-evaluate.mjs?v=20261103-defaults1';
import { METHOD_PROTOCOL } from './comparison.mjs?v=20261104-pspt-repair1';
import { LEGACY_RUN_PROTOCOL } from './legacy-run-protocol.mjs';
import { startSweep, parseValues, sweepJobs, aggregateRuns } from './sweep.mjs?v=20261103-defaults1';
import { DrfMap, linkMapCameras, drawComparisonHistory, drawSweep, drawHistogram, drawProfile, drawCounts } from './render.mjs?v=20261104-labels1';
import { download, png300dpi } from '../surf/exports.mjs';
import { connectComputeServer, createServerRunWorker, startServerSweep } from './server-client.mjs';

const $ = id => document.getElementById(id), form = $('settings');
const state = { mode: 'idle', protocol: null, scenario: null, grid: null, frames: [], evaluations: [], selected: 0, next: 0, generatedSnapshots: 0, measurementTotal: 0,
  busy: false, replay: false, replayAt: 0, generation: 0, workers: [], sweep: null, sweepRuns: [], valid: false, followLive: true, method: 'compare' };
let runWorker, evalWorker, hoverWorker, hoverTimer, hoverGeneration = 0, replayFrame = 0, reference = [], provenance = {};
function renderThresholdProtocol(protocol = METHOD_PROTOCOL) {
  const { guarded, baseline } = protocol;
  $('thresholdSummary').textContent = `Tuning ${guarded.tuning.scenes} · PSPT ${guarded.threshold.toFixed(4)} · B ${baseline.threshold.toFixed(4)}`;
  const refinement = guarded.refinement === 'shared-pose'
    ? 'Candidate refinement accounts for shared vehicle position error.'
    : guarded.refinement === 'independent-pairs' ? 'Candidate refinement treats pair errors independently.' : 'Candidate refinement is not specified in this run metadata.';
  const clustering = guarded.clustering === 'bounded-span'
    ? 'Each echo cluster is limited to the existing distance gate.'
    : guarded.clustering === 'single-link' ? 'Echo clusters use single-link distance grouping.' : 'Echo clustering is not specified in this run metadata.';
  $('thresholdDetails').textContent = `Fixed tuning log-score thresholds: PSPT ${guarded.threshold}; B ${baseline.threshold}. ${refinement} ${clustering} ${guarded.thresholdStatus ?? 'These development thresholds are not certified.'}`;
}
renderThresholdProtocol();
const fmt = (v, places = 3) => typeof v !== 'number' ? '—' : Number.isFinite(v) ? v.toFixed(places) : v === Infinity ? 'Failed (∞)' : v === -Infinity ? 'Failed (−∞)' : 'Failed (NaN)';
// Keep the full message in the tooltip when the single status line is truncated.
const notice = text => { $('status').textContent = text; $('status').title = text; };
function installSidebarControls() {
  const sidebar = $('experimentSidebar'), workspace = $('workspace'), toggle = $('sidebarToggle'),
    controls = $('sidebarControls'), quickRun = $('sidebarRunButton'), run = $('runButton'),
    pause = $('pauseButton'), progressTrack = $('runProgressTrack');
  function setExpanded(expanded) {
    const focusWasInside = sidebar.contains(document.activeElement);
    const focusWasInControls = controls.contains(document.activeElement);
    // Dock in the visible heading before hiding the panel; no empty control column.
    (expanded ? $('experimentTitle') : $('workbenchTitle')).prepend(controls);
    // Reuse the live progress elements so both stages retain their current values.
    (expanded ? $('runSection') : controls).append(progressTrack);
    sidebar.hidden = !expanded;
    workspace.dataset.sidebar = expanded ? 'expanded' : 'collapsed';
    toggle.setAttribute('aria-expanded', String(expanded));
    const label = `${expanded ? 'Hide' : 'Show'} experiment controls`;
    toggle.setAttribute('aria-label', label); toggle.title = label;
    quickRun.hidden = expanded;
    if (focusWasInControls || (!expanded && focusWasInside)) toggle.focus();
    // Resize existing plots without resetting cameras, settings or computation.
    window.dispatchEvent(new Event('resize'));
  }
  const currentAction = () => ['running', 'paused'].includes(document.body.dataset.state) ? pause : run;
  const syncRun = () => {
    const action = currentAction(), label = action === pause ? pause.textContent : 'Run';
    quickRun.disabled = action.disabled;
    $('sidebarRunLabel').textContent = label;
    $('sidebarRunIcon').setAttribute('d', label === 'Pause' ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'm8 5 11 7-11 7z');
    quickRun.setAttribute('aria-label', `${label} comparison`);
    quickRun.title = `${label} comparison`;
  };
  toggle.addEventListener('click', () => setExpanded(sidebar.hidden));
  quickRun.addEventListener('click', () => {
    const action = currentAction();
    if (action.disabled) return;
    if (action === run && !form.checkValidity()) { form.reportValidity(); return; }
    action.click();
    syncRun();
  });
  const observer = new MutationObserver(syncRun);
  observer.observe(run, { attributes: true, attributeFilter: ['disabled'] });
  observer.observe(pause, { attributes: true, attributeFilter: ['disabled'], childList: true, characterData: true, subtree: true });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
  syncRun();
  form.addEventListener('invalid', event => {
    for (let node = event.target.parentElement; node && node !== sidebar; node = node.parentElement)
      if (node.tagName === 'DETAILS') node.open = true;
    setExpanded(true);
  }, true);
}
function fillSettings(input) {
  for (const [key, value] of Object.entries(input)) {
    const field = form.elements.namedItem(key);
    if (field) field.type === 'checkbox' ? field.checked = value : field.value = String(value);
  }
}
function settings() {
  if (Number(form.elements.namedItem('sigmaD').value) === 0) throw new Error('Both methods require range SD σd > 0. Zero range noise can make the joint pose update singular.');
  if (!form.reportValidity()) throw new Error('Check the input values and their allowed ranges.');
  const values = Object.fromEntries(new FormData(form)); values.specular = form.elements.namedItem('specular').checked;
  return normalizeInput(values);
}
function createWorker(name, options = {}) {
  if (name === 'run' && state.server) return createServerRunWorker(state.server, options);
  return globalThis.__drfOffline?.worker(name) ?? new Worker(new URL(`./${name}.worker.mjs?v=20261103-background2`, import.meta.url), { type: 'module' });
}
function makeWorker(name, onProgress = () => {}) {
  const worker = createWorker(name), pending = new Map(); let id = 0, stopped = false;
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') { onProgress(data); return; }
    const request = pending.get(data.requestId); if (!request) return;
    pending.delete(data.requestId);
    data.type === 'error' ? request.reject(new Error(data.message ?? data.error)) : request.resolve(data);
  };
  worker.onerror = event => { for (const p of pending.values()) p.reject(new Error(event.message)); pending.clear(); };
  const handle = { request(message) { return new Promise((resolve, reject) => {
    if (stopped) { reject(new Error('Cancelled')); return; }
    const requestId = ++id; pending.set(requestId, { resolve, reject }); worker.postMessage({ ...message, requestId });
  }); }, stop() { stopped = true; worker.terminate(); for (const p of pending.values()) p.reject(new Error('Cancelled')); pending.clear(); } };
  state.workers.push(handle); return handle;
}
function stopReplay() {
  cancelAnimationFrame(replayFrame); replayFrame = 0; state.replay = false;
  for (const id of ['replayButton', 'completedReplayButton']) if ($(id)) $(id).textContent = 'Replay';
}
function controls() {
  const active = ['running', 'paused'].includes(state.mode), sweeping = !!state.sweep, preparing = active && !state.scenario;
  const completed = state.mode === 'done' && state.valid && state.frames.length > 0;
  $('runButton').disabled = active || sweeping || !!state.connecting; $('pauseButton').disabled = !active || preparing || !!state.pendingCommand;
  $('pauseButton').textContent = state.mode === 'paused' ? 'Resume' : 'Pause';
  $('stepButton').disabled = preparing || state.busy || state.mode === 'running' || sweeping || !!state.connecting;
  $('cancelButton').disabled = !active;
  const completedReplay = $('completedReplayButton');
  if (completedReplay) {
    completedReplay.hidden = !completed;
    completedReplay.disabled = !completed || !!state.connecting;
    completedReplay.textContent = state.replay ? 'Stop' : 'Replay';
    $('runButton').textContent = completed ? 'Reset & run' : 'Run comparison';
    $('runButton').title = completed ? 'Clear previous results and run with the current settings' : 'Run comparison';
    $('runActions').dataset.mode = completed ? 'complete' : active ? 'active' : 'idle';
  }
  const runActions = ['runButton', 'pauseButton', 'stepButton', 'cancelButton', 'completedReplayButton'].map($).filter(Boolean);
  const focusedAction = runActions.find(button => button === document.activeElement);
  for (const button of runActions) button.hidden = button === completedReplay ? !completed : button === $('runButton') ? active : !active;
  if (focusedAction?.hidden) runActions.find(button => !button.hidden && !button.disabled)?.focus();
  for (const el of form.elements) el.disabled = active || sweeping;
  for (const el of $('sweepSettings').elements) el.disabled = active || sweeping;
  $('sweepButton').disabled = active || sweeping || !!state.connecting; $('sweepCancel').disabled = !sweeping;
  $('timeSlider').max = Math.max(1, state.frames.length); $('timeSlider').value = state.selected; $('timeSlider').disabled = active || !state.frames.length;
  $('replayButton').disabled = active || !state.frames.length;
  updateRunProgress();
  $('firstSnapshot').disabled = false;
  $('exportJson').disabled = (!state.valid || !state.frames.length) && !state.sweepRuns.length;
  for (const id of ['exportCsv', 'exportPng']) $(id).disabled = !state.valid || !state.frames.length;
  document.body.dataset.state = state.mode;
  $('runState').textContent = ({idle:'Ready',running:'Computing',paused:'Paused',cancelled:'Partial run',done:'Complete'})[state.mode] ?? 'Stopped';
  if (state.server) $('runState').textContent += ' · Server';
  $('newSeed').disabled = active || sweeping;
}
function updateRunProgress() {
  const total = state.measurementTotal || state.scenario?.input.snapshots || state.pendingInput?.snapshots || Number(form.elements.namedItem('snapshots').value || DEFAULT_INPUT.snapshots);
  $('generationProgress').max = total; $('generationProgress').value = state.generatedSnapshots ?? 0;
  $('runProgress').max = total; $('runProgress').value = state.frames.length;
}
function cancel(clear = false) {
  state.generation++; hoverGeneration++; clearTimeout(hoverTimer); stopReplay();
  const generation = state.generation;
  for (const worker of state.workers) {
    const stopped = worker.stop();
    stopped?.catch?.(error => {
      if (state.generation === generation) notice(`Server cancellation was not confirmed: ${error.message}. Reload to reconnect to the job.`);
    });
  }
  state.workers = []; state.pendingCommand = null;
  runWorker = null; evalWorker = null; hoverWorker = null;
  state.busy = false; state.mode = clear ? 'idle' : 'cancelled';
  if (clear) {
    state.pendingInput = null; state.protocol = null; state.scenario = null; state.grid = null; state.frames = []; state.evaluations = []; state.selected = 0; state.next = 0; state.valid = false;
    state.generatedSnapshots = 0; state.measurementTotal = 0;
    renderThresholdProtocol();
    state.followLive = true;
    $('mapCanvas').removeAttribute('data-field-hash');
    for (const view of [map,baselineMap,densityMap,contrastMap]) view.fit();
  } else if (state.frames.length && state.scenario) {
    // Preserve inspection of completed prefixes after cancellation; no future wire is supplied.
    hoverWorker = makeWorker('field'); evalWorker = makeWorker('eval');
    evalWorker.request({ type: 'init', scenario: state.scenario, grid: state.grid }).catch(error => { if (error.message !== 'Cancelled') notice(error.message); });
  }
  controls(); renderSelected();
}
async function requestedServerJob(mode) {
  if (!state.server) return null;
  const config = await connectComputeServer(); state.server = config;
  const job = config.job;
  if (!job || ['done', 'cancelled', 'failed'].includes(job.status)) return null;
  if (job.mode !== mode) throw new Error(job.mode === 'sweep'
    ? 'A server sweep is already active. Open Analysis tools and press Run sweep to reconnect.'
    : 'A server comparison is already active. Press Run comparison to reconnect.');
  return job;
}
async function prepare(single = false, resumeId) {
  if (state.connecting) return;
  if (state.server && !resumeId) {
    state.connecting = true; controls();
    try {
      const job = await requestedServerJob('comparison');
      if (job) { resumeId = job.id; fillSettings(job.input); }
    } catch (error) { notice(error.message); return; }
    finally { state.connecting = false; controls(); }
  }
  try {
    const input = settings();
    cancel(true); state.pendingInput=input; state.mode = 'running'; state.busy = true;
    const generation = state.generation; controls();
    location.hash = `v1=${encodeURIComponent(JSON.stringify(input))}`;
    notice('Generating wall geometry and measurements.');
    const worker = createWorker('run', { resumeId }); runWorker = worker;
    state.workers.push({ stop: () => worker.terminate(), detach: worker.detach ? () => worker.detach() : null });
    worker.onmessage = ({ data }) => { void receiveRunMessage(data, generation); };
    worker.onerror = event => { if (generation === state.generation) fail(new Error(event.message || 'Could not load the simulation worker. Reload and run again.')); };
    worker.postMessage({ type: 'start', requestId: generation, input, single });
  } catch (error) { fail(error); }
}
function fail(error) {
  if (error.message === 'Cancelled') return;
  cancel(false); state.valid = false; controls(); notice(`Run stopped: ${error.message}`);
}
// The worker owns the entire run. These notifications never request or acknowledge
// the next snapshot, so delaying the page cannot leave the calculation waiting.
async function receiveRunMessage(data, generation) {
  if (generation !== state.generation || data.requestId !== generation) return;
  try {
    if (data.type === 'error') throw new Error(data.message);
    if (data.type === 'command-error') {
      const previous = state.pendingCommand;
      if (['running', 'paused'].includes(data.job?.status)) {
        state.mode = data.job.status; state.busy = data.job.status === 'running';
      } else if (previous) {
        state.mode = previous.mode; state.busy = previous.busy;
      }
      state.pendingCommand = null; controls();
      notice(`Server command was not confirmed: ${data.message}.${data.recoveryError ? ' Server status is unavailable; reload to reconnect.' : ' Computation has not been cancelled.'}`); return;
    }
    if (data.type === 'connection') {
      if (!data.connected) notice('Reconnecting to the server. The server job continues independently.');
      return;
    }
    if (data.type === 'progress') {
      state.measurementTotal = data.total; state.generatedSnapshots = Math.max(state.generatedSnapshots ?? 0, data.t);
      updateRunProgress(); notice(`Generating measurements ${data.t} / ${data.total}`); return;
    }
    if (data.type === 'prepared') {
      state.protocol = structuredClone(data.protocol ?? LEGACY_RUN_PROTOCOL);
      renderThresholdProtocol(state.protocol);
      state.scenario = data.scenario; state.grid = data.grid; state.valid = true;
      state.measurementTotal = data.scenario.input.snapshots; state.generatedSnapshots = state.measurementTotal;
      if (state.server) { fillSettings(data.scenario.input); location.hash = `v1=${encodeURIComponent(JSON.stringify(data.scenario.input))}`; }
      // Inspection is separate from the run and cannot hold up its progress.
      hoverWorker = makeWorker('field'); evalWorker = makeWorker('eval');
      void evalWorker.request({ type: 'init', scenario: data.scenario, grid: data.grid }).catch(error => {
        if (generation === state.generation && error.message !== 'Cancelled') notice(error.message);
      });
      controls(); return;
    }
    if (data.type === 'frame') {
      if (data.next !== state.next + 1) throw new Error('Out-of-order simulation result');
      state.frames.push(data.frame); state.evaluations.push(data.evaluation); state.next = data.next;
      if (state.followLive || !state.selected) state.selected = state.frames.length;
      renderSelected(); controls();
      notice(`Comparing methods ${data.frame.t} / ${state.scenario.input.snapshots}`);
      return;
    }
    if (data.type === 'status') {
      state.pendingCommand = null;
      state.mode = data.mode; state.busy = data.mode === 'running'; controls();
      if (data.mode === 'paused') notice('Paused after the current snapshot.');
      if (data.mode === 'done') {
        const hash = await hashField(state.frames.at(-1));
        if (generation !== state.generation) return;
        $('mapCanvas').dataset.fieldHash = hash;
        notice(`Complete · ${state.frames.length} snapshots`);
        renderSelected();
      }
    }
  } catch (error) { if (generation === state.generation) fail(error); }
}
function commandRun(type) {
  if (!runWorker || !state.scenario || !['running', 'paused'].includes(state.mode) || state.pendingCommand) return;
  if (type === 'step' && (state.mode !== 'paused' || state.busy)) return;
  if (state.server) state.pendingCommand = { type, mode: state.mode, busy: state.busy };
  if (type === 'resume') { state.mode = 'running'; state.followLive = true; }
  if (type === 'pause') state.mode = 'paused';
  if (type === 'step') state.followLive = true;
  state.busy = true; controls();
  runWorker.postMessage({ type, requestId: state.generation });
  notice(type === 'pause' ? 'Pausing after the current snapshot.' : 'Computing the next snapshot.');
}
async function hashField(frame) {
  const bytes = new Uint8Array(frame.Dbar.byteLength + frame.betaHat.byteLength);
  bytes.set(new Uint8Array(frame.Dbar.buffer)); bytes.set(new Uint8Array(frame.betaHat.buffer), frame.Dbar.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
const inspect = point => {
  clearTimeout(hoverTimer); const generation = ++hoverGeneration;
  const frame = state.frames[state.selected - 1];
  if (!frame || point.index < 0 || !hoverWorker) { $('inspector').textContent = ''; return; }
  const grid = state.grid, ix = point.index % grid.nx, iy = Math.floor(point.index / grid.nx), x = grid.x[ix], y = grid.y[iy];
  hoverTimer = setTimeout(async () => {
    if (generation !== hoverGeneration || !hoverWorker) return;
    try {
      const value = await hoverWorker.request({ type: 'prefixInspect', grid, numerical: { band: state.scenario.input.band, perimeter: state.scenario.input.perimeter },
        snapshots: state.scenario.wire.slice(0, frame.t), index: point.index, epsilonA: frame.epsilonA });
      if (generation !== hoverGeneration) return;
      let wallDistance = '';
      if ($('showTruth').checked) {
        let distance = Infinity;
        for (const wall of state.scenario.walls) for (const p of wall) distance = Math.min(distance, Math.hypot(x - p[0], y - p[1]));
        wallDistance = ` · Wall-sample distance ${fmt(distance)} m · evaluation only`;
      }
      $('inspector').textContent = `snapshot ${value.t} · grid (${fmt(x, 2)}, ${fmt(y, 2)}) m · D ${fmt(value.D)} · A ${fmt(value.A)} [1/m²] · Q ${value.Q} · D̄ ${fmt(value.Dbar)} · β̂ ${fmt(value.betaHat)}${wallDistance}`;
    } catch (error) { if (error.message !== 'Cancelled') $('inspector').textContent = `Inspection stopped: ${error.message}`; }
  }, 100);
};
const map = new DrfMap($('mapCanvas'),inspect),baselineMap=new DrfMap($('baselineCanvas'),inspect),densityMap=new DrfMap($('densityCanvas'),inspect),contrastMap=new DrfMap($('contrastCanvas'),inspect);
linkMapCameras(map,baselineMap,()=>state.method==='compare');
let previewKey='',preview=[],previewBounds;
function previewWalls() {
  // Static truth preview uses exactly the accepted geometry used by the worker.
  try {
    const input = state.pendingInput ?? normalizeInput(Object.fromEntries(new FormData(form))),
      key = JSON.stringify([input.scene, input.wallSide, input.seed, input.sigmaM, input.deltaM, input.sigmaDGeometry, input.deltaD]);
    if (key !== previewKey) { const geometry=createSceneGeometry(input);preview=geometry.walls;previewBounds=geometry.cameraBounds;previewKey=key; }
    return preview;
  } catch (error) { notice(error.message); return []; }
}
function renderSelected() {
  // Keep every result, but defer hidden-tab chart work until visibility returns.
  if (document.hidden) return;
  hoverGeneration++;
  $('inspector').textContent = '';
  const frame = state.frames[state.selected - 1], evaluation = state.evaluations[state.selected - 1], scenario = state.scenario;
  const layers = Object.fromEntries(['showEllipses', 'showVehicles', 'showProxy', 'showTruth', 'showSpecular', 'showDiffuse'].map(id => [id, $(id).checked]));
  const display={ grid: state.grid, domain: state.scenario?.domain ?? LAYERED_DOMAIN, frame, truth: scenario?.truth[state.selected - 1], wire: scenario?.wire[state.selected - 1], walls: scenario?.walls ?? previewWalls(),cameraBounds:scenario?.cameraBounds ?? previewBounds,
    candidates: frame?.methods?.[state.method]?.candidates ?? frame?.candidates ?? [], observed: evaluation?.observed, layers, heatField: $('heatField').value, scaleMode: $('scaleMode').value,
    history: scenario?.wire.slice(0, state.selected),aspectMode:$('aspectMode').value };
  $('mapPair').dataset.mode=state.method;
  $('baselinePane').hidden=state.method!=='compare';
  $('primaryMapName').textContent=state.method==='baseline'?'Fixed-fragment B':'Guarded PSPT';
  map.set({...display,mode:'geometry',xRange:[-10,90]});
  baselineMap.set({...display,candidates:frame?.methods?.baseline?.candidates ?? [],mode:'geometry',xRange:[-10,90]});
  const fieldLayers={showTruth:layers.showTruth,showVehicles:layers.showVehicles};
  densityMap.set({...display,layers:fieldLayers,heatField:'Dbar'});
  contrastMap.set({...display,layers:fieldLayers,heatField:'betaHat'});
  $('snapshotLabel').textContent = `${frame?.t ?? 0} / ${scenario?.input.snapshots ?? form.elements.namedItem('snapshots').value}`;
  $('evaluationNote').textContent = '0.4 m tolerance · same measured prefix';
  for (const [method,prefix] of [['guarded',''],['baseline','b']]) {
    const e=evaluation?.methods?.[method] ?? (method==='guarded' ? evaluation : null);
    const node=(name)=>$(prefix ? prefix+name[0].toUpperCase()+name.slice(1) : name);
    for (const [id,key] of [['precisionValue','precision'],['recallValue','recall'],['firstPrecisionValue','firstSupportPrecision'],['offwallValue','offwall']])
      node(id).textContent=e?.[key]==null ? '—' : fmt(100*e[key],1);
    for (const [id,key] of [['p95Value','p95'],['f1Value','f1']]) node(id).textContent=fmt(e?.[key]);
    const candidates=frame?.methods?.[method]?.candidates ?? [];
    for (const [id,status] of [['supportedValue','supported'],['pendingValue','pending'],['contradictedValue','contradicted']])
      node(id).textContent=method==='baseline' && status==='contradicted' ? '—' : candidates.filter(c=>c.status===status).length;
    node('firstPrecisionValue').title=e ? `First-support errors: ${e.firstSupportErrors} / ${e.firstSupportCount}` : '';
  }
  for (const button of document.querySelectorAll('[data-method]')) button.setAttribute('aria-pressed',String(button.dataset.method===state.method));
  if ($('methodNote')) $('methodNote').textContent=state.method==='compare' ? 'Shared snapshot and axes · zoom and pan are linked. B retains past threshold crossings.' : state.method==='guarded'
    ? 'PSPT updates curved patches and holds geometrically ambiguous alternatives.'
    : 'B retains fixed fragments that crossed its threshold in a past qualified snapshot; unselected fragments are held.';
  $('qValue').textContent = frame?.Q ?? 0; $('acceptedValue').textContent = frame?.admitted ?? 0; $('rejectedValue').textContent = frame?.rejected ?? 0;
  const diag = evaluation?.diagnostics;
  $('pathValue').textContent = diag ? `Specular ${diag.specularCount} / diffuse ${diag.diffuseCount}` : '—';
  const times = state.frames.slice(0,state.selected).map(f=>f.ms+(f.methods?.guarded.ms ?? 0)+(f.methods?.baseline.ms ?? 0));
  $('timingValue').textContent = times.length ? `p50 ${fmt(percentile(times,.5),1)} / p95 ${fmt(percentile(times,.95),1)} ms` : '—';
  $('timingValue').title='Display field + both estimators, per snapshot; excludes generation, evaluation and rendering.';
  drawComparisonHistory($('metricChart'),state.evaluations.slice(0,state.selected),$('historyMetric').value,scenario?.input.snapshots ?? Number(form.elements.namedItem('snapshots').value));
  if (diag) {
    $('diagnosticSummary').textContent = `diffuse / configuration ${fmt(diag.diffusePerConfig, 1)} · duplicate ranges ${diag.duplicateFraction == null ? '—' : fmt(100 * diag.duplicateFraction, 1) + '%'} · Theorem 2: mean ${fmt(diag.theoremMean)}, median ${fmt(diag.theoremMedian)}, n=${diag.ratios.length}, negative=${diag.theoremNegative} · fold prediction ${fmt(diag.foldPrediction)} m`;
    if (!$('diagnosticPanel').hidden) {
      drawHistogram($('diagnosticChart'), diag.ratios); drawCounts($('countChart'), diag.diffuseCounts, diag.predictedCounts); updateProfile();
    }
  }
  if (!diag) {
    $('diagnosticSummary').textContent = 'No results yet.';
    drawHistogram($('diagnosticChart'), []); drawProfile($('profileChart'), [],display.domain); drawCounts($('countChart'), [], []);
  }
  const selectedConfig = $('configSelect').value;
  $('configSelect').replaceChildren(...(scenario?.truth[state.selected - 1]?.configs ?? []).map((c, k) => {
    const option = document.createElement('option'); option.value = k; option.textContent = `snapshot ${frame.t} · vehicles ${c.i}–${c.j}`; return option;
  }));
  $('configSelect').value = selectedConfig || '0';
  if (!$('configSelect').value && $('configSelect').options.length) $('configSelect').value = '0';
}
async function updateProfile() {
  if (!state.selected || !evalWorker) return;
  const selected = state.selected, generation = state.generation, configIndex = Number($('configSelect').value || 0);
  try {
    const { profile } = await evalWorker.request({ type: 'profile', t: state.frames[selected - 1].t, configIndex });
    if (generation === state.generation && selected === state.selected && configIndex === Number($('configSelect').value || 0)) drawProfile($('profileChart'), profile.cells,state.scenario.domain);
  } catch (error) { if (error.message !== 'Cancelled') $('diagnosticSummary').textContent = error.message; }
}
function replayTick(time) {
  if (!state.replay) return;
  if (['running', 'paused'].includes(state.mode)) { stopReplay(); return; }
  const interval = 250 / Number($('playbackSpeed').value);
  if (state.replayAt === null) state.replayAt = time;
  if (time - state.replayAt >= interval) {
    state.replayAt = time; state.selected = state.selected >= state.frames.length ? 1 : state.selected + 1;
    $('timeSlider').value = state.selected; renderSelected();
  }
  replayFrame = requestAnimationFrame(replayTick);
}
function toggleReplay() {
  if (['running', 'paused'].includes(state.mode) || !state.frames.length) return;
  if (state.replay) stopReplay(); else {
    state.followLive = false; state.replay = true; state.replayAt = 0;
    for (const id of ['replayButton', 'completedReplayButton']) if ($(id)) $(id).textContent = 'Stop';
    replayFrame = requestAnimationFrame(replayTick);
  }
}
function replayFromStart() {
  if (state.mode !== 'done' || !state.valid || !state.frames.length || state.connecting) return;
  if (state.replay) { stopReplay(); return; }
  // Replay uses saved frames only. Hold the first snapshot for a full interval.
  state.selected = 1; $('timeSlider').value = 1;
  toggleReplay(); state.replayAt = null; renderSelected();
}
function resetView() {
  for (const view of [map,baselineMap,densityMap,contrastMap]) view.fit();
}
$('runButton').onclick = () => prepare();
$('pauseButton').onclick = () => commandRun(state.mode === 'paused' ? 'resume' : 'pause');
$('stepButton').onclick = () => { state.mode === 'paused' ? commandRun('step') : prepare(true); };
$('firstSnapshot').onclick = resetView;
$('cancelButton').onclick = () => { cancel(); notice('Cancelled. Completed snapshots remain available.'); };
$('resetButton').onclick = () => { state.sweep?.cancel(); state.sweepRuns = []; cancel(true); fillSettings(DEFAULT_INPUT); renderSelected(); location.hash = ''; renderSweep(); $('sweepStatus').textContent = 'No results yet.'; notice('Restored default settings.'); };
form.addEventListener('change', () => { state.sweepRuns = []; cancel(true); renderSweep(); $('sweepStatus').textContent = 'No results yet.'; notice('Parameters changed. Run again to compare methods.'); try { location.hash = `v1=${encodeURIComponent(JSON.stringify(settings()))}`; } catch (e) { notice(e.message); } });
$('timeSlider').oninput = () => {
  if (['running', 'paused'].includes(state.mode)) { $('timeSlider').value = state.selected; return; }
  stopReplay(); state.followLive = false; state.selected = Number($('timeSlider').value); hoverGeneration++; renderSelected();
};
$('replayButton').onclick = toggleReplay;
if ($('completedReplayButton')) $('completedReplayButton').onclick = replayFromStart;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { controls(); renderSelected(); renderSweep(); }
});
document.addEventListener('keydown', event => {
  if (event.target.matches('input,select,textarea,button') || $('aboutDialog').open || $('shareDialog').open || $('analysisDialog').open) return;
  if (['running', 'paused'].includes(state.mode)) return;
  if (event.code === 'Space') { event.preventDefault(); toggleReplay(); }
  if (['ArrowLeft', 'ArrowRight'].includes(event.key) && state.frames.length) {
    event.preventDefault(); stopReplay(); state.followLive = false; state.selected = Math.max(1, Math.min(state.frames.length, state.selected + (event.key === 'ArrowRight' ? 1 : -1)));
    $('timeSlider').value = state.selected; renderSelected();
  }
});
for (const id of ['showEllipses', 'showVehicles', 'showProxy', 'showTruth', 'showSpecular', 'showDiffuse', 'heatField', 'scaleMode','historyMetric','aspectMode']) $(id).onchange = renderSelected;
$('fitView').onclick = () => { for (const view of [map,baselineMap,densityMap,contrastMap]) view.fit(true); }; $('zoomIn').onclick = () => map.zoom(1.3); $('zoomOut').onclick = () => map.zoom(1 / 1.3);
for (const [prefix,view] of [['density',densityMap],['contrast',contrastMap]]) {
  $(prefix+'ZoomIn').onclick = () => view.zoom(1.3);
  $(prefix+'ZoomOut').onclick = () => view.zoom(1 / 1.3);
  $(prefix+'ResetView').onclick = () => view.fit();
}
$('configSelect').onchange = updateProfile;
$('aboutButton').onclick = () => $('aboutDialog').showModal(); $('closeAbout').onclick = () => $('aboutDialog').close();
$('themeButton').onclick = () => {
  const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'light' : 'dark'; $('themeButton').setAttribute('aria-label',dark ? 'Switch to dark theme' : 'Switch to light theme'); renderSelected(); renderSweep();
};
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const selected = tab === button; tab.setAttribute('aria-selected', selected); tab.tabIndex=selected ? 0 : -1; $(tab.dataset.tab).hidden = !selected;
  }
  renderSelected(); renderSweep();
};
function renderSweep() {
  if (document.hidden || $('sweepPanel').hidden) return;
  const aggregates = aggregateRuns(state.sweepRuns);
  for (const [method, canvas] of [['guarded', 'sweepChart'], ['baseline', 'sweepBaselineChart']])
    drawSweep($(canvas), aggregates.filter(row => row.method === method), [], 'recall');
  const body = $('sweepTable').querySelector('tbody'); body.replaceChildren();
  const statistic = (metric, total, scale = 1, places = 3) => {
    const counts = `valid ${metric.n}/${total}, failed ${metric.failed}, missing ${metric.missing}`;
    return metric.failed ? `Includes failures (${counts})` : `${fmt(metric.mean == null ? null : scale * metric.mean, places)} ± ${fmt(metric.sd == null ? null : scale * metric.sd, places)} (${counts})`;
  };
  for (const row of aggregates) {
    const tr = document.createElement('tr');
    for (const value of [METHOD_PROTOCOL[row.method].name, row.roughness, row.sigmaD, row.n, statistic(row.precision, row.n, 100, 1), statistic(row.recall, row.n, 100, 1), statistic(row.p95, row.n), statistic(row.offwall, row.n, 100, 1)]) {
      const cell = document.createElement('td'); cell.textContent = value; tr.append(cell);
    }
    body.append(tr);
  }
}
async function runSweep(jobs, resumeId) {
  if (state.connecting) { $('sweepStatus').textContent = 'The compute server is not connected. Reload after restarting the server.'; return; }
  const generation = state.generation; let handle, statusTimer;
  try {
    if (state.server && !resumeId) {
      state.connecting = true; controls();
      const job = await requestedServerJob('sweep');
      if (job) { resumeId = job.id; jobs = job.jobs; fillSettings(jobs[0]); }
      state.connecting = false;
    }
    state.sweepRuns = []; $('sweepButton').disabled = true; $('sweepCancel').disabled = false;
    const status = $('sweepStatus');
    let completedCount = 0;
    status.textContent = `Running sweep · 0 / ${jobs.length} complete`;
    // Parallel experiments emit interleaved snapshot updates. Show only the
    // aggregate completed count, at most once per second; never pace computation.
    statusTimer = setInterval(() => {
      if (generation !== state.generation) { clearInterval(statusTimer); return; }
      const text = `Running sweep · ${completedCount} / ${jobs.length} complete`;
      if (status.textContent !== text) status.textContent = text;
    }, 1000);
    const onProgress = ({ completed, total, results, progress }) => {
      if (generation !== state.generation) return;
      state.sweepRuns = results;
      if (progress?.type === 'command-error') {
        clearInterval(statusTimer);
        status.textContent = `${completed} / ${total} complete · Cancellation was not confirmed: ${progress.message}. The server job may still be running; retry Cancel sweep.`;
        return;
      }
      completedCount = completed;
      if (!progress || progress.type === 'sweep-result') renderSweep();
    };
    handle = state.sweep = state.server ? startServerSweep(state.server, jobs, onProgress, { resumeId }) : startSweep(jobs, onProgress);
    controls();
    const result = await handle.promise;
    if (generation !== state.generation) return;
    state.sweepRuns = result.results;
    status.textContent = `${result.cancelled ? 'Cancelled' : 'Complete'} · ${result.results.length} / ${jobs.length} experiments`;
    renderSweep();
  } catch (error) { if (generation === state.generation) $('sweepStatus').textContent = `Sweep stopped: ${error.message}`; }
  finally { clearInterval(statusTimer); state.connecting = false; if (state.sweep === handle) state.sweep = null; controls(); }
}
$('sweepButton').onclick = () => {
  try {
    const base = settings(), values = Object.fromEntries(new FormData($('sweepSettings')));
    return runSweep(sweepJobs(base, parseValues(values.sweepNoise), parseValues(values.sweepRoughness), parseValues(values.sweepSeeds, true)));
  } catch (error) { $('sweepStatus').textContent = `Sweep stopped: ${error.message}`; }
};
$('sweepCancel').onclick = () => state.sweep?.cancel();
const jsonValue = (_key, value) => ArrayBuffer.isView(value) ? Array.from(value) : typeof value === 'number' && !Number.isFinite(value) ? null : value;
$('exportJson').onclick = () => {
  const data = { schema: 'echomap-drf/5', estimators: state.protocol, selectedMethod: state.method, toleranceM: 0.4, provenance, units: { position: 'm', range: 'm', poseCovariance: 'm²', roughnessInput: 'deg', truthAngles: 'rad', D: '1/m²', A: '1/m²', Dbar: '1/m²', betaHat: 'dimensionless', time: 'snapshot index; physical dt unspecified' },
    grid: state.grid ? { ...state.grid, arrayOrder: 'iy*nx+ix; ascending y; cell centers' } : null,
    input: state.scenario?.input ?? state.sweepRuns[0]?.input, measurement: state.scenario?.wire.slice(0, state.frames.length) ?? [], result: state.frames,
    evaluation: state.evaluations, truth: { role: 'evaluation only', wallModel: state.scenario?.wallModel, wallGeneration: state.scenario?.wallGeneration, walls: state.scenario?.walls ?? [], snapshots: state.scenario?.truth.slice(0, state.frames.length) ?? [] },
    sweep: { completeSeedResults: state.sweepRuns.map(({ final, ...run }) => run), aggregates: aggregateRuns(state.sweepRuns) } };
  download(new Blob([JSON.stringify(data, jsonValue)], { type: 'application/json' }), 'echomap-drf.json');
};
$('exportCsv').onclick = () => {
  const protocol = state.protocol;
  const csvValue = value => /[\",\r\n]/.test(String(value)) ? '"'+String(value).replaceAll('"','""')+'"' : String(value);
  const rows=[];let header;
  for (const method of ['guarded','baseline']) {
    const frames=state.frames.map(f=>({...f,candidates:f.methods[method].candidates,psptMs:f.methods[method].ms}));
    const lines=psptSnapshotCsv(frames,state.evaluations.map(e=>e.methods[method])).replace(/^\ufeff/,'').trim().split('\r\n');
    header=lines[0].replace('pspt_ms','estimator_ms');
    const loaded = protocol[method], revision = loaded.revision ?? 'legacy-unversioned';
    rows.push(...lines.slice(1).map(line=>[method,loaded.threshold,csvValue(loaded.tuning.id),line,csvValue(revision)].join(',')));
  }
  download(new Blob(['\ufeffmethod,selection_threshold,threshold_source,'+header+',implementation_revision\r\n'+rows.join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}),'echomap-method-comparison.csv');
};
$('exportPng').onclick = async () => { try { const field=$('heatField').value;download(await png300dpi(await (field==='betaHat' ? contrastMap : densityMap).png()), `echomap-drf-${field}-300dpi.png`); } catch (error) { notice(`PNG export failed: ${error.message}`); } };
const chartResize = new ResizeObserver(() => { renderSelected(); renderSweep(); });
chartResize.observe($('analysis-panel') ?? $('sweepPanel'));
chartResize.observe($('metricChart'));
window.addEventListener('resize', () => { renderSelected(); renderSweep(); });
window.addEventListener('beforeunload', () => {
  for (const worker of state.workers) worker.detach ? worker.detach() : worker.stop();
  if (state.sweep?.detach) state.sweep.detach(); else state.sweep?.cancel();
});
let initialInput = DEFAULT_INPUT;
try {
  const hasSharedInput=location.hash.startsWith('#v1='),raw=hasSharedInput ? JSON.parse(decodeURIComponent(location.hash.slice(4))) : DEFAULT_INPUT;
  initialInput=normalizeInput({...raw,scene:'layered'});
  // A shared seed is a reproducibility contract. Randomise only an unseeded visit.
  if (!hasSharedInput) initialInput={...initialInput,seed:crypto.getRandomValues(new Uint32Array(1))[0]};
} catch (error) { notice(`Could not restore URL settings: ${error.message}`); }
fillSettings(initialInput);
history.replaceState(null, '', `#v1=${encodeURIComponent(JSON.stringify(initialInput))}`);
if (matchMedia('(max-width: 760px)').matches) $('settingsDetails').open=false;
(globalThis.__drfOffline ? Promise.resolve(globalThis.__drfOffline.metadata) : Promise.all([fetch(new URL('./provenance.json', import.meta.url)).then(r => r.json()), fetch(new URL('./reference/octave/fixtures.json', import.meta.url)).then(r => r.json())]))
  .then(([p, f]) => { provenance = p; reference = f.statistics; $('provenanceCommit').textContent = `${p.baseCommit.slice(0, 8)}`;
    $('provenanceCore').textContent = `${p.coreHash.slice(0, 12)}`; renderSweep(); })
  .catch(error => notice(`Could not load validation metadata: ${error.message}`));
controls(); renderSelected();
if (document.querySelector('meta[name="echomap-compute"]')?.content === 'server') {
  state.connecting = true; controls(); notice('Connecting to the compute server.');
  connectComputeServer().then(config => {
    state.server = config; state.connecting = false; controls();
    const active = config.job && !['done', 'cancelled', 'failed'].includes(config.job.status);
    notice(active ? `Press ${config.job.mode === 'sweep' ? 'Run sweep' : 'Run comparison'} to reconnect.`
      : 'Press Run comparison to start.');
  }).catch(error => {
    state.connecting = true; controls(); notice(`Compute server unavailable: ${error.message}. Reload after restarting the server.`);
  });
}

// Switching the displayed method never recomputes or mutates either estimator.
for (const button of document.querySelectorAll('[data-method]')) button.onclick=()=>{state.method=button.dataset.method;map.fit();baselineMap.fit();renderSelected();};
$('newSeed').onclick=()=>{
  const seedField=form.elements.namedItem('seed'),old=Number(seedField.value);
  let seed=crypto.getRandomValues(new Uint32Array(1))[0];if(seed===old) seed=(seed+1)>>>0;
  seedField.value=seed;form.dispatchEvent(new Event('change'));
};
$('shareButton').onclick=async()=>{
  try {
    const input=state.scenario?.input ?? settings();location.hash=`v1=${encodeURIComponent(JSON.stringify(input))}`;
    $('shareLink').value=location.href;$('shareDialog').showModal();
    if(location.protocol==='file:') {$('shareStatus').textContent='This is a local file URL. Share the hosted page or downloaded JSON with collaborators.';return;}
    try {await navigator.clipboard.writeText(location.href);$('shareStatus').textContent='Link copied. The seed and parameters are preserved.';}
    catch {$('shareStatus').textContent='Select and copy the link above.';}
  } catch(error) {notice(error.message);}
};
$('closeShare').onclick=()=>$('shareDialog').close();
for(const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();const tabs=[...document.querySelectorAll('[data-tab]')],i=tabs.indexOf(tab);
  const j=event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  tabs[j].click();tabs[j].focus();
});

$('analysisButton').onclick=()=>{$('analysisDialog').showModal();renderSelected();renderSweep();};
$('closeAnalysis').onclick=()=>$('analysisDialog').close();
installSidebarControls();
