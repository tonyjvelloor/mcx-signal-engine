/**
 * scripts/backtest_mcx.js — Legacy vs. Upgraded SignalEngine Verification Backtest
 *
 * Evaluates Legacy linear indicator scoring against shared/signal_engine.js
 * (Regime-Conditional + SMC + Fee-to-Target Hurdle Gate) on pre-holdout historical bars
 * (2026-08-06 to 2026-11-02 cutoff strictly preserved) with real Zerodha transaction costs.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const riskEngine = require('../risk');
const signalEngine = require('../shared/signal_engine');
const patternEngine = require('../shared/pattern_engine');

const DB_PATH = path.join(__dirname, '..', 'market_data.db');
const CALIBRATION_CUTOFF_MS = Date.parse('2026-11-02T23:59:59+05:30');

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function emaVal(arr, n) {
  if (!arr.length) return 0;
  const k = 2 / (n + 1);
  let e = arr.slice(0, Math.min(n, arr.length)).reduce((s, v) => s + v, 0) / Math.min(n, arr.length);
  for (let i = Math.min(n, arr.length); i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function calcRSI(arr, n = 14) {
  if (arr.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = arr.length - n; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    d > 0 ? g += d : l -= d;
  }
  const rs = g / (l || 0.0001);
  return 100 - 100 / (1 + rs);
}
function calcBB(arr, n = 20, mult = 2) {
  const sl = arr.slice(-n);
  const mid = sl.reduce((a, b) => a + b, 0) / (sl.length || 1);
  const std = Math.sqrt(sl.reduce((s, p) => s + (p - mid) ** 2, 0) / (sl.length || 1));
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}
function calcATR(cls, his, los, n = 14) {
  const trs = [];
  for (let i = 1; i < cls.length; i++) {
    trs.push(Math.max(his[i] - los[i], Math.abs(his[i] - cls[i - 1]), Math.abs(los[i] - cls[i - 1])));
  }
  const sl = trs.slice(-n);
  return sl.length ? sl.reduce((a, b) => a + b, 0) / sl.length : 0;
}

function resample15m(rows) {
  const out = [];
  for (let i = 0; i + 2 < rows.length; i += 3) {
    const chunk = rows.slice(i, i + 3);
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(r => r.high)),
      low: Math.min(...chunk.map(r => r.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, r) => s + (r.volume || 0), 0)
    });
  }
  return out;
}

function legacyEvaluate(bars, idx) {
  const win = bars.slice(Math.max(0, idx - 60), idx + 1);
  const cls = win.map(b => b.close);
  const his = win.map(b => b.high);
  const los = win.map(b => b.low);
  const vls = win.map(b => b.volume);
  const price = cls[cls.length - 1];
  const rsi = calcRSI(cls);
  const bb = calcBB(cls);
  const e9 = emaVal(cls, 9), e21 = emaVal(cls, 21), e50 = emaVal(cls, 50), e200 = emaVal(cls, 200);

  let obv = 0;
  for (let i = 1; i < cls.length; i++) {
    if (cls[i] > cls[i - 1]) obv += vls[i];
    else if (cls[i] < cls[i - 1]) obv -= vls[i];
  }
  const sigs = {
    rsi: rsi < 35 ? 'BUY' : rsi > 65 ? 'SELL' : 'NEUTRAL',
    bb: price < bb.lower ? 'BUY' : price > bb.upper ? 'SELL' : 'NEUTRAL',
    ema9: price > e9 ? 'BUY' : 'SELL',
    ema21: price > e21 ? 'BUY' : 'SELL',
    ema50: price > e50 ? 'BUY' : 'SELL',
    ema200: price > e200 ? 'BUY' : 'SELL',
    ema_cross: e9 > e21 ? 'BUY' : 'SELL',
    obv: obv > 0 ? 'BUY' : 'SELL'
  };
  const weights = { ema_cross: 3, ema200: 2.5, ema50: 2, ema21: 1, ema9: 0.5, rsi: 1, bb: 1, obv: 0.8 };
  let raw = 0, max = 0;
  for (const [k, w] of Object.entries(weights)) {
    max += w;
    raw += (sigs[k] === 'BUY' ? w : sigs[k] === 'SELL' ? -w : 0);
  }
  const score = clamp(Math.round(50 + (raw / max) * 50), 5, 95);
  const action = score >= 62 ? 'BUY' : score <= 38 ? 'SELL' : 'WAIT';
  return { action, atr: calcATR(cls, his, los) };
}

function upgradedEvaluate(bars, idx, mult) {
  const win = bars.slice(Math.max(0, idx - 60), idx + 1);
  const ops = win.map(b => b.open);
  const cls = win.map(b => b.close);
  const his = win.map(b => b.high);
  const los = win.map(b => b.low);
  const vls = win.map(b => b.volume);
  const price = cls[cls.length - 1];
  const rsi = calcRSI(cls);
  const bb = calcBB(cls);
  const atr = calcATR(cls, his, los);
  const e9 = emaVal(cls, 9), e21 = emaVal(cls, 21), e50 = emaVal(cls, 50), e200 = emaVal(cls, 200);
  const adx = signalEngine.calcADX(cls, his, los);
  const obvObj = signalEngine.calcOBV(cls, vls);
  const vwap = signalEngine.calcSessionVWAP(cls, his, los, vls, 30);
  const smc = patternEngine.scanPatterns({ opens: ops, closes: cls, highs: his, lows: los, volumes: vls });

  const e12 = emaVal(cls, 12), e26 = emaVal(cls, 26);
  const macdHist = e12 - e26;
  const sigs = {
    rsi: rsi < 35 ? 'BUY' : rsi > 65 ? 'SELL' : 'NEUTRAL',
    macd_hist: macdHist > 0 ? 'BUY' : 'SELL',
    bb: price < bb.lower ? 'BUY' : price > bb.upper ? 'SELL' : 'NEUTRAL',
    ema9: price > e9 ? 'BUY' : 'SELL',
    ema21: price > e21 ? 'BUY' : 'SELL',
    ema50: price > e50 ? 'BUY' : 'SELL',
    ema200: price > e200 ? 'BUY' : 'SELL',
    ema_cross: e9 > e21 ? 'BUY' : 'SELL',
    adx: adx.isChop ? 'NEUTRAL' : (adx.plus > adx.minus ? 'BUY' : 'SELL'),
    vwap: price > vwap ? 'BUY' : 'SELL',
    struct: smc.structure?.bias === 'BULLISH' ? 'BUY' : smc.structure?.bias === 'BEARISH' ? 'SELL' : 'NEUTRAL',
    obv: obvObj.trend
  };

  const gate = signalEngine.evaluateRegimeAndFeeGate({
    sigs,
    adxObj: adx,
    smc,
    newsScore: 50,
    volConfirmed: true,
    entry: price,
    sl: price - atr * 1.5,
    t1: price + atr * 2.5,
    lotMultiplier: mult,
    roundTripFee: 20, // Micro-lot fee benchmark for equity/commodity backtest
    minGrossTargetMultiple: 3.5,
    minNetRR: 1.35,
    threshold: 65
  });

  return { action: gate.action, atr };
}

function simulateMode(barsBySymbol, evalFn, lotMult = 10) {
  let trades = 0, wins = 0, grossSum = 0, feeSum = 0, netSum = 0;

  for (const [, bars] of Object.entries(barsBySymbol)) {
    let i = 65;
    while (i < bars.length - 12) {
      const { action, atr } = evalFn(bars, i, lotMult);
      if (action === 'WAIT' || !atr || atr <= 0) {
        i++;
        continue;
      }

      const entry = bars[i].close;
      const slDist = atr * 1.5;
      const t1Dist = atr * 2.5;
      const sl = action === 'BUY' ? entry - slDist : entry + slDist;
      const tp = action === 'BUY' ? entry + t1Dist : entry - t1Dist;

      let exitPrice = bars[Math.min(bars.length - 1, i + 12)].close;
      let exitIdx = Math.min(bars.length - 1, i + 12);

      for (let j = i + 1; j <= Math.min(bars.length - 1, i + 12); j++) {
        const b = bars[j];
        if (action === 'BUY') {
          if (b.low <= sl) { exitPrice = sl; exitIdx = j; break; }
          if (b.high >= tp) { exitPrice = tp; exitIdx = j; break; }
        } else {
          if (b.high >= sl) { exitPrice = sl; exitIdx = j; break; }
          if (b.low <= tp) { exitPrice = tp; exitIdx = j; break; }
        }
      }

      const gross = (action === 'BUY' ? exitPrice - entry : entry - exitPrice) * lotMult;
      const feeObj = riskEngine.calculateZerodhaFees({
        side: action,
        entry,
        exit: exitPrice,
        quantity: 1,
        lotMultiplier: lotMult,
        segment: 'commodity'
      });
      const fee = feeObj.total || 20;
      const net = gross - fee;

      trades++;
      if (net > 0) wins++;
      grossSum += gross;
      feeSum += fee;
      netSum += net;
      i = exitIdx + 2;
    }
  }

  return {
    trades,
    winRate: trades ? +((wins / trades) * 100).toFixed(1) : 0,
    grossExp: trades ? +(grossSum / trades).toFixed(2) : 0,
    avgFee: trades ? +(feeSum / trades).toFixed(2) : 0,
    netExp: trades ? +(netSum / trades).toFixed(2) : 0,
    feeDragPct: grossSum > 0 ? +((feeSum / grossSum) * 100).toFixed(1) : 100
  };
}

function main() {
  const db = new DatabaseSync(DB_PATH, { readonly: true });
  const symbols = ['RELIANCE', 'HDFCBANK', 'INFY', 'SBIN', 'LT', 'ICICIBANK'];
  const barsBySymbol = {};

  for (const sym of symbols) {
    const rows = db.prepare(
      `SELECT time, open, high, low, close, volume FROM candles WHERE symbol = ? AND interval = '5m' AND time <= ? ORDER BY time ASC`
    ).all(sym, CALIBRATION_CUTOFF_MS);
    if (rows.length >= 300) {
      barsBySymbol[sym] = resample15m(rows);
    }
  }

  console.log(`📊 MCX/NSE Pre-Holdout Walk-Forward Signal Comparison (Cutoff <= 2026-11-02, 15m Resampled)`);
  console.log(`Universes loaded: ${Object.keys(barsBySymbol).join(', ')}\n`);

  const legacyRes = simulateMode(barsBySymbol, (bars, idx) => legacyEvaluate(bars, idx), 10);
  const upgradedRes = simulateMode(barsBySymbol, (bars, idx, mult) => upgradedEvaluate(bars, idx, mult), 10);

  console.table({
    'Legacy Linear Engine': legacyRes,
    'Upgraded Regime+SMC+Fee Engine': upgradedRes
  });
}

main();
