import type { FlappyState } from './types.js';

/**
 * Trained-readout policy with hard safety rails.
 * Always blocks "flap above the target" and "double-flap during fast climb".
 */
export function trainedFlapRequest(state: FlappyState, learned: number, threshold: number): boolean {
  const adaptiveMargin = (Math.max(0, Math.min(1, learned)) - 0.5) * 12;
  const belowTarget = state.birdY > state.gapCenterY + 8 - adaptiveMargin;
  const notClimbingFast = state.birdVelocityY > -70;
  return learned >= threshold && belowTarget && notClimbingFast;
}

/** Online-learning threshold starts cautious and converges to the trained model's threshold. */
export function onlineLearningThreshold(samples: number, trainedThreshold: number): number {
  const progress = Math.max(0, Math.min(1, samples / 1000));
  return 0.68 + (trainedThreshold - 0.68) * progress;
}