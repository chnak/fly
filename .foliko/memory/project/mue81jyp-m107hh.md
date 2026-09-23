---
id: "mue81jyp-m107hh"
layer: "project"
title: "trade 项目（jev-gate-leverage-tracker）现状"
tags: [trade, jev-gate-leverage-tracker, gate-io, martingale, typescript, commonjs, jev-system-one]
strength: "1.000"
bornAt: 1790175116114
maturedAt: 1790175116114
bornFromSession: ""
source: "reflect"
refCount: 0
domain: "trade-project"
revision: 1
writtenBy: "self"
writtenByLabel: "self"
---

位置：D:\Date\20260808\trade（fly 项目同级 sibling）

技术栈：
- TypeScript strict + CommonJS（注意：与 fly 项目的 ESM 不同）
- 依赖：gate-api v7.2.144（位置参数 API）、@typesafe-ai/sdk v0.6.x、dotenv
- Node ≥ 18
- 没有 dist、没有 bin、没有测试、没有 README（只有 .env.example + Jev使用文档.md）

架构（10 个 src 文件）：
- index.ts (~350行) - 主循环：tick → 拉数据 → 检测触发 → Jev 决策（异步） → ExecutionEngine.execute
- config.ts - .env → StrategyConfig，含 num/str/bool/logLevel 强类型解析器
- types.ts - 数据契约：GatePosition/GateContractInfo/GateAccount/AddTriggerResult/ReduceTriggerResult/JevDecision/PositionState/RuntimeState/ExecContext/StrategyConfig/LoopEvent/LogLevel
- gate-client.ts - Gate.io SDK 封装：fetchContractInfo/fetchPosition(单+dual fallback)/fetchMarkPrice/fetchAccount/setLeverage/createOrder/marketBuy/marketSell/ping
- jev-decider.ts - Jev 包装器：choice(add/hold/reduce/exit) + noul(confidence) + noul(sizeDelta) + score(reasoning)
- execution-engine.ts - 阶梯式调杠杆：紧急止损 > 减仓触发 > 加仓触发（杠杆硬上限来自合约元数据，不写死）
- pnl-tracker.ts - 核心算法：computeFloatingPnLPct / computeTargetLeverage（阶梯式） / checkAddTrigger / checkReduceTrigger
- position-state.ts - 内存状态 + runtime-state.json 持久化（addCount/peak/phase）
- notifier.ts - 占位（仅控制台，可扩展 Telegram/Webhook）
- logger.ts - 自实现彩色日志（避免第三方依赖）

策略核心（阶梯式杠杆）：
- presetLeverage + currentSteps × leverageStep = targetLeverage
- currentSteps = floor(priceChangePct × leverage / stepSize)
- 含杠杆浮盈 5% → 加 1x 杠杆（默认）
- 含杠杆浮盈 ≤ 5% → 减回 presetLeverage
- 硬上限从合约元数据动态读（不再写死）
- 减仓公式不依赖 margin 字段（cross 模式可能为 0），用 size 比例推导
  newSize = currentSize × targetLev / currentLev

风控：
- 紧急止损（unrealisedPnl ≤ -EMERGENCY_LOSS_USDT）
- 硬上限违规（currentLev > contract.leverageMax）强制 reduce
- 单笔加仓 USDT 上限（MAX_ADD_USDT）
- 最小下单量检查
- 数量精度修正（orderSizeRound）
- 减仓 99% 防御性检查（防止全平 bug）

Jev 使用方式（注意用法细节）：
- 选择：add/hold/reduce/exit（必须包含兜底 exit）
- 置信度：noul 而非 choice.confidence（noul 值本身就是确定性度量）
- sizeDelta：noul 表达"加仓数量（正/负）"，0 表示 hold/reduce/exit
- reasoning：score 给推理详细度，1-5 等级
- 所有 state 字段必须转 Number() / String()（Jev 只要 JSON 基本类型）

启动流程：
1. 加载 .env → 校验 Gate/Jev Key
2. 测试网 vs 主网警告
3. 实例化 GateClient（basePath: api.gateio.ws / api-test.gateapi.io）
4. ping + 拉合约元数据 + 拉持仓（无持仓直接退出）
5. 启动对齐（setLeverage(presetLeverage) 可选）
6. 创建 ExecutionEngine + JevDecider
7. 主循环（每 5s）：并行拉 markPrice/position/account → 算浮盈 → 检测触发 → 异步 Jev（8s timeout） → execute → 更新状态

已知隐患：
- JEV_MIN_CONFIDENCE 在 config.ts 中定义了但 execution-engine.ts 没读它（异步 Jev 仅作日志参考，不阻塞）
- runtime-state.json 在 cwd（不是项目根），但用 process.cwd() 解析，重启时如果 cwd 变了会读不到
- LOOP_INTERVAL_MS = 5000 在测试网跑回测会太慢，测试用 1000ms
- async sleep(8000) 等 Jev 用的是 setTimeout 而不是 AbortController