import { experimentSettings as normalizeInput } from './experiment-settings.mjs?v=20261118-device-selection';
import { prepareScenario as generateScenario } from './prepare-scenario.mjs?v=20261114-wall-geometry';
import { createGrid, createField } from './field.mjs?v=20261118-device-selection';
import { EchoComparison, echoProtocol } from './echo-comparison.mjs?v=20261118-device-selection';
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

/** Each estimator consumes the same ordered wires on its own worker and clock.
 * Emit its result immediately. EchoSpline advances the display field. Joined frames stay ordered for exports and older clients.
 */
export function createRunEngine({emit,yieldTask=yieldWorkerTask,prepare=generateScenario,createMethod=localMethod}={}) {
  if(typeof emit!=='function')throw new TypeError('A result emitter is required');
  let active;
  const current=run=>active===run&&!['done','cancelled','failed'].includes(run.target);
  const send=(run,type,value={})=>emit({type,requestId:run.requestId,...value});
  const status=(run,mode)=>send(run,'status',{mode,next:run.next,total:run.input.snapshots});
  function close(run){for(const lane of Object.values(run.lanes))lane.client.close();}
  function fail(run,error){
    if(!current(run))return;
    run.target='failed';close(run);send(run,'error',{message:error.message});
  }

  function join(run){
    const t=run.next+1,left=run.lanes.echoSpline.pending.get(t),right=run.lanes.guarded.pending.get(t);
    if(!left||!right)return;
    for(const lane of Object.values(run.lanes))lane.pending.delete(t);
    const frame={...left.field};
    frame.methods={echoSpline:left.result,guarded:right.result};
    frame.candidates=right.result.candidates;frame.psptMs=right.result.ms;frame.method=run.method;
    left.evaluation.diagnostics=right.evaluation.diagnostics;
    const evaluation={...right.evaluation,methods:{echoSpline:left.evaluation,guarded:right.evaluation}};
    run.next=t;
    send(run,'frame',{frame,evaluation,next:t});
  }
  async function advance(run,side){
    const lane=run.lanes[side];
    while(current(run)&&run.target==='running'&&lane.next<lane.limit){
      const wire=run.scenario.wire[lane.next],result=await lane.client.step(wire);
      if(!current(run))return;
      const t=++lane.next,at=run.elapsed+performance.now()-run.started;
      const evaluation=lane.evaluator.step({t,...result,method:run.method,curveMethod:side==='echoSpline'?side:run.input.rightMethod},
        side==='echoSpline'?{diagnostics:{}}:null,result.bridges,result.extendedBridges,result.checkedChains);
      const field=side==='echoSpline' ? run.field.step(wire) : undefined;
      lane.pending.set(t,{result,evaluation,field});
      const {diagnostics,...metrics}=evaluation;
      // A ready right-hand result delivers the field in the immediately following joined frame.
      const earlyField=field && !run.lanes.guarded.pending.has(t) ? field : undefined;
      send(run,'method-frame',{side,t,at,result,evaluation:metrics,field:earlyField});
      if(!current(run))return;
      join(run);
      if(current(run)&&lane.next<lane.limit)await yieldTask();
    }
  }
  async function pump(run){
    if(!current(run)||run.busy||!run.ready)return;
    run.busy=true;run.started=performance.now();
    try{
      await Promise.all(sides.map(side=>advance(run,side)));
      if(!current(run))return;
      run.elapsed+=performance.now()-run.started;
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
      run.field=createField(grid,{band:input.band,perimeter:input.perimeter});
      for(const side of sides)run.lanes[side]={client:createMethod(side,input,scenario.domain),
        evaluator:createPSPTEvaluator(scenario,grid),pending:new Map(),next:0,limit:message.single?1:input.snapshots};
      await Promise.all(sides.map(side=>run.lanes[side].client.ready));
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
