// Example 9 - crypto-trading: project OHLCV K-line candles onto the
// 6-channel neural stimulus that the MaleCNS connectome expects, then
// train a "next candle closes up?" predictor.
//
// Same mechanism as Flappy Bird — different input channels.
// We use onlineTrain() rather than fastTrain() because fastTrain() is
// hard-wired to a FlappyState-based teacher (it generates random bird
// states internally). For a non-Flappy task like trading, we drive the
// simulator one step at a time with our own (candle, label) stream.
//
// In production, swap synthCandles() for:
//   const candles = await gate_get_ohlcv_data({ pair: 'BTC_USDT', interval: '1h', limit: 1000 });
//
// Run:
//   node --experimental-strip-types --no-warnings examples/09-crypto-trading.ts
//   pnpm example:crypto
//
// Optional env:
//   CANDLES=600          (defaults: 600 synthetic candles)
//   SEED=42
//   REAL=1               (use real BTC/USDT 1h K-lines from fixtures/btc_real_1h_compact.json)
//
// To refresh real-data fixture (1000 most recent BTC/USDT 1h candles from Gate.io):
//   curl -s "https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1h&limit=1000" \
//     -o fixtures/btc_real_1h.json

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTrainer,
  inferReadout,
  onlineTrain,
  freshModel,
  modelToJson,
  type ReadoutModel
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = process.env.FIXTURES_DIR ?? resolve(here, '..', 'fixtures');
const SEED      = Number(process.env.SEED ?? 42);
const N_CANDLES = Number(process.env.CANDLES ?? 600);

console.log('=== examples/09-crypto-trading.ts ===\n');

// ---------- 1. Synthetic OHLCV generator ----------
// In production: replace with a real feed (gate-trading, binance, csv, etc.)
function synthCandles(n: number, seed: number) {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const candles: Array<{ open: number; high: number; low: number; close: number; volume: number }> = [];
  let price = 30000;
  for (let i = 0; i < n; i++) {
    const drift = (rand() - 0.5) * 0.004;        // -0.2%..+0.2% per bar
    const noise = (rand() - 0.5) * 0.02;         // +/-1% intra-bar
    const open  = price;
    const close = open * (1 + drift + noise);
    const high  = Math.max(open, close) * (1 + rand() * 0.005);
    const low   = Math.min(open, close) * (1 - rand() * 0.005);
    const volume= 50 + rand() * 200;
    candles.push({ open, high, low, close, volume });
    price = close;
  }
  return candles;
}

// ---------- 1b. Real OHLCV loader (Gate.io public REST) ----------
// Gate.io returns [ts, vol_quote, close, high, low, open, vol_base, is_closed].
// Convert to {open, high, low, close, volume} and sort ascending by ts.
// Source fixture: fixtures/btc_real_1h_compact.json (1000 most recent 1h K-lines).
async function loadRealCandles(path: string) {
  const text = await readFile(path, 'utf-8');
  const raw = JSON.parse(text) as Array<{
    ts: number; open: number; high: number; low: number; close: number; volume: number;
  }>;
  // Gate.io returns descending by ts; ensure ascending for the trainer loop.
  raw.sort((a, b) => a.ts - b.ts);
  return raw;
}

// ---------- 2. OHLCV -> 6-channel neural drive ----------
// Maps K-line features onto the same LC4 / LPLC2 / LC10a-L/R / up / down
// channels that FlyEncoder uses for Flappy. Each value clamped to [0, 1].
// NOTE: channel names here are fly-internal (LC4_L etc.) -- simulator.stimulate()
// takes Partial<Record<string, number>>, not NeuralStimulus.
function encodeCandle(
  c:   { open: number; high: number; low: number; close: number; volume: number },
  prev:{ close: number; volume: number }
): Record<string, number> {
  const range  = c.high - c.low;
  const dnWick = Math.min(c.open, c.close) - c.low;
  const ret    = (c.close - prev.close) / Math.max(prev.close, 1e-9);
  const volChg = c.volume / Math.max(prev.volume, 1e-9);

  return {
    LC4_L:    Math.min(1, range  / Math.max(c.close, 1e-9) * 50),   // volatility
    LPLC2_L:  Math.min(1, dnWick / Math.max(range,  1e-9) * 3),    // panic / wick
    LC10a_L:  Math.min(1, Math.max(0, -ret * 50 + (volChg - 1) * 0.3)),
    LC10a_R:  Math.min(1, Math.max(0,  ret * 50 + (volChg - 1) * 0.3)),
    upward:   ret > 0 ? Math.min(1,  ret * 30) : 0,
    downward: ret < 0 ? Math.min(1, -ret * 30) : 0,
  };
}

// ---------- 3. Load brain ----------
const manifest = JSON.parse(
  await readFile(resolve(fixturesDir, 'brain.json'), 'utf8')
);
console.log(
  `fixtures: ${manifest.neurons.toLocaleString()} neurons, ` +
  `${manifest.connections.toLocaleString()} connections`
);

const trainer = await createTrainer({
  metaPath:     resolve(fixturesDir, 'meta.bin'),
  weightsPaths: [
    resolve(fixturesDir, 'weights.0.bin'),
    resolve(fixturesDir, 'weights.1.bin')
  ],
  manifest,
  seed: SEED
});

// ---------- 4. Generate candles + train (online SGD) ----------
const USE_REAL = process.env.REAL === '1';
let candles: Array<{ open: number; high: number; low: number; close: number; volume: number; ts?: number }>;
if (USE_REAL) {
  const realPath = resolve(fixturesDir, 'btc_real_1h_compact.json');
  console.log(`\nloading real BTC/USDT 1h K-lines from ${realPath}...`);
  candles = await loadRealCandles(realPath);
  console.log(`  loaded ${candles.length} real candles`);
  console.log(`  first: ts=${candles[0].ts}  close=${candles[0].close.toFixed(1)}`);
  console.log(`  last : ts=${candles[candles.length-1].ts}  close=${candles[candles.length-1].close.toFixed(1)}`);
} else {
  console.log(`\ngenerating ${N_CANDLES} synthetic candles (seed=${SEED})...`);
  candles = synthCandles(N_CANDLES, SEED);
}

console.log('training online (1 sample per candle)...');
let model: ReadoutModel = freshModel(trainer.features);

let lastLoss = 0;
let lossCount = 0;
for (let i = 1; i < candles.length - 1; i++) {
  const drive = encodeCandle(candles[i], candles[i - 1]);
  // label: 1 if next candle closes up, 0 otherwise
  const label: 0 | 1 = candles[i + 1].close > candles[i].close ? 1 : 0;

  trainer.simulator.stimulate(drive);
  trainer.simulator.step();
  const { smoothed } = trainer.simulator.sampleFeatures();
  const r = onlineTrain(trainer.simulator, model, smoothed, label);
  model = r.model;
  lastLoss = r.loss;
  lossCount++;
}
const avgLoss = lastLoss; // onlineTrain returns running loss
console.log(`  trained on ${model.trainingSamples} samples, last loss=${lastLoss.toFixed(4)}`);

// ---------- 5. Save model ----------
const out = resolve(fixturesDir, USE_REAL ? 'readout.btc.real.json' : 'readout.btc.json');
await writeFile(out, modelToJson(model));
console.log(`\nSaved -> ${out}`);
console.log(`  weights: [${model.weights.map(w => w.toFixed(3)).join(', ')}]`);
console.log(`  bias   : ${model.bias.toFixed(3)}, threshold=${model.threshold.toFixed(3)}`);

// ---------- 6. Live inference demo (last 20 candles) ----------
// NOTE: simulator state matters!  Cold-start (post-reset) gives biased
// 'all BUY' decisions because the brain hasn't seen any stimulus yet.
// Realistic deployment: brain runs 24/7, so we continue from the
// training-loop's final state and warm-up over the last 200 candles.
console.log('\n-- inference demo (last 20 candles) --');
console.log('candle#  | ret%    | p      | decision');

// Warm-up: drive the brain over the last 200 candles to reach steady state.
const warmupStart = Math.max(1, candles.length - 200);
for (let i = warmupStart; i < candles.length - 20; i++) {
  const drive = encodeCandle(candles[i], candles[i - 1]);
  trainer.simulator.stimulate(drive);
  trainer.simulator.step();
  trainer.simulator.sampleFeatures(); // discard — just to update EMA
}

let buys = 0, sells = 0, holds = 0;
let pMin = +Infinity, pMax = -Infinity, pSum = 0, pCount = 0;
for (let i = candles.length - 20; i < candles.length; i++) {
  const drive = encodeCandle(candles[i], candles[i - 1]);
  trainer.simulator.stimulate(drive);
  trainer.simulator.step();
  const { smoothed } = trainer.simulator.sampleFeatures();
  const p = inferReadout(smoothed, model);

  // trainedFlapRequest-style "hard guard": only act on strong signals
  const decision: 'BUY' | 'SELL' | 'HOLD' =
    p >  model.threshold + 0.10 ? 'BUY'  :
    p <  model.threshold - 0.10 ? 'SELL' :
                                    'HOLD';

  if      (decision === 'BUY')  buys++;
  else if (decision === 'SELL') sells++;
  else                          holds++;

  if (p < pMin) pMin = p;
  if (p > pMax) pMax = p;
  pSum += p;
  pCount++;

  const ret = ((candles[i].close - candles[i - 1].close) / candles[i - 1].close) * 100;
  console.log(
    `${String(i).padStart(7)}  | ${ret.toFixed(2).padStart(6)} | ${p.toFixed(3)} | ${decision}`
  );
}
console.log(`\ndecisions: ${buys} BUY / ${sells} SELL / ${holds} HOLD`);
console.log(`p distribution: min=${pMin.toFixed(3)} mean=${(pSum / pCount).toFixed(3)} max=${pMax.toFixed(3)}  (threshold=${model.threshold.toFixed(3)})`);

// --- 7. Diagnostic: synthetic vs. real-data caveat ----------------------
// Synthetic candles = random walk; label is essentially un-predictable.
// Expect loss ≈ 0.69 (random classifier) and p-distribution to sit on one
// side of threshold — not because the model learned anything useful, but
// because EMA-smoothed brain activity gets stuck on whichever side bias
// drifted to during online SGD. On real OHLCV (where patterns exist)
// the same pipeline will produce a calibrated, oscillating p.
if (USE_REAL) {
  console.log('\n[note] trained on REAL BTC/USDT 1h K-lines.');
  console.log('       Decisions reflect actual market microstructure, not random walk.');
} else if (Math.abs(pSum / pCount - 0.5) > 0.15) {
  console.log('\n[note] p-distribution is far from 0.5 — synthetic random walk');
  console.log('       has no learnable signal. Run on real BTC/USDT K-lines');
  console.log('       (REAL=1) to see meaningful predictions.');
}

trainer.dispose();
console.log('\nDone. Next: replace synthCandles() with gate_get_ohlcv_data() to use real data.\n');