import { createGrid, createField } from "./field.mjs?v=20261127-field-prefetch";
import { createDisplayField } from "./display-field.mjs?v=20261127-field-prefetch";

let field, fixedView=false;
globalThis.onmessage = ({ data: message }) => {
  try {
    if (message.type === "init" || message.type === "initDisplay") {
      const grid = message.grid ?? {}, numerical = message.numerical ?? {};
      const baseGrid = createGrid(grid.nx, grid.ny, grid.domain);
      field = (message.type === "initDisplay" ? createDisplayField : createField)(baseGrid, numerical);
      fixedView = message.type === "initDisplay" && numerical.viewBounds !== undefined;
      globalThis.postMessage({ type: "initialized", requestId: message.requestId, grid: field.grid });
    } else if (message.type === "step") {
      if (!field) throw new Error("field worker must be initialized");
      const frame = field.step(message.snapshot);
      globalThis.postMessage({ type: "frame", requestId: message.requestId, ...frame }, [frame.Dbar.buffer, frame.betaHat.buffer]);
    } else if (message.type === "displayBatch") {
      if (!field || !fixedView) throw new Error("a fixed viewport must be initialized for batch readout");
      const {snapshots,t,readFrom} = message;
      if (!Array.isArray(snapshots) || !snapshots.length || !Number.isSafeInteger(t) || t < snapshots.length)
        throw new RangeError("viewport batch requires a measured prefix ending at t");
      const first = t - snapshots.length + 1;
      if (!Number.isSafeInteger(readFrom) || readFrom < first || readFrom > t+1 ||
          !snapshots.every((wire,i)=>wire?.t === first+i))
        throw new RangeError("viewport batch snapshots and readout must follow the requested prefix");
      const frames=[], transfer=[];
      try {
        for (const wire of snapshots) {
          const frame=field.step(wire,wire.t>=readFrom);
          if (frame) {
            // The initialized viewport grid is fixed and already resides on the page.
            const {grid,...readout}=frame;
            frames.push(readout); transfer.push(frame.Dbar.buffer,frame.betaHat.buffer);
          }
        }
      } catch (error) {
        // Some prefixes may already be committed. A failed batch requires a fresh accumulator.
        field=undefined; fixedView=false; throw error;
      }
      globalThis.postMessage({type:"displayBatch", requestId:message.requestId, t, frames}, transfer);
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
