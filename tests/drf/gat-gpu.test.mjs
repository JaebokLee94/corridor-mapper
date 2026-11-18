import test from 'node:test';
import assert from 'node:assert/strict';
import {GatGpr} from '../../drf/gat-gpr.mjs';
import {createGatGpu,gatDenseBlockSize,gatDenseShader} from '../../drf/gat-gpu.mjs';
import {neuralRuntime} from '../../drf/model-runtime.mjs';
import {experimentSettings} from '../../drf/experiment-settings.mjs';
import {createSceneGeometry,generateSnapshot} from '../../drf/scenario.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
  const input=experimentSettings({scene:'paper-upper',vehicles:3,snapshots:16,seed:3296639392,sigmaDGeometry:3});
  const scene=createSceneGeometry(input);
  return Array.from({length:16},(_,i)=>generateSnapshot(input,scene.spans,i+1,scene.wallModel).wire);
}

test('GAT dense and reused one-by-one convolution kernels agree across panels and tails',async()=>{
  const rt=await neuralRuntime('gat');
  for(const [name,weight] of Object.entries(rt.weights)){
    if(!(/\.W$|\.weight$/.test(name)))continue;
    const [inc,out]=weight.shape;
    for(const rows of [1,2,3,4,5,17,64,257]){
      const input=Float32Array.from({length:rows*inc},(_,i)=>Math.sin(i*.3745)*2.4);
      const dense=rt.call('multiply',[input,weight.values],rows*out,[rows,inc,out]);
      const convolution=rt.call('convolution',[input,weight.values,new Float32Array(out)],rows*out,[1,rows,inc,out,1,1]);
      assert.deepEqual(convolution,dense,name+' rows='+rows);
    }
  }
});

test('Eigen GEMV and GEMM reduction schedules reproduce frozen GAT WASM projections',async()=>{
  const rt=await neuralRuntime('gat'),f=Math.fround;
  assert.equal(gatDenseBlockSize(1024),520);
  assert.equal(gatDenseBlockSize(432),432);
  assert.match(gatDenseShader(1024,256),/select\(520u,16u,cfg.rows==1u\)/);
  for(const [name,weight] of Object.entries(rt.weights)){
    if(!(/\.W$|\.weight$/.test(name)))continue;
    const [inc,out]=weight.shape;
    for(const rows of [1,2,3,4,5,12,17,64,257,1023,1024,1025,2047,2048,2049]){
      const input=Float32Array.from({length:rows*inc},(_,i)=>Math.sin(i*.3745)*2.4);
      const expected=rt.call('multiply',[input,weight.values],rows*out,[rows,inc,out]);
      const block=rows===1?(inc<128?inc:16):gatDenseBlockSize(inc);
      const selectedRows=rows>257?[0,1,2,3,4,255,256,257,511,512,513,rows-5,rows-4,rows-3,rows-2,rows-1]:Array.from({length:rows},(_,i)=>i);
      for(const r of selectedRows)for(let c=0;c<Math.min(out,16);c++){
        let value=0;
        for(let start=0;start<inc;start+=block){
          const end=Math.min(start+block,inc),peel=end-(end-start)%8;let even=0,odd=0,k=start;
          if(rows>1&&r<Math.floor(rows/4)*4){
            for(;k<peel;k+=2){
              even=f(even+f(input[r*inc+k]*weight.values[k*out+c]));
              odd=f(odd+f(input[r*inc+k+1]*weight.values[(k+1)*out+c]));
            }
            even=f(even+odd);
          }
          for(;k<end;k++)even=f(even+f(input[r*inc+k]*weight.values[k*out+c]));
          value=f(value+even);
        }
        assert.equal(value,expected[r*out+c],name+' rows='+rows+' index='+[r,c]);
      }
    }
  }
});

test('GAT async projections preserve every prefix and recover once after a partial GPU failure',async()=>{
  const rt=await neuralRuntime('gat'),wires=fixture();
  for(const failAt of [Infinity,10]){
    const model=new GatGpr(rt,3),reference=new GatGpr(rt,3);let closed=0;
    const gpu=model.gpu={completedCalls:0,async multiply(input,name,rows){
      if(this.completedCalls===failAt)throw new Error('test GPU loss');
      const weight=rt.weights[name];this.completedCalls++;
      return rt.call('multiply',[input,weight.values],rows*weight.shape[1],[rows,...weight.shape]);
    },close(){closed++;}};
    for(const wire of wires){
      assert.deepEqual(await model.stepAsync(wire),reference.step(wire));
      assert.deepEqual(model.pairs,reference.pairs,'each accepted observation is committed once');
    }
    assert.ok(model.curve.length);
    assert.equal(gpu.completedCalls%7,failAt===Infinity?0:3);
    const before=gpu.completedCalls,empty={t:17,configs:wires.at(-1).configs.map(c=>({...c,paths:[]}))};
    assert.deepEqual(await model.stepAsync(empty),reference.step(empty));assert.equal(gpu.completedCalls,before);
    if(failAt!==Infinity){
      assert.equal(model.gpu,null);assert.equal(model.gpuCallsBeforeLoss,10);
      assert.match(model.gpuFallbackReason,/test GPU loss/);assert.equal(closed,1);
    }
    model.close();reference.close();
  }
});

test('closing a pending GAT projection rejects without committing reflection points',async()=>{
  const rt=await neuralRuntime('gat'),model=new GatGpr(rt,3),wires=fixture(),gate=deferred(),started=deferred();
  for(const wire of wires.slice(0,3))model.observe(wire);
  const before=[...model.pairs.values()].reduce((n,p)=>n+p.points.length,0);
  model.gpu={completedCalls:0,multiply(){started.resolve();return gate.promise;},close(){gate.reject(new Error('closed readback'));}};
  const result=model.stepAsync(wires[3]);await started.promise;model.close();
  await assert.rejects(result,/closed readback/);
  assert.equal([...model.pairs.values()].reduce((n,p)=>n+p.points.length,0),before);
});

function environment(gpu){
  const names=['navigator','GPUBufferUsage','GPUShaderStage','GPUMapMode'],old=names.map(k=>Object.getOwnPropertyDescriptor(globalThis,k));
  const values=[{gpu},{STORAGE:1,COPY_DST:2,COPY_SRC:4,MAP_READ:8,UNIFORM:16},{COMPUTE:1},{READ:1}];
  names.forEach((k,i)=>Object.defineProperty(globalThis,k,{value:values[i],configurable:true}));
  return ()=>names.forEach((k,i)=>old[i]?Object.defineProperty(globalThis,k,old[i]):delete globalThis[k]);
}

// This mock tests resource/control flow only; actual WGSL arithmetic is calibrated in-browser.
function mockGpu(){
  const lost=deferred(),state={buffers:[],submissions:0};
  const device={limits:{maxBufferSize:1<<28,maxStorageBufferBindingSize:1<<27,maxComputeWorkgroupsPerDimension:65535},lost:lost.promise,
    createBuffer({size}){const b={data:new ArrayBuffer(size),mapState:'unmapped',destroyed:false,
      destroy(){this.destroyed=true;},async mapAsync(){if(this.destroyed)throw new Error('destroyed');this.mapState='mapped';},
      getMappedRange(offset,size){return this.data.slice(offset,offset+size);},unmap(){this.mapState='unmapped';}};state.buffers.push(b);return b;},
    createShaderModule(v){return v;},createBindGroupLayout(v){return v;},createPipelineLayout(v){return v;},
    async createComputePipelineAsync(v){return v;},createBindGroup(v){return v;},
    createCommandEncoder(){const copies=[];return {beginComputePass(){return {setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}};},
      copyBufferToBuffer(a,ai,b,bi,n){copies.push(()=>new Uint8Array(b.data,bi,n).set(new Uint8Array(a.data,ai,n)));},finish(){return copies;}};},
    queue:{writeBuffer(b,offset,a){assert(!b.destroyed);new Uint8Array(b.data,offset,a.byteLength).set(new Uint8Array(a.buffer,a.byteOffset,a.byteLength));},
      submit(commands){state.submissions++;for(const copies of commands)for(const copy of copies)copy();}},destroy(){lost.resolve({message:'device destroyed'});}};
  return {state,lost,gpu:{requestAdapter:async()=>({info:{description:'mock'},requestDevice:async()=>device})}};
}
function zeroRuntime(){
  const names=['gat.0.W','gat.1.W','gat.2.W','gat.3.W','mlp.0.weight','mlp.2.weight','mlp.4.weight'];
  return {weights:Object.fromEntries(names.map(n=>[n,{shape:[2,4],values:new Float32Array(8)}])),
    call(_name,_inputs,n){return new Float32Array(n);}};
}

test('GAT GPU calibrates outside live counters, reuses buffers, and validates dimensions',async()=>{
  const f=mockGpu(),restore=environment(f.gpu),backend=createGatGpu(zeroRuntime());
  try{
    await backend.ready;assert.equal(f.state.submissions,64);assert.equal(backend.completedCalls,0);
    const input=new Float32Array(10).fill(.75),before=input.slice();
    const a=await backend.multiply(input,'gat.0.W',5),allocations=f.state.buffers.length;
    const b=await backend.multiply(input,'gat.0.W',5);
    assert.deepEqual(a,new Float32Array(20));assert.deepEqual(b,a);assert.deepEqual(input,before);
    assert.equal(f.state.buffers.length,allocations);assert.equal(backend.completedCalls,2);
    assert.equal(backend.completedReadbacks,2);assert.equal(backend.inputBytes,80);assert.equal(backend.outputBytes,160);
    await assert.rejects(backend.multiply(new Float32Array(9),'gat.0.W',5),/Invalid/);
    assert.equal(backend.completedCalls,2);
  }finally{backend.close();restore();}
  assert(f.state.buffers.every(b=>b.destroyed));
});

test('GAT GPU rejects calibration mismatch and records unsupported CPU fallback',async()=>{
  const f=mockGpu(),restore=environment(f.gpu),rt=zeroRuntime();
  rt.call=(_name,_inputs,n)=>new Float32Array(n).fill(1);
  const backend=createGatGpu(rt);
  try{await assert.rejects(backend.ready,/did not reproduce GAT/);assert(backend.closed);assert(f.state.buffers.every(b=>b.destroyed));}
  finally{backend.close();restore();}
  const restoreMissing=environment(undefined);
  try{
    assert.equal(createGatGpu(zeroRuntime()),null);
    const model=new GatGpr(await neuralRuntime('gat'),3);
    assert.equal(await model.useGpu(),false);assert.match(model.gpuFallbackReason,/unavailable/);
  }finally{restoreMissing();}
});
