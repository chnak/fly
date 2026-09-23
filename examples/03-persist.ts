// Example 3 — persist: JSON round-trip + clone + validate.
//
// Demonstrates that a ReadoutModel can be safely shipped across the
// Node ↔ browser boundary and recovered.

import {
  freshModel,
  cloneModel,
  validateModel,
  modelToJson,
  modelFromJson,
  type ReadoutModel
} from '../dist/index.js';

console.log('=== 03-persist.ts ===\n');

// --- 3a. freshModel --------------------------------------------------------
const base: ReadoutModel = freshModel();
console.log('[3a] freshModel');
console.log('  features.length =', base.features.length);
console.log('  weights.length  =', base.weights.length);
console.log('  bias            =', base.bias);

// --- 3b. mutate + clone ----------------------------------------------------
base.weights[0] = 1.7;
base.weights[1] = -1.4;
base.threshold = 0.41;
base.trainingSamples = 4321;
base.trainingLoss = 0.184;

const copy = cloneModel(base);
console.log('\n[3b] cloneModel — modifying the copy does not touch the original');
console.log('  before: base.weights[0] =', base.weights[0], '  copy.weights[0] =', copy.weights[0]);
copy.weights[0] = 999;
console.log('  after : base.weights[0] =', base.weights[0], '  copy.weights[0] =', copy.weights[0]);

// --- 3c. validate ----------------------------------------------------------
console.log('\n[3c] validateModel');
try {
  validateModel(base);
  console.log('  base  → ok');
  validateModel({ ...base, weights: [] as number[] });
  console.log('  short weights → unexpectedly ok');
} catch (e) {
  console.log('  short weights → rejected:', (e as Error).message);
}

// --- 3d. JSON round-trip ---------------------------------------------------
const wire = modelToJson(base);
console.log('\n[3d] modelToJson');
console.log('  wire length:', wire.length, 'chars');
console.log('  wire head  :', wire.slice(0, 80) + (wire.length > 80 ? '…' : ''));

// modelFromJson already does JSON.parse internally, so hand it the raw string.
const recovered = modelFromJson(wire);
console.log('\n[3e] modelFromJson(wire)');
const fields: Array<keyof ReadoutModel> = ['features', 'weights', 'bias', 'threshold', 'trainingSamples', 'trainingLoss'];
for (const f of fields) {
  const a = JSON.stringify((base as any)[f]);
  const b = JSON.stringify((recovered as any)[f]);
  console.log(`  ${String(f).padEnd(18)} ${a === b ? '✓ matches' : '✗ MISMATCH: ' + a + ' vs ' + b}`);
}