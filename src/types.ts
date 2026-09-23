// Shared types for the fly-brain-train library.
// State shapes are minimal so callers can map their own task onto FlappyState-like vectors.

export interface FlappyState {
  birdY: number;
  birdVelocityY: number;
  pipeX: number;
  pipeWidth: number;
  gapTop: number;
  gapBottom: number;
  gapCenterY: number;
  distanceToPipe: number;
}

export interface NeuralStimulus {
  lc4: number;
  lplc2: number;
  lc10Left: number;
  lc10Right: number;
  upward: number;
  downward: number;
}

export interface BrainActivity {
  lc4: number;
  lplc2: number;
  lc10Left: number;
  lc10Right: number;
  upward: number;
  downward: number;
  dnp01: number;
}

export type Decision = 'FLAP' | 'WAIT';

export interface BrainManifest {
  neurons: number;
  connections: number;
  ln_min: number;
  weights_mb: number;
  parts: string[];
  meta_mb: number;
  weight_error_mean: number;
  weight_error_max: number;
}

export interface ReadoutModel {
  features: string[];
  weights: number[];
  bias: number;
  threshold: number;
  mean?: number[];
  scale?: number[];
  trainingSamples?: number;
  trainingLoss?: number;
}

/** All progress events emitted during training. */
export type ProgressEvent =
  | { phase: 'init'; stage: string; value: number }
  | { phase: 'fast'; epoch: number; totalEpochs: number; done: number; total: number; loss: number }
  | { phase: 'fast'; stage: 'sample'; done: number; total: number; loss: number }
  | { phase: 'fast'; stage: 'done'; samples: number; loss: number };

export type ProgressReporter = (event: ProgressEvent) => void;