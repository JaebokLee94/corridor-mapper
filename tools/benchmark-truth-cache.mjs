#!/usr/bin/env node
// Compare uncached physical generation against a first packaged read and reuse
// after changing noise. Every measured scenario is checked bit-for-bit first.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { generateScenario } from '../drf/scenario.mjs';
import { createScenarioPreparer } from '../drf/prepare-scenario.mjs';
import { createTruthCache, createPackagedStore } from '../drf/truth-cache.mjs';

const comparable = ({ simulatorMs, ...scenario }) => scenario;
const rows = [];
for (const seed of [1, 10]) for (const vehicles of [3, 10]) {
  const input = { seed, vehicles, snapshots: 120 };
  const cache = createTruthCache({ persistent: null, packaged: createPackagedStore() });
  const prepare = createScenarioPreparer({ cache });
  const reference = await generateScenario(input);
  let source;
  const first = await prepare(input, undefined, { onCache: info => { source = info.source; } });
  assert.equal(source, 'packaged');
  assert.deepEqual(comparable(first), comparable(reference));
  const changed = { ...input, sigmaP: .2, sigmaD: .3 };
  const expected = await generateScenario(changed);
  const reused = await prepare(changed, undefined, { onCache: info => { source = info.source; } });
  assert.equal(source, 'memory');
  assert.deepEqual(comparable(reused), comparable(expected));
  rows.push({ seed, vehicles, snapshots: 120, bitExact: true,
    uncachedMs: reference.simulatorMs, packagedMs: first.simulatorMs,
    changedNoiseUncachedMs: expected.simulatorMs, changedNoiseMemoryMs: reused.simulatorMs,
    packagedSpeedup: reference.simulatorMs / first.simulatorMs,
    changedNoiseSpeedup: expected.simulatorMs / reused.simulatorMs });
  console.log(JSON.stringify(rows.at(-1)));
}
const report = { measuredAt: new Date().toISOString(), runtime: process.version,
  platform: `${process.platform}/${process.arch}`, scope: 'Measurement preparation only; Node filesystem read, no network transfer. One measurement per setting.', rows };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
