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
    warmupBars = 60,
    eodSquareOffMinuteIST = null, // optional forced intraday square-off (e.g. 915 = 15:15 IST)
    signalAtIndex = null          // optional fast path: (i, candles) => signal, avoids O(n^2) slicing
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

      // Size trade through canonical risk engine.
      // Time-exit-only strategies (e.g. H2) have no profit target: a never-reachable
      // sentinel target is used and the fee-adjusted R:R gate is disabled for them.
      const timeExitOnly = pendingSignal.timeExitOnly === true;
      const sentinelTarget = timeExitOnly && pendingSignal.sl
        ? (isBuy
            ? fillPrice + 1000 * Math.abs(fillPrice - pendingSignal.sl)
            : Math.max(0.01, fillPrice - 0.999 * fillPrice))
        : pendingSignal.target;
      const sizing = risk.sizeTrade({
        side: pendingSignal.action,
        entry: fillPrice,
        sl: pendingSignal.sl,
        target: sentinelTarget,
        lotMultiplier,
        segment,
        maxLossTotal,
        minNetRR: timeExitOnly ? 0 : minNetRR,
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
          atr: pendingSignal.atr,
          maxHoldBars: pendingSignal.maxHoldBars || null,
          timeExitOnly
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

      // 2a. Time-based exits (fill at this bar's OPEN, with slippage; no lookahead).
      //     - maxHoldBars: signal-specified holding period
      //     - eodSquareOffMinuteIST: forced intraday square-off (minutes since 00:00 IST)
      //     - session rollover: never carry a position across trading days
      if (i > openTrade.entryBarIndex) {
        const istMs = currentBar.time + 5.5 * 3600 * 1000;
        const barDay = new Date(istMs).toISOString().slice(0, 10);
        const entryDay = new Date(openTrade.entryTime + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
        const minuteOfDay = new Date(istMs).getUTCHours() * 60 + new Date(istMs).getUTCMinutes();
        let timeReason = null;
        if (barDay !== entryDay) timeReason = 'SESSION_ROLLOVER_EXIT';
        else if (eodSquareOffMinuteIST != null && minuteOfDay >= eodSquareOffMinuteIST) timeReason = 'EOD_SQUARE_OFF';
        else if (openTrade.maxHoldBars && (i - openTrade.entryBarIndex) >= openTrade.maxHoldBars) timeReason = 'TIME_EXIT';
        if (timeReason) {
          exitPrice = isLong
            ? currentBar.open - (slippageTicks * tickSize)
            : currentBar.open + (slippageTicks * tickSize);
          exitReason = timeReason;
        }
      }

      const slHit = exitPrice === null && (isLong ? (currentBar.low <= openTrade.stopLoss) : (currentBar.high >= openTrade.stopLoss));
      const tpHit = exitPrice === null && !openTrade.timeExitOnly && (isLong ? (currentBar.high >= openTrade.target) : (currentBar.low <= openTrade.target));

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
      const sig = signalAtIndex
        ? signalAtIndex(i, candles)
        : signalFn(candles.slice(0, i + 1));
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
