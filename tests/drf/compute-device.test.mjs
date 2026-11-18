import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EchoComparison } from '../../drf/echo-comparison.mjs';
import { computationDevice } from '../../drf/compute-device.mjs';
import { experimentSettings } from '../../drf/experiment-settings.mjs';
import { workerMethod } from '../../drf/method-client.mjs';
import { canonicalRightMethod } from '../../drf/right-methods.mjs';

test('CPU overrides every stage; mixed CNN and old spline GPU links remain explicit',()=>{
  for(const method of ['spline-cnn','spline-cnn-fast']){
    assert.deepEqual(computationDevice({computeDevice:'cpu',echoBackend:'gpu'},method),
      {requested:'cpu',neural:false,spline:false});
    assert.deepEqual(computationDevice({computeDevice:'gpu',echoBackend:'cpu'},method),
      {requested:'gpu',neural:true,spline:false});
    assert.equal(computationDevice({},method).neural,true);
  }
  assert.equal(computationDevice({echoBackend:'gpu'},'echoSpline').spline,true);
  assert.equal(computationDevice({},'echoSpline').spline,false);
  for(const computeDevice of ['auto','cpu','gpu']){
    const normalized=experimentSettings({computeDevice});
    assert.deepEqual(experimentSettings(normalized),normalized);
  }
  assert.throws(()=>experimentSettings({computeDevice:'cuda'}),/device/);
});

for(const rightMethod of ['spline-cnn','spline-cnn-fast'])test(`${rightMethod}: worker passes device choices and returns initialization evidence`,async()=>{
  const sent=[],worker={postMessage(message){sent.push(message);},terminate(){}};
  const input={vehicles:3,scene:'paper-upper',rightMethod,computeDevice:'gpu',echoBackend:'cpu',sigmaD:.4};
  const method=workerMethod(worker,'guarded',input,[0,100,-20,50]);
  assert.equal(sent[0].rightMethod,rightMethod);
  assert.equal(sent[0].computeDevice,'gpu');assert.equal(sent[0].echoBackend,'cpu');
  const device={neuralGpu:true,splineGpu:false,adapter:{vendor:'test'}};
  worker.onmessage({data:{type:'initialized',device}});
  assert.deepEqual(await method.ready,device);
  const pending=method.step({t:1,configs:[]});
  worker.onmessage({data:{type:'candidates',methods:{curves:[],ms:1}}});
  assert.deepEqual(await pending,{curves:[],ms:1});method.close();
});


test('Auto uses the fleet policy while explicit CPU, GPU and spline overrides retain priority',()=>{
  const neural = new Set(['spline-cnn','spline-cnn-fast','arc']), fleetSpline = new Set(['echoSpline','gbdt','spline-cnn','spline-cnn-fast']);
  for(const vehicles of [3,10])for(const method of ['echoSpline','gbdt','spline-cnn','spline-cnn-fast','arc','pair-ridge','pair-gbdt','pair-extra-trees','gat','wmp']){
    assert.deepEqual(computationDevice({vehicles},method),{requested:'auto',neural:neural.has(method)||method==='gat'&&vehicles>=10,spline:vehicles>=10&&fleetSpline.has(method)},method+'/'+vehicles);
    assert.deepEqual(computationDevice({vehicles,computeDevice:'cpu',echoBackend:'gpu'},method),{requested:'cpu',neural:false,spline:false});
    assert.equal(computationDevice({vehicles,computeDevice:'gpu'},method).spline,true);
    assert.equal(computationDevice({vehicles,computeDevice:'gpu',echoBackend:'cpu'},method).spline,false);
    assert.equal(computationDevice({vehicles,echoBackend:'cpu'},method).spline,false);
    assert.equal(computationDevice({vehicles,echoBackend:'gpu'},method).spline,true);
  }
  assert.equal(computationDevice({vehicles:9},'gat').neural,false);
  assert.equal(computationDevice({vehicles:20},'gat').neural,true);
});

test('current and migrated CNN requests initialize only the selected CPU, fleet Auto and mixed GPU stages',async()=>{
  const source=readFileSync(new URL('../../drf/echo-comparison.mjs',import.meta.url),'utf8');
  const classSource=source.slice(source.indexOf('export class EchoComparison'),source.indexOf('// Final-only runs')).replace('export class','class');
  for(const rightMethod of ['spline-cnn-fast','spline-cnn'])for(const [choice,spline,neural] of [
    [{vehicles:3},false,true], [{vehicles:10},true,true],
    [{vehicles:10,computeDevice:'cpu',echoBackend:'gpu'},false,false],
    [{vehicles:10,computeDevice:'gpu',echoBackend:'cpu'},false,true],
    [{vehicles:3,computeDevice:'gpu'},true,true],
  ]){
    const allocated={spline:0,neural:0},closed={spline:0,neural:0};
    const context=vm.createContext({computationDevice,canonicalRightMethod,echoProtocol:()=>({guarded:{}}),rightMethods:{'spline-cnn-fast':{}},
      EchoSpline:class {constructor(){this.grid={};}},modelData:async()=>({}),
      neuralRuntime:async name=>{assert.equal(name,'spline-cnn-fast');return {weights:{'start.weight':{shape:[3,3,23,64]}}};},
      createSplineGpu:async()=>{allocated.spline++;return {destroy(){closed.spline++;}};},
      createSplineCnnGpu:()=>{allocated.neural++;return {ready:Promise.resolve(),close(){closed.neural++;}};},
    });
    vm.runInContext(classSource+'\nglobalThis.Comparison=EchoComparison;',context);
    const input=Object.freeze({scene:'paper-upper',rightMethod,...choice});
    const estimator=new context.Comparison(input,[0,100,-20,50],'guarded');
    try{
      assert.equal(estimator.id,'spline-cnn-fast');assert.equal(input.rightMethod,rightMethod);
      await estimator.loadModel({useGpu:true});
      assert.deepEqual(allocated,{spline:Number(spline),neural:Number(neural)},JSON.stringify(choice));
      assert.equal(estimator.deviceInfo().splineGpu,spline);assert.equal(estimator.deviceInfo().neuralGpu,neural);
    }finally{estimator.close();}
    assert.deepEqual(closed,allocated,'Every allocated stage closes');
  }
});

test('pair estimators inherit their parent spline choice instead of reselecting the full-fleet EchoSpline Auto policy',()=>{
  const domain=[0,100,-20,50];
  for(const rightMethod of ['pair-ridge','pair-gbdt','pair-extra-trees']){
    const input={scene:'paper-upper',vehicles:10,sigmaD:.4,rightMethod};
    const pair=new EchoComparison(input,domain,'guarded');
    assert.equal(computationDevice(input,'echoSpline').spline,true);
    assert.equal(pair.deviceChoice.spline,false);assert.equal(pair.pairEstimator.deviceChoice.spline,false);
    assert.equal(pair.pairEstimator.deviceChoice.requested,'auto');pair.close();
    const forced=new EchoComparison({...input,computeDevice:'gpu'},domain,'guarded');
    assert.equal(forced.pairEstimator.deviceChoice.spline,true);forced.close();
  }
});

test('combined comparisons allocate each spline stage independently and share only matching device choices',async()=>{
  const source=readFileSync(new URL('../../drf/echo-comparison.mjs',import.meta.url),'utf8');
  const classSource=source.slice(source.indexOf('export class EchoComparison'),source.indexOf('// Final-only runs')).replace('export class','class');
  for(const [leftGpu,rightGpu] of [[false,true],[true,false],[true,true],[false,false]]){
    const allocations=[];
    const context=vm.createContext({
      computationDevice:(_input,method)=>({requested:'auto',neural:false,spline:method==='echoSpline'?leftGpu:rightGpu}),
      canonicalRightMethod,echoProtocol:()=>({guarded:{}}),rightMethods:{gbdt:{}},
      EchoSpline:class {constructor(options){this.options=options;this.grid={};}},
      modelData:async()=>({}),createSplineGpu:async()=>{const gpu={destroy(){}};allocations.push(gpu);return gpu;},
    });
    vm.runInContext(classSource+'\nglobalThis.Comparison=EchoComparison;',context);
    const estimator=new context.Comparison({scene:'paper-upper',vehicles:10,rightMethod:'gbdt'},[0,100,-20,50]);
    assert.equal(estimator.spline===estimator.fixedSpline,leftGpu===rightGpu);
    await estimator.loadModel({useGpu:true});
    assert.equal(Boolean(estimator.splineGpu),leftGpu);
    assert.equal(Boolean(estimator.fixedSplineGpu),rightGpu&&leftGpu!==rightGpu);
    assert.equal(allocations.length,Number(leftGpu)+Number(rightGpu&&leftGpu!==rightGpu));
    estimator.close();
  }
});

test('local server pages default to browser inference and server jobs require explicit opt-in',()=>{
  const source=readFileSync(new URL('../../drf/app.mjs',import.meta.url),'utf8');
  const start=source.indexOf('const serverPage ='),end=source.indexOf('if (useComputeServer)',start);
  assert.ok(start>=0&&end>start);
  for(const [protocol,meta,search,expected] of [
    ['http:','server','',false],['http:','server','?compute=browser',false],['http:','server','?compute=server',true],
    ['https:','browser','?compute=server',false],['file:','server','?compute=server',false],
  ]){
    const context=vm.createContext({location:{protocol,search},document:{querySelector:()=>({content:meta})},URLSearchParams});
    vm.runInContext(source.slice(start,end)+'globalThis.usesServer=useComputeServer;',context);
    assert.equal(context.usesServer,expected,protocol+'/'+meta+'/'+search);
  }
});
