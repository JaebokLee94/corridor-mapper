import { createGrid, createField } from "./field.mjs";

let field;
globalThis.onmessage = ({ data: message }) => {
  try {
    if (message.type === "init") {
      const grid = message.grid ?? {}, numerical = message.numerical ?? {};
      field = createField(createGrid(grid.nx, grid.ny, grid.domain), numerical);
      globalThis.postMessage({ type: "initialized", requestId: message.requestId, grid: field.grid });
    } else if (message.type === "step") {
      if (!field) throw new Error("field worker must be initialized");
      const frame = field.step(message.snapshot);
      globalThis.postMessage({ type: "frame", requestId: message.requestId, ...frame }, [frame.Dbar.buffer, frame.betaHat.buffer]);
    } else if (message.type === "inspect") {
      if (!field) throw new Error("field worker must be initialized");
      globalThis.postMessage({ type: "inspection", requestId: message.requestId, index: message.index, ...field.inspect(message.index) });
    } else if (message.type === "prefixInspect") {
      const grid = message.grid, index = message.index, epsilonA = message.epsilonA;
      if (!grid || !Number.isSafeInteger(index) || index < 0 || index >= grid.nx * grid.ny)
        throw new RangeError("grid index out of bounds");
      if (!Number.isFinite(epsilonA) || epsilonA < 0 || !Array.isArray(message.snapshots))
        throw new RangeError("prefix inspection requires nonnegative epsilonA and measured snapshots");
      const ix = index % grid.nx, iy = Math.floor(index / grid.nx),
        scalar = createField({ nx: 1, ny: 1, x: Float64Array.of(grid.x[ix]), y: Float64Array.of(grid.y[iy]) }, message.numerical);
      // Replay only the supplied strict past prefix; preserve the independent live field.
      for (const snapshot of message.snapshots) scalar.step(snapshot);
      const point = scalar.inspect(0);
      point.betaHat = point.A + epsilonA > 0 ? point.D / (point.A + epsilonA) : 0;
      globalThis.postMessage({ type: "inspection", requestId: message.requestId, index, ...point });
    } else throw new Error("unknown field worker message type");
  } catch (error) {
    globalThis.postMessage({ type: "error", requestId: message.requestId, error: error.message });
  }
};
