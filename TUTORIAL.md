# fly-brain-train · 零基础使用教程

> 不会用？跟着这一篇走一遍就会了。**全部示例都能跑**，跑不通来找我。

---

## 🎯 这个库解决什么问题

你想在浏览器（或 Node）里跑**果蝇脑连接组**（166,700 神经元 + 25,000,000 突触），然后训练一个**12 维读出模型**做"该 flap 还是该 wait"的决策。

库给你三件事：

| 你想做的事 | 库提供什么 |
|------------|-------------|
| 加载大脑 | `loadConnectome()` |
| 跑神经元仿真 | `Simulator` 类 |
| 训练决策模型 | `fastTrain()` / `onlineTrain()` |
| 应用模型做决策 | `inferReadout()` + `trainedFlapRequest()` |
| 保存/加载模型 | `modelToJson()` / `modelFromJson()` |

**你不需要懂神经科学**——把脑当成一个黑盒，把"游戏状态 → 6 通道刺激 → 脑内 12 维特征 → sigmoid 概率" 这条管线当成一个**内置的特征提取器**就行。

---

## 🚀 第一步：5 分钟跑起来

```bash
git clone …  fly-brain-train
cd fly-brain-train
pnpm install
pnpm test            # 22/22 应该全过
pnpm examples        # 跑示例 1-3（不需要 fixtures）
pnpm example:full    # 跑示例 4-5（需要 fixtures/）
```

`pnpm example:full` 跑 4 + 5 两个示例，最后你应该看到：

```
训练完成：1930 样本, loss=0.382
权重: [0.80, -0.80, -0.18, -0.18, 0.35, 0.35, 0.09, -0.15, 0.21, -0.09, 0.35, 0.35]
bias=-2.000  threshold=0.370

…

frame | birdY | velocity | gapY | decision | prob | reason
------+-------+----------+------+-----------+------+-------
   0 |    80 |       15 |  335 | · WAIT  |   1% | GUARD:above_target
  …
 354 总帧数, 1 根管, "THE FLY DID NOT FLAP."
```

这就是**完整的端到端管线**——从加载大脑，到训练，到游戏循环里做决策。

---

## 🤔 我要"使用"这个库，到底要做什么？

按使用深度分 4 层，每层都是独立的：

### Level 1 — **我只想加载训练好的模型**（最少代码）

你已经从别处拿到一个 `readout.trained.json`。你只需要：

```ts
import { modelFromJson, validateModel, inferReadout } from 'fly-brain-train';

// 1. 加载（任何形式：浏览器拉 / 用户上传 / 内嵌）
const raw = await fetch('/brain/readout.trained.json').then(r => r.text());
const model = modelFromJson(raw);
validateModel(model);

// 2. 在游戏循环里调一次
function decide(features: Float32Array) {
  return inferReadout(features, model);  // 0..1
}
```

**你已经会用 30% 的库了。**

### Level 2 — 我要**加载大脑 + 训练**（端到端）

```ts
import { createTrainer, modelToJson, readFileSync } from 'fly-brain-train';

const trainer = await createTrainer({
  metaPath: './fixtures/meta.bin',
  weightsPaths: ['./fixtures/weights.0.bin', './fixtures/weights.1.bin'],
  manifest: JSON.parse(readFileSync('./fixtures/brain.json', 'utf8'))
});

const { model } = await trainer.fastTrain({ iterations: 1200 });
console.log(modelToJson(model));  // 931 字符 JSON
trainer.dispose();
```

**你已经会用 70% 的库了。**

### Level 3 — 我要**游戏循环每帧调用**

```ts
import { createTrainer, inferReadout, trainedFlapRequest } from 'fly-brain-train';

const trainer = await createTrainer({ /* 同上 */ });
const { model } = await trainer.fastTrain();

function gameLoop(state: FlappyState, dt: number) {
  // 1. 物理 / 碰撞 / 计分…
  game.update(dt);

  // 2. 大脑每 20ms 走一步（50 Hz）
  brainClock += dt;
  while (brainClock >= 0.02) {
    brainClock -= 0.02;
    trainer.simulator.stimulateFromState(state);
    trainer.simulator.step();
  }

  // 3. 每帧采样 + 推理
  const { smoothed } = trainer.simulator.sampleFeatures();
  const p = inferReadout(smoothed, model);

  // 4. 决策（叠了硬护栏）
  if (trainedFlapRequest(state, p, model.threshold)) {
    bird.flap();
  }
}
```

**你已经会用 95% 的库了。**

### Level 4 — 我要**调底层 + 自定义**

看 `src/` 直接调 `Simulator`、`loadConnectome` 的裸 API。可以做：

- 改教师函数（`fastTrain({ teacher: myTeacher })`）
- 注入自定义刺激（绕开 `FlyEncoder`）
- 改硬护栏（重写 `trainedFlapRequest`）
- 在线学习（每帧 `onlineTrain(sim, model, features, label)`）
- 看仿真状态（`simulator.state().fired` 看本步所有脉冲）

**你已经会用 100% 的库了。**

---

## 📖 我从哪个示例开始？

5 个示例，**严格按这个顺序看**：

| # | 文件 | 你会学到 | 不看会怎样 |
|---|------|----------|------------|
| 1 | `examples/01-encoder.ts` | `FlyEncoder.encode(state)` 把游戏状态变 6 通道刺激 | — |
| 2 | `examples/02-decoder-policy.ts` | `FlyDecoder.decide()` 不训练的纯脑决策 | 不懂硬护栏 |
| 3 | `examples/03-persist.ts` | `modelToJson`/`modelFromJson`/`validateModel` | 不会持久化 |
| 4 | `examples/04-createTrainer.ts` | **端到端**：加载 → 训练 → 导出 | — |
| 5 | `examples/05-game-loop.ts` | **端到端 + 游戏循环** 60 fps 调用 | 不知道怎么嵌入游戏 |

**每个示例 ≤ 100 行**。看完 1-5 不超过 15 分钟。

---

## 🧠 必备概念（**5 个就够**）

### 概念 1：6 通道神经刺激

`FlappyState`（鸟的位置/速度/管距） → `FlyEncoder.encode()` → 6 个 0..1 的刺激值：

```
LC4 / LPLC2 / LC10a L / LC10a R / upward / downward
   ↑       ↑         ↑          ↑         ↑         ↑
接近感  迫近感   左视野上升   右视野下降   上飞信号   下飞信号
```

不关心这些是什么也行——库帮你 encode。

### 概念 2：12 维读出特征

仿真跑完一步，从大脑里**采样 12 个读出神经元的脉冲率**，得到一个 12 维特征向量：

```
[TARGET_DN_L, TARGET_DN_R, LOOM_DN_L, LOOM_DN_R,
 ESCAPE_DN_L, ESCAPE_DN_R, DNae002_L, DNae002_R,
 DNg111_L, DNg111_R, DNp01_L, DNp01_R]
```

训练好的模型就是一个**12 个权重 + 偏置**，对这个向量做加权求和 + sigmoid。

### 概念 3：训练 = logistic 回归

```ts
const { model } = await trainer.fastTrain({
  iterations: 1200,          // 仿真次数
  report: (e) => { /* 进度 */ }
});
// 返回 { model: { weights: [12个], bias, threshold, mean?, scale?, trainingSamples, trainingLoss } }
```

- 内部跑 1200 次仿真，每步采样 12 维特征
- 80/20 切分
- 120 epoch logistic 回归（lr=0.12）
- **硬护栏钳制**：w[0] ≥ 0.8、w[1] ≤ -0.8、w[4,5,10,11] ≥ 0.35
- 网格搜最优 threshold

### 概念 4：推理 = sigmoid

```ts
const p = inferReadout(smoothed12dv, trainedModel);
// = sigmoid(bias + Σᵢ wᵢ × (xᵢ - meanᵢ) / scaleᵢ)
```

返回 0..1。**别忘了调 `trainedFlapRequest(state, p, threshold)`** 而不是直接 `if (p > 0.5)`——后者会让鸟直接撞天花板。

### 概念 5：决策 = 概率 + 硬护栏

```ts
function trainedFlapRequest(state, learned, threshold) {
  const adaptiveMargin = (learned - 0.5) * 12;        // 概率 → 余量
  const belowTarget    = state.birdY > state.gapCenterY + 8 - adaptiveMargin;  // 在间隙下方
  const notClimbingFast = state.birdVelocityY > -70;  // 没在高速爬升
  return learned >= threshold && belowTarget && notClimbingFast;
}
```

**3 条护栏**总是生效（即使训练数据很烂）：

1. **自适应容差**：置信度高 → 允许在离 gap 较远时 flap
2. **高速爬升拦截**：鸟刚 flap 完（vel < -70）不 flap
3. **必须在间隙下方或接近**：birdY > gapCenterY + 8 - adaptiveMargin

---

## 🔨 实战：从零嵌入你的游戏

**假设**：你已经有了一个 Flappy Bird 游戏（不管用什么写的）。

### 步骤 1：把 `flappyState` 抽出来

```ts
interface FlappyState {
  birdY: number;
  birdVelocityY: number;
  pipeX: number;
  pipeWidth: number;
  gapTop: number;
  gapBottom: number;
  gapCenterY: number;
  distanceToPipe: number;
}

function capture(): FlappyState {
  const bird = ...; // 你的鸟
  const pipe = ...; // 你面前的管
  return {
    birdY: bird.y,
    birdVelocityY: bird.vy,
    pipeX: pipe.x,
    pipeWidth: pipe.w,
    gapTop: pipe.gapTop,
    gapBottom: pipe.gapBottom,
    gapCenterY: (pipe.gapTop + pipe.gapBottom) / 2,
    distanceToPipe: pipe.x - bird.x
  };
}
```

### 步骤 2：install + 加载 + 训练

```bash
pnpm add fly-brain-train
cp -r fly-brain-train/fixtures ./public/brain    # 浏览器路径；Node 直接 ./fixtures
```

```ts
// trainer.ts —— 只在游戏启动时跑一次
import { createTrainer, modelToJson, modelFromJson } from 'fly-brain-train';

const manifest = JSON.parse(await fetch('/brain/brain.json').then(r => r.text()));
const trainer = await createTrainer({
  metaPath: '/brain/meta.bin',
  weightsPaths: ['/brain/weights.0.bin', '/brain/weights.1.bin'],
  manifest
});
const { model } = await trainer.fastTrain({ iterations: 1200 });

// 缓存到磁盘，下次直接加载
localStorage.setItem('fly-readout-v1', modelToJson(model));
// 下次启动：
// const model = modelFromJson(localStorage.getItem('fly-readout-v1') ?? modelToJson(await trainer.fastTrain().then(r => r.model)));
```

### 步骤 3：游戏循环里调

```ts
// game.ts
let brainClock = 0;

function gameLoop(now: number) {
  const dt = ...;
  game.update(dt);                              // 你的物理 + 碰撞
  const state = capture();

  brainClock += dt;
  while (brainClock >= 0.02) {                  // 脑 50 Hz
    brainClock -= 0.02;
    trainer.simulator.stimulateFromState(state);
    trainer.simulator.step();
  }

  const { smoothed } = trainer.simulator.sampleFeatures();
  const p = inferReadout(smoothed, model);

  if (trainedFlapRequest(state, p, model.threshold)) {
    bird.flap();
  }
}
```

### 步骤 4：可视化（可选）

```ts
// 给玩家看的 HUD
hud.flapProb.textContent = `FLAP ${(p*100).toFixed(0)}%`;
hud.samples.textContent  = `${model.trainingSamples} SAMPLES`;
hud.loss.textContent     = `LOSS ${model.trainingLoss.toFixed(3)}`;

// 大脑活动热力图（WebGL）
gl.uploadTexture(trainer.simulator.state().activity);  // 0=静息, 255=脉冲
```

**完事**。这是生产级的 4 步集成。

---

## 🚨 我跑会炸——9 个常见错误 & 修复

### 错误 1：`loadConnectome` 报 `Z_BUF_ERROR: unexpected end of file`

**原因**：浏览器导出把 `weights.0.bin` 和 `weights.1.bin` 切成同一 gzip 流的两段，逐个 gunzip 都失败。

**修复**：库 v0.1.1+ 已修。如果还在旧版本：

```bash
pnpm update fly-brain-train
```

### 错误 2：`Cannot find module '.../dist/index.js'`

**原因**：忘记 build。

**修复**：

```bash
pnpm build    # tsc 编译到 dist/
```

或跑示例前用 `pnpm example:full`（会自动 check）。

### 错误 3：训练出来 `loss` 一直是 0.693

`0.693 = -ln(0.5)`，是**完全随机的对数损失**。说明模型没学到东西。

**修复**：

- `iterations` 太低？→ 改成 2000
- `manifest` 跟 fixtures 对不上？→ 看 console 第一行有没有 `integrity check failed`
- brain 步进太慢？→ 调 `meta.params.dt` 或 `gain`（高级）

### 错误 4：鸟**一直不 flap** / **一直 flap**

**一直不 flap**：

- `state.birdVelocityY < -70`（刚 flap 完）→ 鸟刚起步时确实不能 flap
- `state.birdY < state.gapCenterY + 8`（鸟在间隙上方）→ 必须先掉到下方

**一直 flap**：

- threshold 太低（< 0.2）→ 重新 fastTrain 搜个好的 threshold
- 物理参数太狠（重力 = 2000 像素/秒²）→ 鸟永远在落 → 模型判断危险 → flap

### 错误 5：`validateModel is not a function` 或 `validateModel threw`

```ts
import { validateModel } from 'fly-brain-train';
// validateModel 是断言（asserts），不是返回 boolean
const ok = validateModel(model);  // ❌ 永远 undefined
// ✅ 正确：
try { validateModel(model); /* OK */ } catch (e) { /* 坏 */ }
```

### 错误 6：训练后 `weights[0]` 不是 0.80

**那才是正常的**——训练里权重的初值是 logistic 回归解，硬护栏 (`Math.max(0.8, model.weights[0])`) 只在最后一步。

但**如果你想要更小的护栏**（比如 w[0] ≥ 0.5）：在 fastTrain 后手动改：

```ts
const { model } = await trainer.fastTrain({ iterations: 1200 });
model.weights[0] = Math.max(0.5, model.weights[0]);
// 但不推荐 —— 硬护栏是 fastTrain 的卖点
```

### 错误 7：`stimulateFromState is not a function`

**原因**：直接调 `simulator.stimulate(state)` 但 `state` 不是 6 通道 `NeuralStimulus`。

**修复**：

```ts
import { FlyEncoder } from 'fly-brain-train';
const stimulus = FlyEncoder.encode(state);
simulator.stimulate(stimulus);
// 或
simulator.stimulateFromState(state);  // 内部就调了 encode
```

### 错误 8：游戏跑得很慢

`loadConnectome` 加载 57 MB 一次性 + 训练 1200 次仿真 ≈ 8 秒。游戏运行时只有**仿真步 + sigmoid 推理**，每步 < 5 ms。

如果游戏循环每帧都卡 50ms：

- 看 `brainClock` 累加是否对：60 fps 应该每 3 帧才走 1 次 brain
- 不要每帧调 `sampleFeatures` 后又立刻 `fastTrain` —— 训练只跑一次

### 错误 9：模型在浏览器里有 `crossOriginIsolated` 警告

**SharedArrayBuffer** 需要 COOP/COEP headers。Node 没这问题；浏览器要：

```html
<!-- 你的 nginx/apache 配置 -->
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

不配也能跑——只是 activity buffer 用普通 ArrayBuffer，不能跨 worker 零拷贝。

---

## 💡 进阶玩法（你可能用得上）

### 改教师

```ts
import { fastTrain, type TeacherFn } from 'fly-brain-train';

const myTeacher: TeacherFn = (state, features) => {
  // 例：只让模型在确实紧急时 flap（保守策略）
  const urgent = state.birdY > state.gapCenterY + 50 && state.distanceToPipe < 150;
  return urgent ? 1 : 0;
};

const { model } = await fastTrain(simulator, baseModel, {
  iterations: 1200,
  teacher: myTeacher
});
```

### 在线学习（边玩边训）

```ts
import { onlineTrain } from 'fly-brain-train';

let m = baseModel;
for (let frame = 0; frame < 1000; frame++) {
  simulator.stimulateFromState(state);
  simulator.step();
  const { smoothed } = simulator.sampleFeatures();
  const label: 0 | 1 = myTeacher(state, smoothed);
  const result = onlineTrain(simulator, m, smoothed, label);
  m = result.model;
}
```

学习率 0.018，正类权重 ×2，L2 0.0005。**不需要 fastTrain 那种 1200 步初始化**——可以冷启动在线训。

### 多策略 + 投票

```ts
// 训练 3 个不同教师，得到 3 个模型
const models = [
  await trainer.fastTrain({ iterations: 1200, teacher: conservativeTeacher }).then(r => r.model),
  await trainer.fastTrain({ iterations: 1200, teacher: aggressiveTeacher }).then(r => r.model),
  await trainer.fastTrain({ iterations: 1200, teacher: balancedTeacher }).then(r => r.model)
];

// 推理时投票
function ensemble(features: Float32Array, state: FlappyState) {
  const votes = models.map(m =>
    trainedFlapRequest(state, inferReadout(features, m), m.threshold) ? 1 : 0
  );
  return votes.reduce((a,b) => a+b, 0) >= 2;  // 多数决
}
```

### 把模型导出成 CSV（给数据分析师）

```ts
const csv = [
  'feature,weight',
  ...model.features.map((f, i) => `${f},${model.weights[i]}`)
].join('\n');
console.log(csv);
// feature,weight
// TARGET_DN L,0.8
// TARGET_DN R,-0.8
// ...
```

### 导出浏览器格式（兼容 fly-flappy App）

```ts
const wire = {
  format: 'fly-brain-readout-v1',
  exportedAt: new Date().toISOString(),
  model
};
const json = JSON.stringify(wire, null, 2);
// 用户现在可以在浏览器页面点 "IMPORT MODEL" 上传这个 json
```

---

## 📊 性能数据（参考）

| 操作 | 时间 | 备注 |
|------|------|------|
| 加载 connectome（57 MB parts → gunzip → FLYW） | ~1.5 秒 | 一次性 |
| `fastTrain` 1200 iter | ~5 秒 | 全程脑仿真 |
| 训练后 sigmoid 推理 | < 0.01 ms | 12 加法 + 1 指数 |
| 仿真 1 步（脑 + 12 维采样） | ~5 ms | 看神经元 spike 多寡 |
| 序列化/反序列化 | < 1 ms | ~900 字符 JSON |

**游戏循环典型性能**（60 fps + 脑 50 Hz）：CPU ~3%，内存 ~120 MB。

---

## 📋 速查表（按使用频率）

```ts
// 90% 的用户只需要这 5 个：

import {
  createTrainer,      // 加载大脑 + 训练一切的开始
  fastTrain,          // 离线训练 1200 步
  inferReadout,       // 12 维特征 → 0..1 概率
  trainedFlapRequest, // 概率 + 硬护栏 → 决策
  modelToJson,        // 持久化
  modelFromJson       // 还原
} from 'fly-brain-train';
```

---

## 🎁 Bonus：Fly-flappy App 是怎么用这个库的

**没用到**。Fly-flappy 浏览器端的 `src/brain/*` 是同一套逻辑的**内联实现**（含 Web Worker + Cache API）。`fly-brain-train` 是这个实现的纯 TS 抽取版。

两条路径：

1. **直接用库**（Node / SSR / Web Worker）：本 README 的所有示例
2. **fork 内联版**（浏览器 + SharedArrayBuffer）：直接改 `fly-flappy/src/brain/flyBrain.worker.ts`

两者逻辑一致（fastTrain 权重计算 + 12 维 readout 完全相同），可以互换模型 JSON 文件。

---

## ❓ 我卡住了

- 读 `examples/05-game-loop.ts`（完整端到端 demo，140 行）
- 看 `test/createTrainer.test.ts`（集成测试，1 个文件涵盖加载/训练/特征采样）
- 看 `src/connectome.ts` 加载大脑的源码
- 跑 `pnpm test` 看 22 个测试的真实代码

或者直接问我！