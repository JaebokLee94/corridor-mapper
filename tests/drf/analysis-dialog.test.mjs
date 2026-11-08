import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

function fixture(t) {
  const html = readFileSync(new URL('../../drf.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html), { document, MouseEvent, Event } = dom.window;
  t.after(() => dom.window.close());
  const $ = id => document.getElementById(id), dialog = $('analysisDialog');
  const source = readFileSync(new URL('../../drf/app.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("$('analysisButton').onclick=");
  const end = source.indexOf('installSidebarControls();', start);
  assert.ok(start >= 0 && end > start);
  // jsdom has no native modal layout/top layer. Chrome verifies those separately.
  dialog.getBoundingClientRect = () => ({ left: 100, right: 900, top: 50, bottom: 650 });
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')); };
  vm.runInNewContext(source.slice(start, end), { $, renderSelected() {}, renderSweep() {} });
  const fire = (type, x, y, target = dialog, button = 0) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button }));
  $('analysisButton').click();
  return { $, dialog, fire };
}

test('Analysis tools closes on each outside edge and can reopen', t => {
  const { $, dialog, fire } = fixture(t);
  for (const [x, y] of [[99, 200], [901, 200], [400, 49], [400, 651]]) {
    fire('pointerdown', x, y); fire('click', x, y);
    assert.equal(dialog.open, false);
    $('analysisButton').click();
    assert.equal(dialog.open, true);
  }
  $('closeAnalysis').click();
  assert.equal(dialog.open, false, 'Existing Close button is preserved');
});

test('inside content, padding and boundary clicks keep Analysis tools open', t => {
  const { $, dialog, fire } = fixture(t);
  for (const target of [dialog, $('analysisTitle'), $('sweepTab')]) {
    fire('pointerdown', 120, 70, target); fire('click', 120, 70, target);
    assert.equal(dialog.open, true);
  }
  for (const [x, y] of [[100, 50], [900, 650]]) {
    fire('pointerdown', x, y); fire('click', x, y);
    assert.equal(dialog.open, true);
  }
});

test('dragging across the edge, cancelled gestures and secondary clicks do not dismiss', t => {
  const { dialog, fire } = fixture(t);
  fire('pointerdown', 120, 70); fire('click', 99, 70);
  assert.equal(dialog.open, true, 'Drag from inside to outside');
  fire('pointerdown', 99, 70); fire('click', 120, 70);
  assert.equal(dialog.open, true, 'Drag from outside to inside');
  fire('pointerdown', 99, 70); fire('pointercancel', 99, 70); fire('click', 99, 70);
  assert.equal(dialog.open, true, 'Cancelled gesture');
  fire('pointerdown', 99, 70, dialog, 2); fire('click', 99, 70, dialog, 2);
  assert.equal(dialog.open, true, 'Secondary button');
});

test('closing and reopening clears the previous backdrop gesture', t => {
  const { $, dialog, fire } = fixture(t);
  fire('pointerdown', 99, 70); $('closeAnalysis').click(); $('analysisButton').click();
  fire('click', 99, 70);
  assert.equal(dialog.open, true, 'A fresh primary press is required');
});
