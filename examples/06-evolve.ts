/**
     * examples/06-evolve.ts
     *
     * 多代神经进化（neuroevolution）。
     *
     * 每一代：
     *   1. 用上一代模型作老师（第一代用 heuristic）
     *   2. fastTrain 出新一代 readout
     *   3. 跑 N 局游戏评估（不同 seed）
     *   4. 取平均分最高的模型保存
     *
     * 为什么这样做：
     *   - 默认 heuristic teacher 只看 (鸟y, 速度, gap)，常常给错标签
     *   - 用模型自己"成功的行为"当老师 → loss 单调下降、分数提升
     *
     * 跑：node --experimental-strip-types --no-warnings examples/06-evolve.ts
     * 跑：pnpm example:evolve
     */
    
    import { readFile, writeFile } from 'node:fs/promises';
    import { resolve, dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import {
      createTrainer,
      inferReadout,
      modelToJson,
      freshModel,
      trainedFlapRequest,
      type ReadoutModel,
      type TeacherFn
    } from '../dist/index.js';
    
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturesDir = process.env.FIXTURES_DIR ?? resolve(here, '..', 'fixtures');
    
    // ---------- 简化版 Flappy（与 examples/05 一致）----------
    class SimpleFlappy {
      birdY = 80;
      birdVelocity = 0;
      readonly gravity = 900;
      readonly flapImpulse = -360;
      readonly width = 480;
      readonly height = 640;
      readonly birdX = 112;
      readonly birdR = 18;
      pipes: Array<{ x: number; gapTop: number; gapBottom: number; scored: boolean }> = [];
      score = 0;
      spawnTimer = 0;
      readonly pipeSpeed = 130;
      readonly pipeGap = 210;
      alive = true;
      deathReason = '';
      rngState = 1;
    
      constructor(seed: number = 1) {
        this.rngState = seed >>> 0;
        this.pipes.push({ x: 480, gapTop: 230, gapBottom: 230 + this.pipeGap, scored: false });
      }
    
      flap() {
        if (this.alive) this.birdVelocity = this.flapImpulse;
      }
    
      rand() {
        this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
        return this.rngState / 4294967296;
      }
    
      update(dt: number) {
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
          if (!p.scored && p.x + 52 < this.birdX) {
            p.scored = true;
            this.score++;
          }
          const gapCenter = (p.gapTop + p.gapBottom) / 2;
          if (
            this.birdX + this.birdR > p.x && this.birdX - this.birdR < p.x + 52 &&
            (this.birdY - this.birdR < p.gapTop || this.birdY + this.birdR > p.gapBottom)
            ) {
            this.alive = false;
            this.deathReason = this.birdY < gapCenter ? 'THE FLY PANICKED.' : 'THE FLY DID NOT FLAP.';
            return;
          }
        }
        this.pipes = this.pipes.filter((p) => p.x + 52 > -20);
    
        if (this.birdY - this.birdR <= 0 || this.birdY + this.birdR >= this.height - 46) {
          this.alive = false;
          this.deathReason = this.birdY < 100 ? 'THE FLY FLAPPED TOO EARLY.' : 'THE FLY DID NOT FLAP.';
        }
      }
    
      capture() {
        const target = this.pipes.find((p) => p.x + 52 >= this.birdX) ?? this.pipes[0];
        return {
          birdY: this.birdY,
          birdVelocityY: this.birdVelocity,
          pipeX: target.x,
          pipeWidth: 52,
          gapTop: target.gapTop,
          gapBottom: target.gapBottom,
          gapCenterY: (target.gapTop + target.gapBottom) / 2,
          distanceToPipe: target.x - this.birdX
        };
      }
    }
    
    // ---------- teacher 工厂：上一代模型 → 标签 ----------
    function makeTeacher(prev: ReadoutModel | null): TeacherFn {
      if (!prev) {
        return (state, _features) => {
          const below = state.birdY > state.gapCenterY + 8;
          const falling = state.birdVelocityY > -60;
          const danger = state.birdY > state.gapBottom - 38;
          return (below && falling) || danger ? 1 : 0;
        };
      }
      return (_state, features) => {
        const p = inferReadout(features, prev);
        return p > prev.threshold ? 1 : 0;
      };
    }
    
    // ---------- 评估：跑 N 局游戏 ----------
    function evaluateModel(
      sim: any,
      model: ReadoutModel,
      nGames: number
    ): { avg: number; max: number; scores: number[] } {
      const scores: number[] = [];
      let max = 0;
      for (let g = 0; g < nGames; g++) {
        sim.reset(g + 1);
        sim.state().trainingSamples = model.trainingSamples ?? 1000;
        sim.state().trainingLoss = model.trainingLoss ?? 0.693;
        sim.state().traces.fill(0);
    
        const game = new SimpleFlappy(g + 1);
        let frame = 0;
        let brainClock = 0;
        while (game.alive && frame < 1200) {
          game.update(1 / 60);
          const state = game.capture();
          brainClock += 1 / 60;
          while (brainClock >= 0.02) {
            brainClock -= 0.02;
            sim.stimulateFromState(state);
            sim.step();
          }
          const { smoothed } = sim.sampleFeatures();
          const p = inferReadout(smoothed, model);
          if (trainedFlapRequest(state, p, model.threshold)) game.flap();
          frame++;
        }
        scores.push(game.score);
        if (game.score > max) max = game.score;
      }
      const avg = scores.reduce((a, b) => a + b, 0) / nGames;
      return { avg, max, scores };
    }
    
    // ---------- 主流程 ----------
    async function main() {
      console.log('=== 多代神经进化训练 ===\n');
    
      const manifest = JSON.parse(
        await readFile(resolve(fixturesDir, 'brain.json'), 'utf8')
      );
      console.log(
        `fixtures: ${manifest.neurons.toLocaleString()} neurons, ${manifest.connections.toLocaleString()} connections\n`
      );
    
      const trainer = await createTrainer({
        metaPath: resolve(fixturesDir, 'meta.bin'),
        weightsPaths: [
          resolve(fixturesDir, 'weights.0.bin'),
          resolve(fixturesDir, 'weights.1.bin')
        ],
        manifest,
        seed: 42
      });
    
      const NUM_GENERATIONS = 5;
      const ITERATIONS = 1500;
      const N_EVAL_GAMES = 8;
    
      console.log(
        `配置: ${NUM_GENERATIONS} 代 × ${ITERATIONS} iter + ${N_EVAL_GAMES} 局评估\n`
      );
    
      let prevModel: ReadoutModel | null = null;
      let bestModel: ReadoutModel = freshModel(trainer.features);
      let bestAvg = -Infinity;
    
      console.log('  gen | loss   | samples | avg score | max | best weights');
      console.log('  ----+--------+---------+-----------+-----+--------------------------------');
    
      for (let gen = 1; gen <= NUM_GENERATIONS; gen++) {
        const t0 = Date.now();
        const teacher = makeTeacher(prevModel);
        const { model, samples, loss } = await trainer.fastTrain({
          iterations: ITERATIONS,
          teacher,
          report: () => {}
        });
    
        const { avg, max, scores } = evaluateModel(trainer.simulator, model, N_EVAL_GAMES);
        const elapsed = Date.now() - t0;
    
        const isBest = avg > bestAvg;
        if (isBest) {
          bestAvg = avg;
          bestModel = model;
          await writeFile(
            resolve(fixturesDir, 'readout.trained.json'),
            modelToJson(model)
          );
        }
    
        const w = model.weights.map((x) => x.toFixed(2)).join(',');
        const marker = isBest ? ' ★' : '';
        console.log(
          `   ${gen}  | ${loss.toFixed(3)}  |  ${String(samples).padStart(5)}  | ` +
            `${avg.toFixed(1).padStart(6)}   |  ${String(max).padStart(2)}  | [${w}]${marker}`
        );
        console.log(`        eval scores: [${scores.join(', ')}]   (${elapsed}ms)`);
    
        prevModel = model;
      }
    
      console.log('\n=== 总结 ===');
      console.log(`best avg: ${bestAvg.toFixed(2)} pipes (saved → readout.trained.json)`);
      console.log(`final model size: ${modelToJson(bestModel).length} chars`);
    
      trainer.dispose();
    }
    
    main().catch((e) => {
      console.error(e);
      process.exit(1);
    });
    