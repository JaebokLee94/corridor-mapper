import { DEFAULT_INPUT, normalizeInput } from './scenario.mjs';
import { METHOD_PROTOCOL } from './comparison.mjs';
import { sweepJobs } from './sweep.mjs';

export const REQUEST_SCHEMA = 'echomap-request/1';
export const RESULT_SCHEMA = 'echomap-remote/1';
export const MAX_RESULT_BYTES = 512 * 1024 * 1024;
const methods = ['guarded', 'baseline'];
const tag = '$echomap';
const typedArrays = { Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array };
const object = value => value && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
const same = (a, b) => canonical(a) === canonical(b);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function checkKeys(value, keys, name) {
  requireValue(object(value), `${name}: object required`);
  for (const key of Object.keys(value)) requireValue(keys.includes(key), `${name}: unsupported field ${key}`);
}
function checkedInput(raw) {
  checkKeys(raw, Object.keys(DEFAULT_INPUT), 'Settings');
  const input = normalizeInput(raw);
  requireValue(input.sigmaD > 0, 'Range SD must be greater than zero.');
  return input;
}
function list(value, name, valid) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 1000, `${name}: nonempty array required`);
  requireValue(value.every(v => typeof v === 'number' && Number.isFinite(v) && valid(v)), `${name}: values outside supported range`);
  requireValue(new Set(value).size === value.length, `${name}: duplicate values`);
  return [...value];
}

/** Strict public request boundary shared by the page and Node runner.
 * No code, file path, URL, threshold override or truth-side estimator option is accepted.
 */
export function normalizeRemoteRequest(raw) {
  checkKeys(raw, ['schema', 'mode', 'input', 'sweep'], 'Request');
  requireValue(raw.schema === REQUEST_SCHEMA, 'Unsupported request format.');
  requireValue(['comparison', 'sweep'].includes(raw.mode), 'Unknown experiment mode.');
  const request = { schema: REQUEST_SCHEMA, mode: raw.mode, input: checkedInput(raw.input ?? {}) };
  if (raw.mode === 'sweep') {
    checkKeys(raw.sweep, ['noise', 'roughness', 'seeds'], 'Sweep');
    request.sweep = {
      noise: list(raw.sweep.noise, 'Range SD', v => v > 0 && v <= 2),
      roughness: list(raw.sweep.roughness, 'Roughness', v => v >= 0 && v <= 20),
      seeds: list(raw.sweep.seeds, 'Seeds', v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff),
    };
    requireValue(request.sweep.noise.length * request.sweep.roughness.length * request.sweep.seeds.length <= 1000,
      'A sweep supports at most 1,000 seed/condition combinations.');
  } else requireValue(raw.sweep === undefined, 'Comparison requests cannot contain sweep settings.');
  return request;
}
export function remoteJobs(raw) {
  const request = normalizeRemoteRequest(raw);
  return request.mode === 'comparison' ? [request.input]
    : sweepJobs(request.input, request.sweep.noise, request.sweep.roughness, request.sweep.seeds);
}

// JSON has no NaN/Infinity or typed-array types. Preserve them explicitly so a
// failed metric cannot silently turn into a missing metric during cloud transfer.
export function stringifyRemoteResult(value) {
  return JSON.stringify(value, (_key, item) => {
    if (ArrayBuffer.isView(item)) {
      const type = item.constructor.name;
      requireValue(Object.hasOwn(typedArrays, type), 'Unsupported result array type.');
      return { [tag]: type, values: Array.from(item) };
    }
    if (typeof item === 'number' && !Number.isFinite(item)) return { [tag]: String(item) };
    return item;
  });
}
function revive(_key, value) {
  if (!object(value) || !Object.hasOwn(value, tag)) return value;
  const type = value[tag];
  if (['NaN', 'Infinity', '-Infinity'].includes(type)) {
    requireValue(Object.keys(value).length === 1, 'Invalid numeric result marker.');
    return type === 'NaN' ? NaN : type === 'Infinity' ? Infinity : -Infinity;
  }
  requireValue(Object.hasOwn(typedArrays, type) && Object.keys(value).length === 2
    && Array.isArray(value.values) && value.values.length <= 40000
    && value.values.every(v => typeof v === 'number'), 'Invalid typed result array.');
  return typedArrays[type].from(value.values);
}
function candidates(rows) {
  requireValue(Array.isArray(rows), 'Missing candidate results.');
  for (const row of rows) {
    requireValue(object(row) && Array.isArray(row.center) && row.center.length === 2
      && row.center.every(Number.isFinite) && ['supported', 'pending', 'contradicted'].includes(row.status), 'Invalid candidate geometry or state.');
    if (row.status === 'supported') requireValue(['phi', 'ell', 'kappa', 'sg'].every(key => Number.isFinite(row[key]))
      && row.ell >= 0, 'Invalid supported-patch geometry.');
  }
}
function checkComparison(value, request, complete) {
  requireValue(object(value) && Array.isArray(value.frames) && Array.isArray(value.evaluations), 'Missing comparison results.');
  const n = value.frames.length, total = request.input.snapshots;
  requireValue(n <= total && value.evaluations.length === n && (!complete || n === total), 'Incomplete or inconsistent snapshot results.');
  // A cancelled job may contain no prepared scenario. It remains a valid partial
  // artifact for diagnostics; the UI must not replace a map with this empty result.
  if (!n && !complete && value.scenario === null && value.grid === null) return;
  const scene = value.scenario, grid = value.grid;
  requireValue(object(scene) && same(checkedInput(scene.input), request.input), 'Result settings do not match the request.');
  requireValue(Array.isArray(scene.wire) && scene.wire.length === total && Array.isArray(scene.truth)
    && scene.truth.length === total && Array.isArray(scene.walls), 'Missing measurement or evaluation history.');
  requireValue(object(grid) && grid.nx === request.input.grid && grid.ny === request.input.grid
    && grid.x instanceof Float64Array && grid.x.length === grid.nx
    && grid.y instanceof Float64Array && grid.y.length === grid.ny
    && Array.isArray(grid.domain) && grid.domain.length === 4 && grid.domain.every(Number.isFinite), 'Invalid result grid.');
  for (let i = 0; i < n; i++) {
    const frame = value.frames[i], evaluation = value.evaluations[i];
    requireValue(frame?.t === i + 1 && scene.wire[i]?.t === i + 1 && scene.truth[i]?.t === i + 1, 'Out-of-order snapshot results.');
    for (const key of ['Dbar', 'betaHat']) requireValue(frame[key] instanceof Float32Array
      && frame[key].length === grid.nx * grid.ny && frame[key].every(Number.isFinite), 'Invalid display-field result.');
    requireValue(object(evaluation) && Array.isArray(evaluation.observed), 'Invalid evaluation result.');
    for (const method of methods) {
      candidates(frame.methods?.[method]?.candidates);
      requireValue(object(evaluation.methods?.[method]), 'Missing paired-method evaluation.');
    }
  }
}
export function parseRemoteResult(text) {
  requireValue(typeof text === 'string' && text.length <= MAX_RESULT_BYTES, 'Result exceeds the supported size.');
  const value = JSON.parse(text, revive);
  requireValue(value?.schema === RESULT_SCHEMA, 'Choose an EchoMap result.json.gz or result.json file.');
  const request = normalizeRemoteRequest(value.request);
  requireValue(['complete', 'partial'].includes(value.status), 'Invalid completion status.');
  requireValue(same(value.protocol, METHOD_PROTOCOL), 'This result uses a different method protocol. Open the matching code version.');
  requireValue(object(value.provenance), 'Missing result provenance.');
  const complete = value.status === 'complete';
  if (request.mode === 'comparison') checkComparison(value.comparison, request, complete);
  else {
    const jobs = remoteJobs(request), runs = value.sweep?.runs;
    requireValue(Array.isArray(runs) && value.sweep.total === jobs.length && runs.length <= jobs.length
      && (!complete || runs.length === jobs.length), 'Incomplete or inconsistent sweep results.');
    const remaining = new Set(jobs.map(canonical));
    for (const run of runs) {
      const key = canonical(checkedInput(run.input));
      requireValue(remaining.delete(key), 'Unexpected or duplicated sweep result.');
      requireValue(same(run.protocol, METHOD_PROTOCOL), 'Mixed method protocols in sweep results.');
      for (const method of methods) {
        const summary = run.methods?.[method]?.summary;
        requireValue(object(summary), 'Missing paired-method sweep result.');
        for (const key of ['precision', 'recall', 'holdRate', 'firstSupportPrecision', 'medianError', 'p95', 'offwall', 'f1', 'observedFraction'])
          requireValue(Object.hasOwn(summary, key) && (summary[key] === null || typeof summary[key] === 'number'), 'Missing or invalid sweep metric.');
      }
    }
  }
  return { ...value, request };
}
