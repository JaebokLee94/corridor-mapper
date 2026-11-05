import test from 'node:test';
import assert from 'node:assert/strict';
import {createField,createGrid} from '../../drf/field.mjs';
import {createFieldUpdateCache} from '../../drf/field-reuse.mjs';

function snapshot(t = 1) {
  return {t,configs:[{i:0,j:1,pHat_i:[2+t/10,2],pHat_j:[5+t/10,2],
    Sigma_i:[.01,.001,.02],Sigma_j:[.02,0,.01],
    paths:[{dHat:2,sigmaD:.1},{dHat:8,sigmaD:.1},{dHat:12,sigmaD:.1}]}]};
}

function state(field) {
  return {D:Array.from(field.D),A:Array.from(field.A),...field.readout()};
}

test('field increments are reused with independent float64 accumulation and scratch', () => {
  const grid=createGrid(16,12,[0,20,-4,10]),updateCache=createFieldUpdateCache();
  const first=createField(grid,{updateCache}),second=createField(grid,{updateCache}),reference=createField(grid);
  for(let t=1;t<=5;t++) {
    const wire=snapshot(t);
    first.step(wire);second.step(structuredClone(wire));reference.step(wire);
    assert.deepEqual(state(first),state(reference));
    assert.deepEqual(state(second),state(reference));
    assert.notEqual(first.D,second.D);
    assert.notEqual(first.A,second.A);
    // Later edits to the caller's arrays must not change the owned cache wire.
    wire.configs[0].paths[1].dHat+=100;
  }
  first.D[0]=999;
  assert.deepEqual(state(second),state(reference));
});

test('cache keys include every measured quantity and numerical setting', () => {
  const grid=createGrid(16,12,[0,20,-4,10]);
  for(const mutate of [
    w=>{w.configs[0].pHat_i[0]+=.5;},w=>{w.configs[0].pHat_j[1]+=.5;},
    w=>{w.configs[0].Sigma_i[0]+=.1;},w=>{w.configs[0].Sigma_j[2]+=.1;},
    w=>{w.configs[0].paths[1].dHat+=.2;},
    w=>{for(const p of w.configs[0].paths)p.sigmaD=.2;},
    w=>{w.configs[0].paths=[];},w=>{w.configs=[];},
  ]) {
    const updateCache=createFieldUpdateCache(),source=createField(grid,{updateCache});
    const actual=createField(grid,{updateCache}),reference=createField(grid);
    source.step(snapshot());
    const changed=snapshot();mutate(changed);
    actual.step(changed);reference.step(changed);
    assert.deepEqual(state(actual),state(reference));
  }
  for(const options of [{band:3},{perimeter:'ramanujan'}]) {
    const updateCache=createFieldUpdateCache();
    createField(grid,{updateCache}).step(snapshot());
    const actual=createField(grid,{...options,updateCache}),reference=createField(grid,options);
    actual.step(snapshot());reference.step(snapshot());
    assert.deepEqual(state(actual),state(reference));
  }
  const updateCache=createFieldUpdateCache(),shifted=createGrid(16,12,[1,21,-4,10]);
  createField(grid,{updateCache}).step(snapshot());
  const actual=createField(shifted,{updateCache}),reference=createField(shifted);
  actual.step(snapshot());reference.step(snapshot());
  assert.deepEqual(state(actual),state(reference));
});

test('cache keys follow captured calculation arrays when caller replaces grid coordinates', () => {
  const grid=createGrid(16,12,[0,20,-4,10]),updateCache=createFieldUpdateCache();
  const source=createField(grid,{updateCache}),oldReference=createField({...grid});
  grid.x=Float64Array.from(grid.x,x=>x+2);
  const target=createField(grid,{updateCache}),newReference=createField(grid);
  source.step(snapshot());oldReference.step(snapshot());
  target.step(snapshot());newReference.step(snapshot());
  assert.deepEqual(state(source),state(oldReference));
  assert.deepEqual(state(target),state(newReference));
  assert.notDeepEqual(state(target),state(source));
});

test('cache never substitutes future increments and rejection preserves the field', () => {
  const grid=createGrid(10,8),updateCache=createFieldUpdateCache();
  const ahead=createField(grid,{updateCache}),behind=createField(grid,{updateCache}),reference=createField(grid);
  ahead.step(snapshot(1));ahead.step(snapshot(2));
  behind.step(snapshot(1));reference.step(snapshot(1));
  assert.deepEqual(state(behind),state(reference));
  const before=state(behind),invalid=snapshot(2);
  invalid.configs[0].Sigma_i[0]=-1;
  assert.throws(()=>behind.step(invalid));
  assert.throws(()=>behind.step(snapshot(3)));
  assert.deepEqual(state(behind),before);
  behind.step(snapshot(2));reference.step(snapshot(2));
  assert.deepEqual(state(behind),state(reference));
  assert.throws(()=>createField(grid,{updateCache:{}}),/Invalid/);
});
