const inputOrder = ['seed', 'scene', 'wallSide', 'vehicles', 'snapshots', 'sigmaP', 'sigmaD',
  'sigmaM', 'deltaM', 'sigmaDGeometry', 'deltaD', 'roughness', 'lambda0', 'cellStep',
  'resolution', 'specular', 'grid', 'band', 'perimeter'];
const summaryOrder = ['precision', 'surfacePrecision', 'recall', 'holdRate', 'firstSupportPrecision',
  'medianError', 'p95', 'offwall', 'f1', 'observedFraction', 'missing',
  'supportedCount', 'pendingCount', 'rejectedCount', 'Q', 'admitted', 'rejected'];

function orderedKeys(preferred, records) {
  const keys = new Set(records.flatMap(record => Object.keys(record ?? {})));
  return [...preferred, ...[...keys].filter(key => !preferred.includes(key)).sort()];
}
function text(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value, (_key, item) =>
    typeof item === 'number' && !Number.isFinite(item) ? String(item) : item);
  return String(value);
}
function csvCell(value) {
  const valueText = text(value);
  return /[",\r\n]/.test(valueText) ? `"${valueText.replaceAll('"', '""')}"` : valueText;
}

/** Export final per-seed results, not the mean/SD shown by the sweep table.
 * Rates remain fractions and numeric values retain JS full precision. A missing
 * metric is blank; Infinity/-Infinity/NaN remain explicit failure values.
 * Every row uses the protocol saved with that experiment, never current tuning.
 */
export function sweepCsv(runs) {
  const records = runs.flatMap((run, index) => {
    const methods = run.methods ?? (run.summary ? { historical: { summary: run.summary } } : {});
    const names = Object.keys(methods).sort((a, b) => {
      const rank = name => name === 'guarded' ? 0 : name === 'baseline' ? 1 : 2;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    return names.map(method => ({ experiment: index + 1, method, input: run.input ?? {},
      protocol: run.protocol?.[method] ?? {}, summary: methods[method]?.summary ?? {} }));
  });
  const inputKeys = orderedKeys(inputOrder, runs.map(run => run.input));
  const summaryKeys = orderedKeys(summaryOrder, records.map(record => record.summary));
  const header = ['experiment_index', 'method', 'method_name', 'selection_threshold', 'threshold_source', 'implementation_revision',
    ...inputKeys.map(key => `input_${key}`), ...summaryKeys.map(key => `summary_${key}`)];
  const rows = records.map(record => [record.experiment, record.method, record.protocol.name, record.protocol.threshold,
    record.protocol.tuning?.id, record.protocol.revision,
    ...inputKeys.map(key => record.input[key]), ...summaryKeys.map(key => record.summary[key])]);
  return '\ufeff' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
