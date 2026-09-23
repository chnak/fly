/**
 * src/fly-server.ts
 *
 * Fly Brain 后台学习交易服务 — HTTP 服务器入口
 *
 *  启动命令：
 *    npm run fly:fg       # 前台（适合调试）
 *    npm run fly:start    # 后台（守护进程）
 *
 *  HTTP API：
 *    GET  /              状态页面（HTML）
 *    GET  /api/state     当前学习状态（JSON）
 *    GET  /api/candles   最近 250 根 K 线（JSON）
 *    POST /api/start     启动主循环
 *    POST /api/pause     暂停主循环
 *    POST /api/reset     重置 brain，重新 warmup
 *    POST /api/persist   强制写盘模型
 *    GET  /api/health    健康检查
 */

// Minimal .env loader (no dotenv dependency)
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
try {
  const envPath = resolvePath(process.cwd(), '.env');
  const raw = readFileSync(envPath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
} catch {}
import { createServer } from 'node:http';
import { resolve, dirname, join, extname } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FlyService, type FlyConfig, type Candle } from './fly-service.ts';

// ============ 1. 加载 .env 配置 ============

function loadConfig(): FlyConfig {
  return {
    port:               parseInt(process.env.FLY_PORT || '4333', 10),
    pair:               process.env.FLY_PAIR || 'BTC_USDT',
    interval:           process.env.FLY_INTERVAL || '1h',
    warmupCandles:      parseInt(process.env.FLY_WARMUP_CANDLES || '1000', 10),
    warmupGens:         parseInt(process.env.FLY_WARMUP_GENS || '200', 10),
    pollMs:             parseInt(process.env.FLY_POLL_MS || '10000', 10),
    evalEveryN:         parseInt(process.env.FLY_EVAL_EVERY_N || '5', 10),
    brainDir:           process.env.FLY_BRAIN_DIR || resolvePath(__dirname, '..', 'fixtures'),
    modelFile:          resolve(process.cwd(), process.env.FLY_MODEL_FILE || './data/fly-model.json'),
    logFile:            resolve(process.cwd(), process.env.FLY_LOG_FILE || './data/fly.log'),
    evalLen:            parseInt(process.env.FLY_EVAL_LEN || '30', 10),
    sigmaInit:          parseFloat(process.env.FLY_SIGMA_INIT || '0.5'),
    thresholdBuf:       parseFloat(process.env.FLY_THRESHOLD_BUF || '0.005'),
  };
}

// ============ 2. 简单 HTML 状态页 ============

function htmlPage(svc: FlyService): string {
  const s = svc.exportState();
  const recentTrades = s.trades.map((t: any) => {
    const profit = t.profit !== undefined ? `$${t.profit.toFixed(2)}` : '';
    const color = t.action === 'BUY' ? '#22c55e' : '#ef4444';
    return `<span style="color:${color}">[${new Date(t.ts*1000).toISOString().slice(0,16)}] ${t.action} @$${t.price.toFixed(2)} ${profit}</span>`;
  }).join('<br>');

  const historyBars = s.history.slice(-60).map((h: any) => {
    const h_pct = Math.min(50, Math.abs(h.score) / 10);
    const color = h.accepted ? (h.score >= 0 ? '#22c55e' : '#f97316') : '#64748b';
    return `<div title="gen=${h.gen} score=${h.score.toFixed(2)} ${h.accepted?'✓':'✗'}" style="display:inline-block;width:6px;height:${Math.max(2, h_pct)}px;background:${color};margin-right:1px;vertical-align:bottom"></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Fly Brain · Gate.io 学习交易</title>
<meta http-equiv="refresh" content="5">
<style>
  body { font-family: 'SF Mono', Menlo, Consolas, monospace; background: #0a0e27; color: #e2e8f0; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { color: #38bdf8; margin: 0 0 8px; font-size: 24px; }
  .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .card { background: #1e293b; border-radius: 8px; padding: 16px; }
  .card-label { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .card-value { color: #f1f5f9; font-size: 22px; font-weight: 600; margin-top: 4px; }
  .pnl-pos { color: #22c55e; } .pnl-neg { color: #ef4444; }
  .section { background: #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .section h2 { color: #38bdf8; font-size: 14px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px; }
  .hist-bar { font-family: monospace; line-height: 100px; overflow: hidden; }
  .trades { font-size: 11px; color: #cbd5e1; max-height: 200px; overflow-y: auto; }
  .controls { display: flex; gap: 8px; margin-top: 8px; }
  .controls form { display: inline; }
  button { background: #334155; color: #f1f5f9; border: 0; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 13px; }
  button:hover { background: #475569; }
  button.danger { background: #991b1b; }
  button.danger:hover { background: #dc2626; }
  .kv { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
  .kv .k { color: #94a3b8; } .kv .v { color: #f1f5f9; }
</style>
</head>
<body>
<h1>🪰 Fly Brain · Gate.io Learning Trader</h1>
<div class="subtitle">基于 @chnak/fly 果蝇大脑 + 1+1-ES Hill Climbing 持续学习 BUY/SELL 决策 · 后台运行 · 端口 ${s.config.port}</div>

<div class="grid">
  <div class="card">
    <div class="card-label">运行状态</div>
    <div class="card-value">${s.running ? '🟢 运行中' : '⏸️ 已暂停'}</div>
  </div>
  <div class="card">
    <div class="card-label">当前阶段</div>
    <div class="card-value">${s.phase}</div>
  </div>
  <div class="card">
    <div class="card-label">累计 P&L (paper)</div>
    <div class="card-value ${s.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}</div>
  </div>
  <div class="card">
    <div class="card-label">持仓</div>
    <div class="card-value">${s.position === 1 ? 'LONG @ $' + s.entryPrice.toFixed(2) : '空仓'}</div>
  </div>
</div>

<div class="grid">
  <div class="card">
    <div class="card-label">Generation</div>
    <div class="card-value">${s.gen}</div>
  </div>
  <div class="card">
    <div class="card-label">接受率</div>
    <div class="card-value">${s.accepts}/${s.totalTries} (${s.totalTries > 0 ? ((s.accepts/s.totalTries)*100).toFixed(1) : '0.0'}%)</div>
  </div>
  <div class="card">
    <div class="card-label">当前 sigma</div>
    <div class="card-value">${s.sigma.toFixed(4)}</div>
  </div>
  <div class="card">
    <div class="card-label">最新 K 线</div>
    <div class="card-value" style="font-size:13px">${s.lastNewCandleDate ? s.lastNewCandleDate.replace('T',' ').slice(0,19) : '-'}</div>
  </div>
</div>

<div class="section">
  <h2>最近 60 代学习曲线 (绿=accept & P&L≥0 橙=accept & P&L<0 灰=reject)</h2>
  <div class="hist-bar">${historyBars}</div>
</div>

<div class="section">
  <h2>最近 20 笔交易</h2>
  <div class="trades">${recentTrades || '(无交易记录)'}</div>
</div>

<div class="section">
  <h2>配置</h2>
  <div class="kv"><span class="k">交易对 / 周期</span><span class="v">${s.config.pair} · ${s.config.interval}</span></div>
  <div class="kv"><span class="k">Brain dir</span><span class="v">${s.config.brainDir}</span></div>
  <div class="kv"><span class="k">Model file</span><span class="v">${s.config.modelFile}</span></div>
  <div class="kv"><span class="k">Log file</span><span class="v">${s.config.logFile}</span></div>
  <div class="kv"><span class="k">轮询间隔 / 评估频率</span><span class="v">${s.config.pollMs}ms / 每 ${s.config.evalEveryN} 根</span></div>
  <div class="kv"><span class="k">评估窗口 / sigma / 阈值 buffer</span><span class="v">${s.config.evalLen} 根 / ${s.config.sigmaInit} / ±${s.config.thresholdBuf}</span></div>
  <div class="kv"><span class="k">当前 P (raw)</span><span class="v">${s.recentP.toFixed(4)} (thr=${s.model.threshold.toFixed(4)})</span></div>
  <div class="kv"><span class="k">K 线总数</span><span class="v">${s.candles} (live新增=${s.liveCount})</span></div>
</div>

<div class="section">
  <h2>控制</h2>
  <div class="controls">
    <form method="POST" action="/api/start"><button>▶ 启动</button></form>
    <form method="POST" action="/api/pause"><button>⏸ 暂停</button></form>
    <form method="POST" action="/api/reset"><button class="danger">↻ 重置</button></form>
    <form method="POST" action="/api/persist"><button>💾 写盘</button></form>
  </div>
  <div style="color:#64748b;font-size:11px;margin-top:8px">页面每 5 秒自动刷新 · JSON API: GET /api/state · GET /api/candles</div>
</div>
</body></html>`;
}

// ============ 3. HTTP 路由 ============

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

async function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

async function main() {
  const config = loadConfig();
  console.log('============================================================');
  console.log('🪰 Fly Brain 学习交易服务启动中...');
  console.log('============================================================');
  console.log(JSON.stringify(config, null, 2));

  // 准备 data 目录
  await mkdir(dirname(config.modelFile), { recursive: true });
  await mkdir(dirname(config.logFile), { recursive: true });

  const svc = new FlyService(config);
  await svc.init();
  await svc.loadInitialCandles();

  if (config.warmupGens > 0 && !svc.gen) {
    console.log(`\n[warmup] training ${config.warmupGens} generations...`);
    svc.warmupTrain(config.warmupGens);
    console.log(`[warmup] done. best challenger P&L = $${svc.warmupPnl.toFixed(2)}, accept=${svc.accepts}/${svc.totalTries}\n`);
    await svc.persistNow();
  } else if (svc.gen > 0) {
    console.log(`[fly] skipping warmup (restored gen=${svc.gen})`);
  }

  svc.start();

  const server = createServer(async (req, res) => {
    try {
      const url = req.url || '/';
      const path = url.split('?')[0];

      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(htmlPage(svc));
        return;
      }
      if (path === '/api/state') {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify(svc.exportState()));
        return;
      }
      if (path === '/api/candles') {
        const from = Math.max(0, svc.candles.length - 250);
        const slice: Candle[] = svc.candles.slice(from);
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ candles: slice, from, currentIdx: svc.candles.length - 1, pair: svc.config.pair, interval: svc.config.interval }));
        return;
      }
      if (path === '/api/health') {
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: true, running: svc.running, uptimeMs: svc.startedAt ? Date.now() - svc.startedAt : 0 }));
        return;
      }
      if (path === '/api/start' && req.method === 'POST') {
        svc.start();
        res.writeHead(200); res.end('started'); return;
      }
      if (path === '/api/pause' && req.method === 'POST') {
        svc.pause();
        res.writeHead(200); res.end('paused'); return;
      }
      if (path === '/api/persist' && req.method === 'POST') {
        await svc.persistNow();
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: true })); return;
      }
      if (path === '/api/reset' && req.method === 'POST') {
        svc.pause();
        // 重新拉取 K 线 + warmup（保留 model 是为了让用户能继续训练）
        await svc.loadInitialCandles();
        if (config.warmupGens > 0) {
          svc.warmupTrain(config.warmupGens);
          await svc.persistNow();
        }
        svc.start();
        res.writeHead(200, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: true, message: 'reset done' })); return;
      }

      res.writeHead(404);
      res.end('not found');
    } catch (e: any) {
      console.error('[http] error:', e.message);
      res.writeHead(500, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  // 优雅退出
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[fly] received ${signal}, shutting down...`);
    svc.stop();
    await svc.persistNow().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  server.listen(config.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${config.port}/`;
    console.log(`\n✅ fly-server: ${url}`);
    console.log(`   GET  ${url}            状态页面`);
    console.log(`   GET  ${url}api/state   当前状态 JSON`);
    console.log(`   POST ${url}api/start   启动`);
    console.log(`   POST ${url}api/pause   暂停`);
    console.log(`   POST ${url}api/reset   重置`);
    console.log(`   POST ${url}api/persist 强制写盘`);
    console.log(`   模型文件：${svc.config.modelFile}`);
    console.log(`   日志文件：${svc.config.logFile}\n`);
  });
}

main().catch((e) => {
  console.error('[fly] fatal:', e.message);
  console.error(e.stack);
  process.exit(1);
});