/** Guarded PSPT, ported from the frozen Python guarded45 implementation.
 * Input: one measured snapshot; no wall geometry, labels, seed, or future data.
 * Supported measurements require sigmaD>0; zero-range-noise joint-pose updates
 * can have singular innovation covariance and are rejected before state changes.
 * State: local quadratic patches [normal offset m, tangent rad, curvature 1/m].
 * Scores are normalized composite weights, NOT calibrated wall probabilities.
 * Pair-snapshot scores use frozen t-1 states/weights, then joint-pose KF updates.
 * V vehicles; C pairs; P returns/pair; G grid cells; J groups; M clusters/pair;
 * F matched configurations/patch; K retained snapshots; T processed snapshots.
 * Worst costs: DRF O(CPG), explaining-away O(CJ²M), KF O(JF³), F<=C=V(V-1)/2.
 * Memory: O(G + KCP + JT), plus O(win*G) when windowed births are requested.
 */
import { makeWire } from "./wire.mjs";
import { DRF } from "./pspt-ridges.mjs";
import { Surfel, refine, mirrored, dot, cov3, eigen2, matVec, matMul, transpose, solve } from "./pspt-math.mjs";

const DEFAULTS = Object.freeze({ nx: 100, ny: 100, ell: 1, K: 12, frac: 0.15, sep: 1.5, dup: 1,
  alpha: 0.01, ext: 1.5, p_miss: 0.05, R_span: 40, max_range: 25, explain_away: true,
  temper: true, mirror: true, win: null, max_inc_deg: 45, geometry_alpha: 0.001, min_evidence_steps: 2 });
// scipy.stats.chi2.isf(.001, df), df=1..18; vehicle counts 3..20.
const CHI2_001 = Object.freeze([10.827566170662733, 13.815510557964274, 16.26623619623813,
  18.466826952903173, 20.51500565243288, 22.457744484825326, 24.321886347856854,
  26.124481558376143, 27.87716487125657, 29.588298445074418, 31.264133620239992,
  32.90949040736022, 34.52817897487089, 36.123273680398135, 37.69729821835383,
  39.25235479076847, 40.79021670690252, 42.31239633167997]);
const SNAP_KEYS = new Set(["t", "configs"]), CONFIG_KEYS = new Set(["i", "j", "pHat_i", "pHat_j", "Sigma_i", "Sigma_j", "paths"]),
  PATH_KEYS = new Set(["dHat", "sigmaD"]), OPTION_KEYS = new Set(Object.keys(DEFAULTS));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const quad = (v, M) => dot(v, matVec(M, v));
const key = (gid, side) => `${gid}:${side}`;
const sum = (values) => values.reduce((a, b) => a + b, 0);
const sameVector = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1e-12 * Math.max(1, Math.abs(v), Math.abs(b[i])));

function allowKeys(object, allowed, name) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) throw new TypeError(`${name} must be an object`);
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${name} must be a plain measured-data object`);
  for (const property of Reflect.ownKeys(object)) {
    if (!allowed.has(property)) throw new TypeError(`${name}: non-wire/non-model key ${String(property)}`);
    if (!("value" in Object.getOwnPropertyDescriptor(object, property))) throw new TypeError(`${name}: accessor fields are not measurements`);
  }
}

export function prepareMeasuredSnapshot(snapshot) {
  allowKeys(snapshot, SNAP_KEYS, "snapshot");
  if (!Array.isArray(snapshot.configs) || !snapshot.configs.length) throw new RangeError("snapshot needs at least one measured configuration");
  for (const c of snapshot.configs) {
    allowKeys(c, CONFIG_KEYS, "configuration");
    if (!Array.isArray(c.paths)) throw new TypeError("paths must be an array");
    for (const p of c.paths) {
      allowKeys(p, PATH_KEYS, "path");
      if (!(p.sigmaD > 0)) throw new RangeError("PSPT requires sigmaD > 0 for every measured path");
    }
  }
  const wire = makeWire(snapshot), vehicles = new Map(), pairs = new Set(), pre = [];
  for (const c of wire.configs) {
    const pair = [c.i, c.j].sort((a, b) => a - b).join(":");
    if (pairs.has(pair)) throw new RangeError("duplicate vehicle pair in snapshot");
    pairs.add(pair);
    for (const [id, position, covariance] of [[c.i, c.pHat_i, c.Sigma_i], [c.j, c.pHat_j, c.Sigma_j]]) {
      const old = vehicles.get(id);
      if (old && (!sameVector(old.position, position) || !sameVector(old.covariance, covariance)))
        throw new RangeError("a vehicle must share the same measured pose/covariance across its pairs");
      vehicles.set(id, { position, covariance });
    }
    const pi = c.pHat_i, pj = c.pHat_j, Si = cov3(c.Sigma_i), Sj = cov3(c.Sigma_j), baseline = distance(pi, pj);
    const sr2 = c.paths.length ? sum(c.paths.map((p) => p.sigmaD ** 2)) / c.paths.length : NaN;
    const ranges = c.paths.filter((p) => p.dHat > baseline).map((p) => p.dHat).sort((a, b) => a - b), cl = [];
    if (ranges.length) {
      const gap = 3 * Math.sqrt(sr2 + 0.5 * (Si[0][0] + Si[1][1] + Sj[0][0] + Sj[1][1]));
      let begin = 0;
      for (let end = 1; end <= ranges.length; end++) if (end === ranges.length || ranges[end] - ranges[end - 1] > gap) {
        const segment = ranges.slice(begin, end), mean = sum(segment) / segment.length;
        cl.push([mean, segment.length, sum(segment.map((v) => (v - mean) ** 2))]);
        begin = end;
      }
    }
    pre.push({ i: c.i, j: c.j, pi, pj, Si, Sj, sr2, cl });
  }
  if (vehicles.size < 2 || vehicles.size > 20) throw new RangeError("PSPT supports 2 through 20 measured vehicles");
  return { wire, pre, veh: [...vehicles].sort(([a], [b]) => a - b).map(([, v]) => v.position) };
}

function newGroup(gid, h, c, t, src) {
  return { gid, s: [h, c], birth: t, src, L: [0, 0, 0, 0], post: [.25, .25, .25, .25], r: [.5, .5],
    nobs: 0, first_obs: null, status: ["pending", "pending"], reason: ["born", "born"], log: [], changes: [[], []],
    active_steps: [0, 0], first_active: [null, null], matched_steps: [0, 0], first_match: [null, null], matched_configs: [0, 0],
    own_core_snapshots: [0, 0], own_matched_snapshots: [0, 0], first_own_range_match: [null, null],
    qualified_active: [0, 0], qualified_matched: [0, 0] };
}

export class PSPT {
  constructor(options = {}) {
    allowKeys(options, OPTION_KEYS, "options");
    const o = { ...DEFAULTS, ...options };
    for (const name of ["nx", "ny", "K", "min_evidence_steps"])
      if (!Number.isSafeInteger(o[name]) || o[name] < (name === "nx" || name === "ny" ? 3 : 1)) throw new RangeError(`${name} is out of range`);
    for (const name of ["ell", "sep", "dup", "ext", "R_span", "max_range"])
      if (!Number.isFinite(o[name]) || o[name] <= 0) throw new RangeError(`${name} must be positive`);
    for (const name of ["frac", "alpha", "p_miss"])
      if (!Number.isFinite(o[name]) || o[name] <= 0 || o[name] >= 1) throw new RangeError(`${name} must lie in (0,1)`);
    for (const name of ["explain_away", "temper", "mirror"])
      if (typeof o[name] !== "boolean") throw new TypeError(`${name} must be boolean`);
    if (o.win !== null && (!Number.isSafeInteger(o.win) || o.win < 1)) throw new RangeError("win must be null or a positive integer");
    if (o.max_inc_deg !== null && (!Number.isFinite(o.max_inc_deg) || o.max_inc_deg <= 0 || o.max_inc_deg > 90))
      throw new RangeError("max_inc_deg must be null or in (0,90]");
    if (o.geometry_alpha !== .001) throw new RangeError("this validated port supports geometry_alpha=.001 only");
    Object.assign(this, o);
    this.pm = o.p_miss;
    this.cos_inc = o.max_inc_deg === null ? null : Math.cos(o.max_inc_deg * Math.PI / 180);
    this.drf = new DRF({ nx: o.nx, ny: o.ny });
    this.hist = []; this.groups = []; this.Dq = [];
    this.ncl = 0; this.ncfg = 0; this.sr2 = .01; this.last_t = null;
    this.geometry_statistic = 0; this.geometry_threshold = Infinity; this.geometry_informative = false;
  }

  _predictAll(pre, veh) {
    const predictions = new Map();
    for (const g of this.groups) {
      if (Math.min(...g.s.map((s) => Math.min(...veh.map((p) => distance(p, s.center))))) > this.max_range) continue;
      for (let k = 0; k < 2; k++) {
        const s = g.s[k], entries = [];
        for (const c of pre) {
          const p = k === 0 || this.mirror ? s.predict(c.pi, c.pj, { ext: this.ext }) : null;
          if (p === null) { entries.push(null); continue; }
          const [, tangent, normal, curvature] = s.frame(), a = curvature * p[1], denom = Math.hypot(1, a),
            rootNormal = normal.map((v, i) => (v - a * tangent[i]) / denom),
            incidence = Math.min(-dot(p[3], rootNormal), -dot(p[4], rootNormal));
          if (incidence <= 0 || (this.cos_inc !== null && incidence < this.cos_inc)) { entries.push(null); continue; }
          const sr2 = Number.isFinite(c.sr2) ? c.sr2 : this.sr2,
            base = quad(p[3], c.Si) + quad(p[4], c.Sj) + quad(p[2], s.P), G = [];
          for (let m = 0; m < c.cl.length; m++) {
            const variance = sr2 / Math.max(c.cl[m][1], 1) + base, residual = c.cl[m][0] - p[0];
            if (!(variance > 0) || !Number.isFinite(variance)) throw new RangeError("PSPT prediction covariance is nonpositive or nonfinite");
            if (Math.abs(residual) <= Math.max(.3, 3 * Math.sqrt(variance)))
              G.push([m, Math.exp(-.5 * residual ** 2 / variance) / Math.sqrt(2 * Math.PI * variance)]);
          }
          entries.push({ p, core: Math.abs(p[1]) <= s.ell, G, sr2 });
        }
        predictions.set(key(g.gid, k), entries);
      }
    }
    const poses = new Map();
    for (const c of pre) { poses.set(c.i, [c.pi, c.Si]); poses.set(c.j, [c.pj, c.Sj]); }
    const ordered = [...poses.values()].sort((a, b) => {
      const aa = [...a[0], ...a[1].flat()], bb = [...b[0], ...b[1].flat()];
      for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
      return 0;
    });
    this.geometry_informative = false;
    if (ordered.length >= 3) {
      const mean = [0, 1].map((d) => sum(ordered.map((v) => v[0][d])) / ordered.length),
        centered = ordered.map(([p]) => [p[0] - mean[0], p[1] - mean[1]]),
        aa = sum(centered.map((p) => p[0] ** 2)), bb = sum(centered.map((p) => p[0] * p[1])), cc = sum(centered.map((p) => p[1] ** 2)),
        normal = eigen2(aa, bb, cc).vectors[0];
      this.geometry_statistic = sum(centered.map((p, i) => dot(p, normal) ** 2 / Math.max(quad(normal, ordered[i][1]), 1e-12)));
      this.geometry_threshold = CHI2_001[ordered.length - 3];
      this.geometry_informative = this.geometry_statistic > this.geometry_threshold;
    }
    for (const g of this.groups) for (let k = 0; k < 2; k++) {
      const entries = predictions.get(key(g.gid, k)) ?? [], active = entries.some((e) => e !== null && e.core),
        matched = entries.some((e) => e !== null && e.core && e.G.length);
      g.own_core_snapshots[k] += Number(active);
      g.own_matched_snapshots[k] += Number(matched);
      if (matched && g.first_own_range_match[k] === null) g.first_own_range_match[k] = this.current_t;
      g.qualified_active[k] += Number(this.geometry_informative && active);
      g.qualified_matched[k] += Number(this.geometry_informative && matched);
    }
    return predictions;
  }

  step(snapshot) {
    // Validate/copy all input before mutating state, including rejected time order.
    const { wire, pre, veh } = prepareMeasuredSnapshot(snapshot), t = wire.t;
    if (t !== (this.last_t ?? 0) + 1) throw new RangeError("snapshots must be processed once in causal t=1,2,... order");
    const byId = new Map(this.groups.map((g) => [g.gid, g]));
    if (byId.size !== this.groups.length) throw new RangeError("group IDs must be unique");
    const prior = new Map(this.groups.map((g) => [g.gid, g.r.slice()]));
    let nextSr2 = this.sr2;
    for (const c of pre) if (Number.isFinite(c.sr2)) nextSr2 = c.sr2;
    const beta = this.ncfg ? Math.max(this.ncl / Math.max(this.ncfg * this.R_span, 1e-9), 1e-3) : .05,
      sp2 = sum(pre.map((c) => .5 * (c.Si[0][0] + c.Si[1][1]))) / pre.length,
      w = this.temper && veh.length > 1 ? (nextSr2 + 2 * sp2) / (nextSr2 + 2 * (veh.length - 1) * sp2) : 1;
    if (!Number.isFinite(w)) throw new RangeError("PSPT temper requires nonzero reported measurement/pose uncertainty");
    this.current_t = t;
    this.sr2 = nextSr2;
    const pred = this._predictAll(pre, veh), claims = new Map();
    for (const g of this.groups) for (let k = 0; k < 2; k++) {
      const entries = pred.get(key(g.gid, k));
      if (!entries) continue;
      entries.forEach((e, ci) => {
        if (e !== null && e.core) for (const [m, f] of e.G) {
          const claimKey = key(ci, m), list = claims.get(claimKey) ?? [];
          list.push([g.gid, k, f, g.s[k].center]); claims.set(claimKey, list);
        }
      });
    }
    const pending = [], pm = this.pm;
    for (const g of this.groups) {
      if (!pred.has(key(g.gid, 0))) continue;
      const centers = g.s.map((s) => s.center), dL = [0, 0, 0, 0], comps = [[], []], coreConfigs = [0, 0];
      let ncfg = 0;
      for (let ci = 0; ci < pre.length; ci++) {
        const c = pre[ci], E = [0, 1].map((k) => pred.get(key(g.gid, k))[ci]);
        E.forEach((e, k) => { coreConfigs[k] += Number(e !== null && e.core); });
        if (!E.some((e) => e !== null && e.core)) continue;
        ncfg++;
        const q = E.map((e, k) => {
          if (e === null) return null;
          const qk = new Map();
          for (const [m, f] of e.G) {
            let lo = beta;
            if (this.explain_away) for (const [gid, kk, ff, center] of claims.get(key(ci, m)) ?? [])
              if (gid !== g.gid && Math.min(...centers.map((x) => distance(center, x))) > 3 * this.ell)
                lo += prior.get(gid)[kk] * (1 - pm) * ff;
            qk.set(m, (1 - pm) * f / lo);
          }
          if (qk.size) {
            let mb = null, best = -Infinity;
            for (const [m, value] of qk) if (value > best) { mb = m; best = value; }
            if (best > pm) comps[k].push([c, c.cl[mb][1], e.sr2, c.cl[mb][0] - e.p[0], e.p]);
          }
          return qk;
        });
        const sh = q[0] === null ? 0 : sum([...q[0].values()]), sc = q[1] === null ? 0 : sum([...q[1].values()]),
          lh = q[0] === null ? 0 : Math.log(pm + sh), lc = q[1] === null ? 0 : Math.log(pm + sc);
        let lhc = lh + lc;
        if (q[0] !== null && q[1] !== null) {
          let cross = 0;
          for (const [m, a] of q[0]) for (const [mm, b] of q[1]) if (m !== mm) cross += a * b;
          lhc = Math.log(pm * pm + pm * sh + pm * sc + cross);
        }
        [0, lh, lc, lhc].forEach((value, i) => { dL[i] += w * value; });
      }
      pending.push([g, dL, comps, ncfg, coreConfigs]);
    }
    for (const [g, dL, comps, ncfg, coreConfigs] of pending) {
      for (let k = 0; k < 2; k++) {
        if (coreConfigs[k]) { g.active_steps[k]++; if (g.first_active[k] === null) g.first_active[k] = t; }
        if (comps[k].length) {
          g.matched_steps[k]++; g.matched_configs[k] += comps[k].length;
          if (g.first_match[k] === null) g.first_match[k] = t;
        }
      }
      if (ncfg) {
        g.L = g.L.map((value, i) => value + dL[i]); g.nobs++;
        if (g.first_obs === null) g.first_obs = t;
        g.log.push([t, ncfg, dL.slice()]);
        for (let k = 0; k < 2; k++) this._kf(g.s[k], comps[k]);
      }
    }
    for (const g of this.groups) this._status(g, t);
    for (const c of pre) { this.ncfg++; this.ncl += c.cl.length; }
    this.drf.update(wire);
    if (this.win) { this.Dq.push(this.drf.D.slice()); if (this.Dq.length > this.win + 1) this.Dq.shift(); }
    this.hist.push([t, pre]); if (this.hist.length > this.K) this.hist.shift();
    this._births(t, veh);
    this.last_t = t;
    return this.report(t);
  }

  _kf(s, comps) {
    if (!comps.length) return;
    const M = comps.length, A = comps.map((cm) => cm[4][2]), residual = comps.map((cm) => cm[3]),
      R = Array.from({ length: M }, (_, i) => Array.from({ length: M }, (_, j) => i === j ? comps[i][2] / comps[i][1] : 0));
    for (let a = 0; a < M; a++) for (let b = 0; b < M; b++) {
      const [ca, , , , pa] = comps[a], [cb, , , , pb] = comps[b];
      for (const [va, ea, covariance] of [[ca.i, pa[3], ca.Si], [ca.j, pa[4], ca.Sj]])
        for (const [vb, eb] of [[cb.i, pb[3]], [cb.j, pb[4]]]) if (va === vb) R[a][b] += dot(ea, matVec(covariance, eb));
    }
    const AP = matMul(A, s.P), S = matMul(AP, transpose(A)).map((row, i) => row.map((v, j) => v + R[i][j])),
      gain = transpose(solve(S, AP)), delta = matVec(gain, residual), KA = matMul(gain, A);
    s.x = s.x.map((value, i) => value + delta[i]);
    s.P = matMul(KA.map((row, i) => row.map((value, j) => Number(i === j) - value)), s.P);
    if (![...s.x, ...s.P.flat()].every(Number.isFinite)) throw new RangeError("PSPT KF produced a nonfinite state");
  }

  _births(t, veh) {
    const snaps = this.hist.map(([, p]) => p), field = this.win && this.Dq.length > this.win
      ? Float64Array.from(this.drf.D, (value, i) => value - this.Dq[0][i]) : null,
      candidates = this.drf.ridges({ frac: this.frac, sep: this.sep,
        xwin: [Math.min(...veh.map((p) => p[0])) - 5, Math.max(...veh.map((p) => p[0])) + 10], field }),
      centers = this.groups.flatMap((g) => g.s.map((s) => s.center)), points = snaps.flatMap((p) => p.flatMap((c) => [c.pi, c.pj])),
      m = [0, 1].map((d) => sum(points.map((p) => p[d])) / points.length),
      centered = points.map((p) => [p[0] - m[0], p[1] - m[1]]),
      direction = eigen2(sum(centered.map((p) => p[0] ** 2)), sum(centered.map((p) => p[0] * p[1])), sum(centered.map((p) => p[1] ** 2))).vectors[1],
      Rm = direction.map((a, i) => direction.map((b, j) => 2 * a * b - Number(i === j))), theta = Math.atan2(direction[1], direction[0]),
      vehicleMean = [0, 1].map((d) => sum(veh.map((p) => p[d])) / veh.length);
    let gid = this.groups.reduce((next, g) => Math.max(next, g.gid + 1), 0);
    for (const [x, y, phi] of candidates) {
      const q = [x, y];
      if (centers.some((c) => distance(q, c) < this.dup)) continue;
      const h = new Surfel(q, phi, vehicleMean.map((v, i) => v - q[i]), this.ell), c = mirrored(h, m, Rm, theta);
      if (refine(h, snaps) < 3) continue;
      if (centers.some((center) => distance(h.center, center) < .5)) continue;
      refine(c, snaps);
      const g = newGroup(gid++, h, c, t, [this.hist[0][0], t]);
      this._status(g, t); this.groups.push(g); centers.push(h.center, c.center);
    }
  }

  _status(g, t) {
    const largest = Math.max(...g.L), weights = g.L.map((value) => Math.exp(value - largest)), total = sum(weights);
    g.post = weights.map((v) => v / total); g.r = [g.post[1] + g.post[3], g.post[2] + g.post[3]];
    for (let k = 0; k < 2; k++) {
      const score = g.r[k], active = g.qualified_active[k], matched = g.qualified_matched[k];
      let state, reason;
      if (g.nobs === 0) { state = "pending"; reason = "no predictive observation"; }
      else if (active < this.min_evidence_steps) { state = "pending"; reason = "pose geometry not distinguished from noise in two active snapshots"; }
      else if (score >= 1 - this.alpha && matched < this.min_evidence_steps) { state = "pending"; reason = "fewer than two own-patch range matches"; }
      else if (score >= 1 - this.alpha) { state = "supported"; reason = "composite score and local evidence requirements passed"; }
      else if (score <= this.alpha) { state = "contradicted"; reason = "composite score and geometric evidence requirements passed"; }
      else { state = "pending"; reason = "insufficient or ambiguous predictive evidence"; }
      if (state !== g.status[k]) g.changes[k].push([t, g.status[k], state, reason]);
      g.status[k] = state; g.reason[k] = reason;
    }
  }

  report(t = this.last_t ?? 0) {
    if (t !== (this.last_t ?? 0)) throw new RangeError("report t must equal the latest completed snapshot");
    return this.groups.flatMap((g) => g.s.map((s, k) => ({ id: `${g.gid}${"hc"[k]}`, gid: g.gid, side: k,
      origin: ["drf", "mirror"][k], center: s.center.slice(), phi: s.x[1], kappa: s.x[2], sg: s.sg, ell: s.ell,
      cov: s.P.map((row) => row.slice()), birth: g.birth, src: g.src.slice(), checkedThrough: t,
      score: g.r[k], P: g.r[k], score_kind: "uncalibrated_composite_weight", status: g.status[k], reason: g.reason[k],
      nobs: g.nobs, group_nobs: g.nobs, first_obs: g.first_obs,
      n_active: g.active_steps[k], first_active: g.first_active[k], n_matched: g.matched_steps[k],
      first_matched: g.first_match[k], n_matched_configs: g.matched_configs[k],
      own_core_snapshots: g.own_core_snapshots[k], own_matched_snapshots: g.own_matched_snapshots[k], first_own_range_match: g.first_own_range_match[k],
      qualified_active: g.qualified_active[k], qualified_matched: g.qualified_matched[k],
      geometry_statistic: this.geometry_statistic, geometry_threshold: this.geometry_threshold, geometry_informative: this.geometry_informative })));
  }
}
