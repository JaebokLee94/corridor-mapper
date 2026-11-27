// Each worker owns an ordered stream with one outstanding prefix.
function stepClient(worker,init,readStep) {
  let pending,failure,closed=false;
  function reject(error){failure=error;pending?.reject(error);pending=null;}
  function receive(data){
    if(!pending)return;
    if(data.type==='error'){reject(new Error(data.message??data.error));return;}
    pending.resolve(data.type==='initialized'?data.device:readStep(data));pending=null;
  }
  if(worker.on){
    worker.on('message',receive);worker.on('error',reject);
    worker.on('exit',()=>{if(!closed)reject(new Error('Computation worker stopped'));});
  }else{
    worker.onmessage=event=>receive(event.data);
    worker.onerror=event=>reject(new Error(event.message||'Computation worker failed'));
  }
  function request(message){
    if(failure)return Promise.reject(failure);
    if(pending)return Promise.reject(new Error('A worker request is already pending'));
    return new Promise((resolve,reject)=>{
      pending={resolve,reject};
      try{worker.postMessage(message);}
      catch(error){pending=null;reject(error);}
    });
  }
  return {ready:request(init),step:snapshot=>request({type:'step',snapshot}),
    close(){closed=true;reject(new Error('Cancelled'));worker.terminate();}};
}

export function workerMethod(worker,side,input,domain) {
  const {vehicles,scene,rightMethod,echoKnotM,echoSupportM,sigmaD,snapshots}=input;
  return stepClient(worker,{type:'init',side,vehicles,scene,rightMethod,domain,echoKnotM,echoSupportM,snapshots,...(input.echoBackend?{echoBackend:input.echoBackend}:{}),...(input.computeDevice?{computeDevice:input.computeDevice}:{}),sigmaR:sigmaD},
    data=>data.methods);
}

export function workerDisplayField(worker,{nx,ny,domain},numerical) {
  return stepClient(worker,{type:'initDisplay',grid:{nx,ny,domain},numerical},
    ({type,requestId,...frame})=>frame);
}
