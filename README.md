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

如果 `fixtures/` 目录缺失或损坏：

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

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。