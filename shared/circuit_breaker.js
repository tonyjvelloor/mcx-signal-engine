/**
 * shared/circuit_breaker.js — Automated Daily Risk Circuit Breaker & Anti-Revenge Trading Guard
 * Locks execution when daily loss limit is reached or 2 consecutive losses occur.
 * Eliminates revenge trading, emotional sizing escalation, and intraday account blowups.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.CircuitBreaker = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Evaluates if the trading session must be halted due to daily drawdown or consecutive loss limits.
   * 
   * @param {Object} params
   * @param {Array} params.trades - array of journal/closed trade objects
   * @param {number} [params.dailyLossLimit=400] - maximum allowed loss in ₹ for the day (e.g. 2.6% of ₹15k)
   * @param {number} [params.maxConsecutiveLosses=2] - maximum consecutive losing trades allowed
   * @param {Date} [params.refDate] - optional date, defaults to today in IST
   * @returns {Object} { tripped: boolean, reason?: string, message?: string, dailyNetPnl: number, consecutiveLosses: number, remainingLossBudget: number }
   */
  function evaluateCircuitBreaker(params = {}) {
    const {
      trades = [],
      dailyLossLimit = 400.0,
      maxConsecutiveLosses = 2,
      maxDailyTrades = 3,
      refDate
    } = params;

    const d = refDate ? new Date(refDate) : new Date();
    const todayIST = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    // Count all trades placed today in IST (open or closed) for daily frequency cap
    const todayAllTrades = trades.filter(t => {
      const rawTs = t.timestamp || t.entry_time || t.exit_time || t.created_at;
      const tDate = t.date || (rawTs ? new Date(rawTs).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : null);
      if (!tDate) return true;
      return tDate === todayIST;
    });
    const todayTradeCount = todayAllTrades.length;

    // Filter closed trades executed today in IST
    const todayClosedTrades = todayAllTrades.filter(t => {
      const rawPnl = t.pnl ?? t.netPnl ?? t.net_pnl;
      return rawPnl != null;
    });

    let dailyNetPnl = 0;
    let consecutiveLosses = 0;

    // Evaluate in true chronological order (supports both SQLite ASC and UI DESC arrays)
    const hasIds = todayClosedTrades.length >= 2 && todayClosedTrades.every(t => t.id != null);
    const chrono = hasIds
      ? todayClosedTrades.slice().sort((a, b) => Number(a.id) - Number(b.id))
      : todayClosedTrades.slice().reverse();
    for (const t of chrono) {
      const pnl = Number(t.pnl ?? t.netPnl ?? t.net_pnl ?? 0);
      dailyNetPnl += pnl;

      if (pnl < 0) {
        consecutiveLosses++;
      } else if (pnl > 0) {
        consecutiveLosses = 0; // Reset consecutive loss counter on a win
      }
    }

    const remainingBudget = Math.max(0, dailyLossLimit + dailyNetPnl);

    // 1. Check Daily Drawdown Limit
    if (dailyNetPnl <= -dailyLossLimit) {
      return {
        tripped: true,
        reason: 'DAILY_LOSS_LIMIT_REACHED',
        dailyNetPnl: Math.round(dailyNetPnl * 100) / 100,
        consecutiveLosses,
        todayTradeCount,
        maxDailyTrades,
        remainingLossBudget: 0,
        message: `🛡️ CIRCUIT BREAKER: Daily loss limit reached (-₹${Math.abs(dailyNetPnl).toFixed(2)} on ₹${dailyLossLimit.toFixed(2)} limit). Trading halted to protect capital.`
      };
    }

    // 2. Check Consecutive Loss Limit
    if (consecutiveLosses >= maxConsecutiveLosses) {
      return {
        tripped: true,
        reason: 'MAX_CONSECUTIVE_LOSSES_REACHED',
        dailyNetPnl: Math.round(dailyNetPnl * 100) / 100,
        consecutiveLosses,
        todayTradeCount,
        maxDailyTrades,
        remainingLossBudget: Math.round(remainingBudget * 100) / 100,
        message: `🛡️ CIRCUIT BREAKER: ${consecutiveLosses} consecutive losses recorded today (P&L: -₹${Math.abs(dailyNetPnl).toFixed(2)}). Session locked to eliminate revenge trading.`
      };
    }

    // 3. Check Daily Order-Frequency Cap (prevents choppy overtrading & fee erosion)
    if (maxDailyTrades > 0 && todayTradeCount >= maxDailyTrades) {
      return {
        tripped: true,
        reason: 'MAX_DAILY_TRADES_REACHED',
        dailyNetPnl: Math.round(dailyNetPnl * 100) / 100,
        consecutiveLosses,
        todayTradeCount,
        maxDailyTrades,
        remainingLossBudget: Math.round(remainingBudget * 100) / 100,
        message: `🛡️ CIRCUIT BREAKER: Daily order cap (${todayTradeCount}/${maxDailyTrades} trades) reached. Stopping to prevent choppy overtrading & fee erosion.`
      };
    }

    return {
      tripped: false,
      dailyNetPnl: Math.round(dailyNetPnl * 100) / 100,
      consecutiveLosses,
      todayTradeCount,
      maxDailyTrades,
      remainingLossBudget: Math.round(remainingBudget * 100) / 100,
      message: 'Active (Within safe daily risk thresholds)'
    };
  }

  return {
    evaluateCircuitBreaker
  };
}));
