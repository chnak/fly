// Example 2 — FlyDecoder (DNp01 spike train) + trainedFlapRequest (policy).
//
// Simulates a fabricated spike train to show how the decoder produces
// WAIT/FLAP decisions, then demonstrates the policy safety rails using
// hand-crafted feature values.

import { FlyDecoder, inferReadout, trainedFlapRequest, onlineLearningThreshold } from '../dist/index.js';
import type { FlappyState } from '../dist/index.js';

console.log('=== 02-decoder-policy.ts ===\n');

// --- 2a. FlyDecoder rolling-window demonstration --------------------------
console.log('[2a] FlyDecoder rolling 100 ms window, cooldown 120 ms');
const decoder = new FlyDecoder(/*threshold=*/2, /*cooldown=*/120);

// Fake spike train: bursts at t=10, 30, 50 (within 100 ms window).
const spikeTrain: Array<[number, boolean]> = [
  [0, false], [10, true], [20, false], [30, true], [40, false],
  [50, true], [60, false], [80, false], [180, true], [200, true],
  [220, true], [350, false]
];

for (const [t, spike] of spikeTrain) {
  const decision = decoder.decide(t, spike);
  console.log(`  t=${String(t).padStart(3)}ms  spike=${spike ? '·' : ' '}  →  ${decision}`);
}

// --- 2b. trainedFlapRequest safety rails ----------------------------------
console.log('\n[2b] trainedFlapRequest safety rails');

const policyScenarios: Array<{ name: string; state: FlappyState; learned: number; threshold: number }> = [
  {
    name: 'below target + falling + learned confident',
    state: { birdY: 460, birdVelocityY: 200, pipeX: 200, pipeWidth: 72,
             gapTop: 320, gapBottom: 440, gapCenterY: 380, distanceToPipe: 88 },
    learned: 0.85, threshold: 0.42
  },
  {
    name: 'above target + fast climb (learned says yes, but rail blocks)',
    state: { birdY: 120, birdVelocityY: -350, pipeX: 200, pipeWidth: 72,
             gapTop: 320, gapBottom: 440, gapCenterY: 380, distanceToPipe: 88 },
    learned: 0.92, threshold: 0.42
  },
  {
    name: 'below target + low learned confidence',
    state: { birdY: 460, birdVelocityY: 200, pipeX: 200, pipeWidth: 72,
             gapTop: 320, gapBottom: 440, gapCenterY: 380, distanceToPipe: 88 },
    learned: 0.30, threshold: 0.42
  }
];

for (const s of policyScenarios) {
  const allow = trainedFlapRequest(s.state, s.learned, s.threshold);
  console.log(`  ${s.name.padEnd(56)} → ${allow ? 'FLAP' : 'WAIT'}`);
}

// --- 2c. online-learning threshold warm-up curve ---------------------------
console.log('\n[2c] onlineLearningThreshold(samples, 0.42)');
const trainedT = 0.42;
for (const n of [0, 50, 200, 500, 800, 1000, 2000]) {
  console.log(`  samples=${String(n).padStart(4)} → threshold=${onlineLearningThreshold(n, trainedT).toFixed(3)}`);
}

// --- 2d. inferReadout on hand-crafted features ----------------------------
console.log('\n[2d] inferReadout with hand-crafted 12-feature vector');
const model = {
  features: [
    'TARGET_DN L', 'TARGET_DN R',
    'LOOM_DN L', 'LOOM_DN R',
    'ESCAPE_DN L', 'ESCAPE_DN R',
    'DNae002 L', 'DNae002 R',
    'DNg111 L', 'DNg111 R',
    'DNp01 L', 'DNp01 R'
  ],
  weights: [1.6, -1.6, 0.9, 0.9, 0.8, 0.8, 0.4, -0.4, 0.4, -0.4, 0.6, -0.6],
  bias: -0.35,
  threshold: 0.42
};

const features = new Float32Array([0.8, 0.2, 0.6, 0.1, 0.7, 0.2, 0.5, 0.1, 0.5, 0.1, 0.9, 0.1]);
const p = inferReadout(features, model);
console.log(`  features=[${Array.from(features).map((v) => v.toFixed(2)).join(', ')}]`);
console.log(`  sigmoid → ${p.toFixed(4)} (threshold ${model.threshold})`);