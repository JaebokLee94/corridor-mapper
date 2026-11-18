// Each worker loads only the chosen model. The file:// build supplies the same assets in its worker blob.
export async function modelData(name) {
  if(globalThis.__echoModelData?.[name])return globalThis.__echoModelData[name];
  const asset=new URL('./models/'+name+'.mjs',import.meta.url);
  if(name==='kernels'||name==='spline-cnn')asset.searchParams.set('v','20261118-rugged-canonical');
  return (await import(asset)).default;
}
const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export async function neuralRuntime(name) {
  const [data,kernel]=await Promise.all([modelData(name),modelData('kernels')]);
  // WASI stdio is unused by inference; report EBADF on any stdio call.
  const wasi={fd_close:()=>8,fd_seek:()=>8,fd_write:()=>8};
  const {instance}=await WebAssembly.instantiate(bytes(kernel),{wasi_snapshot_preview1:wasi});
  const lib=instance.exports;lib._initialize();
  const weights=Object.fromEntries(Object.entries(data.weights).map(([key,[shape,s]])=>[key,{shape,values:new Float32Array(bytes(s).buffer)}]));
  // The checkpoint is immutable. Upload each used weight once per WASM instance.
  const frozen=new Set(Object.values(weights).map(w=>w.values)),resident=new Map();
  // Use each view immediately because a later allocation may grow WASM memory.
  function call(method,inputs,outputSize,params,Type=Float32Array) {
    const temporary=[];
    function allocate(size){
      const ptr=lib.malloc(size*Type.BYTES_PER_ELEMENT);if(!ptr)throw new Error('Insufficient model memory');
      temporary.push(ptr);return ptr;
    }
    try {
      const pointers=inputs.map(a=>{
        if(resident.has(a))return resident.get(a);
        const ptr=allocate(a.length);new Type(lib.memory.buffer,ptr,a.length).set(a);
        if(frozen.has(a)){resident.set(a,ptr);temporary.pop();}
        return ptr;
      });
      pointers.push(allocate(outputSize));
      if(method==='gaussianProcess'){
        const [px,py,pq,out]=pointers;
        if(!lib.gaussianProcess(px,py,params[0],pq,outputSize,out))throw new Error('GPR covariance factorization failed');
      }else lib[method](...pointers,...params);
      return new Type(lib.memory.buffer,pointers.at(-1),outputSize).slice();
    }finally{for(const p of temporary)lib.free(p);}
  }
  return {data,weights,call};
}
