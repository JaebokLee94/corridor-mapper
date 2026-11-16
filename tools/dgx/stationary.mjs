// Research batch only. Retain all near-flat slopes; the simulator refines each flagged triple in its original order.
import {createRequire} from 'node:module';
const {mark}=createRequire(import.meta.url)('./stationary.node');

export function stationaryCandidates(x, observations, sign) {
  if(!observations.length || x.length<3) return null;
  const sensors=new Float64Array(4*observations.length);
  for(let i=0;i<observations.length;i++) {
    const {a,b}=observations[i];
    sensors.set(a,4*i); sensors.set(b,4*i+2);
  }
  const bits=new Uint32Array(observations.length*Math.ceil(x.length/32));
  return heights=>mark(x,sensors,heights,sign,bits);
}
