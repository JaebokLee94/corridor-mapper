import test from 'node:test';
import assert from 'node:assert/strict';
import { DrfMap } from '../../drf/render.mjs';

// Verify the rendered pixels and legend against the declared palette stops, while
// retaining the field's values, normalization and transparent zero-cell mask.
test('heatmap theme changes recolor cached fields and matching colorbars without changing numerical data', () => {
  const observers=[],mediaListeners=[],gradients=[];
  const root={dataset:{theme:'light'}};
  let plotBackground='#ffffff',systemDark=false;
  const makeCanvas=()=>{
    const canvas={clientWidth:700,clientHeight:400,dataset:{},style:{},addEventListener(){}};
    const context=new Proxy({
      font:'14px Arial',measureText:text=>({width:text.length*7}),
      createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),
      putImageData(image){canvas.pixels=[...image.data];},
      createLinearGradient(){const stops=[];gradients.push(stops);return {addColorStop:(at,color)=>stops.push([at,color])};},
    },{get:(target,key)=>key in target ? target[key] : ()=>{}});
    canvas.getContext=()=>context;
    return canvas;
  };
  const stubs={
    document:{documentElement:root,createElement:makeCanvas},window:{devicePixelRatio:1},
    getComputedStyle:()=>({getPropertyValue:name=>name==='--color-plot-bg'?plotBackground:'#111111'}),
    ResizeObserver:class{observe(){}},MutationObserver:class{constructor(callback){observers.push(callback);}observe(){}},
    matchMedia:()=>({matches:systemDark,addEventListener:(event,callback)=>mediaListeners.push(callback)}),
    requestAnimationFrame:()=>1,
  };
  const saved=Object.fromEntries(Object.keys(stubs).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const light={
    Dbar:[[255,255,255],[255,225,143],[255,172,66],[239,100,29],[184,41,20]],
    betaHat:[[255,255,255],[214,233,249],[145,195,229],[61,142,196],[8,81,156]],
  };
  const dark={
    Dbar:[[22,38,48],[96,62,37],[161,88,35],[221,130,46],[255,206,122]],
    betaHat:[[22,38,48],[27,72,102],[34,112,155],[72,163,203],[152,219,242]],
  };
  const luminance=rgb=>rgb.map(c=>c/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,k)=>sum+v*[.2126,.7152,.0722][k],0);
  const expectedPixels=colors=>colors.flatMap((rgb,i)=>[...rgb,i===0?0:255]);
  try {
    Object.assign(globalThis,stubs);
    const canvas=makeCanvas(),map=new DrfMap(canvas),grid={nx:5,ny:1,domain:[0,80,-20,50]};
    for (const scaleMode of ['linear','log']) for (const heatField of ['Dbar','betaHat']) {
      root.dataset.theme='light';plotBackground='#ffffff';
      const values=Float32Array.from(scaleMode==='linear'?[0,.25,.5,.75,1]:[0,1,3,7,15]);
      const frame={Dbar:values,betaHat:values},before=[...values];
      map.set({grid,frame,heatField,scaleMode,layers:{}});
      assert.deepEqual(map.heat.pixels,expectedPixels(light[heatField]),`${heatField}/${scaleMode}: retain light-mode pixels exactly`);
      const maximum=map.maxValue;
      root.dataset.theme='dark';plotBackground='#162630';observers[0]();
      assert.deepEqual(map.heat.pixels,expectedPixels(dark[heatField]),`${heatField}/${scaleMode}: observer rebuilds cached field before the next draw`);
      assert.equal(map.maxValue,maximum);assert.deepEqual([...values],before,'Theme selection never modifies the field values');
      map.paint(canvas,1);
      assert.deepEqual(gradients.at(-1),dark[heatField].map((rgb,i)=>[i/4,`rgb(${rgb.join(',')})`]),'Colorbar and field use exactly the same color stops');
      const brightness=dark[heatField].map(luminance);
      assert.ok(brightness.every((value,i)=>i===0 || value>brightness[i-1]),'Dark sequential palette increases in luminance');
      root.dataset.theme='light';plotBackground='#ffffff';observers[0]();
      assert.deepEqual(map.heat.pixels,expectedPixels(light[heatField]),'Switching back restores the original light colors');
      systemDark=true;mediaListeners[0]();
      assert.deepEqual(map.heat.pixels,expectedPixels(light[heatField]),'System dark preference cannot override explicit light');
      delete root.dataset.theme;plotBackground='#162630';mediaListeners[0]();
      assert.deepEqual(map.heat.pixels,expectedPixels(dark[heatField]),'Without an explicit theme, recolor to the effective CSS background');
      root.dataset.theme='light';plotBackground='#ffffff';
      // A PNG export can draw immediately, before MutationObserver delivery.
      map.paint(canvas,300/96);
      assert.deepEqual(map.heat.pixels,expectedPixels(light[heatField]),'Direct/export paint synchronizes a changed theme before drawing');
    }
    root.dataset.theme='dark';plotBackground='#162630';
    for (const heatField of ['Dbar','betaHat']) {
      const values=Float32Array.from([0,1e-8,1]);
      map.set({grid:{nx:3,ny:1,domain:[0,80,-20,50]},frame:{[heatField]:values},heatField,scaleMode:'linear',layers:{}});
      assert.deepEqual(map.heat.pixels.slice(4,8),[22,38,48,255],'Tiny positive values blend into the dark plot background instead of becoming white patches');
      assert.deepEqual(map.heat.pixels.slice(0,4),[22,38,48,0],'A zero cell still uses the existing transparent alpha mask');
    }
  } finally {
    for (const [key,descriptor] of Object.entries(saved)) descriptor ? Object.defineProperty(globalThis,key,descriptor) : delete globalThis[key];
  }
});
