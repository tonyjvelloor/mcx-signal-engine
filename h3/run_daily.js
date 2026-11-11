/**
 * h3/run_daily.js — Institutional Calibration Evaluation of Hypothesis 3
 * 
 * Pre-registered Multi-Day Trend & Volatility Breakout on NSE Large-Caps (Daily Swing).
 * Follows docs/hypothesis_3_preregistration.md exactly.
 * Calibration window: 2024-11-11 to 2026-11-02 (2026-11-02 holdout freeze strictly enforced).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const risk = require('../risk');
const ind = require('../shared/indicators');
const { fetchUpstreamCandles } = require('../backtest/data');
const { calculateMetrics, createPrng } = require('../backtest/metrics');

const UNIVERSE = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
  'BHARTIARTL', 'SBIN', 'ITC', 'LT', 'KOTAKBANK', 'AXISBANK', 'MARUTI'
];

const SYMBOL_MAP = {
  'RELIANCE': 'RELIANCE.NS',
  'TCS': 'TCS.NS',
  'INFY': 'INFY.NS',
  'HDFCBANK': 'HDFCBANK.NS',
  'ICICIBANK': 'ICICIBANK.NS',
  'BHARTIARTL': 'BHARTIARTL.NS',
  'SBIN': 'SBIN.NS',
  'ITC': 'ITC.NS',
  'LT': 'LT.NS',
  'KOTAKBANK': 'KOTAKBANK.NS',
  'AXISBANK': 'AXISBANK.NS',
  'MARUTI': 'MARUTI.NS'
};

const FREEZE_DATE = '2026-11-02';
const ATR_STOP_MULT = 2.0;
const SLIPPAGE_TICKS = 1;
const TICK = 0.05;
const SPREAD = 0.10;
const MAX_LOSS_PER_TRADE = 150.0; // ₹150 max risk on ₹15,000 capital (1% risk)
const SEEDS = [42, 101, 777, 1337, 2026];

function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function loadCalibrationDailyCandles() {
  const dataset = {};
  console.log('📥 INGESTING 2-YEAR DAILY CANDLES FOR UNIVERSE (Yahoo Proxy)...');
  for (const sym of UNIVERSE) {
    const ticker = SYMBOL_MAP[sym];
    const raw = await fetchUpstreamCandles(ticker, '1d', '2y');
    if (!raw || raw.length < 250) {
      throw new Error(`Insufficient daily bars for ${sym}: got ${raw?.length || 0}`);
    }
    // Enforce 2026-11-02 Calibration Freeze Date
    const calibrationBars = raw.filter(c => {
      const day = new Date(c.time + (5.5 * 3600 * 1000)).toISOString().slice(0, 10);
      return day <= FREEZE_DATE;
    });
    dataset[sym] = calibrationBars;
    const start = new Date(calibrationBars[0].time).toISOString().slice(0, 10);
    const end = new Date(calibrationBars[calibrationBars.length - 1].time).toISOString().slice(0, 10);
    console.log(`  ✓ ${sym.padEnd(10)}: ${calibrationBars.length} daily bars (${start} to ${end})`);
  }
  return dataset;
}

function simulateDailyStrategy(candles, sym) {
  const trades = [];
  let openTrade = null;
  let pendingSignal = null;
  const warmup = 205; // 200 SMA warmup

  for (let i = warmup; i < candles.length; i++) {
    const currentBar = candles[i];

    // 1. Process Pending Order (Fills at Current Bar OPEN with slippage)
    if (pendingSignal && !openTrade) {
      const fillPrice = currentBar.open + (SLIPPAGE_TICKS * TICK) + (SPREAD / 2);
      const slDist = fillPrice - pendingSignal.sl;
      const targetDist = slDist * 2.5;
      const targetPrice = fillPrice + targetDist;

      const sizing = risk.sizeTrade({
        side: 'BUY',
        entry: fillPrice,
        sl: pendingSignal.sl,
        target: targetPrice,
        lotMultiplier: 1,
        segment: 'equity_delivery',
        maxLossTotal: MAX_LOSS_PER_TRADE,
        minNetRR: 1.5,
        atr: pendingSignal.atr
      });

      if (sizing.ok) {
        openTrade = {
          id: trades.length + 1,
          symbol: sym,
          side: 'BUY',
          entryBarIndex: i,
          entryTime: currentBar.time,
          entryPrice: sizing.entryPrice,
          stopLoss: sizing.stopLoss,
          targetPrice: sizing.target,
          highestPriceSinceEntry: currentBar.high,
          qty: sizing.qty,
          plannedLoss: sizing.totalPlannedLoss,
          atr: pendingSignal.atr
        };
      }
      pendingSignal = null;
    }

    // 2. Manage Active Trade (Check SL hit, Target hit, or 10-day Low Channel exit)
    if (openTrade) {
      const isLong = true;
      let exitPrice = null;
      let exitReason = null;

      // Update trailing highest price
      if (currentBar.high > openTrade.highestPriceSinceEntry) {
        openTrade.highestPriceSinceEntry = currentBar.high;
      }

      // Check Stop Loss hit during day
      if (currentBar.low <= openTrade.stopLoss) {
        exitPrice = openTrade.stopLoss - (SLIPPAGE_TICKS * TICK);
        exitReason = 'STOP_LOSS';
      } else if (currentBar.high >= openTrade.targetPrice) {
        exitPrice = openTrade.targetPrice - (SLIPPAGE_TICKS * TICK);
        exitReason = 'TARGET_HIT';
      } else {
        // Check 10-day Donchian Low Exit
        const prior10Lows = candles.slice(i - 10, i).map(c => c.low);
        const donchian10Low = Math.min(...prior10Lows);
        if (currentBar.close < donchian10Low) {
          exitPrice = currentBar.close - (SLIPPAGE_TICKS * TICK);
          exitReason = '10D_CHANNEL_EXIT';
        }
      }

      if (exitPrice !== null) {
        const fees = risk.calculateZerodhaFees({
          segment: 'equity_delivery',
          buyPrice: openTrade.entryPrice,
          sellPrice: exitPrice,
          qty: openTrade.qty,
          lotMultiplier: 1
        });

        const grossPnl = (exitPrice - openTrade.entryPrice) * openTrade.qty;
        const netPnl = grossPnl - fees.totalFees;
        const initialRisk = openTrade.plannedLoss;
        const rMultiple = initialRisk > 0 ? (netPnl / initialRisk) : 0;

        trades.push({
          ...openTrade,
          exitBarIndex: i,
          exitTime: currentBar.time,
          exitPrice: Math.round(exitPrice * 100) / 100,
          exitReason,
          daysHeld: i - openTrade.entryBarIndex,
          grossPnl: Math.round(grossPnl * 100) / 100,
          fees: fees.totalFees,
          netPnl: Math.round(netPnl * 100) / 100,
          rMultiple: Math.round(rMultiple * 100) / 100,
          isWin: netPnl > 0
        });

        openTrade = null;
      }
    }

    // 3. Evaluate Breakout Signal at Close of Day i
    if (!openTrade && !pendingSignal) {
      const history = candles.slice(0, i + 1);
      const closes = history.map(c => c.close);
      const highs = history.map(c => c.high);
      const lows = history.map(c => c.low);

      const currentClose = closes[closes.length - 1];
      const sma50 = sma(closes, 50);
      const sma200 = sma(closes, 200);

      // Macro Trend Filter: 50 SMA > 200 SMA (Golden Cross) and Close > 50 SMA
      const isMacroBull = sma50 !== null && sma200 !== null && sma50 > sma200 && currentClose > sma50;

      // 20-Day Donchian High Breakout (excluding today's bar)
      const prior20Highs = highs.slice(-21, -1);
      const donchian20High = Math.max(...prior20Highs);
      const isBreakout = currentClose > donchian20High;

      if (isMacroBull && isBreakout) {
        const atr = ind.calcATR(closes, highs, lows, 14);
        if (atr > 0) {
          const sl = currentClose - (ATR_STOP_MULT * atr);
          pendingSignal = { action: 'BUY', sl, atr };
        }
      }
    }
  }

  return trades;
}

async function run() {
  console.log('\n================================================================================');
  console.log('   HYPOTHESIS 3 (DAILY SWING MOMENTUM) INSTITUTIONAL CALIBRATION SUITE');
  console.log('================================================================================');
  console.log('• Universe:      12 Liquid NSE Large-Caps');
  console.log('• Timeframe:     Daily (1D) Candlesticks (2-Year Window)');
  console.log('• Risk Model:    ₹15,000 Capital | ₹150 Max Risk / Trade | Zerodha Delivery Schedule');
  console.log(`• Boundary:      Calibration Freeze Date: ${FREEZE_DATE}\n`);

  const dataset = await loadCalibrationDailyCandles();
  const allTrades = [];

  console.log('\n📊 PER-SYMBOL PERFORMANCE (DAILY SWING):');
  console.log('--------------------------------------------------------------------------------');
  console.log('Symbol       Trades   WinRate   Gross P&L     Fees     Net P&L    PF     Status');
  console.log('--------------------------------------------------------------------------------');

  for (const sym of UNIVERSE) {
    const symTrades = simulateDailyStrategy(dataset[sym], sym);
    allTrades.push(...symTrades);

    const wins = symTrades.filter(t => t.isWin);
    const gross = symTrades.reduce((s, t) => s + t.grossPnl, 0);
    const fees = symTrades.reduce((s, t) => s + t.fees, 0);
    const net = symTrades.reduce((s, t) => s + t.netPnl, 0);
    const winRate = symTrades.length ? (wins.length / symTrades.length) * 100 : 0;
    const losses = symTrades.filter(t => !t.isWin);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.grossPnl, 0));
    const grossWin = wins.reduce((s, t) => s + t.grossPnl, 0);
    const pf = grossLoss > 0 ? (grossWin / grossLoss) : (grossWin > 0 ? 99.9 : 0);

    const status = net > 0 ? 'PROFITABLE' : 'UNPROFITABLE';
    console.log(
      `${sym.padEnd(11)} ` +
      `${symTrades.length.toString().padStart(6)} ` +
      `${winRate.toFixed(1).padStart(8)}% ` +
      `${(gross >= 0 ? '+' : '') + '₹' + gross.toFixed(2).padStart(9)} ` +
      `${('₹' + fees.toFixed(2)).padStart(9)} ` +
      `${(net >= 0 ? '+' : '') + '₹' + net.toFixed(2).padStart(10)} ` +
      `${pf.toFixed(2).padStart(6)}   ` +
      `${status}`
    );
  }

  const m = calculateMetrics(allTrades, 15000, 42);
  const grossPerTrade = allTrades.length ? allTrades.reduce((s, t) => s + t.grossPnl, 0) / allTrades.length : 0;
  const feePerTrade = allTrades.length ? allTrades.reduce((s, t) => s + t.fees, 0) / allTrades.length : 0;

  console.log('\n================================================================================');
  console.log('       POOLED PORTFOLIO CALIBRATION RESULTS (ALL 12 SYMBOLS)');
  console.log('================================================================================');
  console.log(`Total Pooled Trades: ${m.totalTrades} (Wins: ${m.winsCount}, Losses: ${m.lossesCount})`);
  console.log(`Net Win Rate:        ${m.winRate}%`);
  console.log(`Total Net P&L:       ₹${m.netPnl}`);
  console.log(`Gross P&L:           +₹${m.grossProfit} / -₹${m.grossLoss}`);
  console.log(`Total Zerodha Fees:  ₹${m.totalFees} (${m.feeDragPct}% fee drag)`);
  console.log(`Gross Expectancy:    ₹${grossPerTrade.toFixed(2)} per trade`);
  console.log(`Avg Fee per Trade:   ₹${feePerTrade.toFixed(2)} per trade`);
  console.log(`Net Expectancy (₹):  ₹${m.expectancyRupees} per trade`);
  console.log(`Net Expectancy (R):  ${m.expectancyR}R`);
  console.log(`Profit Factor:       ${m.profitFactor}`);
  console.log(`Max Drawdown:        ₹${m.maxDrawdownRupees} (${m.maxDrawdownPct}% of capital)`);
  console.log(`95% Conf. Interval:  ₹${m.ci95Low} to ₹${m.ci95High} per trade (Day-Block Bootstrap)`);

  // Matched Random Baseline
  console.log('\n================================================================================');
  console.log('   MULTI-SEED MONTE CARLO NULL PERMUTATION TEST (1,000 Runs across 5 Seeds)');
  console.log('================================================================================');

  let totalGe = 0;
  const seedPValues = [];
  const totalPerms = 1000;
  const perSeed = 200;

  for (const seed of SEEDS) {
    const prng = createPrng(seed);
    let ge = 0;
    for (let p = 0; p < perSeed; p++) {
      // Simulate random portfolio with matched trade count
      let simNullNet = 0;
      for (const sym of UNIVERSE) {
        const symBars = dataset[sym];
        const nTrades = Math.floor(allTrades.length / UNIVERSE.length);
        for (let k = 0; k < nTrades; k++) {
          const randIdx = 205 + Math.floor(prng() * (symBars.length - 230));
          const entryBar = symBars[randIdx];
          const exitBar = symBars[randIdx + 10]; // 10 day hold
          const isLong = prng() < 0.5;
          const gross = isLong ? (exitBar.close - entryBar.open) : (entryBar.open - exitBar.close);
          const fees = 15.0; // typical delivery fee
          simNullNet += (gross - fees);
        }
      }
      const nullExp = simNullNet / allTrades.length;
      if (nullExp >= m.expectancyRupees) ge++;
    }
    const pVal = (ge + 1) / (perSeed + 1);
    seedPValues.push({ seed, pValue: pVal });
    totalGe += ge;
  }

  const pValueMean = seedPValues.reduce((s, r) => s + r.pValue, 0) / seedPValues.length;
  console.log(`• Empirical p-value Mean:            ${pValueMean.toFixed(3)}`);
  console.log(`• 95% CI Lower Bound:                ₹${m.ci95Low} / trade`);

  let verdict, reason;
  if (m.totalTrades < 30) {
    verdict = 'CLOSED_UNTESTABLE';
    reason = `Trade count ${m.totalTrades} < 30 minimum floor.`;
  } else if (m.ci95High <= 0) {
    verdict = 'CLOSED_FALSIFIED_ON_CALIBRATION';
    reason = `95% CI Upper Bound (₹${m.ci95High}) <= ₹0.00.`;
  } else if (m.ci95Low > 0 && pValueMean < 0.01) {
    verdict = 'ADVANCES_TO_FORWARD_ACCUMULATION';
    reason = `CI lower bound ₹${m.ci95Low} > 0 and p-value ${pValueMean.toFixed(3)} < 0.01. Valid empirical edge!`;
  } else {
    verdict = 'INCONCLUSIVE';
    reason = `Net positive (₹${m.expectancyRupees}/trade) but CI includes zero [₹${m.ci95Low}, ₹${m.ci95High}] or p >= 0.01.`;
  }

  console.log('\n================================================================================');
  console.log(`FINAL VERDICT: ${verdict}`);
  console.log(`Reason:        ${reason}`);
  console.log('================================================================================\n');

  // Save report
  const report = {
    hypothesis: 'H3',
    evaluatedAt: new Date().toISOString(),
    trades: m.totalTrades,
    winRate: m.winRate,
    netPnl: m.netPnl,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    totalFees: m.totalFees,
    feeDragPct: m.feeDragPct,
    grossExpectancyPerTrade: +grossPerTrade.toFixed(2),
    avgFeePerTrade: +feePerTrade.toFixed(2),
    netExpectancy: m.expectancyRupees,
    ci95Low: m.ci95Low,
    ci95High: m.ci95High,
    profitFactor: m.profitFactor,
    pValueMean: +pValueMean.toFixed(3),
    verdict,
    reason
  };

  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', 'h3_calibration_report.json'), JSON.stringify(report, null, 2));
}

run().catch(console.error);
