// Resource/control-flow tests. The mock does not claim to execute WGSL;
// actual device arithmetic is independently calibrated by the backend itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {convolutionShader} from '../../drf/arc-gpu.mjs';
import {createSplineCnnGpu} from '../../drf/spline-cnn-gpu.mjs';
import {splineCnnProposal} from '../../drf/echospline-cnn.mjs';
import {EchoComparison} from '../../drf/echo-comparison.mjs';
import {neuralRuntime} from '../../drf/model-runtime.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function environment(gpu){
  const names=['navigator','GPUBufferUsage','GPUShaderStage','GPUMapMode'],old=names.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
  const values=[{gpu},{STORAGE:1,COPY_DST:2,COPY_SRC:4,MAP_READ:8,UNIFORM:16},{COMPUTE:1},{READ:1}];
  names.forEach((k,i)=>Object.defineProperty(globalThis,k,{value:values[i],configurable:true}));
  return ()=>names.forEach((k,i)=>old[i]?Object.defineProperty(globalThis,k,old[i]):delete globalThis[k]);
}
function fakeGpu(){
  const loss=deferred(),state={buffers:[],submissions:0,maps:0,destroyed:0,blockMap:null,mapBlocked:deferred()};
  const device={limits:{maxBufferSize:1<<28,maxStorageBufferBindingSize:1<<27,maxComputeWorkgroupsPerDimension:65535},lost:loss.promise,
    createBuffer({size}){const b={data:new ArrayBuffer(size),mapState:'unmapped',destroyed:false,
      destroy(){this.destroyed=true;this.mapState='unmapped';},
      async mapAsync(){assert.equal(this.mapState,'unmapped');this.mapState='pending';state.maps++;
        if(state.blockMap){const gate=state.blockMap;state.blockMap=null;state.mapBlocked.resolve();await gate.promise;}
        if(this.destroyed)throw new Error('mapped buffer destroyed');this.mapState='mapped';},
      getMappedRange(offset,size){assert.equal(this.mapState,'mapped');return this.data.slice(offset,offset+size);},
      unmap(){this.mapState='unmapped';}};state.buffers.push(b);return b;},
    createShaderModule(v){return v;},createBindGroupLayout(v){return v;},createPipelineLayout(v){return v;},
    async createComputePipelineAsync(v){return {...v,getBindGroupLayout(){return {};}};},createBindGroup(v){return v;},
    createCommandEncoder(){const copies=[];return {beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}};},
      copyBufferToBuffer(a,ai,b,bi,n){copies.push(()=>new Uint8Array(b.data,bi,n).set(new Uint8Array(a.data,ai,n)));},finish(){return copies;}};},
    queue:{writeBuffer(b,offset,a){assert(!b.destroyed);new Uint8Array(b.data,offset,a.byteLength).set(new Uint8Array(a.buffer,a.byteOffset,a.byteLength));},
      submit(commands){state.submissions++;for(const copies of commands)for(const copy of copies)copy();}},
    destroy(){state.destroyed++;loss.resolve({message:'device destroyed'});}};
  const adapter={info:{description:'mock lifecycle device'},requestDevice:async()=>device};
  return {state,device,adapter,loss,gpu:{requestAdapter:async()=>adapter}};
}
function runtime(width=32,channels=26){
  const dilations=[[1,2],[2,4],[4,8],[8,16],[12,24],[20,40]],weights={};
  for(const [name,k,inc,out] of [['start',3,channels,width],...dilations.map((_,i)=>['blocks.'+i,3,width,width]),['end',1,width,1]]){
    weights[name+'.weight']={shape:[k,k,inc,out],values:new Float32Array(k*k*inc*out)};
    weights[name+'.bias']={shape:[out],values:new Float32Array(out)};
  }
  return {data:{dilations},weights,call(_name,_inputs,n){return new Float32Array(n);}};
}

test('Arc default shader text is unchanged and XY dilation is explicit',()=>{
  // Frozen text hashes from the pre-change Arc generator, independent of Git HEAD.
  const fixtures=[
    [[9,16,3,1],'0b175d79c675c50cafc4fb2735a1ca17ecb68901ce2b61072e5f9414127f1f48'],
    [[16,32,3,2],'b0383d45a8978f487ed0ff93a896be3b2b121a26cb649b7c8e1af31f115721bc'],
    [[32,32,3,1,true],'358e793c5e8878e5ab3fdb49a7a15fa4a864cc3ebdcd8c65a7eeef11a639434e'],
    [[16,1,1,1],'fbc20915f0933bf2d4d47d011be32dbb94ca5da336c44971911bc17aef680d0a'],
  ];
  for(const [args,sha] of fixtures)assert.equal(createHash('sha256').update(convolutionShader(...args)).digest('hex'),sha);
  const xy=convolutionShader(26,64,3,3,false,5);
  assert(xy.includes('let sy = y + (ky - 1) * 5;'));assert(xy.includes('let dx = (kx - 1) * 3;'));
});

test('unsupported GPU returns null without starting work',()=>{
  const restore=environment(undefined);try{assert.equal(createSplineCnnGpu(runtime()),null);}finally{restore();}
});

for(const [width,channels] of [[32,26],[64,26],[64,23]])test(`width${width}/input${channels}: one submit/readback, resident reuse, serialization and raw-logit contract`,async()=>{
  const f=fakeGpu(),restore=environment(f.gpu),backend=createSplineCnnGpu(runtime(width,channels));
  try{
    await backend.ready;
    const submits=f.state.submissions,maps=f.state.maps;
    const input=new Float32Array(channels*81*41).fill(.75),original=input.slice();
    const first=await backend.estimate(input,41),allocated=f.state.buffers.length;
    assert(first.every(v=>v===0),'raw zero-weight logits must not subtract the input prior');
    await Promise.all([backend.estimate(input,41),backend.estimate(input,41)]);
    assert.equal(f.state.buffers.length,allocated,'same dimensions reuse device buffers');
    assert.equal(f.state.submissions-submits,3);assert.equal(f.state.maps-maps,3);assert.equal(backend.completedCalls,3);
    assert.equal(backend.completedReadbacks,3);assert.equal(backend.inputBytes,3*input.byteLength);assert.deepEqual(input,original);
    await assert.rejects(backend.estimate(new Float32Array(1),41),/Invalid/);
    const smaller=await backend.estimate(new Float32Array(channels*81*37),37);assert.equal(smaller.length,81*37);
    assert(f.state.buffers.slice(allocated-6,allocated).every(b=>b.destroyed),'resize releases previous workspace');
  }finally{backend.close();restore();}
  assert(f.state.buffers.every(b=>b.destroyed));assert.equal(f.state.destroyed,1);
});

test('close during adapter/device initialization disposes a late-created device',async()=>{
  const f=fakeGpu(),gate=deferred();f.adapter.requestDevice=()=>gate.promise;
  const restore=environment(f.gpu),backend=createSplineCnnGpu(runtime());
  try{
    await Promise.resolve();backend.close();gate.resolve(f.device);
    await assert.rejects(backend.ready,/closed/);assert.equal(f.state.destroyed,1);assert.equal(f.state.buffers.length,0);
  }finally{backend.close();restore();}
});

test('close before an adapter arrives never creates a device',async()=>{
  const f=fakeGpu(),gate=deferred();f.gpu.requestAdapter=()=>gate.promise;
  const restore=environment(f.gpu),backend=createSplineCnnGpu(runtime());
  try{backend.close();gate.resolve(f.adapter);await assert.rejects(backend.ready,/closed/);assert.equal(f.state.destroyed,0);}
  finally{restore();}
});

test('device loss and close during mapped readback reject for caller CPU fallback',async()=>{
  const f=fakeGpu(),restore=environment(f.gpu),backend=createSplineCnnGpu(runtime());
  try{
    await backend.ready;const gate=deferred();f.state.blockMap=gate;
    const result=backend.estimate(new Float32Array(26*81*41),41);
    await f.state.mapBlocked.promise;backend.close();gate.resolve();await assert.rejects(result,/destroyed|closed/);
    assert.equal(backend.completedCalls,0);assert(f.state.buffers.every(b=>b.destroyed));
  }finally{backend.close();restore();}
  const g=fakeGpu(),restore2=environment(g.gpu),other=createSplineCnnGpu(runtime());
  try{await other.ready;g.loss.resolve({message:'test device lost'});await Promise.resolve();await assert.rejects(other.estimate(new Float32Array(26*81*41),41),/lost/);assert(other.closed);}
  finally{other.close();restore2();}
});


for(const rightMethod of ['spline-cnn','spline-cnn-fast'])test(`${rightMethod} awaits the CNN branch independently of the Arc GPU flag`,async()=>{
  const model=new EchoComparison({scene:'paper-upper',vehicles:3,rightMethod},[0,100,-20,50]);
  const details={token:'shared fit'},left={curves:[[[0,4],[.2,4]]],fit:details},right={curves:[[[0,5],[.2,5]]],candidates:[]};
  let supplied;
  model.stepLeft=()=>left;
  model.stepRight=(_wire,shared)=>{supplied=shared.fit;return Promise.resolve(right);};
  const output=await model.step({t:1});
  assert.equal(supplied,details,'right branch consumes the shared fit before it is hidden from output');
  assert.equal(output.guarded,right);assert.equal(typeof output.guarded.then,'undefined');
  assert.equal(output.echoSpline,left);assert(!Object.hasOwn(left,'fit'));
  model.close();
});

const fitFixture=()=>({x:[0,.2,.4],heights:new Float64Array([4,4,4]),points:[]});
const anchorFixture=[[[0,4],[.2,4],[.4,4]]];
const evidenceFixture={points:[[],[]],configs:[],links:3,sign:1};

test('CNN device failure uses one CPU fallback and preserves the measured-prefix result',async()=>{
  const rt=runtime(),calls=[];rt.data.penalty=.5;
  rt.call=(name,_inputs,n)=>{calls.push(name);return new Float32Array(n);};
  let closed=0;
  rt.gpu={completedCalls:3,estimate:()=>Promise.reject(new Error('lost device')),close(){closed++;}};
  const fit=fitFixture(),before=JSON.stringify(fit),actual=await splineCnnProposal(rt,fit,anchorFixture,evidenceFixture);
  assert.equal(rt.gpu,null);assert.equal(rt.gpuCallsBeforeLoss,3);assert.equal(closed,1);
  assert.equal(calls.filter(k=>k==='convolutionXY').length,8);
  assert.deepEqual(Array.from(actual.base),[4,4,4]);assert.equal(JSON.stringify(fit),before);
});

test('cancelling a pending CNN readback propagates rejection without CPU recomputation',async()=>{
  const rt=runtime(),gate=deferred(),calls=[];rt.data.penalty=.5;
  rt.call=(name,_inputs,n)=>{calls.push(name);return new Float32Array(n);};
  rt.gpu={estimate:()=>gate.promise,close(){}};
  const result=splineCnnProposal(rt,fitFixture(),anchorFixture,evidenceFixture);
  rt.closed=true;rt.gpu.close();gate.reject(new Error('cancelled readback'));
  await assert.rejects(result,/cancelled readback/);
  assert.equal(calls.filter(k=>k==='convolutionXY').length,0);
});

for(const [id,channels] of [['spline-cnn',26],['spline-cnn-fast',23]])test(`${id}: GPU receives the same canonical features as CPU CNN`,async()=>{
  const rt=await neuralRuntime(id),call=rt.call;
  let cpuInput,gpuInput,rangeCalls=0,convolutionCalls=0;
  rt.call=(name,inputs,...args)=>{
    if(name==='rangeVotes')rangeCalls++;
    if(name==='convolutionXY'){convolutionCalls++;cpuInput??=inputs[0].slice();}
    return call(name,inputs,...args);
  };
  const evidence={...evidenceFixture,configs:[{pHat_i:[0,0],pHat_j:[0,0],Sigma_i:[0,0,0],Sigma_j:[0,0,0],
    paths:[{dHat:8,sigmaD:.4}]}]};
  splineCnnProposal(rt,fitFixture(),anchorFixture,evidence);
  const gpu={
    get rangeImage(){throw new Error('GPU range arithmetic must not influence CNN input');},
    async estimate(input,n){assert.equal(n,3);gpuInput=input.slice();return new Float32Array(81*n);},
    close(){assert.fail('canonical range features must not trigger GPU fallback');},
  };
  rt.gpu=gpu;
  await splineCnnProposal(rt,fitFixture(),anchorFixture,evidence);
  assert.equal(rt.gpu,gpu);assert.equal(rangeCalls,channels===26?2:0);assert.equal(convolutionCalls,8);
  assert.equal(cpuInput.length,81*3*channels);
  if(channels===26)assert.ok(cpuInput[(40*3)*26+18]>0,'the range evidence must be nonzero');
  assert.deepEqual(gpuInput,cpuInput,'changing CNN backend must not change any input channel');
});

for(const rightMethod of ['spline-cnn','spline-cnn-fast'])test(`${rightMethod} records the completed invocation and retains only needed configurations`,async()=>{
  const model=new EchoComparison({scene:'paper-upper',vehicles:3,rightMethod},[0,100,-20,50],'guarded');
  const wire=t=>({t,configs:[[1,2],[1,3],[2,3]].map(([i,j])=>({i,j,pHat_i:[i,0],pHat_j:[j,0],Sigma_i:[0,0,0],Sigma_j:[0,0,0],paths:[{dHat:10,sigmaD:.4}]}))});
  let observed=0;
  model.cnn={gpu:{completedCalls:0,close(){}}};model.fixedSpline={step:()=>({fit:{}}),observe:()=>{observed++;}};
  model.correctedMap=async()=>{model.cnn.gpu.completedCalls++;return {curves:[],candidates:[]};};
  const first=await model.stepRight(wire(1)),second=await model.stepRight(wire(2));
  assert.equal(first.backend,'WebGPU + CPU');assert.equal(first.gpuCallsThisStep,1);assert.equal(first.gpuCalls,1);
  // Stride-4 cadence: t=2 records the observation and holds the t=1 map without a CNN call.
  assert.equal(observed,1);assert.equal(second.gpuCallsThisStep,0);assert.equal(second.gpuCalls,1);
  assert.equal(model.id,'spline-cnn-fast');assert.equal(model.protocol.guarded.id,'spline-cnn-fast');
  assert.equal(model.cnnConfigs,undefined);assert.equal(model.lastT,2);
  assert.throws(()=>model.stepRight(wire(2)),/consecutive/);assert.equal(model.cnnConfigs,undefined);
  model.close();
});
