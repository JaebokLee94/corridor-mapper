import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../drf.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../drf/app.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function installSidebarControls()');
const end = source.indexOf('function fillSettings(', start);
assert.ok(start >= 0 && end > start);
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const nodes = new Map(), document = { activeElement: null };
  class Element extends EventTarget {
    constructor(id, tagName = 'BUTTON') {
      super(); this.id = id; this.tagName = tagName; this.attributes = {}; this.type = 'button'; this.children = []; this.observers = [];
      this.dataset = new Proxy({}, { set: (target, key, value) => { target[key] = value; this.mutate('attributes', `data-${key}`); return true; } });
    }
    mutate(type, attributeName) {
      for (const { callback, options } of this.observers) {
        if (options[type] && (type !== 'attributes' || !options.attributeFilter || options.attributeFilter.includes(attributeName))) queueMicrotask(callback);
      }
    }
    setAttribute(name, value) { this.attributes[name] = value; this.mutate('attributes', name); }
    getAttribute(name) { return this.attributes[name]; }
    get textContent() { return this._textContent ?? ''; }
    set textContent(value) { this._textContent = value; this.mutate('childList'); }
    get disabled() { return this._disabled ?? false; }
    set disabled(value) { this._disabled = value; this.mutate('attributes', 'disabled'); }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
    focus() { document.activeElement = this; }
    get firstElementChild() { return this.children[0] ?? null; }
    move(node, toStart) {
      if (node.parentElement) {
        node.parentElement.children = node.parentElement.children.filter(child => child !== node);
        // Moving the focused subtree can drop native focus; the app must restore it.
        if (node.contains(document.activeElement)) document.activeElement = null;
      }
      node.parentElement = this; this.children[toStart ? 'unshift' : 'push'](node);
    }
    prepend(node) { this.move(node, true); }
    append(node) { this.move(node, false); }
    contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
    closest(tag) { for (let node = this; node; node = node.parentElement) if (node.tagName === tag.toUpperCase()) return node; }
  }
  document.body = new Element('body', 'BODY'); document.body.dataset.state = 'idle';
  const $ = id => { if (!nodes.has(id)) nodes.set(id, new Element(id)); return nodes.get(id); };
  for (const id of ['workspace', 'experimentSidebar', 'sidebarControls', 'experimentTitle', 'workbenchTitle', 'sidebarToggle', 'sidebarRunButton', 'sidebarRunLabel', 'sidebarRunIcon', 'runButton', 'pauseButton', 'runSection', 'runProgressTrack', 'generationProgress', 'runProgress', 'settings', 'settingsDetails']) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${id} has one actual DOM binding`);
  }
  const sidebar = $('experimentSidebar'), form = $('settings'), details = $('settingsDetails');
  $('workspace').prepend($('workbenchTitle')); $('workspace').prepend(sidebar);
  sidebar.prepend($('runSection')); $('runSection').prepend($('experimentTitle'));
  $('experimentTitle').prepend(new Element('experimentHeading', 'H2'));
  $('workbenchTitle').prepend(new Element('workbenchHeading', 'H1'));
  $('sidebarControls').prepend($('sidebarRunButton')); $('sidebarControls').prepend($('sidebarToggle'));
  $('sidebarRunButton').append($('sidebarRunIcon')); $('sidebarRunButton').append($('sidebarRunLabel'));
  $('experimentTitle').prepend($('sidebarControls'));
  $('runProgressTrack').append($('generationProgress')); $('runProgressTrack').append($('runProgress'));
  $('runSection').append($('runProgressTrack'));
  $('generationProgress').max = $('runProgress').max = 120;
  $('generationProgress').value = 120; $('runProgress').value = 35;
  sidebar.hidden = false; form.parentElement = sidebar; details.tagName = 'DETAILS'; details.parentElement = form;
  const group = new Element('measurement', 'DETAILS'); group.parentElement = details;
  const seed = new Element('seed', 'INPUT'), sigmaM = new Element('sigmaM', 'INPUT');
  seed.parentElement = form; sigmaM.parentElement = group; sigmaM.value = '6'; sigmaM.validity = {};
  form.elements = { namedItem: name => name === 'seed' ? seed : sigmaM };
  form.checkValidity = () => {
    sigmaM.validity.valueMissing = sigmaM.value === '';
    if (sigmaM.validity.valueMissing) {
      const event = new Event('invalid'); Object.defineProperty(event, 'target', { value: sigmaM }); form.dispatchEvent(event);
    }
    return !sigmaM.validity.valueMissing;
  };
  form.reportValidity = () => form.checkValidity();
  $('sidebarToggle').setAttribute('aria-controls', 'experimentSidebar');
  $('runButton').disabled = true; $('pauseButton').disabled = true; $('pauseButton').textContent = 'Pause';
  const window = new EventTarget(); window.location = { hash: '#v1=preserved' };
  vm.runInNewContext(`${source.slice(start, end)}\ninstallSidebarControls();`, { $, form, document, window, Event,
    MutationObserver: class { constructor(callback) { this.callback = callback; } observe(node, options) { node.observers.push({ callback: this.callback, options }); } } });
  return { window, document, $ };
}

test('moving controls between the two headings preserves focus and the active experiment', t => {
  const { window, document, $ } = fixture(t);
  const form = $('settings'), seed = form.elements.namedItem('seed');
  seed.value = '42'; document.body.dataset.state = 'running';
  let changes = 0, runs = 0, resizes = 0;
  form.addEventListener('change', () => changes++);
  $('runButton').addEventListener('click', () => runs++);
  window.addEventListener('resize', () => resizes++);
  const controls = $('sidebarControls'), track = $('runProgressTrack'), generated = $('generationProgress'), computed = $('runProgress');
  assert.equal($('experimentTitle').firstElementChild, controls);
  seed.focus(); $('sidebarToggle').click();
  assert.equal($('experimentSidebar').hidden, true);
  assert.equal($('workspace').dataset.sidebar, 'collapsed');
  assert.equal($('sidebarToggle').getAttribute('aria-expanded'), 'false');
  assert.equal($('sidebarToggle').getAttribute('aria-controls'), 'experimentSidebar');
  assert.equal($('sidebarToggle').getAttribute('aria-label'), 'Show experiment controls');
  assert.equal($('experimentSidebar').contains($('sidebarToggle')), false);
  assert.equal(controls.parentElement, $('workbenchTitle'));
  assert.equal($('workbenchTitle').firstElementChild, controls);
  assert.equal($('experimentTitle').children.includes(controls), false);
  assert.equal(track.parentElement, controls);
  assert.deepEqual(track.children, [generated, computed], 'Move the live progress elements without cloning them');
  assert.deepEqual([generated.max, generated.value, computed.max, computed.value], [120, 120, 120, 35]);
  computed.value = 36;
  assert.equal(document.activeElement, $('sidebarToggle'));
  assert.equal($('sidebarToggle').type, 'button');
  assert.equal($('sidebarRunButton').hidden, false);
  assert.equal($('sidebarRunButton').disabled, true, 'An active run remains disabled in the collapsed controls');
  $('sidebarToggle').click();
  assert.equal($('experimentSidebar').hidden, false);
  assert.equal($('workspace').dataset.sidebar, 'expanded');
  assert.equal($('sidebarToggle').getAttribute('aria-expanded'), 'true');
  assert.equal($('sidebarRunButton').hidden, true);
  assert.equal(controls.parentElement, $('experimentTitle'));
  assert.equal($('experimentTitle').firstElementChild, controls);
  assert.equal($('workbenchTitle').children.includes(controls), false);
  assert.equal(track.parentElement, $('runSection'));
  assert.equal(controls.children.includes(track), false);
  assert.deepEqual(track.children, [generated, computed]);
  assert.deepEqual([generated.max, generated.value, computed.max, computed.value], [120, 120, 120, 36]);
  assert.equal(document.activeElement, $('sidebarToggle'), 'Moving the focused controls back restores keyboard focus');
  assert.equal(seed.value, '42'); assert.equal(document.body.dataset.state, 'running');
  assert.equal(window.location.hash, '#v1=preserved');
  assert.deepEqual([changes, runs, resizes], [0, 0, 2]);
});

test('the collapsed Run action delegates once to the existing control and mirrors its disabled state', async t => {
  const { $ } = fixture(t);
  let runs = 0;
  $('runButton').disabled = false; await tick();
  $('sidebarToggle').click();
  assert.equal($('sidebarRunButton').disabled, false);
  assert.equal($('sidebarRunLabel').textContent, 'Run');
  assert.equal($('sidebarRunButton').getAttribute('aria-label'), 'Run comparison');
  $('runButton').addEventListener('click', () => { runs++; $('runButton').disabled = true; });
  $('sidebarRunButton').click(); await tick();
  assert.equal(runs, 1); assert.equal($('sidebarRunButton').disabled, true);
  $('sidebarRunButton').click(); assert.equal(runs, 1);
  $('runButton').disabled = false; await tick();
  assert.equal($('sidebarRunButton').disabled, false);
});

test('compact action follows preparation, Pause, Resume, pending commands and terminal states', async () => {
  const { document, $ } = fixture();
  const compact = $('sidebarRunButton'), pause = $('pauseButton'), run = $('runButton');
  const actions = [];
  pause.addEventListener('click', () => { actions.push(pause.textContent); pause.disabled = true; });
  run.addEventListener('click', () => actions.push('Run'));
  $('sidebarToggle').click();
  document.body.dataset.state = 'running'; await tick();
  assert.equal($('sidebarRunLabel').textContent, 'Pause');
  assert.equal(compact.disabled, true, 'The preparation stage cannot pause before the original control permits it');
  compact.click(); assert.deepEqual(actions, []);
  const checkValidity = $('settings').checkValidity;
  $('settings').checkValidity = () => assert.fail('Pause and Resume do not validate experiment inputs');
  pause.disabled = false; await tick();
  assert.equal(compact.getAttribute('aria-label'), 'Pause comparison');
  assert.equal(compact.title, 'Pause comparison');
  assert.match($('sidebarRunIcon').getAttribute('d'), /M6/);
  compact.click(); compact.click();
  assert.deepEqual(actions, ['Pause']); assert.equal(compact.disabled, true, 'A pending command cannot be sent twice');
  document.body.dataset.state = 'paused'; pause.textContent = 'Resume'; pause.disabled = false; await tick();
  assert.equal($('sidebarRunLabel').textContent, 'Resume');
  assert.equal(compact.getAttribute('aria-label'), 'Resume comparison');
  assert.equal(compact.title, 'Resume comparison');
  assert.equal($('sidebarRunIcon').getAttribute('d'), 'm8 5 11 7-11 7z');
  compact.click(); compact.click(); assert.deepEqual(actions, ['Pause', 'Resume']);
  assert.equal(compact.disabled, true);
  $('settings').checkValidity = checkValidity;
  for (const state of ['done', 'cancelled']) {
    document.body.dataset.state = state; run.disabled = false; await tick();
    assert.equal($('sidebarRunLabel').textContent, 'Run'); assert.equal(compact.disabled, false);
    assert.equal(compact.getAttribute('aria-label'), 'Run comparison');
    compact.click();
  }
  assert.deepEqual(actions, ['Pause', 'Resume', 'Run', 'Run']);
});

test('invalid hidden settings reopen the controls and their closed details without starting a run', async t => {
  const { $ } = fixture(t);
  const field = $('settings').elements.namedItem('sigmaM'), details = field.closest('details');
  let runs = 0; $('runButton').addEventListener('click', () => runs++);
  $('runButton').disabled = false; await tick(); $('sidebarToggle').click();
  details.open = false; $('settingsDetails').open = false; field.value = '';
  $('sidebarRunButton').click();
  assert.equal(runs, 0);
  assert.equal($('experimentSidebar').hidden, false);
  assert.equal($('sidebarToggle').getAttribute('aria-expanded'), 'true');
  assert.equal($('settingsDetails').open, true); assert.equal(details.open, true);
  assert.equal(field.value, ''); assert.equal(field.validity.valueMissing, true);
});
