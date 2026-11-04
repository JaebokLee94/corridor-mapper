import { createGrid, createField } from "./field.mjs";

/** scipy.ndimage.map_coordinates(order=1, mode='nearest') on y-major data. */
export function sampleLinear(field, nx, ny, row, column) {
  const y = Math.max(0, Math.min(ny - 1, row)), x = Math.max(0, Math.min(nx - 1, column));
  const y0 = Math.floor(y), x0 = Math.floor(x), y1 = Math.min(y0 + 1, ny - 1), x1 = Math.min(x0 + 1, nx - 1);
  const fy = y - y0, fx = x - x0;
  return (1 - fy) * ((1 - fx) * field[y0 * nx + x0] + fx * field[y0 * nx + x1])
    + fy * ((1 - fx) * field[y1 * nx + x0] + fx * field[y1 * nx + x1]);
}

/** np.gradient default edge_order=1, central differences in the interior. */
function gradient(field, nx, ny, dx, dy) {
  const gx = new Float64Array(field.length), gy = new Float64Array(field.length);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const at = y * nx + x, left = Math.max(0, x - 1), right = Math.min(nx - 1, x + 1);
    const bottom = Math.max(0, y - 1), top = Math.min(ny - 1, y + 1);
    gx[at] = (field[y * nx + right] - field[y * nx + left]) / ((right - left) * dx);
    gy[at] = (field[top * nx + x] - field[bottom * nx + x]) / ((top - bottom) * dy);
  }
  return [gy, gx];
}

/** Measured-only candidate field. Fixed public domain, band=4 and exact perimeter.
 * D/A are the original createField Float64 arrays. Readout Float32 is not used
 * for candidate extraction or beta. Ridges O(grid + candidates²), O(grid) memory.
 */
export class DRF {
  constructor({ nx = 100, ny = 100 } = {}) {
    if (nx < 2 || ny < 2) throw new RangeError("ridge grid needs at least two cells per axis");
    this.grid = createGrid(nx, ny, [0, 80, -20, 50]);
    this.field = createField(this.grid, { band: 4, perimeter: "exact" });
    const { x, y, dx, dy } = this.grid;
    Object.assign(this, { nx, ny, x, y, dx, dy, D: this.field.D, A: this.field.A });
  }

  get Q() { return this.field.Q; }
  update(wire) { return this.field.step(wire); }

  beta() {
    let maximum = 1e-300;
    for (const value of this.A) maximum = Math.max(maximum, value);
    const epsilon = 1e-12 * maximum;
    return Float64Array.from(this.D, (value, index) => value / (this.A[index] + epsilon));
  }

  ridges({ frac = 0.15, sep = 1.5, xwin = null, field = null } = {}) {
    const D = field ?? this.D, { nx, ny, dx, dy, x, y } = this;
    if (D.length !== nx * ny || !Number.isFinite(frac) || frac < 0 || !Number.isFinite(sep) || sep < 0)
      throw new RangeError("invalid ridge extraction input");
    let maximum = 0;
    for (const value of D) { if (!Number.isFinite(value)) throw new RangeError("nonfinite field"); maximum = Math.max(maximum, value); }
    if (maximum <= 0) return [];
    const [Dy, Dx] = gradient(D, nx, ny, dx, dy);
    const [Dyy, Dyx] = gradient(Dy, nx, ny, dx, dy), [Dxy, Dxx] = gradient(Dx, nx, ny, dx, dy);
    const candidates = [], h = Math.min(dx, dy);
    for (let row = 1; row + 1 < ny; row++) for (let column = 1; column + 1 < nx; column++) {
      const at = row * nx + column;
      if (D[at] < frac * maximum || (xwin && (x[column] < xwin[0] || x[column] > xwin[1]))) continue;
      const mixed = 0.5 * (Dxy[at] + Dyx[at]);
      const disc = Math.sqrt(Math.max(0.25 * (Dxx[at] - Dyy[at]) ** 2 + mixed ** 2, 0));
      const eigenvalue = 0.5 * (Dxx[at] + Dyy[at]) - disc;
      if (!(eigenvalue < 0)) continue;
      let vx = Math.abs(mixed) > 1e-15 ? mixed : (Dxx[at] <= Dyy[at] ? 1 : 0);
      let vy = Math.abs(mixed) > 1e-15 ? eigenvalue - Dxx[at] : (Dxx[at] <= Dyy[at] ? 0 : 1);
      const norm = Math.hypot(vx, vy) + 1e-300; vx /= norm; vy /= norm;
      const plus = sampleLinear(D, nx, ny, row + h * vy / dy, column + h * vx / dx);
      const minus = sampleLinear(D, nx, ny, row - h * vy / dy, column - h * vx / dx);
      if (D[at] >= plus && D[at] >= minus) candidates.push([x[column], y[row], Math.atan2(vx, -vy), D[at], at]);
    }
    // NumPy's default unstable argsort has no portable tie ordering. Use row-major
    // order for exact ties; unequal strengths follow the same greedy suppression.
    candidates.sort((a, b) => b[3] - a[3] || a[4] - b[4]);
    const out = [];
    for (const candidate of candidates) if (out.every((other) => Math.hypot(candidate[0] - other[0], candidate[1] - other[1]) >= sep))
      out.push(candidate.slice(0, 4));
    return out;
  }
}
