---
id: "mue7r74r-74fn7b"
layer: "project"
title: "fly-fetch CLI 完成"
tags: [cli, fly-fetch, fixtures, download, released]
strength: "1.000"
bornAt: 1790174632923
maturedAt: 1790174632923
bornFromSession: ""
source: "reflect"
refCount: 0
domain: "fly-project"
revision: 1
writtenBy: "self"
writtenByLabel: "self"
---

fly-fetch CLI 已发布：位置 src/cli/fetch-fixtures.ts → dist/cli/fetch-fixtures.js。

功能：
- --to <dir> 目标目录 (默认 ./fixtures)
- --check 仅校验不下载
- --force 强制重新下载
- --yes 跳过确认提示
- --base <url> 镜像源（默认 github.com/chnak/fly raw）
- --verbose 详细进度
- --help 帮助

下载内容：MaleCNS fixtures 7 files / 55.25 MB：
- brain.json (243 B)
- meta.bin (335.2 KB)
- readout.json (563 B)
- readout.trained.json (950 B)
- readout.trial-and-error.json (526 B)
- weights.0.bin (40 MB)
- weights.1.bin (17.59 MB)

manifest 文件：fixtures/checksums.json（包含 sha256 + size）。

完整流程：loadManifest → pre-scan → confirm → sequential download → sha256 verify → atomic rename (.partial → dest)。

测试覆盖：
- vitest: 22 unit tests pass
- scripts/e2e-cli.cjs: 6/6 scenarios (check-empty, full-download, sha256-verify, check-downloaded, skip-when-complete, force-redownload)

脚本工具：
- scripts/gen-checksums.cjs - fixtures 变更后重新生成 sha256
- scripts/e2e-cli.cjs - E2E 测试 CLI