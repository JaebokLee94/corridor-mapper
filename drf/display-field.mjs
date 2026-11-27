import { createField } from './field.mjs';
import { makeWire } from './wire.mjs';

// Both perimeter methods give P >= π*dHat/2. With |grad rho| <= 2 and
// sigmaR >= sigmaD, each path density is bounded by alphaMax*exp(-z²/2).
const LOG_ALPHA_FACTOR = Math.log(4 / (Math.PI * Math.sqrt(2 * Math.PI)));
function fullDisplayBand(dHat, sigmaD) {
  if (!sigmaD) return 39; // exp(-39²/2) already rounds to zero in Float64.
  const logAlphaMax = LOG_ALPHA_FACTOR - Math.log(sigmaD) - Math.log(dHat);
  // Dbar is a mean of densities, betaHat a weighted mean of kernels with
  // a nonnegative denominator guard. Put both below half a Float32 subnormal
  // (2^-150), with one extra SD for floating-point geometry and accumulation.
  return Math.min(39, 1 + Math.sqrt(2 * (150 * Math.LN2 + Math.max(0, logAlphaMax))));
}

function measuredBounds(wire, band, domain) {
  let [xmin, xmax, ymin, ymax] = domain;
  for (const {pHat_i: a, pHat_j: b, Sigma_i: si, Sigma_j: sj, paths} of wire.configs) {
    const dx = b[0] - a[0], dy = b[1] - a[1], focal = Math.hypot(dx, dy);
    // A PSD covariance's trace bounds its variance in every unit direction.
    const poseVariance = si[0] + si[2] + sj[0] + sj[2];
    let range = 0;
    for (const {dHat, sigmaD} of paths) {
      if (dHat <= focal) continue;
      const width = band === 'full' ? fullDisplayBand(dHat, sigmaD) : band;
      range = Math.max(range, dHat + width * Math.sqrt(sigmaD ** 2 + poseVariance));
    }
    if (!range) continue;
    // Axis projections of the outer ellipse: hx²=(range²-dy²)/4, hy²=(range²-dx²)/4.
    const halfExtent = d => 0.5 * Math.sqrt(Math.max(0, (range - Math.abs(d)) * (range + Math.abs(d))));
    const hx = halfExtent(dy), hy = halfExtent(dx), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    xmin = Math.min(xmin, mx - hx); xmax = Math.max(xmax, mx + hx);
    ymin = Math.min(ymin, my - hy); ymax = Math.max(ymax, my + hy);
  }
  return [xmin, xmax, ymin, ymax];
}

// Reserve whole blocks and grow each margin geometrically to amortize prefix replays.
function growMargin(current, cells, baseSize) {
  if (cells <= current) return current;
  const block = Math.max(1, Math.ceil(baseSize / 8));
  return Math.max(2 * current, block * Math.ceil(cells / block));
}

function paddedGrid(base, [left, right, bottom, top]) {
  const {dx, dy} = base, nx = base.nx + left + right, ny = base.ny + bottom + top;
  const xmin = base.xmin - left * dx, xmax = base.xmax + right * dx;
  const ymin = base.ymin - bottom * dy, ymax = base.ymax + top * dy;
  // Address every centre from the original origin, including after repeated extensions.
  return {nx, ny, xmin, xmax, ymin, ymax, domain: [xmin, xmax, ymin, ymax], dx, dy,
    x: Float64Array.from({length: nx}, (_, ix) => base.xmin + (ix - left + 0.5) * dx),
    y: Float64Array.from({length: ny}, (_, iy) => base.ymin + (iy - bottom + 0.5) * dy)};
}

/** Display-only cumulative Dbar and betaHat. Inputs are a cell-centred base grid
 * in metres and ordered measured wires. Each frame owns its iy*nx+ix readouts
 * and references the grid in effect at that snapshot.
 * The ordinary field step is reused on G cells. An extension replays earlier
 * measurements so the new cells also include every past denominator term.
 * Storage is O(G + measured prefix), in addition to the frames retained by callers.
 */
export function createDisplayField(baseGrid, numerical = {}) {
  const band = numerical.band ?? 4;
  let grid = baseGrid, field = createField(grid, numerical), margins = [0, 0, 0, 0];
  const history = [];
  return {step(snapshot) {
    const started = performance.now(), wire = makeWire(snapshot);
    if (wire.t !== history.length + 1) throw new RangeError('Display snapshots must follow causal t=1,2,... order');
    const [xmin, xmax, ymin, ymax] = measuredBounds(wire, band, baseGrid.domain);
    const nextMargins = [
      growMargin(margins[0], (baseGrid.xmin - xmin) / baseGrid.dx, baseGrid.nx),
      growMargin(margins[1], (xmax - baseGrid.xmax) / baseGrid.dx, baseGrid.nx),
      growMargin(margins[2], (baseGrid.ymin - ymin) / baseGrid.dy, baseGrid.ny),
      growMargin(margins[3], (ymax - baseGrid.ymax) / baseGrid.dy, baseGrid.ny),
    ];
    let nextGrid = grid, nextField = field;
    if (nextMargins.some((n, i) => n !== margins[i])) {
      nextGrid = paddedGrid(baseGrid, nextMargins);
      nextField = createField(nextGrid, numerical);
      for (const past of history) nextField.step(past);
    }
    const frame = nextField.step(wire);
    history.push(wire);
    grid = nextGrid; field = nextField; margins = nextMargins;
    return {...frame, grid, ms: performance.now() - started};
  }};
}
