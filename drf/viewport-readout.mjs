import { viewGridLayout } from './display-field.mjs?v=20261128-viewport-field';

/** Read an exact display prefix on a panned/resized cell rectangle. The run's
 * wire array identifies its measured stream; only entries through target t go
 * to the worker. Keep frames for backwards scrubbing until the run/view changes.
 */
export function createViewportReadout(openWorker, notify, onError) {
  let current;

  function reset() {
    const previous = current;
    current = undefined; // Fence late requests before stopping the worker.
    previous?.worker?.stop();
    if (previous?.frames) previous.frames.length = 0;
  }

  async function advance(view) {
    view.busy = true;
    try {
      if (!view.worker) {
        view.worker = openWorker();
        const {nx, ny, domain} = view.baseGrid;
        await view.worker.request({type:'initDisplay', grid:{nx, ny, domain},
          numerical:{band:view.band, perimeter:view.perimeter, viewBounds:view.layout.domain}});
      }
      while (view === current && view.frames.length < view.target) {
        const next = view.frames.length + 1;
        const {type, requestId, ...frame} = await view.worker.request({type:'step', snapshot:view.wire[next - 1]});
        if (view !== current) return;
        if (type !== 'frame' || frame.t !== next) throw new Error('Field worker returned an unexpected viewport snapshot');
        view.frames.push(frame);
        if (next === view.target) notify();
      }
    } catch (error) {
      if (view === current) {
        view.failed = true;
        view.worker?.stop();
        view.worker = undefined;
        onError(error);
      }
    } finally {
      view.busy = false;
    }
  }

  function read({baseGrid, numerical = {}, wire, bounds, t}) {
    if (!baseGrid || !Array.isArray(wire) || !Number.isSafeInteger(t) || t < 1 || t > wire.length) {
      if (current && (current.baseGrid !== baseGrid || current.wire !== wire)) reset();
      else if (current) current.target = 0;
      return undefined;
    }
    const band = numerical.band ?? 4, perimeter = numerical.perimeter ?? 'exact';
    const sameRun = current && current.wire === wire && current.baseGrid === baseGrid &&
      current.band === band && current.perimeter === perimeter;
    let layout;
    try {
      layout = viewGridLayout(baseGrid, bounds);
    } catch (error) {
      const invalid = String(bounds);
      if (!sameRun || current.invalid !== invalid) {
        reset();
        current = {baseGrid, wire, band, perimeter, invalid};
        onError(error);
      }
      return undefined;
    }
    const old = current?.layout;
    if (!sameRun || !old || old.x0 !== layout.x0 || old.y0 !== layout.y0 || old.nx !== layout.nx || old.ny !== layout.ny) {
      reset();
      current = {baseGrid, wire, band, perimeter, layout, frames:[]};
    }
    current.target = t;
    const frame = current.frames[t - 1];
    if (!frame && !current.busy && !current.failed) void advance(current);
    return frame;
  }

  return {read, reset};
}
