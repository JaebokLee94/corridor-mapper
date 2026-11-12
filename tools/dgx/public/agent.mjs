// Outbound only. The public relay can request a bounded block of generated physical paths, never a URL, command or file.
import { gzipSync,gunzipSync } from 'node:zlib';
import { deserialize } from 'node:v8';
import { setTimeout as delay } from 'node:timers/promises';
import { publicBlock } from './relay.mjs';
const addr=process.env.ECHOMAP_RELAY, key=process.env.ECHOMAP_AGENT_KEY;
if(!key || new URL(addr).protocol!=='wss:')throw Error('Missing private agent configuration');
for(;;){
 let n=0;const ws=new WebSocket(addr,{headers:{Authorization:'Bearer '+key}});
 const pulse=setInterval(()=>{if(ws.readyState===1)ws.send('ping');},45000);
 ws.addEventListener('message',async e=>{
   if(e.data==='pong')return;
   let id,started=false;
   try{
     const job=JSON.parse(e.data);id=job.id;if(!/^[\da-f-]{36}$/.test(id))return;
     const block=publicBlock(job.block);if(n>=2)throw Error('Busy');n++;started=true;
     const res=await fetch('http://127.0.0.1:18902/v1/measure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...block,physicalOnly:true}),signal:AbortSignal.timeout(15000),redirect:'error'});
     if(!res.ok||res.headers.get('x-echomap-protocol')!=='1')throw Error('Unavailable');
     const chunk=deserialize(gunzipSync(Buffer.from(await res.arrayBuffer()),{maxOutputLength:96*1024*1024}));
     const bytes=gzipSync(JSON.stringify(chunk),{level:1});if(bytes.length>9*1024*1024)throw Error('Oversized');
     if(ws.readyState===1)ws.send(Buffer.concat([Buffer.from(id),bytes]));
   }catch{if(id&&ws.readyState===1)ws.send(id);}
   finally{if(started)n--;}
 });
 await new Promise(r=>{ws.addEventListener('close',r,{once:true});ws.addEventListener('error',r,{once:true});});
 clearInterval(pulse);try{ws.close();}catch{}await delay(5000);
}
