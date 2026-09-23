---
planId: "plan_2026-09-23T14-36-实现-fly-fetch-cli-自动下载-fixtures-a66369"
title: "实现 fly-fetch CLI 自动下载 fixtures"
status: "in_progress"
totalSteps: 6
completedSteps: 3
failedSteps: 0
createdAt: "2026-09-23T14:36:11.015Z"
updatedAt: "2026-09-23T14:36:39.671Z"
---

# 实现 fly-fetch CLI 自动下载 fixtures

## 任务描述

(无)

## 计划步骤

- [x] 1. 生成 fixtures/checksums.json — 用 Node 计算 fixtures 下 7 个文件的 sha256 + size，写入 checksums.json
- [x] 2. 写 src/cli/fetch-fixtures.ts — 实现 CLI：参数解析、加载 manifest、下载、断点续传、sha256 校验、--check/--force/--to/--help
- [x] 3. 更新 package.json 加 bin 字段 — 在 package.json 添加 bin.fly-fetch 入口指向 dist/cli/fetch-fixtures.js
- [-] 4. 更新 tsconfig.json 包含 src/cli — 确保 src/cli/fetch-fixtures.ts 被 TypeScript 编译
- [ ] 5. 重新编译 + 单测 CLI 行为 — 编译后用 --help/--check 验证 CLI 工作正确
- [ ] 6. 发新版本 @chnak/fly@0.1.1 + 验证 — npm version patch + npm publish + 在 fly-test 安装测试 npx fly-fetch

## 执行日志

### Step 1 (尝试 1) - 2026-09-23T14:36:18.793Z - completed
- 工具: N/A
- 结果: "Wrote fixtures/checksums.json: 7 files, 55.25 MB total, all sha256 computed"
- 耗时: N/Ams

### Step 2 (尝试 1) - 2026-09-23T14:36:32.421Z - completed
- 工具: N/A
- 结果: "Wrote src/cli/fetch-fixtures.ts (~280 lines, ESM, 0 deps)"
- 耗时: N/Ams

### Step 3 (尝试 1) - 2026-09-23T14:36:39.671Z - completed
- 工具: N/A
- 结果: "Added bin.fly-fetch + engines + files; kept exports clean"
- 耗时: N/Ams
