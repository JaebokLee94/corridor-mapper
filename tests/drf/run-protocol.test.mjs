import { echoProtocol } from '../../drf/echo-comparison.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { METHOD_PROTOCOL } from '../../drf/comparison.mjs';
import { LEGACY_RUN_PROTOCOL } from '../../drf/legacy-run-protocol.mjs';
import { sweepCsv } from '../../drf/sweep-export.mjs';
import { createGrid, pathFieldPoint } from '../../drf/field.mjs';
import { createDisplayField } from '../../drf/display-field.mjs';

const slice = (source,start,end) => {
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a,`Missing handler boundary: ${start}`);
  return source.slice(a,b);
};
function attachReceiver(source,state,elements={thresholdDetails:{}}) {
  const renderThresholdProtocol=new Function('$','METHOD_PROTOCOL','echoProtocol',
    `${slice(source,'function renderThresholdProtocol','const fmt =')}return renderThresholdProtocol;`)(id=>elements[id],METHOD_PROTOCOL,echoProtocol);
  return new Function('state','LEGACY_RUN_PROTOCOL','makeWorker','controls','fillSettings','location','fail','notice','renderSelected','renderThresholdProtocol',
    `let hoverWorker,evalWorker;${slice(source,'async function receiveRunMessage','function commandRun')}return receiveRunMessage;`)(
    state,LEGACY_RUN_PROTOCOL,()=>({request:async()=>{}}),()=>{},()=>{},{hash:''},error=>{throw error;},()=>{},()=>{},renderThresholdProtocol);
}
function exportHandlers(source,state,makeWorker) {
  const buttons={exportJson:{textContent:'Download JSON'},exportCsv:{},exportSourceSelect:{value:'comparison'}},downloads=[],notices=[];
  const code=slice(source,'const jsonValue =',"$('exportPng').onclick");
  new Function('state','provenance','aggregateRuns','download','Blob','$','psptSnapshotCsv','renderExportControls','sweepCsv','makeWorker','notice',code)(
    state,{},()=>[],(blob,name)=>downloads.push({blob,name}),Blob,id=>buttons[id],()=> 't,precision,pspt_ms\r\n1,1,2\r\n',
    ()=>{buttons.exportJson.disabled=!!state.jsonExportWorker;},sweepCsv,makeWorker,message=>notices.push(message));
  return {buttons,downloads,notices};
}
const initial=()=>({generation:7,protocol:null,server:{},frames:[],frameTimes:[],evaluations:[],sweepRuns:[],next:0,selected:0,followLive:true,method:'compare'});
const scenario=()=>({input:{snapshots:1},wire:[{t:1,configs:[]}],truth:[{t:1}],walls:[]});
const frame=()=>({type:'frame',requestId:7,next:1,frame:{t:1,methods:{guarded:{candidates:[],ms:2},baseline:{candidates:[],ms:3}}},evaluation:{methods:{guarded:{},baseline:{}}}});

{
  const source=fs.readFileSync(new URL('../../drf/app.mjs',import.meta.url),'utf8'),label='Original';
  test(`${label}: reconnect keeps the producing worker protocol through JSON and CSV export`,async()=>{
    const state=initial(),receive=attachReceiver(source,state),loaded=structuredClone(METHOD_PROTOCOL);
    loaded.guarded.revision='saved-worker-revision';loaded.guarded.threshold=1.234;loaded.guarded.tuning.id='saved-development';
    await receive({type:'prepared',requestId:7,scenario:scenario(),grid:{nx:1,ny:1},protocol:loaded},7);
    loaded.guarded.revision='packet-object-mutated';
    assert.equal(state.protocol.guarded.revision,'saved-worker-revision','state needs a stable snapshot of worker metadata');
    await receive(frame(),7);
    const {buttons,downloads}=exportHandlers(source,state);
    buttons.exportJson.onclick();buttons.exportCsv.onclick();
    const json=JSON.parse(await downloads[0].blob.text());
    assert.deepEqual(json.estimators,state.protocol);
    assert.equal(json.estimators.guarded.threshold,1.234);
    const csv=(await downloads[1].blob.text()).trim().split('\r\n').map(row=>row.split(','));
    assert.equal(csv[0].at(-1),'implementation_revision');
    assert.equal(csv[1][1],'1.234');assert.equal(csv[1][2],'saved-development');
    assert.equal(csv[1].at(-1),'saved-worker-revision');
  });
  test(`${label}: old prepared packets are exported as independent-pairs/single-link, never current code`,async()=>{
    const state=initial(),receive=attachReceiver(source,state);
    await receive({type:'prepared',requestId:7,scenario:scenario(),grid:{nx:1,ny:1}},7);
    assert.deepEqual(state.protocol,LEGACY_RUN_PROTOCOL);
    assert.equal(state.protocol.guarded.refinement,'independent-pairs');
    assert.equal(state.protocol.guarded.clustering,'single-link');
    assert.notEqual(state.protocol.guarded.revision,METHOD_PROTOCOL.guarded.revision);
    await receive(frame(),7);
    const {buttons,downloads}=exportHandlers(source,state);
    buttons.exportJson.onclick();buttons.exportCsv.onclick();
    assert.deepEqual(JSON.parse(await downloads[0].blob.text()).estimators,LEGACY_RUN_PROTOCOL);
    assert.match(await downloads[1].blob.text(),/guarded45-independent-pairs-single-link-legacy/);
  });
  test(`${label}: threshold popup follows the loaded implementation and its saved threshold`,async()=>{
    const elements={thresholdDetails:{}},state=initial(),receive=attachReceiver(source,state,elements);
    await receive({type:'prepared',requestId:7,scenario:scenario(),grid:{nx:1,ny:1}},7);
    assert.match(elements.thresholdDetails.textContent,/treats pair errors independently/);
    assert.match(elements.thresholdDetails.textContent,/single-link distance grouping/);
    assert.doesNotMatch(elements.thresholdDetails.textContent,/accounts for shared vehicle position error|Each echo cluster is limited/);
    const current=structuredClone(METHOD_PROTOCOL);current.guarded.threshold=2.345;
    await receive({type:'prepared',requestId:7,scenario:scenario(),grid:{nx:1,ny:1},protocol:current},7);
    assert.match(elements.thresholdDetails.textContent,/WM-P 2.345;/);
    assert.match(elements.thresholdDetails.textContent,/accounts for shared vehicle position error/);
    assert.match(elements.thresholdDetails.textContent,/Each echo cluster is limited/);
    assert.match(elements.thresholdDetails.textContent,/not retuned or certified/);
    assert.doesNotMatch(elements.thresholdDetails.textContent,/treats pair errors independently|single-link distance grouping/);
  });
  test(`${label}: sweep-only export preserves each run protocol without claiming a current comparison`,async()=>{
    const state=initial();state.sweepRuns=[{input:{seed:1},protocol:LEGACY_RUN_PROTOCOL,final:{large:'omitted'}}];
    const {buttons,downloads}=exportHandlers(source,state);buttons.exportJson.onclick();
    const json=JSON.parse(await downloads[0].blob.text());
    assert.equal(json.estimators,null);
    assert.deepEqual(json.sweep.completeSeedResults[0].protocol,LEGACY_RUN_PROTOCOL);
    assert.equal(json.sweep.completeSeedResults[0].final,undefined);
  });
  test('viewport JSON restores just the clicked prefix, including a measured ellipse tip outside the screen',async()=>{
    const grid=createGrid(10,10,[-.5,9.5,-.5,9.5]),viewBounds=[0,8,0,8],numerical={band:4,perimeter:'exact'};
    const c={i:0,j:1,pHat_i:[2,2],pHat_j:[6,2],Sigma_i:[0,0,0],Sigma_j:[0,0,0],paths:[{dHat:24,sigmaD:.4}]};
    const wire=[1,2,3].map(t=>({t,configs:[c]})), viewport=createDisplayField(grid,{...numerical,viewBounds});
    const frames=wire.slice(0,2).map(w=>({...viewport.step(w),methods:{echoSpline:{ms:w.t}},method:'fixture'}));
    const state={...initial(),frames,workers:[],grid,fieldViewBounds:viewBounds,evaluations:[{t:1},{t:2}],
      scenario:{input:{...numerical,snapshots:3},wire,walls:[],truth:[1,2,3]}};
    const calls=[];let field,stops=0;
    const f=exportHandlers(source,state,name=>{
      assert.equal(name,'field');
      const worker={request:async m=>{
        calls.push(m);
        if (m.type==='initDisplay') {field=createDisplayField(createGrid(m.grid.nx,m.grid.ny,m.grid.domain),m.numerical);return;}
        return field.step(m.snapshot);
      },stop(){stops++;}};
      state.workers.push(worker);return worker;
    });
    const job=f.buttons.exportJson.onclick(); await f.buttons.exportJson.onclick();
    assert.equal(f.buttons.exportJson.disabled,true);
    state.frames.push({...viewport.step(wire[2]),methods:{}});state.evaluations.push({t:3});
    await job;
    assert.deepEqual(calls.map(m=>m.type),['initDisplay','step','step']);
    assert.deepEqual(calls[0].numerical,numerical);assert.equal(f.downloads.length,1);
    const result=JSON.parse(await f.downloads[0].blob.text());
    assert.equal(result.schema,'echomap-drf/7');
    assert.deepEqual(result.measurement,wire.slice(0,2));assert.deepEqual(result.truth.snapshots,[1,2]);
    assert.deepEqual(result.evaluation,[{t:1},{t:2}]);
    const expected=pathFieldPoint([-8,2],c,c.paths[0]);
    for(const [i,frame] of result.result.entries()){
      const x=frame.grid.x.indexOf(-8),y=frame.grid.y.indexOf(2);assert.ok(x>=0&&y>=0);
      assert.equal(frame.Dbar[y*frame.grid.nx+x],Math.fround(expected.u));
      assert.equal(frame.betaHat[y*frame.grid.nx+x],Math.fround((i+1)*expected.u/((i+1)*expected.alpha+frame.epsilonA)));
      assert.equal(frame.ms,state.frames[i].ms);assert.deepEqual(frame.methods,state.frames[i].methods);
      assert.equal(state.frames[i].grid.x.includes(-8),false);
    }
    assert.equal(stops,1);assert.equal(state.workers.length,0);assert.equal(f.buttons.exportJson.textContent,'Download JSON');
    assert.equal(f.buttons.exportJson.disabled,false);assert.deepEqual(f.notices,[]);
  });
  test('a failed or superseded full-field JSON export releases its worker without downloading stale data',async()=>{
    for (const superseded of [false,true]) {
      const state={...initial(),frames:[{t:1,grid:{}}],workers:[],grid:{nx:1,ny:1,domain:[0,1,0,1]},
        fieldViewBounds:[0,1,0,1],scenario:scenario()};
      let rejectStep,stops=0;
      const f=exportHandlers(source,state,()=>{
        const worker={request:m=>m.type==='initDisplay'?Promise.resolve():new Promise((_,reject)=>{rejectStep=reject;}),
          stop(){stops++;}};
        state.workers.push(worker);return worker;
      });
      const job=f.buttons.exportJson.onclick();await Promise.resolve();
      if (superseded) state.generation++;
      rejectStep(new Error('Field worker failed'));await job;
      assert.deepEqual(f.notices,superseded?[]:['JSON export failed: Field worker failed']);
      assert.equal(stops,1);assert.deepEqual(state.workers,[]);assert.equal(f.downloads.length,0);
      assert.equal(f.buttons.exportJson.disabled,false);assert.equal(f.buttons.exportJson.textContent,'Download JSON');
    }
  });
}
