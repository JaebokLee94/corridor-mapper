/** Lossless browser/Node transport. The JSON header precedes binary typed arrays.
 * Current-frame candidates are stored once; cumulative diagnostic samples travel
 * as append-only deltas. Historical arrays are read-only prefix views, so keeping
 * T frames does not duplicate all earlier diagnostic samples T times.
 */
const constructors = { Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array };
const sampleKeys = ['ratios', 'diffuseCounts', 'predictedCounts'];
const encoder = new TextEncoder(), decoder = new TextDecoder();

export function encodePacket(value) {
  const chunks = []; let offset = 0;
  const json = encoder.encode(JSON.stringify(value, (_, item) => {
    if (ArrayBuffer.isView(item) && constructors[item.constructor.name]) {
      const bytes = new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
      const reference = { $typed: item.constructor.name, offset, length: item.length };
      chunks.push(bytes); offset += bytes.byteLength; return reference;
    }
    if (typeof item === 'number' && !Number.isFinite(item)) return { $number: String(item) };
    return item;
  }));
  const output = new Uint8Array(4 + json.length + offset);
  new DataView(output.buffer).setUint32(0, json.length, true); output.set(json, 4);
  let at = 4 + json.length;
  for (const bytes of chunks) { output.set(bytes, at); at += bytes.length; }
  return output;
}

export function decodePacket(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < 4) throw new Error('Truncated simulation packet');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true), start = 4 + length;
  if (start > bytes.length) throw new Error('Truncated simulation header');
  return JSON.parse(decoder.decode(bytes.subarray(4, start)), (_, item) => {
    if (item && item.$typed) {
      const Type = constructors[item.$typed], count = item.length, offset = item.offset;
      if (!Type || !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(offset) || offset < 0
        || start + offset + count * Type.BYTES_PER_ELEMENT > bytes.length) throw new Error('Invalid typed-array packet');
      return new Type(bytes.slice(start + offset, start + offset + count * Type.BYTES_PER_ELEMENT).buffer);
    }
    if (item && item.$number) {
      if (!['NaN', 'Infinity', '-Infinity'].includes(item.$number)) throw new Error('Invalid nonfinite value');
      return Number(item.$number);
    }
    return item;
  });
}

function prefixView(values, end) {
  return new Proxy([], {
    get(target, key, receiver) {
      if (key === 'length') return end;
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return Number(key) < end ? values[Number(key)] : undefined;
      return Reflect.get(target, key, receiver);
    },
    has(target, key) { return typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) ? Number(key) < end : Reflect.has(target, key); },
    ownKeys() { return Array.from({ length: end }, (_, i) => String(i)).concat('length'); },
    getOwnPropertyDescriptor(target, key) {
      if (key === 'length') return { ...Reflect.getOwnPropertyDescriptor(target, key), value: end };
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < end)
        return { value: values[Number(key)], writable: false, enumerable: true, configurable: true };
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    set() { throw new Error('Diagnostic history is read-only'); },
    deleteProperty() { throw new Error('Diagnostic history is read-only'); },
  });
}

export function createMessageEncoder() {
  const lengths = Object.fromEntries(sampleKeys.map(key => [key, 0]));
  return { encode(message) {
    if (message.type !== 'frame') return encodePacket(message);
    const { candidates, ...frame } = message.frame;
    const { diagnostics, methods } = message.evaluation;
    const samples = {}, compactDiagnostics = { ...diagnostics };
    for (const key of sampleKeys) {
      const values = diagnostics[key];
      if (!Array.isArray(values) || values.length < lengths[key]) throw new Error('Diagnostic history must be append-only');
      samples[key] = { base: lengths[key], values: new Float64Array(values.slice(lengths[key])) };
      lengths[key] = values.length; delete compactDiagnostics[key];
    }
    const compactMethods = Object.fromEntries(Object.entries(methods).map(([key, value]) => {
      const { diagnostics: ignored, ...rest } = value; return [key, rest];
    }));
    return encodePacket({ ...message, frame, evaluation: undefined,
      $evaluation: { methods: compactMethods, diagnostics: compactDiagnostics, samples } });
  } };
}

export function createMessageDecoder() {
  const history = Object.fromEntries(sampleKeys.map(key => [key, []]));
  return { decode(raw) {
    const message = decodePacket(raw);
    if (!message.$evaluation) return message;
    const { methods, diagnostics, samples } = message.$evaluation;
    for (const key of sampleKeys) {
      if (samples[key].base !== history[key].length) throw new Error('Missing or out-of-order diagnostic delta');
      for (const value of samples[key].values) history[key].push(value);
      diagnostics[key] = prefixView(history[key], history[key].length);
    }
    for (const method of Object.values(methods)) method.diagnostics = diagnostics;
    message.evaluation = { ...methods.guarded, methods };
    message.frame.candidates = message.frame.methods.guarded.candidates;
    delete message.$evaluation; return message;
  } };
}
