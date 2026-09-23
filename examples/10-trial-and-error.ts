// 示例 10 - 试错学习：不依赖任何预训练模型，让鸟自己从零开始爬山。
    //
    // 思路（极简 hill climbing / 1+1-ES）：
    //   1. 起点：freshModel() 随机权重
    //   2. 每代：在当前权重上叠加一点点高斯噪声 -> 候选模型
    //   3. 用候选模型玩 K 局游戏，看平均分是否提升
    //   4. 提升 -> 接受（这就是"从经验里学到东西了"）
    //      没提升 -> 退回当前权重（保留经验）
    //   5. 持续若干代，权重逐渐收敛到能玩的形态
    //
    // 跟 07/09 的本质区别：
    //   - 07 用了 fastTrain + teacher（模仿教师，是监督学习）
    //   - 09 加载训好的模型做对照
    //   - 10 完全从 freshModel 起步，没有教师，没有标签，全靠"玩得更好就留"
    //
    // 用法：
    //   node --experimental-strip-types --no-warnings examples/10-trial-and-error.ts
    //   GENS=80 EVAL_GAMES=8 node --experimental-strip-types --no-warnings examples/10-trial-and-error.ts
    //   SAVE=1 node --experimental-strip-types --no-warnings examples/10-trial-and-error.ts
    
    import { readFile, writeFile } from 'node:fs/promises';
    import { resolve, dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import {
      createTrainer,
      freshModel,
      modelToJson,
      type ReadoutModel
    } from '../dist/index.js';
    import { evaluateModel } from './_evolve.ts';
    
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturesDir = process.env.FIXTURES_DIR ?? resolve(here, '..', 'fixtures');
    
    const GENS       = Number(process.env.GENS ?? 60);          // 总共尝试多少代
    const EVAL_GAMES = Number(process.env.EVAL_GAMES ?? 8);      // 每代玩几局评估
    const INIT_SIGMA = Number(process.env.SIGMA ?? 0.35);         // 初始扰动幅度（权重尺度）
    const DECAY      = Number(process.env.DECAY ?? 0.97);        // 每代 sigma 衰减（晚点细化）
    const SEED       = Number(process.env.SEED ?? 1);
    const SHOULD_SAVE = process.env.SAVE === '1';                 // 是否保存最终模型
    const SAVE_PATH  = process.env.SAVE_PATH
      ?? resolve(fixturesDir, 'readout.trial-and-error.json');
    
    console.log('=== 示例 10：纯试错学习（无预训练、无教师）===\n');
    console.log(`参数: GENS=${GENS}, 每代评估 ${EVAL_GAMES} 局, 初始噪声 ${INIT_SIGMA}, 衰减 ${DECAY}\n`);
    
    // 加载 fly-brain 模拟器（不加载任何 trained 模型）
    const manifest = JSON.parse(await readFile(resolve(fixturesDir, 'brain.json'), 'utf8'));
    const trainer = await createTrainer({
      metaPath: resolve(fixturesDir, 'meta.bin'),
      weightsPaths: [
        resolve(fixturesDir, 'weights.0.bin'),
        resolve(fixturesDir, 'weights.1.bin')
      ],
      manifest,
      seed: SEED
    });
    
    // 1) 起点：随机权重（这就是"没有任何经验的鸟"）
    let currentModel: ReadoutModel = freshModel(trainer.features);
    let currentEval = evaluateModel(trainer.simulator, currentModel, EVAL_GAMES);
    let currentAvg = currentEval.avg;
    let currentMax = currentEval.max;
    
    // 简单的确定性随机数生成器（每次跑实验一致）
    let rngState = (SEED * 2654435761) >>> 0 || 1;
    function rand() {
      rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
      return rngState / 4294967296;
    }
    // Box-Muller：高斯噪声
    function randn() {
      const u = Math.max(rand(), 1e-9);
      const v = rand();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    
    // 在当前权重上加噪声生成候选
    function mutate(m: ReadoutModel, sigma: number): ReadoutModel {
      return {
        weights: m.weights.map((w) => w + randn() * sigma),
        bias: m.bias + randn() * sigma * 0.3,         // 偏置用更小步长
        threshold: m.threshold,                         // 阈值不动，保持稳定
        features: m.features,
        mean: m.mean,
        scale: m.scale,
      };
    }
    
    // 打印表头
    console.log('  代  |  sigma  |  候选均分  |   当前均分  |  候选最大  |  决定');
    console.log('  ----+---------+-----------+-------------+----------+');
    
    // 主循环：每代 = 尝试一次扰动
    let acceptCount = 0;
    const history: Array<{ gen: number; sigma: number; candAvg: number; curAvg: number; candMax: number; accepted: boolean }> = [];
    
    for (let gen = 1; gen <= GENS; gen++) {
      const sigma = INIT_SIGMA * Math.pow(DECAY, gen - 1);
      const candidate = mutate(currentModel, sigma);
      const candEval = evaluateModel(trainer.simulator, candidate, EVAL_GAMES);
      const candAvg = candEval.avg;
      const candMax = candEval.max;
    
      const accepted = candAvg > currentAvg;
      const decision = accepted ? '接受 ✓ (学到东西)' : '退回 ✗ (没进步)';
    
      if (accepted) {
        currentModel = candidate;
        currentAvg = candAvg;
        currentMax = candEval.max;
        acceptCount++;
      }
    
      console.log(
        `  ${String(gen).padStart(3)} | ${sigma.toFixed(3).padStart(7)} | ${candAvg.toFixed(2).padStart(9)} | ${currentAvg.toFixed(2).padStart(11)} | ${String(candMax).padStart(8)} | ${decision}`
      );
    
      history.push({ gen, sigma, candAvg, curAvg: currentAvg, candMax, accepted });
    }
    
    // 打印最终结果
    console.log('\n=== 试错学习结果 ===');
    console.log(`接受次数: ${acceptCount} / ${GENS}  (接受率 ${((acceptCount / GENS) * 100).toFixed(0)}%)`);
    console.log(`最终均分: ${currentAvg.toFixed(2)}  (从 ${currentEval.avg.toFixed(2)} -> ${currentAvg.toFixed(2)})`);
    console.log(`最终最大: ${currentMax}`);
    
    // 跟"完全不学"对比
    const baseline = evaluateModel(trainer.simulator, freshModel(trainer.features), EVAL_GAMES);
    console.log(`\n对比全新随机模型: 均分 ${baseline.avg.toFixed(2)}  (本实验起点也是这个分布)`);
    console.log(`相对全新随机: ${currentAvg >= baseline.avg ? '+' : ''}${(currentAvg - baseline.avg).toFixed(2)} 个管子`);
    
    if (SHOULD_SAVE) {
          await writeFile(SAVE_PATH, modelToJson(currentModel), 'utf8');
      console.log(`\n已保存到: ${SAVE_PATH}`);
      console.log('下次跑 09-verify 时可设置 MODEL_PATH 指向这个文件来对比。');
    }
    
    trainer.dispose();
    