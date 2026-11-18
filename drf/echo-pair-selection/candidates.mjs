import {chooseVehicles} from './choose.mjs';

export const featureNames = [
  'pair_count', 'fleet_size', 'snapshot', 'previous_overlap', 'active_fraction',
  'echo_fraction', 'echo_mean', 'echo_std', 'history_active_fraction', 'history_echo_mean',
  'history_range_rate_mean', 'baseline_mean', 'baseline_std', 'baseline_min', 'baseline_max',
  'midpoint_x_span', 'midpoint_y_span', 'midpoint_x_std', 'midpoint_y_std',
  'direction_dispersion', 'endpoint_fraction', 'range_mean', 'range_std',
  'range_spread_mean', 'range_baseline_ratio', 'current_history_echo_ratio',
];
const average = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0;
const deviation = values => {
  const mean=average(values);
  return Math.sqrt(average(values.map(v=>(v-mean)**2)));
};
const span = values => Math.max(...values)-Math.min(...values);
const EMPTY=Object.freeze([]);

export function applySelection(wire,pairs) {
  if (!Array.isArray(pairs) || !pairs.length || pairs.length>10 ||
      new Set(pairs).size!==pairs.length || pairs.some(i=>!Number.isInteger(i)||i<0||i>=wire.configs.length)) {
    throw Error('Selection must contain 1 through 10 distinct current pair indices');
  }
  const selected=new Set(pairs);
  return {t:wire.t,configs:wire.configs.map((c,i)=>selected.has(i)||!c.paths.length?c:{...c,paths:EMPTY})};
}

function clique(configs,vertices) {
  const selected=new Set(vertices);
  return configs.flatMap((c,i)=>selected.has(c.i)&&selected.has(c.j)?[i]:[]);
}

function geometry(configs) {
  const vertices=new Map();
  for (const c of configs) {vertices.set(c.i,c.pHat_i);vertices.set(c.j,c.pHat_j);}
  const xy=[...vertices.values()];
  const scale=Math.max(1,Math.hypot(span(xy.map(p=>p[0])),span(xy.map(p=>p[1]))));
  const values=configs.map(c=>{
    const [x,y]=c.pHat_i,[u,v]=c.pHat_j,dx=u-x,dy=v-y,length=Math.hypot(dx,dy),den=length**2||1;
    return {length,mx:(x+u)/2,my:(y+v)/2,cos:(dx*dx-dy*dy)/den,sin:2*dx*dy/den,
      descriptor:[(x+u)*.5/scale,(y+v)*.5/scale,.4*(dx*dx-dy*dy)/den,.4*2*dx*dy/den,.4*length/scale]};
  });
  return {vertices,scale,values};
}

function diversityOrder(configs,g,historyCount) {
  const candidates=configs.map((c,i)=>({i,nearest:Infinity,score:historyCount[i]+c.paths.length+.01*g.values[i].length/g.scale}));
  const ordered=[];
  while (candidates.length && ordered.length<10) {
    let at=0;
    for (let j=1;j<candidates.length;j++) if (candidates[j].score>candidates[at].score) at=j;
    const chosen=candidates.splice(at,1)[0], point=g.values[chosen.i].descriptor;
    ordered.push(chosen.i);
    for (const c of candidates) {
      const v=g.values[c.i].descriptor;
      c.nearest=Math.min(c.nearest,v.reduce((sum,x,j)=>sum+(x-point[j])**2,0));
      c.score=c.nearest;
    }
  }
  return ordered;
}

/** Causal feature state uses only ten most recent noisy wires. O(P) storage for each of ten frames. */
export function createContext(fleet) {
  let latest,keys,firstOrder,rightOrder;
  const history=[];
  function observe(wire) {
    if (wire.t!==(latest?.t??0)+1) throw Error('Pair context requires consecutive snapshots');
    const currentKeys=wire.configs.map(c=>c.i+','+c.j);
    if (keys && (keys.length!==currentKeys.length || keys.some((k,i)=>k!==currentKeys[i]))) throw Error('Pair order changed');
    keys??=currentKeys;
    if (!latest && fleet>=5) {
      firstOrder=chooseVehicles(wire);
      rightOrder=chooseVehicles({configs:wire.configs.map(c=>({...c,
        pHat_i:[-c.pHat_i[0],c.pHat_i[1]],pHat_j:[-c.pHat_j[0],c.pHat_j[1]]}))});
    }
    latest=wire;
    history.push(wire.configs.map(c=>({
      count:c.paths.length,mean:average(c.paths.map(p=>p.dHat)),
    })));
    if (history.length>10) history.shift();
  }
  function fixedPairs() {
    if (!latest) throw Error('Observe the current snapshot before selecting pairs');
    return latest.configs.length<=10?latest.configs.map((_,i)=>i):clique(latest.configs,firstOrder);
  }
  function diversityPairs() {
    if (!latest) throw Error('Observe the current snapshot before selecting pairs');
    const counts=latest.configs.map((_,i)=>average(history.map(h=>h[i].count)));
    return diversityOrder(latest.configs,geometry(latest.configs),counts).sort((a,b)=>a-b);
  }
  function candidates(previousPairs=fixedPairs()) {
    if (!latest) throw Error('Observe the current snapshot before selecting pairs');
    const configs=latest.configs,g=geometry(configs),count=configs.length,totalEchoes=configs.reduce((s,c)=>s+c.paths.length,0);
    const previous=new Set(previousPairs);
    const past=configs.map((_,i)=>{
      const active=history.filter(h=>h[i].count), rate=[];
      for (let j=1;j<history.length;j++) if (history[j][i].count&&history[j-1][i].count) {
        rate.push(Math.abs(history[j][i].mean-history[j-1][i].mean));
      }
      return {active:active.length/history.length,echoes:average(history.map(h=>h[i].count)),rate:average(rate)};
    });
    const diverse=diversityOrder(configs,g,past.map(p=>p.echoes));
    const indices=configs.map((_,i)=>i);
    const byCount=indices.toSorted((a,b)=>configs[b].paths.length-configs[a].paths.length||a-b);
    const byLength=indices.toSorted((a,b)=>g.values[a].length-g.values[b].length||a-b);
    let menus;
    if (count===3) {
      menus=[['keep',previousPairs],['all3',indices],
        ...indices.map(i=>['single'+i,[i]]),
        ...indices.map(i=>['doubleWithout'+i,indices.filter(j=>j!==i)])];
    } else if (count===10) {
      menus=[['keep',previousPairs],['fixed6',clique(configs,firstOrder.slice(0,4))],
        ['diverse6',diverse.slice(0,6)],['diverse8',diverse.slice(0,8)],['all10',indices],
        ['echoTop6',byCount.slice(0,6)],['echoTop8',byCount.slice(0,8)],['short6',byLength.slice(0,6)],
        ['long6',byLength.toReversed().slice(0,6)],['right6',clique(configs,rightOrder.slice(0,4))]];
    } else {
      menus=[['keep',previousPairs],['fixed6',clique(configs,firstOrder.slice(0,4))],
        ['diverse6',diverse.slice(0,6)],['diverse8',diverse.slice(0,8)],['fixed10',fixedPairs()],
        ['diverse10',diverse],['echoTop10',byCount.slice(0,10)],['short10',byLength.slice(0,10)],
        ['long10',byLength.toReversed().slice(0,10)],['right10',clique(configs,rightOrder)]];
    }
    const seen=new Map(),result=[];
    for (const [name,raw] of menus) {
      const pairs=raw.toSorted((a,b)=>a-b),key=pairs.join(',');
      if (seen.has(key)) {seen.get(key).names.push(name);continue;}
      if (!pairs.length||pairs.length>10||new Set(pairs).size!==pairs.length||pairs.some(i=>!Number.isInteger(i)||i<0||i>=count)) throw Error('Invalid candidate subset');
      const selected=pairs.map(i=>configs[i]),geometries=pairs.map(i=>g.values[i]),ranges=selected.flatMap(c=>c.paths.map(p=>p.dHat));
      const baselines=geometries.map(p=>p.length),xs=geometries.map(p=>p.mx),ys=geometries.map(p=>p.my);
      const rangeSpread=selected.map(c=>c.paths.length?span(c.paths.map(p=>p.dHat)):0);
      const directions=1-Math.hypot(average(geometries.map(p=>p.cos)),average(geometries.map(p=>p.sin)));
      const currentCounts=selected.map(c=>c.paths.length),priorCounts=pairs.map(i=>past[i].echoes);
      const features=[
        pairs.length/10,fleet/10,latest.t/100,pairs.filter(i=>previous.has(i)).length/pairs.length,
        selected.filter(c=>c.paths.length).length/pairs.length,ranges.length/Math.max(1,totalEchoes),
        Math.log1p(average(currentCounts)),Math.log1p(deviation(currentCounts)),average(pairs.map(i=>past[i].active)),
        Math.log1p(average(priorCounts)),Math.log1p(average(pairs.map(i=>past[i].rate))),
        average(baselines)/g.scale,deviation(baselines)/g.scale,Math.min(...baselines)/g.scale,Math.max(...baselines)/g.scale,
        span(xs)/g.scale,span(ys)/g.scale,deviation(xs)/g.scale,deviation(ys)/g.scale,directions,
        new Set(selected.flatMap(c=>[c.i,c.j])).size/g.vertices.size,average(ranges)/100,deviation(ranges)/100,
        average(rangeSpread)/100,average(selected.map((c,j)=>baselines[j]/Math.max(baselines[j],average(c.paths.map(p=>p.dHat)),1))),
        average(currentCounts)/Math.max(1,average(priorCounts)),
      ];
      if (features.length!==featureNames.length || !features.every(Number.isFinite)) throw Error('Invalid candidate feature vector');
      const candidate={name,names:[name],pairs,features};
      seen.set(key,candidate);result.push(candidate);
    }
    if (count<=10) result.find(c=>c.pairs.length===count).names.push('fixed10','diverse10');
    return result;
  }
  return {observe,candidates,fixedPairs,diversityPairs};
}
