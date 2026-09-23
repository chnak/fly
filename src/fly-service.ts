/**
 * src/fly-service.ts
 *
 * Fly Brain 后台学习交易服务 — 核心引擎
 *
 *  基于 @chnak/fly（果蝇大脑模拟器）+ 12-crypto-fly 的 1+1-ES Hill Climbing 算法
 *  从 Gate.io 公共 API 拉 K 线（实时），持续在后台学习 BUY/SELL/HOLD 决策。
 *
 *  特性：
 *   - 启动时 warmup：拉历史 N 根 K 线 → brain warm-up → N 代 Hill Climbing
 *   - 运行时：每 FLY_POLL_MS 轮询新 K 线 → step brain → 决策 → trade (paper)
 *   - 每 FLY_EVAL_EVERY_N 根新 K 线做一次 challenger 评估（sigma × 0.96^gen）
 *   - 模型快照持久化：每次 accept 后写盘（断电恢复）
 *   - 日志持久化：所有决策、accept/reject、P&L 都写到 FLY_LOG_FILE
 *
 *  用法：
 *   import { FlyService } from './fly-service';
 *   const svc = new FlyService({...config});
 *   await svc.init();
 *   svc.start();
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createTrainer, freshModel, cloneModel, inferReadout, modelFromJson, modelToJson } from '@chnak/fly';
import type { ReadoutModel } from '@chnak/fly';

// Trainer 类型从 createTrainer 的返回类型推断
type Trainer = Awaited<ReturnType<typeof createTrainer>>;

// ============ Types ============

export interface FlyConfig {
  port: number;             // HTTP 端口（仅作记录，不在这里 listen）
  pair: string;              // e.g. BTC_USDT
  interval: string;         // e.g. 1h
  warmupCandles: number;    // 初始拉取 K 线数
  warmupGens: number;       // 预热训练代数
  pollMs: number;           // 实时轮询间隔
  evalEveryN: number;       // 每 N 根新 K 线评估
  brainDir: string;         // fixtures 目录
  modelFile: string;        // 模型保存路径
  logFile: string;          // 日志文件路径
  evalLen: number;          // challenger 评估窗口
  sigmaInit: number;        // 初始噪声 sigma
  thresholdBuf: number;     // 决策阈值 buffer（±）
}

export interface Candle {
  ts: number; open: number; high: number; low: number; close: number; volume: number;
}

interface PersistedState {
  model: any;
  gen: number;
  sigma: number;
  accepts: number;
  totalTries: number;
  warmupPnl: number;
  lastAcceptedScore: number;
  lastCandleTs: number;
  updatedAt: number;
}

// ============ Gate.io 公共 K 线 API ============

const INTERVAL_SEC: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
  '1h': 3600, '2h': 7200, '4h': 14400, '6h': 21600, '12h': 43200,
  '1d': 86400, '7d': 604800, '30d': 2592000,
};

async function fetchCandles(pair: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gate.io HTTP ${res.status}: ${await res.text()}`);
  const raw = (await res.json()) as string[][];
  const candles: Candle[] = raw
    .map((r) => ({
      ts:     +r[0],
      open:   +r[5],
      high:   +r[3],
      low:    +r[4],
      close:  +r[2],
      volume: +r[6],
    }))
    .sort((a, b) => a.ts - b.ts);
  if (candles.length === 0) throw new Error('gate.io returned empty array');
  return candles;
}

// ============ OHLCV → 6 通道神经驱动 ============

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

// ============ Brain 快照/恢复 ============

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

// ============ FlyService 类 ============

export class FlyService {
  readonly config: FlyConfig;
  trainer!: Trainer;
  candles: Candle[] = [];
  idx = 1;
  model!: ReadoutModel;
  challenger: ReadoutModel | null = null;
  gen = 0;
  sigma = 0.5;
  position = 0;
  entryPrice = 0;
  pnl = 0;
  warmupPnl = 0;
  bestPnl = -Infinity;
  lastAcceptedScore = -Infinity;
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
  startedAt = 0;
  lastCandleTs = 0;

  private pollTimer: NodeJS.Timeout | null = null;
  private logTimer: NodeJS.Timeout | null = null;
  private persistQueued = false;

  constructor(config: FlyConfig) {
    this.config = config;
    this.sigma = config.sigmaInit;
  }

  async init(): Promise<void> {
    const manifestPath = resolve(this.config.brainDir, 'brain.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
    console.log(`[fly] brain: ${manifest.neurons.toLocaleString()} neurons, ${manifest.connections.toLocaleString()} connections`);

    this.trainer = await createTrainer({
      metaPath:     resolve(this.config.brainDir, 'meta.bin'),
      weightsPaths: [
        resolve(this.config.brainDir, 'weights.0.bin'),
        resolve(this.config.brainDir, 'weights.1.bin'),
      ],
      manifest,
      seed: 42,
    });

    const restored = await this.tryRestore();
    if (!restored) {
      this.model = freshModel(this.trainer.features);
      for (let i = 0; i < this.model.weights.length; i++) {
        this.model.weights[i] += (Math.random() - 0.5) * 2 * 0.3;
      }
      this.model.bias += (Math.random() - 0.5) * 2 * 0.15;
      this.model.threshold = 0.5 + (Math.random() - 0.5) * 2 * 0.03;
    }

    await mkdir(dirname(resolve(this.config.logFile)), { recursive: true });
    await this.writeLog('=== fly-service started ===');
    await this.writeLog(`config: ${JSON.stringify(this.config)}`);
    if (restored) {
      await this.writeLog(`restored model: gen=${this.gen} accepts=${this.accepts}/${this.totalTries}`);
    }
  }

  async loadInitialCandles(): Promise<void> {
    console.log(`[fly] fetching ${this.config.warmupCandles} ${this.config.interval} K-lines (${this.config.pair}) ...`);
    const candles = await fetchCandles(this.config.pair, this.config.interval, this.config.warmupCandles);
    const first = candles[0], last = candles[candles.length - 1];
    console.log(`[fly] loaded ${candles.length} candles  (${((last.close/first.close - 1)*100).toFixed(2)}% over ${((last.ts - first.ts)/86400).toFixed(1)} days)`);
    this.loadCandles(candles);
    this.lastCandleTs = candles[candles.length - 1].ts;
  }

  loadCandles(candles: Candle[]) {
    this.candles = candles;
    this.idx = 1;
    this.liveCount = 0;
    this.liveCandlesSinceEval = 0;
    const warmup = Math.min(80, candles.length - 1);
    for (let i = 1; i <= warmup; i++) {
      this.trainer.simulator.stimulate(encode(this.candles[i], this.candles[i - 1]));
      this.trainer.simulator.step();
      this.trainer.simulator.sampleFeatures();
    }
    this.idx = 1;
  }

  warmupTrain(gens: number): void {
    this.phase = 'warmup';
    const windowSize = this.config.evalLen;
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
    console.log(`[fly] warmupTrain: ${gens} gens in ${dt}ms (avg ${(dt/gens).toFixed(1)}ms/gen)`);
    this.warmupPnl = this.lastAcceptedScore === -Infinity ? 0 : this.lastAcceptedScore;
    this.phase = 'live';
  }

  private decide(model: ReadoutModel, candle: Candle, prev: Candle) {
    this.trainer.simulator.stimulate(encode(candle, prev));
    this.trainer.simulator.step();
    const { smoothed } = this.trainer.simulator.sampleFeatures();
    const p = inferReadout(smoothed, model);
    const buf = this.config.thresholdBuf;
    const decision: 'BUY'|'SELL'|'HOLD' =
      p > model.threshold + buf ? 'BUY'  :
      p < model.threshold - buf ? 'SELL' :
                                  'HOLD';
    return { p, decision, smoothed: Array.from(smoothed as Float32Array) as number[] };
  }

  stepOne(idx: number, phase: 'warmup' | 'live' | 'backtest' = 'live') {
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

  evaluateAt(start: number, end: number, phase: 'live' | 'backtest' = 'live') {
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
      this.queuePersist();
    }
    this.gen++;
    this.history.push({ gen: this.gen, score: challengerPnl, accepted, phase, window: { start, end } });
    this.challenger = this._mutate(this.model, this.sigma * Math.pow(0.96, this.gen));
    restore(this.trainer.simulator, snap);

    this.writeLog(`[eval ${phase}] gen=${this.gen} window=[${start},${end}) champ=$${championPnl.toFixed(2)} chal=$${challengerPnl.toFixed(2)} ${accepted ? '✓ACCEPT' : '✗reject'} sigma=${curSigma.toFixed(4)} cumPnl=$${this.pnl.toFixed(2)}`).catch(() => {});

    return { championPnl, challengerPnl, accepted, start, end };
  }

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
    const buf = Math.max(this.config.thresholdBuf, 0.05);
    for (let i = start; i < end; i++) {
      const c = this.candles[i];
      this.trainer.simulator.stimulate(encode(c, this.candles[i - 1]));
      this.trainer.simulator.step();
      const { smoothed } = this.trainer.simulator.sampleFeatures();
      const p = inferReadout(smoothed, model);
      const d =
        p > model.threshold + buf ? 'BUY'  :
        p < model.threshold - buf ? 'SELL' :
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

  private async pollOnce() {
    if (!this.running) return;
    try {
      const latest = await fetchCandles(this.config.pair, this.config.interval, 5);
      let added = 0;
      for (const c of latest) {
        if (c.ts <= this.candles[this.candles.length - 1].ts) continue;
        this.candles.push(c);
        const idx = this.candles.length - 1;
        const r = this.stepOne(idx, 'live');
        if (r) {
          added++;
          this.liveCount++;
          this.liveCandlesSinceEval++;
          await this.writeLog(`[live] ts=${new Date(c.ts * 1000).toISOString()} close=$${c.close} p=${r.p.toFixed(3)} -> ${r.decision} cumPnl=$${this.pnl.toFixed(2)}`);
        }
      }
      if (added > 0) {
        this.lastCandleTs = this.candles[this.candles.length - 1].ts;
        if (this.liveCandlesSinceEval >= this.config.evalEveryN) {
          const end = this.candles.length - 1;
          const start = Math.max(1, end - this.config.evalLen);
          const r = this.evaluateAt(start, end, 'live');
          if (r) {
            console.log(`[live] eval gen=${this.gen} window=[${start},${end}) champ=$${r.championPnl.toFixed(0)} chal=$${r.challengerPnl.toFixed(0)} ${r.accepted ? '✓ACCEPT' : '✗reject'} cumPnl=$${this.pnl.toFixed(0)}`);
            this.liveCandlesSinceEval = 0;
          }
        }
      }
    } catch (e: any) {
      console.error(`[poll] error: ${e.message}`);
      await this.writeLog(`[poll error] ${e.message}`).catch(() => {});
    }
  }

  private startPoll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollOnce(), this.config.pollMs);
    setTimeout(() => this.pollOnce(), 2000);
    console.log(`[fly] polling gate.io every ${this.config.pollMs}ms, evaluate every ${this.config.evalEveryN} new candles`);
  }
  private stopPoll() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private startLogTimer() {
    if (this.logTimer) return;
    this.logTimer = setInterval(() => {
      if (!this.running) return;
      process.stdout.write(
        `\r[fly] ${this.phase}  pnl=${this.pnl >= 0 ? '+' : ''}${this.pnl.toFixed(0)}  gen=${this.gen}  acc=${this.accepts}/${this.totalTries}  p=${this.recentP.toFixed(2)} -> ${this.recentDecision}   `
      );
    }, 1000);
  }
  private stopLogTimer() { if (this.logTimer) { clearInterval(this.logTimer); this.logTimer = null; } }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.startPoll();
    this.startLogTimer();
    console.log(`[fly] service started`);
  }

  pause() {
    this.running = false;
    this.stopPoll();
    console.log(`[fly] service paused`);
  }

  stop() {
    this.pause();
    this.stopLogTimer();
  }

  private queuePersist() {
    if (this.persistQueued) return;
    this.persistQueued = true;
    setTimeout(() => {
      this.persistQueued = false;
      this.persistNow().catch((e) => console.error('[persist] error:', e.message));
    }, 1000);
  }

  async persistNow(): Promise<void> {
    const data: PersistedState = {
      model: modelToJson(this.model),
      gen: this.gen,
      sigma: this.sigma,
      accepts: this.accepts,
      totalTries: this.totalTries,
      warmupPnl: this.warmupPnl,
      lastAcceptedScore: this.lastAcceptedScore === -Infinity ? 0 : this.lastAcceptedScore,
      lastCandleTs: this.lastCandleTs,
      updatedAt: Date.now(),
    };
    await mkdir(dirname(resolve(this.config.modelFile)), { recursive: true });
    await writeFile(resolve(this.config.modelFile), JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[fly] model persisted: gen=${this.gen} acc=${this.accepts}/${this.totalTries}`);
  }

  private async tryRestore(): Promise<boolean> {
    try {
      const raw = await readFile(resolve(this.config.modelFile), 'utf-8');
      const data: PersistedState = JSON.parse(raw);
      this.model = modelFromJson(data.model);
      this.gen = data.gen;
      this.sigma = data.sigma;
      this.accepts = data.accepts;
      this.totalTries = data.totalTries;
      this.warmupPnl = data.warmupPnl;
      this.lastAcceptedScore = data.lastAcceptedScore;
      this.lastCandleTs = data.lastCandleTs;
      console.log(`[fly] model restored: gen=${this.gen} acc=${this.accepts}/${this.totalTries}`);
      return true;
    } catch {
      return false;
    }
  }

  private async writeLog(line: string): Promise<void> {
    const ts = new Date().toISOString();
    const fullLine = `[${ts}] ${line}\n`;
    try {
      await appendFile(resolve(this.config.logFile), fullLine, 'utf-8');
    } catch {
      // 静默失败
    }
  }

  exportState() {
    return {
      config: this.config,
      running: this.running,
      phase: this.phase,
      candles: this.candles.length,
      idx: this.idx,
      liveCount: this.liveCount,
      liveCandlesSinceEval: this.liveCandlesSinceEval,
      pnl: this.pnl,
      warmupPnl: this.warmupPnl,
      bestPnl: this.bestPnl === -Infinity ? 0 : this.bestPnl,
      gen: this.gen,
      sigma: this.sigma * Math.pow(0.96, this.gen),
      accepts: this.accepts,
      totalTries: this.totalTries,
      position: this.position,
      entryPrice: this.entryPrice,
      lastNewCandleTs: this.lastCandleTs,
      lastNewCandleDate: this.lastCandleTs ? new Date(this.lastCandleTs * 1000).toISOString() : null,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      history: this.history.slice(-100),
      trades: this.trades.slice(-20),
      recentP: this.recentP,
      recentDecision: this.recentDecision,
      features: this.recentFeatures,
      model: {
        bias: this.model.bias,
        threshold: this.model.threshold,
        weights: Array.from(this.model.weights),
      },
    };
  }
}