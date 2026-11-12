// Table/selector/axis labels for lengths of the reconstructed map, not added gaps.
export const centreMetricNames = {count:['Centre links','Centre links'], lengthM:['Map length [m]','Map [m]'], offWallM:['Off-wall length [m]','Off-wall [m]'], falseBridges:['Off-wall links','Off-wall links']};
// Read only the post-hoc evaluation for one method at the selected snapshot.
export function interpolationResult(e, kind) {
  return kind === 'linear' ? e?.interpolation : e?.interpolation?.[kind==='off'?'rawMap':kind];
}

export function interpolationPair(frame, method, kind) {
  const e = frame?.methods?.[method] ?? (method === 'guarded' ? frame : null);
  if (!e) return [null, null];
  if(kind==='centre')return [e.interpolation?.centre ?? null,e.interpolation?.rawMap ?? null];
  const raw = {mapF1:e.interpolation?.rawMap?.mapF1, recall:e.recall, missing:e.missing, count:0, lengthM:0, offWallM:0, falseBridges:0};
  return [interpolationResult(e, kind) ?? null, raw];
}

export function renderInterpolationPanel(get, mode, kind, frame, format) {
  const single = mode !== 'compare', name = mode === 'baseline' ? 'WM-F' : 'WM-P';
  get('methodMetrics').hidden = single;
  get('interpolationMetrics').hidden = !single;
  get('methodThresholdNote').hidden = single;
  get('bridgeTableNote').hidden = !single;
  get('historyMetric').hidden = single;
  get('interpolationChartMetric').hidden = !single;
  const centre=kind==='centre';
  const interpolation = centre ? 'Centre spline' : kind === 'extended' ? 'Extended linear' : kind === 'hermite' ? 'Gap Hermite' : 'Linear';
  get('resultsTitle').textContent = single ? name + ' interpolation' : 'Method comparison';
  get('evaluationNote').textContent = single
    ? interpolation + ' · 0.4 m tolerance'
    : '0.4 m tolerance · same measured prefix';
  if (kind === 'extended' && (single || get('showInterpolation').checked))
    get('evaluationNote').textContent = 'Extended linear · may cross openings';
  const completedLabel = interpolation;
  get('interpolatedMapHeading').textContent = completedLabel;
  get('historyFirst').textContent = single ? completedLabel : 'WM-P';
  get('historySecond').textContent = single ? get('rawMapHeading').textContent : 'WM-F';
  const selector = get(single ? 'interpolationChartMetric' : 'historyMetric');
  if(single){
    get('bridgeTableNote').textContent=centre
      ? 'Curves replace the linked halves of fragments. Map lengths include unlinked ends. Aligned openings may be crossed.'
      : 'Interpolation adds inferred connections to the supported wall fragments.';
    for(const row of get('interpolationMetrics').tBodies[0].rows){
      const key=row.dataset.metric;
      if(!centreMetricNames[key])continue;
      const th=row.cells[0], opt=Array.from(selector.options).find(o=>o.value===key);
      th.dataset.original ??= th.firstChild.nodeValue; opt.dataset.original ??= opt.textContent;
      const optText=centre ? centreMetricNames[key][0] : opt.dataset.original;
      if(opt.textContent!==optText)opt.textContent=optText;
      const label=centre ? optText.replace(' [m]',' ') : th.dataset.original;
      if(th.firstChild.nodeValue!==label)th.firstChild.nodeValue=label;
    }
  }
  const metric = selector.selectedOptions[0].textContent;
  get('metricChart').setAttribute('aria-label', single
    ? name + ' ' + metric + ' with ' + completedLabel.toLowerCase() + ' and the raw map without interpolation over computed snapshots.'
    : metric + ' for WM-P and WM-F over computed snapshots.');
  if (!single) return;
  const pair = interpolationPair(frame, mode, kind);
  for (const row of get('interpolationMetrics').tBodies[0].rows) {
    const {metric, digits} = row.dataset;
    pair.forEach((record, i) => {
      const v = record?.[metric];
      row.cells[i+1].textContent = v == null ? '—' : format((metric === 'recall' || metric === 'mapF1') ? v*100 : v, Number(digits));
    });
  }
}
