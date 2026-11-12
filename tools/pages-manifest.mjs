import { readFileSync } from 'node:fs';
const originalCacheFiles = ['drf/prepare-scenario.mjs', 'drf/truth-cache.mjs', 'drf/run-preloader.mjs', 'assets/truth-cache/manifest.json'];
const truthBank = JSON.parse(readFileSync(new URL('../assets/truth-cache/manifest.json', import.meta.url), 'utf8'));
originalCacheFiles.push(...truthBank.entries.map(entry => `assets/truth-cache/${entry.file}`));

// Only public viewer dependencies belong in the shared-site artifact.
const originalDiagnosticFiles = ['diagnostic-ui.mjs', 'diagnostic-profile.mjs', 'sweep-export.mjs'].map(path => `drf/${path}`);
const originalMathFiles = ['latex-LICENSE.txt', 'latex.mjs', 'latex-assets.mjs', 'dom-math.mjs', 'render-math.mjs'].map(path => `drf/${path}`);
const originalComputeFiles = ['drf/public-measure.mjs','drf/field-reuse.mjs', 'drf/pspt-curvature.mjs', 'drf/pspt-recovery.mjs'];
export const runtimeFiles = [
  ...originalMathFiles, ...originalDiagnosticFiles, ...originalCacheFiles, ...originalComputeFiles,
  'drf.html', 'wall_metrics.js', 'surf/map.mjs', 'surf/exports.mjs',
  'favicon.ico', 'assets/echomap-icon.svg', 'assets/echomap-icon-32.png', 'assets/echomap-touch-icon.png',
  ...[
    'app.mjs', 'server-client.mjs', 'simulation-codec.mjs', 'run.worker.mjs', 'run-engine.mjs', 'baseline.mjs', 'comparison.mjs', 'legacy-run-protocol.mjs', 'compare.worker.mjs', 'diffuse.mjs', 'eval.worker.mjs', 'statistics.mjs', 'reflection-diagnostics.mjs', 'field.mjs',
    'field.worker.mjs', 'pspt.worker.mjs', 'pspt.mjs', 'pspt-math.mjs', 'wall-bridges.mjs', 'bridge-evidence.mjs', 'bridge-curves.mjs', 'centre-spline.mjs', 'checked-centre.mjs', 'interpolation-panel.mjs', 'pspt-ridges.mjs', 'pspt-evaluate.mjs', 'offline.bundle.js', 'poly.mjs', 'provenance.json',
    'reference/octave/fixtures.json', 'render.mjs', 'rng.mjs', 'scenario.mjs',
    'scenario.worker.mjs', 'specular.mjs', 'style.css', 'sweep.mjs',
    'sweep.worker.mjs', 'wall.mjs', 'wire.mjs',
  ].map(path => `drf/${path}`),
];
