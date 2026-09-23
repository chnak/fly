import { describe, expect, it } from 'vitest';
import { FlyEncoder } from '../src/encoder.js';

describe('FlyEncoder', () => {
  it('encodes below-gap and falling state', () => {
    const s = FlyEncoder.encode({
      birdY: 400, birdVelocityY: 200, pipeX: 220, pipeWidth: 72,
      gapTop: 180, gapBottom: 360, gapCenterY: 270, distanceToPipe: 108
    });
    expect(s.lc4).toBeCloseTo(0.64);
    expect(s.lc10Left).toBeGreaterThan(0);
    expect(s.lc10Right).toBe(0);
    expect(s.downward).toBeGreaterThan(0);
  });

  it('clamps distant pipes to zero', () => {
    const s = FlyEncoder.encode({
      birdY: 1, birdVelocityY: 0, pipeX: 999, pipeWidth: 72,
      gapTop: 0, gapBottom: 10, gapCenterY: 5, distanceToPipe: 900
    });
    expect(s.lc4).toBe(0);
  });

  it('encodes above-gap with lc10Right dominating', () => {
    const s = FlyEncoder.encode({
      birdY: 100, birdVelocityY: -100, pipeX: 220, pipeWidth: 72,
      gapTop: 200, gapBottom: 400, gapCenterY: 300, distanceToPipe: 108
    });
    expect(s.lc10Right).toBeGreaterThan(0);
    expect(s.lc10Left).toBe(0);
    expect(s.upward).toBeGreaterThan(0);
  });
});