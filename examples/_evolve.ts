// Shared evolution helpers used by examples/06-evolve.ts and 07-train-and-save.ts.
    //
    // Provides:
    //   - SimpleFlappy class (deterministic, seeded)
    //   - makeTeacher(prev) — first gen uses heuristic, later gens use prev model
    //   - evaluateModel(sim, model, nGames) — game score avg/max
    //   - evolve({gens, iter, evalGames, seed}) — runs full loop, returns best model
    
    import { inferReadout, trainedFlapRequest, freshModel, type ReadoutModel, type TeacherFn } from '../dist/index.js';
    
    const FRAME_DT = 1 / 60;
    const BRAIN_TICK = 0.02;
    
    // Minimal Flappy Bird clone. Seeded so runs are reproducible.
    export class SimpleFlappy {
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
        this.rngState = (seed * 2654435761) >>> 0 || 1;
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
          const gc = (p.gapTop + p.gapBottom) / 2;
          if (
            this.birdX + this.birdR > p.x && this.birdX - this.birdR < p.x + 52 &&
            (this.birdY - this.birdR < p.gapTop || this.birdY + this.birdR > p.gapBottom)
          ) {
            this.alive = false;
            this.deathReason = this.birdY < gc ? 'THE FLY PANICKED.' : 'THE FLY DID NOT FLAP.';
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
    
    // First gen uses heuristic; later gens use the previous model as teacher
    // (self-distillation: imitation of one's own good behaviour).
    export function makeTeacher(prev: ReadoutModel | null): TeacherFn {
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
    
    // Roll out N games with the model, return avg/max game score.
    export function evaluateModel(
      sim: any,
      model: ReadoutModel,
      nGames: number,
      maxFrames = 1200
    ): { avg: number; max: number; scores: number[] } {
      const scores: number[] = [];
      let max = 0;
      for (let g = 0; g < nGames; g++) {
        sim.reset(g + 1);
        if (sim.state) {
          sim.state().trainingSamples = model.trainingSamples ?? 1000;
          sim.state().trainingLoss = model.trainingLoss ?? 0.693;
          sim.state().traces.fill(0);
        }
    
        const game = new SimpleFlappy(g + 1);
        let frame = 0;
        let brainClock = 0;
        while (game.alive && frame < maxFrames) {
          game.update(FRAME_DT);
          const state = game.capture();
          brainClock += FRAME_DT;
          while (brainClock >= BRAIN_TICK) {
            brainClock -= BRAIN_TICK;
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
    
    export interface EvolveConfig {
      gens: number;       // number of generations
      iter: number;       // fastTrain iterations per gen
      evalGames: number;  // games per evaluation
      seed: number;       // trainer seed
    }
    
    export interface EvolveResult {
      bestModel: ReadoutModel;
      bestAvg: number;
      history: Array<{ gen: number; loss: number; samples: number; avg: number; max: number; scores: number[]; elapsedMs: number; isBest: boolean }>;
    }
    
    // One-shot mini-evolution. Each gen: fastTrain(prev as teacher) -> eval -> maybe save best.
    // Returns the best model by avg game score (NOT training loss).
    export async function evolve(
      trainer: any,
      config: EvolveConfig
    ): Promise<EvolveResult> {
      let prevModel: ReadoutModel | null = null;
      let bestModel: ReadoutModel = freshModel(trainer.features);
      let bestAvg = -Infinity;
      const history: EvolveResult['history'] = [];
    
      for (let gen = 1; gen <= config.gens; gen++) {
        const t0 = Date.now();
        const teacher = makeTeacher(prevModel);
        const { model: trained, samples, loss } = await trainer.fastTrain({
          iterations: config.iter,
          teacher,
          report: () => {}
        });
    
        const { avg, max, scores } = evaluateModel(trainer.simulator, trained, config.evalGames);
        const elapsedMs = Date.now() - t0;
    
        const isBest = avg > bestAvg;
        if (isBest) {
          bestAvg = avg;
          bestModel = trained;
        }
    
        history.push({ gen, loss, samples, avg, max, scores, elapsedMs, isBest });
        prevModel = trained;
      }
    
      return { bestModel, bestAvg, history };
    }
    