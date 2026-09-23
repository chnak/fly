import type { ReadoutModel } from './types.js';
import { DEFAULT_READOUT } from './readout.js';

/** Validate that a parsed JSON object is a usable readout model. */
export function validateModel(model: unknown): asserts model is ReadoutModel {
  if (!model || typeof model !== 'object') throw new Error('Model is not an object');
  const m = model as Record<string, unknown>;
  if (!Array.isArray(m.features) || !Array.isArray(m.weights)) throw new Error('Model must have features[] and weights[]');
  if (m.features.length !== m.weights.length) throw new Error('features.length must equal weights.length');
  if (!(m.weights as number[]).every(Number.isFinite)) throw new Error('weights contain non-finite values');
  if (!Number.isFinite(m.bias as number)) throw new Error('bias is not finite');
  if (!Number.isFinite(m.threshold as number)) throw new Error('threshold is not finite');
}

/** A frozen baseline clone with weight array copied. */
export function cloneModel(model: ReadoutModel): ReadoutModel {
  return {
    ...model,
    weights: [...model.weights],
    mean: model.mean && [...model.mean],
    scale: model.scale && [...model.scale]
  };
}

/** Build a fresh default model. */
export function freshModel(features: ReadoutModel['features'] = DEFAULT_READOUT.features): ReadoutModel {
  return {
    ...DEFAULT_READOUT,
    features: [...features],
    weights: Array(features.length).fill(0),
    mean: Array(features.length).fill(0),
    scale: Array(features.length).fill(1)
  };
}

/** Serialize a model to JSON. */
export function modelToJson(model: ReadoutModel): string {
  return JSON.stringify(model);
}

/** Parse + validate a model from JSON text. */
export function modelFromJson(text: string): ReadoutModel {
  const parsed = JSON.parse(text);
  // Accept both raw and the browser-style wrapper `{ format, model }`.
  const model = (parsed && typeof parsed === 'object' && 'model' in parsed && (parsed as { format?: string }).format?.startsWith('fly-brain-readout-'))
    ? (parsed as { model: unknown }).model
    : parsed;
  validateModel(model);
  return model;
}