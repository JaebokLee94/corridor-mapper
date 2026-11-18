import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { experimentSettings } from '../../drf/experiment-settings.mjs';
import { EchoComparison, echoProtocol } from '../../drf/echo-comparison.mjs';
import { createSceneGeometry,generateSnapshot } from '../../drf/scenario.mjs';
import { gpSubset } from '../../drf/gat-gpr.mjs';
import { rightMethods, activeRightMethods, canonicalRightMethod } from '../../drf/right-methods.mjs';
import { fitMethodLabel, setMethodLabel } from '../../drf/method-label.mjs';

for(const [full,short] of [['EchoSpline-GBDT','ES-GBDT'],['EchoSpline-CNN (Rugged Wall Recovery)','EchoSpline-CNN']])
test(`a wrapped ${full} label keeps its accessible name and expands again when it fits`,()=>{
  const doc=new JSDOM('<table><tr><th></th></tr></table>').window.document;
  const heading=doc.querySelector('th');
  let lines=[{width:60},{width:40}];
  heading.getClientRects=()=>[{width:60}];
  doc.defaultView.Range.prototype.getClientRects=()=>lines;
  setMethodLabel(heading,full);
  assert.equal(heading.textContent,short);
  assert.equal(heading.getAttribute('aria-label'),full);
  lines=[{width:120}];
  fitMethodLabel(heading);
  assert.equal(heading.textContent,full);
  setMethodLabel(heading,'WM-P');
  assert.equal(heading.textContent,'WM-P');
  assert.equal(heading.hasAttribute('aria-label'),false);
});

test('the map heading owns the ordered selector; its form still saves/defaults the experiment',()=>{
  const dom=new JSDOM(readFileSync(new URL('../../drf.html',import.meta.url),'utf8'));
  const doc=dom.window.document,select=doc.querySelector('#rightMethod');
  assert.equal(select.closest('#baselinePane h3')?.contains(select),true);
  assert.equal(doc.querySelector('#experimentSidebar').contains(select),false);
  assert.equal(select.form,doc.querySelector('#settings'));
  assert.deepEqual(Object.keys(rightMethods),['gat','wmp','gbdt','spline-cnn','spline-cnn-fast','pair-ridge','pair-gbdt','pair-extra-trees','arc']);
  assert.deepEqual(Array.from(select.options).filter(o=>!o.hidden).map(o=>o.value),['gat','wmp','gbdt','spline-cnn-fast','pair-ridge','pair-gbdt','pair-extra-trees']);
  assert.deepEqual(activeRightMethods,Object.keys(rightMethods).filter(id=>id!=='spline-cnn'));
  assert.equal(rightMethods['spline-cnn'].name,'이전 EchoSpline-CNN');
  assert.equal(rightMethods['spline-cnn'].deprecated,true);
  assert.equal(experimentSettings({rightMethod:'wmf'}).rightMethod,undefined);
  for(const option of select.options)assert.equal(option.text,rightMethods[option.value].name);
  assert.equal(select.value,'wmp');assert.equal(doc.querySelector('#showInterpolation').checked,true);
  select.value='gbdt';assert.equal(new dom.window.FormData(select.form).get('rightMethod'),'gbdt');
  select.value='arc';assert.equal(new dom.window.FormData(select.form).get('rightMethod'),'arc');
  select.value='spline-cnn-fast';assert.equal(new dom.window.FormData(select.form).get('rightMethod'),'spline-cnn-fast');
  assert.equal(rightMethods['spline-cnn-fast'].name,'EchoSpline-CNN');
  const saved=experimentSettings({rightMethod:'spline-cnn-fast'});
  assert.equal(experimentSettings(JSON.parse(JSON.stringify(saved))).rightMethod,'spline-cnn-fast');
  assert.equal(experimentSettings({rightMethod:'spline-cnn'}).rightMethod,'spline-cnn-fast');
  assert.equal(canonicalRightMethod('spline-cnn'),'spline-cnn-fast');
  assert.equal(canonicalRightMethod('wmf'),'wmp');
  assert.equal(experimentSettings({rightMethod:'arc'}).rightMethod,'arc');
  assert.equal(experimentSettings({}).rightMethod,undefined);
  assert.throws(()=>experimentSettings({rightMethod:'invalid'}));
});

test('frozen learned methods reproduce independent Python estimates on a shared prefix',async()=>{
  const input=experimentSettings({scene:'paper-upper',vehicles:3,snapshots:16,seed:3296639392,sigmaDGeometry:3});
  const g=createSceneGeometry(input),ws=Array.from({length:16},(_,i)=>generateSnapshot(input,g.spans,i+1,g.wallModel).wire);
  // Original PyTorch/SciPy and sklearn outputs. Tolerances cover float32 network arithmetic.
  const references={gat:[1200,600,29.14453771,24.46586186,.001],arc:[16,8,7,35.52304860,.001],gbdt:[246,123,24.6,28.80830231,.001]};
  let left;
  for(const [id,[length,index,x,y,tolerance]] of Object.entries(references)){
    const model=new EchoComparison({...input,rightMethod:id},g.domain);
    await model.loadModel();let last;
    for(const wire of ws)last=model.step(wire);
    assert.equal(last.guarded.curves[0].length,length);
    const point=last.guarded.curves[0][index];
    assert.ok(Math.abs(point[0]-x)<tolerance && Math.abs(point[1]-y)<tolerance,id);
    if(left)assert.deepEqual(last.echoSpline.curves,left);else left=last.echoSpline.curves;
  }
  assert.deepEqual(gpSubset(1502).slice(0,5),[317,1404,1425,954,1257]);
});


test('current CNN and its saved alias share the fixed anchor while historical protocol metadata stays distinct',()=>{
  for(const rightMethod of ['spline-cnn','spline-cnn-fast']){
    const input={scene:'paper-upper',vehicles:3,rightMethod},domain=[0,100,-20,50];
    const shared=new EchoComparison(input,domain),custom=new EchoComparison({...input,echoKnotM:4},domain);
    assert.equal(shared.id,'spline-cnn-fast');assert.equal(custom.id,'spline-cnn-fast');
    assert.equal(shared.cnnConfigs,undefined);assert.equal(custom.cnnConfigs,undefined);
    assert.equal(shared.protocol.guarded.id,'spline-cnn-fast');
    assert.equal(shared.fixedSpline,shared.spline);
    assert.notEqual(custom.fixedSpline,custom.spline);
    assert.equal(echoProtocol(input).guarded.id,rightMethod);
    shared.close();custom.close();
  }
  assert.notEqual(echoProtocol({rightMethod:'spline-cnn-fast'}).guarded.revision,echoProtocol({rightMethod:'spline-cnn'}).guarded.revision);
  assert.equal(echoProtocol({rightMethod:'spline-cnn'}).guarded.name,'이전 EchoSpline-CNN');
  const defaults=new EchoComparison({vehicles:3},[0,100,-20,50]);
  assert.equal(defaults.id,'wmp');defaults.close();
});
