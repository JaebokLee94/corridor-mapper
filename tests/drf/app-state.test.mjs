import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_INPUT, LAYERED_DOMAIN, normalizeInput } from '../../drf/scenario.mjs';

const source=readFileSync(new URL('../../drf/app.mjs',import.meta.url),'utf8');
const section=(start,end)=>{
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0 && b>a,`Actual app source section: ${start}`);
  return source.slice(a,b);
};

test('shared URLs preserve the exact seed and snapshot count across reloads; only unseeded visits randomise',()=>{
  const initial={...DEFAULT_INPUT,scene:'layered',seed:0xffffffff,vehicles:7,snapshots:80};
  for (const hash of ['',`#v1=${encodeURIComponent(JSON.stringify(initial))}`,'#v1=invalid']) {
    const location={hash},filled=[],notices=[];let calls=0;
    const context=vm.createContext({location,DEFAULT_INPUT,normalizeInput,matchMedia:()=>({matches:false}),
      crypto:{getRandomValues:array=>{calls++;array[0]=1234567;return array;}},
      fillSettings:input=>filled.push({...input}),notice:text=>notices.push(text),
      history:{replaceState:(_,__,url)=>{location.hash=url;}}});
    vm.runInContext(section('let initialInput = DEFAULT_INPUT;','(globalThis.__drfOffline ?'),context);
    const value=filled.at(-1),restored=JSON.parse(decodeURIComponent(location.hash.slice(4)));
    assert.deepEqual(restored,value);
    assert.equal(calls,hash ? 0 : 1);
    assert.equal(value.seed,hash.includes('invalid') ? DEFAULT_INPUT.seed : hash ? initial.seed : 1234567);
    assert.equal(value.snapshots,hash && !hash.includes('invalid') ? 80 : DEFAULT_INPUT.snapshots);
    assert.equal(value.vehicles,hash && !hash.includes('invalid') ? 7 : DEFAULT_INPUT.vehicles);
    assert.equal(notices.length,hash.includes('invalid') ? 1 : 0);
    vm.runInNewContext(section('let initialInput = DEFAULT_INPUT;','(globalThis.__drfOffline ?'),{...context,location});
    assert.deepEqual(filled.at(-1),value,'Reloading the resulting URL preserves all settings');
  }
});

test('server page load remains idle for saved completed, active and paused comparisons or sweeps',async()=>{
  for (const job of [null,...['comparison','sweep'].flatMap(mode=>['done','running','paused','cancelled','failed'].map(status=>({id:'saved-job',mode,status,input:{seed:42},jobs:[{seed:42}]})))]) {
    const state={mode:'idle',frames:[],sweep:null},notices=[];
    const context=vm.createContext({state,document:{querySelector:()=>({content:'server'})},
      connectComputeServer:async()=>({job}),controls(){},notice:message=>notices.push(message),
      prepare:()=>assert.fail('Page load must not start or restore a comparison'),
      runSweep:()=>assert.fail('Page load must not start or restore a sweep'),
      fillSettings:()=>assert.fail('Saved job must not overwrite selected settings on page load'),
      $:()=>assert.fail('Page load must not open the sweep dialog'),
    });
    vm.runInContext(section('if (document.querySelector(\'meta[name="echomap-compute"]\')','// Switching the displayed method'),context);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(state.mode,'idle');assert.equal(state.frames.length,0);assert.equal(state.sweep,null);
    assert.equal(state.connecting,false);assert.equal(state.server.job,job);
    assert.match(notices.at(-1),/^Press /);
  }
});

test('explicit Run starts a new calculation after completion and reconnects only to an active comparison',async()=>{
  for (const status of ['done','cancelled','failed','running','paused']) {
    const selected={seed:7,snapshots:3},previous={seed:42,snapshots:120};let input=selected,queries=0;
    const state={server:{},mode:'idle',generation:0,workers:[]},created=[],posted=[];
    const context=vm.createContext({state,location:{hash:''},controls(){},notice(){},
      connectComputeServer:async()=>{queries++;return {job:{id:'previous',mode:'comparison',status,input:previous}};},
      settings:()=>input,fillSettings:value=>{input=value;},cancel:()=>{state.generation++;},
      createWorker:(name,options)=>{created.push({name,...options});return {postMessage:message=>posted.push(message),terminate(){}};},
      fail:error=>{throw error;},
    });
    vm.runInContext(section('async function requestedServerJob(','function fail('),context);
    assert.equal(queries,0);assert.deepEqual(created,[]);
    await context.prepare(false);
    const active=['running','paused'].includes(status);
    assert.equal(queries,1);assert.equal(created.length,1);assert.equal(created[0].resumeId,active?'previous':undefined);
    assert.equal(posted.length,1);assert.equal(posted[0].input,active?previous:selected);
  }
});

test('an explicit Run cannot duplicate or cancel a different active server job',async()=>{
  const state={server:{},mode:'idle'},notices=[];
  const context=vm.createContext({state,controls(){},notice:message=>notices.push(message),
    connectComputeServer:async()=>({job:{id:'sweep',mode:'sweep',status:'running'}}),
    cancel:()=>assert.fail('Do not cancel a background sweep'),
    createWorker:()=>assert.fail('Do not create a competing comparison'),
    fail:error=>{throw error;},
  });
  vm.runInContext(section('async function requestedServerJob(','function fail('),context);
  await context.prepare(false);
  assert.equal(state.mode,'idle');assert.equal(state.connecting,false);assert.match(notices.at(-1),/press Run sweep to reconnect/);
});

test('full runs and single steps send exactly one start command with the requested settings',async()=>{
  for (const [single,requested] of [[false,60],[true,60],[false,80]]) {
    const input={scene:'layered',seed:0xffffffff,vehicles:10,snapshots:requested,grid:150,band:4,perimeter:'exact'},posted=[],inspections=[];
    const state={generation:0,scenario:null,mode:'idle',workers:[]},location={hash:'#v1=old'};
    const worker={postMessage:message=>posted.push(message),terminate(){}};
    const context=vm.createContext({state,location,
      settings:()=>({...input}),cancel:()=>{state.generation++;},controls(){},notice(){},
      createWorker:name=>{assert.equal(name,'run');return worker;},
      makeWorker:name=>({request:async message=>{inspections.push([name,message]);return {};}}),
      fail:error=>{throw error;},
    });
    vm.runInContext(section('async function prepare(','function fail(')+section('async function receiveRunMessage(','async function hashField('),context);
    await context.prepare(single);
    assert.equal(posted.length,1,'Starting the run must not dispatch any per-snapshot request');
    assert.equal(posted[0].type,'start');assert.equal(posted[0].requestId,state.generation);assert.equal(posted[0].single,single);
    assert.deepEqual({...posted[0].input},input,'Preserve seed, fleet size and requested run length');
    assert.deepEqual(JSON.parse(decodeURIComponent(location.hash.slice(3))),input);
    const scenario={input,domain:[0,80,-20,50]},grid={nx:150,ny:150,domain:scenario.domain};
    await context.receiveRunMessage({type:'prepared',requestId:state.generation,scenario,grid},state.generation);
    assert.equal(state.scenario,scenario);assert.equal(state.grid,grid,'Use the grid supplied by the autonomous worker');
    assert.equal(state.valid,true);assert.equal(state.mode,'running');assert.equal(state.busy,true);
    assert.equal(posted.length,1,'Prepared notifications need no acknowledgement to continue');
    assert.equal(inspections.length,1);assert.equal(inspections[0][0],'eval');assert.equal(inspections[0][1].type,'init');
  }
});

test('actual lower-map buttons affect only their own camera',()=>{
  const nodes=new Map(),calls=[],$=id=>{if (!nodes.has(id)) nodes.set(id,{});return nodes.get(id);};
  const view=name=>({zoom:factor=>calls.push([name,'zoom',factor]),fit:()=>calls.push([name,'fit'])});
  vm.runInNewContext(section("for (const [prefix,view] of [['density'","$('configSelect').onchange"),
    {$,densityMap:view('density'),contrastMap:view('contrast')});
  for (const prefix of ['density','contrast']) {
    $(prefix+'ZoomIn').onclick();$(prefix+'ZoomOut').onclick();$(prefix+'ResetView').onclick();
  }
  assert.deepEqual(calls,[['density','zoom',1.3],['density','zoom',1/1.3],['density','fit'],
    ['contrast','zoom',1.3],['contrast','zoom',1/1.3],['contrast','fit']]);
});

test('actual preview geometry stays cached when the truth overlay is hidden',()=>{
  const truth={checked:true},input={scene:'layered',seed:1,sigmaM:6,deltaM:20,sigmaDGeometry:.33,deltaD:4};
  const walls=[[[0,6],[60,7]],[[0,24],[60,23]]],domain=[0,60,-20,50];
  let generated=0;
  const context=vm.createContext({state:{},$:()=>truth,form:{},
    FormData:class { *[Symbol.iterator]() { yield* Object.entries(input); } },
    previewKey:'',preview:[],previewBounds:undefined,normalizeInput:value=>value,notice:message=>assert.fail(message),
    createSceneGeometry:()=>{generated++;return {walls,domain};}});
  vm.runInContext(section('function previewWalls()','function renderSelected()'),context);
  const initial=context.previewWalls();
  truth.checked=false;assert.equal(context.previewWalls(),initial,'Hiding the preview must keep the scene extent');
  truth.checked=true;assert.equal(context.previewWalls(),initial);
  assert.equal(generated,1,'Layer toggles must reuse the scene, without regenerating it');
  input.sigmaDGeometry=.66;context.previewWalls();
  assert.equal(generated,2,'Changing geometry roughness must invalidate the preview');
});

test('actual view reset preserves simulation, selection and replay; experiment reset still clears them',async()=>{
  const nodes=new Map(),pending=new Map(),charts=new Map();let nextFrame=0,stoppedWorkers=0,cancelledSweeps=0,fitCalls=0;
  const $=id=>{
    if (!nodes.has(id)) nodes.set(id,{id,value:'',textContent:'old snapshot value',checked:false,options:[],
      dataset:{},removeAttribute(){},replaceChildren(...options){this.options=options;}});
    return nodes.get(id);
  };
  const snapshots={value:'3'},elements=[snapshots];elements.namedItem=name=>name==='snapshots' ? snapshots : name==='wallSide' ? {value:'both'} : null;
  const form={elements};$('sweepSettings').elements=[];$('playbackSpeed').value='1';
  const state={mode:'done',frames:[1,2,3].map(t=>({t,Q:t,admitted:t,rejected:0,ms:1})),evaluations:[{},{},{}],
    selected:3,next:3,busy:false,replay:false,replayAt:0,generation:0,valid:true,grid:{},
    scenario:{input:{snapshots:3},truth:[{configs:[]},{configs:[]},{configs:[]}],wire:[],walls:[]},
    workers:[{stop(){stoppedWorkers++;}}],sweep:{cancel(){cancelledSweeps++;}},sweepRuns:[{}]};
  const context=vm.createContext({state,$,form,hoverGeneration:0,hoverTimer:0,replayFrame:0,
    runWorker:{},evalWorker:{},hoverWorker:{},DEFAULT_INPUT:{snapshots:60},LAYERED_DOMAIN,location:{hash:'#old'},
    document:{body:{dataset:{}},createElement:()=>({}),querySelectorAll:()=>[]},map:{set(){},fit(){fitCalls++;}},baselineMap:{set(){},fit(){fitCalls++;}},densityMap:{set(){},fit(){fitCalls++;}},contrastMap:{set(){},fit(){fitCalls++;}},previewWalls:()=>[],previewBounds:undefined,
    fmt:v=>Number.isFinite(v) ? String(v) : '—',percentile:values=>values[0]??null,
    requestAnimationFrame:fn=>{const id=++nextFrame;pending.set(id,fn);return id;},cancelAnimationFrame:id=>pending.delete(id),clearTimeout(){},
    drawComparisonHistory:(canvas,data)=>charts.set(canvas.id,data),drawHistogram:(canvas,data)=>charts.set(canvas.id,data),
    drawProfile:(canvas,data)=>charts.set(canvas.id,data),drawCounts:(canvas,a,b)=>charts.set(canvas.id,[a,b]),
    fillSettings:input=>{snapshots.value=String(input.snapshots);},renderSweep(){},notice:text=>{$('status').textContent=text;},
  });
  const reset=source.match(/^\$\('resetButton'\)\.onclick = .*;$/m)?.[0];assert.ok(reset,'Actual reset handler exists');
  const viewReset=source.match(/^\$\('firstSnapshot'\)\.onclick = .*;$/m)?.[0];assert.ok(viewReset,'Actual view reset handler exists');
  vm.runInContext([
    section('function stopReplay()','async function prepare('),
    section('function renderSelected()','async function updateProfile('),
    section('async function receiveRunMessage(','async function hashField('),
    section('function replayTick(','$(\'runButton\').onclick'),viewReset,reset,
  ].join('\n'),context);
  const assertViewOnly=()=>{
    const before={...state},beforeFit=fitCalls,queued=[...pending.keys()],replayFrame=context.replayFrame;
    const ui=[$('timeSlider').value,$('timeSlider').max,$('snapshotLabel').textContent,$('status').textContent,$('inspector').textContent,snapshots.value,context.location.hash];
    $('firstSnapshot').onclick();
    assert.equal(fitCalls-beforeFit,4,'Restore all four map cameras');
    assert.deepEqual(state,before,'Keep every simulation/selection/replay field unchanged');
    for (const key of ['frames','evaluations','scenario','grid','workers','sweep','sweepRuns']) assert.equal(state[key],before[key],`Preserve ${key} identity`);
    assert.deepEqual([...pending.keys()],queued,'Keep the queued replay/advance callbacks');
    assert.equal(context.replayFrame,replayFrame);
    assert.deepEqual([$('timeSlider').value,$('timeSlider').max,$('snapshotLabel').textContent,$('status').textContent,$('inspector').textContent,snapshots.value,context.location.hash],ui,'Preserve the current readout, settings and progress notice');
    assert.equal(stoppedWorkers,0);assert.equal(cancelledSweeps,0);
  };
  const completed={...state},settingsValue=snapshots.value,workers=state.workers;
  Object.assign(state,{frames:[],evaluations:[],scenario:null,grid:null,selected:0,next:0,valid:false,followLive:true,sweep:null,sweepRuns:[],generation:17});
  for (const mode of ['idle','running']) {
    state.mode=mode;context.controls();
    assert.equal($('firstSnapshot').disabled,false,`First view must be available while ${mode} without records`);
    const frames=state.frames,evaluations=state.evaluations;
    assertViewOnly();
    assert.equal(state.mode,mode,'Restoring the preview must not pause generation');
    assert.equal(state.followLive,true);assert.equal(state.selected,0);assert.equal(state.next,0);
    assert.equal(state.generation,17);assert.equal(state.scenario,null);assert.equal(state.valid,false);
    assert.equal(state.frames,frames);assert.equal(state.evaluations,evaluations);
    assert.equal(state.frames.length,0);assert.equal(state.evaluations.length,0);
    assert.equal(state.workers,workers);assert.equal(stoppedWorkers,0);
    assert.equal(snapshots.value,settingsValue);assert.equal(context.location.hash,'#old');
    assert.equal($('firstSnapshot').disabled,false);
  }
  Object.assign(state,completed);fitCalls=0;
  vm.runInContext('controls();',context);
  assert.equal(Number($('timeSlider').max),3);assert.equal(Number($('timeSlider').value),3);
  for (const mode of ['done','paused','running','cancelled']) {state.mode=mode;state.selected=2;state.followLive=false;context.controls();assertViewOnly();}
  state.mode='done';state.selected=3;context.controls();
  vm.runInContext('toggleReplay();stopReplay();toggleReplay();',context);
  assert.equal(pending.size,1,'Rapid start/stop/start must retain only one rAF');
  assertViewOnly();
  const [id,callback]=pending.entries().next().value;pending.delete(id);callback(300);
  assert.equal(pending.size,1,'Replay tick must retain only one next rAF');assert.equal(state.selected,1);
  vm.runInContext('stopReplay();',context);state.mode='running';state.selected=3;state.followLive=true;
  state.scenario.wire=Array.from({length:5},()=>({}));state.busy=true;
  const predictedCandidates=[{id:'1:h',center:[10,20],status:'pending'}];
  const beforeFit=fitCalls;assertViewOnly();assert.equal(state.selected,3);assert.equal(state.mode,'running');assert.equal(state.followLive,true);
  assert.equal(state.frames.length,3,'View reset must preserve completed records');assert.equal(fitCalls-beforeFit,4);assert.equal(pending.size,0);
  const frame={t:4,Q:4,admitted:4,rejected:0,ms:1,candidates:predictedCandidates,psptMs:2,method:'guarded-tuned'};
  await context.receiveRunMessage({type:'frame',requestId:state.generation,frame,evaluation:{},next:4},state.generation);
  assert.equal(state.frames.length,4,'Worker results arriving after view reset must be retained');
  assert.equal(state.frames.at(-1),frame);assert.equal(state.selected,4,'Live following must continue after a view reset');
  assert.equal(state.mode,'running');assert.equal(state.followLive,true);
  assert.equal(state.busy,true,'Run remains busy until the worker confirms a pause or completion');assert.equal(pending.size,0);
  state.workers=[{stop(){stoppedWorkers++;}}];
  $('inspector').textContent='old D/A/Q';$('diagnosticSummary').textContent='old Theorem 2';
  vm.runInContext("$('resetButton').onclick();",context);
  for (const [id,callback] of [...pending]) {pending.delete(id);callback(400);}
  assert.equal(pending.size,0);assert.equal(stoppedWorkers,1);assert.equal(cancelledSweeps,1);
  assert.equal(state.frames.length,0);assert.equal(state.evaluations.length,0);assert.equal(state.scenario,null);assert.equal(state.valid,false);
  assert.equal(Number($('timeSlider').max),1);assert.equal(Number($('timeSlider').value),0);assert.equal($('timeSlider').disabled,true);
  assert.equal($('snapshotLabel').textContent,'0 / 60');
  assert.equal($('sweepStatus').textContent,'No results yet.');
  assert.equal($('diagnosticSummary').textContent,'No results yet.');
  assert.match($('inspector').textContent,/Hover/);assert.ok(!$('inspector').textContent.includes('old D/A/Q'));
  assert.equal(charts.get('diagnosticChart').length,0);assert.equal(charts.get('profileChart').length,0);
  assert.equal(charts.get('countChart')[0].length,0);assert.equal(charts.get('countChart')[1].length,0);
  assert.equal(context.runWorker,null);assert.equal(context.evalWorker,null);assert.equal(context.hoverWorker,null);
});

function runUiContext(total=120) {
  const nodes=new Map(),posted=[],drawn=[],errors=[];
  const $=id=>{if (!nodes.has(id)) nodes.set(id,{dataset:{}});return nodes.get(id);};
  const snapshotInput={value:String(total)},elements=[];elements.namedItem=()=>snapshotInput;$('sweepSettings').elements=[];
  const state={generation:1,busy:true,mode:'running',scenario:{input:{snapshots:total}},
    next:0,frames:[],evaluations:[],selected:0,followLive:true,sweepRuns:[],valid:true};
  const context=vm.createContext({state,$,form:{elements},document:{body:{dataset:{}}},DEFAULT_INPUT,
    runWorker:{postMessage:message=>posted.push({...message})},
    renderSelected:()=>drawn.push(state.selected),notice:text=>{$('status').textContent=text;},
    hashField:async()=> 'completed-hash',requestAnimationFrame:()=>assert.fail('UI receipt must not depend on a repaint'),
    fail:error=>errors.push(error),makeWorker:()=>assert.fail('Only prepared messages create inspection workers'),
  });
  vm.runInContext(section('function controls()','function cancel(')+section('async function receiveRunMessage(','async function hashField('),context);
  return {context,state,$,posted,drawn,errors};
}

test('UI receives every background result without requesting or acknowledging any next snapshot',async()=>{
  const {context,state,$,posted,errors}=runUiContext();
  const frames=Array.from({length:120},(_,i)=>({t:i+1}));
  for (const [i,frame] of frames.entries()) {
    if (i===5) {state.selected=2;state.followLive=false;}
    await context.receiveRunMessage({type:'frame',requestId:1,frame,evaluation:{t:frame.t},next:i+1},1);
  }
  await context.receiveRunMessage({type:'status',requestId:1,mode:'done',next:120,total:120},1);
  assert.deepEqual(errors,[]);assert.deepEqual(posted,[],'Rendering is never an acknowledgement required by the worker');
  assert.deepEqual(state.frames,frames);assert.deepEqual(state.evaluations.map(e=>e.t),frames.map(f=>f.t));
  assert.equal(state.selected,2,'A manual selection survives background results');
  assert.equal(state.mode,'done');assert.equal(state.busy,false);assert.equal($('runProgress').value,120);
  assert.equal($('mapCanvas').dataset.fieldHash,'completed-hash');assert.match($('status').textContent,/Complete · 120/);
});

test('Pause, Step and Resume send explicit commands and wait for worker status before enabling another step',async()=>{
  const {context,state,$,posted,errors}=runUiContext(4);
  context.commandRun('pause');
  assert.equal(state.mode,'paused');assert.equal(state.busy,true);assert.equal($('stepButton').disabled,true);
  context.commandRun('step');assert.equal(posted.length,1,'A pause request does not mean the worker has stopped yet');
  await context.receiveRunMessage({type:'frame',requestId:1,frame:{t:1},evaluation:{},next:1},1);
  assert.equal(state.mode,'paused');assert.equal(state.busy,true);assert.equal(state.frames.length,1,'Keep the snapshot already in flight');
  await context.receiveRunMessage({type:'status',requestId:1,mode:'paused',next:1,total:4},1);
  assert.equal(state.busy,false);assert.equal($('stepButton').disabled,false);
  state.followLive=false;context.commandRun('step');context.commandRun('step');
  assert.equal(posted.length,2,'A second click cannot queue a duplicate single step');assert.equal(state.followLive,true);
  await context.receiveRunMessage({type:'frame',requestId:1,frame:{t:2},evaluation:{},next:2},1);
  await context.receiveRunMessage({type:'status',requestId:1,mode:'paused',next:2,total:4},1);
  assert.equal(state.frames.length,2);assert.equal(state.busy,false);assert.equal(state.mode,'paused');
  context.commandRun('resume');
  assert.equal(state.mode,'running');assert.equal(state.busy,true);assert.equal($('stepButton').disabled,true);
  assert.deepEqual(posted,[{type:'pause',requestId:1},{type:'step',requestId:1},{type:'resume',requestId:1}]);
  assert.deepEqual(errors,[]);
});

test('hidden charts defer rendering and visibility return refreshes the current selection and sweep without advancing',()=>{
  const events=new Map(),drawn=[],sweeps=[],document={hidden:true,addEventListener:(name,fn)=>events.set(name,fn)};
  const state={selected:17,mode:'paused'};
  vm.runInNewContext(section('function renderSelected()','async function updateProfile(')+'\nrenderSelected();',{
    document,$:()=>assert.fail('Hidden chart rendering must be skipped'),
  });
  vm.runInNewContext(section("document.addEventListener('visibilitychange'","document.addEventListener('keydown'"),{
    document,state,controls(){},renderSelected:()=>drawn.push(state.selected),renderSweep:()=>sweeps.push('refreshed'),advance:()=>assert.fail('Visibility must not start computation'),
  });
  events.get('visibilitychange')();assert.deepEqual(drawn,[]);assert.deepEqual(sweeps,[]);
  document.hidden=false;events.get('visibilitychange')();
  assert.deepEqual(drawn,[17]);assert.deepEqual(sweeps,['refreshed']);assert.equal(state.mode,'paused');
});

test('server connection failure blocks both comparison and sweep instead of using browser computation',()=>{
  const {context,state,$}=runUiContext();
  state.mode='idle';state.connecting=true;context.controls();
  assert.equal($('runButton').disabled,true);assert.equal($('stepButton').disabled,true);assert.equal($('sweepButton').disabled,true);
});

test('failed server commands recover actual controls without cancelling the job',async()=>{
  const {context,state,$,posted,errors}=runUiContext(4);state.server={};state.mode='paused';state.busy=false;
  context.commandRun('resume');assert.equal(state.mode,'running');assert.equal($('pauseButton').disabled,true);
  await context.receiveRunMessage({type:'command-error',command:'resume',message:'Network error',job:{status:'paused'},requestId:1},1);
  assert.equal(state.mode,'paused');assert.equal(state.busy,false);assert.equal($('stepButton').disabled,false);
  context.commandRun('step');
  await context.receiveRunMessage({type:'command-error',command:'step',message:'Network error',job:null,recoveryError:'Offline',requestId:1},1);
  assert.equal(state.mode,'paused');assert.equal(state.busy,false);assert.match($('status').textContent,/reload to reconnect/);
  assert.deepEqual(posted.map(p=>p.type),['resume','step']);assert.deepEqual(errors,[]);
});

test('stale worker notifications cannot change a cancelled or replacement run',async()=>{
  const {context,state,$,posted,errors}=runUiContext();
  const original={...state};state.generation=2;state.mode='cancelled';state.busy=false;
  for (const data of [
    {type:'progress',t:70,total:120},
    {type:'prepared',scenario:{input:{snapshots:120}},grid:{}},
    {type:'frame',frame:{t:1},evaluation:{},next:1},
    {type:'status',mode:'done',next:120,total:120},
    {type:'error',message:'Late worker error'},
  ]) {
    await context.receiveRunMessage({...data,requestId:1},1);
    await context.receiveRunMessage({...data,requestId:1},2);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(posted,[]);
  assert.equal(state.frames,original.frames);assert.equal(state.evaluations,original.evaluations);assert.equal(state.scenario,original.scenario);
  assert.equal(state.frames.length,0);assert.equal(state.next,0);assert.equal(state.selected,0);assert.equal(state.mode,'cancelled');
  assert.equal($('mapCanvas').dataset.fieldHash,undefined);
});

test('cancellation during result hashing cannot overwrite the next run completion state',async()=>{
  const {context,state,$,errors}=runUiContext(1);let release;
  state.frames=[{t:1}];state.next=1;
  context.hashField=()=>new Promise(resolve=>{release=resolve;});
  const done=context.receiveRunMessage({type:'status',requestId:1,mode:'done',next:1,total:1},1);
  assert.equal(state.mode,'done');assert.equal(typeof release,'function');
  state.generation++;state.mode='running';$('status').textContent='New run';
  release('old-result-hash');await done;
  assert.equal($('mapCanvas').dataset.fieldHash,undefined);assert.equal($('status').textContent,'New run');
  assert.equal(state.mode,'running');assert.deepEqual(errors,[]);
});

test('out-of-order results fail explicitly rather than mislabelling the measured prefix',async()=>{
  const {context,state,errors}=runUiContext();
  await context.receiveRunMessage({type:'frame',requestId:1,frame:{t:2},evaluation:{},next:2},1);
  assert.equal(errors.length,1);assert.match(errors[0].message,/Out-of-order/);
  assert.equal(state.frames.length,0);assert.equal(state.evaluations.length,0);assert.equal(state.next,0);
});
