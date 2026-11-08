import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

test('interpolation panel follows method and geometry without changing raw recall',async()=>{
  const {renderInterpolationPanel}=await import('../../drf/interpolation-panel.mjs');
  const {window}=new JSDOM(readFileSync(new URL('../../drf.html',import.meta.url),'utf8'));
  const $=id=>window.document.getElementById(id),fmt=(value,places)=>value.toFixed(places);
  const frame={methods:{guarded:{recall:.5,missing:5,interpolation:{recall:.7,missing:3,hermite:{recall:.8,missing:2}}},baseline:{recall:.4,missing:6,interpolation:{recall:.6,missing:4}}}};
  const render=(mode,kind='linear',f=frame)=>renderInterpolationPanel($,mode,kind,f,fmt);
  const recalls=()=>Array.from($('interpolationMetrics').rows[1].cells).slice(1).map(c=>c.textContent);
  render('guarded');assert.deepEqual(recalls(),['50.0','70.0']);assert.equal($('historyFirst').textContent,'Before');assert.equal($('methodMetrics').hidden,true);
  const selector=$('interpolationChartMetric');
  assert.equal(selector.hidden,false);
  assert.deepEqual(Array.from(selector.options,o=>o.value),Array.from($('interpolationMetrics').tBodies[0].rows,r=>r.dataset.metric));
  selector.value='count';
  render('guarded','hermite');assert.deepEqual(recalls(),['50.0','80.0']);
  render('baseline');assert.deepEqual(recalls(),['40.0','60.0']);
  render('baseline','hermite');assert.deepEqual(recalls(),['40.0','—']);
  render('guarded','linear',null);assert.deepEqual(recalls(),['—','—']);
  render('compare');assert.equal($('interpolationMetrics').hidden,true);assert.equal($('methodMetrics').hidden,false);assert.equal($('historySecond').textContent,'WM-F');assert.equal($('historyMetric').hidden,false);
  assert.equal(selector.hidden,true);
  render('baseline');
  assert.equal(selector.value,'count');
  assert.match($('metricChart').getAttribute('aria-label'),/WM-F Gaps joined/);
  window.close();
});
