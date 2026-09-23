import type { ReadoutModel } from './types.js';

/** Default 12-feature readout covering target / loom / escape descending neurons. */
export const DEFAULT_READOUT: ReadoutModel = {
  features: [
    'TARGET_DN L', 'TARGET_DN R',
    'LOOM_DN L', 'LOOM_DN R',
    'ESCAPE_DN L', 'ESCAPE_DN R',
    'DNae002 L', 'DNae002 R',
    'DNg111 L', 'DNg111 R',
    'DNp01 L', 'DNp01 R'
  ],
  weights: Array(12).fill(0),
  bias: -0.35,
  threshold: 0.42
};

export function inferReadout(values: Float32Array | number[], model: ReadoutModel): number {
  let z = model.bias;
  const n = model.weights.length;
  for (let i = 0; i < n; i++) {
    const x = (values[i] ?? 0);
    const mean = model.mean?.[i] ?? 0;
    const scale = model.scale?.[i] ?? 1;
    z += model.weights[i] * ((x - mean) / scale);
  }
  return 1 / (1 + Math.exp(-z));
}