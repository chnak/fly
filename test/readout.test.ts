import { describe, expect, it } from 'vitest';
import { DEFAULT_READOUT, inferReadout } from '../src/readout.js';

describe('inferReadout', () => {
  it('matches a hand-computed sigmoid for the default bias-only model', () => {
    const model = { ...DEFAULT_READOUT, weights: [...DEFAULT_READOUT.weights] };
    const x = new Float32Array(model.weights.length);
    const p = inferReadout(x, model);
    const expected = 1 / (1 + Math.exp(0.35));
    expect(p).toBeCloseTo(expected, 6);
  });

  it('uses mean/scale normalization when supplied', () => {
    const model = {
      ...DEFAULT_READOUT,
      weights: [1, ...Array(11).fill(0)],
      bias: 0,
      mean: [0.5, ...Array(11).fill(0)],
      scale: [2, ...Array(11).fill(1)]
    };
    const x = new Float32Array(12);
    x[0] = 1.5; // normalized -> 0.5
    const p = inferReadout(x, model);
    expect(p).toBeCloseTo(1 / (1 + Math.exp(-0.5)), 6);
  });
});