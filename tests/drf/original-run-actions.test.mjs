import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Original layout only: the separate design preview has its own run controls.
const source = readFileSync(new URL('../../drf/app.mjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../drf.html', import.meta.url), 'utf8');
const start = source.indexOf('function controls()'), end = source.indexOf('function updateRunProgress()', start);
assert.ok(start >= 0 && end > start);
const actionIds = ['runButton', 'pauseButton', 'stepButton', 'cancelButton'];

function fixture() {
  const nodes = new Map(), state = { mode:'idle', scenario:null, frames:[], selected:0, sweepRuns:[], valid:false, busy:false };
  const document = { body:{ dataset:{} }, activeElement:null };
  const $ = id => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden:false, disabled:false, dataset:{}, focus(){ document.activeElement = this; } });
    return nodes.get(id);
  };
  $('sweepSettings').elements = [];
  const context = vm.createContext({ state, $, form:{ elements:[] }, document, updateRunProgress(){} });
  vm.runInContext(source.slice(start, end), context);
  return { state, $, document, update:context.controls };
}

test('original run area shows only Run initially and switches to the active controls without changing their permissions', () => {
  for (const id of actionIds) {
    const tag = html.match(new RegExp(`<button\\b[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, id);
    assert.equal(/\shidden(?:\s|>|=)/.test(tag), id !== 'runButton', `${id}: initial HTML visibility`);
  }
  const activeActions = ['pauseButton', 'stepButton', 'cancelButton'];
  const cases = [
    { name:'idle', input:{ mode:'idle' }, shown:['runButton'], disabled:[false,true,false,true], label:'Pause' },
    { name:'preparing', input:{ mode:'running', busy:true }, shown:activeActions, disabled:[true,true,true,false], label:'Pause' },
    { name:'running', input:{ mode:'running', scenario:{}, busy:true }, shown:activeActions, disabled:[true,false,true,false], label:'Pause' },
    { name:'paused', input:{ mode:'paused', scenario:{} }, shown:activeActions, disabled:[true,false,false,false], label:'Resume' },
    { name:'pending pause', input:{ mode:'paused', scenario:{}, busy:true, pendingCommand:'pause' }, shown:activeActions, disabled:[true,true,true,false], label:'Resume' },
    { name:'preparing one step', input:{ mode:'paused', busy:true }, shown:activeActions, disabled:[true,true,true,false], label:'Resume' },
    { name:'complete', input:{ mode:'done' }, shown:['runButton'], disabled:[false,true,false,true], label:'Pause' },
    { name:'cancelled', input:{ mode:'cancelled' }, shown:['runButton'], disabled:[false,true,false,true], label:'Pause' },
    { name:'connecting', input:{ mode:'idle', connecting:true }, shown:['runButton'], disabled:[true,true,true,true], label:'Pause' },
    { name:'sweeping', input:{ mode:'idle', sweep:{} }, shown:['runButton'], disabled:[true,true,true,true], label:'Pause' },
  ];
  for (const item of cases) {
    const { state, $, update } = fixture(); Object.assign(state, item.input); update();
    assert.deepEqual(actionIds.filter(id => !$(id).hidden), item.shown, `${item.name}: visible actions`);
    assert.deepEqual(actionIds.map(id => $(id).disabled), item.disabled, `${item.name}: existing permission rules`);
    assert.equal($('pauseButton').textContent, item.label, `${item.name}: pause/resume label`);
  }
});

test('run-state transitions reuse the original action buttons and their event handlers', () => {
  const { state, $, update } = fixture();
  const buttons = actionIds.map($), handlers = buttons.map((button, index) => button.onclick = () => index);
  state.scenario = {}; state.frames = [{ t:1 }]; state.selected = 1;
  for (const mode of ['idle', 'running', 'paused', 'running', 'done', 'running', 'cancelled']) {
    state.mode = mode; state.busy = mode === 'running'; update();
    for (const [index, id] of actionIds.entries()) {
      assert.equal($(id), buttons[index], `${mode}: preserve ${id}`);
      assert.equal($(id).onclick, handlers[index], `${mode}: preserve ${id} handler`);
    }
    assert.equal(state.frames.length, 1); assert.equal(state.selected, 1);
  }
});

test('focus moves only when its action disappears and never lands on a disabled preparation action', () => {
  const { state, $, document, update } = fixture();
  update(); $('runButton').focus();
  state.mode = 'running'; state.busy = true; update();
  assert.equal(document.activeElement, $('cancelButton'), 'Cancel is the only available action while preparing');
  state.scenario = {}; update();
  assert.equal(document.activeElement, $('cancelButton'), 'Progress updates do not steal focus from a visible action');
  state.mode = 'cancelled'; state.busy = false; update();
  assert.equal(document.activeElement, $('runButton'));
  state.mode = 'running'; state.busy = true; update();
  assert.equal(document.activeElement, $('pauseButton'));
  state.mode = 'done'; state.busy = false; update();
  assert.equal(document.activeElement, $('runButton'));
  const other = { id:'unrelated-control' }; document.activeElement = other;
  state.mode = 'running'; update();
  assert.equal(document.activeElement, other, 'Changing run controls must not move focus from another part of the page');
});
