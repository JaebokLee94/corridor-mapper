// Only public viewer dependencies belong in the shared-site artifact.
export const runtimeFiles = [
  'drf.html', 'wall_metrics.js', 'surf/map.mjs', 'surf/exports.mjs',
  'favicon.ico', 'assets/echomap-icon.svg', 'assets/echomap-icon-32.png', 'assets/echomap-touch-icon.png',
  ...[
    'app.mjs', 'server-client.mjs', 'simulation-codec.mjs', 'run.worker.mjs', 'run-engine.mjs', 'baseline.mjs', 'comparison.mjs', 'compare.worker.mjs', 'diffuse.mjs', 'eval.worker.mjs', 'statistics.mjs', 'reflection-diagnostics.mjs', 'field.mjs',
    'field.worker.mjs', 'pspt.worker.mjs', 'pspt.mjs', 'pspt-math.mjs', 'pspt-ridges.mjs', 'pspt-evaluate.mjs', 'offline.bundle.js', 'poly.mjs', 'provenance.json',
    'reference/octave/fixtures.json', 'render.mjs', 'rng.mjs', 'scenario.mjs',
    'scenario.worker.mjs', 'specular.mjs', 'style.css', 'sweep.mjs',
    'sweep.worker.mjs', 'wall.mjs', 'wire.mjs',
  ].map(path => `drf/${path}`),
];

export const previewFiles = [
  ...runtimeFiles,
  'drf/design-preview.css', 'drf/design-preview.mjs', 'drf/preview-run-control.mjs',
];
