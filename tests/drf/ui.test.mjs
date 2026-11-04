import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DrfMap, linkMapCameras, mapToScreen, mapToWorld, zoomMap, drawMetricHistory, drawSweep, drawHistogram, drawProfile, drawCounts } from '../../drf/render.mjs';
import { SurfaceMap } from '../../surf/map.mjs';
import { generateSnapshot, normalizeInput } from '../../drf/scenario.mjs';
import { createWalls, sampleWalls } from '../../drf/wall.mjs';

test('DRF DOM contract and readable stylesheet', () => {
  const html=readFileSync(new URL('../../drf.html',import.meta.url),'utf8');
  const ids='settings runButton pauseButton stepButton resetButton cancelButton status generationProgress runProgress mapCanvas fitView zoomIn zoomOut firstSnapshot ellipseStats aspectMode densityCanvas densityZoomOut densityZoomIn densityResetView contrastCanvas contrastZoomOut contrastZoomIn contrastResetView historyMetric timeSlider snapshotLabel replayButton playbackSpeed heatField scaleMode themeButton showEllipses showVehicles showProxy showTruth showSpecular showDiffuse qValue acceptedValue rejectedValue precisionValue recallValue firstPrecisionValue p95Value offwallValue f1Value supportedValue pendingValue contradictedValue timingValue pathValue inspector metricChart sweepPanel diagnosticPanel exportPanel sweepSettings sweepButton sweepCancel sweepStatus sweepChart sweepTable configSelect diagnosticChart profileChart countChart diagnosticSummary exportJson exportCsv exportPng aboutButton aboutDialog closeAbout provenanceCommit provenanceCore'.split(' ');
  for (const id of ids) assert.equal([...html.matchAll(new RegExp(`id="${id}"`,'g'))].length,1,id);
  for (const removed of ['medianValue','msdValue','hd95Value']) assert.ok(!html.includes(`id="${removed}"`),'Legacy-only metric removed: '+removed);
  assert.doesNotMatch(html,/id="showObserved"/,'The observed-wall mask is no longer a selectable layer');
  assert.match(html,/First support/);assert.match(html,/Precision is undefined when no candidates are supported/);
  const historySelect=html.match(/<select id="historyMetric"[\s\S]*?<\/select>/)[0];
  for (const metric of ['precision','recall','firstSupportPrecision','holdRate','p95','offwall']) assert.ok(historySelect.includes(`value="${metric}"`));
  assert.ok(!historySelect.includes('value="all"'),'The compact dashboard renders one metric at a time');
  for (const name of 'scene vehicles snapshots sigmaP sigmaD roughness lambda0 cellStep resolution specular grid band perimeter seed'.split(' ')) assert.ok(html.includes(`name="${name}"`),name);
  assert.ok(!html.includes('장면'));
  const geometryNote=html.match(/<p[^>]*class="note geometry-note"[^>]*>[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.match(geometryNote,/Independent walls · <span data-tex=\"\\Delta y\\ge 6\\,\\mathrm\{m\}\">Δy ≥6 m<\/span>/,'The compact note retains wall independence and the LaTeX minimum gap');
  assert.match(geometryNote,/title="Both walls have independent shapes and a minimum vertical gap of 6 m\."/,'The tooltip defines the vertical gap in full');
  assert.match(html,/input name="scene" type="hidden" value="layered"/);
  assert.doesNotMatch(html,/<select[^>]*name="scene"/);
  assert.match(html,/<select name="wallSide"><option value="both">Both walls<\/option><option value="upper">Upper only<\/option><option value="lower">Lower only<\/option>/);
  assert.match(html,/name="snapshots"[^>]*max="120"[^>]*value="120"/);
  for (const path of ['../../drf/style.css','../../surf/style.css']) {
    const css=readFileSync(new URL(path,import.meta.url),'utf8');
    for (const match of css.matchAll(/font-size:\s*(\d+)px/g)) {
      assert.ok(Number(match[1])>=(path.includes('/drf/') ? 12 : 16),`${path}: ${match[0]}`);
    }
  }
  assert.match(readFileSync(new URL('../../drf/style.css',import.meta.url),'utf8'),/body\s*\{[^}]*font:14px/,'Main text and controls retain a 14 px base');
  assert.match(html,/name="sigmaP"[^>]*value="0.1"/);
  assert.match(html,/name="roughness"[\s\S]*?value="2" selected/);
});

test('axis-fitted camera preserves metre coordinates and the zoom anchor', () => {
  const camera={cx:30,cy:15,scaleX:21,scaleY:11},box={x:44,y:16,w:1640,h:288};
  const close=(actual,expected) => actual.forEach((value,k)=>assert.ok(Math.abs(value-expected[k])<1e-11,`${value} != ${expected[k]}`));
  for (const point of [[0,0],[60,30],[-12,45],[31.5,12.75]]) close(mapToWorld(mapToScreen(point,camera,box),camera,box),point);
  const anchor=[box.x+box.w*.37,box.y+box.h*.61],world=mapToWorld(anchor,camera,box),zoomed=zoomMap(camera,1.7,anchor,box);
  close(mapToWorld(anchor,zoomed,box),world);
  close([zoomed.scaleX,zoomed.scaleY],[camera.scaleX*1.7,camera.scaleY*1.7]);
  assert.deepEqual(camera,{cx:30,cy:15,scaleX:21,scaleY:11},'zoom must leave the old camera untouched');
});

test('render keeps world row order, uses real DPR/300 dpi pixels, and charts execute', async () => {
  const snapshots={},created=[],rectangles=[],labels=[],mathImages=[],gridSegments=[],labelPositions=[],dots=[],ellipseStarts=[],strokes=[],gridColor='#c4d3e2';
  const context=() => {
    let path=[],subpathStarts=[],point;
    return new Proxy({font:'16px Arial',createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:(data)=>{snapshots.image=data.data;},measureText:(text)=>({width:text.length*9}),createLinearGradient:()=>({addColorStop(){}})}, {get(target,key){return key in target ? target[key] : (...args)=>{
      if (key==='beginPath') {path=[];subpathStarts=[];point=undefined;}
      if (key==='moveTo') {point=args;subpathStarts.push(path.length);}
      if (key==='lineTo') {if (point) path.push([point,args]);point=args;}
      if (key==='setLineDash') target.lineDash=args[0].slice();
      if (key==='stroke') strokes.push({color:target.strokeStyle,width:target.lineWidth,cap:target.lineCap,dash:target.lineDash?.slice() ?? [],segments:path.slice()});
      if (key==='stroke' && target.strokeStyle===gridColor) gridSegments.push(...path);
      if (key==='stroke' && target.strokeStyle!==gridColor) for (const [i,start] of subpathStarts.entries())
        if ((subpathStarts[i+1] ?? path.length)-start===96) ellipseStarts.push(path[start][0]);
      if (key==='arc') dots.push(args);
      if (key==='fillText') {assert.ok(parseFloat(target.font.match(/(\d+)px/)[1])>=14,args[0]);labels.push(args[0]);if (/^V\d+$/.test(args[0])) labelPositions.push(args);}
      if (key==='drawImage' && args[0]?.src?.startsWith('data:image/svg+xml')) mathImages.push(args);
      if (key==='strokeRect') rectangles.push(args);
    };}});
  };
  const makeCanvas=()=>{const ctx=context(),listeners={};return {clientWidth:700,clientHeight:540,width:0,height:0,style:{},dataset:{},listeners,getContext:()=>ctx,addEventListener(name,callback){listeners[name]=callback;},setPointerCapture(){},toBlob(callback){callback(new Blob(['png']));}};};
  const assertGrid=(box,message) => {
    const near=(a,b)=>Math.abs(a-b)<1e-8,inside=(v,lo,hi)=>v>lo+1e-8 && v<hi-1e-8;
    assert.ok(gridSegments.some(([a,b])=>near(a[0],b[0]) && inside(a[0],box.x,box.x+box.w) && near(Math.min(a[1],b[1]),box.y) && near(Math.max(a[1],b[1]),box.y+box.h)),`${message}: vertical grid inside plot`);
    assert.ok(gridSegments.some(([a,b])=>near(a[1],b[1]) && inside(a[1],box.y,box.y+box.h) && near(Math.min(a[0],b[0]),box.x) && near(Math.max(a[0],b[0]),box.x+box.w)),`${message}: horizontal grid inside plot`);
  };
  const assertMetreGrid=(map,message) => {
    const coordinates=[[],[]];
    for (const [a,b] of gridSegments) {
      const axis=Math.abs(a[0]-b[0])<1e-8 ? 0 : 1,value=mapToWorld(a,map.camera,map.box)[axis];
      assert.ok(Math.abs(value/10-Math.round(value/10))<1e-10,`${message}: grid at ${value} m must be a multiple of 10 m`);
      coordinates[axis].push(value);
    }
    for (const values of coordinates) {
      values.sort((a,b)=>a-b);
      for (let i=1;i<values.length;i++) assert.ok(Math.abs(values[i]-values[i-1]-10)<1e-8,`${message}: adjacent grid lines must be 10 m apart`);
    }
  };
  const assertChartGrids=message=>rectangles.forEach(([x,y,w,h],k)=>assertGrid({x,y,w,h},`${message} subplot ${k}`));
  const saved={};
  const stubs={document:{createElement:()=>{const c=makeCanvas();created.push(c);return c;},documentElement:{}},window:{devicePixelRatio:2,dispatchEvent(){}},Image:class{set src(value){this._src=value;this.complete=true;queueMicrotask(()=>this.onload?.());}get src(){return this._src;}async decode(){}},getComputedStyle:()=>({getPropertyValue:name=>name==='--color-grid' ? gridColor : name==='--color-plot-bg' ? '#ffffff' : '#111111'}),ResizeObserver:class{observe(){}},MutationObserver:class{observe(){}},matchMedia:()=>({addEventListener(){}}),requestAnimationFrame:()=>1};
  try {
    for (const [key,value] of Object.entries(stubs)) {saved[key]=globalThis[key];globalThis[key]=value;}
    const canvas=makeCanvas(),map=new DrfMap(canvas),frame={Dbar:new Float32Array([0,1,2,3]),betaHat:new Float32Array([0,.2,.5,1])};
    map.set({grid:{nx:2,ny:2,domain:[0,60,0,30]},frame,heatField:'Dbar',scaleMode:'linear',layers:{}});
    assert.equal(snapshots.image.length,16);
    assert.deepEqual([...snapshots.image.slice(4,7)],[184,41,20],'largest world y row must become top image row');
    assert.deepEqual([...snapshots.image.slice(8,12)],[255,255,255,0],'zero values are transparent in the bottom world row');
    assert.deepEqual([...frame.Dbar],[0,1,2,3],'presentation must not mutate field values');
    map.paint(canvas,1);const cssView=JSON.parse(canvas.dataset.view);
    assertGrid(map.box,'density');
    assertMetreGrid(map,'density');
    assert.equal(cssView.plotWidth,584,'heatmap must use the full width after axes and colorbar');
    assert.equal(cssView.plotHeight,478,'heatmap must use the full height after axes');
    map.paint(canvas,2);assert.equal(canvas.width,1400);assert.equal(canvas.height,1080);
    assert.deepEqual(JSON.parse(canvas.dataset.view),cssView,'DPR must not change the metre viewport');
    const target=makeCanvas();map.paint(target,300/96);assert.equal(target.width,2188);assert.equal(target.height,1688);
    assert.ok(await map.png() instanceof Blob);
    assert.ok(mathImages.length>=3,'PNG includes the LaTeX field symbol and both mathematical axis labels');
    assert.ok(mathImages.every(([image,...rect])=>decodeURIComponent(image.src).includes('<svg') && rect.every(Number.isFinite)),'Mathematical labels are SVG images with finite drawing dimensions');
    assert.ok(labels.some(text=>text.includes('linear color scale')));
    assert.ok(labels.includes('Axes: independent ') && labels.includes(' scale'),'export must disclose the selected axis scale');
    const beforeLog=map.state;
    map.set({...map.state,heatField:'betaHat',scaleMode:'log'});mathImages.length=0;
    assert.ok(await map.png() instanceof Blob);
    assert.ok(mathImages.length>=4,'Log-contrast PNG includes both axis labels, the contrast symbol and the log expression on its first export');
    map.set(beforeLog);

    gridSegments.length=0;map.set({...map.state,heatField:'betaHat'});map.paint(canvas,1);
    assertGrid(map.box,'contrast');
    assertMetreGrid(map,'contrast');
    rectangles.length=0;gridSegments.length=0;canvas.clientHeight=7*180;
    drawMetricHistory(canvas,[{t:1,precision:.9,recall:.7,firstSupportPrecision:.8,holdRate:.5,offset:.1,p95:.3,offwall:.05}]);
    assert.equal(rectangles.length,7);assert.ok(rectangles.every(([, , ,height])=>height>=117),'history compactness follows each subplot height');
    assertChartGrids('history');
    rectangles.length=0;gridSegments.length=0;canvas.clientHeight=7*120;
    drawMetricHistory(canvas,[{t:1,precision:.9,recall:.7,firstSupportPrecision:.8,holdRate:.5,offset:.1,p95:.3,offwall:.05}]);
    assert.equal(rectangles.length,7);assert.ok(rectangles.every(([, , ,height])=>height>=50),'compact history plots must retain usable vertical space');
    assertChartGrids('compact history');
    rectangles.length=0;gridSegments.length=0;canvas.clientHeight=240;
    drawMetricHistory(canvas,[{t:1,offset:.1,p95:.3,offwall:.05}],'p95');
    assert.equal(rectangles.length,1);assert.ok(rectangles[0][3]>=170,'selected metric uses one large plot');
    assertChartGrids('selected history');
    const display={grid:{nx:2,ny:2,domain:[0,60,0,30]},frame,layers:{showTruth:false},walls:[[[0,6],[60,24]]],wire:{configs:[{pHat_i:[50,15],pHat_j:[52,15]}]}};
    map.set(display);map.paint(canvas,2);const view=JSON.parse(canvas.dataset.view);
    assert.equal(map.camera.cx,30);assert.equal(map.camera.cy,15);
    assert.equal(view.xmax-view.xmin,60*1.04,'automatic fit uses the static scene width');
    map.set({...display,layers:{showTruth:true}});map.paint(canvas,2);
    assert.deepEqual(JSON.parse(canvas.dataset.view),view,'actual wall visibility cannot change the view');
    map.fit(true);map.paint(canvas,2);assert.equal(map.camera.cx,30,'full view returns to the public domain');
    map.fit();canvas.clientWidth=1700;canvas.clientHeight=350;
    const card={style:{},parentElement:{clientWidth:1702},firstElementChild:{offsetHeight:68}},body={style:{}};
    canvas.closest=()=>card;canvas.parentElement=body;
    gridSegments.length=0;
    map.set({...display,mode:'geometry',aspectMode:'fill',layers:{showTruth:true}});map.paint(canvas,2);
    assert.deepEqual([card.style,body.style],[{},{}],'RAW fitting must leave CSS frame and plot-body dimensions unchanged');
    const wideView=JSON.parse(canvas.dataset.view);
    assert.equal(wideView.plotWidth,1632,'the graph must use the full available panel width');
    assert.equal(wideView.plotHeight,288,'the graph must use the full available panel height');
    assert.equal(wideView.pixelsPerMetreX,wideView.pixelsPerMetreY,'RAW must remain isometric even when fill is requested');
    const origin=mapToScreen([30,15],map.camera,map.box),unitX=mapToScreen([31,15],map.camera,map.box),unitY=mapToScreen([30,16],map.camera,map.box);
    assert.ok(Math.abs(Math.hypot(unitX[0]-origin[0],unitX[1]-origin[1])-Math.hypot(unitY[0]-origin[0],unitY[1]-origin[1]))<1e-10,'one metre must have the same screen length in each RAW direction');
    assertGrid(map.box,'RAW');
    assertMetreGrid(map,'RAW');
    for (const heatField of ['Dbar','betaHat']) {
      const bottomCanvas=makeCanvas();bottomCanvas.clientWidth=560;bottomCanvas.clientHeight=216;
      const bottom=new DrfMap(bottomCanvas);
      bottom.set({...map.state,mode:undefined,aspectMode:'equal',heatField});bottom.paint(bottomCanvas,2);
      const bottomView=JSON.parse(bottomCanvas.dataset.view);
      assert.deepEqual([bottom.camera.cx,bottom.camera.cy],[map.camera.cx,map.camera.cy],`${heatField}: full map uses the same visible wall center as RAW`);
      assert.equal(bottom.camera.scaleX,bottom.camera.scaleY,`${heatField}: metres must remain isometric`);
      assert.equal(bottom.camera.scaleX,Math.min(bottom.box.w/(60*1.04),bottom.box.h/(18*1.04)),`${heatField}: automatic fit uses the visible wall range`);
      assert.ok(bottomView.xmin<=0 && bottomView.xmax>=60 && bottomView.ymin<=6 && bottomView.ymax>=24,`${heatField}: both wall endpoints must fit the smaller panel`);
      const visibleView=bottomCanvas.dataset.view,visibleFloor={...bottom.defaultScale};
      bottom.set({...bottom.state,layers:{showTruth:false}});bottom.paint(bottomCanvas,2);
      assert.equal(bottomCanvas.dataset.view,visibleView,`${heatField}: hiding truth preserves the automatic camera`);
      assert.deepEqual(bottom.defaultScale,visibleFloor,`${heatField}: hiding truth preserves the zoom floor`);
      bottom.fit();bottom.paint(bottomCanvas,2);
      assert.equal(bottomCanvas.dataset.view,visibleView,`${heatField}: reset while truth is hidden uses the same view`);
      bottom.zoom(1.3,[100,80]);bottom.paint(bottomCanvas,2);
      const manualView=bottomCanvas.dataset.view;
      bottom.set({...bottom.state,layers:{showTruth:true}});bottom.paint(bottomCanvas,2);
      assert.equal(bottomCanvas.dataset.view,manualView,`${heatField}: showing truth preserves the manual camera`);
      assert.deepEqual(bottom.defaultScale,visibleFloor);
    }
    const beforeExit=map.state,exitWire={t:80,configs:[{i:1,j:2,pHat_i:[120,15],pHat_j:[150,16]}]};
    for (const [name,mode,heatField] of [['RAW','geometry','Dbar'],['density',undefined,'Dbar'],['contrast',undefined,'betaHat']]) {
      const exitMap=name==='RAW' ? map : new DrfMap(makeCanvas()),exitCanvas=exitMap.canvas;
      exitMap.set({...beforeExit,mode,heatField,aspectMode:'equal'});exitMap.fit();exitMap.paint(exitCanvas,1);
      const initialCamera={...exitMap.camera},initialView=exitCanvas.dataset.view,initialFloor={...exitMap.defaultScale};
      const exitState={...exitMap.state,frame:{...frame,t:80},wire:exitWire,proxy:[[300,400]],layers:{showTruth:true,showVehicles:true,showProxy:true},
        history:[exitWire,{t:81,configs:[{pHat_i:[999,999],pHat_j:[1000,999]}]}]},record=JSON.stringify(exitState);
      exitMap.set(exitState);exitMap.paint(exitCanvas,1);
      assert.deepEqual(exitMap.camera,initialCamera,`${name}: advancing outside the map must not recenter or rescale`);
      assert.equal(exitCanvas.dataset.view,initialView,`${name}: current/past/future poses and wall candidates cannot expand the map`);
      assert.deepEqual(exitMap.defaultScale,initialFloor,`${name}: advancing cannot alter the zoom floor`);
      const outside=mapToScreen(exitWire.configs[0].pHat_j,exitMap.camera,exitMap.box);
      assert.ok(outside[0]>exitMap.box.x+exitMap.box.w,`${name}: the exiting vehicle stays clipped instead of changing the camera`);
      exitMap.set({...exitState,layers:{showTruth:false,showVehicles:false,showProxy:false}});exitMap.paint(exitCanvas,1);
      assert.equal(exitCanvas.dataset.view,initialView,`${name}: layer toggles retain the static view`);
      exitMap.zoom(1.3,[100,80]);exitMap.paint(exitCanvas,1);const manualCamera={...exitMap.camera};
      exitMap.set({...exitState,frame:{...frame,t:81}});exitMap.paint(exitCanvas,1);
      assert.deepEqual(exitMap.camera,manualCamera,`${name}: advancing preserves manual zoom`);
      exitMap.fit();exitMap.paint(exitCanvas,1);
      assert.equal(exitCanvas.dataset.view,initialView,`${name}: reset restores the initial scene view after vehicles exit`);
      assert.equal(JSON.stringify(exitState),record,`${name}: fixed framing must not mutate field, measured poses or evaluation candidates`);
    }
    map.set(beforeExit);map.paint(canvas,1);
    map.zoom(1.3,[100,80]);map.paint(canvas,2);
    const manualCamera={...map.camera},manualView=canvas.dataset.view,manualBox={...map.box};
    labels.length=0;assert.ok(await map.png() instanceof Blob);
    assert.ok(labels.includes('Axes: equal metres'),'RAW PNG must report its effective metric scale');
    assert.ok(!labels.includes('Axes: independent '));
    assert.deepEqual(map.camera,manualCamera,'selected-axis PNG export must not reset the manual screen camera');
    assert.equal(canvas.dataset.view,manualView,'PNG export must leave the screen viewport unchanged');
    assert.deepEqual(map.box,manualBox,'PNG export must leave the screen hit-test box unchanged');
    map.zoom(1000);gridSegments.length=0;labels.length=0;map.paint(canvas,2);
    assertMetreGrid(map,'magnified RAW');
    assert.ok(gridSegments.length<=2,'magnification must retain the 10 m grid instead of adding dense fractional-metre ticks');
    assert.ok(labels.filter(text=>/^-?\d+$/.test(text)).every(text=>Number(text)%10===0),'magnified map labels must retain 10 m world coordinates');
    map.set({...map.state,mode:undefined,aspectMode:'fill'});map.fit();map.paint(canvas,2);
    assert.notEqual(map.camera.scaleX,map.camera.scaleY,'field fill mode retains its selected independent scales');
    labels.length=0;assert.ok(await map.png() instanceof Blob);
    assert.ok(labels.includes('Axes: independent ') && labels.includes(' scale'),'field fill PNG reports independent scales');
    map.set({...map.state,aspectMode:'equal'});map.fit();map.paint(canvas,2);
    assert.equal(map.camera.scaleX,map.camera.scaleY,'explicit equal-axis mode preserves metres in both directions');
    labels.length=0;assert.ok(await map.png() instanceof Blob);
    assert.ok(labels.includes('Axes: equal metres'),'equal-axis export must disclose its metric scale');
    assert.deepEqual([...frame.Dbar],[0,1,2,3]);
    assert.deepEqual([...frame.betaHat],[0,...new Float32Array([.2,.5]),1],'display and export must not mutate either field');
    canvas.clientWidth=700;
    const fixedCanvas=makeCanvas(),fixedMap=new DrfMap(fixedCanvas),fixedWalls=[[[0,-20],[80,0]],[[0,35],[80,50]]];
    fixedMap.set({mode:'geometry',xRange:[-10,90],domain:[0,80,-20,50],walls:fixedWalls,frame,layers:{showTruth:true}});
    const assertFixed=()=>{
      fixedMap.paint(fixedCanvas,1);const view=JSON.parse(fixedCanvas.dataset.view);
      assert.ok(Math.abs(view.xmin+10)<1e-9 && Math.abs(view.xmax-90)<1e-9,'RAW default x range is exactly -10..90 m');
      assert.equal(view.pixelsPerMetreX,view.pixelsPerMetreY,'RAW retains equal metres on both axes');
      assert.ok(view.ymin<=-20 && view.ymax>=50,'Tall walls must fit rather than be clipped');
    };
    assertFixed();const fixedCamera={...fixedMap.camera};
    fixedMap.set({...fixedMap.state,wire:{configs:[{pHat_i:[104,15],pHat_j:[150,16]}]},layers:{showTruth:false}});assertFixed();
    assert.deepEqual(fixedMap.camera,fixedCamera,'Vehicles exiting and hiding truth must leave the camera fixed');
    fixedMap.zoom(1.3);fixedMap.fit();assertFixed();
    fixedMap.fit(true);assertFixed();
    fixedMap.camera.cx+=10;fixedMap.auto=false;fixedCanvas.listeners.wheel({preventDefault(){},deltaY:1,offsetX:100,offsetY:80});assertFixed();
    fixedCanvas.clientWidth=1700;fixedCanvas.clientHeight=350;fixedMap.fit();assertFixed();
    labels.length=0;drawProfile(canvas,[{s:[10,6],wall:0,delta:.1,w:.5,lambda:.1}],[0,80]);assert.ok(labels.filter(text=>text==='80').length>=3,'All three profiles extend to 80 m');
    labels.length=0;drawMetricHistory(canvas,[],'p95',120);assert.ok(labels.includes('120'),'The default history includes 120 snapshots');
    canvas.clientHeight=540;
    for (const [draw, message] of [[()=>drawHistogram(canvas,[]),'No eligible ratio samples'],[()=>drawProfile(canvas,[]),'No profile selected'],[()=>drawCounts(canvas,[],[]),'No count samples']]) {
      labels.length=0;strokes.length=0;draw();
      assert.deepEqual(labels,[message],'Empty diagnostics show an explicit message instead of synthetic result axes');
      assert.equal(strokes.length,0,'No theoretical/reference line is drawn without empirical samples');
    }
    for (const draw of [()=>drawSweep(canvas,[{roughness:2,sigmaD:.1,medianError:{mean:.13,sd:.02}}],[{roughness:2,sigmaD:.1,medianError:.134}]),()=>drawHistogram(canvas,[-.1,.1,.4,1,2]),()=>drawCounts(canvas,[10,20],[11,19])]) {
      rectangles.length=0;gridSegments.length=0;draw();
      assert.equal(rectangles.length,1);
      assert.ok(rectangles[0][2]>=canvas.clientWidth*.85 && rectangles[0][3]>=canvas.clientHeight*.65,'each analysis chart uses most of its allocated area');
      assertChartGrids('analysis');
    }
    rectangles.length=0;gridSegments.length=0;labels.length=0;canvas.clientHeight=600;
    drawProfile(canvas,[{s:[10,6],wall:0,delta:.1,w:.5,lambda:.1},{s:[20,22],wall:1,delta:.2,w:.3,lambda:.06}]);
    assert.equal(rectangles.length,3);
    assert.ok(rectangles.every(([, , ,height])=>height>=130),'every profile subplot must use most of its allotted height');
    assertChartGrids('profile');
    for (const [x,y,w,h] of rectangles) {
      const vertical=gridSegments.filter(([a,b])=>Math.abs(a[0]-b[0])<1e-8 && Math.abs(a[1]-y)<1e-8 && Math.abs(b[1]-y-h)<1e-8);
      assert.equal(vertical.length,5,'profile must use 10 m x grid at 10, 20, 30, 40 and 50 m');
      vertical.forEach(([a],k)=>assert.ok(Math.abs((a[0]-x)/w*60-(k+1)*10)<1e-8));
    }
    for (const tick of ['0','10','20','30','40','50','60']) assert.ok(labels.filter(text=>text===tick).length>=3,`each profile must label ${tick} m`);
    const spans=createWalls({ scene: 'reference' }),fleet=generateSnapshot(normalizeInput({scene:'reference',vehicles:20,snapshots:1}),spans,1),wireBefore=JSON.stringify(fleet.wire),fleetCanvas=makeCanvas(),stats={textContent:''};
    fleetCanvas.clientWidth=480;fleetCanvas.clientHeight=220;fleetCanvas.closest=()=>({querySelector:()=>stats});
    const fleetMap=new DrfMap(fleetCanvas),fleetState={grid:{nx:2,ny:2,domain:[0,60,0,30]},frame:{...frame,t:1},wire:fleet.wire,walls:sampleWalls(spans),history:[fleet.wire],aspectMode:'equal',layers:{showTruth:true,showVehicles:true,showEllipses:true}};
    labelPositions.length=0;dots.length=0;ellipseStarts.length=0;
    fleetMap.set({...fleetState,mode:'geometry'});fleetMap.paint(fleetCanvas,1);
    const allPaths=fleet.wire.configs.flatMap(c=>c.paths.map(q=>({c,q}))),stride=Math.ceil(allPaths.length/600);
    const sampled=allPaths.filter(({c,q},i)=>i%stride===0 && q.dHat>Math.hypot(c.pHat_j[0]-c.pHat_i[0],c.pHat_j[1]-c.pHat_i[1]));
    assert.ok(allPaths.length>600 && ellipseStarts.length<=600,'large fleets must retain a bounded ellipse overlay');
    assert.equal(ellipseStarts.length,sampled.length,'ellipse sampling follows global wire order rather than a per-pair limit');
    sampled.forEach(({c,q},i)=> {
      const a=c.pHat_i,b=c.pHat_j,angle=Math.atan2(b[1]-a[1],b[0]-a[0]),expected=mapToScreen([(a[0]+b[0])/2+q.dHat/2*Math.cos(angle),(a[1]+b[1])/2+q.dHat/2*Math.sin(angle)],fleetMap.camera,fleetMap.box);
      expected.forEach((value,k)=>assert.ok(Math.abs(value-ellipseStarts[i][k])<1e-8,'sampled ellipse must come from the unchanged measured path'));
    });
    assert.equal(fleetCanvas.dataset.ellipseTotal,String(allPaths.length));assert.equal(fleetCanvas.dataset.ellipseShown,String(sampled.length));
    assert.equal(stats.textContent,`${sampled.length} ellipses shown / ${allPaths.length} ranges`);
    const smallWire={...fleet.wire,configs:fleet.wire.configs.filter(c=>c.i<=3 && c.j<=3)};
    ellipseStarts.length=0;fleetMap.set({...fleetState,wire:smallWire,mode:'geometry'});fleetMap.paint(fleetCanvas,1);
    const smallPaths=smallWire.configs.reduce((sum,c)=>sum+c.paths.length,0);
    assert.ok(smallPaths<600);assert.equal(Number(fleetCanvas.dataset.ellipseShown),smallPaths,'small fleets retain every valid ellipse');
    for (const mode of ['geometry',undefined]) {
      labelPositions.length=0;dots.length=0;
      fleetMap.set({...fleetState,mode,layers:{...fleetState.layers,showEllipses:false}});fleetMap.fit();fleetMap.paint(fleetCanvas,1);
      assert.equal(dots.length,20,'every measured vehicle must retain its point when a number is omitted');
      assert.ok(labelPositions.length>0 && labelPositions.length<=20);
      const boxes=labelPositions.map(([text,x,y])=>({left:x-text.length*9/2-4,right:x+text.length*9/2+4,top:y-18,bottom:y+6})),b=fleetMap.box;
      for (const [i,box] of boxes.entries()) {
        assert.ok(box.left>=b.x && box.right<=b.x+b.w && box.top>=b.y && box.bottom<=b.y+b.h,'20-vehicle number labels must stay inside either plot');
        assert.ok(boxes.slice(i+1).every(other=>box.right<=other.left || box.left>=other.right || box.bottom<=other.top || box.top>=other.bottom),'number labels must not overlap');
        assert.ok(dots.every(([x,y])=>box.right<=x-7 || box.left>=x+7 || box.bottom<=y-7 || box.top>=y+7),'number backgrounds must not cover any vehicle marker or its 2 px margin');
      }
      if (mode==='geometry') {assert.equal(stats.textContent,'Ellipses hidden');assert.equal(fleetCanvas.dataset.ellipseShown,'0');}
    }
    assert.equal(JSON.stringify(fleet.wire),wireBefore,'drawing limits must not remove or reorder estimator measurements');
    assert.deepEqual([...frame.Dbar],[0,1,2,3]);assert.deepEqual([...frame.betaHat],[0,...new Float32Array([.2,.5]),1]);
    for (const [name,mode,heatField,aspectMode] of [['RAW','geometry','Dbar','fill'],['density',undefined,'Dbar','equal'],['contrast',undefined,'betaHat','fill']]) {
      const floorCanvas=makeCanvas(),floorMap=new DrfMap(floorCanvas),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${name}: ${a} != ${b}`);
      const selectedFrame={...frame,t:59,Q:2859};
      floorMap.set({grid:{nx:2,ny:2,domain:[0,60,0,30]},frame:selectedFrame,wire:{t:59,configs:[]},history:[{t:59}],mode,heatField,aspectMode,layers:{}});floorMap.paint(floorCanvas,2);
      const viewState=floorMap.state,recordBefore=JSON.stringify(viewState);
      const initial={...floorMap.camera},anchor=[floorMap.box.x+floorMap.box.w*.3,floorMap.box.y+floorMap.box.h*.6];
      floorMap.zoom(1/1.3);assert.deepEqual(floorMap.camera,initial,`${name}: minus button cannot shrink the default view`);
      assert.equal(floorMap.auto,true,`${name}: a blocked zoom must preserve automatic fit`);
      let prevented=false;
      floorCanvas.listeners.wheel({deltaY:1e6,offsetX:anchor[0],offsetY:anchor[1],preventDefault(){prevented=true;}});
      floorMap.paint(floorCanvas,1);
      assert.equal(prevented,true);assert.deepEqual(floorMap.camera,initial,`${name}: wheel cannot shrink the default view`);
      const wheel=deltaY=> {floorCanvas.listeners.wheel({deltaY,offsetX:anchor[0],offsetY:anchor[1],preventDefault(){}});floorMap.paint(floorCanvas,1);};
      const pan=()=> {
        floorCanvas.listeners.pointerdown({button:0,pointerId:1,clientX:anchor[0],clientY:anchor[1]});
        floorCanvas.listeners.pointermove({clientX:anchor[0]+25,clientY:anchor[1]+17,offsetX:anchor[0]+25,offsetY:anchor[1]+17});
        floorCanvas.listeners.pointerup();
      };
      pan();const pannedDefault={...floorMap.camera};
      floorMap.zoom(1/1.3);assert.deepEqual(floorMap.camera,pannedDefault,`${name}: minus at the floor preserves manual panning`);
      wheel(0);assert.deepEqual(floorMap.camera,pannedDefault,`${name}: zero wheel delta must not reset the view`);
      wheel(1);assert.deepEqual(floorMap.camera,initial,`${name}: further wheel zoom-out at the floor restores the default centre and scale`);
      assert.equal(floorMap.auto,true,`${name}: wheel reset restores automatic fit`);
      const world=mapToWorld(anchor,floorMap.camera,floorMap.box);
      floorCanvas.listeners.wheel({deltaY:-Math.log(2)*1000,offsetX:anchor[0],offsetY:anchor[1],preventDefault(){}});
      mapToWorld(anchor,floorMap.camera,floorMap.box).forEach((value,k)=>near(value,world[k]));
      near(floorMap.camera.scaleX,initial.scaleX*2);near(floorMap.camera.scaleY,initial.scaleY*2);
      pan();
      assert.equal(floorMap.auto,false);assert.ok(floorMap.camera.cx!==initial.cx || floorMap.camera.cy!==initial.cy,`${name}: panning remains available`);
      const pannedWorld=mapToWorld(anchor,floorMap.camera,floorMap.box);
      wheel(1e6);
      near(floorMap.camera.scaleX,initial.scaleX);near(floorMap.camera.scaleY,initial.scaleY);
      assert.equal(floorMap.auto,false,`${name}: the first wheel zoom-out from above the floor reaches the floor without resetting`);
      mapToWorld(anchor,floorMap.camera,floorMap.box).forEach((value,k)=>near(value,pannedWorld[k]));
      const fittedSpan=JSON.parse(floorCanvas.dataset.view);
      near(fittedSpan.xmax-fittedSpan.xmin,floorMap.box.w/initial.scaleX);near(fittedSpan.ymax-fittedSpan.ymin,floorMap.box.h/initial.scaleY);
      wheel(1);assert.deepEqual(floorMap.camera,initial,`${name}: only the subsequent wheel zoom-out resets the view`);
      pan();floorMap.camera.scaleX*=1+8*Number.EPSILON;floorMap.camera.scaleY*=1+8*Number.EPSILON;
      wheel(1);assert.deepEqual(floorMap.camera,initial,`${name}: floating-point roundoff must not prevent floor reset`);
      pan();floorMap.camera.scaleX*=1+2e-12;floorMap.camera.scaleY*=1+2e-12;
      wheel(1e6);assert.equal(floorMap.auto,false,`${name}: a view above the tolerance still reaches the floor first`);
      wheel(1);assert.deepEqual(floorMap.camera,initial);
      assert.equal(floorMap.state,viewState,`${name}: wheel reset preserves the selected display state`);
      assert.equal(floorMap.state.frame,selectedFrame);assert.equal(floorMap.state.frame.t,59);assert.equal(floorMap.state.frame.Q,2859);
      assert.equal(JSON.stringify(viewState),recordBefore,`${name}: wheel reset must not mutate fields, measurements or history`);
      pan();
      const panCenter=[floorMap.camera.cx,floorMap.camera.cy],axisRatio=floorMap.camera.scaleX/floorMap.camera.scaleY;
      floorCanvas.clientWidth=1400;floorCanvas.clientHeight=700;floorMap.paint(floorCanvas,2);
      let extent=[60,30];
      const expected=()=> {
        let x=floorMap.box.w/(extent[0]*1.04),y=floorMap.box.h/(extent[1]*1.04);
        if (mode==='geometry' || aspectMode==='equal') x=y=Math.min(x,y);
        return [x,y];
      };
      let minimum=expected();
      assert.ok(floorMap.camera.scaleX>=minimum[0]-1e-9 && floorMap.camera.scaleY>=minimum[1]-1e-9,`${name}: resize immediately enforces the new default floor`);
      near(floorMap.camera.cx,panCenter[0]);near(floorMap.camera.cy,panCenter[1]);near(floorMap.camera.scaleX/floorMap.camera.scaleY,axisRatio);
      floorMap.set({...floorMap.state,layers:{showTruth:true},walls:[[[10,6],[50,24]]]});floorMap.paint(floorCanvas,1);
      extent=[40,18];
      let wallX=floorMap.box.w/(40*1.04),wallY=floorMap.box.h/(18*1.04);
      if (mode==='geometry' || aspectMode==='equal') wallX=wallY=Math.min(wallX,wallY);
      assert.ok(floorMap.camera.scaleX>=wallX-1e-9 && floorMap.camera.scaleY>=wallY-1e-9,`${name}: a changed visible range updates the default floor`);
      near(floorMap.camera.cx,panCenter[0]);near(floorMap.camera.cy,panCenter[1]);
      const beforeHide=JSON.parse(floorCanvas.dataset.view),defaultBeforeHide={...floorMap.defaultScale};
      floorMap.set({...floorMap.state,layers:{showTruth:false}});floorMap.paint(floorCanvas,1);
      const afterHide=JSON.parse(floorCanvas.dataset.view);
      for (const key of Object.keys(beforeHide)) typeof beforeHide[key]==='number' ? near(afterHide[key],beforeHide[key]) : assert.equal(afterHide[key],beforeHide[key],`${name}: hiding truth preserves the panned camera`);
      assert.deepEqual(floorMap.defaultScale,defaultBeforeHide,`${name}: hiding truth preserves the resize floor`);
      floorCanvas.clientWidth=360;floorCanvas.clientHeight=220;floorMap.paint(floorCanvas,1);
      floorMap.zoom(.0001,anchor);floorMap.paint(floorCanvas,1);minimum=expected();
      assert.ok(floorMap.camera.scaleX>=minimum[0]-1e-9 && floorMap.camera.scaleY>=minimum[1]-1e-9,`${name}: a smaller viewport allows only its own default floor`);
      assert.ok(Math.abs(floorMap.camera.scaleX-minimum[0])<1e-9 || Math.abs(floorMap.camera.scaleY-minimum[1])<1e-9,`${name}: zoom-out must reach the floor instead of retaining a stale large-view minimum`);
      floorMap.fit();floorMap.paint(floorCanvas,1);near(floorMap.camera.scaleX,minimum[0]);near(floorMap.camera.scaleY,minimum[1]);
      near(floorMap.camera.cx,30);near(floorMap.camera.cy,15);assert.equal(floorMap.state.frame,selectedFrame);
      if (mode!=='geometry' && aspectMode==='fill') {
        floorMap.zoom(2,anchor);floorCanvas.clientWidth=1400;floorMap.paint(floorCanvas,1);minimum=expected();
        near(floorMap.camera.scaleX,minimum[0]);assert.ok(floorMap.camera.scaleY>minimum[1],`${name}: resize can put only one independent axis at its floor`);
        wheel(1);near(floorMap.camera.scaleX,minimum[0]);near(floorMap.camera.scaleY,minimum[1]);
        near(floorMap.camera.cx,30);near(floorMap.camera.cy,15);assert.equal(floorMap.auto,true,`${name}: a wheel attempt at either limiting axis restores both default scales`);
      }
      floorMap.zoom(1e9,anchor);assert.ok(floorMap.camera.scaleX<=100000 && floorMap.camera.scaleY<=100000,`${name}: retain the existing maximum scale`);
      floorMap.zoom(.0001,anchor);floorMap.paint(floorCanvas,1);
      assert.ok(floorMap.camera.scaleX>=minimum[0]-1e-9 && floorMap.camera.scaleY>=minimum[1]-1e-9);
    }
    // Truth must not cover support, and drawing must preserve actual patch gaps
    // even with overlapping supported patches and a narrow display.
    const patchCanvas=makeCanvas(),patchMap=new DrfMap(patchCanvas),patchState={
      mode:'geometry',aspectMode:'equal',cameraBounds:[0,30,0,30],domain:[0,30,0,30],frame:{t:1},
      walls:[[[0,10],[30,10]]],layers:{showTruth:true,showProxy:true},
      candidates:[10,11.5,16].map(x=>({center:[x,10],phi:0,kappa:0,sg:1,ell:1,status:'supported'}))
    },patchBefore=JSON.stringify(patchState);
    for (const width of [700,250]) {
      patchCanvas.clientWidth=width;patchMap.set(patchState);patchMap.fit();strokes.length=0;patchMap.paint(patchCanvas,1);
      const truthIndex=strokes.findIndex(s=>s.dash.join(',')==='7,5'),casings=strokes.filter(s=>s.width===8),support=strokes.filter(s=>s.color==='#009e73');
      assert.equal(casings.length,3);assert.equal(support.length,3,'Each supported patch must remain an independent path');
      assert.ok(truthIndex>=0 && truthIndex<strokes.indexOf(casings[0]),'Truth must be behind support');
      assert.ok(strokes.indexOf(casings.at(-1))<strokes.indexOf(support[0]),'Later casings must not erase earlier support');
      support.forEach((s,k)=>{
        assert.equal(s.width,5);assert.equal(s.cap,'butt','Round endpoints would visually bridge short unsupported gaps');
        assert.deepEqual(s.dash,[]);assert.equal(s.segments.length,20);
        const endpoints=[s.segments[0][0],s.segments.at(-1)[1]].map(p=>mapToWorld(p,patchMap.camera,patchMap.box)[0]);
        const expected=[[9,11],[10.5,12.5],[15,17]][k];
        endpoints.forEach((x,j)=>assert.ok(Math.abs(x-expected[j])<1e-9,'Patch support extent must not expand or connect across its gap'));
      });
    }
    assert.equal(JSON.stringify(patchState),patchBefore,'Presentation must not alter inferred patch geometry or status');
    canvas.clientHeight=540;
    const mobile=makeCanvas();mobile.clientWidth=250;mobile.clientHeight=385;
    const surf=new SurfaceMap(mobile,()=>{});
    surf.set({config:{shape:'arc',nBots:3},evaluation:{wall:[]},raw:{poses:[]}},{fit:{status:'UNIQUE'},cross:{candidates:[],predictions:[]},curves:[],predictions:[]},{truth:true,curve:true});
    assert.ok(await surf.png() instanceof Blob);
    assert.ok(created.at(-1).height>Math.round((385+104)*300/96),'mobile captions must wrap into a taller export');
  } finally {for (const [key,value] of Object.entries(saved)) value===undefined ? delete globalThis[key] : globalThis[key]=value;}
});


test('comparison navigation links cameras without sharing estimator data or changing single views',()=>{
  const left={camera:{cx:10,cy:2,scaleX:3,scaleY:3},auto:false,fullDomain:false,state:{candidates:[1]},draw(){}},
    right={camera:null,auto:true,state:{candidates:[2]},draw(){}};
  let paired=true;linkMapCameras(left,right,()=>paired);
  left.onCameraChange();assert.deepEqual(right.camera,left.camera);assert.notEqual(right.camera,left.camera);
  assert.deepEqual(right.state.candidates,[2]);assert.equal(right.auto,false);
  right.camera.cx=20;right.onCameraChange();assert.equal(left.camera.cx,20);
  right.camera=null;right.auto=true;right.fullDomain=true;right.onCameraChange();
  assert.equal(left.camera,null);assert.equal(left.auto,true);assert.equal(left.fullDomain,true);
  paired=false;left.camera={cx:4};left.onCameraChange();assert.equal(right.camera,null);
});
