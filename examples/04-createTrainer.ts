// Example 4 — createTrainer + fastTrain (full end-to-end pipeline).
//
// Loads the bundled MaleCNS connectome (166,700 neurons, ~25 M connections)
// from ./fixtures/, runs a 1200-iteration Fast Train, then prints the
// resulting 12-feature readout model.
//
// Run:
//   node --experimental-strip-types --no-warnings examples/04-createTrainer.ts
//   # or, with custom fixtures:
//   FIXTURES_DIR=./my-brain node --experimental-strip-types --no-warnings examples/04-createTrainer.ts

import { createTrainer, modelToJson, modelFromJson, freshModel } from '../dist/index.js';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = process.env.FIXTURES_DIR ?? resolve(here, '..', 'fixtures');
const manifestPath = resolve(fixturesDir, 'brain.json');
const metaPath = resolve(fixturesDir, 'meta.bin');
const weightsPaths = [
  resolve(fixturesDir, 'weights.0.bin'),
  resolve(fixturesDir, 'weights.1.bin')
];

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch {
  console.log('=== 04-createTrainer.ts ===\n');
  console.log(`Skipped: no fixtures at ${fixturesDir}.\n`);
  console.log('Expected files:');
  console.log('  brain.json       (manifest)');
  console.log('  meta.bin         (FLYM neuron metadata)');
  console.log('  weights.0.bin    (FLYW sparse weights, part 1)');
  console.log('  weights.1.bin    (FLYW sparse weights, part 2)');
  console.log('  readout.json     (optional initial model)\n');
  console.log('You can copy them from the sibling fly-flappy repo:');
  console.log('  cp ../fly-flappy/public/brain/* fixtures/');
  process.exit(0);
}

console.log('=== 04-createTrainer.ts ===\n');
console.log(`fixtures: ${fixturesDir}`);
console.log(`manifest: ${manifest.neurons.toLocaleString()} neurons, ${manifest.connections.toLocaleString()} connections, ln_min=${manifest.ln_min.toFixed(3)}`);
console.log(`parts   : ${manifest.parts.join(', ')} (${manifest.weights_mb} MB total)\n`);

// Try to load a pre-existing trained readout as the warm start.
let initialModel;
try {
  const wire = await readFile(resolve(fixturesDir, 'readout.json'), 'utf8');
  initialModel = modelFromJson(wire);
  console.log(`warm start: ${wire.length} bytes from readout.json`);
  console.log(`            weights non-zero: ${initialModel.weights.filter((w) => w !== 0).length}/12`);
} catch {
  initialModel = undefined;
}

const trainer = await createTrainer({
  metaPath,
  weightsPaths,
  manifest,
  seed: 42,
  initialModel
});

console.log('\nfastTrain (1200 iterations, ~10-15 s)...');
const t0 = Date.now();
const { model, samples, loss } = await trainer.fastTrain({
  iterations: 1200,
  report: (e) => {
    if (e.phase === 'fast' && 'epoch' in e && e.epoch % 24 === 0) {
      process.stdout.write(`   epoch ${String(e.epoch).padStart(3)}/${e.totalEpochs}  loss=${e.loss.toFixed(3)}\n`);
    }
    if (e.phase === 'fast' && e.stage === 'done') {
      process.stdout.write(`   finished: ${e.samples} samples, loss=${e.loss.toFixed(3)}\n`);
    }
  }
});
const ms = Date.now() - t0;

console.log(`\nTrained on ${samples} samples in ${ms} ms, loss=${loss.toFixed(3)}`);
console.log(`weights: [${model.weights.map((w) => w.toFixed(2)).join(', ')}]`);
console.log(`bias   : ${model.bias.toFixed(3)}`);
console.log(`threshold: ${model.threshold.toFixed(3)}`);
console.log(`samples/loss: ${model.trainingSamples} / ${model.trainingLoss?.toFixed(3)}`);

const out = resolve(fixturesDir, 'readout.trained.json');
await writeFile(out, modelToJson(model));
console.log(`\nSaved → ${out}`);

trainer.dispose();