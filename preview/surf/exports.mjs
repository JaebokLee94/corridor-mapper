/** Output serialization only. Intended Point is evaluation-only and not worker input. */
export function exportData(scene, result, metrics) {
  return {
    schema: "echomap-surf/1",
    units: { position: "m", range: "m", time: "s", normal: "unit vector" },
    experiment: scene.config,
    provenance: result.provenance,
    availability: {
      mode: "BATCH",
      information_cutoff_s: 12,
      earliest_observation_availability_s: 12,
      compute_time_s: {SURF: result.fit.seconds, CROSS: result.cross.seconds},
      availability_clock: "simulated observation time; computation latency is separate",
      note: "12 s of observations plus computation latency; slider is vehicle replay only",
    },
    input: scene.raw.poses,
    measurement: scene.raw.records.map((r) => ({
      record_id: `${scene.raw.run_id}/range/${r.key}`,
      key: r.key,
      tx_id: r.i,
      rx_id: r.j,
      time_s: r.t,
      available_at_s: r.t,
      total_reflected_path_m: r.r,
      sigma_m: r.sigma,
    })),
    result: {
      surf: result.predictions,
      cross: result.cross.predictions,
      all_c_candidates: result.cross.candidates,
      surface_fit: result.fit,
      native_contacts: result.native_contacts,
    },
    "Intended Point": {
      role: "evaluation only, never supplied to estimator",
      contacts: scene.evaluation.truth,
      wall: scene.evaluation.wall,
    },
    evaluation: {
      rule: { contact_tolerance_m: 0.2, observed_wall_radius_m: 0.12 },
      metrics,
    },
  };
}
export function pointCsv(scene, result) {
  const truth = new Map(scene.evaluation.truth.map((t) => [t.key, t]));
  const fields = [
    "method",
    "target_id",
    "status",
    "valid",
    "time_s",
    "available_at_s",
    "x_m",
    "y_m",
    "nx",
    "ny",
    "intended_x_m",
    "intended_y_m",
  ];
  const rows = [fields];
  for (const p of [...result.predictions, ...result.cross.predictions]) {
    const t = truth.get(p.key);
    rows.push([
      p.method_id,
      p.target_id,
      p.status,
      p.valid,
      p.time_s,
      p.available_at ?? 12,
      p.valid ? p.x[0] : "",
      p.valid ? p.x[1] : "",
      p.valid ? p.normal[0] : "",
      p.valid ? p.normal[1] : "",
      t?.hit[0] ?? "",
      t?.hit[1] ?? "",
    ]);
  }
  return (
    "\ufeff" +
    rows
      .map((row) =>
        row
          .map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"')
          .join(","),
      )
      .join("\r\n") +
    "\r\n"
  );
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Set PNG pHYs to 11811 px/m (300 dpi); preserve all image chunks. */
export async function png300dpi(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    parts = [bytes.slice(0, 8)],
    data = new Uint8Array(13),
    view = new DataView(data.buffer);
  data.set([112, 72, 89, 115]);
  view.setUint32(4, 11811);
  view.setUint32(8, 11811);
  data[12] = 1;
  const chunk = new Uint8Array(21),
    cv = new DataView(chunk.buffer);
  cv.setUint32(0, 9);
  chunk.set(data, 4);
  cv.setUint32(17, crc32(data));
  let added = false;
  for (let at = 8; at < bytes.length; ) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(
        0,
      ),
      type = String.fromCharCode(...bytes.slice(at + 4, at + 8));
    if (type === "IDAT" && !added) {
      parts.push(chunk);
      added = true;
    }
    if (type !== "pHYs") parts.push(bytes.slice(at, at + size + 12));
    at += size + 12;
  }
  return new Blob(parts, { type: "image/png" });
}
export function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
