const number = (value, places = 3) => Number.isFinite(value) ? value.toFixed(places) : '—';
const inputKey = input => JSON.stringify(Object.keys(input ?? {}).sort().map(key => [key, input[key]]));

/** Present post-hoc diagnostics from exactly one experiment at a time.
 * Histogram/count arrays are accumulated across all pairs and snapshots; the
 * spatial profile alone belongs to the selected pair at the final/current t.
 * Only the active source and latest pair profile are cached. Async responses
 * carry a revision token so a slower previous selection cannot overwrite it.
 */
export function createDiagnosticView({ elements, drawHistogram, drawCounts, drawProfile, setMathText,
  loadSweepSource, loadSweepProfile, loadComparisonProfile }) {
  const sourceSelect = elements.diagnosticSourceSelect, pairSelect = elements.configSelect;
  const document = sourceSelect.ownerDocument;
  let latest = { comparison: null, sweepRuns: [], visible: false }, sources = [], active = null;
  let revision = 0, context = null, sourceLoading = false, sourceError = '', profile = null;
  let profileKey = '', profileLoading = false, profileError = '';

  function option(value, label) {
    const node = document.createElement('option'); node.value = value; node.textContent = label; return node;
  }
  function emptyPair(label) {
    pairSelect.replaceChildren(option('', label)); pairSelect.disabled = true;
  }
  function rebuildPairs(keep = pairSelect.value) {
    const configs = context?.configs ?? [];
    if (!configs.length) { emptyPair(sourceError ? 'Vehicle pairs unavailable' : 'No vehicle pairs'); return; }
    pairSelect.replaceChildren(...configs.map((config, index) => option(String(index), `Vehicles ${config.i}–${config.j}`)));
    pairSelect.disabled = false;
    pairSelect.value = configs[Number(keep)] && keep !== '' ? keep : '0';
  }
  function drawState() {
    if (!active) {
      elements.diagnosticSummary.textContent = 'No diagnostics yet. Run comparison or complete a parameter sweep.';
      elements.diagnosticScope.textContent = 'Choose a completed experiment to inspect its scattering diagnostics.';
      elements.diagnosticProfileStatus.textContent = '';
    } else {
      const diag = active.diagnostics, t = context?.t ?? active.t;
      elements.diagnosticScope.textContent = `Histogram and counts: all vehicle pairs through snapshot ${t}. Profile: selected pair at snapshot ${t}.`;
      setMathText(elements.diagnosticSummary, [
        `diffuse / configuration ${number(diag.diffusePerConfig, 1)} · duplicate ranges ${diag.duplicateFraction == null ? '—' : number(100 * diag.duplicateFraction, 1) + '%'} · Theorem 2: mean ${number(diag.theoremMean)}, median ${number(diag.theoremMedian)}, `,
        { tex: 'n' }, ` = ${diag.ratios?.length ?? 0}, negative = ${diag.theoremNegative ?? 0} · fold prediction ${number(diag.foldPrediction)} m`,
        ...(active.input.roughness === 0 ? ['. Zero roughness: the diffuse ratio test is not applicable.']
          : !diag.ratios?.length ? ['. No eligible samples for the ratio test.'] : []),
      ]);
      elements.diagnosticProfileStatus.textContent = sourceError || profileError ||
        (sourceLoading ? 'Loading vehicle pairs…' : profileLoading ? 'Loading selected-pair profile…' : '');
    }
    if (!latest.visible) return;
    drawHistogram(elements.diagnosticChart, active?.diagnostics.ratios ?? []);
    drawCounts(elements.countChart, active?.diagnostics.diffuseCounts ?? [], active?.diagnostics.predictedCounts ?? []);
    drawProfile(elements.profileChart, profile?.cells ?? [], context?.domain ?? active?.domain ?? [0, 80]);
  }
  function requestProfile() {
    if (!latest.visible || !active || !context || pairSelect.disabled) return;
    const configIndex = Number(pairSelect.value), key = `${revision}:${configIndex}`;
    if (profileKey === key) return;
    const token = revision, source = active;
    profileKey = key; profile = null; profileError = ''; profileLoading = true;
    drawState();
    Promise.resolve().then(() => source.kind === 'sweep'
      ? loadSweepProfile(source.run, configIndex)
      : loadComparisonProfile(source.comparison, configIndex)).then(value => {
      if (token !== revision || profileKey !== key) return;
      profile = value; profileLoading = false; drawState();
    }, error => {
      if (token !== revision || profileKey !== key) return;
      profileLoading = false; profileError = `Profile unavailable: ${error.message}`; drawState();
    });
  }
  function ensureContext() {
    if (!active || !latest.visible) return;
    if (context) { requestProfile(); return; }
    if (sourceLoading || sourceError) return;
    const token = revision, source = active;
    sourceLoading = true; emptyPair('Loading vehicle pairs…'); drawState();
    Promise.resolve().then(() => loadSweepSource(source.run)).then(value => {
      if (token !== revision) return;
      context = value; sourceLoading = false; rebuildPairs(); drawState(); requestProfile();
    }, error => {
      if (token !== revision) return;
      sourceLoading = false; sourceError = `Vehicle pairs unavailable: ${error.message}`;
      emptyPair('Vehicle pairs unavailable'); drawState();
    });
  }
  function selectSource(source) {
    const previousPair = active?.key === source?.key ? pairSelect.value : '';
    revision++; active = source; context = null; sourceLoading = false; sourceError = '';
    profile = null; profileKey = ''; profileLoading = false; profileError = '';
    if (source?.kind === 'comparison') {
      context = source.comparison; rebuildPairs(previousPair);
    } else emptyPair(source ? 'Open Diagnostics to load vehicle pairs' : 'Run an experiment first');
    drawState(); ensureContext();
  }
  function render({ comparison = null, sweepRuns = [], visible = false }) {
    latest = { comparison, sweepRuns, visible };
    sources = [];
    if (comparison?.diagnostics) sources.push({ kind: 'comparison', key: `main:${comparison.key ?? 'current'}`,
      version: `${comparison.key ?? 'current'}:${comparison.t}`, label: `Comparison · snapshot ${comparison.t} · seed ${comparison.input.seed}`,
      comparison, input: comparison.input, domain: comparison.domain, t: comparison.t, diagnostics: comparison.diagnostics });
    const runs = sweepRuns.filter(run => run.diagnostics).slice().sort((a, b) =>
      a.input.roughness - b.input.roughness || a.input.sigmaD - b.input.sigmaD || a.input.seed - b.input.seed);
    for (const run of runs) sources.push({ kind: 'sweep', key: `sweep:${inputKey(run.input)}`, version: inputKey(run.input),
      label: `Sweep · range SD ${run.input.sigmaD} m · roughness ${run.input.roughness} deg · seed ${run.input.seed}`,
      run, input: run.input, t: run.input.snapshots, diagnostics: run.diagnostics });
    const chosen = sources.find(source => source.key === active?.key) ?? sources[0] ?? null;
    sourceSelect.replaceChildren(...(sources.length ? sources.map(source => option(source.key, source.label)) : [option('', 'Run comparison or a parameter sweep first')]));
    sourceSelect.disabled = !sources.length; sourceSelect.value = chosen?.key ?? '';
    if (!chosen || chosen.key !== active?.key || chosen.version !== active?.version) selectSource(chosen);
    else { active = chosen; drawState(); ensureContext(); }
  }
  sourceSelect.addEventListener('change', () => selectSource(sources.find(source => source.key === sourceSelect.value) ?? null));
  pairSelect.addEventListener('change', requestProfile);
  return { render, reset() { render({ visible: latest.visible }); } };
}
