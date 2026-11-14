import { normalizeInput } from './scenario.mjs?v=20261114-wall-geometry';

// Keep estimator settings out of the hash, request and cache key of physical measurements.
export function experimentSettings(raw={}) {
  const input=normalizeInput(raw), spacing=Number(raw.echoKnotM??2), support=Number(raw.echoSupportM??8);
  if(![2,4].includes(spacing)||!(support>=1 && support<=12))throw new RangeError('Use 2 or 4 m knots and 1–12 m support reach.');
  if(spacing!==2)input.echoKnotM=spacing;
  if(support!==8)input.echoSupportM=support;
  return input;
}
