import {ellipsePerimeter} from './field.mjs?v=20261118-device-selection';

// Measured configurations only; no scene geometry or evaluation labels.
// Reflection in y preserves range and horizontal normals for lower walls.
export function rangeConfiguration(configs,sign=1) {
  const rows=[],paths=[];
  const eigen=s=>(s[0]+s[2]+Math.hypot(s[0]-s[2],2*s[1]))/2;
  for(const c of configs){
    const focal=Math.hypot(c.pHat_i[0]-c.pHat_j[0],c.pHat_i[1]-c.pHat_j[1]);
    const admitted=c.paths.filter(p=>p.dHat>focal).sort((a,b)=>a.dHat-b.dHat);
    if(!admitted.length)continue;
    const start=paths.length/3;
    let variance=0;
    for(const p of admitted){
      paths.push(p.dHat,p.sigmaD**2,1/ellipsePerimeter(p.dHat,focal));
      variance=Math.max(variance,p.sigmaD**2);
    }
    // Ten standard deviations omit at most exp(-50) per Gaussian kernel.
    const radius=10*Math.sqrt(Math.max(1e-12,variance+eigen(c.Sigma_i)+eigen(c.Sigma_j)));
    rows.push(c.pHat_i[0],sign*c.pHat_i[1],c.pHat_j[0],sign*c.pHat_j[1],
      c.Sigma_i[0],sign*c.Sigma_i[1],c.Sigma_i[2],c.Sigma_j[0],sign*c.Sigma_j[1],c.Sigma_j[2],
      start,admitted.length,radius);
  }
  return {configs:Float32Array.from(rows),paths:Float32Array.from(paths)};
}

// Output [81*N,3]: log density (three-link reference), normal-x mean and second moment.
// Keep canonical WASM features: GPU transcendental rounding can cross FP16 bins
// and change the discrete wall path even when individual feature errors are small.
export function splineRangeImage(rt,x,anchor,configs,links,sign=1) {
  const n=x.length,xy=new Float32Array(81*n*2),packed=rangeConfiguration(configs,sign);
  for(let z=0;z<81;z++)for(let j=0;j<n;j++){
    const k=2*(z*n+j);xy[k]=x[j];xy[k+1]=(Number.isFinite(anchor[j])?anchor[j]:0)+(z-40)*.4;
  }
  const result=rt.call('rangeVotes',[xy,packed.configs,packed.paths],81*n*3,[81*n,packed.configs.length/13,links]);
  for(let j=0;j<n;j++)if(!Number.isFinite(anchor[j]))for(let z=0;z<81;z++)result.fill(0,3*(z*n+j),3*(z*n+j)+3);
  return result;
}
