# 🐛 Crypto Fly — 果蝇大脑学炒 BTC

> 一只果蝇用 1+1-ES Hill Climbing 在真实 Gate.io K 线上自学习做 paper trading。

## 跑起来

```bash
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts
```

浏览器会自动打开 `http://127.0.0.1:4322/`。

参数（可选）：
```bash
launch.ts [port=4322] [pair=BTC_USDT] [interval=1h] [limit=1000]
```

环境变量：
```bash
STEP_MS=100 launch.ts ...   # 加快节奏（默认 200ms/根 candle）
```

例如跑 ETH 5 分钟 K 线：
```bash
launch.ts 4322 ETH_USDT 5m 2000
```

## 它在做什么

```
Gate.io API ──1000 根 1h K 线──► flyCrypto 训练器
                                       │
                                       ▼
                    OHLCV → 6 通道神经驱动 (LC4/LPLC2/LC10a L/R)
                                       │
                                       ▼
                  FlyBrain.step() ──► 12 维 DN 神经元活动
                                       │
                                       ▼
                    sigmoid(weights·features + bias) → p
                                       │
                                       ▼
                  p > thr+0.10 ? BUY
                  p < thr-0.10 ? SELL
                  其它          HOLD
                                       │
                                       ▼
                       paper trade: BUY 满仓，SELL 平仓
                                       │
                  每 30 根 candle ───► Hill Climbing 评估
                                       │
                  challenger = champion + N(0, σ) 噪声
                  评估窗口 P&L 比较：接受 / 拒绝
                  σ = 0.5 × 0.96^gen  ──► 越学越精细
```

## 跟之前示例的差异

| 示例 | 算法 | 任务 | 备注 |
|------|------|------|------|
| 09-trading-fly | onlineTrain (SGD) | 炒币 | ❌ SGD 太脆，gen~1 后 brain 死锁 |
| **12-crypto-fly** | **1+1-ES Hill Climbing** | **炒币** | **✅ 不依赖梯度，更稳** |
| 11-screen-fly   | 1+1-ES Hill Climbing | 跟鼠标 | ✅ 同款算法 |

## 关键设计点

1. **snapshot/restore 模式**：`simulator.state()` 暴露了所有内部数组（v/activity/traces/rng/...）。每次 challenger 评估时先 `snapshot`，评估完用 `restore`，主循环的脑状态完全不受污染。
2. **每代 30 根 candle**：约 1.25 天学习窗口，1000 根 K 线 ≈ 33 代。
3. **奖励函数 = 累计 P&L**：champion / challenger 在最近 30 根上跑 paper trading，比 P&L。
4. **数据驱动**：从 Gate.io 公共 API 实时拉，不需要任何 API key。

## 已知局限

- **BTC 1h 极难预测**：期望 gen 几十代后 `bestPnl` 在 ±$100 间震荡（接近随机）。
- **BTC 5m 噪声更大**：更难学到东西，但挑战也更大。
- **paper trading 极简**：没有手续费、没有滑点、没有资金管理。
- **没有仓位规模**：满仓 1 BTC 假设（杠杆=1）。

## 学习预期曲线

```
bestPnl ↑
   +200 ┤                              ╭─╮
   +100 ┤                          ╭──╯ ╰─╮
      0 ┤────────────╮  ╭─╮   ╭────╯      ╰─╮
   -100 ┤       ╭────╯  ╰─╯╭──╯              ╰─╮
   -200 ┤   ╭───╯            ╰────────────────╯
        └────────────────────────────────────────► gen
        0    5    10   15   20   25   30   35
```

理论上：前期 σ 大 → 大胆突变 → 快速找到不亏钱的策略；后期 σ 小 → 精细调整 → 慢慢盈利。**但 BTC 不是这种函数**，所以期望曲线会比较平。

## 调试技巧

- 浏览器控制台 → 看每根 candle 后的 12 维 features 是否都 < 1
- 调 `STEP_MS=50` 加速 4 倍（注意 CPU）
- 改 `epLen = 60` 让评估窗口翻倍（更稳但更慢）
- 在 `freshModel` 后改 `sigma = 1.0`：突变更强
- 调 `thr + 0.10` 改成 `thr + 0.20`：决策更保守（更难触发 BUY/SELL）

## 文件清单

- `launch.ts`    — HTTP server + brain + Hill Climbing
- `index.html`   — 浏览器可视化（蜡烛图 + 决策徽章 + P&L 曲线 + 学习曲线）
- `README.md`    — 本文件