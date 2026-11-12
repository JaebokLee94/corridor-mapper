import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { serialize } from 'node:v8';
import { gzipSync } from 'node:zlib';
import { remoteScenario } from '../../tools/dgx/client.mjs';
import { createSceneGeometry, generateSnapshot } from '../../drf/scenario.mjs';

test('DGX chunk arrival order preserves causal time and rejects incomplete replies', async t => {
  let truncate=false;
  const server=createServer(async(req,res)=>{
    let data='';for await(const part of req)data+=part;
    const {input,start,end}=JSON.parse(data);
    const geometry=createSceneGeometry(input);
    const frames=Array.from({length:end-start+1},(_,i)=>generateSnapshot(input,geometry.spans,start+i,geometry.wallModel));
    if(start===1) await new Promise(resolve=>setTimeout(resolve,60));
    if(truncate) frames.pop();
    res.writeHead(200,{'X-EchoMap-Protocol':'1'}).end(gzipSync(serialize({start,end,frames,...(start===1?{geometry}:{})})));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url='http://127.0.0.1:'+server.address().port, input={seed:3801,scene:'reference',vehicles:2,snapshots:13,roughness:0};
  const trace=[],result=await remoteScenario(input,url,n=>trace.push(n));
  assert.equal(trace.at(-1),13);
  for(let i=0;i<13;i++){
    const expected=generateSnapshot(result.input,result.spans,i+1,result.wallModel);
    assert.deepEqual(result.wire[i],expected.wire);assert.deepEqual(result.truth[i],expected.truth);
  }
  truncate=true;
  await assert.rejects(remoteScenario(input,url),/incomplete interval/);
});
