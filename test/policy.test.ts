import { describe, expect, it } from 'vitest';
import { onlineLearningThreshold, trainedFlapRequest } from '../src/policy.js';

const state = (birdY: number, birdVelocityY: number) => ({
  birdY, birdVelocityY, pipeX: 250, pipeWidth: 72, gapTop: 200,
  gapBottom: 410, gapCenterY: 305, distanceToPipe: 138
});

describe('trainedFlapRequest', () => {
  it('never flaps above the gap even with a saturated learned output', () => {
    expect(trainedFlapRequest(state(250, 100), 1, 0.42)).toBe(false);
  });

  it('never double-flaps during a fast climb', () => {
    expect(trainedFlapRequest(state(340, -200), 1, 0.42)).toBe(false);
  });

  it('only recovers once the readout has learned enough confidence', () => {
    expect(trainedFlapRequest(state(340, 20), 0.4, 0.42)).toBe(false);
    expect(trainedFlapRequest(state(340, 20), 0.8, 0.42)).toBe(true);
  });

  it('uses mature flight control without a confidence gate after fast training', () => {
    expect(trainedFlapRequest(state(340, 20), 0, 0)).toBe(true);
  });
});

describe('onlineLearningThreshold', () => {
  it('gradually converges from the ordinary-training threshold to the fast-trained threshold', () => {
    expect(onlineLearningThreshold(0, 0.42)).toBe(0.68);
    expect(onlineLearningThreshold(500, 0.42)).toBeCloseTo(0.55);
    expect(onlineLearningThreshold(1000, 0.42)).toBeCloseTo(0.42);
  });
});