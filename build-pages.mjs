import { copyFileSync, mkdirSync, rmSync } from 'node:fs';

// Public runtime only: keep historical research sources out of the Pages artifact.
const root = new URL('./', import.meta.url), output = new URL('_site/', root);
const files = [
  'drf.html', 'wall_metrics.js', 'surf/map.mjs', 'surf/exports.mjs',
  'favicon.ico', 'assets/echomap-icon.svg', 'assets/echomap-icon-32.png', 'assets/echomap-touch-icon.png',
  ...[
    'app.mjs', 'remote-format.mjs', 'run.worker.mjs', 'run-engine.mjs', 'baseline.mjs', 'comparison.mjs', 'compare.worker.mjs', 'diffuse.mjs', 'eval.worker.mjs', 'statistics.mjs', 'reflection-diagnostics.mjs', 'field.mjs',
    'field.worker.mjs', 'pspt.worker.mjs', 'pspt.mjs', 'pspt-math.mjs', 'pspt-ridges.mjs', 'pspt-evaluate.mjs', 'offline.bundle.js', 'poly.mjs', 'provenance.json',
    'reference/octave/fixtures.json', 'render.mjs', 'rng.mjs', 'scenario.mjs',
    'scenario.worker.mjs', 'specular.mjs', 'style.css', 'sweep.mjs',
    'sweep.worker.mjs', 'wall.mjs', 'wire.mjs',
  ].map(path => `drf/${path}`),
];
rmSync(output, { recursive: true, force: true });
for (const path of files) {
  const target = new URL(path, output);
  mkdirSync(new URL('./', target), { recursive: true });
  copyFileSync(new URL(path, root), target);
}
console.log(`Built DRF-only Pages artifact: ${files.length} files.`);
