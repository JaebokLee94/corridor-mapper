// Each worker loads only the chosen model. The file:// build supplies the same assets in its worker blob.
export async function modelData(name) {
  return globalThis.__echoModelData?.[name] ?? (await import(new URL('./models/'+name+'.mjs', import.meta.url))).default;
}
const bytes=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
export async function neuralRuntime(name) {
  const [data,kernel]=await Promise.all([modelData(name),modelData('kernels')]);
  // WASI stdio is unused by inference; report EBADF on any stdio call.
  const wasi={fd_close:()=>8,fd_seek:()=>8,fd_write:()=>8};
  const {instance}=await WebAssembly.instantiate(bytes(kernel),{wasi_snapshot_preview1:wasi});
  const lib=instance.exports;lib._initialize();
  const weights=Object.fromEntries(Object.entries(data.weights).map(([key,[shape,s]])=>[key,{shape,values:new Float32Array(bytes(s).buffer)}]));
  // WASM memory can grow on every allocation; form views only after all allocations.
  function call(method,inputs,outputSize,params,Type=Float32Array) {
    const pointers=[];
    try {
      for(const size of [...inputs.map(a=>a.length),outputSize]){
        const ptr=lib.malloc(size*Type.BYTES_PER_ELEMENT);if(!ptr)throw new Error('Insufficient model memory');
        pointers.push(ptr);
      }
      inputs.forEach((a,i)=>new Type(lib.memory.buffer,pointers[i],a.length).set(a));
      if(method==='gaussianProcess'){
        const [px,py,pq,out]=pointers;
        if(!lib.gaussianProcess(px,py,params[0],pq,outputSize,out))throw new Error('GPR covariance factorization failed');
      }else lib[method](...pointers,...params);
      return new Type(lib.memory.buffer,pointers.at(-1),outputSize).slice();
    }finally{for(const p of pointers)lib.free(p);}
  }
  return {data,weights,call};
}
