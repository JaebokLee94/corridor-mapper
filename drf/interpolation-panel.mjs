// Read only the post-hoc evaluation for one method at the selected snapshot.
export function interpolationResult(e, kind) {
  return kind === 'linear' ? e?.interpolation : e?.interpolation?.[kind];
}

export function interpolationPair(frame, method, kind) {
  const e = frame?.methods?.[method] ?? (method === 'guarded' ? frame : null);
  if (!e) return [null, null];
  const raw = {recall:e.recall, missing:e.missing, count:0, lengthM:0, offWallM:0, falseBridges:0};
  return [raw, interpolationResult(e, kind) ?? null];
}

export function renderInterpolationPanel(get, mode, kind, frame, format) {
  const single = mode !== 'compare', name = mode === 'baseline' ? 'WM-F' : 'WM-P';
  get('methodMetrics').hidden = single;
  get('interpolationMetrics').hidden = !single;
  get('methodThresholdNote').hidden = single;
  get('bridgeTableNote').hidden = !single;
  get('historyMetric').hidden = single;
  get('interpolationChartMetric').hidden = !single;
  const interpolation = kind === 'extended' ? 'Extended linear' : kind === 'hermite' ? 'Cubic Hermite' : 'Linear';
  get('resultsTitle').textContent = single ? name + ' interpolation' : 'Method comparison';
  get('evaluationNote').textContent = single
    ? interpolation + ' · 0.4 m tolerance'
    : '0.4 m tolerance · same measured prefix';
  if (kind === 'extended' && (single || get('showInterpolation').checked))
    get('evaluationNote').textContent = 'Extended linear · may cross openings';
  const completedLabel = interpolation + ' interpolation';
  get('interpolatedMapHeading').textContent = completedLabel;
  get('historyFirst').textContent = single ? get('rawMapHeading').textContent : 'WM-P';
  get('historySecond').textContent = single ? completedLabel : 'WM-F';
  const selector = get(single ? 'interpolationChartMetric' : 'historyMetric');
  const metric = selector.selectedOptions[0].textContent;
  get('metricChart').setAttribute('aria-label', single
    ? name + ' ' + metric + ' before and after ' + interpolation.toLowerCase() + ' interpolation over computed snapshots.'
    : metric + ' for WM-P and WM-F over computed snapshots.');
  if (!single) return;
  const pair = interpolationPair(frame, mode, kind);
  for (const row of get('interpolationMetrics').tBodies[0].rows) {
    const {metric, digits} = row.dataset;
    pair.forEach((record, i) => {
      const v = record?.[metric];
      row.cells[i+1].textContent = v == null ? '—' : format(metric === 'recall' ? v*100 : v, Number(digits));
    });
  }
}
