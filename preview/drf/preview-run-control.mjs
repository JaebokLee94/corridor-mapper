// Presentation-only proxy: computation and command validation remain in the existing controls.
export function installPreviewRunControl({ body, run, pause, button, Observer = globalThis.MutationObserver }) {
  let dispatching = false;
  function currentAction() {
    const mode = body.dataset.state;
    if (mode === 'running' || mode === 'paused') {
      return { target:pause, action:mode === 'paused' ? 'resume' : 'pause', label:pause.textContent.trim() };
    }
    return { target:run, action:'run', label:run.textContent.trim() };
  }
  function sync() {
    const { target, action, label } = currentAction();
    button.dataset.action = action;
    button.textContent = label;
    button.disabled = dispatching || target.disabled;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-disabled', String(button.disabled));
  }
  button.addEventListener('click', () => {
    // Re-read the canonical state; a mutation callback may not have run yet.
    const { target } = currentAction();
    if (dispatching || target.disabled) { sync(); return; }
    dispatching = true;
    sync();
    try { target.click(); }
    finally {
      queueMicrotask(() => { dispatching = false; sync(); });
    }
  });
  const observer = new Observer(sync);
  observer.observe(body, { attributes:true, attributeFilter:['data-state'] });
  for (const target of [run, pause]) {
    observer.observe(target, { attributes:true, attributeFilter:['disabled'], childList:true, characterData:true, subtree:true });
  }
  sync();
}
