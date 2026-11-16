// One JSON settings object per input line; write one completed result per line.
// Set ECHOMAP_DGX_URL to the server loopback URL (or the Mac SSH forward).
import { createInterface } from 'node:readline';
import { runExperiment } from '../../drf/sweep.mjs';
import { prepareNodeScenario } from './client.mjs';
const backend=process.env.ECHOMAP_DGX_ESTIMATOR || 'cpu';
if(!['cpu','h200'].includes(backend)) throw new Error('ECHOMAP_DGX_ESTIMATOR must be cpu or h200.');
const stationaryCandidates=backend==='h200' ? (await import('./stationary.mjs')).stationaryCandidates : undefined;
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  if(!line.trim()) continue;
  const {final, ...record}=await runExperiment(JSON.parse(line),()=>{},prepareNodeScenario,stationaryCandidates);
  record.timing.echoSplineBackend=backend;
  process.stdout.write(JSON.stringify(record)+'\n');
}
