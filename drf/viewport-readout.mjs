import { viewGridLayout } from './display-field.mjs?v=20261127-field-prefetch';

// Let a changed seek take effect between eight measured updates. On a distant
// seek, retain four neighboring readouts for scrubbing and skip earlier rasters.
const batchSize=8, neighborFrames=4, cacheBytes=16*1024*1024;
const rasterBytes=frame=>frame.Dbar.byteLength+frame.betaHat.byteLength;

/** Read an exact display prefix on a panned/resized cell rectangle. The run's
 * wire array identifies its measured stream; only entries through target t go
 * to the worker. Cache recent requested frames by byte size for backwards scrubbing.
 */
export function createViewportReadout(openWorker, notify, onError) {
  let current;

  function reset() {
    const previous = current;
    current = undefined; // Fence late requests before stopping the worker.
    previous?.worker?.stop();
    previous?.frames?.clear();
  }

  function remember(view,frame) {
    const previous=view.frames.get(frame.t);
    if (previous) { view.bytes-=rasterBytes(previous);view.frames.delete(frame.t); }
    view.frames.set(frame.t,frame);view.bytes+=rasterBytes(frame);
    while (view.bytes>cacheBytes && view.frames.size>1) {
      const oldest=view.frames.keys().next().value;
      view.bytes-=rasterBytes(view.frames.get(oldest));view.frames.delete(oldest);
    }
  }

  async function advance(view) {
    view.busy = true;
    try {
      while (view === current && view.target>0 && !view.frames.has(view.target)) {
        if (!view.worker || view.position>=view.target) {
          view.worker?.stop();
          view.worker=openWorker();
          const {nx, ny, domain}=view.baseGrid;
          const ready=await view.worker.request({type:'initDisplay',grid:{nx,ny,domain},
            numerical:{band:view.band,perimeter:view.perimeter,viewBounds:view.layout.domain}});
          if (view!==current) return;
          view.grid??=ready.grid;view.position=0;
          continue;
        }
        const first=view.position+1, through=Math.min(view.position+batchSize,view.target);
        const readFrom=Math.min(through+1,Math.max(first,view.target-neighborFrames+1));
        const batch=await view.worker.request({type:'displayBatch',t:through,readFrom,snapshots:view.wire.slice(view.position,through)});
        if (view !== current) return;
        if (batch.type!=='displayBatch' || batch.t!==through || batch.frames?.length!==through-readFrom+1 ||
            !batch.frames.every((frame,i)=>frame.t===readFrom+i))
          throw new Error('Field worker returned an unexpected viewport snapshot');
        view.position=through;
        for (const frame of batch.frames) remember(view,{...frame,grid:view.grid});
        if (view.target>=readFrom && view.target<=through && view.frames.has(view.target)) notify();
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
      current = {baseGrid, wire, band, perimeter, layout, frames:new Map(), bytes:0, position:0};
    }
    current.target = t;
    const frame=current.frames.get(t);
    if (frame) {
      current.frames.delete(t);current.frames.set(t,frame);
    } else if (!current.busy && !current.failed) void advance(current);
    return frame;
  }

  return {read, reset};
}
