// 示例 9 - 验证：trained 与多个 baseline 在同一组种子上的对比测试
    //
    // 在 N 个种子（1..N）上跑 4 个条件，输出对比表。
    // 用来验证训好的 readout 是否真的有效：
    //   - trained 应明显高于 untrained（freshModel）
    //   - always-flap / never-flap 是退化基线（两者都应接近 0）
    //
    // 用法：
    //   node --experimental-strip-types --no-warnings examples/09-verify.ts
    //   N_GAMES=100 node --experimental-strip-types --no-warnings examples/09-verify.ts
    
    import { readFile } from 'node:fs/promises';
    import { resolve, dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { createTrainer, modelFromJson, freshModel, inferReadout, trainedFlapRequest } from '../dist/index.js';
    import { SimpleFlappy } from './_evolve.ts';
    
    const here = dirname(fileURLToPath(import.meta.url));
    const fixturesDir = process.env.FIXTURES_DIR ?? resolve(here, '..', 'fixtures');
    const modelPath = resolve(fixturesDir, 'readout.trained.json');
    
    const N = Number(process.env.N_GAMES ?? 50);
    
    console.log('=== 示例 9：验证 trained vs 基线 ===\n');
    console.log(`每组条件跑 ${N} 局（使用同一组种子以保证公平）\n`);
    
    const manifest = JSON.parse(await readFile(resolve(fixturesDir, 'brain.json'), 'utf8'));
    const trainer = await createTrainer({
      metaPath: resolve(fixturesDir, 'meta.bin'),
      weightsPaths: [
        resolve(fixturesDir, 'weights.0.bin'),
        resolve(fixturesDir, 'weights.1.bin')
      ],
      manifest,
      seed: 1
    });
    
    const trained = await modelFromJson(await readFile(modelPath, 'utf8'));
    const untrained = freshModel(trainer.features);
    
    console.log(`已训模型: 权重前4位=[${trained.weights.slice(0, 4).map((x) => x.toFixed(2)).join(',')}]... 偏置=${trained.bias.toFixed(2)} 阈值=${trained.threshold.toFixed(2)}`);
    console.log(`未训模型: 权重前4位=[${untrained.weights.slice(0, 4).map((x) => x.toFixed(2)).join(',')}]... 偏置=${untrained.bias.toFixed(2)} 阈值=${untrained.threshold.toFixed(2)}`);
    console.log();
    
    const FRAME_DT = 1 / 60;
    const BRAIN_TICK = 0.02;
    
    // 跑一局游戏。`decide(状态, 特征) -> boolean` 返回 true 表示这一帧拍翅。
    function playOne(seed: number, decide: (state: any, smoothed: Float32Array) => boolean, maxFrames = 800) {
      const sim = trainer.simulator;
      sim.reset(seed);
      if (sim.state) {
        sim.state().trainingSamples = 1000;
        sim.state().trainingLoss = 0.693;
        sim.state().traces.fill(0);
      }
      const game = new SimpleFlappy(seed);
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
        if (decide(state, smoothed)) game.flap();
        frame++;
      }
      return game.score;
    }
    
    // 4 种决策策略（占位，下面会替换 trained/untrained）
    const policies = {
      trained:      (_state: any, _feat: Float32Array) => true && true, // 占位，下面替换
      untrained:    (_state: any, _feat: Float32Array) => false,        // 占位，下面替换
      'always-flap': (_state: any, _feat: Float32Array) => true,       // 每帧都拍（乱拍基线）
      'never-flap':  (_state: any, _feat: Float32Array) => false        // 一帧不拍（坠地基线）
    };
    
    // 用闭包构造真正的 trained/untrained 策略
    const trainedPolicy = (state: any, smoothed: Float32Array) => {
      const p = inferReadout(smoothed, trained);
      return trainedFlapRequest(state, p, trained.threshold);
    };
    const untrainedPolicy = (state: any, smoothed: Float32Array) => {
      const p = inferReadout(smoothed, untrained);
      return trainedFlapRequest(state, p, untrained.threshold);
    };
    
    const results: Record<string, { scores: number[]; avg: number; median: number; max: number; std: number; survived: number }> = {};
    
    for (const [name, _stub] of Object.entries(policies)) {
      const scores: number[] = [];
      for (let g = 1; g <= N; g++) {
        const decide = name === 'trained' ? trainedPolicy :
                       name === 'untrained' ? untrainedPolicy :
                       name === 'always-flap' ? (() => true) :
                       (() => false);
        const score = playOne(g, decide);
        scores.push(score);
      }
      const avg = scores.reduce((a, b) => a + b, 0) / N;
      const sorted = [...scores].sort((a, b) => a - b);
      const median = sorted[Math.floor(N / 2)];
      const max = sorted[sorted.length - 1];
      const variance = scores.reduce((a, b) => a + (b - avg) ** 2, 0) / N;
      const std = Math.sqrt(variance);
      const survived = scores.filter((s) => s >= 5).length; // 过到第 5 个管算"活下来"
      results[name] = { scores, avg, median, max, std, survived };
    }
    
    // 打印对比表
    console.log('  策略名称     | 均分 | 中位数 | 最大 | 标准差 | 存活(>=5管)');
    console.log('  -------------+------+--------+------+--------+----------');
    for (const name of ['trained', 'untrained', 'always-flap', 'never-flap']) {
      const r = results[name];
      const label =
        name === 'trained' ? '已训模型' :
        name === 'untrained' ? '未训模型' :
        name === 'always-flap' ? '乱拍基线' :
        '不拍基线';
      console.log(
        `  ${label.padEnd(11)} | ${r.avg.toFixed(2).padStart(4)} | ${String(r.median).padStart(6)} | ${String(r.max).padStart(4)} | ${r.std.toFixed(2).padStart(6)} | ${String(r.survived).padStart(3)}/${N}`
      );
    }
    console.log();
    
    // 自动判定
    const t = results.trained.avg;
    const u = results.untrained.avg;
    const lift = t - u;
    const liftPct = u > 0 ? (lift / u) * 100 : Infinity;
    console.log('=== 自动判定 ===');
    console.log(`已训模型均分: ${t.toFixed(2)}`);
    console.log(`未训模型均分: ${u.toFixed(2)}`);
    console.log(`绝对提升:    ${lift >= 0 ? '+' : ''}${lift.toFixed(2)} 个管子`);
    console.log(`相对提升:    ${liftPct === Infinity ? '无穷大' : liftPct.toFixed(0) + '%'}`);
    
    const baselineVerdict =
      results['always-flap'].avg < 0.5 && results['never-flap'].avg < 0.5
        ? '通过 (PASS)'
        : '失败 (基线没退化，请检查游戏/策略)';
    console.log(`退化基线正常？: ${baselineVerdict}  (乱拍=${results['always-flap'].avg.toFixed(2)}, 不拍=${results['never-flap'].avg.toFixed(2)})`);
    
    const trainedVerdict = t > u + 0.3 ? '通过 (PASS)' : '失败 (差距不够)';
    console.log(`已训 > 未训？: ${trainedVerdict}  (要求差距 > +0.3)`);
    console.log(`训练有效果？:   ${t > 0.5 ? '是 (YES)' : '否 (NO，信号太弱，盖不住重力)'}`);
    
    trainer.dispose();
    