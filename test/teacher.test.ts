import { describe, expect, it } from 'vitest';
import { defaultTeacher } from '../src/teacher.js';

const makeState = (birdY: number, gapCenterY: number, birdVelocityY: number, gapBottom = gapCenterY + 90) => ({
  birdY, birdVelocityY, pipeX: 200, pipeWidth: 72,
  gapTop: gapCenterY - 90, gapBottom, gapCenterY, distanceToPipe: 88
});

describe('defaultTeacher', () => {
  it('flaps when below target and descending', () => {
    expect(defaultTeacher(makeState(400, 320, 100), new Float32Array(12))).toBe(1);
  });

  it('waits when above target', () => {
    expect(defaultTeacher(makeState(200, 320, 0), new Float32Array(12))).toBe(0);
  });

  it('flaps when close to the bottom edge', () => {
    expect(defaultTeacher(makeState(500, 320, -200, 500), new Float32Array(12))).toBe(1);
  });
});