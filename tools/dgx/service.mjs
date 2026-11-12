import cluster from 'node:cluster';
import http from 'node:http';
import { serialize } from 'node:v8';
import { gzipSync } from 'node:zlib';
import { normalizeInput } from '../../drf/scenario.mjs';
import { generateChunk } from './generate.mjs';

const port=Number(process.env.ECHOMAP_GPU_PORT||18902), workers=Number(process.env.ECHOMAP_GPU_WORKERS||6);
if(cluster.isPrimary) {
  if(!Number.isInteger(workers)||workers<1||workers>16) throw new Error('Use 1–16 GPU service workers');
  for(let i=0;i<workers;i++) cluster.fork();
  cluster.on('exit',(_worker,code)=>{if(code) cluster.fork();});
} else {
  http.createServer(async (req,res)=>{
    try {
      if(!['127.0.0.1','localhost'].includes(req.headers.host?.split(':')[0]) || req.headers.origin || req.headers['sec-fetch-site']==='cross-site') { res.writeHead(403).end(); return; }
      if(req.url==='/health' && req.method==='GET') {res.end('echomap-dgx/1');return;}
      if(req.url!=='/v1/measure' || req.method!=='POST' || req.headers['content-type']!=='application/json') { res.writeHead(404).end(); return; }
      let body='';
      for await(const part of req){body+=part;if(body.length>8192)throw new Error('Request exceeds 8 KiB');}
      const raw=JSON.parse(body), input=normalizeInput(raw.input), {start,end}=raw;
      if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end>input.snapshots||end<start||end-start>=12) throw new RangeError('Invalid snapshot interval');
      const began=performance.now();
      const packed=gzipSync(serialize(generateChunk(input,start,end,raw.physicalOnly===true)),{level:1});
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':packed.length,'X-EchoMap-Protocol':'1','X-Compute-Ms':(performance.now()-began).toFixed(2)}).end(packed);
    } catch(err) {res.writeHead(err instanceof SyntaxError||err instanceof RangeError?400:500).end(err.message);}
  }).listen(port,'127.0.0.1');
}
