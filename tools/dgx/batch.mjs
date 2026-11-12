// One JSON settings object per input line; write one completed result per line.
// Set ECHOMAP_DGX_URL to the server loopback URL (or the Mac SSH forward).
import { createInterface } from 'node:readline';
import { runExperiment } from '../../drf/sweep.mjs';
import { prepareNodeScenario } from './client.mjs';
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  if(!line.trim()) continue;
  const {final, ...record}=await runExperiment(JSON.parse(line),()=>{},prepareNodeScenario);
  process.stdout.write(JSON.stringify(record)+'\n');
}
