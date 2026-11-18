import { normalizeInput } from './scenario.mjs?v=20261114-wall-geometry';

import { rightMethods } from './right-methods.mjs?v=20261118-method-order2';

// Keep estimator settings out of the hash, request and cache key of physical measurements.
export function experimentSettings(raw={}) {
  const input=normalizeInput(raw), spacing=Number(raw.echoKnotM??2), support=Number(raw.echoSupportM??8);
  if(![2,4].includes(spacing)||!(support>=1 && support<=12))throw new RangeError('Use 2 or 4 m knots and 1–12 m support reach.');
  const backend=raw.echoBackend??'cpu';
  if(!['cpu','gpu'].includes(backend))throw new RangeError('Unknown EchoSpline computation device');
  if(backend==='gpu')input.echoBackend=backend;
  if(spacing!==2)input.echoKnotM=spacing;
  if(support!==8)input.echoSupportM=support;
  const method=raw.rightMethod==='wmf'?'wmp':raw.rightMethod??'wmp';
  if(!Object.hasOwn(rightMethods,method))throw new RangeError('Unknown right-hand comparison method');
  if(method!=='wmp')input.rightMethod=method;
  return input;
}
