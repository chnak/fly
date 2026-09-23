// Example 7 - train-and-save: train a flappy readout via mini-evolution and save.
    //
    // Combines fastTrain (imitation) + game-score evaluation + self-distillation:
    //   - Gen 1: heuristic teacher
    //   - Gen 2..N: previous model as teacher (imitate own good behaviour)
    //   - Each gen: fastTrain then evaluate on K games
    //   - Keep best by AVG GAME SCORE (not training loss) and save JSON
    //
    // Why this works better than single fastTrain:
    //   Pure imitation minimises cross-entropy on teacher labels but the labels
    //   themselves come from a heuristic that breaks in edge cases. By selecting
    //   on real game score, the readout learns what actually keeps the bird alive.
    //
    // Run:
    //   node --experimental-strip-types --no-warnings examples/07-train-and-save.ts
    //   pnpm example:train
    //
    // Optional env:
    //   GENS=3  ITER=1000  EVAL_GAMES=5  SEED=42
    
    import { readFile, writeFile } from 'node:fs/promises';
    import { resolve, dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { createTrainer, modelToJson } from '../dist/index.js';
    import { evolve } from './_evolve.ts';
    
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturesDir = process.env.FIXTURES_DIR ?? resolve(here, '..', 'fixtures');
    const modelPath = resolve(fixturesDir, 'readout.trained.json');
    
    const GENS = Number(process.env.GENS ?? 3);
    const ITER = Number(process.env.ITER ?? 1000);
    const EVAL_GAMES = Number(process.env.EVAL_GAMES ?? 5);
    const SEED = Number(process.env.SEED ?? 42);
    
    console.log('=== examples/07-train-and-save.ts ===\n');
    console.log(`config: ${GENS} gens x ${ITER} iter, ${EVAL_GAMES} eval games, seed=${SEED}\n`);
    
    const manifest = JSON.parse(await readFile(resolve(fixturesDir, 'brain.json'), 'utf8'));
    console.log(
      `fixtures: ${manifest.neurons.toLocaleString()} neurons, ` +
      `${manifest.connections.toLocaleString()} connections`
    );
    
    const trainer = await createTrainer({
      metaPath: resolve(fixturesDir, 'meta.bin'),
      weightsPaths: [
        resolve(fixturesDir, 'weights.0.bin'),
        resolve(fixturesDir, 'weights.1.bin')
      ],
      manifest,
      seed: SEED
    });
    
    const t0 = Date.now();
    const { bestModel, bestAvg, history } = await evolve(trainer, {
      gens: GENS, iter: ITER, evalGames: EVAL_GAMES, seed: SEED
    });
    const elapsed = Date.now() - t0;
    
    // print history table
    console.log('  gen | loss   | samples | avg score | max | scores');
    console.log('  ----+--------+---------+-----------+-----+------------------');
    for (const h of history) {
      const marker = h.isBest ? ' *' : '  ';
      const w = h.scores.join(',');
      console.log(
        `  ${h.gen}${marker} | ${h.loss.toFixed(3)}  |  ${String(h.samples).padStart(5)}  | ` +
        `${h.avg.toFixed(2).padStart(6)}    |  ${String(h.max).padStart(2)}  | [${w}]`
      );
    }
    
    // write JSON
    const json = modelToJson(bestModel);
    await writeFile(modelPath, json);
    
    const w = bestModel.weights.map((x) => x.toFixed(3)).join(', ');
    console.log('\n-- saved --');
    console.log(`output      : ${modelPath}`);
    console.log(`json size   : ${json.length} chars`);
    console.log(`best avg    : ${bestAvg.toFixed(2)} pipes (over ${EVAL_GAMES} games)`);
    console.log(`best weights: [${w}]`);
    console.log(`best bias   : ${bestModel.bias.toFixed(3)}, threshold: ${bestModel.threshold.toFixed(3)}`);
    console.log(`elapsed     : ${elapsed} ms`);
    
    trainer.dispose();
    console.log('\nDone. Next: pnpm example:eval to verify on more seeds.\n');
    