// Manual browser QA only. The production engine and numerical kernels run unchanged.
// Profiles worker wall time, MessageChannel scheduling and structured-clone cost.
let engine, warmTruthCache, started, preparedAt, lastPostedAt, frameStart;
let posts = [], yields = [], frames = [], requestId;
const clock = () => performance.now();
const nativePost = globalThis.postMessage.bind(globalThis);
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, total: values.reduce((sum, n) => sum + n, 0),
    mean: values.reduce((sum, n) => sum + n, 0) / (values.length || 1),
    p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0,
    max: sorted.at(-1) ?? 0 };
};
globalThis.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const [{ createRunEngine, yieldWorkerTask }, prepare] = await Promise.all([
        import(new URL('drf/run-engine.mjs', data.base).href),
        import(new URL('drf/prepare-scenario.mjs?v=20261104-background2', data.base).href),
      ]);
      warmTruthCache = prepare.warmTruthCache;
      engine = createRunEngine({
        async yieldTask() { const at = clock(); await yieldWorkerTask(); yields.push(clock() - at); },
        emit(message) {
          const at = clock();
          if (message.type === 'prepared') preparedAt = at;
          if (message.type === 'frame') {
            frameStart ??= at;
            frames.push({ next: message.next, at: at - started,
              intervalMs: at - (lastPostedAt ?? preparedAt),
              fieldMs: message.frame.ms, guardedMs: message.frame.methods.guarded.ms,
              baselineMs: message.frame.methods.baseline.ms });
          }
          const transfer = message.type === 'frame' ? [message.frame.Dbar.buffer, message.frame.betaHat.buffer] : [];
          nativePost({ ...message, qaEmittedAt: performance.timeOrigin + at }, transfer);
          const postMs = clock() - at;
          posts.push({ type: message.type, ms: postMs });
          if (message.type === 'frame' || message.type === 'prepared') lastPostedAt = clock();
          if (message.type === 'status' && message.mode === 'done') {
            nativePost({ type: 'qa-profile', requestId, profile: {
              workerElapsedMs: at - started, preparationMs: preparedAt - started,
              comparisonMs: at - preparedAt, firstFrameMs: frameStart - started,
              yieldMs: stats(yields), postMs: stats(posts.map(p => p.ms)),
              framePostMs: stats(posts.filter(p => p.type === 'frame').map(p => p.ms)),
              frameIntervalsMs: stats(frames.map(f => f.intervalMs)), frames,
              scope: 'Production engine with timed yieldTask and full production-style frame transport; no chart/DOM rendering.'
            } });
          }
        },
      });
      nativePost({ type: 'qa-ready' }); return;
    }
    if (data.type === 'warm-truth') { nativePost({ type: 'truth-warmed', hit: await warmTruthCache(data.input) }); return; }
    if (data.type === 'start') {
      started = clock(); requestId = data.requestId; preparedAt = lastPostedAt = frameStart = undefined;
      posts = []; yields = []; frames = [];
    }
    await engine.command(data);
  } catch (error) { nativePost({ type: 'error', requestId: data.requestId, message: error.stack ?? error.message }); }
};
