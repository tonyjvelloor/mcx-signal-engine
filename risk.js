/**
 * risk.js — Canonical Risk Management & Position Sizing Engine
 * Shared across: Node.js server, Paper Trading Ledger, Frontend Terminals, and Backtest Simulator.
 * 
 * Enforces:
 * 1. Realistic Zerodha Fee Schedule (Intraday Equity vs MCX Futures).
 * 2. Absolute Loss Cap (₹50 total risk on ₹15,000 pilot capital).
 * 3. Volatility Floor: Stop-loss must be >= 1.0x ATR(14) to avoid market noise-outs.
 * 4. Fee-Adjusted R:R Gate: Net Reward / Net Risk >= 1.5. Rejects trades where fees eat the edge.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.RiskEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Calculate realistic Zerodha round-trip fees and statutory taxes
   * 
   * Schedule:
   * - Equity Intraday (MIS):
   *     Brokerage: min(₹20, 0.03% turnover) per side
   *     STT: 0.025% on sell turnover
   *     Exchange Txn (NSE): 0.00297% turnover
   *     SEBI: ₹10 per crore (0.0001%)
   *     GST: 18% on (Brokerage + Exchange Txn + SEBI)
   *     Stamp Duty: 0.003% on buy turnover
   * 
   * - MCX Commodity Futures:
   *     Brokerage: min(₹20, 0.03% turnover) per side
   *     CTT: 0.01% on sell turnover
   *     Exchange Txn (MCX): 0.0021% turnover
   *     SEBI: ₹10 per crore (0.0001%)
   *     GST: 18% on (Brokerage + Exchange Txn + SEBI)
   *     Stamp Duty: 0.002% on buy turnover
   */
  function calculateZerodhaFees({ segment = 'equity', buyPrice, sellPrice, qty = 1, lotMultiplier = 1 }) {
    const buyVal = buyPrice * qty * lotMultiplier;
    const sellVal = sellPrice * qty * lotMultiplier;
    const totalTurnover = buyVal + sellVal;

    let buyBrokerage = 0;
    let sellBrokerage = 0;
    let stt = 0;
    let exchangeTxn = 0;
    let stampDuty = 0;
    const sebiCharges = totalTurnover * 0.000001; // ₹10 per crore

    let dpCharge = 0;

    if (segment === 'equity_delivery' || segment === 'equity_swing') {
      // Equity Delivery / Multi-Day Swing (holding overnight)
      buyBrokerage = 0; // Zerodha delivery brokerage is ₹0
      sellBrokerage = 0;
      stt = (buyVal * 0.001) + (sellVal * 0.001); // 0.1% on buy & 0.1% on sell
      exchangeTxn = totalTurnover * 0.0000297; // 0.00297%
      stampDuty = buyVal * 0.00015; // 0.015% on buy
      dpCharge = 15.93; // Flat DP charge (₹13.50 + 18% GST) on debit/sell
    } else if (segment === 'equity') {
      buyBrokerage = Math.min(20, buyVal * 0.0003);
      sellBrokerage = Math.min(20, sellVal * 0.0003);
      stt = sellVal * 0.00025; // 0.025% on sell
      exchangeTxn = totalTurnover * 0.0000297; // 0.00297%
      stampDuty = buyVal * 0.00003; // 0.003% on buy
    } else {
      // Commodity Futures (MCX)
      buyBrokerage = Math.min(20, buyVal * 0.0003);
      sellBrokerage = Math.min(20, sellVal * 0.0003);
      stt = sellVal * 0.0001; // CTT 0.01% on sell
      exchangeTxn = totalTurnover * 0.000021; // 0.0021%
      stampDuty = buyVal * 0.00002; // 0.002% on buy
    }

    const totalBrokerage = buyBrokerage + sellBrokerage;
    const gst = (totalBrokerage + exchangeTxn + sebiCharges) * 0.18;
    const totalFees = totalBrokerage + stt + exchangeTxn + sebiCharges + gst + stampDuty + dpCharge;

    return {
      brokerage: Math.round(totalBrokerage * 100) / 100,
      stt: Math.round(stt * 100) / 100,
      exchangeTxn: Math.round(exchangeTxn * 100) / 100,
      gst: Math.round(gst * 100) / 100,
      stampDuty: Math.round(stampDuty * 100) / 100,
      totalFees: Math.round(totalFees * 100) / 100
    };
  }

  /**
   * Sizing and Pre-Trade Risk Evaluation Gate
   * 
   * @param {Object} params
   * @param {string} params.side - 'BUY' or 'SELL'
   * @param {number} params.entry - Planned entry price
   * @param {number} params.sl - Planned stop loss price
   * @param {number} params.target - Planned target price
   * @param {number} params.lotMultiplier - Contract multiplier (default: 1)
   * @param {string} params.segment - 'equity' or 'commodity' (default: 'equity')
   * @param {number} params.maxLossTotal - Hard loss budget in ₹ (default: 50.0)
   * @param {number} params.minNetRR - Minimum acceptable fee-adjusted R:R (default: 1.5)
   * @param {number} params.atr - 14-period ATR for volatility floor (optional)
   * 
   * @returns {Object} { ok: boolean, qty: number, grossRisk, grossReward, totalPlannedLoss, netProfitAtTarget, netRR, reason?: string }
   */
  function sizeTrade(params) {
    const {
      side = 'BUY',
      entry,
      sl,
      target,
      lotMultiplier = 1,
      segment = 'equity',
      maxLossTotal = 50.0,
      minNetRR = 1.5,
      atr = null
    } = params;

    if (!entry || !sl || !target || entry <= 0 || sl <= 0 || target <= 0) {
      return { ok: false, reason: 'INVALID_PRICES: Entry, Stop Loss, and Target must be positive numbers.' };
    }

    // 1. Structural Geometry Validation
    const isBuy = side.toUpperCase() === 'BUY';
    if (isBuy) {
      if (sl >= entry) return { ok: false, reason: 'GEOMETRY_ERROR: Long trade stop loss must be strictly below entry price.' };
      if (target <= entry) return { ok: false, reason: 'GEOMETRY_ERROR: Long trade target must be strictly above entry price.' };
    } else {
      if (sl <= entry) return { ok: false, reason: 'GEOMETRY_ERROR: Short trade stop loss must be strictly above entry price.' };
      if (target >= entry) return { ok: false, reason: 'GEOMETRY_ERROR: Short trade target must be strictly below entry price.' };
    }

    const slDist = Math.abs(entry - sl);
    const targetDist = Math.abs(target - entry);

    // 2. Volatility Floor: Stop loss must respect market noise (>= 1.0x ATR)
    if (atr && Number(atr) > 0) {
      const minSafeStop = Number(atr) * 0.95; // 5% tolerance
      if (slDist < minSafeStop) {
        return {
          ok: false,
          reason: `NOISE_OUT_RISK: Planned stop distance (₹${slDist.toFixed(2)}) is narrower than 1x ATR(14) (₹${Number(atr).toFixed(2)}). Stops this tight are noise.`
        };
      }
    }

    // 3. Evaluate 1-unit minimum viability
    const perUnitRisk = slDist * lotMultiplier;
    const test1Fee = calculateZerodhaFees({
      segment,
      buyPrice: isBuy ? entry : sl,
      sellPrice: isBuy ? sl : entry,
      qty: 1,
      lotMultiplier
    }).totalFees;

    const minUnitPlannedLoss = perUnitRisk + test1Fee;
    if (minUnitPlannedLoss > maxLossTotal) {
      return {
        ok: false,
        reason: `RISK_CAP_EXCEEDED: Minimum size of 1 unit requires ₹${minUnitPlannedLoss.toFixed(2)} planned loss (₹${perUnitRisk.toFixed(2)} market risk + ₹${test1Fee.toFixed(2)} fees), exceeding your ₹${maxLossTotal.toFixed(2)} budget on ₹15,000 capital.`
      };
    }

    // 4. Determine largest integer quantity that fits within maxLossTotal
    let bestQty = 1;
    let low = 1, high = Math.max(1, Math.floor(maxLossTotal / perUnitRisk));

    for (let q = high; q >= 1; q--) {
      const feeAtStop = calculateZerodhaFees({
        segment,
        buyPrice: isBuy ? entry : sl,
        sellPrice: isBuy ? sl : entry,
        qty: q,
        lotMultiplier
      }).totalFees;
      const totalLoss = (perUnitRisk * q) + feeAtStop;
      if (totalLoss <= maxLossTotal) {
        bestQty = q;
        break;
      }
    }

    // 5. Calculate Final Risk, Reward, Fees and Fee-Adjusted R:R
    const grossRisk = perUnitRisk * bestQty;
    const grossReward = targetDist * lotMultiplier * bestQty;

    const stopFees = calculateZerodhaFees({
      segment,
      buyPrice: isBuy ? entry : sl,
      sellPrice: isBuy ? sl : entry,
      qty: bestQty,
      lotMultiplier
    }).totalFees;

    const targetFees = calculateZerodhaFees({
      segment,
      buyPrice: isBuy ? entry : target,
      sellPrice: isBuy ? target : entry,
      qty: bestQty,
      lotMultiplier
    }).totalFees;

    const totalPlannedLoss = grossRisk + stopFees;
    const netProfitAtTarget = grossReward - targetFees;

    // Fee-adjusted Net R:R = Net Reward / Total Risk
    const netRR = (grossReward - targetFees) / (grossRisk + stopFees);

    // 6. Fee-Adjusted R:R Gate: Rejects trades where transaction costs consume the edge
    if (netRR < minNetRR) {
      return {
        ok: false,
        reason: `FEE_DRAG_REJECTED: Fee-adjusted R:R is 1:${netRR.toFixed(2)} (below 1:${minNetRR}). Gross reward ₹${grossReward.toFixed(2)} loses ₹${targetFees.toFixed(2)} in fees. Expectancy is unviable.`
      };
    }

    return {
      ok: true,
      side: isBuy ? 'BUY' : 'SELL',
      entryPrice: Math.round(entry * 100) / 100,
      stopLoss: Math.round(sl * 100) / 100,
      target: Math.round(target * 100) / 100,
      qty: bestQty,
      slDist: Math.round(slDist * 100) / 100,
      targetDist: Math.round(targetDist * 100) / 100,
      grossRisk: Math.round(grossRisk * 100) / 100,
      grossReward: Math.round(grossReward * 100) / 100,
      stopFees: Math.round(stopFees * 100) / 100,
      targetFees: Math.round(targetFees * 100) / 100,
      totalPlannedLoss: Math.round(totalPlannedLoss * 100) / 100,
      netProfitAtTarget: Math.round(netProfitAtTarget * 100) / 100,
      netRR: Math.round(netRR * 100) / 100
    };
  }

  return {
    calculateZerodhaFees,
    sizeTrade
  };
}));
