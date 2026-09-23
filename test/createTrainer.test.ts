import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import createTrainer from '../src/createTrainer.js';

const fixturesDir = resolve(process.cwd(), 'fixtures');
const manifestPath = resolve(fixturesDir, 'brain.json');
const metaPath = resolve(fixturesDir, 'meta.bin');
const weightsPaths = [
  resolve(fixturesDir, 'weights.0.bin'),
  resolve(fixturesDir, 'weights.1.bin')
];
const hasFixtures = existsSync(manifestPath) && existsSync(metaPath) && weightsPaths.every(existsSync);

const itMaybe = hasFixtures ? it : it.skip;

describe('createTrainer (full connectome)', () => {
  itMaybe('loads the bundled MaleCNS connectome end-to-end', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const trainer = await createTrainer({ metaPath, weightsPaths, manifest });

    expect(trainer.brain.meta.n).toBe(manifest.neurons);
    expect(trainer.features).toHaveLength(12);
    expect(trainer.simulator).toBeDefined();

    // Run a few steps and make sure features sample cleanly.
    trainer.simulator.stimulateFromState({
      birdY: 320, birdVelocityY: 50, gapCenterY: 320, distanceToPipe: 120
    });
    trainer.simulator.step();
    const { raw, smoothed } = trainer.simulator.sampleFeatures();
    expect(raw).toHaveLength(12);
    expect(smoothed).toHaveLength(12);
    for (const v of smoothed) expect(Number.isFinite(v)).toBe(true);

    trainer.dispose();
  }, 60_000);
});