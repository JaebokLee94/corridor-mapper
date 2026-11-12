import { createRequire } from 'node:module';
import { createSceneGeometry, truePoses, measureTruthSnapshot } from '../../drf/scenario.mjs';
import { wallCells } from '../../drf/wall.mjs';
import { specularPoints } from '../../drf/specular.mjs';
import { sampleDiffuse } from '../../drf/diffuse.mjs';
import { createRng } from '../../drf/rng.mjs';

const { weights } = createRequire(import.meta.url)('./weights.node');
// The CPU reference, random streams and observation model stay in JavaScript.
// GPU memory O(pairs*cells) is released each snapshot. Only one scene is retained per process.
let previousKey, cached;
export function generateChunk(input, start, end, physicalOnly = false) {
  const key=JSON.stringify(input);
  if (key!==previousKey) {
    const geometry=createSceneGeometry(input), cells=wallCells(geometry.spans,input.cellStep);
    const walls=[...new Set(geometry.spans.map(s=>s.wall))];
    const groups=walls.map(wall=>cells.filter(c=>c.wall===wall).map(c=>({...c,lambda:0})));
    const packed=new Float64Array(groups.flat().flatMap(c=>[...c.s,...c.t,c.ds]));
    const pairs=input.vehicles*(input.vehicles-1)/2;
    cached={geometry,walls,groups,packed,pairXY:new Float64Array(pairs*4),out:new Float64Array(pairs*cells.length)};
    previousKey=key;
  }
  const {geometry,walls,groups,packed,pairXY,out}=cached;
  const frames=[];
  for(let t=start;t<=end;t++) {
    const p=truePoses(t,input.vehicles,geometry.wallModel), configs=[];
    let pair=0;
    for(let i=0;i<p.length;i++) for(let j=i+1;j<p.length;j++) pairXY.set([...p[i],...p[j]],4*pair++);
    const scatter=input.roughness>0 && input.lambda0>0;
    if(scatter) weights(packed,pairXY,input.roughness*Math.PI/180,input.lambda0,out);
    let k=0;
    for(let i=0;i<p.length;i++) for(let j=i+1;j<p.length;j++) {
      const spec=specularPoints(geometry.spans,p[i],p[j]), diffuse=[], lambdaTotal=[0,0];
      const diffuseSampling={beforeThinning:[0,0],afterThinning:[0,0]};
      if(scatter) for(const [index,cells] of groups.entries()) {
        const wall=walls[index]; let total=0;
        for(const cell of cells) { cell.lambda=out[k++]; total+=cell.lambda; }
        lambdaTotal[wall]=total;
        const diagnostics={}, points=sampleDiffuse(geometry.spans,p[i],p[j],{cells,lambdaTotal},createRng(input.seed,'diffuse',t,i+1,j+1,wall),diagnostics);
        diffuseSampling.beforeThinning[wall]=diagnostics.generated;
        diffuseSampling.afterThinning[wall]=points.length;
        for(const point of points) diffuse.push(point);
      }
      configs.push({i:i+1,j:j+1,specular:spec.slice(),diffuse,lambdaTotal,diffuseSampling,generated:{specular:spec.length,diffuse:diffuse.length},numericalDiagnostics:spec.diagnostics});
    }
    const physical={t,p,configs};
    frames.push(physicalOnly ? physical : measureTruthSnapshot(input,physical));
  }
  return {start,end,frames,...(start===1?{geometry}:{} )};
}
