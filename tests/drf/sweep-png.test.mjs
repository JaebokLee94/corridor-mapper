import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepPng } from '../../drf/render.mjs';

function canvasEnvironment() {
  const canvases=[];
  const createCanvas=()=>{
    const calls=[],canvas={clientWidth:0,clientHeight:0,calls};
    const ctx=new Proxy({
      fillStyle:'#111111',font:'14px Arial',measureText:text=>({width:text.length*7}),
      fillText(text,...position){calls.push({type:'text',text,position});},
      drawImage(image,...rect){calls.push({type:'image',image,rect});},
      arc(...args){calls.push({type:'point',args});},
      strokeRect(...args){calls.push({type:'axes',args});},
      scale(...args){calls.push({type:'scale',args});},
    },{get:(target,key)=>key in target ? target[key] : (...args)=>{
      if(['moveTo','lineTo','translate','fillRect'].includes(key)) calls.push({type:key,args});
    }});
    canvas.getContext=()=>ctx;
    canvas.toBlob=(callback,type)=>callback(new Blob(['mock PNG payload'],{type}));
    canvases.push(canvas);return canvas;
  };
  const stubs={
    document:{documentElement:{},createElement:createCanvas},window:{devicePixelRatio:1,dispatchEvent(){}},
    getComputedStyle:()=>({getPropertyValue:name=>name==='--color-plot-bg'?'#ffffff':'#111111'}),
    Image:class{set src(value){this._src=value;queueMicrotask(()=>this.onload?.());}get src(){return this._src;}},
  };
  const saved=Object.fromEntries(Object.keys(stubs).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  Object.assign(globalThis,stubs);
  return {canvases,restore(){for(const [key,descriptor] of Object.entries(saved)) descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];}};
}
const row=(method,sigmaD,mean,sd,roughness=2)=>({method,sigmaD,roughness,n:mean==null?0:sd==null?1:2,
  recall:{mean,sd,n:mean==null?0:sd==null?1:2,missing:mean==null?2:0,failed:mean===Infinity?1:0}});

test('sweep PNG renders both actual aggregate methods at 300 dpi independently of browser dimensions',async()=>{
  const env=canvasEnvironment();
  try {
    const aggregates=[row('guarded',.1,.25,.1),row('guarded',.2,.5,null),row('guarded',.3,null,null),
      row('baseline',.1,.75,.05),row('baseline',.2,.8,.1),row('baseline',.3,Infinity,null)],before=structuredClone(aggregates);
    const blob=await sweepPng(aggregates),[out,left,right]=env.canvases;
    assert.equal(blob.type,'image/png');
    assert.equal(out.width,3750,'1200 CSS pixels are rasterized at 300/96 even on a DPR-1 browser');
    assert.equal(out.height,1675,'536 CSS-pixel height is rasterized at 300/96');
    assert.equal(env.canvases.length,3,'Two offscreen plot panels and one output canvas are sufficient');
    assert.equal(left.clientWidth,0,'Export works without attaching plot canvases to the DOM');
    assert.deepEqual(left.calls.find(c=>c.type==='scale').args,[300/96,300/96]);
    assert.equal(left.width,right.width);assert.equal(left.height,right.height);
    const labels=out.calls.filter(c=>c.type==='text').map(c=>c.text);
    assert.ok(labels.includes('Guarded PSPT'));assert.ok(labels.includes('Fixed-fragment B'));
    assert.ok(labels.some(s=>s.includes('sample SD across seeds; not confidence intervals.')));
    const panels=out.calls.filter(c=>c.type==='image' && env.canvases.includes(c.image));
    assert.equal(panels.length,2);assert.ok(panels[0].rect[0]+panels[0].rect[2]<panels[1].rect[0],'The two panels have a positive separating gap');
    assert.equal(panels[0].rect[1],panels[1].rect[1]);
    for(const panel of [left,right]) {
      const prose=panel.calls.filter(c=>c.type==='text').map(c=>c.text);
      assert.ok(prose.includes('Range SD '));assert.ok(prose.includes('Observed recall '));
      assert.ok(panel.calls.some(c=>c.type==='image' && c.image.src?.startsWith('data:image/svg+xml')),'Axis and roughness notation is rendered from LaTeX SVG');
      assert.equal(panel.calls.filter(c=>c.type==='point').length,2,'Undefined and nonfinite means are not drawn as zero-valued points');
      assert.ok(panel.calls.filter(c=>['moveTo','lineTo','point','axes'].includes(c.type)).every(c=>c.args.every(Number.isFinite)),'Missing values never generate nonfinite drawing coordinates');
    }
    const leftPoints=left.calls.filter(c=>c.type==='point'),rightPoints=right.calls.filter(c=>c.type==='point');
    assert.ok(leftPoints[0].args[1]>rightPoints[0].args[1],'Guarded recall 25% is below baseline recall 75%, so the exported panels use distinct method results');
    assert.deepEqual(aggregates,before,'Export cannot mutate aggregate statistics or missing values');
  } finally {env.restore();}
});

test('sweep PNG names absent results and rejects an empty sweep instead of exporting the selected field',async()=>{
  const env=canvasEnvironment();
  try {
    await assert.rejects(sweepPng([]),/Run a parameter sweep/);
    await sweepPng([row('guarded',.1,null,null)]);
    const prose=env.canvases[0].calls.filter(c=>c.type==='text').map(c=>c.text);
    assert.ok(prose.includes('No defined recall means'));
    assert.ok(prose.includes('No completed conditions'));
  } finally {env.restore();}
});
