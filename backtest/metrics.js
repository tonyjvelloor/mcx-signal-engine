/**
 * backtest/metrics.js — Institutional Strategy Metrics Engine
 * 
 * Reports:
 * - Trade Count & Sample Significance
 * - Net Win Rate (strictly net_pnl > 0)
 * - Expectancy in ₹ and in R
 * - Profit Factor
 * - Max Drawdown
 * - Fee Drag Impact (Fees as % of edge)
 * - Bootstrap 95% Confidence Interval
 */

function calculateMetrics(trades, initialCapital = 15000) {
  if (!trades || !trades.length) {
    return {
      totalTrades: 0,
      winsCount: 0,
      lossesCount: 0,
      winRate: 0,
      grossProfit: 0,
      grossLoss: 0,
      totalFees: 0,
      netPnl: 0,
      profitFactor: 0,
      expectancyRupees: 0,
      expectancyR: 0,
      avgWin: 0,
      avgLoss: 0,
      winLossRatio: 0,
      maxDrawdownRupees: 0,
      maxDrawdownPct: 0,
      feeDragPct: 0,
      ci95Low: 0,
      ci95High: 0
    };
  }

  const closed = trades.filter(t => t.netPnl !== undefined);
  const wins = closed.filter(t => t.netPnl > 0);
  const losses = closed.filter(t => t.netPnl <= 0);

  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;

  const grossProfit = wins.reduce((s, t) => s + (t.grossPnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.grossPnl || 0), 0));
  const totalFees = closed.reduce((s, t) => s + (t.fees || 0), 0);
  const netPnl = closed.reduce((s, t) => s + (t.netPnl || 0), 0);

  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? 99.9 : 0);
  const expectancyRupees = closed.length ? (netPnl / closed.length) : 0;
  const expectancyR = closed.length ? (closed.reduce((s, t) => s + (t.rMultiple || 0), 0) / closed.length) : 0;

  const avgWin = wins.length ? (wins.reduce((s, t) => s + t.netPnl, 0) / wins.length) : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.netPnl, 0) / losses.length) : 0;
  const winLossRatio = avgLoss > 0 ? (avgWin / avgLoss) : 0;

  // Max Drawdown Calculation
  let equity = initialCapital;
  let peak = initialCapital;
  let maxDD = 0;

  for (const t of closed) {
    equity += t.netPnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDDPct = (maxDD / initialCapital) * 100;

  // Fee Drag: What fraction of gross winnings went straight to fees?
  const feeDragPct = grossProfit > 0 ? (totalFees / grossProfit) * 100 : 100;

  // Block Bootstrap 95% Confidence Interval by Calendar Trading Day (1,000 resamples)
  // Preserves cross-sectional correlation across stocks on the same session.
  const dayClusters = {};
  for (const t of closed) {
    const day = t.entryTime ? new Date(t.entryTime + (5.5 * 3600 * 1000)).toISOString().split('T')[0] : 'unknown';
    if (!dayClusters[day]) dayClusters[day] = [];
    dayClusters[day].push(t);
  }
  const uniqueDays = Object.keys(dayClusters);
  const numDays = uniqueDays.length;

  const bootstrapExpectancies = [];
  for (let b = 0; b < 1000; b++) {
    let sampleSum = 0;
    let sampleCount = 0;

    for (let k = 0; k < numDays; k++) {
      const randDay = uniqueDays[Math.floor(Math.random() * numDays)];
      const dayTrades = dayClusters[randDay];
      for (let j = 0; j < dayTrades.length; j++) {
        sampleSum += dayTrades[j].netPnl;
        sampleCount++;
      }
    }
    bootstrapExpectancies.push(sampleCount > 0 ? (sampleSum / sampleCount) : 0);
  }

  bootstrapExpectancies.sort((a, b) => a - b);
  const ci95Low = bootstrapExpectancies[Math.floor(0.025 * 1000)];
  const ci95High = bootstrapExpectancies[Math.floor(0.975 * 1000)];

  return {
    totalTrades: closed.length,
    winsCount: wins.length,
    lossesCount: losses.length,
    winRate: Math.round(winRate * 10) / 10,
    grossProfit: Math.round(grossProfit * 100) / 100,
    grossLoss: Math.round(grossLoss * 100) / 100,
    totalFees: Math.round(totalFees * 100) / 100,
    netPnl: Math.round(netPnl * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    expectancyRupees: Math.round(expectancyRupees * 100) / 100,
    expectancyR: Math.round(expectancyR * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    winLossRatio: Math.round(winLossRatio * 100) / 100,
    maxDrawdownRupees: Math.round(maxDD * 100) / 100,
    maxDrawdownPct: Math.round(maxDDPct * 10) / 10,
    feeDragPct: Math.round(feeDragPct * 10) / 10,
    ci95Low: Math.round(ci95Low * 100) / 100,
    ci95High: Math.round(ci95High * 100) / 100
  };
}

module.exports = {
  calculateMetrics
};
