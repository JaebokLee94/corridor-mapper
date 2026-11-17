// One outstanding prefix per worker. The next measurement is sent only after this method completes.
export function workerMethod(worker,side,input,domain) {
  let pending,failure,closed=false;
  function reject(error){failure=error;pending?.reject(error);pending=null;}
  function receive(data){
    if(!pending)return;
    if(data.type==='error'){reject(new Error(data.message));return;}
    pending.resolve(data.methods);pending=null;
  }
  if(worker.on){
    worker.on('message',receive);worker.on('error',reject);
    worker.on('exit',()=>{if(!closed)reject(new Error('Estimator worker stopped'));});
  }else{
    worker.onmessage=event=>receive(event.data);
    worker.onerror=event=>reject(new Error(event.message||'Estimator worker failed'));
  }
  function request(message){
    if(failure)return Promise.reject(failure);
    return new Promise((resolve,reject)=>{pending={resolve,reject};worker.postMessage(message);});
  }
  const {vehicles,scene,rightMethod,echoKnotM,echoSupportM,sigmaD}=input;
  return {ready:request({type:'init',side,vehicles,scene,rightMethod,domain,echoKnotM,echoSupportM,...(input.echoBackend?{echoBackend:input.echoBackend}:{}),sigmaR:sigmaD}),
    step:snapshot=>request({type:'step',snapshot}),
    close(){closed=true;reject(new Error('Cancelled'));worker.terminate();}};
}
