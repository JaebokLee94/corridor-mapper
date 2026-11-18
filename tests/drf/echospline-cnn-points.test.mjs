import test from 'node:test';
import assert from 'node:assert/strict';
import {EchoSpline} from '../../drf/echospline.mjs';

test('short-window CNN evidence recovers the tangent of a known steep reflector',()=>{
  const model=new EchoSpline({domain:[-50,100],upper:true});
  const slope=4,height=30,norm=Math.hypot(slope,1),normal=[-slope/norm,1/norm];
  for(let t=1;t<=15;t++){
    const a=[t,-50],b=[t+1,-50],distance=(a[1]-slope*a[0]-height)/norm;
    const reflected=a.map((v,k)=>v-2*distance*normal[k]);
    const range=Math.hypot(reflected[0]-b[0],reflected[1]-b[1]);
    model.observe({t,configs:[{i:1,j:2,pHat_i:a,pHat_j:b,Sigma_i:[0,0,0],Sigma_j:[0,0,0],paths:[{dHat:range,sigmaD:.4}]}]});
  }
  const before=JSON.stringify(model.tracks),scales=model.cnnPoints(1);
  for(const points of scales){
    assert.equal(points.length,15);
    for(const [x,y,s] of points){
      assert.ok(Math.abs(y-slope*x-height)/norm<.02);
      assert.ok(Math.abs(s-slope)<.03);
    }
  }
  assert.equal(JSON.stringify(model.tracks),before);
});
