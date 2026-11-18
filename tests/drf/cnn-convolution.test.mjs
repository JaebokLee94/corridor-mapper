import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {neuralRuntime} from '../../drf/model-runtime.mjs';

test('CNN convolution retains the original FP32 output across panels, tails and dilated edges',async()=>{
  const rt=await neuralRuntime('spline-cnn');
  // Byte fingerprints from commit 948ec76, before the SIMD convolution; exact binary-rational inputs.
  const fixtures=[
    [17,1,"start",1,1,"d626743d8d924e3a24ab63fc060d3698d718ebde1b3a2d56926c30efd2740422"],
    [17,2,"start",1,1,"6dcacece901783cfcef62e9b59c355444f52cfe82cebcd99d644b80fb52be8ca"],
    [17,3,"start",1,1,"e89487c2226d27983cafac3f74259559b779245b0676dd9f9298d8af2ffd8aa0"],
    [17,3,"blocks.0",1,2,"3f874042129401a03732d2fb0627c1df220946d3f2b99bfa69b75e6f111daa70"],
    [17,4,"start",1,1,"c4b0a93d7b80603d695d40337aebe3092c20c089cadc289ceb7d9a00a3952c8c"],
    [17,4,"blocks.0",1,2,"b8fddf4664d8f14139b5e4da4fee2b470ca3c943b59e27d7fde1e0fd4f81689e"],
    [17,5,"start",1,1,"97680996f20f2428e566d428e4b5eef600dbd9b50acd0d83b9b38f4015ef260c"],
    [17,5,"blocks.0",1,2,"1c945cdfb5beb33e8eabc275e8125f5ddbdb92d2ba7a6baa1d0345858c54b062"],
    [17,7,"start",1,1,"e9bbde569dfed4b4e833a26ed69ecc7b383eac212bca751dc7d5eb655d5d4965"],
    [17,7,"blocks.0",1,2,"0a2d6c8cf5da0311e8b1cfe14a2afafe168698eaf70e666a916535d509ed1cb0"],
    [17,9,"start",1,1,"2b11751b54454a57be309b12cfb836d2cb5918776660e9e0fd298a934e3848c0"],
    [17,9,"blocks.0",1,2,"aac66fb32ff21f8d3f23b910667a444a57d8516b70f8b871ee85ad914d13ebfd"],
    [81,80,"blocks.5",20,40,"649f79c2717a867719d81f8642b3412271e31e068dca59524475af365b1679a1"],
    [81,81,"blocks.5",20,40,"6da96fdc15552c32abfaab3b9394d8d057fe0062afe742239589743e888f5ed2"],
    [81,82,"blocks.5",20,40,"76290bddbad050b976f5e32eecd8788afeb306a8e2e9f69dd6a13ff0e3d0dcba"],
    [81,83,"blocks.5",20,40,"c4b5f66f1bd15fa51b84eda9f9c2ec9d1acd313a0008dd0a9e9c727b91b3e978"],
  ];
  for(const [h,n,name,dy,dx,expected] of fixtures){
    const weight=rt.weights[name+'.weight'],bias=rt.weights[name+'.bias'],[k,,inc,out]=weight.shape;
    const input=Float32Array.from({length:h*n*inc},(_,i)=>(((i*97)%211)-105)/32*((i%17===0)?1024:1));
    const result=rt.call('convolutionXY',[input,weight.values,bias.values],h*n*out,[h,n,inc,out,k,dy,dx]);
    const bytes=Buffer.alloc(result.byteLength);
    result.forEach((v,i)=>bytes.writeFloatLE(v,i*4));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,`${name}: ${h}x${n}, dilation ${dy},${dx}`);
  }
});

test('CNN reduction preserves independently known FP32 cancellation and channel tails',async()=>{
  const rt=await neuralRuntime('spline-cnn'),width=7,out=64;
  for(const inc of [26,64]){
    const input=new Float32Array(width*inc).fill(1),weight=new Float32Array(inc*out),bias=new Float32Array(out).fill(.25);
    for(const [c,value] of [[0,1e8],[1,1],[2,-1e8],[3,1]])weight.fill(value,c*out,(c+1)*out);
    if(inc===26){weight.fill(16,24*out,25*out);weight.fill(-1,25*out,26*out);}
    const actual=rt.call('convolutionXY',[input,weight,bias],width*out,[1,width,inc,out,1,1,1]);
    // (1e8-1e8)+(1+1)=2 in four-position panels; sequential FP32 addition gives 1 in the tail.
    for(let x=0;x<width;x++)for(let c=0;c<out;c++)
      assert.equal(actual[x*out+c],(x<4?2:1)+(inc===26?15:0)+.25,`input channels ${inc}, position ${x}, output ${c}`);
  }
});
