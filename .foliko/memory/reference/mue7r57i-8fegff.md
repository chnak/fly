---
id: "mue7r57i-8fegff"
layer: "reference"
title: "Node.js HTTP client: avoid fetch(), use http.request"
tags: [nodejs, http, fetch, windows, bug, undici, debugging]
strength: "1.000"
bornAt: 1790174630430
maturedAt: 1790174630430
bornFromSession: ""
source: "reflect"
refCount: 0
domain: "nodejs-runtime"
revision: 1
writtenBy: "self"
writtenByLabel: "self"
---

在 Windows 上，Node 18+ 内置的全局 fetch()（基于 undici）在访问 127.0.0.1/localhost 时有 hang 风险。症状：调用 fetch() 后进程卡死，TCP connect 完全不发包，30s+ 无响应。

解决方案：直接用 node:http / node:https 模块的 request() API。这是 Node 长久以来最稳定的网络客户端，没有 undici 那层。

适用场景：CLI 工具、脚本、需要稳定 HTTP 客户端的项目。不要用全局 fetch() 在 Windows 环境生产关键路径。

相关陷阱：测试时不要用 execFileSync 同步 spawn 子进程做 HTTP client —— 父进程 event loop 被同步阻塞，server accept callback 不被处理，子进程 HTTP request hang。改用 child_process.spawn 异步。