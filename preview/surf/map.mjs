/** Drawing only. All coordinates are metres; device pixels never enter inference.
 * Equal-metre camera, invertible world/screen transforms. O(points + grid ticks).
 */
export const finitePoint = (p) =>
  Array.isArray(p) &&
  p.length >= 2 &&
  Number.isFinite(p[0]) &&
  Number.isFinite(p[1]);
export function boundsOf(points) {
  let xmin = Infinity,
    xmax = -Infinity,
    ymin = Infinity,
    ymax = -Infinity;
  for (const p of points)
    if (finitePoint(p)) {
      xmin = Math.min(xmin, p[0]);
      xmax = Math.max(xmax, p[0]);
      ymin = Math.min(ymin, p[1]);
      ymax = Math.max(ymax, p[1]);
    }
  return Number.isFinite(xmin)
    ? { xmin, xmax, ymin, ymax }
    : { xmin: -13, xmax: 13, ymin: -3, ymax: 14 };
}
export function fitCamera(bounds, width, height) {
  const spanX = Math.max(1, bounds.xmax - bounds.xmin),
    spanY = Math.max(1, bounds.ymax - bounds.ymin);
  return {
    cx: (bounds.xmax + bounds.xmin) / 2,
    cy: (bounds.ymax + bounds.ymin) / 2,
    scale: Math.min(width / (spanX * 1.15), height / (spanY * 1.2)),
  };
}
export function toScreen(p, c, box) {
  return [
    box.x + box.w / 2 + (p[0] - c.cx) * c.scale,
    box.y + box.h / 2 - (p[1] - c.cy) * c.scale,
  ];
}
export function toWorld(p, c, box) {
  return [
    c.cx + (p[0] - box.x - box.w / 2) / c.scale,
    c.cy - (p[1] - box.y - box.h / 2) / c.scale,
  ];
}
export function zoomCamera(c, factor, anchor, box) {
  const p = toWorld(anchor, c, box),
    scale = Math.max(0.05, Math.min(100000, c.scale * factor));
  return {
    cx: p[0] - (anchor[0] - box.x - box.w / 2) / scale,
    cy: p[1] + (anchor[1] - box.y - box.h / 2) / scale,
    scale,
  };
}
export function visiblePoints(scene, result, layers) {
  const pts = (scene?.raw.poses ?? []).map((p) => p.position_m);
  if (layers.truth) pts.push(...(scene?.evaluation.wall ?? []));
  if (layers.curve) for (const c of result?.curves ?? []) pts.push(...c.points);
  for (const p of result?.predictions ?? [])
    if (p.valid) {
      pts.push(p.x);
      if (layers.normals) pts.push(p.x.map((v, k) => v + 0.55 * p.normal[k]));
    }
  if (layers.cross)
    for (const p of result?.cross.predictions ?? []) if (p.valid) pts.push(p.x);
  if (layers.candidates)
    for (const p of result?.cross.candidates ?? []) pts.push(p.x);
  return pts;
}
export function tickStep(scale) {
  const target = 64 / scale,
    power = 10 ** Math.floor(Math.log10(target)),
    m = target / power;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * power;
}
export class SurfaceMap {
  constructor(canvas, onManual) {
    this.canvas = canvas;
    this.onManual = onManual;
    this.auto = true;
    this.scene = null;
    this.result = null;
    this.layers = { truth: true, curve: true };
    this.frame = 240;
    this.camera = null;
    this.pointer = null;
    this.box = { x: 55, y: 34, w: 300, h: 300 };
    new ResizeObserver(() => {
      if (this.auto) this.camera = null;
      this.draw();
    }).observe(canvas);
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(-e.deltaY * 0.001), [e.offsetX, e.offsetY]);
      },
      { passive: false },
    );
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      this.pointer = [e.clientX, e.clientY];
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.pointer || !this.camera) return;
      this.camera.cx -= (e.clientX - this.pointer[0]) / this.camera.scale;
      this.camera.cy += (e.clientY - this.pointer[1]) / this.camera.scale;
      this.pointer = [e.clientX, e.clientY];
      this.auto = false;
      this.onManual();
      this.draw();
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
      canvas.addEventListener(event, () => {
        this.pointer = null;
      });
  }
  set(scene, result, layers) {
    this.scene = scene;
    this.result = result;
    this.layers = layers;
    if (this.auto) this.camera = null;
    this.draw();
  }
  fit() {
    this.auto = true;
    this.camera = null;
    this.draw();
  }
  zoom(factor, anchor) {
    if (!this.camera) return;
    this.camera = zoomCamera(
      this.camera,
      factor,
      anchor ?? [this.box.x + this.box.w / 2, this.box.y + this.box.h / 2],
      this.box,
    );
    this.auto = false;
    this.onManual();
    this.draw();
  }
  draw(target = this.canvas, pixelRatio = window.devicePixelRatio || 1) {
    const width = this.canvas.clientWidth,
      height = this.canvas.clientHeight;
    if (width < 1 || height < 1) return;
    target.width = Math.round(width * pixelRatio);
    target.height = Math.round(height * pixelRatio);
    const ctx = target.getContext("2d");
    ctx.scale(pixelRatio, pixelRatio);
    const box = {
      x: 72,
      y: width < 560 ? 96 : 40,
      w: width - 94,
      h: height - (width < 560 ? 164 : 108),
    };
    this.box = box;
    if (!this.camera)
      this.camera = fitCamera(
        boundsOf(visiblePoints(this.scene, this.result, this.layers)),
        box.w,
        box.h,
      );
    const c = this.camera,
      screen = (p) => toScreen(p, c, box),
      lo = toWorld([box.x, box.y + box.h], c, box),
      hi = toWorld([box.x + box.w, box.y], c, box);
    this.canvas.dataset.view = JSON.stringify({
      xmin: lo[0],
      xmax: hi[0],
      ymin: lo[1],
      ymax: hi[1],
      pixelsPerMetre: c.scale,
      plotWidth: box.w,
      plotHeight: box.h,
      auto: this.auto,
    });
    ctx.fillStyle = "#f9fbfe";
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 1;
    ctx.font = "16px -apple-system, Arial, sans-serif";
    ctx.fillStyle = "#64738b";
    const step = tickStep(c.scale * (64 / 96)),
      digits = Math.max(0, -Math.floor(Math.log10(step)));
    const label = (n) => (Math.abs(n) < step / 100 ? "0" : n.toFixed(digits));
    for (
      let x = Math.ceil(lo[0] / step) * step;
      x <= hi[0] + step * 1e-8;
      x += step
    ) {
      const sx = screen([x, 0])[0];
      ctx.strokeStyle = Math.abs(x) < step / 100 ? "#cad3e3" : "#e5ebf3";
      ctx.beginPath();
      ctx.moveTo(sx, box.y);
      ctx.lineTo(sx, box.y + box.h);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(label(x), sx, box.y + box.h + 25);
    }
    for (
      let y = Math.ceil(lo[1] / step) * step;
      y <= hi[1] + step * 1e-8;
      y += step
    ) {
      const sy = screen([0, y])[1];
      ctx.strokeStyle = Math.abs(y) < step / 100 ? "#cad3e3" : "#e5ebf3";
      ctx.beginPath();
      ctx.moveTo(box.x, sy);
      ctx.lineTo(box.x + box.w, sy);
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(label(y), box.x - 9, sy + 6);
    }
    ctx.strokeStyle = "#cbd5e4";
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = "#52627c";
    ctx.textAlign = "center";
    ctx.fillText("x (m)", box.x + box.w / 2, height - 8);
    ctx.save();
    ctx.translate(19, box.y + box.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("y (m)", 0, 0);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    const path = (points, color, lineWidth = 1.5, dash = []) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      let first = true;
      for (const p of points) {
        if (!finitePoint(p)) {
          first = true;
          continue;
        }
        const [x, y] = screen(p);
        if (first) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        first = false;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (this.layers.truth)
      path(this.scene?.evaluation.wall ?? [], "#919dad", 2, [6, 5]);
    const poses = this.scene?.raw.poses ?? [],
      bots = new Map();
    for (const p of poses) {
      if (!bots.has(p.vehicle_id)) bots.set(p.vehicle_id, []);
      bots.get(p.vehicle_id).push(p);
    }
    for (const track of bots.values())
      path(
        track.map((p) => p.position_m),
        "#85c8de",
        1.5,
        [3, 5],
      );
    if (this.layers.curve)
      for (const curve of this.result?.curves ?? [])
        path(
          curve.points,
          this.result.fit.status === "UNIQUE" ? "#2a2aea" : "#843aff",
          2,
          this.result.fit.status === "UNIQUE" ? [] : [7, 5],
        );
    const dot = (p, color, r = 2.8, open = false, diamond = false) => {
      if (!finitePoint(p)) return;
      const [x, y] = screen(p);
      ctx.beginPath();
      if (diamond) {
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
      } else ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      open ? ctx.stroke() : ctx.fill();
    };
    if (this.layers.candidates)
      for (const p of this.result?.cross.candidates ?? [])
        dot(p.x, "#843aff70", 3, true);
    if (this.layers.cross)
      for (const p of this.result?.cross.predictions ?? [])
        if (p.valid) dot(p.x, "#bf6c0b", 3.5, true, true);
    for (const p of this.result?.predictions ?? [])
      if (p.valid) {
        if (this.layers.normals)
          path(
            [p.x, p.x.map((v, k) => v + 0.55 * p.normal[k])],
            "#657ded",
            1.5,
          );
        dot(p.x, "#2a2aea", 2.7);
      }
    const labels = [];
    for (const [id, track] of bots) {
      const pose = track
        .filter((p) => p.time_s <= this.frame * 0.05 + 1e-8)
        .at(-1);
      if (!pose) continue;
      const [x, y] = screen(pose.position_m);
      ctx.beginPath();
      ctx.roundRect(x - 6, y - 5, 12, 10, 3);
      ctx.fillStyle = "#039dc6";
      ctx.fill();
      ctx.strokeStyle = "white";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.font = "bold 16px -apple-system, Arial";
      ctx.textAlign = "center";
      ctx.fillStyle = "#1d6a82";
      const labelX = Math.max(box.x + 20, Math.min(box.x + box.w - 20, x));
      let ly = y - 11;
      while (
        labels.some((p) => Math.abs(p[0] - labelX) < 36 && Math.abs(p[1] - ly) < 24)
      )
        ly -= 24;
      labels.push([labelX, ly]);
      if (ly < y - 11 || labelX !== x) {
        ctx.strokeStyle = "#6c9dac";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, y - 7);
        ctx.lineTo(labelX, ly + 3);
        ctx.stroke();
      }
      ctx.fillStyle = "#f9fbfe";
      ctx.fillRect(labelX - 18, ly - 18, 36, 24);
      ctx.fillStyle = "#1d6a82";
      ctx.fillText(`V${id + 1}`, labelX, ly);
    }
    ctx.restore();
    if (!this.scene) {
      ctx.fillStyle = "#7a879d";
      ctx.textAlign = "center";
      ctx.fillText("관측 기록을 준비하고 있습니다.", width / 2, height / 2);
    }
  }
  async png() {
    const ratio = 300 / 96,
      plot = document.createElement("canvas");
    this.draw(plot, ratio);
    const out = document.createElement("canvas");
    const ctx = out.getContext("2d");
    const wrap = (text, font) => {
      ctx.font = font;
      const lines = [];
      let line = "";
      for (const word of text.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > this.canvas.clientWidth - 30) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      if (line) lines.push(line);
      return lines;
    };
    const heading = wrap(`SURF / ${this.scene.config.shape} / ${this.scene.config.nBots} vehicles / batch 12 s`, "bold 18px Arial");
    const notes = [
      ...wrap(`${this.result.fit.status} / x, y in metres / 1:1 metric scale`, "16px Arial"),
      ...wrap(`${this.result.fit.status === "AMBIGUOUS" ? "Purple: alternative surfaces" : "Blue: SURF"} / Cyan: vehicles`, "16px Arial"),
    ];
    const headerHeight = 16 + heading.length * 24,
      footerHeight = 16 + notes.length * 24;
    out.width = plot.width;
    out.height = plot.height + Math.round((headerHeight + footerHeight) * ratio);
    ctx.fillStyle = "#f9fbfe";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(plot, 0, Math.round(headerHeight * ratio));
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#172136";
    ctx.font = "bold 18px Arial";
    heading.forEach((text, k) => ctx.fillText(text, 15, 25 + k * 24));
    ctx.font = "16px Arial";
    ctx.fillStyle = "#536484";
    notes.forEach((text, k) => ctx.fillText(text, 15, headerHeight + this.canvas.clientHeight + 25 + k * 24));
    return new Promise((resolve) => out.toBlob(resolve, "image/png"));
  }
}
