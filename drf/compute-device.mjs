const gpuMethods = new Set(['spline-cnn', 'arc']);
const fleetGpuSplines = new Set(['echoSpline', 'gbdt', 'spline-cnn']);

// Automatic choices are updated only from paired, full-prefix browser measurements.
export function computationDevice(input, method) {
  const requested = input.computeDevice ?? 'auto';
  const spline = input.echoBackend ?? 'auto';
  if (!['auto', 'cpu', 'gpu'].includes(requested) || !['auto', 'cpu', 'gpu'].includes(spline))
    throw new RangeError('Unknown computation device');
  const autoNeural = gpuMethods.has(method) || method === 'gat' && input.vehicles >= 10;
  const automaticSpline = input.vehicles >= 10 && fleetGpuSplines.has(method);
  return { requested, neural: requested === 'gpu' || requested === 'auto' && autoNeural,
    spline: requested !== 'cpu' && (spline === 'gpu' || spline === 'auto' && (requested === 'gpu' || requested === 'auto' && automaticSpline)) };
}
