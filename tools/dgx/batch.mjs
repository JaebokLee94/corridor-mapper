// One JSON settings object per input line; write one completed result per line.
// Set ECHOMAP_DGX_URL to the server loopback URL (or the Mac SSH forward).
import { createInterface } from 'node:readline';
import { estimateFinalMaps } from '../../drf/echo-comparison.mjs';
import { experimentSettings } from '../../drf/experiment-settings.mjs';
import { runExperiment } from '../../drf/sweep.mjs';
import { prepareNodeScenario } from './client.mjs';
const backend=process.env.ECHOMAP_DGX_ESTIMATOR || 'cpu';
if(!['cpu','h200'].includes(backend)) throw new Error('ECHOMAP_DGX_ESTIMATOR must be cpu or h200.');
const stationaryCandidates=backend==='h200' ? (await import('./stationary.mjs')).stationaryCandidates : undefined;
const args=process.argv.slice(2), finalOnly=args.includes('--final-map');
if(args.length!==Number(finalOnly))throw new Error('Usage: node tools/dgx/batch.mjs [--final-map]');
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  if(!line.trim()) continue;
  const raw=JSON.parse(line);
  if(finalOnly){
    const input=experimentSettings(raw);
    if(input.sigmaD===0)throw new Error('Both methods require range SD σd > 0.');
    const scenario=await prepareNodeScenario(input);
    const maps=await estimateFinalMaps(input,scenario.domain,scenario.wire,stationaryCandidates);
    process.stdout.write(JSON.stringify({input,t:scenario.wire.length,echoSplineBackend:backend,maps})+'\n');
    continue;
  }
  const {final, ...record}=await runExperiment(raw,()=>{},prepareNodeScenario,stationaryCandidates);
  record.timing.echoSplineBackend=backend;
  process.stdout.write(JSON.stringify(record)+'\n');
}
