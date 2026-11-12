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
      refDate
    } = params;

    const d = refDate ? new Date(refDate) : new Date();
    const todayIST = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    // Filter closed trades executed today in IST
    const todayClosedTrades = trades.filter(t => {
      if (t.pnl == null && t.netPnl == null) return false;
      const tDate = t.date || (t.timestamp ? new Date(t.timestamp).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : null);
      if (!tDate) return true; // Include if date was omitted or caller pre-filtered
      return tDate === todayIST;
    });

    let dailyNetPnl = 0;
    let consecutiveLosses = 0;

    // Evaluate in chronological order
    const chrono = todayClosedTrades.slice().reverse();
    for (const t of chrono) {
      const pnl = Number(t.pnl != null ? t.pnl : (t.netPnl || 0));
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
        remainingLossBudget: Math.round(remainingBudget * 100) / 100,
        message: `🛡️ CIRCUIT BREAKER: ${consecutiveLosses} consecutive losses recorded today (P&L: -₹${Math.abs(dailyNetPnl).toFixed(2)}). Session locked to eliminate revenge trading.`
      };
    }

    return {
      tripped: false,
      dailyNetPnl: Math.round(dailyNetPnl * 100) / 100,
      consecutiveLosses,
      remainingLossBudget: Math.round(remainingBudget * 100) / 100,
      message: 'Active (Within safe daily risk thresholds)'
    };
  }

  return {
    evaluateCircuitBreaker
  };
}));
