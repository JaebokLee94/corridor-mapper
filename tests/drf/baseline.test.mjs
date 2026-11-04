import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Baseline,predictFragment,gaussianEvidence,duplicateFragment} from '../../drf/baseline.mjs';
import {METHOD_PROTOCOL,selectGuarded,MethodComparison} from '../../drf/comparison.mjs';
const fixtures=JSON.parse(fs.readFileSync(new URL('./pspt-reference.json',import.meta.url))),reference=JSON.parse(fs.readFileSync(new URL('./baseline-reference.json',import.meta.url)));
const close=(a,b,label,tol=1e-7)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${label}: ${a} != ${b}`);

test('B agrees with independent frozen Python checkpoints, including expiration and qualified peak selection',()=>{
  const full=process.env.PSPT_FULL_PARITY==='1';
  for(const one of reference.cases.slice(0,full?3:1)) {
    const wire=fixtures.cases.find(c=>c.caseId===one.caseId).wire,checks=new Map(one.checks.map(c=>[c.t,c.rows])),est=new Baseline();
    for(const snapshot of wire.slice(0,full?120:30)) {
      const rows=est.step(snapshot);if(!checks.has(snapshot.t))continue;
      const expected=checks.get(snapshot.t);assert.equal(rows.length,expected.length,`${one.caseId} t=${snapshot.t} count`);
      for(const [i,row] of expected.entries()) {
        const p=rows[i];assert.equal(p.id,`b${row[0]}`);assert.equal(p.birth,row[7]);assert.equal(p.n_matched,row[9]);
        const actual=[...p.center,p.phi,p.ell,p.kappa,p.sg];
        actual.forEach((v,k)=>close(k===2 ? Math.atan2(Math.sin(2*(v-row[k+1])),Math.cos(2*(v-row[k+1])))/2 : v,k===2 ? 0 : row[k+1],`${one.caseId}/${snapshot.t}/${i}/piece${k}`));
        close(p.logit,row[8],`${one.caseId}/${snapshot.t}/${i}/logit`);
        if(row[10]===null)assert.equal(p.selectionLogit,-Infinity);else close(p.selectionLogit,row[10],`${i}/peak`);
        assert.equal(p.status,row[10]!==null && row[10]>=12?'supported':'pending');
      }
    }
  }
});
test('mirror prediction matches an analytic flat-wall path and projected pose variance',()=>{
  const link={pHat_i:[-1,2],pHat_j:[1,2],Sigma_i:[.04,0,.09],Sigma_j:[.04,0,.09],paths:[]};
  const p=predictFragment([0,0,0,2,0,1],link,.1);assert.equal(p.valid,true);
  p.hit.forEach(x=>close(x,0,'specular point'));close(p.range,2*Math.sqrt(5),'range');close(p.sigma**2,.01+2*(.04/5+4*.09/5),'variance');
  assert.equal(predictFragment([5,0,0,1,0,1],link).valid,false);
});
test('Gaussian sharing conserves each echo and an analytic missed detection contributes log(.05)',()=>{
  const p=[0,0,0,2,0,1],link={i:0,j:1,pHat_i:[-1,2],pHat_j:[1,2],Sigma_i:[0,0,0],Sigma_j:[0,0,0],paths:[{dHat:2*Math.sqrt(5),sigmaD:.1}]};
  const {increments,matched}=gaussianEvidence([p,p],{configs:[link]});
  const expected=Math.log(.05+.95*.5/(Math.sqrt(2*Math.PI)*.1)/.025);
  increments.forEach(x=>close(x,expected,'shared Gaussian'));assert.deepEqual([...matched],[1,1]);
  close(gaussianEvidence([p],{configs:[{...link,paths:[]}]}).increments[0],Math.log(.05),'miss');
});
test('B rejects truth, future, nonconsecutive time and wrong noise before mutation',()=>{
  const est=new Baseline(),snapshot=fixtures.cases[0].wire[0],before=JSON.stringify(est);
  for(const bad of [{...snapshot,truth:[]},{...snapshot,t:2},{...snapshot,future:[]}]) {
    assert.throws(()=>est.step(bad));assert.equal(JSON.stringify(est),before);
  }
  const wrong=structuredClone(snapshot);wrong.configs[0].paths[0].sigmaD=.2;
  assert.throws(()=>est.step(wrong));assert.equal(JSON.stringify(est),before);
  const first=est.step(snapshot),saved=JSON.stringify(first);
  assert.ok(first.every(c=>c.logit===0&&!c.eligible&&c.status==='pending'),'birth data never scores its own candidate');
  est.step(fixtures.cases[0].wire[1]);assert.equal(JSON.stringify(first),saved);
});
test('B duplicate gate is symmetric and respects orientation modulo pi',()=>{
  const a=[0,0,0,1,0,1],b=[.2,0,Math.PI,1,0,1];assert.equal(duplicateFragment(a,b),true);assert.equal(duplicateFragment(b,a),true);
  assert.equal(duplicateFragment(a,[0,0,Math.PI/2,1,0,1]),false);
});
test('development thresholds do not imply calibration; guarded selection stays finite after sigmoid saturation',()=>{
  assert.equal(METHOD_PROTOCOL.guarded.calibrated,false);assert.equal(METHOD_PROTOCOL.baseline.threshold,29.108623616301394);
  const g={gid:0,L:[-100,100,-100,100],nobs:2,qualified_active:[2,0],qualified_matched:[2,0]};
  const rows=selectGuarded({groups:[g]},[0,1].map(k=>({gid:0,side:k,status:'pending'})));
  close(rows[0].selectionLogit,200,'finite log score');assert.equal(rows[0].status,'supported');assert.equal(rows[1].status,'pending');
});


test('comparison applies the tuning gate to B without changing its qualified score history',()=>{
  const comparison=new MethodComparison();
  comparison.baseline.all=[{id:0,piece:[0,0,0,1,0,1],birth:0,logit:20,bestLogit:20,matches:2,lastScored:1}];
  comparison.baseline.active=[];
  comparison.guarded.step=()=>[];
  const wire={t:1,configs:[{i:0,j:1,pHat_i:[0,2],pHat_j:[1,2],Sigma_i:[0,0,0],Sigma_j:[0,0,0],paths:[]}]};
  const rows=comparison.step(wire).baseline.candidates;
  assert.equal(rows[0].selectionLogit,20);assert.equal(rows[0].status,'pending');
  assert.equal(comparison.baseline.report(12)[0].status,'supported','old gate would select the same score');
});

test('guarded selection uses the tuning breakpoint, including equality',()=>{
  for (const [score,status] of [[6.5,'pending'],[METHOD_PROTOCOL.guarded.threshold,'supported']]) {
    const g={gid:0,L:[0,score,0,score],nobs:2,qualified_active:[2,0],qualified_matched:[2,0]};
    const [row]=selectGuarded({groups:[g]},[{gid:0,side:0,status:'pending'}]);
    close(row.selectionLogit,score,'marginal log odds');assert.equal(row.status,status);
  }
});

test('comparison explanations follow its log-score threshold, not the reference weight gate',()=>{
  const g={gid:0,L:[0,6.5,0,6.5],nobs:2,qualified_active:[2,2],qualified_matched:[2,1]};
  const oldReason='composite score and local evidence requirements passed';
  const rows=selectGuarded({groups:[g]},[0,1].map(side=>({gid:0,side,status:'supported',reason:oldReason})));
  assert.equal(rows[0].status,'pending');
  assert.equal(rows[0].reason,'current log-score below the fixed selection threshold');
  assert.equal(rows[0].originalReason,oldReason);
  assert.equal(rows[1].reason,'fewer than two own-patch range matches');
});

test('live comparison declares shared-pose refinement without retuning thresholds',()=>{
  const comparison=new MethodComparison();
  assert.equal(comparison.guarded.refinement,'shared-pose');
  assert.equal(comparison.guarded.clustering,'bounded-span');
  assert.equal(METHOD_PROTOCOL.guarded.refinement,'shared-pose');
  assert.match(METHOD_PROTOCOL.guarded.thresholdStatus,/not retuned/);
  assert.equal(METHOD_PROTOCOL.guarded.threshold,6.650397183049193);
});


test('published tuning provenance matches the exact runtime thresholds and dataset role',()=>{
  const record=JSON.parse(fs.readFileSync(new URL('../../validation/threshold-tuning-20261020.json',import.meta.url)));
  for (const method of ['guarded','baseline']) {
    const protocol=METHOD_PROTOCOL[method];
    assert.equal(protocol.threshold,record.methods[method].selected.logit);
    assert.equal(protocol.tuning.scenes,record.n_scenes);
    assert.equal(protocol.tuning.sigmaP,record.generator.sigmaP);
    assert.deepEqual(protocol.tuning.seedRangeInclusive,record.seed_range_inclusive);
    assert.equal(record.methods[method].joint_target_operating_points,0);
    assert.equal(protocol.tuning.certified,false);
  }
});
