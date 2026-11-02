/**
 * backtest/run.js — Walk-Forward Backtest Runner & Strategy Comparator
 * 
 * Compares:
 * 1. Baseline Strategy (EMA 9/21 Crossover)
 * 2. MCX Beginner Strategy (Trend + Momentum Pullback)
 * 3. MCX Pro Strategy (Supertrend + Stochastic %K/%D + Wilder's ADX + Rejections)
 * 
 * Usage:
 *   node backtest/run.js [SYMBOL]
 */

const { getHistoricalCandles } = require('./data');
const { evaluateBaselineStrategy, evaluateBeginnerStrategy, evaluateProStrategy } = require('./signals');
const { simulateStrategy } = require('./sim');
const { calculateMetrics } = require('./metrics');

async function runBacktest(symbol = 'RELIANCE', segment = 'equity', lotMultiplier = 1) {
  console.log('================================================================================');
  console.log(`  INSTITUTIONAL WALK-FORWARD BACKTEST: ${symbol} (${segment.toUpperCase()})`);
  console.log(`  Capital: ₹15,000 | Max Risk: ₹50.00 | Exact Zerodha Fees & Slippage Included`);
  console.log('================================================================================\n');

  // 1. Ingest Data
  const candles = await getHistoricalCandles(symbol, '5m', 1500);
  const totalBars = candles.length;
  const splitIdx = Math.floor(totalBars * 0.60); // 60% In-Sample, 40% Out-of-Sample

  const inSampleCandles = candles.slice(0, splitIdx);
  const outSampleCandles = candles.slice(splitIdx);

  console.log(`Data Range: ${totalBars} bars (5m intervals)`);
  console.log(`- In-Sample (Calibration): ${inSampleCandles.length} bars`);
  console.log(`- Out-of-Sample (Unseen Test): ${outSampleCandles.length} bars\n`);

  const strategies = [
    { name: 'Baseline (EMA 9/21 Crossover)', fn: evaluateBaselineStrategy },
    { name: 'MCX Beginner (Trend + RSI)', fn: evaluateBeginnerStrategy },
    { name: 'MCX Pro (Supertrend + Stoch + ADX)', fn: evaluateProStrategy }
  ];

  const simConfig = {
    symbol,
    segment,
    lotMultiplier,
    maxLossTotal: 50.0,
    minNetRR: 1.5,
    slippageTicks: 1,
    tickSize: 0.05,
    spread: 0.10,
    warmupBars: 60
  };

  const results = [];

  for (const strat of strategies) {
    // In-Sample Simulation
    const inSim = simulateStrategy(inSampleCandles, strat.fn, simConfig);
    const inMetrics = calculateMetrics(inSim.trades);

    // Out-of-Sample Simulation (True Test of Edge)
    const outSim = simulateStrategy(outSampleCandles, strat.fn, simConfig);
    const outMetrics = calculateMetrics(outSim.trades);

    results.push({
      name: strat.name,
      inSample: inMetrics,
      outSample: outMetrics,
      inBlocked: inSim.blockedSignals,
      outBlocked: outSim.blockedSignals
    });
  }

  // Print Formatted Output Table
  console.log('--------------------------------------------------------------------------------');
  console.log('  OUT-OF-SAMPLE RESULTS (THE TRUE PROOF OF EDGE AFTER ALL FEES & SLIPPAGE)');
  console.log('--------------------------------------------------------------------------------');

  for (const r of results) {
    const o = r.outSample;
    const isProfitable = o.netPnl > 0;
    const edgeStatus = isProfitable ? '✅ POSITIVE EXPECTANCY' : '❌ NEGATIVE EXPECTANCY';

    console.log(`\nStrategy: ${r.name}`);
    console.log(`Status: ${edgeStatus} | Trades: ${o.totalTrades} (Blocked by Risk: ${r.outBlocked})`);
    console.log(`Net Win Rate:    ${o.winRate}% (Wins: ${o.winsCount}, Losses: ${o.lossesCount})`);
    console.log(`Total Net P&L:   ${o.netPnl >= 0 ? '+' : ''}₹${o.netPnl.toFixed(2)}`);
    console.log(`Gross Gains:     +₹${o.grossProfit.toFixed(2)} | Gross Losses: -₹${o.grossLoss.toFixed(2)}`);
    console.log(`Zerodha Fees:    ₹${o.totalFees.toFixed(2)} (${o.feeDragPct.toFixed(1)}% fee drag)`);
    console.log(`Expectancy (₹):  ${o.expectancyRupees >= 0 ? '+' : ''}₹${o.expectancyRupees.toFixed(2)} per trade`);
    console.log(`Expectancy (R):  ${o.expectancyR >= 0 ? '+' : ''}${o.expectancyR.toFixed(2)}R`);
    console.log(`Profit Factor:   ${o.profitFactor}`);
    console.log(`Max Drawdown:    ₹${o.maxDrawdownRupees.toFixed(2)} (${o.maxDrawdownPct.toFixed(1)}% of capital)`);
    console.log(`95% Conf. Int:   ₹${o.ci95Low.toFixed(2)} to ₹${o.ci95High.toFixed(2)} per trade`);
  }

  console.log('\n================================================================================');
  console.log('  ARCHITECTURAL CONCLUSION:');
  const bestOut = results.reduce((best, curr) => curr.outSample.netPnl > best.outSample.netPnl ? curr : best);
  console.log(`  Top Performing Out-of-Sample: "${bestOut.name}" (Net P&L: ₹${bestOut.outSample.netPnl.toFixed(2)}, Expectancy: ₹${bestOut.outSample.expectancyRupees.toFixed(2)}/trade)`);
  console.log('================================================================================\n');

  return results;
}

if (require.main === module) {
  const sym = process.argv[2] || 'RELIANCE';
  runBacktest(sym, 'equity', 1).catch(err => {
    console.error('Backtest error:', err);
    process.exit(1);
  });
}

module.exports = {
  runBacktest
};
