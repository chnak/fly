import { loadConnectome, type Connectome } from './connectome.js';
import { Simulator } from './simulator.js';
import { fastTrain, type FastTrainOptions, type FastTrainResult } from './training.js';
import { freshModel } from './persist.js';
import type { BrainManifest, ProgressReporter, ReadoutModel } from './types.js';
import { DEFAULT_READOUT } from './readout.js';

export interface CreateTrainerOptions {
  metaPath: string;
  weightsPaths: string[];
  manifest: BrainManifest;
  seed?: number;
  features?: ReadoutModel['features'];
  initialModel?: ReadoutModel;
}

export interface Trainer {
  brain: Connectome;
  simulator: Simulator;
  features: ReadoutModel['features'];
  fastTrain(options?: FastTrainOptions): Promise<FastTrainResult>;
  dispose(): void;
}

export default async function createTrainer(opts: CreateTrainerOptions): Promise<Trainer> {
  const brain = await loadConnectome({
    metaPath: opts.metaPath,
    weightsPaths: opts.weightsPaths,
    manifest: opts.manifest,
    onProgress: (frac) => console.log(`  connectome ${(frac * 100).toFixed(1)}%`)
  });
  const features = opts.features ?? DEFAULT_READOUT.features;
  const simulator = new Simulator(brain, features);
  simulator.init(opts.seed ?? 1);

  // Seed the working model with whatever the caller provided.
  const initial = opts.initialModel ?? freshModel(features);
  simulator.state().trainingSamples = initial.trainingSamples ?? 0;
  simulator.state().trainingLoss = initial.trainingLoss ?? 0.693;

  return {
    brain,
    simulator,
    features,
    async fastTrain(options: FastTrainOptions = {}): Promise<FastTrainResult> {
      const baseline = opts.initialModel ?? initial;
      return await fastTrain(simulator, baseline, options);
    },
    dispose() {
      brain.dispose();
    }
  };
}

export type { ProgressReporter };