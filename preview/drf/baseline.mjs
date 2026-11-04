/** Method B: fixed straight fragments with causal Gaussian evidence.
 * Port of the 2026-10-20 Python baseline.py, Config defaults retained.
 * Input: measured wire at one t and declared range SD [m]; no truth or future.
 * Output: all fragments born by t, immutable geometry [m, rad, m^-1], live log
 * score and the largest score after >=2 matching snapshots seen so far.
 * A fragment is scored only at birth < t <= birth+20; regeneration cooldown=5.
 * Work O(G*returns + active*returns + proposals*retained); memory O(G+all+active
 * + max link edges). A link's temporary arrays are released before the next.
 * At sigmaR=.1 this is the frozen experiment. Other sigmaR values explicitly
 * substitute the declared range SD into the same Gaussian measurement model.
 */
import { DRF } from './pspt-ridges.mjs';
import { prepareMeasuredSnapshot } from './pspt.mjs';
import { eigen2 } from './pspt-math.mjs';

export const BASELINE_CONFIG = Object.freeze({ life:20, cooldown:5, dNms:.75,
  thetaNms:Math.PI/12, overlapNms:.5, zGate:3, pd:.95, clutter:.025,
  minMatches:2, halfLength:1, ridgeFraction:.15, ridgeSeparation:1.5, mirrorRatio:.1 });
const dot = (a,b) => a[0]*b[0]+a[1]*b[1];
const variance = (v,S) => v[0]*v[0]*S[0]+2*v[0]*v[1]*S[1]+v[1]*v[1]*S[2];
const sigmoid = x => x >= 0 ? 1/(1+Math.exp(-x)) : Math.exp(x)/(1+Math.exp(x));

export function duplicateFragment(a,b) {
  const c=BASELINE_CONFIG;
  if (Math.hypot(a[0]-b[0],a[1]-b[1]) >= c.dNms) return false;
  const angle=Math.abs(Math.atan2(Math.sin(2*(a[2]-b[2])),Math.cos(2*(a[2]-b[2])))/2);
  if (angle>=c.thetaNms) return false;
  for (const [p,q] of [[a,b],[b,a]]) {
    const offset=(q[0]-p[0])*Math.cos(p[2])+(q[1]-p[1])*Math.sin(p[2]),radius=q[3]*Math.abs(Math.cos(p[2]-q[2]));
    const overlap=Math.max(0,Math.min(p[3],offset+radius)-Math.max(-p[3],offset-radius));
    if (overlap/(2*Math.min(p[3],q[3]))<=c.overlapNms) return false;
  }
  return true;
}

/** Mirror-Tx line intersection; variance=J diag(Si,Sj) J'. O(1), Float64. */
export function predictFragment(piece,link,sigmaR=.1) {
  const [x,y,phi,h]=piece,tangent=[Math.cos(phi),Math.sin(phi)],normal=[-tangent[1],tangent[0]],pi=link.pHat_i,pj=link.pHat_j;
  const di=dot([pi[0]-x,pi[1]-y],normal),dj=dot([pj[0]-x,pj[1]-y],normal),ratio=di+dj===0 ? 0 : di/(di+dj);
  const mirror=[pi[0]-2*di*normal[0],pi[1]-2*di*normal[1]],hit=mirror.map((v,k)=>v+ratio*(pj[k]-v));
  const vi=pi.map((v,k)=>v-hit[k]),vj=pj.map((v,k)=>v-hit[k]),ri=Math.hypot(...vi),rj=Math.hypot(...vj);
  const ui=vi.map(v=>ri ? v/ri : 0),uj=vj.map(v=>rj ? v/rj : 0);
  return {valid:di*dj>0 && Math.abs(dot([hit[0]-x,hit[1]-y],tangent))<=h+1e-12,
    hit,range:ri+rj,sigma:Math.sqrt(sigmaR**2+variance(ui,link.Sigma_i)+variance(uj,link.Sigma_j))};
}

/** For each echo: a=g/sum_candidates(g); b=a/max(1,sum_echoes_in_link(a)).
 * Delta log score = sum_valid_links log(.05 + .95*sum_echoes(b*g)/.025).
 * Zero-density echoes carry zero assignment; misses penalize valid links only.
 */
export function gaussianEvidence(pieces,snapshot,sigmaR=.1) {
  const n=pieces.length,increments=new Float64Array(n),matched=new Uint8Array(n),c=BASELINE_CONFIG;
  for (const link of snapshot.configs) {
    const predictions=pieces.map(p=>predictFragment(p,link,sigmaR)),edges=[],totals=new Float64Array(n),evidence=new Float64Array(n);
    for (const path of link.paths) {
      const echo=[]; let sum=0;
      for (let i=0;i<n;i++) {
        const p=predictions[i],z=(path.dHat-p.range)/p.sigma;
        if (!p.valid || Math.abs(z)>c.zGate) continue;
        const g=Math.exp(-z*z/2)/(Math.sqrt(2*Math.PI)*p.sigma);
        if (g>0) {echo.push([i,g]);sum+=g;matched[i]=1;}
      }
      for (const [i,g] of echo) {const a=g/sum;edges.push([i,g,a]);totals[i]+=a;}
    }
    for (const [i,g,a] of edges) evidence[i]+=a/Math.max(1,totals[i])*g;
    for (let i=0;i<n;i++) if (predictions[i].valid) increments[i]+=Math.log(1-c.pd+c.pd*evidence[i]/c.clutter);
  }
  return {increments,matched};
}

export class Baseline {
  constructor({sigmaR=.1}={}) {
    if (!Number.isFinite(sigmaR) || sigmaR<=0) throw new RangeError('Method B requires sigmaR > 0');
    this.sigmaR=sigmaR;this.field=new DRF();this.active=[];this.expired=[];this.all=[];this.lastT=0;
  }
  step(snapshot, threshold=12) {
    const {wire}=prepareMeasuredSnapshot(snapshot),t=wire.t,c=BASELINE_CONFIG;
    if (t!==this.lastT+1) throw new RangeError('snapshots must be consecutive from t=1');
    for (const link of wire.configs) for (const p of link.paths)
      if (Math.abs(p.sigmaD-this.sigmaR)>1e-12) throw new RangeError('Method B requires the declared uniform range SD');
    this.lastT=t;this.expired=this.expired.filter(p=>t<=p.birth+c.life+c.cooldown);
    const still=[];
    for (const p of this.active) (t>p.birth+c.life ? this.expired : still).push(p);
    this.active=still;
    if (still.length) {
      const {increments,matched}=gaussianEvidence(still.map(p=>p.piece),wire,this.sigmaR);
      still.forEach((p,i)=>{p.logit+=increments[i];p.matches+=matched[i];p.lastScored=t;
        if (p.matches>=c.minMatches) p.bestLogit=Math.max(p.bestLogit,p.logit);});
    }
    this.field.update(wire);
    const vehicles=new Map();
    for (const l of wire.configs) {vehicles.set(l.i,l.pHat_i);vehicles.set(l.j,l.pHat_j);}
    const xy=[...vehicles.values()],center=[0,1].map(k=>xy.reduce((s,p)=>s+p[k],0)/xy.length),z=xy.map(p=>p.map((v,k)=>v-center[k]));
    const eig=eigen2(z.reduce((s,p)=>s+p[0]**2,0),z.reduce((s,p)=>s+p[0]*p[1],0),z.reduce((s,p)=>s+p[1]**2,0));
    const mirror=Math.sqrt(Math.max(eig.values[0],0)/Math.max(eig.values[1],1e-30))<=c.mirrorRatio,axis=eig.vectors[1],angle=Math.atan2(axis[1],axis[0]);
    const proposals=this.field.ridges({frac:c.ridgeFraction,sep:c.ridgeSeparation,xwin:[Math.min(...xy.map(p=>p[0]))-5,Math.max(...xy.map(p=>p[0]))+10]});
    for (const [x,y,phi] of proposals) {
      const options=[[x,y,phi,c.halfLength,0,1]];
      if (mirror) {const d=[x-center[0],y-center[1]],projection=dot(axis,d);
        options.push([center[0]+2*projection*axis[0]-d[0],center[1]+2*projection*axis[1]-d[1],2*angle-phi,c.halfLength,0,1]);}
      for (const p of options) {
        if ([...this.active,...this.expired].some(q=>duplicateFragment(p,q.piece))) continue;
        const candidate={id:this.all.length,piece:p,birth:t,logit:0,bestLogit:-Infinity,matches:0,lastScored:null};
        this.all.push(candidate);this.active.push(candidate);
      }
    }
    return this.report(threshold);
  }
  // The default preserves the archived Python checkpoints; the web comparison
  // always supplies its explicitly versioned tuning threshold.
  report(threshold=12) {
    return this.all.map(p=>({id:`b${p.id}`,center:p.piece.slice(0,2),phi:p.piece[2],ell:p.piece[3],kappa:0,sg:1,
      birth:p.birth,checkedThrough:this.lastT,lastScored:p.lastScored,logit:p.logit,selectionLogit:p.bestLogit,
      eligible:p.matches>=BASELINE_CONFIG.minMatches,score:sigmoid(p.bestLogit),score_kind:'uncalibrated_peak_gaussian_score',
      status:p.bestLogit>=threshold ? 'supported' : 'pending',n_matched:p.matches,
      lifecycle:this.lastT<=p.birth+BASELINE_CONFIG.life ? 'active' : 'expired',
      reason:p.bestLogit>=threshold ? 'Past qualified score crossed the fixed development threshold' : 'No qualified threshold crossing yet'}));
  }
}
