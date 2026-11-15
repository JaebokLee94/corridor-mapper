// Run the browser's nested module worker through the same message boundary in Node tests.
const {Worker}=require('node:worker_threads');
module.exports=class extends Worker {
  constructor(url){
    super(`const {parentPort}=require('node:worker_threads');
      globalThis.postMessage=m=>parentPort.postMessage(m);
      import(${JSON.stringify(url.href)}).then(()=>parentPort.on('message',data=>globalThis.onmessage({data}))); `,{eval:true});
  }
};
