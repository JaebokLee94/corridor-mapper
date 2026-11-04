// Preview-only presentation controls. Numerical and simulation modules are unchanged.
import { installPreviewRunControl } from './preview-run-control.mjs';
const $ = id => document.getElementById(id);
installPreviewRunControl({ body:document.body, run:$('runButton'), pause:$('pauseButton'), button:$('previewRunButton') });
const dialog = $('settingsDialog');
const form = $('settings');
let opener;

function selectSettings(section) {
  const parameters = section === 'parameters';
  form.hidden = !parameters;
  $('previewDisplayPanel').hidden = parameters;
  for (const [id, active] of [['parametersTab', parameters], ['layersTab', !parameters]]) {
    $(id).setAttribute('aria-selected', String(active));
    $(id).tabIndex = active ? 0 : -1;
  }
}
function openSettings(section, trigger) {
  opener = trigger ?? document.activeElement;
  $('settingsDetails').open = true;
  selectSettings(section);
  if (!dialog.open) dialog.showModal();
}
$('openParameters').addEventListener('click', () => openSettings('parameters', $('openParameters')));
$('openLayers').addEventListener('click', () => openSettings('layers', $('openLayers')));
$('closeSettings').addEventListener('click', () => dialog.close());
$('parametersTab').addEventListener('click', () => selectSettings('parameters'));
$('layersTab').addEventListener('click', () => selectSettings('layers'));
dialog.addEventListener('close', () => opener?.focus());
// Do not let the workbench's Space / arrow shortcuts affect playback in this drawer.
dialog.addEventListener('keydown', event => event.stopPropagation());
// Keep keyboard scrolling of the metrics table separate from replay shortcuts.
document.querySelector('.comparison-scroll').addEventListener('keydown', event => {
  if (['ArrowLeft', 'ArrowRight', ' '].includes(event.key)) event.stopPropagation();
});
for (const id of ['parametersTab', 'layersTab']) $(id).addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === 'Home' ? 'parametersTab' : event.key === 'End' ? 'layersTab'
    : id === 'parametersTab' ? 'layersTab' : 'parametersTab';
  $(target).click(); $(target).focus();
});
// Native validation needs the invalid field visible before the browser focuses it.
form.addEventListener('invalid', () => openSettings('parameters', $('openParameters')), true);

const quickDialog = $('quickParameterDialog');
const quickForm = $('quickParameterForm');
const quickSettings = [
  { name:'wallSide', label:'Wall configuration', format:value => ({both:'Both walls',upper:'Upper wall',lower:'Lower wall'})[value] },
  { name:'vehicles', label:'Vehicles', format:value => `${value} vehicles` },
  { name:'snapshots', label:'Snapshots', format:value => `${value} snapshots` },
  { name:'seed', label:'Random seed', format:value => `Seed ${value}` },
  { name:'sigmaP', label:'Position σ (m)', format:value => `Position σ ${value} m` },
  { name:'sigmaD', label:'Range σ (m)', format:value => `Range σ ${value} m` },
];
let editingParameter, quickOpener;
for (const setting of quickSettings) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.parameter = setting.name;
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => {
    editingParameter = setting;
    quickOpener = button;
    const source = form.elements.namedItem(setting.name);
    // Reuse the real field's type, bounds and options; commit through its existing change path.
    const input = source.cloneNode(true);
    input.removeAttribute('name');
    input.id = 'quickParameterInput';
    input.value = source.value;
    input.setAttribute('aria-labelledby', 'quickParameterTitle');
    $('quickParameterTitle').textContent = setting.label;
    $('quickParameterControl').replaceChildren(input);
    const box = button.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 32);
    quickDialog.style.width = `${width}px`;
    quickDialog.style.left = `${Math.max(16, Math.min(box.left, window.innerWidth - width - 16))}px`;
    quickDialog.style.top = `${Math.max(16, Math.min(box.bottom + 8, window.innerHeight - 245))}px`;
    quickDialog.showModal();
    input.focus();
    if (input.type === 'number') input.select();
  });
  setting.button = button;
  $('experimentSummary').append(button);
}
quickForm.addEventListener('submit', event => {
  event.preventDefault();
  const input = $('quickParameterInput');
  if (!input.reportValidity()) return;
  const source = form.elements.namedItem(editingParameter.name);
  const changed = source.value !== input.value;
  source.value = input.value;
  quickDialog.close();
  if (changed) source.dispatchEvent(new Event('change', { bubbles:true }));
  updateSummary();
});
$('cancelQuickParameter').addEventListener('click', () => quickDialog.close());
quickDialog.addEventListener('close', () => quickOpener?.focus());
quickDialog.addEventListener('keydown', event => event.stopPropagation());

function closeOnBackdropClick(modal) {
  let startedOutside = false;
  const outside = event => {
    const box = modal.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right
      || event.clientY < box.top || event.clientY > box.bottom;
  };
  modal.addEventListener('pointerdown', event => {
    startedOutside = event.button === 0 && event.target === modal && outside(event);
  });
  modal.addEventListener('click', event => {
    // Padding clicks and drags that start inside the editor must keep it open.
    if (startedOutside && event.target === modal && outside(event)) {
      event.preventDefault();
      modal.close();
    }
    startedOutside = false;
  });
  modal.addEventListener('pointercancel', () => { startedOutside = false; });
  modal.addEventListener('close', () => { startedOutside = false; });
}
closeOnBackdropClick(dialog);
closeOnBackdropClick(quickDialog);

function updateSummary() {
  for (const setting of quickSettings) {
    const value = form.elements.namedItem(setting.name).value;
    setting.button.textContent = setting.format(value);
    setting.button.setAttribute('aria-label', `Edit ${setting.label}: ${value}`);
    setting.button.title = `Edit ${setting.label}`;
  }
}
form.addEventListener('input', updateSummary);
form.addEventListener('change', updateSummary);
window.addEventListener('hashchange', updateSummary);
new MutationObserver(updateSummary).observe(document.body, { attributes:true, attributeFilter:['data-state'] });
for (const id of ['resetButton','newSeed']) $(id).addEventListener('click', () => queueMicrotask(updateSummary));
updateSummary();
