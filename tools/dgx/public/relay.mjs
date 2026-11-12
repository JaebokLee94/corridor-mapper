import { normalizeInput } from '../../../drf/scenario.mjs';
const origin='https://jaeboklee94.github.io', cors={'Access-Control-Allow-Origin':origin,'Vary':'Origin','Cache-Control':'no-store'};
const reply=(s,t='')=>new Response(t||null,{status:s,headers:cors});
export function publicBlock(raw){
  const {start,end}=raw,input=normalizeInput(raw.input);
  if(input.vehicles>10 || input.cellStep<0.02 || input.lambda0>15 || input.roughness>10 || !Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>input.snapshots||end-start>=12) throw Error('Outside public GPU budget');
  return {start,end,input};
}
export default {async fetch(req,env){
 const path=new URL(req.url).pathname;
 if(path==='/agent'){
   if(!env.AGENT_KEY||req.headers.get('Authorization')!=='Bearer '+env.AGENT_KEY||req.headers.get('Upgrade')?.toLowerCase()!=='websocket')return reply(403);
 }else{
   if(path!=='/v1/physical')return reply(404);
   if(req.headers.get('Origin')!==origin)return reply(403);
   if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{...cors,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400'}});
   if(req.method!=='POST'||!req.headers.get('Content-Type')?.startsWith('application/json'))return reply(415);
   const len=Number(req.headers.get('Content-Length'));if(!(len>0&&len<=4096))return reply(413);
 }
 return env.BROKER.get(env.BROKER.idFromName('measurement-v1')).fetch(req);
}};
export class MeasureBroker {
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.jobs=new Map();this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping','pong'));}
 async fetch(req){
   if(new URL(req.url).pathname==='/agent'){
     const [client,server]=Object.values(new WebSocketPair());
     for(const old of this.ctx.getWebSockets())old.close(1000,'reconnected');
     this.ctx.acceptWebSocket(server);
     return new Response(null,{status:101,webSocket:client});
   }
   let block;try{block=publicBlock(await req.json());}catch{return reply(422);}
   const socket=this.ctx.getWebSockets().find(s=>s.readyState===1);
   if(!socket)return reply(503);
   if(this.jobs.size>=2)return reply(429);
   // Persistent quotas survive hibernation. Count the more expensive fleet and cell density before dispatch.
   const window=Math.floor(Date.now()/600000), ip=req.headers.get('CF-Connecting-IP')||'unknown';
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(this.env.AGENT_KEY+window+ip));
   const client=Array.from(new Uint8Array(digest).slice(0,10),v=>v.toString(16).padStart(2,'0')).join('');
   if(this.jobs.size>=2)return reply(429);
   const cost=Math.max(45,(block.end-block.start+1)*block.input.vehicles*(block.input.vehicles-1)/2);
   const quotas=this.ctx.storage.kv, prev=quotas.get('usage'), usage=prev?.window===window?prev:{window,all:0,clients:{}};
   if(usage.all+cost>108000 || (usage.clients[client]||0)+cost>10800)return reply(429);
   usage.all+=cost;usage.clients[client]=(usage.clients[client]||0)+cost;quotas.put('usage',usage);
   const id=crypto.randomUUID();
   return new Promise(resolve=>{
     const finish=(status,bytes)=>{clearTimeout(timer);this.jobs.delete(id);
       resolve(bytes?new Response(bytes,{headers:{...cors,'Content-Type':'application/gzip','X-Content-Type-Options':'nosniff'}}):reply(status));};
     const timer=setTimeout(()=>finish(504),20000);this.jobs.set(id,{finish,socket});
     try{socket.send(JSON.stringify({id,block}));}catch{finish(503);}
   });
 }
 webSocketMessage(ws,data){
   if(typeof data==='string'){this.jobs.get(data)?.finish(503);return;}
   const bytes=new Uint8Array(data),id=new TextDecoder().decode(bytes.subarray(0,36)),job=this.jobs.get(id);
   if(job?.socket===ws&&bytes.length>36&&bytes.length<=10*1024*1024)job.finish(200,bytes.subarray(36));
 }
 webSocketClose(ws){for(const j of this.jobs.values())if(j.socket===ws)j.finish(503);try{ws.close();}catch{}}
 webSocketError(ws){this.webSocketClose(ws);}
}
