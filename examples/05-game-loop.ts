/**
 * examples/05-game-loop.ts
 *
 * 端到端：用 fly-brain-train 训练一个 12 维 readout 模型，
 *        然后把它套进一个 60 fps 简化 Flappy 游戏循环。
 *
 * 演示：
 *   - 加载 fixtures/ 里的 MaleCNS 连接组
 *   - fastTrain 2000 次采样（≈ 8 秒）
 *   - 训练好的模型 → 导出 JSON → 从 JSON 加载回来
 *   - 跑 800 帧游戏，brain step（50 Hz）+ 读出推理（每帧）
 *   - 打印最终分数 / 撞死原因 / 模型权重
 *
 * 跑：node --experimental-strip-types --no-warnings examples/05-game-loop.ts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTrainer,
  inferReadout,
  trainedFlapRequest,
  modelToJson,
  modelFromJson,
  validateModel
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = process.env.FIXTURES_DIR ?? resolve(here, '..', 'fixtures');

// ---------- 简化版 Flappy（顶层 class，避开 TDZ） ----------
class SimpleFlappy {
  // 物理参数（像素/秒）
  birdY = 80;
  birdVelocity = 0;
  readonly gravity = 900;        // px/s²（≈ 22.4 像素/帧² × 60²/60 = 1344；这里取温和的 900）
  readonly flapImpulse = -360;   // px/s
  readonly width = 480;
  readonly height = 640;
  readonly birdX = 112;
  readonly birdR = 18;
  pipes: Array<{ x: number; gapTop: number; gapBottom: number; scored: boolean }> = [];
  score = 0;
  spawnTimer = 0;
  readonly pipeSpeed = 130;       // px/s
  readonly pipeGap = 210;
  alive = true;
  deathReason = '';
  rngState = 1;

  constructor() {
    // 第一根管放在鸟右侧 350 px，gap 中心在 320 偏下，让鸟初期需要 flap
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
    this.pipes = this.pipes.filter(p => p.x + 52 > -20);

    if (this.birdY - this.birdR <= 0 || this.birdY + this.birdR >= this.height - 46) {
      this.alive = false;
      this.deathReason = this.birdY < 100 ? 'THE FLY FLAPPED TOO EARLY.' : 'THE FLY DID NOT FLAP.';
    }
  }

  capture() {
    const target = this.pipes.find(p => p.x + 52 >= this.birdX) ?? this.pipes[0];
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

// ---------- 1. 加载 fixture + 训练 ----------
console.log('═══ 1. 加载 fixtures + 训练 readout 模型 ═══');

const manifest = JSON.parse(
  await readFile(resolve(fixturesDir, 'brain.json'), 'utf8')
);
const metaPath = resolve(fixturesDir, 'meta.bin');
const weightsPaths = [
  resolve(fixturesDir, 'weights.0.bin'),
  resolve(fixturesDir, 'weights.1.bin')
];

const trainer = await createTrainer({
  metaPath,
  weightsPaths,
  manifest,
  onProgress: () => {}
});

const { model: trainedModel } = await trainer.fastTrain({
  iterations: 2000,
  report: () => {}
});

console.log(`训练完成：${trainedModel.trainingSamples} 样本, loss=${trainedModel.trainingLoss.toFixed(3)}`);
console.log(`权重: [${trainedModel.weights.map(w => w.toFixed(2)).join(', ')}]`);
console.log(`bias=${trainedModel.bias.toFixed(3)}  threshold=${trainedModel.threshold.toFixed(3)}`);

// ---------- 2. 导出 + 重新加载（演示 persist） ----------
console.log('\n═══ 2. 序列化模型 → JSON → 再反序列化 ═══');
const wire = modelToJson(trainedModel);
await writeFile(resolve(fixturesDir, 'readout.trained.json'), wire);
console.log(`序列化大小: ${wire.length} 字符 → 已保存到 fixtures/readout.trained.json`);

const loaded = modelFromJson(wire);
let validateOk = true;
try { validateModel(loaded); } catch (e) { validateOk = false; console.error(e); }
console.log(`反序列化校验: ${validateOk ? 'OK' : 'FAIL'}  (features=${loaded.features.length}, weights=${loaded.weights.length})`);

// 把训练好的模型装回 simulator 状态机
const trainerState = trainer.simulator.state();
trainerState.trainingSamples = loaded.trainingSamples ?? 0;
trainerState.trainingLoss = loaded.trainingLoss ?? 0.693;
trainer.dispose();

// ---------- 3. 游戏循环（brain step 50 Hz + 读出推理） ----------
console.log('\n═══ 3. 跑游戏循环（800 帧 / ~13 秒）═══');

const t2 = await createTrainer({
  metaPath,
  weightsPaths,
  manifest,
  initialModel: loaded
});

const game = new SimpleFlappy();
let frame = 0;
let brainClock = 0;
const FRAME_DT = 1 / 60;
let printNextAt = 0;

console.log('frame | birdY | velocity | gapY | decision | prob | reason');
console.log('------+-------+----------+------+-----------+------+-------');

while (game.alive && frame < 800) {
  game.update(FRAME_DT);
  const state = game.capture();

  brainClock += FRAME_DT;
  while (brainClock >= 0.02) {
    brainClock -= 0.02;
    t2.simulator.stimulateFromState(state);
    t2.simulator.step();
  }

  const { smoothed } = t2.simulator.sampleFeatures();
  const p = inferReadout(smoothed, loaded);

  const flap = trainedFlapRequest(state, p, loaded.threshold);
  if (flap) game.flap();

  if (frame >= printNextAt) {
    printNextAt = frame + 30;
    const reason = !game.alive ? 'DEAD' :
                   flap ? '↑ FLAP' :
                   state.birdVelocityY < -70 ? 'GUARD:high_velocity' :
                   state.birdY < state.gapCenterY + 8 ? 'GUARD:above_target' :
                   'WAIT';
    console.log(
      `${String(frame).padStart(4)} | ${state.birdY.toFixed(0).padStart(5)} | ` +
      `${state.birdVelocityY.toFixed(0).padStart(8)} | ` +
      `${state.gapCenterY.toFixed(0).padStart(4)} | ` +
      `${flap ? '↑ FLAP' : '· WAIT'.padEnd(7)} | ` +
      `${(p * 100).toFixed(0).padStart(3)}% | ${reason}`
    );
  }

  frame++;
}

console.log('\n═══ 最终结果 ═══');
console.log(`总帧数: ${frame}`);
console.log(`最终分数: ${game.score} 根管`);
console.log(`鸟的最终位置: y=${game.birdY.toFixed(0)}, velocity=${game.birdVelocity.toFixed(0)}`);
console.log(`死亡原因: ${game.deathReason || '(survived all 800 frames)'}`);

t2.dispose();