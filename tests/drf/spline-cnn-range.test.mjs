import test from 'node:test';
import assert from 'node:assert/strict';
import {neuralRuntime} from '../../drf/model-runtime.mjs';
import {splineRangeImage} from '../../drf/spline-cnn-range.mjs';
import {pathFieldPoint} from '../../drf/field.mjs';

test('CNN range features agree with scalar ellipse likelihood and preserve measured inputs',async()=>{
  const rt=await neuralRuntime('spline-cnn');
  const configs=[{i:1,j:2,pHat_i:[-3,0],pHat_j:[3,0],Sigma_i:[.03,.005,.02],Sigma_j:[.02,-.003,.01],
    paths:[{dHat:21,sigmaD:.4},{dHat:10,sigmaD:.4},{dHat:2,sigmaD:.4}]}];
  const before=JSON.stringify(configs),x=[-1,0,1],anchor=[4,4,NaN];
  const output=splineRangeImage(rt,x,anchor,configs,3);
  for(const z of [0,30,39,40,41,55,80])for(let j=0;j<2;j++){
    const point=[x[j],anchor[j]+(z-40)*.4],c=configs[0];
    const mass=c.paths.reduce((sum,p)=>sum+pathFieldPoint(point,c,p).u,0);
    const a=point.map((v,k)=>v-c.pHat_i[k]),b=point.map((v,k)=>v-c.pHat_j[k]);
    const g=a.map((v,k)=>v/Math.hypot(...a)+b[k]/Math.hypot(...b)),nx=g[0]/Math.max(1e-9,Math.hypot(...g));
    const reference=[Math.log1p(mass),mass*nx/Math.max(1e-12,mass),mass*nx*nx/Math.max(1e-12,mass)];
    reference.forEach((v,k)=>assert.ok(Math.abs(output[3*(z*3+j)+k]-v)<2e-5,`${z},${j},${k}: ${output[3*(z*3+j)+k]} != ${v}`));
  }
  for(let z=0;z<81;z++)assert.deepEqual(Array.from(output.slice(3*(z*3+2),3*(z*3+3))),[0,0,0]);
  assert.equal(JSON.stringify(configs),before);
  const mirror=configs.map(c=>({...c,pHat_i:c.pHat_i.map((v,k)=>k?-v:v),pHat_j:c.pHat_j.map((v,k)=>k?-v:v),
    Sigma_i:[c.Sigma_i[0],-c.Sigma_i[1],c.Sigma_i[2]],Sigma_j:[c.Sigma_j[0],-c.Sigma_j[1],c.Sigma_j[2]]}));
  assert.deepEqual(splineRangeImage(rt,x,anchor,mirror,3,-1),output);
});

test('range kernel has the analytic circular-ellipse density and empty-prefix limit',async()=>{
  const rt=await neuralRuntime('spline-cnn');
  const c={i:1,j:2,pHat_i:[0,0],pHat_j:[0,0],Sigma_i:[0,0,0],Sigma_j:[0,0,0],paths:[{dHat:10,sigmaD:.4}]};
  const image=splineRangeImage(rt,[0],[5],[c],3),center=image.slice(40*3,41*3);
  assert.ok(Math.abs(center[0]-Math.log1p(2/(Math.sqrt(2*Math.PI)*.4*10*Math.PI)))<1e-7);
  assert.equal(center[1],0);assert.equal(center[2],0);
  assert.ok(splineRangeImage(rt,[0],[5],[],3).every(v=>v===0));
});
