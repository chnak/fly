# @chnak/fly · 中文文档

> 一个 **TypeScript 训练库**：把果蝇脑连接组（MaleCNS）当作 1300 万突触的"感知处理器"，在你的游戏/任务里跑 LIF 仿真，再用 logistic 回归在上面训练一个**小型读出层**（12 个 DN 神经元的加权 + sigmoid），做"现在该不该 flap"的二分类。

---

## 目录

1. [它是什么](#1-它是什么)
2. [安装](#2-安装)
3. [内置 fixtures — 立刻就能跑](#3-内置-fixtures--立刻就能跑)
4. [概念速览](#4-概念速览)
5. [快速上手](#5-快速上手)
6. [端到端训练流程](#6-端到端训练流程)
7. [训练 API 详解](#7-训练-api-详解)
8. [推理 API](#8-推理-api)
9. [自定义教师](#9-自定义教师)
10. [持久化模型](#10-持久化模型)
11. [Connectome 文件格式与加载原理](#11-connectome-文件格式与加载原理)
12. [Simulator 进阶](#12-simulator-进阶)
13. [嵌入游戏循环](#13-嵌入游戏循环)
14. [调试与常见问题](#14-调试与常见问题)
15. [API 参考表](#15-api-参考表)
16. [`fly-fetch` CLI — 下载 fixtures](#16-fly-fetch-cli--下载-fixtures)
17. [应用方向：自动交易](#17-应用方向自动交易)

---

## 1. 它是什么

- **底层**：果蝇脑 25,000 个神经元、~1300 万条化学突触的连接组（MaleCNS / flywire），用稀疏 CSR 格式压缩存储在 `.flw`/`.flt` 文件里。
- **运行时**：LIF（Leaky Integrate-and-Fire）神经元仿真器，dt=1ms，把 6 通道视觉刺激（LC4 / LPLC2 / LC10a-L/R）灌进去，得到 descending neuron（DN）的脉冲时序。
- **读出层**：每步采样 12 个 DN 群体的脉冲率（target/loom/escape + 4 个具体 DN），用 sigmoid 把它们加权求和，得到一个 0..1 的"该不该 flap"概率。
- **训练**：默认走 `fastTrain()`（离线 1200 次仿真 + 80/20 切分 + 120 epoch logistic 回归 + 阈值搜索）。也可以 `onlineTrain()` 一边玩一边学。
- **护栏**：训练后的策略函数 `trainedFlapRequest()` 会在"高速爬升中"和"已经在间隙上方"时**硬拦截** flap，防止学习到的模型把鸟拍进管子里。

适合做：

- Flappy Bird / 类管道游戏的离线策略训练
- 给小型神经网络找"if-then"基线（用仿真替代手写规则）
- 在游戏循环里跑"果蝇大脑"做实时决策
- 仿真数据回归分析（线性模型权重可解释）

---

## 2. 安装

需要 **Node ≥ 20**（开发时 24.5+）。

```bash
# 推荐 pnpm
pnpm add @chnak/fly

# 或 npm
npm install @chnak/fly
```

构建 + 跑测试 + 类型检查：

```bash
pnpm build        # tsc 出 dist/
pnpm test         # vitest 跑全部测试（含真实 connectome 集成测试）
pnpm typecheck    # 严格模式 tsc --noEmit
```

---

## 3. 内置 fixtures — 立刻就能跑

**仓库自带真实的 MaleCNS 连接组**（从同目录的 `fly-flappy/public/brain/` 拷过来），无需任何额外下载：

```
fixtures/
  brain.json         243 B   ← manifest，字段与 BrainManifest 接口一致
  meta.bin           328 KB  ← gzipped FLYM 神经元元数据
  weights.0.bin      40 MB   ┐
  weights.1.bin      17.5 MB ┘ ← 两段拼起来是单个 gzip 流 → 整体 gunzip 得 62 MB FLYW
  readout.json       563 B   ← 默认训练模型（权重全 0，是空骨架）
```

**数据规模**：166,700 神经元 + 25,088,107 条突触连接 + ln_min=-11.695 + weights_mb=57.6。

**注意**：完整的 MaleCNS v1.0 是 20 万神经元、~5 千万突触。本 fixtures 是 `sensory_input=False` 导出（移除指向感觉神经元的传入边），所以规模缩水到 16.7 万。

### 3.1 跑起来

```bash
cd fly
pnpm examples          # 跑 01-encoder / 02-decoder-policy / 03-persist（无需 fixtures）
pnpm example:full      # 跑 04-createTrainer（用 ./fixtures/）
pnpm test              # 22/22 测试，含 createTrainer 集成测试
```

### 3.2 如果 fixtures 不见了

如果 `fixtures/` 目录缺失或损坏，**推荐用 `fly-fetch` CLI 一键恢复**（详见 [§16](#16-fly-fetch-cli--下载-fixtures)）：

```bash
# 安装包后（或者在仓库内 pnpm install）执行
npx fly-fetch
# → 下载 7 个文件 / 55.25 MB 到 ./fixtures/
```

如果想手动恢复：

```bash
# 从同目录的 fly-flappy 仓库恢复
cp ../fly-flappy/public/brain/* fixtures/
```

或重新从浏览器导出：

```js
// 浏览器 devtools 控制台
maleCNS.exportConnectome({ metaPath: 'exports/meta.bin',
                          weightsPaths: ['exports/weights.0.bin', 'exports/weights.1.bin'] });
console.log(JSON.stringify(maleCNS.exportManifest()));
// 把 5 个字段涂到 exports/brain.json
```

---

## 4. 概念速览

### 4.1 神经刺激（6 通道）

| 通道       | 含义                                              |
|------------|---------------------------------------------------|
| `LC4`      | 全屏运动 / 接近感（approach）                       |
| `LPLC2`    | 迫近感（looming）                                    |
| `LC10a L`  | 左视野 loom + 上升运动（合成进 LC10a 驱动）          |
| `LC10a R`  | 右视野 loom + 下降运动（合成进 LC10a 驱动）          |
| upward     | 由 LC10a 编码（速度 < 0 时偏 L）                     |
| downward   | 由 LC10a 编码（速度 ≥ 0 时偏 R）                     |

`FlyEncoder.encode(state)` 把 `FlappyState`（鸟的位置/速度/管距）投影到这 6 个通道。如果不想用 FlappyState，也可以直接调 `simulator.stimulate({ LC4_L, LC10a_L, ... })`。

### 4.2 读出特征（12 个 DN）

```
TARGET_DN L  | TARGET_DN R    ← 瞄准管道的 DN（8 个 DN 类）
LOOM_DN L    | LOOM_DN R      ← 紧急逃避触发（12 个 DN 类）
ESCAPE_DN L  | ESCAPE_DN R    ← 整体逃避信号（4 个 DN 类）
DNae002 L/R  | DNg111 L/R     ← 单 DN，提供更细粒度信号
DNp01 L/R                     ← 最关键的逃避 DN（FlyDecoder 也用它）
```

`rate(ids, activity)` 把一组神经元里 activity==255 的占比归一化到 0..1，然后用 EMA（α=0.14）平滑成 `smoothed` 特征向量。

### 4.3 ReadoutModel 数据结构

```ts
interface ReadoutModel {
  features: string[];        // 12 个特征名（决定权重顺序）
  weights: number[];         // 12 个权重（z-score 后）
  bias: number;              // 偏置
  threshold: number;         // FLAP 判定阈值（0..1）
  mean?: number[];           // z-score 用均值
  scale?: number[];          // z-score 用标准差
  trainingSamples?: number;  // 已训练样本数
  trainingLoss?: number;     // 验证损失（指数平均）
}
```

所有数值都 z-score 标准化。`mean/scale` 在 `fastTrain()` 时计算，推理时 `inferReadout()` 自动套用。

### 4.4 三种决策通道

| 函数                    | 何时用                                          |
|-------------------------|-------------------------------------------------|
| `trainedFlapRequest()`  | **默认**。把 sigmoid 输出当概率，再叠硬护栏。 |
| `inferReadout()`        | 想要概率值，自己叠策略时调。                   |
| `FlyDecoder.decide()`   | **不训练**、只读 DNp01 脉冲时用（纯脑，无学习）。|

---

## 5. 快速上手

```bash
pnpm examples
```

会看到 4 段输出：

- **01-encoder**：三种典型 FlappyState → 6 通道神经刺激
- **02-decoder-policy**：FlyDecoder 滚动窗口 + 策略护栏 + 在线阈值收敛 + sigmoid 推理
- **03-persist**：fresh / validate / modelToJson / modelFromJson
- **04-createTrainer**（用 fixtures/）：端到端训练 1200 步 → 保存 trained.json

源码每个不到 100 行，可以直接打开看。

---

## 6. 端到端训练流程

最小训练代码（完整可运行版见 `examples/04-createTrainer.ts`）：

```ts
import { createTrainer, modelToJson } from '@chnak/fly';
import { writeFile, readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('./fixtures/brain.json', 'utf8'));

const trainer = await createTrainer({
  metaPath:        './fixtures/meta.bin',
  weightsPaths:    ['./fixtures/weights.0.bin', './fixtures/weights.1.bin'],
  manifest,
  initialModel:    modelFromJson(await readFile('./fixtures/readout.json', 'utf8'))  // 可选 warm start
});

const { model, samples, loss } = await trainer.fastTrain({
  iterations: 1200,
  report: (e) => {
    if (e.phase === 'fast' && e.stage === 'done') {
      console.log(`finished: ${e.samples} samples, loss=${e.loss.toFixed(3)}`);
    }
  }
});

await writeFile('./fixtures/readout.trained.json', modelToJson(model));
trainer.dispose();
```

实际跑出来的典型产物：

```
weights: [0.80, -0.80, -0.16, -0.16, 0.35, 0.35, 0.10, -0.17, 0.23, -0.06, 0.35, 0.35]
bias   : -2.078
threshold: 0.250
samples/loss: 1160 / 0.415
```

训练时间：1200 iter 在 i7 上约 5-6 秒。

注意前两个权重（`0.80, -0.80`）和第 5/6/11/12 个权重（`0.35`）是**硬护栏钳制后的结果**，详见 §7.1。

---

## 7. 训练 API 详解

### 7.1 `fastTrain(sim, model, opts)` —— 离线批量训练

完整流水线（**与浏览器"Fast Train"按钮同源**）：

1. 重置 simulator，确定性 RNG（种子 = `model.trainingSamples * 7919 + 1`）
2. 随机生成 1200 个 Flappy 状态，按 `defaultTeacher` 打标签
3. 跑 LIF 仿真 1200 步，每步采样 12 维特征（EMA 平滑）
4. 80/20 切分训练/验证集
5. 算均值/标准差，z-score 标准化
6. **120 epoch logistic 回归**（lr=0.12，正负类加权平衡）
7. **硬护栏**（永远生效，即使 logistic 学出别的值也会被拉回）：
   - `weights[0]`（TARGET_DN L）至少 `0.8`
   - `weights[1]`（TARGET_DN R）至多 `-0.8`
   - `weights[4,5,10,11]`（ESCAPE + DNp01）至少 `0.35`
8. 在验证集上 0.2..0.7 网格搜最优 threshold（最终 `Math.min(0.5, best)`）

```ts
const { model, samples, loss } = await fastTrain(simulator, baseModel, {
  iterations: 1200,            // 400..5000
  teacher: defaultTeacher,      // 可换成自定义 teacher
  report: (e) => { /* 进度 */ }
});
```

### 7.2 `onlineTrain(sim, model, features, label)` —— 在线学习

```ts
import { onlineTrain } from '@chnak/fly';

let model = baseModel;
for (let step = 0; step < 10000; step++) {
  simulator.stimulateFromState(state);
  simulator.step();
  const { smoothed } = simulator.sampleFeatures();
  const label: 0 | 1 = myTeacher(state, smoothed);
  const r = onlineTrain(simulator, model, smoothed, label);
  model = r.model;
}
```

- 学习率 `lr = 0.018`
- 正类权重 ×2（FLAP 比 WAIT 少）
- L2 正则 0.0005
- 权重 clip 到 `[-6, 6]`，bias clip 到 `[-4, 4]`

### 7.3 `applyModel(sim, model)` —— 应用模型

```ts
applyModel(simulator, trainedModel);
```

把训练好的模型"装回" simulator 状态机（设 samples ≥ 1000、loss、traces.fill(0)）。

### 7.4 进度事件

```ts
type ProgressEvent =
  | { phase: 'init'; stage: string; value: number }
  | { phase: 'fast'; epoch: number; totalEpochs: number; done: number; total: number; loss: number }
  | { phase: 'fast'; stage: 'sample'; done: number; total: number; loss: number }
  | { phase: 'fast'; stage: 'done'; samples: number; loss: number };
```

`stage: 'sample'` 高频，生产环境记得节流。

---

## 8. 推理 API

### 8.1 `inferReadout(features, model)` —— 纯数学

```ts
const p = inferReadout(features, trainedModel);  // 0..1
```

内部 `sigmoid(bias + Σ w_i * (x_i - mean_i)/scale_i)`。

### 8.2 `trainedFlapRequest(state, learned, threshold)` —— **推荐**

```ts
if (trainedFlapRequest(currentState, p, model.threshold)) fly.flap();
```

**3 条硬护栏**（总是生效）：

1. **自适应容差**：`belowTarget` 用 `(learned - 0.5) * 12` 调整鸟离 gap 的判定余量——置信度越高，越愿意在接近 gap 时就 flap。
2. **高速爬升拦截**：`|velocityY| > 70`（向上飞）时直接拒绝 flap。
3. **必须在间隙下方或接近**：`birdY > gapCenterY + 8 - adaptiveMargin`。

### 8.3 `FlyDecoder.decide(now, spike)` —— 纯脑（无训练）

```ts
const decoder = new FlyDecoder(/* threshold= */ 2, /* cooldown= */ 120);

simulator.step();
const spike = simulator.dnp01Rate() > 0.1;
const decision = decoder.decide(performance.now(), spike);  // 'FLAP' | 'WAIT'
```

- 100 ms 滚动窗口累计 DNp01 脉冲
- 窗口内 ≥ 2 个脉冲 → FLAP（受 cooldown 120ms 限制）

### 8.4 `onlineLearningThreshold(samples, trainedThreshold)` —— 在线阈值退火

```ts
const t = onlineLearningThreshold(simulator.state().trainingSamples, model.threshold);
// 0 sample → 0.68（保守）
// 1000+ sample → model.threshold（信任模型）
```

---

## 9. 自定义教师

```ts
type TeacherFn = (state: FlappyState, features: Float32Array) => 0 | 1;

const aggressive: TeacherFn = (state, features) => {
  const nearPipe = state.distanceToPipe < 120;
  const offCenter = Math.abs(state.gapCenterY - state.birdY) > 30;
  return (nearPipe && offCenter) ? 1 : 0;
};

await fastTrain(simulator, baseModel, { teacher: aggressive });
```

`features` 不会修改，可读。如果想做"DNp01 已经在响应该不 flap"的复杂规则也可以。

---

## 10. 持久化模型

| 函数 | 作用 |
|------|------|
| `modelToJson(model)` | 序列化为字符串（~350 字符） |
| `modelFromJson(text)` | 解析 + 校验，内部已经 `JSON.parse` |
| `validateModel(model)` | 运行时校验（features/weights 等长、全 finite） |
| `cloneModel(model)` | 深拷贝（weights/mean/scale） |
| `freshModel(features?)` | 全零模型（bias=-0.35, threshold=0.42） |

```ts
const wire = modelToJson(model);                     // 序列化为字符串
fs.writeFileSync('readout.json', wire);
const model = modelFromJson(fs.readFileSync('readout.json', 'utf8'));
// 注意 modelFromJson(text) 已经内部 JSON.parse，不要再外套 parse
```

`modelFromJson` 还接受浏览器格式 `{ format: 'fly-brain-readout-v1', model: {...} }` 和裸模型两种。

---

## 11. Connectome 文件格式与加载原理

### 11.1 浏览器导出格式

浏览器 devtools 控制台：

```js
maleCNS.exportConnectome({
  metaPath:     'exports/meta.bin',
  weightsPaths: ['exports/weights.0.bin', 'exports/weights.1.bin']
});
console.log(JSON.stringify(maleCNS.exportManifest()));
```

文件格式：

| 文件 | 格式 | 说明 |
|------|------|------|
| `meta.bin` | gzip → FLYM | 神经元类型 + 侧别 + 仿真参数 |
| `weights.0.bin` | gzip 片段 1 ┐ | CSR 稀疏突触权重；两个 part **拼起来**才是一个完整的 gzip 流 |
| `weights.1.bin` | gzip 片段 2 ┘ | |
| `brain.json` | JSON manifest | 神经元/突触数量、文件清单、压缩误差 |

**关键陷阱**：`weights.0.bin` 和 `weights.1.bin` 不是独立 gzip，不能逐个 gunzip。它们是同一个 gzip 流的两个分段，**必须把原始字节拼接后再 gunzip 一次**。这是浏览器 `fetchGz()` 的做法，也是本库的实现。

`loadConnectome()` 会做完整性校验（magic 头、神经元数、突触数），任一不符直接抛错。

### 11.2 manifest 字段

`brain.json` 字段与 `BrainManifest` 接口完全一致：

```json
{
  "neurons": 166700,
  "connections": 25088107,
  "ln_min": -11.694705171391272,
  "weights_mb": 57.6,
  "parts": ["weights.0.bin", "weights.1.bin"],
  "meta_mb": 0.34,
  "weight_error_mean": 0.023,
  "weight_error_max": 0.0471
}
```

### 11.3 解析步骤

`loadConnectome(opts)`：

1. 读 `metaPath` → 检测 magic → 若是 1f 8b 则 gunzip → `parseMeta(buf)`
2. 并行读所有 `weightsPaths[i]`，只读取尺寸用于进度
3. 按顺序读 part → 拼接原始字节 → 检测整体 magic → 若是 1f 8b 则整体 gunzip → `parseWeights(buf)`
4. 校验 `meta.n === manifest.neurons`、`weights.n === manifest.neurons`、`weights.nnz === manifest.connections`
5. 返回 `{ meta, weights, manifest, cells, featureCells, dispose }`

---

## 12. Simulator 进阶

### 12.1 自己灌刺激（绕开 Flappy encoder）

```ts
import { Simulator } from '@chnak/fly';

const sim = new Simulator(brain, DEFAULT_READOUT.features);
sim.init(42);

sim.stimulate({LC4_L: 0.5, LC10a_R: 0.8});
sim.step();
const { raw, smoothed } = sim.sampleFeatures();
```

### 12.2 看真实神经元活动

```ts
const spikeNeuronIds = sim.state().fired;     // 本步所有脉冲神经元 id
const spikeCount = sim.state().firedCount;
const totalSpikes = sim.state().totalSpikes;
```

### 12.3 SimulationState 字段速查

```ts
interface SimulationState {
  v: Float32Array;              // 膜电位
  drive: Float32Array;          // 外部刺激（每步后清零）
  current: Float32Array;        // 突触输入
  fired: Int32Array;            // 本步脉冲的神经元 id
  firedCount: number;
  activity: Uint8Array;         // 0=静息, 255=本步脉冲, 1..180=亚阈值
  totalSpikes: number;
  rng: number;
  traces: Float32Array;         // 12 维 EMA 读出 trace
  trainingSamples: number;
  trainingLoss: number;
}
```

### 12.4 按名字查神经元

```ts
const ids = brain.featureCells('TARGET_DN L');
console.log(`${ids.length} neurons in TARGET_DN L`, ids.slice(0, 10));
// 或直接按名字（精确 + 父类匹配）
const lc4L = brain.cells('LC4', 'L');
```

---

## 13. 嵌入游戏循环

60 fps 游戏，1 个仿真步 = 1 个 game frame：

```ts
import { createTrainer, inferReadout, trainedFlapRequest } from '@chnak/fly';

const trainer = await createTrainer({ /* fixtures */ });
const { model } = await trainer.fastTrain();

function gameLoop(state: FlappyState) {
  trainer.simulator.stimulateFromState({
    birdY: state.birdY,
    birdVelocityY: state.birdVelocityY,
    gapCenterY: state.gapCenterY,
    distanceToPipe: state.distanceToPipe
  });

  trainer.simulator.step();

  const { smoothed } = trainer.simulator.sampleFeatures();
  const learned = inferReadout(smoothed, model);

  if (trainedFlapRequest(state, learned, model.threshold)) {
    fly.flap();
  }
}
```

更高 FPS（如 120/144 Hz）可以**每 N 帧才步进一次仿真**，否则脑电活动会被时间压缩得太快。

---

## 14. 调试与常见问题

### 14.1 训练后 loss 不下降

- 检查 `iterations` ≥ 400（默认 1200）
- 检查 `defaultTeacher` 对你的任务合理
- 看 `e.stage === 'done'` 事件的 `samples` 是否 ≥ 100

### 14.2 模型全是 FLAP / 全是 WAIT

- 阈值 `model.threshold` 太低 / 太高
- 硬护栏会拦掉几乎所有决策——检查 `state.birdVelocityY > -70` 是不是满足

### 14.3 `loadConnectome` 抛 "integrity check failed"

- 导出的 manifest 和文件对不上
- 重新跑一次浏览器导出

### 14.4 `Z_BUF_ERROR: unexpected end of file`

- 这是**库 bug**：逐文件 gunzip。但官方导出的 weights parts 是单 gzip 流的两段，必须整体 gunzip
- 0.1.1+ 已修，新版用 `readAllWeightsParts()` 拼接 + 整体 gunzip
- 如果还在旧版，先 `pnpm update @chnak/fly`，或手动把 parts 拼成单个 gzip 文件再加载

### 14.5 想关掉硬护栏自己跑

直接调 `inferReadout()` 而不是 `trainedFlapRequest()`，自己做策略。

### 14.6 默认 fixtures 跑得很慢

`fixtures/weights.0.bin` + `weights.1.bin` 共 57.6 MB，gunzip 后 62 MB。加载约 1 秒；fastTrain 1200 步约 5 秒。

---

## 15. API 参考表

| 模块              | 导出                                                       |
|-------------------|------------------------------------------------------------|
| `types`           | `FlappyState`, `NeuralStimulus`, `BrainActivity`, `Decision`, `BrainManifest`, `ReadoutModel`, `ProgressEvent`, `ProgressReporter` |
| `encoder`         | `FlyEncoder.encode(state)`                                 |
| `decoder`         | `FlyDecoder` 类                                            |
| `readout`         | `DEFAULT_READOUT`, `inferReadout(features, model)`        |
| `policy`          | `trainedFlapRequest`, `onlineLearningThreshold`           |
| `teacher`         | `defaultTeacher`, `TeacherFn`, `Label`                    |
| `connectome`      | `loadConnectome`, `parseMeta`, `parseWeights`, `Connectome`, `ConnectomeLoadOptions`, `Meta`, `ConnectomeWeights` |
| `simulator`       | `Simulator`, `rate`, `SimulationState`, `StepResult`      |
| `training`        | `fastTrain`, `onlineTrain`, `applyModel`, `FastTrainOptions`, `FastTrainResult` |
| `persist`         | `validateModel`, `cloneModel`, `freshModel`, `modelToJson`, `modelFromJson` |
| `createTrainer`   | `createTrainer`（默认导出）, `CreateTrainerOptions`, `Trainer` |

---

## 16. `fly-fetch` CLI — 下载 fixtures

`@chnak/fly` 包提供一个独立二进制 `fly-fetch`，用来从 GitHub raw 仓库下载 MaleCNS fixtures（脑连接组 + manifest + 预训练读出模型）。

### 16.1 安装后调用

```bash
# npx（推荐，无需全局安装）
npx fly-fetch

# 或全局安装后直接调
pnpm add -g @chnak/fly
fly-fetch

# 或仓库内（pnpm install 后）
pnpm cli
```

### 16.2 全部参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--to <dir>` | `./fixtures` | 目标目录（不存在则创建） |
| `--base <url>` | `https://raw.githubusercontent.com/chnak/fly/main/fixtures` | 镜像源 URL |
| `--check` | `false` | 只校验现有文件是否完整，不下载 |
| `--force` | `false` | 即使已存在也重新下载（跳过 skip） |
| `--yes` | `false` | 跳过交互式确认 |
| `--verbose` | `false` | 显示每个文件进度 + 详细日志 |
| `--help` | — | 打印帮助并退出 |

所有参数都可以组合。

### 16.3 常用场景

**首次下载**（生成 manifest + 全部 7 个 fixture）：

```bash
npx fly-fetch --to ./fixtures --yes
```

输出：

```
fly-fetch v0.1.0
target : ./fixtures
base   : https://raw.githubusercontent.com/chnak/fly/main/fixtures

Found manifest with 7 entries (55.25 MB total).
Need to download 7 file(s).

✔ brain.json             243 B
✔ meta.bin               335.2 KB
✔ readout.json           563 B
✔ readout.trial-and-error.json    526 B
✔ readout.trained.json   950 B
✔ weights.0.bin          40 MB
✔ weights.1.bin          17.59 MB

Done: 7 file(s) verified in 8.3s
```

**校验已有目录**（不下载任何东西，只查 sha256）：

```bash
npx fly-fetch --check
# 所有文件完整 → exit 0
# 缺文件 / sha256 不匹配 → exit 1
```

适合接入 CI：

```yaml
# GitHub Actions 示例
- run: npx fly-fetch --check
```

**强制重新下载**（文件存在但 sha256 不匹配、或你想刷新）：

```bash
npx fly-fetch --force
```

**换镜像源**（Gitee、自建、公司内网）：

```bash
npx fly-fetch --base https://gitee.com/chnak/fly/raw/main/fixtures
```

`--base` 必须指向一个目录，目录里要有 `checksums.json`（同结构 manifest）。CLI 会拉 `checksums.json`，后续所有文件都从这个 base 派生。

**详细进度**：

```bash
npx fly-fetch --verbose
# 会显示每个文件 HTTP 状态、字节数、sha256 中间值
```

### 16.4 它做什么 / 不做什么

**做**：

1. 拉 `<base>/checksums.json`，得到 7 个文件清单 + sha256 + size
2. 对目标目录预扫——已下载 + sha256 匹配的跳过
3. 顺序下载缺失 / 不匹配的文件（带 timeout + retry）
4. 写到 `<dest>/<filename>.partial`，下载完成 + sha256 校验通过后原子重命名为正式名
5. 总体进度 + 颜色化输出
6. 退出码：`0` 全部 OK / `1` 有错误 / `2` 参数错误

**不做**：

- ❌ 不会修改仓库外文件
- ❌ 不会运行 npm install / tsc
- ❌ 不会删除目标目录里不属于 manifest 的文件
- ❌ 不会验证文件**内容**（只校验 sha256）

### 16.5 退出码

| 码 | 含义 |
|----|------|
| `0` | 成功：所有文件已下载 / 已校验 / 无需操作 |
| `1` | 至少一个文件下载失败、sha256 不匹配、目录无法创建 |
| `2` | 参数解析错误（未知 flag、`--to` 路径是文件而非目录） |

### 16.6 完整文件清单

CLI 下载的 7 个文件全部在内（合计 **55.25 MB**）：

| 文件 | 大小 | 内容 |
|------|------|------|
| `brain.json` | 243 B | `BrainManifest`（神经元/突触数、文件清单、压缩误差） |
| `meta.bin` | 335.2 KB | gzipped FLYM 神经元元数据 |
| `readout.json` | 563 B | 默认空骨架读出模型（weights=0） |
| `readout.trial-and-error.json` | 526 B | 试错调参产物 |
| `readout.trained.json` | 950 B | §6 训练流程的典型输出（weights 已学到非零值） |
| `weights.0.bin` | 40 MB | gzip 权重流分段 1 |
| `weights.1.bin` | 17.59 MB | gzip 权重流分段 2 |

`weights.0.bin` + `weights.1.bin` 拼起来是单个 gzip 流 → 整体 gunzip 得到 62 MB 的 CSR 稀疏权重矩阵（详见 [§11](#11-connectome-文件格式与加载原理)）。

### 16.7 在 CI / Docker 里用

```dockerfile
# Dockerfile 示例
FROM node:20-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm && pnpm install --prod
# 首启动拉 fixtures，之后只校验
RUN npx fly-fetch --to ./fixtures --yes
COPY . .
CMD ["node", "dist/index.js"]
```

### 16.8 调试

```bash
# 网络有问题？开 verbose
npx fly-fetch --verbose --force

# 想换镜像？比如本地 nginx
npx fly-fetch --base http://localhost:8080/fixtures --verbose

# 只校验，不下载
npx fly-fetch --check --verbose
```

常见错误：

- **`ECONNREFUSED`**：base URL 不通，或本地 server 没起
- **`TimeoutError`**：网络太慢——可以加大 timeout（用 `--verbose` 看每文件耗时）
- **`sha256 mismatch`**：本地文件损坏——加 `--force` 重下

### 16.9 源码

- CLI 源码：`src/cli/fetch-fixtures.ts`（单文件 ~380 行，纯 Node ≥ 18 + `http`/`https` 模块，**零依赖**）
- manifest：`fixtures/checksums.json`（用 `scripts/gen-checksums.cjs` 重新生成）

---
    
    ---

---
    
    ---

## 17. 应用方向：自动交易

果蝇大脑可以当作**时间序列特征提取器**：LIF 仿真器把价格/成交量的原始输入转换成一组非线性脉冲序列（12 维 DN），logistic 读出层再把它们加权求和 → "现在该不该下单"的概率。**这与 Flappy Bird 是同一个机制，只是输入通道换了。**

### 17.1 核心思想

```
OHLCV K 线
  ↓ encodeCandle()         ←  类似 FlyEncoder.encode(state)
6 通道神经刺激
  ↓ simulator.stimulate()
1 步 LIF 仿真（166,700 神经元 / 1,300 万突触）
  ↓ simulator.step()
脉冲发放 + 12 维 DN 读出
  ↓ sampleFeatures()       ←  rate + EMA
12 维特征向量
  ↓ inferReadout()                 ←  sigmoid(w · z + b)
概率 p ∈ [0, 1]
  ↓ trainedFlapRequest()   ←  硬护栏
BUY / SELL / HOLD
```

**为什么用脑子，而不是直接 LSTM/Transformer？**

- **可解释**：12 个 DN 有明确语义（目标、迫近、逃避），权重可以直接看（"买盘响应"看哪个神经元贡献最大）
- **零训练成本**：连接组是**预训练好的**——166k 神经元 + 1.3 亿突触权重从 MaleCNS 直接拿来用，不需要 GPU 训练
- **6 通道 → 12 维特征的"非线性提纯"**：果蝇脑在视觉领域被进化调了几亿年，对"快速运动 / 迫近 / 上升下降"的特征提取已经有现成解
- **冷启动友好**：初始 weights=0 也可以先跑，logistic 慢慢学

### 17.2 概念映射：OHLCV → 神经刺激

| 通道       | 果蝇视觉语义                            | 交易语义                                       |
|------------|------------------------------------------|------------------------------------------------|
| `LC4`      | 全屏运动 / 接近感                       | 整体波动强度（振幅 / close）                   |
| `LPLC2`    | 迫近感                                  | 下影线 / 恐慌抛售                              |
| `LC10a L`  | 左视野运动（向后退 → 上升）              | 负收益 + 放量 → 可能反弹                       |
| `LC10a R`  | 右视野运动（向前推 → 下降）              | 正收益 + 放量 → 可能见顶                       |
| `upward`   | 上升运动                                | 价格动量为正                                   |
| `downward` | 下降运动                                | 价格动量为负                                   |

12 维 DN 读出 → 交易决策：

| DN 群          | 含义                            | 交易信号                                  |
|----------------|---------------------------------|-------------------------------------------|
| `TARGET_DN L`  | 瞄准左前方（推进中）            | 趋势确认 / 买入确认                       |
| `TARGET_DN R`  | 瞄准右前方（后退中）            | 趋势反转 / 卖出确认                       |
| `LOOM_DN L`    | 迫近左边（紧急）                | 急跌预警 → 立即止损                       |
| `LOOM_DN R`    | 迫近右边（紧急）                | 急涨预警 → 注意回调                       |
| `ESCAPE_DN L`  | 整体逃避（低置信）              | 风险信号 → 减仓                           |
| `ESCAPE_DN R`  | 整体逃避（高置信）              | 强烈风险 → 清仓                           |
| `DNae002`      | 单 DN                           | 附加信号                                  |
| `DNg111`       | 单 DN                           | 附加信号                                  |
| `DNp01`        | **最关键的逃避 DN**             | **最强行动信号**（FlyDecoder 也用它）     |

### 17.3 完整代码示例

> ⚠️ **API 提示**：`fastTrain()` 内部生成的是 Flappy `FlappyState`、调用 `teacher(state, features)`。交易场景的"输入不是鸟"必须绕过它，用 `onlineTrain()` 自己写训练循环（每根 K 线一步在线 SGD）。

```ts
// examples/09-crypto-trading.ts
import {
  createTrainer, inferReadout, onlineTrain,
  freshModel, modelToJson,
  type ReadoutModel
} from '@chnak/fly';
import { readFile, writeFile } from 'node:fs/promises';

interface Candle {
  open: number; high: number; low: number; close: number; volume: number;
}

// ---- 1. OHLCV → 6 通道神经 drive ----
// 注：simulator.stimulate() 接受 Partial<Record<string, number>>，
//     通道名是果蝇脑内部名（LC4_L 等），不是 NeuralStimulus 那个 camelCase 包装。
function encodeCandle(c: Candle, prev: Candle): Record<string, number> {
  const range  = c.high - c.low;
  const dnWick = Math.min(c.open, c.close) - c.low;
  const ret    = (c.close - prev.close) / Math.max(prev.close, 1e-9);
  const volChg = c.volume / Math.max(prev.volume, 1e-9);

  return {
    LC4_L:    Math.min(1, range  / Math.max(c.close, 1e-9) * 50),   // 波动强度
    LPLC2_L:  Math.min(1, dnWick / Math.max(range,  1e-9) * 3),    // 下影 / 恐慌
    LC10a_L:  Math.min(1, Math.max(0, -ret * 50 + (volChg - 1) * 0.3)),
    LC10a_R:  Math.min(1, Math.max(0,  ret * 50 + (volChg - 1) * 0.3)),
    upward:   ret > 0 ? Math.min(1,  ret * 30) : 0,
    downward: ret < 0 ? Math.min(1, -ret * 30) : 0,
  };
}

// ---- 2. 加载 fixtures + 创建训练器 ----
const manifest = JSON.parse(await readFile('./fixtures/brain.json', 'utf8'));
const trainer  = await createTrainer({
  metaPath:     './fixtures/meta.bin',
  weightsPaths: ['./fixtures/weights.0.bin', './fixtures/weights.1.bin'],
  manifest,
  seed: 42,
});

// ---- 3. 训练（online SGD，每根 K 线一步）----
// 真实场景里 candles 来自 gate_get_ohlcv_data / csv / binance 等
const candles: Candle[] = /* ... 1000 根 BTC/USDT 1h ... */ [];
let model: ReadoutModel = freshModel(trainer.features);

for (let i = 1; i < candles.length - 1; i++) {
  const drive = encodeCandle(candles[i], candles[i - 1]);
  // 标签：下根 K 线收涨 → 1，否则 0
  const label: 0 | 1 = candles[i + 1].close > candles[i].close ? 1 : 0;

  trainer.simulator.stimulate(drive);
  trainer.simulator.step();
  const { smoothed } = trainer.simulator.sampleFeatures();
  model = onlineTrain(trainer.simulator, model, smoothed, label).model;
}

// 保存训练好的读出
await writeFile('./fixtures/readout.btc.json', modelToJson(model));

// ---- 4. 推理：每根新 K 线决策 ----
function onCandle(c: Candle, prev: Candle) {
  trainer.simulator.stimulate(encodeCandle(c, prev));
  trainer.simulator.step();
  const { smoothed } = trainer.simulator.sampleFeatures();
  const p = inferReadout(smoothed, model);

  // trainedFlapRequest 的精神：只在强信号下出手，中间地带不动
  const decision: 'BUY' | 'SELL' | 'HOLD' =
    p >  model.threshold + 0.10 ? 'BUY'  :
    p <  model.threshold - 0.10 ? 'SELL' :
                                    'HOLD';
  return { p, decision };
}
```

完整可运行版（含合成 K 线、训练循环、推理 demo、输出保存）见 `examples/09-crypto-trading.ts`。

### 17.4 标签策略（label 函数）

`onlineTrain()` 接收 `(0 | 1)` 标签，标签怎么算完全自定义。常见模式：

| 策略                       | 标签计算                                       |
|----------------------------|------------------------------------------------|
| **下一根涨 → 买**          | `candles[i+1].close > candles[i].close ? 1 : 0` |
| **下一根突破 N% → 买**     | `(candles[i+1].close - candles[i].close) / candles[i].close > 0.005 ? 1 : 0` |
| **回撤 N% 后反弹 → 买**    | 在回撤序列里检测"已跌 5%+ 然后次日收涨"        |
| **多信号集成**             | `momentum > 0 && volumeZ > 1.5 && ret > 0 ? 1 : 0` |

> 跟 `fastTrain()` 的 `teacher(state, features)` 不同 — 这里的 label 是普通 JS 表达式，**不接收 FlappyState**。详见 [§9](#9-自定义教师) 了解 `defaultTeacher` 在 Flappy 场景下怎么用。

### 17.5 与 gate.io 现货交易集成

如果你已经在用 `gate-trading` 插件拉数据 + 下单，可以这样接线：

```ts
import { gate_get_ohlcv_data, gate_create_order } from 'gate-trading';

// 1. 拉 1000 根 1 小时 K 线
const candles = await gate_get_ohlcv_data({
  pair: 'BTC_USDT', interval: '1h', limit: 1000
});

// 2. 直接喂给 §17.3 的训练循环（candles 就是 Candle[]）
for (let i = 1; i < candles.length - 1; i++) {
  const drive  = encodeCandle(candles[i], candles[i - 1]);
  const label  = candles[i + 1].close > candles[i].close ? 1 : 0;
  trainer.simulator.stimulate(drive);
  trainer.simulator.step();
  const { smoothed } = trainer.simulator.sampleFeatures();
  model = onlineTrain(trainer.simulator, model, smoothed, label).model;
}

// 3. 实时推理：WebSocket 或轮询新 K 线
//    决策后调 gate_create_order({ pair, side: 'buy'|'sell', amount })
```

> 实盘下单涉及仓位管理、滑点、风控等复杂逻辑，**不建议直接照搬示例**。建议先用 paper trading / testnet 跑 3 个月以上（见 [§17.6](#176-风险提示)）。完整端到端（含下单）bot 计划在未来版本提供。

### 17.6 风险提示

⚠️ **这不是投资建议**。以下是这个框架的已知局限：

- **回测必须**：demo 先跑 1 年历史 K 线看夏普 / 最大回撤
- **滑点与手续费**：训练时 teacher 假设的是"理想成交价"，实盘要减点
- **过拟合**：120 epoch logistic 在 1000 根 K 线上容易记样本。**用验证集选 threshold**（§7.1 第 8 步已在做）
- **黑天鹅**：果蝇脑没有"2020-03-12"那种事件的概念 — teacher 没教过的模式它不会识别
- **不要直接接实盘**：先用 paper trading / testnet 跑 3 个月以上
- **仓位管理**：单笔不要超过 1-2% 本金，超过会被 LOOM_DN / ESCAPE_DN 的硬护栏拦下但可能太晚

**推荐起点**：先按 [§17.3](#173-完整代码示例) 的代码用 BTC/USDT 1h K 线 demo 跑一周，看 `p` 的分布和决策是否合理，再考虑接实盘。

### 17.7 与 §3 fixtures 的关系

`fly-fetch` CLI 拉的就是这个应用需要的脑：

```bash
# 拉 fixtures（脑连接组 + 预训练读出）
npx fly-fetch

# 然后直接用
pnpm example:crypto    # 或 node examples/09-crypto-trading.ts
```

### 17.8 下一步可选

| 你想…                                               | 看这里                                              |
|------------------------------------------------------|------------------------------------------------------|
| 调映射（OHLCV → 6 通道）                            | `examples/09-crypto-trading.ts` 的 `encodeCandle()`  |
| 调读出（12 DN → BUY/SELL）                          | `examples/09-crypto-trading.ts` 的 `onCandle()`      |
| 换市场（外汇 / 期货）                               | 把 `gate_get_ohlcv_data` 换成对应数据源              |
| 跑多品种（组合 50 个币的脑）                         | 多 `createTrainer` 实例 + 独立 `Simulator`          |
| 长期进化（脑 + 读出一起调）                         | `examples/06-evolve.ts`                              |
| 接实盘下单（gate.io / binance）                     | 在 §17.5 基础上加 `gate_create_order`，先 testnet    |

---## 许可证

MIT —— 见 [LICENSE](./LICENSE)。