export type {
  FlappyState,
  NeuralStimulus,
  BrainActivity,
  Decision,
  BrainManifest,
  ReadoutModel,
  ProgressEvent,
  ProgressReporter
} from './types.js';

export { FlyEncoder } from './encoder.js';
export { FlyDecoder } from './decoder.js';
export { DEFAULT_READOUT, inferReadout } from './readout.js';
export { trainedFlapRequest, onlineLearningThreshold } from './policy.js';
export { defaultTeacher, type TeacherFn, type Label } from './teacher.js';

export {
  loadConnectome,
  parseMeta,
  parseWeights,
  type Connectome,
  type ConnectomeLoadOptions,
  type Meta,
  type ConnectomeWeights
} from './connectome.js';

export { Simulator, rate, type SimulationState, type StepResult } from './simulator.js';

export { fastTrain, onlineTrain, applyModel, type FastTrainOptions, type FastTrainResult } from './training.js';

export {
  validateModel,
  cloneModel,
  freshModel,
  modelToJson,
  modelFromJson
} from './persist.js';

export { default as createTrainer } from './createTrainer.js';