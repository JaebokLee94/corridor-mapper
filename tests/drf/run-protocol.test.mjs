import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { METHOD_PROTOCOL } from '../../drf/comparison.mjs';
import { LEGACY_RUN_PROTOCOL } from '../../drf/legacy-run-protocol.mjs';
import { sweepCsv } from '../../drf/sweep-export.mjs';

const targets = [new URL('../../drf/app.mjs',import.meta.url),new URL('../../preview/drf/app.mjs',import.meta.url)];
// Also exercise the user's actual temporary preview when present on this Mac.
const localPreview='/Users/jaebok/Documents/Codex/2026-11-04/echomap-design-preview/drf/app.mjs';
if(fs.existsSync(localPreview))targets.push(localPreview);
const slice = (source,start,end) => {
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a,`Missing handler boundary: ${start}`);
  return source.slice(a,b);
};
function attachReceiver(source,state,elements={thresholdSummary:{},thresholdDetails:{}}) {
  const renderThresholdProtocol=new Function('$','METHOD_PROTOCOL',
    `${slice(source,'function renderThresholdProtocol','const fmt =')}return renderThresholdProtocol;`)(id=>elements[id],METHOD_PROTOCOL);
  return new Function('state','LEGACY_RUN_PROTOCOL','makeWorker','controls','fillSettings','location','fail','notice','renderSelected','renderThresholdProtocol',
    `let hoverWorker,evalWorker;${slice(source,'async function receiveRunMessage','function commandRun')}return receiveRunMessage;`)(
    state,LEGACY_RUN_PROTOCOL,()=>({request:async()=>{}}),()=>{},()=>{},{hash:''},error=>{throw error;},()=>{},()=>{},renderThresholdProtocol);
}
function exportHandlers(source,state) {
  const buttons={exportJson:{},exportCsv:{},exportSourceSelect:{value:'comparison'}},downloads=[];
  const code=slice(source,'const jsonValue =',"$('exportPng').onclick");
  new Function('state','provenance','aggregateRuns','download','Blob','$','psptSnapshotCsv','renderExportControls','sweepCsv',code)(
    state,{},()=>[],(blob,name)=>downloads.push({blob,name}),Blob,id=>buttons[id],()=> 't,precision,pspt_ms\r\n1,1,2\r\n',()=>{},sweepCsv);
  return {buttons,downloads};
}
const initial=()=>({generation:7,protocol:null,server:{},frames:[],evaluations:[],sweepRuns:[],next:0,selected:0,followLive:true,method:'compare'});
const scenario=()=>({input:{snapshots:1},wire:[{t:1,configs:[]}],truth:[{t:1}],walls:[]});
const frame=()=>({type:'frame',requestId:7,next:1,frame:{t:1,methods:{guarded:{candidates:[],ms:2},baseline:{candidates:[],ms:3}}},evaluation:{methods:{guarded:{},baseline:{}}}});

for(const filename of targets) {
  const source=fs.readFileSync(filename,'utf8'),label=String(filename);
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
    const elements={thresholdSummary:{},thresholdDetails:{}},state=initial(),receive=attachReceiver(source,state,elements);
    await receive({type:'prepared',requestId:7,scenario:scenario(),grid:{nx:1,ny:1}},7);
    assert.match(elements.thresholdDetails.textContent,/treats pair errors independently/);
    assert.match(elements.thresholdDetails.textContent,/single-link distance grouping/);
    assert.doesNotMatch(elements.thresholdDetails.textContent,/accounts for shared vehicle position error|Each echo cluster is limited/);
    const current=structuredClone(METHOD_PROTOCOL);current.guarded.threshold=2.345;
    await receive({type:'prepared',requestId:7,scenario:scenario(),grid:{nx:1,ny:1},protocol:current},7);
    assert.match(elements.thresholdSummary.textContent,/WM-P 2.3450/);
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
}
