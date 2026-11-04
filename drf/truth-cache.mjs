/** Lossless, simulator-only physical-path cache. No measurement, estimator state,
 * fitted threshold or evaluation result is cached here. Consumers must treat a
 * returned bundle as immutable and create their own noisy measurement arrays.
 * A key excludes noise, observation selection and requested V/T; a cache hit
 * must additionally contain the complete requested vehicle/time prefix.
 * Validation is O(stored paths); an already validated in-memory hit is O(1).
 */
export const TRUTH_CACHE_SCHEMA = 'echomap-truth/1';
export const TRUTH_CACHE_GENERATOR = 'raw-paths-20261104-v1';
const KEY_FIELDS = ['seed', 'scene', 'wallSide', 'sigmaM', 'deltaM', 'sigmaDGeometry',
  'deltaD', 'roughness', 'lambda0', 'cellStep'];
const MAX_ENTRIES = 8, MAX_BYTES = 128 * 1024 * 1024;
const isNode = () => typeof process !== 'undefined' && Boolean(process.versions?.node);
// Variable imports keep Node-only modules out of browser/offline bundles.
const nodeImport = name => import(name);
const point2 = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const finiteArray = (a, length) => Array.isArray(a) && a.length === length && a.every(Number.isFinite);
const integer = x => Number.isInteger(x) && x >= 0;
const capacity = (bundle, input) => bundle.vehicles >= input.vehicles && bundle.snapshots >= input.snapshots;
const eligible = input => Number.isInteger(input.seed) && input.seed >= 1 && input.seed <= 10
  && Number.isInteger(input.vehicles) && input.vehicles >= 2 && input.vehicles <= 10;
const recordId = (key, bundle) => `${key}|${bundle.vehicles}|${bundle.snapshots}`;

/** Canonical JSON of the physical settings. Call with normalized simulator input. */
export function truthCacheKey(input) {
  const value = { schema: TRUTH_CACHE_SCHEMA, generator: TRUTH_CACHE_GENERATOR };
  for (const key of KEY_FIELDS) {
    const item = input[key];
    if (key === 'scene' || key === 'wallSide') {
      if (typeof item !== 'string' || !item) throw new TypeError(`Missing normalized truth setting: ${key}`);
    } else if (!Number.isFinite(item)) throw new TypeError(`Invalid normalized truth setting: ${key}`);
    value[key] = item;
  }
  return JSON.stringify(value);
}

/** Reject incomplete/corrupt records instead of silently changing the experiment.
 * This checks the full stored capacity, not just the requested prefix. */
export function validateTruthBundle(bundle, input, key = truthCacheKey(input)) {
  if (!bundle || bundle.schema !== TRUTH_CACHE_SCHEMA || bundle.key !== key
    || !Number.isInteger(bundle.vehicles) || bundle.vehicles < 2 || bundle.vehicles > 20
    || !Number.isInteger(bundle.snapshots) || bundle.snapshots < 1 || bundle.snapshots > 120
    || !capacity(bundle, input) || !Array.isArray(bundle.truth) || bundle.truth.length !== bundle.snapshots) return false;
  const g = bundle.geometry;
  if (!g || !finiteArray(g.domain, 4) || g.domain[0] >= g.domain[1] || g.domain[2] >= g.domain[3]
    || !Array.isArray(g.spans) || !g.spans.length || !Array.isArray(g.walls)
    || !g.walls.every(wall => Array.isArray(wall) && wall.every(point2))) return false;
  const spans = new Set();
  for (const span of g.spans) {
    if (!span || !Number.isInteger(span.span) || spans.has(span.span) || ![0, 1].includes(span.wall)
      || !Array.isArray(span.C) || span.C.length !== 4 || !span.C.every(point2)
      || !finiteArray(span.aabb, 4)) return false;
    spans.add(span.span);
  }
  if (input.scene === 'layered' && (!g.wallModel || !Number.isFinite(g.wallModel.L))) return false;
  const pathValid = p => p && point2(p.s) && Number.isFinite(p.rho) && p.rho >= 0
    && Number.isFinite(p.u) && p.u >= 0 && p.u <= 1 && spans.has(p.span) && [0, 1].includes(p.wall)
    && !Object.hasOwn(p, 'z') && !Object.hasOwn(p, 'dHat');
  for (let t = 0; t < bundle.snapshots; t++) {
    const snapshot = bundle.truth[t];
    if (snapshot?.t !== t + 1 || !Array.isArray(snapshot.p) || snapshot.p.length !== bundle.vehicles
      || !snapshot.p.every(point2) || !Array.isArray(snapshot.configs)
      || snapshot.configs.length !== bundle.vehicles * (bundle.vehicles - 1) / 2
      || Object.hasOwn(snapshot, 'poseNoise')) return false;
    let n = 0;
    for (let i = 1; i <= bundle.vehicles; i++) for (let j = i + 1; j <= bundle.vehicles; j++) {
      const c = snapshot.configs[n++];
      if (c?.i !== i || c?.j !== j || !Array.isArray(c.specular) || !Array.isArray(c.diffuse)
        || !c.specular.every(pathValid) || !c.diffuse.every(pathValid)
        || !finiteArray(c.lambdaTotal, 2) || c.lambdaTotal.some(x => x < 0)
        || !finiteArray(c.diffuseSampling?.beforeThinning, 2)
        || !finiteArray(c.diffuseSampling?.afterThinning, 2)
        || !c.diffuseSampling.beforeThinning.every(integer) || !c.diffuseSampling.afterThinning.every(integer)
        || c.diffuseSampling.beforeThinning.some((v, wall) => v < c.diffuseSampling.afterThinning[wall])
        || c.diffuseSampling.afterThinning[0] + c.diffuseSampling.afterThinning[1] !== c.diffuse.length
        || c.generated?.specular !== c.specular.length || c.generated?.diffuse !== c.diffuse.length
        || !Array.isArray(c.numericalDiagnostics?.degenerateSpans) || !integer(c.numericalDiagnostics?.unresolved)) return false;
    }
  }
  return true;
}

const bestRecord = (records, input) => records.filter(r => capacity(r, input))
  .sort((a, b) => a.vehicles - b.vehicles || a.snapshots - b.snapshots)[0];
const textEncoder = new TextEncoder(), textDecoder = new TextDecoder();
async function digest(bytes) {
  if (isNode()) return (await nodeImport('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
async function gzip(bytes, decompress = false) {
  if (isNode()) {
    const zlib = await nodeImport('node:zlib');
    return new Promise((resolve, reject) => zlib[decompress ? 'gunzip' : 'gzip'](bytes,
      ...(decompress ? [] : [{ level: 1 }]), (error, output) => error ? reject(error) : resolve(output)));
  }
  const Stream = decompress ? globalThis.DecompressionStream : globalThis.CompressionStream;
  const stream = new Blob([bytes]).stream().pipeThrough(new Stream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const decode = async bytes => JSON.parse(textDecoder.decode(await gzip(bytes, true)));
const encode = async bundle => gzip(textEncoder.encode(JSON.stringify(bundle)));

/** Injectable storage interface: get(key,input) -> bundle|null, put(key,bundle).
 * Cache I/O failures are recoverable misses; failure of build() is not swallowed. */
export function createTruthCache({ persistent = createPersistentStore(), packaged = createPackagedStore(), memoryLimit = 2 } = {}) {
  const memory = new Map(), pending = new Map();
  const counts = { memory: 0, persistent: 0, packaged: 0, generated: 0, uncached: 0,
    cacheReadErrors: 0, cacheWriteErrors: 0, invalidEntries: 0 };
  function remember(key, bundle) {
    if (memoryLimit < 1) return;
    const id = recordId(key, bundle); memory.delete(id); memory.set(id, bundle);
    while (memory.size > memoryLimit) memory.delete(memory.keys().next().value);
  }
  async function save(key, bundle) {
    try { await persistent?.put?.(key, bundle); } catch { counts.cacheWriteErrors++; }
  }
  async function buildValid(input, key, build) {
    const raw = await build();
    const bundle = { ...raw, schema: raw?.schema ?? TRUTH_CACHE_SCHEMA, key: raw?.key ?? key };
    if (!validateTruthBundle(bundle, input, key)) throw new Error('Generated physical truth bundle is invalid or incomplete');
    return bundle;
  }
  async function get(input, build) {
    const key = truthCacheKey(input);
    if (!eligible(input)) { counts.uncached++; return { bundle: await buildValid(input, key, build), source: 'uncached' }; }
    const cached = bestRecord([...memory.values()].filter(b => b.key === key), input);
    if (cached) { remember(key, cached); counts.memory++; return { bundle: cached, source: 'memory' }; }
    // Same-capacity requests share physical generation inside one worker. Larger
    // requests stay independent and may replace a smaller persistent capacity.
    const request = recordId(key, input);
    if (pending.has(request)) return pending.get(request);
    const work = (async () => {
      for (const [source, store] of [['persistent', persistent], ['packaged', packaged]]) {
        let bundle;
        try { bundle = await store?.get?.(key, input); } catch { counts.cacheReadErrors++; continue; }
        if (!bundle) continue;
        if (!validateTruthBundle(bundle, input, key)) { counts.invalidEntries++; continue; }
        remember(key, bundle); counts[source]++;
        // Packaged bytes already persist on disk or in the browser HTTP cache.
        // Recompressing a bank hit here would delay the first measurement and
        // duplicate a potentially large asset in the on-demand cache.
        return { bundle, source };
      }
      const bundle = await buildValid(input, key, build);
      remember(key, bundle); counts.generated++; await save(key, bundle);
      return { bundle, source: 'generated' };
    })();
    pending.set(request, work);
    try { return await work; } finally { pending.delete(request); }
  }
  return { getTruthBundle: get, stats: () => ({ ...counts, memoryEntries: memory.size }), clearMemory: () => memory.clear() };
}

/** Packaged bytes use gzip(JSON) with JS Number round-trip precision. The SHA-256
 * is over the compressed asset. Files are relative to the manifest directory. */
export function createPackagedStore({ manifestUrl, readBytes, hash = digest } = {}) {
  let manifestPromise;
  function url() {
    if (manifestUrl) return new URL(manifestUrl);
    // Offline blob workers may not define the substituted import.meta.url.
    // Resolve lazily inside the recoverable lookup, never at module evaluation.
    return new URL('../assets/truth-cache/manifest.json', import.meta.url);
  }
  async function read(location) {
    if (readBytes) return readBytes(location);
    if (location.protocol === 'file:' && isNode()) return (await nodeImport('node:fs/promises')).readFile(location);
    if (!['http:', 'https:'].includes(location.protocol)) throw new Error('Packaged truth bank unavailable on this transport');
    const response = await fetch(location, { cache: 'force-cache', signal: AbortSignal.timeout(location.pathname.endsWith('manifest.json') ? 5000 : 60000) });
    if (!response.ok) throw new Error(`Truth bank HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  return { async get(key, input) {
    const location = url();
    manifestPromise ??= read(location).then(bytes => JSON.parse(textDecoder.decode(bytes)));
    const manifest = await manifestPromise;
    if (!Array.isArray(manifest?.entries)) throw new Error('Invalid truth-bank manifest');
    const entry = bestRecord(manifest.entries.filter(e => e?.key === key && typeof e.file === 'string'), input);
    if (!entry) return null;
    const asset = new URL(entry.file, location);
    // A manifest may reference only files beneath its own directory.
    if (asset.origin !== location.origin || !asset.href.startsWith(new URL('.', location).href)) throw new Error('Truth-bank asset is outside its directory');
    const bytes = await read(asset);
    if (entry.sha256 && (!/^[a-f0-9]{64}$/i.test(entry.sha256) || await hash(bytes) !== entry.sha256.toLowerCase()))
      throw new Error('Truth-bank asset checksum mismatch');
    const bundle = await decode(bytes);
    if (bundle.vehicles !== entry.vehicles || bundle.snapshots !== entry.snapshots) throw new Error('Truth-bank capacity does not match its manifest');
    return bundle;
  } };
}

function createPersistentStore() {
  let store;
  async function current() {
    return store ??= isNode() ? createNodeStore() : createBrowserStore();
  }
  return { get: async (key, input) => (await current()).get(key, input), put: async (key, bundle) => (await current()).put(key, bundle) };
}

/** Independent of ephemeral echomap-server-* job directories; safe across server
 * restarts. Capacity-specific files and atomic rename avoid partial cross-worker
 * reads. Cache failures never remove user data outside this owned directory. */
export async function createNodeStore({ directory, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES } = {}) {
  const fs = await nodeImport('node:fs/promises'), path = await nodeImport('node:path');
  const os = await nodeImport('node:os'), crypto = await nodeImport('node:crypto');
  const root = directory || process.env.ECHOMAP_TRUTH_CACHE_DIR || path.join(os.homedir(), 'Library', 'Caches', 'EchoMapCompute', 'truth-bank-v1');
  const entries = async () => (await fs.readdir(root, { withFileTypes: true })).filter(e => e.isFile() && /^[a-f0-9]{64}\.v\d+\.t\d+\.json\.gz$/.test(e.name));
  async function prune() {
    const rows = await Promise.all((await entries()).map(async e => {
      try { const info = await fs.stat(path.join(root, e.name)); return { name: e.name, size: info.size, time: info.mtimeMs }; } catch { return null; }
    }));
    const sorted = rows.filter(Boolean).sort((a, b) => b.time - a.time);
    let size = 0;
    for (let i = 0; i < sorted.length; i++) {
      size += sorted[i].size;
      if (i >= maxEntries || size > maxBytes) await fs.unlink(path.join(root, sorted[i].name)).catch(() => {});
    }
  }
  return {
    async get(key, input) {
      let files; try { files = await entries(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      const prefix = `${await digest(textEncoder.encode(key))}.v`;
      const candidates = files.filter(e => e.name.startsWith(prefix)).map(e => {
        const [, vehicles, snapshots] = e.name.match(/\.v(\d+)\.t(\d+)\./);
        return { file: path.join(root, e.name), vehicles: Number(vehicles), snapshots: Number(snapshots) };
      });
      while (candidates.length) {
        const chosen = bestRecord(candidates, input); if (!chosen) return null;
        candidates.splice(candidates.indexOf(chosen), 1);
        try {
          const bundle = await decode(await fs.readFile(chosen.file));
          if (!validateTruthBundle(bundle, input, key)) continue;
          await fs.utimes(chosen.file, new Date(), new Date()).catch(() => {}); return bundle;
        } catch { /* A damaged/deleted cache file is a miss, not a simulation failure. */ }
      }
      return null;
    },
    async put(key, bundle) {
      const bytes = await encode(bundle); if (bytes.byteLength > maxBytes) return;
      await fs.mkdir(root, { recursive: true });
      const name = `${await digest(textEncoder.encode(key))}.v${bundle.vehicles}.t${bundle.snapshots}.json.gz`;
      const temporary = path.join(root, `${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
      try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, path.join(root, name)); }
      finally { await fs.unlink(temporary).catch(() => {}); }
      await prune();
    },
  };
}

function createBrowserStore() {
  let database;
  const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const completed = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error || new Error('Truth cache transaction failed')); });
  async function open() {
    database ??= new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.open('echomap-physical-truth-v1', 1);
      req.onupgradeneeded = () => { req.result.createObjectStore('meta', { keyPath: 'id' }); req.result.createObjectStore('data'); };
      req.onsuccess = () => { req.result.onversionchange = () => req.result.close(); resolve(req.result); };
      req.onerror = () => reject(req.error); req.onblocked = () => reject(new Error('Truth cache database blocked'));
    });
    return database;
  }
  return {
    async get(key, input) {
      const db = await open(), tx = db.transaction(['meta', 'data'], 'readonly');
      const rows = await request(tx.objectStore('meta').getAll());
      const chosen = bestRecord(rows.filter(r => r.key === key), input); if (!chosen) return null;
      const bytes = await request(tx.objectStore('data').get(chosen.id)); if (!bytes) return null;
      const bundle = await decode(bytes);
      const update = db.transaction('meta', 'readwrite');
      update.objectStore('meta').put({ ...chosen, usedAt: Date.now() }); await completed(update);
      return bundle;
    },
    async put(key, bundle) {
      const bytes = await encode(bundle); if (bytes.byteLength > MAX_BYTES) return;
      const db = await open(), tx = db.transaction(['meta', 'data'], 'readwrite'), done = completed(tx);
      // A request can reject before the transaction itself aborts. Register the
      // handler immediately to avoid an unhandled secondary quota rejection.
      done.catch(() => {});
      const meta = tx.objectStore('meta'), data = tx.objectStore('data');
      const id = recordId(key, bundle), rows = await request(meta.getAll());
      const row = { id, key, vehicles: bundle.vehicles, snapshots: bundle.snapshots, size: bytes.byteLength, usedAt: Date.now() };
      meta.put(row); data.put(bytes, id);
      const sorted = [...rows.filter(r => r.id !== id), row].sort((a, b) => b.usedAt - a.usedAt); let size = 0;
      for (let i = 0; i < sorted.length; i++) {
        size += sorted[i].size;
        if (i >= MAX_ENTRIES || size > MAX_BYTES) { meta.delete(sorted[i].id); data.delete(sorted[i].id); }
      }
      await done;
    },
  };
}

const sharedCache = createTruthCache();
export const getTruthBundle = (input, build) => sharedCache.getTruthBundle(input, build);
export const getTruthCacheStats = () => sharedCache.stats();
