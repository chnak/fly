import type { ReadoutModel, ProgressReporter } from './types.js';
import { inferReadout } from './readout.js';
import { defaultTeacher, type TeacherFn } from './teacher.js';
import { Simulator } from './simulator.js';
import { cloneModel, validateModel } from './persist.js';

export interface FastTrainOptions {
  iterations?: number;
  teacher?: TeacherFn;
  report?: ProgressReporter;
}

export interface FastTrainResult {
  model: ReadoutModel;
  samples: number;
  loss: number;
}

/** Online LIF regression update. Caller drives the simulation one step at a time. */
export function onlineTrain(
  sim: Simulator,
  model: ReadoutModel,
  features: Float32Array,
  label: 0 | 1
): { model: ReadoutModel; loss: number; samples: number } {
  const y = label;
  const p = inferReadout(features, model);
  const weight = y ? 2 : 1;
  const gradient = (p - y) * weight;
  const lr = 0.018;
  const next = cloneModel(model);
  for (let i = 0; i < next.weights.length; i++) {
    const x = (features[i]! - (next.mean?.[i] ?? 0)) / (next.scale?.[i] ?? 1);
    next.weights[i] = Math.max(-6, Math.min(6, next.weights[i]! - lr * (gradient * x + 0.0005 * next.weights[i]!)));
  }
  next.bias = Math.max(-4, Math.min(4, next.bias - lr * gradient));
  const loss = -(y * Math.log(Math.max(1e-6, p)) + (1 - y) * Math.log(Math.max(1e-6, 1 - p)));
  const newSamples = (next.trainingSamples ?? sim.state().trainingSamples) + 1;
  next.trainingSamples = newSamples;
  next.trainingLoss = newSamples > 1 ? (next.trainingLoss ?? 0.693) * 0.98 + loss * 0.02 : loss;
  sim.state().trainingSamples = newSamples;
  sim.state().trainingLoss = next.trainingLoss;
  return { model: next, loss: next.trainingLoss, samples: newSamples };
}

/** Internal simulator-only RNG to keep fast training reproducible. */
function rngOf(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function validationLoss(model: ReadoutModel, idx: number[], xs: Float32Array[], ys: number[]): number {
  let loss = 0;
  for (const i of idx) {
    const p = inferReadout(xs[i], model);
    loss -= Math.log(Math.max(1e-6, ys[i] ? p : 1 - p));
  }
  return loss / Math.max(1, idx.length);
}

/**
 * Offline training: simulate the brain on random Flappy-like states,
 * collect (feature, label) pairs, then fit a Logistic regression with
 * class balancing, validation, and threshold search.
 *
 * This is a faithful port of the browser's "Fast Train" pipeline and is
 * the recommended path for producing a production-grade readout model.
 */
export async function fastTrain(
  sim: Simulator,
  model: ReadoutModel,
  options: FastTrainOptions = {}
): Promise<FastTrainResult> {
  const teacher = options.teacher ?? defaultTeacher;
  const report = options.report;
  const iterations = Math.max(400, Math.min(5000, Math.floor(options.iterations ?? 1200)));

  validateModel(model);
  sim.reset((sim.state().rng || 1) >>> 0);

  // Use a deterministic per-iteration random to avoid drifting with the connectome RNG.
  const rand = rngOf(((model.trainingSamples ?? 0) * 7919 + 1) >>> 0);

  const xs: Float32Array[] = [];
  const ys: number[] = [];
  const labels: number[] = [];

  let birdY = 320;
  let velocity = 0;
  let gapCenter = 320;
  let pipeX = 480;

  for (let i = 0; i < iterations; i++) {
    if (i % 150 === 0) {
      sim.state().v.fill(0);
      sim.state().drive.fill(0);
      sim.state().current.fill(0);
      sim.state().traces.fill(0);
      labels.length = 0;
      sim.state().firedCount = 0;
      gapCenter = 155 + rand() * 310;
      birdY = 120 + rand() * 400;
      velocity = -140 + rand() * 300;
      pipeX = 350 + rand() * 180;
    }
    velocity += 22.4;
    birdY += velocity * 0.02;

    const state = {
      birdY,
      birdVelocityY: velocity,
      pipeX,
      pipeWidth: 72,
      gapTop: gapCenter - 105,
      gapBottom: gapCenter + 105,
      gapCenterY: gapCenter,
      distanceToPipe: pipeX - 112
    };
    const label = teacher(state, sim.state().traces) as 0 | 1;
    labels.push(label);
    if (label) velocity = -355;
    pipeX -= 2.64;

    sim.stimulateFromState({
      birdY: state.birdY,
      birdVelocityY: state.birdVelocityY,
      gapCenterY: state.gapCenterY,
      distanceToPipe: state.distanceToPipe
    });
    sim.step();
    const { smoothed } = sim.sampleFeatures();

    if (labels.length > 5) {
      xs.push(new Float32Array(smoothed));
      ys.push(labels.shift() as 0 | 1);
    }
    if (i % 50 === 0) {
      report?.({ phase: 'fast', stage: 'sample', done: Math.round((i + 1) * 0.7), total: iterations, loss: sim.state().trainingLoss });
      // Yield to the event loop occasionally so callers can abort.
      if ((i & 0xff) === 0) await new Promise<void>((r) => setImmediate(r));
    }
  }

  if (xs.length === 0) throw new Error('fastTrain produced no training samples; check teacher() output');

  // Train / validation split (80/20).
  const totalIdx = xs.map((_, i) => i);
  const trainIdx = totalIdx.filter((i) => i % 5 !== 0);
  const validIdx = totalIdx.filter((i) => i % 5 === 0);

  const d = model.features.length;
  const mean = new Array(d).fill(0);
  const scale = new Array(d).fill(0);
  for (const i of trainIdx) for (let k = 0; k < d; k++) mean[k]! += xs[i]![k]! / trainIdx.length;
  for (const i of trainIdx) for (let k = 0; k < d; k++) scale[k]! += (xs[i]![k]! - mean[k]!) ** 2 / trainIdx.length;
  for (let k = 0; k < d; k++) scale[k]! = Math.max(0.025, Math.sqrt(scale[k]!));

  const positives = trainIdx.reduce((a, i) => a + ys[i], 0);
  const negatives = trainIdx.length - positives;

  let next: ReadoutModel = {
    ...model,
    weights: Array(d).fill(0),
    bias: Math.log((positives + 1) / (negatives + 1)),
    mean,
    scale
  };
  const posWeight = negatives / Math.max(1, positives);

  let bestLoss = Infinity;
  let bestWeights = [...next.weights];
  let bestBias = next.bias;
  const totalEpochs = 120;
  for (let epoch = 0; epoch < totalEpochs; epoch++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (const i of trainIdx) {
      const p = inferReadout(xs[i]!, next);
      const g = (p - ys[i]) * (ys[i] ? posWeight : 1);
      gb += g;
      for (let k = 0; k < d; k++) gw[k]! += g * ((xs[i]![k]! - mean[k]!) / scale[k]!);
    }
    const lr = 0.12;
    for (let k = 0; k < d; k++) next.weights[k]! -= lr * (gw[k]! / trainIdx.length + 0.001 * next.weights[k]!);
    next.bias -= lr * (gb / trainIdx.length);
    const loss = validationLoss(next, validIdx, xs, ys);
    if (loss < bestLoss) {
      bestLoss = loss;
      bestWeights = [...next.weights];
      bestBias = next.bias;
    }
    if (epoch % 12 === 0) {
      report?.({ phase: 'fast', epoch, totalEpochs, done: Math.round(iterations * (0.72 + epoch / 430)), total: iterations, loss });
      if ((epoch & 0x1f) === 0) await new Promise<void>((r) => setImmediate(r));
    }
  }
  next.weights = bestWeights;
  next.bias = bestBias;

  // Hard safety rails: keep weights that reinforce upward/loom escape, and ensure left/right target weights are tuned.
  next.weights[0]! = Math.max(0.8, next.weights[0]!);
  next.weights[1]! = Math.min(-0.8, next.weights[1]!);
  for (const k of [4, 5, 10, 11]) next.weights[k]! = Math.max(0.35, next.weights[k]!);

  // Threshold search on validation set.
  let best = 0.42;
  let bestScore = -1;
  for (let t = 0.2; t <= 0.7; t += 0.01) {
    let tp = 0, tn = 0, p = 0, n = 0;
    for (const i of validIdx) {
      const y = ys[i];
      const hit = inferReadout(xs[i], next) >= t;
      if (y) { p++; if (hit) tp++; }
      else { n++; if (!hit) tn++; }
    }
    const score = tp / Math.max(1, p) + tn / Math.max(1, n);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  next.threshold = Math.min(0.5, best);
  const finalLoss = validationLoss(next, validIdx, xs, ys);
  next.trainingSamples = (next.trainingSamples ?? 0) + xs.length;
  next.trainingLoss = finalLoss;

  report?.({ phase: 'fast', stage: 'sample', done: iterations, total: iterations, loss: finalLoss });
  report?.({ phase: 'fast', stage: 'done', samples: next.trainingSamples, loss: finalLoss });

  return { model: next, samples: xs.length, loss: finalLoss };
}

/** Replace the simulator's working model + reset sample counters. */
export function applyModel(sim: Simulator, model: ReadoutModel): void {
  validateModel(model);
  sim.state().trainingSamples = Math.max(1000, model.trainingSamples ?? 0);
  sim.state().trainingLoss = model.trainingLoss ?? 0.693;
  sim.state().traces.fill(0);
}