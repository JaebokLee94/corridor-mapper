import test from 'node:test';
import assert from 'node:assert/strict';
import {curvatureConsistentUpdate,CURVATURE_INNOVATION_LIMIT} from '../../drf/pspt-curvature.mjs';
import {dot,matVec,matMul,transpose,solve} from '../../drf/pspt-math.mjs';

const close=(x,y)=>assert.ok(Math.abs(x-y)<1e-11*Math.max(1,Math.abs(y)),`${x} != ${y}`),
  identity=()=>[[1,0,0],[0,1,0],[0,0,1]],zero=[[0,0],[0,0]];
const comp=(residual,H=[1,1,1],variance=1)=>[{i:0,j:1,Si:zero,Sj:zero},1,variance,residual,[0,0,H,[1,0],[0,1]]];

function legacy(s,comps) {
  const M=comps.length,A=comps.map(cm=>cm[4][2]),residual=comps.map(cm=>cm[3]),
    R=Array.from({length:M},(_,i)=>Array.from({length:M},(_,j)=>i===j?comps[i][2]/comps[i][1]:0));
  for(let a=0;a<M;a++)for(let b=0;b<M;b++){
    const [ca,,,,pa]=comps[a],[cb,,,,pb]=comps[b];
    for(const [va,ea,covariance]of[[ca.i,pa[3],ca.Si],[ca.j,pa[4],ca.Sj]])
      for(const[vb,eb]of[[cb.i,pb[3]],[cb.j,pb[4]]])if(va===vb)R[a][b]+=dot(ea,matVec(covariance,eb));
  }
  const AP=matMul(A,s.P),S=matMul(AP,transpose(A)).map((row,i)=>row.map((v,j)=>v+R[i][j])),
    gain=transpose(solve(S,AP)),delta=matVec(gain,residual),KA=matMul(gain,A);
  s.x=s.x.map((value,i)=>value+delta[i]);
  s.P=matMul(KA.map((row,i)=>row.map((value,j)=>Number(i===j)-value)),s.P);
}

function checkPSD(P) {
  // Principal minors characterize a symmetric 3x3 positive-semidefinite matrix.
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)close(P[i][j],P[j][i]);
  for(let i=0;i<3;i++)assert.ok(P[i][i]>=-1e-12);
  for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)assert.ok(P[i][i]*P[j][j]-P[i][j]**2>=-1e-12);
  const d=P[0][0]*(P[1][1]*P[2][2]-P[1][2]*P[2][1])-P[0][1]*(P[1][0]*P[2][2]-P[1][2]*P[2][0])+P[0][2]*(P[1][0]*P[2][1]-P[1][1]*P[2][0]);
  assert.ok(d>=-1e-12);
}

test('independent linear Gaussian result and nominal statistic are analytic',()=>{
  // P=I, H=[1,1,1], R=1: S=4, K=[1/4,1/4,1/4]', q=y²/4.
  const s={x:[0,0,0],P:identity()},r=curvatureConsistentUpdate(s,[comp(2)]);
  assert.equal(r.guarded,false);close(r.statistic,1);close(r.curvatureInnovationVariance,.25);
  assert.deepEqual(s.x,[.5,.5,.5]);assert.deepEqual(s.P,[[.75,-.25,-.25],[-.25,.75,-.25],[-.25,-.25,.75]]);
});

test('only surprising curvature is frozen; centre, angle and cross terms remain correct',()=>{
  // y=8 -> q=16>10.827566, masked K=[1/4,1/4,0]'.
  const s={x:[0,0,0],P:identity()},r=curvatureConsistentUpdate(s,[comp(8)]);
  assert.equal(r.guarded,true);close(r.statistic,16);assert.deepEqual(s.x,[2,2,0]);
  assert.deepEqual(s.P,[[.75,-.25,-.25],[-.25,.75,-.25],[-.25,-.25,1]]);checkPSD(s.P);
});

test('fixed significance boundary is tested with analytically chosen linear residuals',()=>{
  for(const factor of [.999,1.001]){
    const s={x:[0,0,0],P:identity()},y=Math.sqrt(4*CURVATURE_INNOVATION_LIMIT*factor),r=curvatureConsistentUpdate(s,[comp(y)]);
    close(r.statistic,CURVATURE_INNOVATION_LIMIT*factor);assert.equal(r.guarded,factor>1);
  }
});

test('zero curvature information does not block a centre correction',()=>{
  const s={x:[0,0,.4],P:identity()},r=curvatureConsistentUpdate(s,[comp(100,[1,0,0])]);
  assert.equal(r.guarded,false);close(r.statistic,0);close(s.x[0],50);close(s.x[2],.4);close(s.P[2][2],1);
});

test('non-guarded path preserves legacy float64 operations for correlated configurations',()=>{
  for(let k=1;k<=32;k++){
    const B=[[.3+k/100,.04,-.02],[0,.3,.03],[0,0,.2]],P=matMul(B,transpose(B)),
      initial={x:[.1,.2,.03],P},a=structuredClone(initial),b=structuredClone(initial),
      comps=Array.from({length:4},(_,i)=>{
        const c=comp((i-1.5)*.0001,[1+i/10,-.2+i/7,.1+i/9],.01);
        c[0]={i:0,j:i+1,Si:[[.01,.002],[.002,.02]],Sj:[[.02,0],[0,.01]]};c[1]=i+1;return c;
      });
    const r=curvatureConsistentUpdate(a,comps);legacy(b,comps);
    assert.equal(r.guarded,false);assert.deepEqual(a,b);
  }
});

test('guarded Joseph update preserves PSD and the frozen marginal variance under correlation',()=>{
  const B=[[.7,.1,.2],[0,.5,-.1],[0,0,.3]],P=matMul(B,transpose(B)),
    s={x:[.1,.2,.03],P:structuredClone(P)},comps=[comp(50,[1,.5,1]),comp(-30,[-.3,1,.5])],
    ordinary=structuredClone(s);
  legacy(ordinary,comps);const r=curvatureConsistentUpdate(s,comps);
  assert.equal(r.guarded,true);close(s.x[0],ordinary.x[0]);close(s.x[1],ordinary.x[1]);close(s.x[2],.03);
  close(s.P[2][2],P[2][2]);assert.notDeepEqual(s.P[2].slice(0,2),P[2].slice(0,2));checkPSD(s.P);
});

test('curvature statistic and decision are invariant to curvature-coordinate units',()=>{
  const a={x:[0,0,0],P:identity()},b={x:[0,0,0],P:[[1,0,0],[0,1,0],[0,0,100]]},
    ra=curvatureConsistentUpdate(a,[comp(8)]),rb=curvatureConsistentUpdate(b,[comp(8,[1,1,.1])]);
  close(ra.statistic,rb.statistic);assert.equal(ra.guarded,rb.guarded);
  close(a.x[0],b.x[0]);close(a.x[1],b.x[1]);close(a.P[2][2]*100,b.P[2][2]);close(a.P[0][2]*10,b.P[0][2]);
});

test('no measurements leave state and covariance unchanged',()=>{
  const s={x:[.1,.2,.3],P:identity()},before=structuredClone(s);
  assert.equal(curvatureConsistentUpdate(s,[]).matches,0);assert.deepEqual(s,before);
});
