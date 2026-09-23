// Example 1 — FlyEncoder: project a Flappy-like state vector onto the
// 6-channel stimulus the MaleCNS connectome expects.
//
// No brain fixture required. This runs purely on the encoder math.

import { FlyEncoder } from '../dist/index.js';
import type { FlappyState } from '../dist/index.js';

console.log('=== 01-encoder.ts ===\n');

const cases: Array<{ label: string; state: FlappyState }> = [
  {
    label: 'A) bird below gap, falling, pipe near',
    state: {
      birdY: 460, birdVelocityY: 180, pipeX: 200, pipeWidth: 72,
      gapTop: 320, gapBottom: 440, gapCenterY: 380, distanceToPipe: 88
    }
  },
  {
    label: 'B) bird above gap, climbing, pipe far',
    state: {
      birdY: 80, birdVelocityY: -260, pipeX: 480, pipeWidth: 72,
      gapTop: 320, gapBottom: 440, gapCenterY: 380, distanceToPipe: 300
    }
  },
  {
    label: 'C) bird dead-center, hovering, pipe mid-range',
    state: {
      birdY: 380, birdVelocityY: -20, pipeX: 320, pipeWidth: 72,
      gapTop: 340, gapBottom: 420, gapCenterY: 380, distanceToPipe: 160
    }
  }
];

for (const { label, state } of cases) {
  const s = FlyEncoder.encode(state);
  console.log(label);
  console.log('  state:', { birdY: state.birdY.toFixed(0), vel: state.birdVelocityY, dist: state.distanceToPipe });
  console.log('  stimulus:', {
    lc4: s.lc4.toFixed(3),
    lplc2: s.lplc2.toFixed(3),
    lc10Left: s.lc10Left.toFixed(3),
    lc10Right: s.lc10Right.toFixed(3),
    upward: s.upward.toFixed(3),
    downward: s.downward.toFixed(3)
  });
  console.log();
}