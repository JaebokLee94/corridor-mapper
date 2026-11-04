import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PSPT } from '../../drf/pspt.mjs';
import { refine, sharedPoseNormalEquations, solve, dot, matVec } from '../../drf/pspt-math.mjs';

const close = (actual, expected, tolerance = 1e-10) => assert.ok(
  Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const diagonal = v => [[v,0,0],[0,1,0],[0,0,1]];
function linearSurface() {
  return { P0: diagonal(1), P: diagonal(1), x: [0,0,0], x0: [0,0,0],
    predict() { return [this.x[0],0,[1,0,0],[1,0],[0,0]]; } };
}
function linearConfigs(shared, variance = .25) {
  return [0,1].map(k => ({ i: shared ? 0 : k*2, j: shared ? k+1 : k*2+1,
    pi: [0,0], pj: [1,0], Si: [[variance,0],[0,0]], Sj: [[0,0],[0,0]], sr2: .01, cl: [[.1,1,0]] }));
}

test('shared-pose birth refinement matches an independently derived correlated Gaussian posterior', () => {
  // Prior N(0,1); H=[1;1], y=[.1;.1], R=.01 I+.25 11'.
  // Posterior variance=.51/2.51 and mean=.2/2.51, without numerical reference code.
  const surface = linearSurface();
  assert.equal(refine(surface,[linearConfigs(true)],{iters:1,refinement:'shared-pose'}),2);
  close(surface.P[0][0],.51/2.51);
  close(surface.x[0],.2/2.51);
  const independent = linearSurface();
  refine(independent,[linearConfigs(true)],{iters:1,refinement:'independent-pairs'});
  close(independent.P[0][0],.26/2.26);
  assert.ok(surface.P[0][0] > independent.P[0][0]);
});

test('shared-pose correction vanishes for disjoint vehicles or zero pose uncertainty', () => {
  for (const [shared,variance] of [[false,.25],[true,0]]) {
    const a=linearSurface(),b=linearSurface(),configs=[linearConfigs(shared,variance)];
    refine(a,configs,{iters:1,refinement:'shared-pose'});
    refine(b,configs,{iters:1,refinement:'independent-pairs'});
    a.P.flat().forEach((value,i)=>close(value,b.P.flat()[i]));
    a.x.forEach((value,i)=>close(value,b.x[i]));
  }
});

// A dense observation-space GLS calculation is a separate reference for the
// pose-space Woodbury implementation. It is used only in this bounded test.
function denseNormalEquations(matches) {
  const M=matches.length,R=matches.map((m,i)=>matches.map((_,j)=>i===j?m.rangeVariance:0));
  for (let a=0;a<M;a++) for (let b=0;b<M;b++) {
    const u=matches[a],v=matches[b];
    for (const [i,e,S] of [[u.config.i,u.ei,u.config.Si],[u.config.j,u.ej,u.config.Sj]])
      for (const [j,f] of [[v.config.i,v.ei],[v.config.j,v.ej]]) if(i===j) R[a][b]+=dot(e,matVec(S,f));
  }
  const X=solve(R,matches.map(m=>[...m.derivative,m.residual]));
  const H=Array.from({length:3},()=>[0,0,0]),b=[0,0,0];
  for(let a=0;a<M;a++)for(let i=0;i<3;i++) {
    b[i]+=matches[a].derivative[i]*X[a][3];
    for(let j=0;j<3;j++)H[i][j]+=matches[a].derivative[i]*X[a][j];
  }
  return {H,b};
}

test('pose-space Woodbury matches dense GLS for 2–20 vehicles and singular PSD covariances', () => {
  let seed=0x4ea472f1;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const direction=()=>{const a=random()*2*Math.PI;return [Math.cos(a),Math.sin(a)];};
  for(const V of [2,3,10,20]) for(const mode of ['zero','rank1','full']) for(let run=0;run<8;run++) {
    const cov=Array.from({length:V},()=>{
      const a=.2*random(),b=.2*(random()-.5),c=.2*random();
      return mode==='zero'?[[0,0],[0,0]]:mode==='rank1'?[[a*a,a*b],[a*b,b*b]]:[[a*a,a*b],[a*b,b*b+c*c]];
    });
    const matches=[];
    for(let i=0;i<V;i++)for(let j=i+1;j<V;j++)matches.push({
      config:{i,j,Si:cov[i],Sj:cov[j]}, derivative:[random()*4-2,random()*4-2,random()*4-2],
      ei:direction(),ej:direction(),rangeVariance:10**(-4+3*random()),residual:random()-.5 });
    const actual=sharedPoseNormalEquations(matches),expected=denseNormalEquations(matches);
    actual.H.flat().forEach((value,i)=>close(value,expected.H.flat()[i],1e-8));
    actual.b.forEach((value,i)=>close(value,expected.b[i],1e-8));
  }
});

test('pose-space normal equations retain information when range noise is tiny', () => {
  for (const variance of [1e-8,1e-12,1e-20]) {
    const matches = [1,2].map(j=>({ config:{i:0,j,Si:[[.25,0],[0,0]],Sj:[[0,0],[0,0]]},
      derivative:[1,0,0],ei:[1,0],ej:[0,0],rangeVariance:variance,residual:.1 }));
    // Common-mode information is 2/(r+2q), even as independent noise tends to zero.
    const normal=sharedPoseNormalEquations(matches);
    close(normal.H[0][0],2/(variance+.5),1e-10);
    close(normal.b[0],.2/(variance+.5),1e-10);
  }
});

test('refinement modes are explicit and frozen default remains independent-pairs', () => {
  assert.equal(new PSPT().refinement,'independent-pairs');
  assert.equal(new PSPT({refinement:'shared-pose'}).refinement,'shared-pose');
  for(const refinement of ['',null,true,'legacy','shared']) {
    assert.throws(()=>new PSPT({refinement}),/refinement/);
    assert.throws(()=>refine(linearSurface(),[],{refinement}),/refinement/);
  }
});

test('shared-pose mode is causal and excludes birth-window evidence and truth fields', () => {
  const fixture=JSON.parse(fs.readFileSync(new URL('./pspt-reference.json',import.meta.url)));
  const wires=fixture.cases[0].wire.slice(0,8),prefix=new PSPT({refinement:'shared-pose'}),full=new PSPT({refinement:'shared-pose'});
  let prefixRows,fullPrefix;
  for(const wire of wires.slice(0,5))prefixRows=prefix.step(wire);
  for(const wire of wires) {
    const rows=full.step(wire);
    if(wire.t===5)fullPrefix=structuredClone(rows);
  }
  assert.deepEqual(prefixRows,fullPrefix,'future snapshots changed a completed prefix');
  assert.ok(full.groups.length>0);
  assert.ok(full.groups.every(g=>g.log.every(([t])=>t>g.birth)),'creation data reused as predictive evidence');
  const before=JSON.stringify(prefix),poisoned=structuredClone(wires[5]);
  let accessed=false;
  Object.defineProperty(poisoned,'truth',{enumerable:true,get(){accessed=true;throw Error('truth accessed');}});
  assert.throws(()=>prefix.step(poisoned),/non-wire/);
  assert.equal(accessed,false);
  assert.equal(JSON.stringify(prefix),before);
});
