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

// A tile keeps its accumulated field, so extending one block never replays the old area.
function growMargin(current, cells, baseSize) {
  if (cells <= current) return current;
  const block = Math.max(1, Math.ceil(baseSize / 8));
  return block * Math.ceil(cells / block);
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

// 64K cells fit all ten vehicles' three Float64 focal coordinates in createField's 16 MiB cache.
const MAX_TILE_CELLS = 64 * 1024;

// Tile origins use the original lattice, so added rows never move a previously measured cell.
function appendTiles(tiles, grid, old, margins, base, replay) {
  const [left, right, bottom, top] = margins;
  const x0 = -left, x1 = base.nx + right, y0 = -bottom, y1 = base.ny + top;
  function add(x, endX, y, endY) {
    if (endX === x || endY === y) return;
    const xs = grid.x.subarray(x - x0, endX - x0);
    const rows = Math.max(1, Math.floor(MAX_TILE_CELLS / xs.length));
    for (let row = y; row < endY; row += rows) {
      const ys = grid.y.subarray(row - y0, Math.min(row + rows, endY) - y0);
      tiles.push({x, y:row, field:replay({nx:xs.length, ny:ys.length, x:xs, y:ys})});
    }
  }
  if (!old) { add(x0, x1, y0, y1); return; }
  const oldX0 = -old[0], oldX1 = base.nx + old[1], oldY0 = -old[2], oldY1 = base.ny + old[3];
  // Side strips cover the previous height; top and bottom span the new width.
  add(x0, oldX0, oldY0, oldY1);
  add(oldX1, x1, oldY0, oldY1);
  add(x0, x1, y0, oldY0);
  add(x0, x1, oldY1, y1);
}

/** Cumulative Dbar and betaHat on the original metre lattice, using measured prefixes only.
 * Grown cells need past D and A, including denominator contributions far from any return.
 * Backfill only the new strips. Old cells receive each measurement exactly once. Storage
 * is O(G + measured prefix), including the O(G) contiguous frame used by display/export.
 */
export function createDisplayField(baseGrid, numerical = {}) {
  const band = numerical.band ?? 4;
  const history = [];
  function replay(coords) {
    const field = createField(coords, numerical);
    for (const past of history) field.step(past);
    return field;
  }
  let grid = baseGrid, margins = [0, 0, 0, 0], tiles = [];
  appendTiles(tiles, grid, null, margins, baseGrid, replay);
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
    let nextGrid = grid, nextTiles = tiles;
    const grew = nextMargins.some((n, i) => n !== margins[i]);
    if (grew) {
      nextGrid = paddedGrid(baseGrid, nextMargins);
      nextTiles = history.length ? tiles.slice() : [];
      appendTiles(nextTiles, nextGrid, history.length ? margins : null, nextMargins, baseGrid, replay);
    }
    let frames;
    try {
      frames = nextTiles.map(tile => tile.field.step(wire));
    } catch (error) {
      // A rejected snapshot must not advance an earlier tile before a retry.
      for (const tile of tiles) if (tile.field.t === wire.t) tile.field = replay(tile.field.grid);
      throw error;
    }
    history.push(wire);
    grid = nextGrid; margins = nextMargins; tiles = nextTiles;
    const first = frames[0];
    if (tiles.length === 1) return {...first, grid, ms:performance.now()-started};
    const epsilonA = Math.max(...frames.map(f => f.epsilonA));
    const Dbar = new Float32Array(grid.nx*grid.ny), betaHat = new Float32Array(Dbar.length);
    for (const [k, tile] of tiles.entries()) {
      const {D, A, grid:part} = tile.field, src = frames[k].Dbar;
      for (let iy=0; iy<part.ny; iy++) {
        const row = iy*part.nx, dest = (tile.y+margins[2]+iy)*grid.nx+tile.x+margins[0];
        Dbar.set(src.subarray(row,row+part.nx),dest);
        for (let ix=0; ix<part.nx; ix++) {
          const cell = row+ix, denominator = A[cell]+epsilonA;
          betaHat[dest+ix] = denominator>0 ? D[cell]/denominator : 0;
        }
      }
    }
    return {...first, grid, Dbar, betaHat, epsilonA, ms:performance.now()-started};
  }};
}
