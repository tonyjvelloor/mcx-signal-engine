/**
 * backtest/sim.js — Bar-by-Bar Walk Forward Simulation Engine
 * 
 * Rules:
 * 1. Zero Lookahead: Signal at bar t enters at OPEN of bar t+1.
 * 2. Slippage & Spread Modeling: Slippage ticks and half-spread added to fills.
 * 3. Position Sizing: Governed by canonical risk.js (fee-adjusted R:R gate + ₹50 loss cap).
 * 4. Conservative Same-Bar Ambiguity: If both SL and Target are touched in the same candle, STOP is assumed hit first.
 * 5. Realistic Fees: Exact Zerodha brokerage, STT/CTT, exchange charges, GST, and stamp duty.
 */

const risk = require('../risk');

function simulateStrategy(candles, signalFn, config = {}) {
  const {
    symbol = 'RELIANCE',
    segment = 'equity',
    lotMultiplier = 1,
    maxLossTotal = 50.0,
    minNetRR = 1.5,
    slippageTicks = 1,
    tickSize = 0.05,
    spread = 0.10,
    warmupBars = 60
  } = config;

  if (!candles || candles.length <= warmupBars) {
    return { trades: [], blockedSignals: 0 };
  }

  const trades = [];
  let openTrade = null;
  let pendingSignal = null;
  let blockedCount = 0;

  for (let i = warmupBars; i < candles.length; i++) {
    const currentBar = candles[i];

    // 1. Process Pending Order from previous bar (fills at current bar's OPEN)
    if (pendingSignal && !openTrade) {
      const isBuy = pendingSignal.action === 'BUY';
      const slipAmount = slippageTicks * tickSize;
      const spreadHalf = spread / 2;

      // Realistic fill price factoring in spread and slippage
      const fillPrice = isBuy
        ? currentBar.open + slipAmount + spreadHalf
        : currentBar.open - slipAmount - spreadHalf;

      // Size trade through canonical risk engine
      const sizing = risk.sizeTrade({
        side: pendingSignal.action,
        entry: fillPrice,
        sl: pendingSignal.sl,
        target: pendingSignal.target,
        lotMultiplier,
        segment,
        maxLossTotal,
        minNetRR,
        atr: pendingSignal.atr
      });

      if (sizing.ok) {
        openTrade = {
          id: trades.length + 1,
          symbol,
          side: sizing.side,
          entryBarIndex: i,
          entryTime: currentBar.time,
          entryPrice: sizing.entryPrice,
          stopLoss: sizing.stopLoss,
          target: sizing.target,
          qty: sizing.qty,
          lotMultiplier,
          segment,
          slDist: sizing.slDist,
          targetDist: sizing.targetDist,
          plannedLoss: sizing.totalPlannedLoss,
          plannedNetReward: sizing.netProfitAtTarget,
          expectedNetRR: sizing.netRR,
          atr: pendingSignal.atr
        };
      } else {
        blockedCount++;
      }
      pendingSignal = null;
    }

    // 2. Manage Active Position (Check for SL / TP hits)
    if (openTrade) {
      let exitPrice = null;
      let exitReason = null;
      const isLong = openTrade.side === 'BUY';

      const slHit = isLong ? (currentBar.low <= openTrade.stopLoss) : (currentBar.high >= openTrade.stopLoss);
      const tpHit = isLong ? (currentBar.high >= openTrade.target) : (currentBar.low <= openTrade.target);

      // Conservative Ambiguity Resolution: If both hit in the same bar, assume Stop Loss hit first
      if (slHit && tpHit) {
        exitPrice = isLong
          ? openTrade.stopLoss - (slippageTicks * tickSize)
          : openTrade.stopLoss + (slippageTicks * tickSize);
        exitReason = 'STOP_LOSS (Same-bar conflict)';
      } else if (slHit) {
        exitPrice = isLong
          ? openTrade.stopLoss - (slippageTicks * tickSize)
          : openTrade.stopLoss + (slippageTicks * tickSize);
        exitReason = 'STOP_LOSS';
      } else if (tpHit) {
        exitPrice = isLong
          ? openTrade.target - (slippageTicks * tickSize)
          : openTrade.target + (slippageTicks * tickSize);
        exitReason = 'TARGET_HIT';
      }

      if (exitPrice !== null) {
        // Calculate exact Zerodha fees for round trip
        const fees = risk.calculateZerodhaFees({
          segment: openTrade.segment,
          buyPrice: isLong ? openTrade.entryPrice : exitPrice,
          sellPrice: isLong ? exitPrice : openTrade.entryPrice,
          qty: openTrade.qty,
          lotMultiplier: openTrade.lotMultiplier
        });

        const grossPnl = isLong
          ? (exitPrice - openTrade.entryPrice) * openTrade.qty * openTrade.lotMultiplier
          : (openTrade.entryPrice - exitPrice) * openTrade.qty * openTrade.lotMultiplier;

        const netPnl = grossPnl - fees.totalFees;
        const initialRisk = openTrade.plannedLoss;
        const rMultiple = initialRisk > 0 ? (netPnl / initialRisk) : 0;

        trades.push({
          ...openTrade,
          exitBarIndex: i,
          exitTime: currentBar.time,
          exitPrice: Math.round(exitPrice * 100) / 100,
          exitReason,
          barsHeld: i - openTrade.entryBarIndex,
          grossPnl: Math.round(grossPnl * 100) / 100,
          fees: fees.totalFees,
          netPnl: Math.round(netPnl * 100) / 100,
          rMultiple: Math.round(rMultiple * 100) / 100,
          isWin: netPnl > 0
        });

        openTrade = null;
      }
    }

    // 3. Generate Signals for next bar (strictly using candles slice <= i)
    if (!openTrade && !pendingSignal) {
      const historySlice = candles.slice(0, i + 1);
      const sig = signalFn(historySlice);
      if (sig && (sig.action === 'BUY' || sig.action === 'SELL')) {
        pendingSignal = sig;
      }
    }
  }

  return {
    trades,
    blockedSignals: blockedCount
  };
}

module.exports = {
  simulateStrategy
};
