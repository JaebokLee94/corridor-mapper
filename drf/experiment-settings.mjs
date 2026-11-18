import { normalizeInput } from './scenario.mjs?v=20261114-wall-geometry';

import { rightMethods, canonicalRightMethod } from './right-methods.mjs?v=20261118-cnn-current';
import { computationDevice } from './compute-device.mjs?v=20261118-cnn-current';

// Keep estimator settings out of the hash, request and cache key of physical measurements.
export function experimentSettings(raw={}) {
  const input=normalizeInput(raw), spacing=Number(raw.echoKnotM??2), support=Number(raw.echoSupportM??8);
  if(![2,4].includes(spacing)||!(support>=1 && support<=12))throw new RangeError('Use 2 or 4 m knots and 1–12 m support reach.');
  computationDevice(raw,raw.rightMethod);
  if(raw.echoBackend && raw.echoBackend!=='auto')input.echoBackend=raw.echoBackend;
  if(raw.computeDevice && raw.computeDevice!=='auto')input.computeDevice=raw.computeDevice;
  if(spacing!==2)input.echoKnotM=spacing;
  if(support!==8)input.echoSupportM=support;
  const method=canonicalRightMethod(raw.rightMethod);
  if(!Object.hasOwn(rightMethods,method))throw new RangeError('Unknown right-hand comparison method');
  if(method!=='wmp')input.rightMethod=method;
  return input;
}
