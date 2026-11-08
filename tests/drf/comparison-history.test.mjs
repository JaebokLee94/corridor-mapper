import test from 'node:test';
import assert from 'node:assert/strict';
import { drawComparisonHistory } from '../../drf/render.mjs';
import { prepareCanvasMath } from '../../drf/latex.mjs';

test('comparison history uses 20-snapshot grid labels and quarter-scale percentage labels without rescaling metres', async () => {
  const labels=[],grids=[],mathImages=[],endpoints=[];
  let box,path=[],point;
  const ctx=new Proxy({
    arc(x,y){endpoints.push([x,y]);},
    drawImage(image){mathImages.push(decodeURIComponent(image.src));},
    measureText:text=>({width:text.length*7}),
    fillText(text,x,y){labels.push({text,x,y,align:this.textAlign});},
    strokeRect(x,y,w,h){box={x,y,w,h};},
    beginPath(){path=[];point=undefined;},
    moveTo(x,y){point=[x,y];},
    lineTo(x,y){if(point)path.push([point,[x,y]]);point=[x,y];},
    stroke(){if(this.strokeStyle==='#grid')grids.push(...path);}
  },{get:(target,key)=>key in target ? target[key] : ()=>{}});
  const canvas={clientWidth:400,clientHeight:220,getContext:()=>ctx};
  const stubs={window:{devicePixelRatio:1,dispatchEvent(){}},document:{documentElement:{}},Image:class{set src(value){this._src=value;queueMicrotask(()=>this.onload?.());}get src(){return this._src;}},getComputedStyle:()=>({getPropertyValue:name=>name==='--color-grid'?'#grid':'#111111'})};
  const saved=Object.fromEntries(Object.keys(stubs).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const evaluations=[{t:1,methods:{guarded:{recall:.25,p95:2,missing:7,interpolation:{recall:.75,missing:3,count:2,lengthM:1.5,offWallM:.2,falseBridges:1,hermite:{recall:.8,lengthM:1.75}}},baseline:{recall:.75,p95:1}}}],before=JSON.stringify(evaluations);
  const render=(selection,snapshots,mode='compare',kind='linear')=>{endpoints.length=0;labels.length=0;grids.length=0;mathImages.length=0;drawComparisonHistory(canvas,evaluations,selection,snapshots,mode,kind);};
  const xLabels=()=>labels.filter(label=>label.align==='center');
  const yLabels=()=>labels.filter(label=>label.align==='right');
  const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
  try {
    Object.assign(globalThis,stubs);
    await prepareCanvasMath(['#111111']);
    render('recall',120);
    assert.deepEqual(xLabels().map(label=>label.text),['20','40','60','80','100','120']);
    assert.deepEqual(yLabels().map(label=>label.text),['0','25','50','75','100']);
    assert.ok(labels.some(label=>label.text==='Observed recall '),'The selected metric labels the vertical axis');
    assert.ok(mathImages.some(svg=>svg.includes('data-c="25"')),'The percent unit is rendered as a LaTeX SVG glyph');
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
    assert.ok(labels.some(label=>label.text==='P95 distance '));
    assert.ok(mathImages.some(svg=>svg.includes('data-c="6D"')),'The metre unit is rendered as a LaTeX SVG glyph');
    for (const [metric,raw,after,maximum] of [
      ['recall',25,75,100], ['missing',7,3,8], ['count',0,2,2], ['falseBridges',0,1,1],
      ['lengthM',0,1.5,1.68], ['offWallM',0,.2,.224],
    ]) {
      render(metric,120,'guarded');
      assert.equal(endpoints.length,2,metric);
      for (const [i,value] of [raw,after].entries()) close(endpoints[i][1],box.y+box.h*(1-value/maximum));
    }
    render('lengthM',120,'guarded','hermite');
    assert.deepEqual(yLabels().map(label=>label.text),['0','0.98','1.96']);
    render('lengthM',120,'baseline','hermite');
    assert.equal(endpoints.length,1,'A missing post-interpolation result must leave a gap');
    assert.equal(JSON.stringify(evaluations),before,'Tick formatting cannot change any metric value');
  } finally {
    for(const [key,descriptor] of Object.entries(saved))descriptor ? Object.defineProperty(globalThis,key,descriptor) : delete globalThis[key];
  }
});
