import test from 'node:test';
import assert from 'node:assert/strict';
import {neuralRuntime} from '../../drf/model-runtime.mjs';
import {rangeConfiguration,splineRangeImage} from '../../drf/spline-cnn-range.mjs';
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

test('supported-column compaction exactly preserves the full-cell WASM range image',async()=>{
  const rt=await neuralRuntime('spline-cnn'),call=rt.call;
  const configs=[
    {pHat_i:[-3,1],pHat_j:[3,-2],Sigma_i:[.03,.005,.02],Sigma_j:[.02,-.003,.01],
      paths:[{dHat:21,sigmaD:.4},{dHat:10,sigmaD:.3},{dHat:2,sigmaD:.4}]},
    {pHat_i:[2,0],pHat_j:[2,0],Sigma_i:[0,0,0],Sigma_j:[0,0,0],paths:[{dHat:10,sigmaD:.4}]},
  ];
  const x=Float64Array.from([-2,-.2,0,.2,4]);
  for(const anchor of [[4,4,4,4,4],[NaN,4,NaN,5,NaN],[NaN,NaN,NaN,NaN,NaN]])for(const sign of [1,-1]){
    const packed=rangeConfiguration(configs,sign),xy=new Float32Array(81*x.length*2);
    for(let z=0;z<81;z++)for(let j=0;j<x.length;j++){
      const k=2*(z*x.length+j);xy[k]=x[j];xy[k+1]=(Number.isFinite(anchor[j])?anchor[j]:0)+(z-40)*.4;
    }
    const expected=call('rangeVotes',[xy,packed.configs,packed.paths],81*x.length*3,[81*x.length,packed.configs.length/13,3]);
    for(let j=0;j<x.length;j++)if(!Number.isFinite(anchor[j]))for(let z=0;z<81;z++)expected.fill(0,3*(z*x.length+j),3*(z*x.length+j)+3);
    const before=structuredClone({x,anchor,configs});let cells=0,raw;
    rt.call=(name,inputs,outputSize,params)=>{cells+=params[0];return raw=call(name,inputs,outputSize,params);};
    const actual=splineRangeImage(rt,x,anchor,configs,3,sign),supported=anchor.filter(Number.isFinite).length;
    assert.deepEqual(actual,expected);
    assert.equal(cells,81*supported,'only supported cells enter the range kernel');
    if(supported===x.length)assert.equal(actual,raw,'full support returns the kernel output without a copy');
    assert.deepEqual({x,anchor,configs},before);
  }
  assert.deepEqual(splineRangeImage(rt,[],[],configs,3),new Float32Array());
});
