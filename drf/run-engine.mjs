import { experimentSettings as normalizeInput } from './experiment-settings.mjs?v=20261119-cnn-stride4';
import { prepareScenario as generateScenario } from './prepare-scenario.mjs?v=20261114-wall-geometry';
import { createGrid } from './field.mjs?v=20261119-cnn-stride4';
import { createDisplayField } from './display-field.mjs?v=20261127-independent-field';
import { EchoComparison, echoProtocol } from './echo-comparison.mjs?v=20261119-cnn-stride4';
import { createPSPTEvaluator } from './pspt-evaluate.mjs?v=20261117-map-metrics';

/** Yield within the worker so pause/cancel commands run between snapshots.
 * No page acknowledgement, animation callback or parent timer is required.
 */
export function yieldWorkerTask() {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close(); channel.port2.close(); resolve();
    };
    channel.port2.postMessage(null);
  });
}

const sides=['echoSpline','guarded'];

function localMethod(side,input,domain){
  const estimator=new EchoComparison(input,domain,side);
  return {ready:estimator.loadModel({useGpu:true}),
    step:wire=>estimator.stepSide(side,wire),close:()=>estimator.close()};
}

function localField(grid,numerical){
  return {...createDisplayField(grid,numerical),ready:Promise.resolve(),close(){}};
}

/** The estimators and display field advance independently on the same measured
 * wires. Joined snapshots retain all three outputs for replay and exports.
 */
export function createRunEngine({emit,yieldTask=yieldWorkerTask,prepare=generateScenario,createMethod=localMethod,createFieldClient=localField}={}) {
  if(typeof emit!=='function')throw new TypeError('A result emitter is required');
  let active;
  const current=run=>active===run&&!['done','cancelled','failed'].includes(run.target);
  const send=(run,type,value={})=>emit({type,requestId:run.requestId,...value});
  const status=(run,mode)=>send(run,'status',{mode,next:run.next,total:run.input.snapshots});
  function close(run){
    for(const lane of Object.values(run.lanes)){
      lane.client.close(); lane.pending.clear();
    }
  }
  function fail(run,error){
    if(!current(run))return;
    run.target='failed';close(run);send(run,'error',{message:error.message});
  }

  function join(run){
    const t=run.next+1,left=run.lanes.echoSpline.pending.get(t),right=run.lanes.guarded.pending.get(t),
      display=run.lanes.field.pending.get(t);
    if(!left||!right||!display)return;
    for(const lane of Object.values(run.lanes))lane.pending.delete(t);
    const frame={...display.field};
    frame.methods={echoSpline:left.result,guarded:right.result};
    frame.candidates=right.result.candidates;frame.psptMs=right.result.ms;frame.method=run.method;
    left.evaluation.diagnostics=right.evaluation.diagnostics;
    const evaluation={...right.evaluation,methods:{echoSpline:left.evaluation,guarded:right.evaluation}};
    run.next=t;
    send(run,'frame',{frame,evaluation,next:t,fieldAt:display.at});
  }

  function recordMethod(run,side,t,at,result){
    const lane=run.lanes[side];
    const evaluation=lane.evaluator.step({t,...result,method:run.method,curveMethod:side==='echoSpline'?side:run.input.rightMethod},
      side==='echoSpline'?{diagnostics:{}}:null,result.bridges,result.extendedBridges,result.checkedChains);
    lane.pending.set(t,{result,evaluation});
    const {diagnostics,...metrics}=evaluation;
    const display=side==='echoSpline' && !run.lanes.guarded.pending.has(t) ? run.lanes.field.pending.get(t) : null;
    send(run,'method-frame',{side,t,at,result,evaluation:metrics,field:display?.field});
  }

  async function advance(run,side){
    const lane=run.lanes[side];
    while(current(run)&&run.target==='running'&&lane.next<lane.limit){
      const wire=run.scenario.wire[lane.next],result=await lane.client.step(wire);
      if(!current(run))return;
      const at=run.elapsed+performance.now()-run.started,t=++lane.next;
      if(side==='field'){
        lane.pending.set(t,{field:result,at});
        if(run.lanes.echoSpline.pending.has(t)&&!run.lanes.guarded.pending.has(t))
          send(run,'field-frame',{t,at,field:result});
      }else recordMethod(run,side,t,at,result);
      if(!current(run))return;
      join(run);
      if(current(run)&&lane.next<lane.limit)await yieldTask();
    }
  }
  async function pump(run){
    if(!current(run)||run.busy||!run.ready)return;
    run.busy=true;run.started=performance.now();
    send(run,'compute-clock',{elapsedMs:run.elapsed,running:true});
    try{
      const lanes=Object.keys(run.lanes);
      // A resume can arrive while a paused lane still has a request in flight.
      do {
        await Promise.all(lanes.map(side=>advance(run,side)));
      }while(current(run)&&run.target==='running'&&lanes.some(side=>run.lanes[side].next<run.lanes[side].limit));
      if(!current(run))return;
      run.elapsed+=performance.now()-run.started;
      send(run,'compute-clock',{elapsedMs:run.elapsed,running:false});
      if(run.next===run.input.snapshots){run.target='done';close(run);status(run,'done');}
      else {run.target='paused';status(run,'paused');}
    }catch(error){fail(run,error);}
    finally{run.busy=false;}
  }
  async function start(message){
    if(active&&current(active))throw new Error('Cancel the current run before starting another');
    const input=normalizeInput(message.input);
    if(input.sigmaD===0)throw new Error('Both methods require range SD σd > 0.');
    const run=active={requestId:message.requestId,input,next:0,target:'running',lanes:{},elapsed:0,
      method:!input.rightMethod||input.rightMethod==='wmp'?'guarded-tuned':input.rightMethod};
    status(run,'running');
    try {
      const scenario=await prepare(input,(t,total)=>{
        if(!current(run))throw new Error('Cancelled');
        send(run,'progress',{t,total});
      },{onPhase:phase=>{if(current(run))send(run,'preparation',{phase});}});
      if(!current(run))return;
      scenario.input=input;run.scenario=scenario;
      const grid=createGrid(input.grid,input.grid,scenario.domain);
      await Promise.all([...sides,'field'].map(async side=>{
        const client=side==='field' ? createFieldClient(grid,{band:input.band,perimeter:input.perimeter})
          : createMethod(side,input,scenario.domain);
        const lane=run.lanes[side]={client,pending:new Map(),next:0,limit:message.single?1:input.snapshots};
        await client.ready;
        if(side!=='field'&&current(run))lane.evaluator=createPSPTEvaluator(scenario,grid);
      }));
      if(!current(run))return;
      run.ready=true;
      send(run,'prepared',{scenario,grid,protocol:echoProtocol(input)});
      await pump(run);
    }catch(error){fail(run,error);}
  }
  function command(message){
    if(message.type==='start')return start(message);
    const run=active;
    if(!run||message.requestId!==run.requestId||!current(run))return;
    if(message.type==='cancel'){run.target='cancelled';close(run);status(run,'cancelled');return;}
    if(message.type==='pause'){run.target='paused';if(run.ready&&!run.busy)status(run,'paused');return;}
    if(!['step','resume'].includes(message.type))throw new Error('Unknown run command');
    if(message.type==='step'&&(run.target!=='paused'||run.busy))return;
    for(const lane of Object.values(run.lanes))lane.limit=message.type==='step'?Math.min(lane.next+1,run.input.snapshots):run.input.snapshots;
    run.target='running';if(message.type==='resume')status(run,'running');
    return pump(run);
  }
  return {command};
}
