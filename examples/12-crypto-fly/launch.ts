#!/usr/bin/env node
// examples/12-crypto-fly/launch.ts
//
// Crypto Fly v3 — 果蝇大脑 + 1+1-ES Hill Climbing 在真实 Gate.io K 线上 paper trading
//
// 两种模式：
//
//   LIVE（默认）: 拉最近 N 根历史 K 线 + 实时 poll 新 K 线
//     launch.ts [port=4322] [pair=BTC_USDT] [interval=1h] [warmupCandles=1000] [warmupGens=200] [liveEvalEveryN=5]
//
//   BACKTEST: 拉一段历史区间，用 setImmediate 链快速遍历（每根 candle 都 step + paper trade）
//     launch.ts --backtest [since=YYYY-MM-DD|unixSec] [until=YYYY-MM-DD|unixSec]
//       - 不指定 since/until：默认最近 90 天
//       - 浏览器可通过 POST /api/backtest {since, until} 切换历史区间并重启 backtest
//
//   通用: --fast  跳过 200ms 节拍，用 setImmediate 链（live 模式也能用）
//
// 数据源：Gate.io 公共 API（无需 API key，单次最多 1000 根 / 总共最多 10000 根）
// 学习算法：1+1-ES Hill Climbing（跟 11-screen-fly 完全相同）
//
// 流程：
//   1. 加载果蝇脑（dist/ 中的 brain fixture）
//   2. 拉 K 线（live: warmupCandles / backtest: since→until 分页拉取）
//   3. brain warm-up（前 80 根让它进入稳态）
//   4. LIVE: warmupTrain（30 代预热）→ 启动实时 poll loop
//      BACKTEST: 立即遍历剩余 K 线（每 30 根评估 challenger）
//   5. HTTP server 提供 /api/state, /api/candles, /api/start, /api/pause, /api/reset, /api/backtest

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  createTrainer,
  freshModel,
  cloneModel,
  inferReadout,
  type ReadoutModel,
  type Trainer,
} from '../../dist/index.js';

const here     = dirname(fileURLToPath(import.meta.url));
const ROOT     = here;
const fixDir   = resolve(here, '..', '..', 'fixtures');

// ---------- 1. Gate.io 公共 K 线接口 ----------
interface Candle {
  ts: number; open: number; high: number; low: number; close: number; volume: number;
}

const INTERVAL_SEC: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
  '1d': 86400, '7d': 604800, '30d': 2592000,
};
function intervalToSec(s: string): number {
  return INTERVAL_SEC[s] ?? 3600;
}

// 拉最近 N 根（live 用）
async function fetchCandles(pair: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=${limit}`;
  console.log(`  GET ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gate.io HTTP ${res.status}: ${await res.text()}`);
  const raw: string[][] = await res.json();
  // [ts, vol_quote, close, high, low, open, vol_base, is_closed]
  const candles: Candle[] = raw.map(r => ({
    ts:     +r[0],
    open:   +r[5],
    high:   +r[3],
    low:    +r[4],
    close:  +r[2],
    volume: +r[6],
  })).sort((a, b) => a.ts - b.ts);
  if (candles.length === 0) throw new Error('gate.io returned empty array');
  return candles;
}

// 拉取指定日期范围（backtest 用，自动分页）
async function fetchCandlesRange(
  pair: string, interval: string, sinceSec: number, untilSec: number,
): Promise<Candle[]> {
  const intervalSec = intervalToSec(interval);
  const requested = Math.floor((untilSec - sinceSec) / intervalSec) + 1;
  if (requested > 10000) {
    throw new Error(
      `requested ${requested} candles exceeds Gate.io 10000-point limit ` +
      `(${(untilSec - sinceSec) / 86400 | 0} days @ ${interval}); ` +
      `narrow the date range or use a coarser interval`
    );
  }
  // Gate.io：单次请求返回 ≤ limit 根，且 (to-from) 不能超过 limit * intervalSec
  // 另外 Gate.io 实际返回的 ts 范围可能比请求小，最后一根可能落后 toPage 一个 interval 以上
  const maxPerReq = 1000;
  const chunkSec = maxPerReq * intervalSec;
  const all: Candle[] = [];
  let from = sinceSec;
  const to = untilSec;
  let page = 0;
  while (from < to) {
    const toPage = Math.min(to, from + chunkSec - intervalSec);
    const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=${maxPerReq}&from=${from}&to=${toPage}`;
    console.log(`  GET page ${++page} from=${from} to=${toPage} (${(toPage-from)/86400|0}d)`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`gate.io HTTP ${res.status}: ${await res.text()}`);
    const raw: string[][] = await res.json();
    if (raw.length === 0) break;
    // API returns DESC (newest first); [ts, vol_quote, close, high, low, open, vol_base, is_closed]
    const batch: Candle[] = raw.map(r => ({
      ts: +r[0], open: +r[5], high: +r[3], low: +r[4], close: +r[2], volume: +r[6],
    }));
    all.push(...batch);
    // 以 batch 最后一根的下一个 interval 作为下页起点
    const lastTs = batch[batch.length - 1].ts;
    if (batch.length < maxPerReq) break;            // 已经是最后一页（数据不够）
    if (lastTs + intervalSec >= to) break;          // 已经覆盖到目标时间
    from = lastTs + intervalSec;
  }
  // 用 ts 去重（防重叠），按 ts ASC 排序
  const seen = new Map<number, Candle>();
  for (const c of all) seen.set(c.ts, c);
  const out = Array.from(seen.values()).sort((a, b) => a.ts - b.ts);
  if (out.length === 0) throw new Error('gate.io returned empty array');
  console.log(`  deduped: ${all.length} → ${out.length} candles`);
  return out;
}

// ---------- 2. OHLCV → 6 通道神经驱动（跟 09 一致） ----------
function encode(c: Candle, prev: Candle): Record<string, number> {
  const range  = c.high - c.low;
  const dnWick = Math.min(c.open, c.close) - c.low;
  const ret    = (c.close - prev.close) / Math.max(prev.close, 1e-9);
  const volChg = c.volume / Math.max(prev.volume, 1e-9);
  return {
    LC4_L:    Math.min(1, range  / Math.max(c.close, 1e-9) * 50),
    LPLC2_L:  Math.min(1, dnWick / Math.max(range,  1e-9) * 3),
    LC10a_L:  Math.min(1, Math.max(0, -ret * 50 + (volChg - 1) * 0.3)),
    LC10a_R:  Math.min(1, Math.max(0,  ret * 50 + (volChg - 1) * 0.3)),
    upward:   ret > 0 ? Math.min(1,  ret * 30) : 0,
    downward: ret < 0 ? Math.min(1, -ret * 30) : 0,
  };
}

// ---------- 3. Brain state 快照 / 恢复 ----------
function snapshot(sim: Trainer['simulator']) {
  const s = sim.state();
  return {
    v:           new Float32Array(s.v),
    activity:    new Uint8Array(s.activity),
    rng:         s.rng,
    traces:      new Float32Array(s.traces),
    totalSpikes: s.totalSpikes,
  };
}
function restore(sim: Trainer['simulator'], snap: ReturnType<typeof snapshot>) {
  const s = sim.state();
  s.v.set(snap.v);
  s.activity.set(snap.activity);
  s.rng = snap.rng;
  s.traces.set(snap.traces);
  s.totalSpikes = snap.totalSpikes;
  s.drive.fill(0);
  s.current.fill(0);
  s.firedCount = 0;
}

// ---------- 4. 蝇脑交易训练器 ----------
class FlyCrypto {
  trainer: Trainer;
  candles: Candle[] = [];
  idx = 1;                          // 主循环当前位置（next candle to step）
  evLen = 30;                       // 评估窗口（根数）
  lastAcceptedScore = -Infinity;
  model:    ReadoutModel;
  challenger: ReadoutModel | null = null;
  gen = 0;
  sigma = 0.5;
  position = 0;
  entryPrice = 0;
  pnl = 0;                          // 主 P&L（paper trade 累计）
  warmupPnl = 0;
  bestPnl = -Infinity;
  accepts = 0;
  totalTries = 0;
  history: Array<{ gen: number; score: number; accepted: boolean; phase: 'warmup' | 'live' | 'backtest'; window: { start: number; end: number } }> = [];
  trades:   Array<{ ts: number; action: 'BUY'|'SELL'; price: number; profit?: number; idx: number }> = [];
  recentFeatures: number[] = Array(12).fill(0);
  recentDecision: 'BUY'|'SELL'|'HOLD' = 'HOLD';
  recentP = 0.5;
  running = false;
  phase: 'warmup' | 'live' | 'backtest' = 'warmup';
  liveCount = 0;
  liveCandlesSinceEval = 0;

  constructor(trainer: Trainer) {
    this.trainer = trainer;
    this.model = freshModel(trainer.features);
    for (let i = 0; i < this.model.weights.length; i++) {
      this.model.weights[i] += (Math.random() - 0.5) * 2 * 0.3;
    }
    this.model.bias += (Math.random() - 0.5) * 2 * 0.15;
    this.model.threshold = 0.5 + (Math.random() - 0.5) * 2 * 0.03;
  }

  loadCandles(candles: Candle[]) {
    this.candles = candles;
    this.idx = 1;
    this.liveCount = 0;
    this.liveCandlesSinceEval = 0;
    // brain warm-up：让脑状态稳定在最近的"市场状态"
    const warmup = Math.min(80, candles.length - 1);
    for (let i = 1; i <= warmup; i++) {
      this.trainer.simulator.stimulate(encode(this.candles[i], this.candles[i - 1]));
      this.trainer.simulator.step();
      this.trainer.simulator.sampleFeatures();
    }
    this.idx = 1;
  }

  reset() {
    this.idx = 1;
    this.liveCount = 0;
    this.liveCandlesSinceEval = 0;
    this.lastAcceptedScore = -Infinity;
    this.model = freshModel(this.trainer.features);
    for (let i = 0; i < this.model.weights.length; i++) {
      this.model.weights[i] += (Math.random() - 0.5) * 2 * 0.3;
    }
    this.model.bias += (Math.random() - 0.5) * 2 * 0.15;
    this.model.threshold = 0.5 + (Math.random() - 0.5) * 2 * 0.03;
    this.challenger = null;
    this.gen = 0;
    this.sigma = 0.5;
    this.position = 0;
    this.entryPrice = 0;
    this.pnl = 0;
    this.warmupPnl = 0;
    this.bestPnl = -Infinity;
    this.accepts = 0;
    this.totalTries = 0;
    this.history = [];
    this.trades = [];
    this.phase = 'warmup';
  }

  // 用某个 model 在一根 candle 上决策（无副作用到主循环的 brain）
  private decide(model: ReadoutModel, candle: Candle, prev: Candle) {
    this.trainer.simulator.stimulate(encode(candle, prev));
    this.trainer.simulator.step();
    const { smoothed } = this.trainer.simulator.sampleFeatures();
    const p = inferReadout(smoothed, model);
    const decision: 'BUY'|'SELL'|'HOLD' =
      p > model.threshold + 0.005 ? 'BUY'  :
      p < model.threshold - 0.005 ? 'SELL' :
                                    'HOLD';
    return { p, decision, smoothed: Array.from(smoothed) };
  }

  // ---------- 4a. 预热训练：用历史数据快速跑 N 代 ----------
  warmupTrain(gens: number) {
    this.phase = 'warmup';
    const windowSize = this.evLen;
    const baseStart = Math.max(1, this.candles.length - 1 - windowSize * 8);
    const t0 = Date.now();
    for (let g = 0; g < gens; g++) {
      const maxStart = this.candles.length - 1 - windowSize;
      const start = baseStart + Math.floor(Math.random() * (maxStart - baseStart));
      const end = start + windowSize;

      const snap = snapshot(this.trainer.simulator);
      const championPnl = this._simulatePnl(this.model, start, end);

      const curSigma = this.sigma * Math.pow(0.96, this.gen);
      if (this.challenger === null) {
        this.challenger = this._mutate(this.model, curSigma);
      }
      const challengerPnl = this._simulatePnl(this.challenger, start, end);

      const accepted = (this.challenger === null && g === 0) ||
                       (this.lastAcceptedScore === -Infinity) ||
                       (challengerPnl > this.lastAcceptedScore);
      if (accepted) {
        this.model = cloneModel(this.challenger);
        this.lastAcceptedScore = challengerPnl;
        this.accepts++;
      }
      this.totalTries++;
      this.gen++;
      this.history.push({ gen: this.gen, score: challengerPnl, accepted, phase: 'warmup', window: { start, end } });
      this.challenger = this._mutate(this.model, this.sigma * Math.pow(0.96, this.gen));
      restore(this.trainer.simulator, snap);
    }
    const dt = Date.now() - t0;
    console.log(`  warmupTrain: ${gens} gens in ${dt}ms (avg ${(dt / gens).toFixed(1)}ms/gen)`);
    this.warmupPnl = this.lastAcceptedScore === -Infinity ? 0 : this.lastAcceptedScore;
    this.phase = 'live';
  }

  // ---------- 4b. 主 step（跑一根 candle + paper trade） ----------
  stepOne(idx: number, phase: 'warmup' | 'live' | 'backtest') {
    if (idx < 1 || idx >= this.candles.length) return null;
    const candle = this.candles[idx];
    const prev   = this.candles[idx - 1];
    const { p, decision, smoothed } = this.decide(this.model, candle, prev);
    this.recentFeatures = smoothed;
    this.recentDecision = decision;
    this.recentP = p;

    if (decision === 'BUY' && this.position === 0) {
      this.position = 1;
      this.entryPrice = candle.close;
      this.trades.push({ ts: candle.ts, action: 'BUY', price: candle.close, idx });
    } else if (decision === 'SELL' && this.position === 1) {
      const profit = candle.close - this.entryPrice;
      this.pnl += profit;
      this.trades.push({ ts: candle.ts, action: 'SELL', price: candle.close, profit, idx });
      this.position = 0;
    }
    return { p, decision };
  }

  // ---------- 4c. challenger 评估（区间 P&L） ----------
  evaluateAt(start: number, end: number, phase: 'live' | 'backtest') {
    if (this.candles.length < 32) return null;
    this.totalTries++;
    const snap = snapshot(this.trainer.simulator);
    const curSigma = this.sigma * Math.pow(0.96, this.gen);
    if (this.challenger === null) {
      this.challenger = this._mutate(this.model, curSigma);
    }
    const challengerPnl = this._simulatePnl(this.challenger, start, end);
    const championPnl   = this._simulatePnl(this.model, start, end);

    const accepted = (this.lastAcceptedScore === -Infinity) ||
                     (challengerPnl > this.lastAcceptedScore);
    if (accepted) {
      this.model = cloneModel(this.challenger);
      this.lastAcceptedScore = challengerPnl;
      this.accepts++;
    }
    this.gen++;
    this.history.push({ gen: this.gen, score: challengerPnl, accepted, phase, window: { start, end } });
    this.challenger = this._mutate(this.model, this.sigma * Math.pow(0.96, this.gen));
    restore(this.trainer.simulator, snap);
    return { championPnl, challengerPnl, accepted, start, end };
  }

  // 在 [start, end) 区间跑某个 model 算 P&L（独立 brain 状态）
  private _simulatePnl(model: ReadoutModel, start: number, end: number): number {
    let pnl = 0;
    let position = 0;
    let entryPrice = 0;
    const warmupStart = Math.max(1, start - 30);
    for (let i = warmupStart; i < start; i++) {
      this.trainer.simulator.stimulate(encode(this.candles[i], this.candles[i - 1]));
      this.trainer.simulator.step();
      this.trainer.simulator.sampleFeatures();
    }
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      this.trainer.simulator.stimulate(encode(c, this.candles[i - 1]));
      this.trainer.simulator.step();
      const { smoothed } = this.trainer.simulator.sampleFeatures();
      const p = inferReadout(smoothed, model);
      const d =
        p > model.threshold + 0.05 ? 'BUY'  :
        p < model.threshold - 0.05 ? 'SELL' :
                                      'HOLD';
      if (d === 'BUY' && position === 0) {
        position = 1; entryPrice = c.close;
      } else if (d === 'SELL' && position === 1) {
        pnl += c.close - entryPrice;
        position = 0;
      }
    }
    if (position === 1) pnl += this.candles[end - 1].close - entryPrice;
    return pnl;
  }

  private _mutate(model: ReadoutModel, sigma: number): ReadoutModel {
    const m = cloneModel(model);
    for (let i = 0; i < m.weights.length; i++) {
      m.weights[i] += (Math.random() - 0.5) * 2 * sigma;
    }
    m.bias += (Math.random() - 0.5) * 2 * sigma * 0.4;
    m.threshold = Math.max(0.15, Math.min(0.85,
      m.threshold + (Math.random() - 0.5) * 2 * sigma * 0.15));
    return m;
  }
}

// ---------- 5. CLI 解析 ----------
type CliConfig =
  | { mode: 'live'; port: number; pair: string; interval: string; warmupCandles: number; warmupGens: number; liveEvalEveryN: number; isFast: boolean }
  | { mode: 'backtest'; port: number; pair: string; interval: string; sinceSec: number; untilSec: number; isFast: boolean };

function parseCliArgs(): CliConfig {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const positional = args.filter(a => !a.startsWith('--'));
  const isBacktest = flags.has('--backtest');
  const isFast     = flags.has('--fast') || isBacktest;
  const port       = parseInt(positional[0] || '4322', 10);
  const pair       = positional[1] || 'BTC_USDT';
  const interval   = positional[2] || '1h';
  const parseDate = (s: string | undefined): number => {
    if (!s) return 0;
    if (/^\d{10,}$/.test(s)) return +s;
    return Math.floor(new Date(s + 'T00:00:00Z').getTime() / 1000);
  };
  if (isBacktest) {
    const now = Math.floor(Date.now() / 1000);
    const sinceSec = parseDate(positional[3]) || (now - 90 * 86400);
    const untilSec = parseDate(positional[4]) || now;
    return { mode: 'backtest', port, pair, interval, sinceSec, untilSec, isFast };
  }
  return {
    mode: 'live',
    port, pair, interval,
    warmupCandles:  parseInt(positional[3] || '1000', 10),
    warmupGens:     parseInt(positional[4] || '200',  10),
    liveEvalEveryN: parseInt(positional[5] || '5',    10),
    isFast,
  };
}

const CLI = parseCliArgs();
const POLL_MS = parseInt(process.env.POLL_MS || '10000', 10);

// ---------- 6. 启动 ----------
const manifest = JSON.parse(
  await readFile(resolve(fixDir, 'brain.json'), 'utf-8'),
);
console.log(`brain: ${manifest.neurons.toLocaleString()} neurons, ${manifest.connections.toLocaleString()} connections`);

const trainer = await createTrainer({
  metaPath:     resolve(fixDir, 'meta.bin'),
  weightsPaths: [
    resolve(fixDir, 'weights.0.bin'),
    resolve(fixDir, 'weights.1.bin'),
  ],
  manifest,
  seed: 42,
});

const fly = new FlyCrypto(trainer);

// ---------- 6a. 拉 K 线 ----------
let initialCandles: Candle[];
if (CLI.mode === 'backtest') {
  console.log(`fetching ${CLI.pair} ${CLI.interval}  range=${new Date(CLI.sinceSec*1000).toISOString().slice(0,10)} → ${new Date(CLI.untilSec*1000).toISOString().slice(0,10)} ...`);
  initialCandles = await fetchCandlesRange(CLI.pair, CLI.interval, CLI.sinceSec, CLI.untilSec);
  const first = initialCandles[0], last = initialCandles[initialCandles.length - 1];
  console.log(`  loaded ${initialCandles.length} candles  (${((last.close/first.close - 1)*100).toFixed(2)}% over ${((last.ts - first.ts)/86400).toFixed(1)} days)`);
} else {
  console.log(`fetching ${CLI.warmupCandles} ${CLI.interval} K-lines (${CLI.pair}) from gate.io ...`);
  initialCandles = await fetchCandles(CLI.pair, CLI.interval, CLI.warmupCandles);
  const first = initialCandles[0], last = initialCandles[initialCandles.length - 1];
  console.log(`  loaded ${initialCandles.length} candles  (${((last.close/first.close - 1)*100).toFixed(2)}% over ${((last.ts - first.ts)/86400).toFixed(1)} days)`);
}
fly.loadCandles(initialCandles);
console.log('brain warm-up done.\n');

// ---------- 6b. 状态机 ----------
let backtestActive = false;
let backtestDone   = false;
let backtestStartedAt = 0;
let backtestFinishedAt = 0;
let backtestLastCount = 0;
let backtestCandlesPerSec = 0;
let backtestStartIdx = 0;
let livePollTimer: NodeJS.Timeout | null = null;
let backtestTimer: NodeJS.Timeout | null = null;
let backtestStoppedResolve: (() => void) | null = null;
let logTimer: NodeJS.Timeout | null = null;

// ---------- 6c. 主 step（live 模式下由 poll 触发；backtest 模式下由 setImmediate 链触发） ----------
async function backtestTick() {
  if (!backtestActive) return;
  if (fly.idx >= fly.candles.length - 1) {
    // 跑完了，强制平仓（如果还持仓）
    if (fly.position === 1) {
      const lastCandle = fly.candles[fly.candles.length - 1];
      const profit = lastCandle.close - fly.entryPrice;
      fly.pnl += profit;
      fly.trades.push({ ts: lastCandle.ts, action: 'SELL', price: lastCandle.close, profit, idx: fly.candles.length - 1, forced: true });
      fly.position = 0;
      console.log(`[backtest] FORCED close at end: pnl=$${profit.toFixed(0)} (cum=$${fly.pnl.toFixed(0)})`);
    }
    backtestActive = false;
    backtestDone = true;
    backtestFinishedAt = Date.now();
    fly.phase = 'live';
    const dt = (backtestFinishedAt - backtestStartedAt) / 1000;
    const dt2 = Math.max(0.001, dt);
    backtestCandlesPerSec = (fly.idx - backtestStartIdx) / dt2;
    console.log(`\n[backtest] DONE  candles=${fly.idx - backtestStartIdx}  gens=${fly.gen}  pnl=$${fly.pnl.toFixed(0)}  accept=${fly.accepts}/${fly.totalTries}  speed=${backtestCandlesPerSec.toFixed(0)} c/s  in ${dt.toFixed(1)}s`);
    if (backtestStoppedResolve) backtestStoppedResolve();
    return;
  }
  // 主循环：跑一根 candle + paper trade
  fly.stepOne(fly.idx, 'backtest');
  fly.idx++;
  // 每 evLen 根评估一次 challenger
  if (fly.idx > fly.evLen && fly.idx % fly.evLen === 0) {
    const start = fly.idx - fly.evLen;
    const end   = fly.idx;
    const r = fly.evaluateAt(start, end, 'backtest');
    if (r && (r.accepted || fly.gen % 10 === 0)) {
      console.log(`[backtest] gen=${fly.gen}  window=[${start},${end})  champ=$${r.championPnl.toFixed(0)}  chal=$${r.challengerPnl.toFixed(0)}  ${r.accepted ? '✓ACCEPT' : '✗reject'}  cumPnl=$${fly.pnl.toFixed(0)}`);
    }
  }
  // 让出 event loop
  if (CLI.isFast) {
    setImmediate(backtestTick);
  } else {
    setTimeout(backtestTick, 200);
  }
}
function startBacktest() {
  if (backtestActive) return;
  backtestActive = true;
  backtestDone = false;
  backtestStartedAt = Date.now();
  backtestStartIdx = fly.idx;
  fly.phase = 'backtest';
  // backtest 模式下：clip 负 baseline 到 0，避免算法卡在负 pnl
  // （live 模式保留原始语义，让 warmup 自身寻找正 baseline）
  if (fly.lastAcceptedScore !== -Infinity && fly.lastAcceptedScore < 0) {
    console.log(`[backtest] clip baseline ${fly.lastAcceptedScore.toFixed(0)} → 0 (avoid stuck on negative)`);
    fly.lastAcceptedScore = 0;
  }
  console.log(`[backtest] starting  candles=${fly.candles.length - fly.idx}  fast=${CLI.isFast}  evLen=${fly.evLen}`);
  if (CLI.isFast) setImmediate(backtestTick);
  else setTimeout(backtestTick, 200);
}
function stopBacktest(): Promise<void> {
  if (!backtestActive) return Promise.resolve();
  backtestActive = false;
  backtestStoppedResolve?.();
  backtestStoppedResolve = null;
  return Promise.resolve();
}

// ---------- 6d. 实时 poll loop（仅 live 模式） ----------
async function pollNewCandles() {
  if (CLI.mode !== 'live' || !fly.running) return;
  try {
    const latest = await fetchCandles(CLI.pair, CLI.interval, 5);
    let added = 0;
    for (const c of latest) {
      if (c.ts <= fly.candles[fly.candles.length - 1].ts) continue;
      fly.candles.push(c);
      const idx = fly.candles.length - 1;
      const r = fly.stepOne(idx, 'live');
      if (r) {
        added++;
        fly.liveCount++;
        fly.liveCandlesSinceEval++;
      }
    }
    if (added > 0 && fly.liveCandlesSinceEval >= CLI.liveEvalEveryN) {
      const end = fly.candles.length - 1;
      const start = Math.max(1, end - fly.evLen);
      const r = fly.evaluateAt(start, end, 'live');
      if (r) {
        console.log(`\n[live] eval gen=${fly.gen}  window=[${start},${end})  champ=$${r.championPnl.toFixed(0)}  chal=$${r.challengerPnl.toFixed(0)}  ${r.accepted ? '✓ACCEPT' : '✗reject'}  cumPnl=$${fly.pnl.toFixed(0)}`);
        fly.liveCandlesSinceEval = 0;
      }
    }
  } catch (e: any) {
    console.error(`[poll] error: ${e.message}`);
  }
}
function startPoll() {
  if (livePollTimer || CLI.mode !== 'live') return;
  livePollTimer = setInterval(pollNewCandles, POLL_MS);
  setTimeout(pollNewCandles, 2000);
  console.log(`[live] polling gate.io every ${POLL_MS}ms, evaluate every ${CLI.liveEvalEveryN} new candles`);
}
function stopPoll() {
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
}

// ---------- 6e. log timer ----------
function startLog() {
  if (logTimer) return;
  logTimer = setInterval(() => {
    if (!fly.running && CLI.mode === 'live' && !backtestActive) return;
    const phaseLabel = backtestActive ? `BACKTEST ${fly.idx}/${fly.candles.length}` : fly.phase;
    process.stdout.write(
      `\r[fly] ${phaseLabel}  pnl=${fly.pnl >= 0 ? '+' : ''}${fly.pnl.toFixed(0)}  gen=${fly.gen}  acc=${fly.accepts}/${fly.totalTries}  p=${fly.recentP.toFixed(2)} → ${fly.recentDecision}   `
    );
  }, 1000);
}
function stopLog() { if (logTimer) { clearInterval(logTimer); logTimer = null; } }

// ---------- 6f. 重新加载 backtest 区间 ----------
async function reloadBacktest(sinceSec: number, untilSec: number) {
  await stopBacktest();
  const newCandles = await fetchCandlesRange(CLI.pair, CLI.interval, sinceSec, untilSec);
  fly.reset();
  fly.loadCandles(newCandles);
  fly.running = true;
  startBacktest();
  return newCandles.length;
}

// ---------- 7. HTTP server ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
};

function readBody(req: any): Promise<string> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  const [path, qs] = url.split('?');

  if (path === '/api/state') {
    const st = {
      mode:             CLI.mode,
      pair:             CLI.pair,
      interval:         CLI.interval,
      running:          fly.running,
      phase:            fly.phase,
      candles:          fly.candles.length,
      idx:              fly.idx,
      liveCount:        fly.liveCount,
      liveCandlesSinceEval: fly.liveCandlesSinceEval,
      liveEvalEveryN:   CLI.mode === 'live' ? CLI.liveEvalEveryN : 0,
      pnl:              fly.pnl,
      warmupPnl:        fly.warmupPnl,
      bestPnl:          fly.bestPnl === -Infinity ? 0 : fly.bestPnl,
      gen:              fly.gen,
      sigma:            fly.sigma * Math.pow(0.96, fly.gen),
      accepts:          fly.accepts,
      totalTries:       fly.totalTries,
      position:         fly.position,
      entryPrice:       fly.entryPrice,
      lastNewCandleTs:  fly.candles[fly.candles.length - 1]?.ts ?? 0,
      history:          fly.history.slice(-100),
      trades:           fly.trades.slice(-20),
      recentP:          fly.recentP,
      recentDecision:   fly.recentDecision,
      features:         fly.recentFeatures,
      model: {
        bias: fly.model.bias,
        threshold: fly.model.threshold,
        weights: fly.model.weights,
      },
      backtest: {
        active:       backtestActive,
        done:         backtestDone,
        progress:     fly.candles.length > 0 ? fly.idx / fly.candles.length : 0,
        startedAt:    backtestStartedAt,
        finishedAt:   backtestFinishedAt,
        candlesPerSec: backtestCandlesPerSec,
        startIdx:     backtestStartIdx,
        speed:        CLI.isFast ? 'fast' : 'normal',
        range:        CLI.mode === 'backtest' ? {
          since: fly.candles[0]?.ts ?? 0,
          until: fly.candles[fly.candles.length - 1]?.ts ?? 0,
        } : null,
      },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(st));
    return;
  }
  if (path === '/api/candles') {
    const from = Math.max(0, fly.candles.length - 250);
    const slice = fly.candles.slice(from);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candles: slice, from, currentIdx: fly.candles.length - 1, pair: CLI.pair, interval: CLI.interval }));
    return;
  }
  if (path === '/api/start' && req.method === 'POST') {
    fly.running = true;
    if (CLI.mode === 'live') startPoll();
    res.writeHead(200); res.end('started'); return;
  }
  if (path === '/api/pause' && req.method === 'POST') {
    fly.running = false;
    if (CLI.mode === 'live') stopPoll();
    await stopBacktest();
    res.writeHead(200); res.end('paused'); return;
  }
  if (path === '/api/reset' && req.method === 'POST') {
    if (CLI.mode === 'live') {
      stopPoll();
      fly.reset();
      fly.loadCandles(initialCandles);
      if (CLI.warmupGens > 0) fly.warmupTrain(CLI.warmupGens);
      fly.running = true;
      startPoll();
    } else {
      await stopBacktest();
      fly.reset();
      fly.loadCandles(initialCandles);
      fly.running = true;
      startBacktest();
    }
    res.writeHead(200); res.end('reset'); return;
  }
  if (path === '/api/backtest' && req.method === 'POST') {
    if (CLI.mode !== 'backtest') {
      res.writeHead(400); res.end('not in backtest mode (launch with --backtest)'); return;
    }
    try {
      const body = await readBody(req);
      const cfg = body ? JSON.parse(body) : {};
      const parseDate = (s: string | undefined): number => {
        if (!s) return 0;
        if (/^\d{10,}$/.test(s)) return +s;
        return Math.floor(new Date(s + 'T00:00:00Z').getTime() / 1000);
      };
      const now = Math.floor(Date.now() / 1000);
      const sinceSec = parseDate(cfg.since) || (now - 90 * 86400);
      const untilSec = parseDate(cfg.until) || now;
      const n = await reloadBacktest(sinceSec, untilSec);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, candles: n, since: sinceSec, until: untilSec }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  if (path === '/api/backtest/stop' && req.method === 'POST') {
    await stopBacktest();
    res.writeHead(200); res.end('stopped'); return;
  }

  // ---- 静态文件 ----
  let filePath = path === '/' ? '/index.html' : path;
  const fp = join(ROOT, filePath);
  try {
    const body = await readFile(fp);
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

// ---------- 8. go ----------
fly.running = true;
startLog();
server.listen(CLI.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${CLI.port}/`;
  if (CLI.mode === 'backtest') {
    console.log(`\nfly-server: ${url}  [BACKTEST MODE  fast=${CLI.isFast}]`);
    console.log(`  pair=${CLI.pair}  interval=${CLI.interval}  range=${new Date(CLI.sinceSec*1000).toISOString().slice(0,10)} → ${new Date(CLI.untilSec*1000).toISOString().slice(0,10)}`);
    console.log(`  evaluate every ${fly.evLen} candles (Hill Climbing)`);
    console.log(`  POST /api/backtest {since, until}  切换历史区间并重启`);
    startBacktest();
  } else {
    console.log(`\nfly-server: ${url}  [LIVE MODE]`);
    console.log(`  pair=${CLI.pair}  interval=${CLI.interval}  warmup=${CLI.warmupCandles} candles × ${CLI.warmupGens} gens  fast=${CLI.isFast}`);
    console.log(`  live poll=${POLL_MS}ms  eval every ${CLI.liveEvalEveryN} new candles`);
    if (CLI.warmupGens > 0) {
      console.log(`\nwarmup training: ${CLI.warmupGens} generations on history...`);
      fly.warmupTrain(CLI.warmupGens);
      console.log(`  warmup done: best challenger P&L = $${fly.warmupPnl.toFixed(0)}, accept = ${fly.accepts}/${fly.totalTries}\n`);
    }
    startPoll();
  }
  console.log(`  ctrl+C to quit.\n`);

  const opener =
    process.platform === 'win32'  ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
                                    `xdg-open "${url}"`;
  spawn(opener, { shell: true, stdio: 'ignore', windowsHide: true });
});

process.on('SIGINT',  () => { backtestActive = false; stopPoll(); stopLog(); server.close(); process.exit(0); });
process.on('SIGTERM', () => { backtestActive = false; stopPoll(); stopLog(); server.close(); process.exit(0); });