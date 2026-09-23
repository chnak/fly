import { describe, expect, it } from 'vitest';
import { cloneModel, freshModel, modelFromJson, modelToJson, validateModel } from '../src/persist.js';

describe('persist', () => {
  it('round-trips a model through JSON', () => {
    const m = freshModel(['a', 'c']);
    m.weights = [1, 2];
    m.bias = -0.1;
    m.threshold = 0.5;
    const back = modelFromJson(modelToJson(m));
    expect(back.weights).toEqual(m.weights);
    expect(back.bias).toBe(m.bias);
    expect(back.features).toEqual(m.features);
  });

  it('accepts browser-style wrapper { format, model }', () => {
    const m = freshModel(['a']);
    const text = JSON.stringify({ format: 'fly-brain-readout-v3', model: m });
    const back = modelFromJson(text);
    expect(back.features).toEqual(m.features);
  });

  it('rejects malformed input', () => {
    expect(() => modelFromJson('{}')).toThrow();
    expect(() => modelFromJson(JSON.stringify({ features: ['a'], weights: [1, 2], bias: 0, threshold: 0.5 }))).toThrow();
    expect(() => modelFromJson(JSON.stringify({ features: ['a'], weights: [NaN], bias: 0, threshold: 0.5 }))).toThrow();
  });

  it('cloneModel produces a deep copy of weights', () => {
    const m = freshModel(['a', 'b']);
    m.weights = [1, 2];
    const c = cloneModel(m);
    c.weights[0] = 99;
    expect(m.weights[0]).toBe(1);
  });

  it('validateModel accepts a baseline model', () => {
    expect(() => validateModel(freshModel())).not.toThrow();
  });
});