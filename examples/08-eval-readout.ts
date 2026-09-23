// Example 8 - eval-readout: load fixtures/readout.trained.json and play N games.
    //
    // Pure evaluation demo (no training). Reads the model produced by
    // examples/07-train-and-save.ts and measures how many pipes it clears on
    // average across many seeds.
    //
    // Run:
    //   node --experimental-strip-types --no-warnings examples/08-eval-readout.ts
    //   pnpm example:eval
    //
    // Optional env:
    //   GAMES=50  FRAMES=600  (defaults: 20 games, 800 frames each)
    //   MODEL=fixtures/readout.trained.json
    
    import { createTrainer, inferReadout, trainedFlapRequest, modelFromJson } from '../dist/index.js';
    import { readFile } from 'node:fs/promises';
    import { resolve, dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturesDir = process.env.FIXTURES_DIR ?? resolve(here, '..', 'fixtures');
    const modelPath = process.env.MODEL ?? resolve(fixturesDir, 'readout.trained.json');
    const manifestPath = resolve(fixturesDir, 'brain.json');
    const metaPath = resolve(fixturesDir, 'meta.bin');
    const weightsPaths = [
      resolve(fixturesDir, 'weights.0.bin'),
      resolve(fixturesDir, 'weights.1.bin')
    ];
    const GAMES = Number(process.env.GAMES ?? 20);
    const FRAMES = Number(process.env.FRAMES ?? 800);
    
    console.log('=== examples/08-eval-readout.ts ===\n');
    
    // 1. load model (required)
    let model;
    try {
      model = modelFromJson(await readFile(modelPath, 'utf8'));
    } catch {
      console.error('Cannot read model: ' + modelPath);
      console.error('  Run: pnpm example:train first');
      process.exit(1);
    }
    console.log('model: ' + modelPath);
    console.log('  weights : [' + model.weights.map(w => w.toFixed(3)).join(', ') + ']');
    console.log('  bias    : ' + model.bias.toFixed(3));
    console.log('  thresh  : ' + model.threshold.toFixed(3));
    console.log('  trained : ' + (model.trainingSamples ?? 0) + ' samples, loss=' +
                (model.trainingLoss?.toFixed(3) ?? '?'));
    console.log('');
    
    // 2. load brain
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const trainer = await createTrainer({ metaPath, weightsPaths, manifest, seed: 42 });
    
    // 3. game class (same as 05 / 06)
    class SimpleFlappy {
      birdY = 80; birdVelocity = 0;
      readonly gravity = 900; readonly flapImpulse = -360;
      readonly width = 480; readonly height = 640; readonly birdX = 112; readonly birdR = 18;
      pipes = []; score = 0; spawnTimer = 0;
      readonly pipeSpeed = 130; readonly pipeGap = 210;
      alive = true; deathReason = '';
      rngState = 1;
      constructor(seed) {
        this.pipes.push({ x: 480, gapTop: 230, gapBottom: 230 + this.pipeGap, scored: false });
        this.rngState = (seed * 2654435761) >>> 0 || 1;
      }
      flap() { if (this.alive) this.birdVelocity = this.flapImpulse; }
      rand() { this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0; return this.rngState / 4294967296; }
      update(dt) {
        if (!this.alive) return;
        this.spawnTimer += dt;
        this.birdVelocity += this.gravity * dt;
        this.birdY += this.birdVelocity * dt;
        if (this.spawnTimer >= 2.1) {
          this.spawnTimer -= 2.1;
          const gapTop = 86 + this.rand() * (this.height - 86 * 2 - this.pipeGap);
          this.pipes.push({ x: this.width + 80, gapTop, gapBottom: gapTop + this.pipeGap, scored: false });
        }
        for (const p of this.pipes) {
          p.x -= this.pipeSpeed * dt;
          if (!p.scored && p.x + 52 < this.birdX) { p.scored = true; this.score++; }
          const gc = (p.gapTop + p.gapBottom) / 2;
          if (this.birdX + this.birdR > p.x && this.birdX - this.birdR < p.x + 52 &&
              (this.birdY - this.birdR < p.gapTop || this.birdY + this.birdR > p.gapBottom)) {
            this.alive = false;
            this.deathReason = this.birdY < gc ? 'THE FLY PANICKED.' : 'THE FLY DID NOT FLAP.';
            return;
          }
        }
        this.pipes = this.pipes.filter(p => p.x + 52 > -20);
        if (this.birdY - this.birdR <= 0 || this.birdY + this.birdR >= this.height - 46) {
          this.alive = false;
          this.deathReason = this.birdY < 100 ? 'THE FLY FLAPPED TOO EARLY.' : 'THE FLY DID NOT FLAP.';
        }
      }
      capture() {
        const t = this.pipes.find(p => p.x + 52 >= this.birdX) ?? this.pipes[0];
        return {
          birdY: this.birdY, birdVelocityY: this.birdVelocity,
          pipeX: t.x, pipeWidth: 52, gapTop: t.gapTop, gapBottom: t.gapBottom,
          gapCenterY: (t.gapTop + t.gapBottom) / 2, distanceToPipe: t.x - this.birdX
        };
      }
    }
    
    // 4. play N games
    console.log('playing ' + GAMES + ' games, max ' + FRAMES + ' frames each...\n');
    const scores = [];
    const reasons = {};
    const FRAME_DT = 1 / 60;
    
    for (let g = 0; g < GAMES; g++) {
      const game = new SimpleFlappy(g + 1);
      let brainClock = 0;
      for (let f = 0; f < FRAMES && game.alive; f++) {
        game.update(FRAME_DT);
        const st = game.capture();
        brainClock += FRAME_DT;
        while (brainClock >= 0.02) {
          brainClock -= 0.02;
          trainer.simulator.stimulateFromState(st);
          trainer.simulator.step();
        }
        const { smoothed } = trainer.simulator.sampleFeatures();
        const p = inferReadout(smoothed, model);
        if (trainedFlapRequest(st, p, model.threshold)) game.flap();
      }
      scores.push(game.score);
      reasons[game.deathReason || '(survived)'] = (reasons[game.deathReason || '(survived)'] ?? 0) + 1;
    
      if (g < 3) {
        console.log('  game ' + (g + 1) + ' (seed=' + (g + 1) + '): ' +
                    game.score + ' pipes, ' + (game.alive ? 'survived' : game.deathReason));
      }
    }
    
    // 5. report
    scores.sort((a, b) => a - b);
    const avg = scores.reduce((s, x) => s + x, 0) / scores.length;
    const median = scores[Math.floor(scores.length / 2)];
    const min = scores[0];
    const max = scores[scores.length - 1];
    const variance = scores.reduce((s, x) => s + (x - avg) ** 2, 0) / scores.length;
    const std = Math.sqrt(variance);
    const p90 = scores[Math.floor(scores.length * 0.9)];
    
    const histogram = {};
    for (const s of scores) histogram[s] = (histogram[s] ?? 0) + 1;
    const maxBucket = Math.max(...Object.values(histogram));
    const buckets = Object.keys(histogram).map(Number).sort((a, b) => a - b);
    
    console.log('\n-- results (' + GAMES + ' games) --');
    console.log('avg     : ' + avg.toFixed(2) + ' pipes');
    console.log('median  : ' + median);
    console.log('min     : ' + min);
    console.log('max     : ' + max);
    console.log('p90     : ' + p90);
    console.log('std     : ' + std.toFixed(2));
    console.log('\nscore histogram:');
    for (const b of buckets) {
      const bar = '#'.repeat(Math.round(histogram[b] / maxBucket * 30));
      console.log('  ' + String(b).padStart(3) + ' | ' + bar + ' ' + histogram[b]);
    }
    console.log('\ndeath reasons:');
    for (const r of Object.keys(reasons).sort((a, b) => reasons[b] - reasons[a])) {
      const pct = (reasons[r] / GAMES * 100).toFixed(0);
      console.log('  ' + pct + '%  ' + r);
    }
    
    trainer.dispose();
    console.log('\nDone.\n');
    