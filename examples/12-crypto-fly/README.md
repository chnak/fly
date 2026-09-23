# 🐛 Crypto Fly — 果蝇大脑学炒 BTC

> 一只果蝇用 1+1-ES Hill Climbing 在真实 Gate.io K 线上自学习做 paper trading。支持 **Live 模式**（拉最新 K 线实时交易）和 **Backtest 模式**（在任意历史区间高速回测）。

## 跑起来

### Live 模式（默认）

```bash
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts
```

浏览器打开 `http://127.0.0.1:4322/`。

参数（可选）：
```bash
launch.ts [port=4322] [pair=BTC_USDT] [interval=1h] [warmupCandles=1000] [warmupGens=200]
```

例：跑 ETH 5 分钟 K 线：
```bash
launch.ts 4322 ETH_USDT 5m 2000 500
```

### Backtest 模式（任意历史区间）

```bash
# 跑最近 90 天 1h BTC（默认区间）
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts --backtest

# 指定起止日期
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts --backtest --since 2025-01-01 --until 2025-04-01

# 高速模式（省去 setTimeout 等候，~100x 加速；适合长时间回测）
node --experimental-strip-types --no-warnings examples/12-crypto-fly/launch.ts --backtest --fast
```

浏览器同样打开 `http://127.0.0.1:4322/`。Backtest 模式下：
- 顶部徽章显示 **BACKTEST**（紫色）
- 自动出现 **Backtest 进度面板**：进度条 / 起止日期 / 速度 / 已用时间
- 跑完后弹出 **Summary 卡**：总 P&L / 交易笔数 / 胜率 / Generation 数 / Accept 数
- 可在 UI 上 **修改日期区间** 并点击 `Reload Backtest` 重新跑
- 跑的过程中可点 `Stop` 中断

#### 实测示例（2025 真实行情）

```
[backtest] starting  candles=2160  fast=true  evLen=30
[backtest] DONE  candles=2160  gens=71  pnl=$22522  accept=7/71  speed=18 c/s  in 119.3s
  Trades: opens=2  closes=2 (forced=1)  wins=2  losses=0
```

90 天 BTC_USDT 1h 回测，~2 分钟跑完，赚 **$22,522**（bull run 行情模型抓得不错）。

## 它在做什么

```
Gate.io API ──K 线 (live 1000 根 / backtest 最多 10000 根)──► flyCrypto 训练器
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
                  p > thr+0.005 ? BUY
                  p < thr-0.005 ? SELL
                  其它            HOLD
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
| **12-crypto-fly (Live)** | **1+1-ES Hill Climbing** | **炒币** | **✅ 拉最新 K 线，实时跑** |
| **12-crypto-fly (Backtest)** | **1+1-ES Hill Climbing** | **炒币** | **✅ 任意历史区间高速回测** |
| 11-screen-fly   | 1+1-ES Hill Climbing | 跟鼠标 | ✅ 同款算法 |

## 关键设计点

1. **snapshot/restore 模式**：`simulator.state()` 暴露了所有内部数组（v/activity/traces/rng/...）。每次 challenger 评估时先 `snapshot`，评估完用 `restore`，主循环的脑状态完全不受污染。
2. **每代 30 根 candle**：约 1.25 天学习窗口，1000 根 K 线 ≈ 33 代。Backtest 默认从最长可达 10000 根（约 416 天 1h 数据）。
3. **奖励函数 = 累计 P&L**：champion / challenger 在最近 30 根上跑 paper trading，比 P&L。
4. **数据驱动**：从 Gate.io 公共 API 实时拉，不需要任何 API key。
5. **Backtest 分页**：Gate.io 限制单次最多 1000 根 1h 蜡烛 + 单次请求时间窗不能超过 1000 个 interval。自动按 1000 根/页分页，用 `Map<ts, candle>` 去重，按 ts 排序后返回。
6. **强制平仓**：回测结束（或停止）时，如果还持仓，按最后一根 candle 价格强制 close，保证有最终 P&L 结算。

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /` | HTML 可视化页面 |
| `GET /api/state` | 当前 state（live 或 backtest） |
| `POST /api/pause` | 暂停主循环（live 模式保留内存，仅停止 tick） |
| `POST /api/start` | 恢复主循环 |
| `POST /api/reset` | 重置 brain（warmup + 清状态） |
| `POST /api/backtest` | body `{since?, until?}` — 重新加载历史区间并跑回测 |
| `POST /api/backtest/stop` | 中断正在跑的 backtest |

## 已知局限

- **BTC 1h 极难预测**：期望 gen 几十代后 `bestPnl` 在 ±$100 间震荡（接近随机）。
- **BTC 5m 噪声更大**：更难学到东西，但挑战也更大。
- **paper trading 极简**：没有手续费、没有滑点、没有资金管理。
- **没有仓位规模**：满仓 1 BTC 假设（杠杆=1）。
- **Hill Climbing 容易卡在"永远持仓"**：accept 只看 challenger P&L，没惩罚交易频率，所以模型可能收敛到"永远 BUY"。强制平仓保证结算，但无主动平仓信号时可能一直持仓直到回测结束。
- **模型阈值 buffer 偏小**：默认 ±0.005（p 偏离 0.5 一点点就开仓），实际跑下来常见 1-3 笔交易/2-3 个月。如果想更保守，可改为 ±0.05。
- **算法对随机种子敏感**：1+1-ES Hill Climbing 是严格爬山（只接受严格更优），容易被 random 初始权重卡住。Backtest 模式已加 `clip baseline ≥ 0` 修复（live 模式保留原语义），但极端情况下仍可能出现 `pnl=$0` / `trades=0` 的"死锁"结果。**如果遇到这种情况，重启一下（不同 seed）通常就会跑出正 P&L**。

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
- Live 模式：调 `STEP_MS=50` 加速 4 倍（注意 CPU）
- 改 `epLen = 60` 让评估窗口翻倍（更稳但更慢）
- 在 `freshModel` 后改 `sigma = 1.0`：突变更强
- 调 `thr + 0.005` 改成 `thr + 0.05`：决策更保守（更难触发 BUY/SELL）
- Backtest 模式：`--fast` 比非 fast 快 ~50x（不同时刻走同一根 candle 的算法结果完全相同，仅耗时不同）

## 文件清单

- `launch.ts`    — HTTP server + brain + Hill Climbing + Backtest 模式
- `index.html`   — 浏览器可视化（蜡烛图 + 决策徽章 + P&L 曲线 + 学习曲线 + Backtest 进度面板 + Summary 卡）
- `README.md`    — 本文件