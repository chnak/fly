import type { FlappyState, NeuralStimulus } from './types.js';

/**
 * Translate a Flappy-like state vector into the 6-channel neural stimulus
 * that the MaleCNS connectome expects (LC4 / LPLC2 / LC10a-L/R + UPWARD / DOWNWARD).
 *
 * If your task does not map cleanly onto FlappyState, you can either:
 *   1. provide a FlappyState-shaped vector by projecting your observation, or
 *   2. bypass the encoder entirely and write your own `stimulate()` driver using the simulator API.
 */
export class FlyEncoder {
  static encode(state: FlappyState): NeuralStimulus {
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    const approach = clamp(1 - state.distanceToPipe / 300);
    const error = state.gapCenterY - state.birdY;
    const vertical = clamp(Math.abs(error) / 240);
    const velocity = clamp(Math.abs(state.birdVelocityY) / 520);
    return {
      lc4: approach,
      lplc2: clamp(approach * 0.9 + 0.04),
      lc10Left: error < 0 ? vertical : 0,
      lc10Right: error >= 0 ? vertical : 0,
      upward: state.birdVelocityY < 0 ? velocity : 0,
      downward: state.birdVelocityY >= 0 ? velocity : 0
    };
  }
}