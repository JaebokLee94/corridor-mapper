import test from 'node:test';
import assert from 'node:assert/strict';
import { drawComparisonHistory } from '../../drf/render.mjs';

test('comparison history uses 20-snapshot grid labels and quarter-scale percentage labels without rescaling metres', () => {
  const labels=[],grids=[];
  let box,path=[],point;
  const ctx=new Proxy({
    measureText:text=>({width:text.length*7}),
    fillText(text,x,y){labels.push({text,x,y,align:this.textAlign});},
    strokeRect(x,y,w,h){box={x,y,w,h};},
    beginPath(){path=[];point=undefined;},
    moveTo(x,y){point=[x,y];},
    lineTo(x,y){if(point)path.push([point,[x,y]]);point=[x,y];},
    stroke(){if(this.strokeStyle==='#grid')grids.push(...path);}
  },{get:(target,key)=>key in target ? target[key] : ()=>{}});
  const canvas={clientWidth:400,clientHeight:220,getContext:()=>ctx};
  const stubs={window:{devicePixelRatio:1},document:{documentElement:{}},getComputedStyle:()=>({getPropertyValue:name=>name==='--color-grid'?'#grid':'#ink'})};
  const saved=Object.fromEntries(Object.keys(stubs).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const evaluations=[{t:1,methods:{guarded:{recall:.25,p95:2},baseline:{recall:.75,p95:1}}}],before=JSON.stringify(evaluations);
  const render=(selection,snapshots)=>{labels.length=0;grids.length=0;drawComparisonHistory(canvas,evaluations,selection,snapshots);};
  const xLabels=()=>labels.filter(label=>label.align==='center');
  const yLabels=()=>labels.filter(label=>label.align==='right');
  const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
  try {
    Object.assign(globalThis,stubs);
    render('recall',120);
    assert.deepEqual(xLabels().map(label=>label.text),['20','40','60','80','100','120']);
    assert.deepEqual(yLabels().map(label=>label.text),['0','25','50','75','100']);
    assert.ok(labels.some(label=>label.text==='Observed recall [%]'),'The selected metric and its unit label the vertical axis');
    assert.ok(!labels.some(label=>label.text==='Snapshot'),'The horizontal title is provided by the DOM legend footer');
    for(const label of xLabels())close((label.x-box.x)/box.w*120,Number(label.text));
    for(const label of yLabels())close(100-(label.y-5-box.y)/box.h*100,Number(label.text));
    const vertical=grids.filter(([a,b])=>a[0]===b[0]);
    assert.equal(vertical.length,5,'Only the five interior 20-snapshot grid lines are drawn');
    vertical.forEach(([a],i)=>close((a[0]-box.x)/box.w*120,(i+1)*20));
    const horizontal=grids.filter(([a,b])=>a[1]===b[1]);
    assert.equal(horizontal.length,3,'The percentage grid aligns with 25, 50 and 75 percent');
    horizontal.forEach(([a],i)=>close(100-(a[1]-box.y)/box.h*100,(i+1)*25));
    render('recall',8);
    assert.deepEqual(xLabels().map(label=>label.text),['8'],'A short run labels its endpoint while hiding the numeric zero');
    assert.ok(grids.every(([a,b])=>a[1]===b[1]),'Short runs have no spurious fractional snapshot grid');
    render('p95',120);
    assert.deepEqual(xLabels().map(label=>label.text),['20','40','60','80','100','120']);
    assert.deepEqual(yLabels().map(label=>label.text),['0','1.12','2.24'],'P95 keeps its data-dependent metre scale');
    assert.ok(labels.some(label=>label.text==='P95 distance [m]'));
    assert.equal(JSON.stringify(evaluations),before,'Tick formatting cannot change any metric value');
  } finally {
    for(const [key,descriptor] of Object.entries(saved))descriptor ? Object.defineProperty(globalThis,key,descriptor) : delete globalThis[key];
  }
});
