/**
 * h2/evaluate.js — Pre-registered calibration evaluation of Hypothesis 2 (TimesFM filter).
 *
 * Implements EXACTLY docs/hypothesis_2_preregistration.md (+ Addendum 1). No tuning flags exist.
 * Calibration data only (2026-11-02 freeze). Refuses --final.
 *
 * Run:  node h2/evaluate.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const risk = require('../risk');
const ind = require('../shared/indicators');
const { simulateStrategy } = require('../backtest/sim');
const { calculateMetrics, createPrng } = require('../backtest/metrics');

// ---- Pre-registered constants (DO NOT CHANGE) ----
const HOLD_BARS = 12;
const ATR_STOP_MULT = 1.5;
const EOD_MINUTE_IST = 15 * 60 + 15;
const SLIPPAGE_TICKS = 1, TICK = 0.05, SPREAD = 0.10;
const SEEDS = [42, 101, 777, 1337, 2026];
const PERMS_PER_SEED = 200;           // 5 x 200 = 1,000 permutations (same as the H1 null)
const ALPHA = 0.01;
const MIN_TRADES = 30;

const SIM_CFG = {
  segment: 'equity', lotMultiplier: 1, maxLossTotal: 50.0, minNetRR: 0,
  slippageTicks: SLIPPAGE_TICKS, tickSize: TICK, spread: SPREAD,
  warmupBars: 60, eodSquareOffMinuteIST: EOD_MINUTE_IST
};

function istDay(ms) { return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }

function atrAt(candles, i) {
  const s = candles.slice(Math.max(0, i - 99), i + 1);
  return ind.calcATR(s.map(c => c.close), s.map(c => c.high), s.map(c => c.low), 14);
}

/** Per-share cost hurdle C at the sized quantity (Addendum 1, item 3). */
function costHurdle(close, atr) {
  const sl = close - ATR_STOP_MULT * atr;
  const sz = risk.sizeTrade({
    side: 'BUY', entry: close, sl, target: close * 10, segment: 'equity',
    maxLossTotal: 50, minNetRR: 0, atr
  });
  if (!sz.ok) return null;
  const fee = risk.calculateZerodhaFees({ segment: 'equity', buyPrice: close, sellPrice: close, qty: sz.qty, lotMultiplier: 1 }).totalFees;
  return fee / sz.qty + 2 * SLIPPAGE_TICKS * TICK + SPREAD;
}

function makeSignal(side, close, atr) {
  const sl = side === 'BUY' ? close - ATR_STOP_MULT * atr : close + ATR_STOP_MULT * atr;
  return { action: side, sl, atr, timeExitOnly: true, maxHoldBars: HOLD_BARS };
}

function binomTwoSidedP(k, n) {
  if (n === 0) return 1;
  const z = (k - n / 2) / Math.sqrt(n / 4);
  const phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
  return Math.min(1, 2 * (1 - phi(Math.abs(z))));
}
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

function runPortfolio(universe, signalMapBySym) {
  const trades = [];
  for (const sym of Object.keys(universe)) {
    const candles = universe[sym];
    const map = signalMapBySym[sym];
    const res = simulateStrategy(candles, null, {
      ...SIM_CFG, symbol: sym, signalAtIndex: (i) => map.get(i) || null
    });
    trades.push(...res.trades);
  }
  return trades;
}

function main() {
  if (process.argv.includes('--final') || process.env.EVALUATE_HOLDOUT === 'true') {
    console.error('H2 evaluate refuses --final: calibration only.'); process.exit(1);
  }
  const candlesFile = path.join(__dirname, 'data', 'candles_calibration.json');
  const fcFile = path.join(__dirname, 'data', 'forecasts_calibration.json');
  const candlesRaw = fs.readFileSync(candlesFile);
  const candlesSha = crypto.createHash('sha256').update(candlesRaw).digest('hex');
  const fc = JSON.parse(fs.readFileSync(fcFile, 'utf8'));
  if (fc.meta.input_sha256 !== candlesSha) {
    console.error('Forecast file was not produced from the current candle export (hash mismatch).'); process.exit(1);
  }
  const raw = JSON.parse(candlesRaw);
  const universe = {};
  for (const [sym, rows] of Object.entries(raw)) {
    universe[sym] = rows.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
  }

  // ---- 1. Real strategy signals ----
  const realMaps = {}, slotsByDay = {};
  let nForecasts = 0, nSignals = 0, nNoSize = 0;
  const diag = { n: 0, correct: 0, sigN: 0, sigCorrect: 0 };
  for (const sym of Object.keys(universe)) {
    const c = universe[sym];
    realMaps[sym] = new Map();
    slotsByDay[sym] = {};
    for (const f of fc.forecasts[sym]) {
      nForecasts++;
      const day = istDay(f.time);
      (slotsByDay[sym][day] = slotsByDay[sym][day] || []).push(f);
      const atr = atrAt(c, f.i);
      if (!(atr > 0)) continue;
      const C = costHurdle(f.close, atr);
      if (C === null) { nNoSize++; continue; }
      let side = null;
      if (f.q10 > f.close + C) side = 'BUY';
      else if (f.q90 < f.close - C) side = 'SELL';

      // diagnostic: median-forecast direction vs realised 12-bar direction (same session only)
      const j = f.i + HOLD_BARS;
      if (j < c.length && istDay(c[j].time) === day) {
        const realised = Math.sign(c[j].close - f.close);
        const predicted = Math.sign(f.q50 - f.close);
        if (realised !== 0 && predicted !== 0) {
          diag.n++; if (realised === predicted) diag.correct++;
          if (side) { diag.sigN++; if ((side === 'BUY' ? 1 : -1) === realised) diag.sigCorrect++; }
        }
      }
      if (side) { realMaps[sym].set(f.i, makeSignal(side, f.close, atr)); nSignals++; }
    }
  }
  const trades = runPortfolio(universe, realMaps);
  const m = calculateMetrics(trades, 15000, 42);
  const grossPerTrade = trades.length ? trades.reduce((s, t) => s + t.grossPnl, 0) / trades.length : 0;
  const feePerTrade = trades.length ? trades.reduce((s, t) => s + t.fees, 0) / trades.length : 0;
  const sessions = new Set(trades.map(t => istDay(t.entryTime))).size;

  // ---- 2. Matched random-entry null (Addendum 1, item 6) ----
  const perSymDay = {};
  for (const t of trades) {
    const d = istDay(t.entryTime);
    perSymDay[t.symbol] = perSymDay[t.symbol] || {};
    perSymDay[t.symbol][d] = (perSymDay[t.symbol][d] || 0) + 1;
  }
  const seedResults = [];
  const allNullExp = [];
  for (const seed of SEEDS) {
    const rand = createPrng(seed);
    let ge = 0;
    for (let p = 0; p < PERMS_PER_SEED; p++) {
      const maps = {};
      for (const sym of Object.keys(universe)) {
        maps[sym] = new Map();
        const c = universe[sym];
        for (const [day, n] of Object.entries(perSymDay[sym] || {})) {
          const slots = (slotsByDay[sym][day] || []).slice();
          for (let k = 0; k < n && slots.length; k++) {
            const f = slots.splice(Math.floor(rand() * slots.length), 1)[0];
            const atr = atrAt(c, f.i);
            if (!(atr > 0)) continue;
            maps[sym].set(f.i, makeSignal(rand() < 0.5 ? 'BUY' : 'SELL', f.close, atr));
          }
        }
      }
      const nt = runPortfolio(universe, maps);
      const exp = nt.length ? nt.reduce((s, t) => s + t.netPnl, 0) / nt.length : 0;
      allNullExp.push(exp);
      if (exp >= m.expectancyRupees) ge++;
    }
    seedResults.push({ seed, pValue: (ge + 1) / (PERMS_PER_SEED + 1) });
  }
  allNullExp.sort((a, b) => a - b);
  const pMean = seedResults.reduce((s, r) => s + r.pValue, 0) / seedResults.length;
  const nullMean = allNullExp.reduce((s, v) => s + v, 0) / allNullExp.length;

  // ---- 3. Pre-registered decision rule ----
  let verdict, reason;
  if (m.totalTrades < MIN_TRADES) { verdict = 'CLOSED_UNTESTABLE'; reason = `only ${m.totalTrades} trades (< ${MIN_TRADES})`; }
  else if (m.ci95High <= 0) { verdict = 'CLOSED_FALSIFIED_ON_CALIBRATION'; reason = `CI upper bound ₹${m.ci95High} <= 0`; }
  else if (grossPerTrade < feePerTrade) { verdict = 'CLOSED_FALSIFIED_ON_CALIBRATION'; reason = `gross ₹${grossPerTrade.toFixed(2)} < avg fee ₹${feePerTrade.toFixed(2)} per trade`; }
  else if (m.ci95Low > 0 && pMean < ALPHA) { verdict = 'ADVANCES_TO_FORWARD_ACCUMULATION'; reason = 'CI lower > 0 and p < 0.01'; }
  else { verdict = 'INCONCLUSIVE'; reason = 'neither falsified nor passed'; }

  const report = {
    hypothesis: 'H2', evaluatedAt: new Date().toISOString(),
    inputs: { candlesSha256: candlesSha, forecastMeta: fc.meta },
    signals: { forecasts: nForecasts, signals: nSignals, unsizable: nNoSize },
    trades: m.totalTrades, sessions, winRate: m.winRate,
    grossExpectancyPerTrade: +grossPerTrade.toFixed(2), avgFeePerTrade: +feePerTrade.toFixed(2),
    netExpectancy: m.expectancyRupees, ci95: [m.ci95Low, m.ci95High], profitFactor: m.profitFactor,
    nullMeanExpectancy: +nullMean.toFixed(2), pValueMean: +pMean.toFixed(3), seedResults,
    directional: {
      allForecasts: { n: diag.n, accuracy: diag.n ? +(diag.correct / diag.n).toFixed(4) : null, binomP: +binomTwoSidedP(diag.correct, diag.n).toFixed(4) },
      signalledOnly: { n: diag.sigN, accuracy: diag.sigN ? +(diag.sigCorrect / diag.sigN).toFixed(4) : null, binomP: +binomTwoSidedP(diag.sigCorrect, diag.sigN).toFixed(4) }
    },
    verdict, reason
  };
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', 'h2_calibration_report.json'), JSON.stringify(report, null, 2));

  console.log('\n================ H2 CALIBRATION RESULT (pre-registered, single run) ================');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nVERDICT: ${verdict} — ${reason}\n`);
}

main();
