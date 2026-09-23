---
id: "mue81jyu-6qdrur"
layer: "reference"
title: "CLI-first 模式：把 runtime 脚本升级为产品"
tags: [cli, testing, readme, productization, fly-fetch-pattern, trade]
strength: "1.000"
bornAt: 1790175116118
maturedAt: 1790175116118
bornFromSession: ""
source: "reflect"
refCount: 0
domain: "cross-project-pattern"
revision: 1
writtenBy: "self"
writtenByLabel: "self"
---

fly-fetch 成功后总结的"runtime 脚本 → 产品"升级模式（适用 trade 等长跑服务）：

1. **包结构升级**
   - 在 package.json 添加 `"type": "module"`（如适用）和 `"bin": { "name": "./dist/cli/main.js" }`
   - bin 入口必须用 `#!/usr/bin/env node` shebang
   - npm/pnpm publish 后用户可直接 `npx name` 跑

2. **CLI 命令拆分原则**
   - 不要只有一个 start，把子命令拆成：run / status / check / backtest / align
   - 每个子命令独立可测、可 dry-run
   - 共享 setup（loadConfig / connectGate / loadState）在 lib 层

3. **测试金字塔**
   - 单元（vitest）：纯算法（pnl-tracker, state 推导）— 用 mock 不打外网
   - 集成：mock 外部 SDK（gate-client fetch, jev-decider sdk）— 验证编排逻辑
   - E2E（child_process.spawn）：起真测试网 + 真 Jev 短跑（30s-60s），验证完整链路
   - 死锁陷阱：测试用 execFileSync 同步 spawn 会阻塞 event loop，server accept 不被处理 → 用 spawn 异步

4. **README 结构（跟 fly README 同模板）**
   - §1 是什么：定位 + 适用场景
   - §2 安装：含 npx 方式
   - §3 快速上手：最小可运行示例
   - §4 概念速览：核心数据结构 / 决策表
   - §5+ 进阶 / API 参考 / 故障排查
   - §N CLI 章节：所有参数 + 场景 + 退出码 + 调试
   - 文末：资源链接 + 许可证

5. **持久化策略**
   - 状态文件用 `process.cwd()` 还是 `__dirname`？→ 用 `__dirname` 保证路径稳定，cwd 不影响
   - 状态 schema 加 version 字段，未来迁移兼容
   - save/load 用 atomic write（writeFile + rename 临时文件）

6. **渐进式发布**
   - 阶段 1：CLI + 基础命令（run/status/check）
   - 阶段 2：单元测试覆盖纯算法
   - 阶段 3：E2E（mock + 真测试网）
   - 阶段 4：拆分库（@org/core + @org/integrations）— 只在必要时做，避免过度设计

7. **危险信号（避免早期过度工程）**
   - 不要先拆库再写测试
   - 不要加 metrics dashboard 再跑通 E2E
   - 不要支持多策略并行再 fix bug

跨项目经验：
- fly-fetch（无依赖的下载 CLI）→ 用 node:http + ts strict，零运行时依赖
- trade（长跑 trading bot）→ 必须有外部 SDK，需要 mock 测试层
- 两者 README 模板可共用（§N CLI 章节），但场景不同（下载 vs 运行）