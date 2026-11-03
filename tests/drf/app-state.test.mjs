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

test('actual full run and single steps preserve the requested length and use the declared experiment domain',async()=>{
  for (const [single,requested] of [[false,60],[true,60],[false,80]]) {
    const expected=requested,input={scene:'layered',vehicles:10,snapshots:requested,grid:150,band:4,perimeter:'exact'},generated=[],filled=[],advanced=[];
    const state={generation:0,scenario:null,mode:'idle'},location={hash:'#v1=old'};
    const context=vm.createContext({state,location,DEFAULT_INPUT:{snapshots:80},
      settings:()=>({...input}),fillSettings:value=>filled.push({...value}),
      cancel:()=>{state.generation++;},controls(){},notice(){},createGrid:(nx,ny,domain)=>({nx,ny,domain}),
      makeWorker:name=>({stop(){},async request(message){
        if (name==='scenario') {generated.push({...message.input});return {scenario:{input:message.input,domain:[0,80,-20,50]}};}
        return {};
      }}),advance:value=>advanced.push(value??false),fail:error=>{throw error;},
    });
    vm.runInContext(section('async function prepare(','function fail('),context);
    await context.prepare(single);
    assert.equal(generated.length,1);
    assert.equal(generated[0].snapshots,expected,'Generate the same length stored in the URL');
    assert.equal(state.scenario.input.snapshots,expected);
    assert.equal(JSON.parse(decodeURIComponent(location.hash.slice(3))).snapshots,expected);
    assert.equal(generated[0].vehicles,10,'Preserve the restored vehicle count');
    assert.deepEqual(filled,[],'Respect the experiment length shown in the settings');
    assert.deepEqual(state.grid.domain,[0,80,-20,50],'Pass the predeclared domain without consulting truth wall bounds');
    assert.deepEqual(advanced,[single]);
    assert.equal(state.mode,single ? 'paused' : 'running');
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
  const nodes=new Map(),pending=new Map(),charts=new Map();let nextFrame=0,stoppedWorkers=0,cancelledSweeps=0,fitCalls=0,releaseField;
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
    fieldWorker:{},evalWorker:{},hoverWorker:{},psptWorker:{},DEFAULT_INPUT:{snapshots:60},LAYERED_DOMAIN,location:{hash:'#old'},
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
    section('async function advance(','async function hashField('),
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
  state.scenario.wire=Array.from({length:5},()=>({}));
  context.fieldWorker={request:()=>new Promise(resolve=>{releaseField=resolve;})};context.evalWorker={request:async()=>({evaluation:{}})};
  const predictedCandidates=[{id:'1:h',center:[10,20],status:'pending'}];
  context.psptWorker={request:async message=>{assert.deepEqual(Object.keys(message).sort(),['snapshot','type']);assert.equal(message.snapshot,state.scenario.wire[state.next]);return {methods:{guarded:{candidates:predictedCandidates,ms:2},baseline:{candidates:[],ms:1}}};}};
  const inFlight=context.advance();assert.equal(state.busy,true);
  const beforeFit=fitCalls;assertViewOnly();assert.equal(state.selected,3);assert.equal(state.mode,'running');assert.equal(state.followLive,true);
  assert.equal(state.frames.length,3,'View reset must preserve completed records');assert.equal(fitCalls-beforeFit,4);assert.equal(pending.size,0);
  releaseField({type:'frame',requestId:1,t:4,Q:4,admitted:4,rejected:0,ms:1});await inFlight;
  assert.equal(state.frames.length,4,'An in-flight completed result must be retained');
  assert.equal(state.frames.at(-1).candidates,predictedCandidates);assert.equal(state.frames.at(-1).psptMs,2);assert.equal(state.frames.at(-1).method,'guarded-tuned');assert.equal(state.selected,4,'Live following must continue after a view reset');
  assert.equal(state.mode,'running');assert.equal(state.followLive,true);
  assert.equal(state.busy,true,'Dispatch the next snapshot without waiting for a repaint');assert.equal(pending.size,0);
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
  assert.equal(context.fieldWorker,null);assert.equal(context.evalWorker,null);assert.equal(context.hoverWorker,null);assert.equal(context.psptWorker,null);
});

test('background computation completes in causal order without animation frames; pause and step remain explicit',async()=>{
  for (const pauseAt of [0,5]) {
    const total=120,nodes=new Map(),calls=[],errors=[];
    const $=id=>{if (!nodes.has(id)) nodes.set(id,{dataset:{}});return nodes.get(id);};
    const state={generation:1,busy:false,mode:'running',scenario:{wire:Array.from({length:total},(_,i)=>({t:i+1,configs:[]})),input:{snapshots:total}},
      next:0,frames:[],evaluations:[],selected:0,followLive:true};
    const context=vm.createContext({state,$,controls(){},renderSelected(){},notice(){},
      fieldWorker:{request:async({snapshot})=>{calls.push(['field',snapshot.t]);return {t:snapshot.t,Dbar:[],betaHat:[]};}},
      psptWorker:{request:async message=>{
        assert.deepEqual(Object.keys(message).sort(),['snapshot','type'],'Only the current measured snapshot reaches the estimator');
        assert.equal(message.snapshot.t,state.evaluations.length+1,'Evaluate each prefix before dispatching the next');
        calls.push(['methods',message.snapshot.t]);
        if (message.snapshot.t===pauseAt) state.mode='paused';
        return {methods:{guarded:{candidates:[],ms:1},baseline:{candidates:[],ms:1}}};
      }},
      evalWorker:{request:async({frame})=>{calls.push(['evaluate',frame.t]);return {evaluation:{t:frame.t}};}},
      hashField:async()=> 'completed-hash',requestAnimationFrame:()=>{throw new Error('No repaint callbacks in a hidden tab');},
      fail:error=>errors.push(error),
    });
    vm.runInContext(section('async function advance(','async function hashField('),context);
    const settle=async()=>{for (let i=0;i<total*10;i++) await Promise.resolve();assert.deepEqual(errors,[]);};
    await context.advance();await settle();
    if (pauseAt) {
      assert.equal(state.frames.length,pauseAt,'Pause retains the in-flight snapshot and stops further dispatch');
      assert.equal(state.busy,false);assert.equal(state.mode,'paused');
      await context.advance();await settle();assert.equal(state.frames.length,pauseAt,'Hidden tabs do not implicitly resume a paused run');
      await context.advance(true);await settle();
      assert.equal(state.frames.length,pauseAt+1,'Single step computes exactly one snapshot');assert.equal(state.mode,'paused');
      state.followLive=false;state.selected=2;state.mode='running';await context.advance();await settle();
    }
    assert.equal(state.mode,'done');assert.equal(state.busy,false);assert.equal(state.frames.length,total);
    assert.equal(state.selected,pauseAt ? 2 : total,'Preserve a manually selected snapshot while computing in the background');
    assert.equal($('mapCanvas').dataset.fieldHash,'completed-hash');
    assert.deepEqual(calls,Array.from({length:total},(_,i)=>[['field',i+1],['methods',i+1],['evaluate',i+1]]).flat());
    assert.deepEqual(state.evaluations.map(e=>e.t),Array.from({length:total},(_,i)=>i+1));
  }
});

test('hidden charts defer rendering and visibility return refreshes the current selection without advancing',()=>{
  const events=new Map(),drawn=[],document={hidden:true,addEventListener:(name,fn)=>events.set(name,fn)};
  const state={selected:17,mode:'paused'};
  vm.runInNewContext(section('function renderSelected()','async function updateProfile(')+'\nrenderSelected();',{
    document,$:()=>assert.fail('Hidden chart rendering must be skipped'),
  });
  vm.runInNewContext(section("document.addEventListener('visibilitychange'","document.addEventListener('keydown'"),{
    document,state,controls(){},renderSelected:()=>drawn.push(state.selected),advance:()=>assert.fail('Visibility must not start computation'),
  });
  events.get('visibilitychange')();assert.deepEqual(drawn,[]);
  document.hidden=false;events.get('visibilitychange')();
  assert.deepEqual(drawn,[17]);assert.equal(state.mode,'paused');
});

test('cancellation ignores late PSPT or evaluator responses without retaining a partial snapshot',async()=>{
  for (const delayed of ['pspt','evaluation']) {
    let release,waiting=false,evaluationCalls=0,scheduled=0;
    const wire={t:1,configs:[]},state={generation:1,busy:false,mode:'running',scenario:{wire:[wire],input:{snapshots:1}},next:0,
      frames:[],evaluations:[],selected:0,followLive:true};
    const pause=()=>new Promise(resolve=>{release=resolve;waiting=true;});
    const context=vm.createContext({state,controls(){},renderSelected(){},notice(){},$:()=>({}),
      fieldWorker:{request:async message=>{assert.equal(message.snapshot,wire);return {type:'frame',requestId:1,t:1,Dbar:[],betaHat:[]};}},
      psptWorker:{request:async message=>{assert.deepEqual(Object.keys(message).sort(),['snapshot','type']);return delayed==='pspt' ? pause() : {methods:{guarded:{candidates:[],ms:1},baseline:{candidates:[],ms:1}}};}},
      evalWorker:{request:async()=>{evaluationCalls++;return pause();}},
      requestAnimationFrame:()=>{scheduled++;},fail:error=>{throw error;},
    });
    vm.runInContext(section('async function advance(','async function hashField('),context);
    const run=context.advance();
    for (let k=0;k<10&&!waiting;k++) await Promise.resolve();
    assert.ok(waiting,'Reach the requested worker response boundary');
    state.generation++;state.mode='cancelled';state.busy=false;
    release(delayed==='pspt' ? {candidates:[{id:'late',status:'supported'}],psptMs:1} : {evaluation:{precision:1}});
    await run;
    assert.equal(evaluationCalls,delayed==='pspt' ? 0 : 1);
    assert.deepEqual(state.frames,[]);assert.deepEqual(state.evaluations,[]);
    assert.equal(state.next,0);assert.equal(state.selected,0);assert.equal(state.mode,'cancelled');assert.equal(scheduled,0);
  }
});
