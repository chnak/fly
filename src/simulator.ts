import type { BrainManifest, NeuralStimulus } from './types.js';
import { FlyEncoder } from './encoder.js';
import type { Connectome } from './connectome.js';

export interface SimulationState {
  v: Float32Array;
  drive: Float32Array;
  current: Float32Array;
  fired: Int32Array;
  firedCount: number;
  activity: Uint8Array;
  totalSpikes: number;
  rng: number;
  traces: Float32Array;
  /** EMA traces per readout feature. */
  trainingSamples: number;
  trainingLoss: number;
}

export interface StepResult {
  activity: Uint8Array;
  dnp01: number;
  features: Float32Array;
  rawFeatures: Float32Array;
  totalSpikes: number;
  stimulus: NeuralStimulus;
}

/** Stateless rate sampler. Pulses any neuron whose activity is 255 (spike). */
export function rate(ids: Int32Array, activity: Uint8Array): number {
  if (ids.length === 0) return 0;
  let hits = 0;
  for (let k = 0; k < ids.length; k++) if (activity[ids[k]] === 255) hits++;
  return Math.min(1, hits / Math.max(1, ids.length * 0.3));
}

function random(rngIn: number): [number, number] {
  const rng = (Math.imul(rngIn, 1664525) + 1013904223) >>> 0;
  return [rng / 4294967296, rng];
}

export class Simulator {
  private s!: SimulationState;
  /** feature name -> neuron ids */
  private groups = new Map<string, Int32Array>();

  constructor(private brain: Connectome, private features: string[]) {}

  init(seed = 1): SimulationState {
    const n = this.brain.meta.n;
    const featureCells = this.brain.featureCells.bind(this.brain);
    this.groups.clear();
    for (const side of ['L', 'R'] as const) {
      this.groups.set(`LC4_${side}`, this.brain.cells('LC4', side));
      this.groups.set(`LPLC2_${side}`, this.brain.cells('LPLC2', side));
      this.groups.set(`LC10a_${side}`, this.brain.cells('LC10a', side));
    }
    for (const f of this.features) this.groups.set(f, featureCells(f));
    this.groups.set('DNp01', this.brain.cells('DNp01'));
    this.s = {
      v: new Float32Array(n),
      drive: new Float32Array(n),
      current: new Float32Array(n),
      fired: new Int32Array(n),
      firedCount: 0,
      activity: new Uint8Array(n),
      totalSpikes: 0,
      rng: seed >>> 0,
      traces: new Float32Array(this.features.length),
      trainingSamples: 0,
      trainingLoss: 0.693
    };
    return this.s;
  }

  state(): SimulationState {
    return this.s;
  }

  reset(seed: number): void {
    if (!this.s) this.init(seed);
    this.s.v.fill(0);
    this.s.drive.fill(0);
    this.s.current.fill(0);
    this.s.activity.fill(0);
    this.s.traces.fill(0);
    this.s.firedCount = 0;
    this.s.totalSpikes = 0;
    this.s.rng = seed >>> 0;
  }

  /** Drive neurons by name. Pass a record like { LC4_L: 0.6, LC10a_L: 0.3, ... }. */
  stimulate(drive: Partial<Record<string, number>>): void {
    for (const [name, amount] of Object.entries(drive)) {
      const ids = this.groups.get(name);
      if (!ids) continue;
      for (let k = 0; k < ids.length; k++) this.s.drive[ids[k]] += amount ?? 0;
    }
  }

  /** Apply stimulus in the standard Flappy encoding. */
  stimulateFromState(state: { birdY: number; birdVelocityY: number; gapCenterY: number; distanceToPipe: number }): NeuralStimulus {
    const s = FlyEncoder.encode({
      birdY: state.birdY,
      birdVelocityY: state.birdVelocityY,
      pipeX: 0, pipeWidth: 72, gapTop: 0, gapBottom: 0,
      gapCenterY: state.gapCenterY,
      distanceToPipe: state.distanceToPipe
    });
    this.stimulate({
      LC4_L: s.lc4, LC4_R: s.lc4,
      LPLC2_L: s.lplc2, LPLC2_R: s.lplc2,
      LC10a_L: s.lc10Left + s.upward * 0.35,
      LC10a_R: s.lc10Right + s.downward * 0.35
    });
    return s;
  }

  /** One LIF integration step. */
  step(): void {
    const { v, drive, current, fired, activity } = this.s;
    const { colPtr, rowIdx, code, lut } = this.brain.weights;
    current.fill(0);
    for (let k = 0; k < this.s.firedCount; k++) {
      const j = fired[k];
      for (let e = colPtr[j]; e < colPtr[j + 1]; e++) current[rowIdx[e]] += lut[code[e]];
    }
    const p = this.brain.meta.params;
    const decay = Math.exp(-p.dt / p.tau);
    const pNoise = p.noise_hz * p.dt;
    let count = 0;
    activity.fill(0);
    for (let i = 0; i < this.brain.meta.n; i++) {
      const [r, rng2] = random(this.s.rng);
      this.s.rng = rng2;
      let x = decay * v[i] + p.gain * current[i] + p.tonic + drive[i];
      if (r < pNoise) x += p.noise_amp;
      if (x >= 1) {
        fired[count++] = i;
        activity[i] = 255;
        x = 0;
      } else {
        activity[i] = Math.min(180, Math.max(0, x * 85));
      }
      v[i] = x;
      drive[i] = 0;
    }
    this.s.firedCount = count;
    this.s.totalSpikes += count;
  }

  /** Sample all readout features as a smoothed trace vector. */
  sampleFeatures(): { raw: Float32Array; smoothed: Float32Array } {
    const raw = new Float32Array(this.features.length);
    for (let i = 0; i < this.features.length; i++) raw[i] = rate(this.groups.get(this.features[i]) ?? new Int32Array(), this.s.activity);
    for (let i = 0; i < this.features.length; i++) this.s.traces[i]! = this.s.traces[i]! * 0.86 + raw[i]! * 0.14;
    return { raw, smoothed: new Float32Array(this.s.traces) };
  }

  dnp01Rate(): number {
    return rate(this.groups.get('DNp01') ?? new Int32Array(), this.s.activity);
  }
}

// Re-export manifest type to keep the public surface tidy.
export type { BrainManifest };