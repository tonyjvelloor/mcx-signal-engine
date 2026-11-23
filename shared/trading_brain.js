/**
 * shared/trading_brain.js — Self-Auditing Market Regime & Execution Quality Brain
 *
 * Gives the trading engine a closed-loop self-awareness layer:
 *   1. Market Regime Brain: Classifies live NSE into BULL_TREND, RANGE_CHOP, BEAR_DRIFT, or HIGH_VOL_PANIC
 *      using official NSE MCP live index change, breadth, and multi-day index trend.
 *   2. MFE / MAE Execution Auditor: Tracks Max Favorable Excursion (MFE) & Max Adverse Excursion (MAE)
 *      in R-multiples for every open & closed trade in SQLite, diagnosing premature exits or chasing entries.
 *   3. Self-Tuning Auto-Bench Allocator: Automatically benches symbols with >=2 consecutive losses or
 *      negative rolling expectancy, and scales risk size dynamically by regime & drawdown.
 */

function ensureBrainTables(db) {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS trade_execution_audit (
      trade_id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      init_sl REAL NOT NULL,
      target REAL DEFAULT 0,
      mfe_price REAL NOT NULL,
      mae_price REAL NOT NULL,
      mfe_r REAL DEFAULT 0,
      mae_r REAL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS brain_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_ist TEXT NOT NULL,
      regime TEXT NOT NULL,
      execution_score INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Updates live MFE (Max Favorable Excursion) & MAE (Max Adverse Excursion) in R-multiples
 * for every open paper trade on each 60s Auto-Pilot tick.
 */
function updateTradeExcursions(db, openTrades = [], latestPrices = {}) {
  if (!db || !Array.isArray(openTrades) || openTrades.length === 0) return [];
  ensureBrainTables(db);
  const updated = [];

  for (const t of openTrades) {
    const sym = String(t.symbol || '').toUpperCase();
    const pxObj = latestPrices[sym];
    const ltp = Number(pxObj?.price || t.liveLtp || 0);
    if (!(ltp > 0)) continue;

    const entry = Number(t.entry_price || 0);
    const sl = Number(t.stop_loss || 0);
    const initRisk = Math.max(entry * 0.005, Math.abs(entry - sl));
    const isBuy = String(t.side).toUpperCase() === 'BUY';

    const existing = db.prepare(`SELECT * FROM trade_execution_audit WHERE trade_id = ?`).get(t.id);
    let mfePrice = existing ? Number(existing.mfe_price) : entry;
    let maePrice = existing ? Number(existing.mae_price) : entry;
    const savedInitSl = existing ? Number(existing.init_sl) : sl;
    const riskUnit = Math.max(entry * 0.005, Math.abs(entry - savedInitSl) || initRisk);

    if (isBuy) {
      if (ltp > mfePrice) mfePrice = ltp;
      if (ltp < maePrice) maePrice = ltp;
    } else {
      if (ltp < mfePrice) mfePrice = ltp;
      if (ltp > maePrice) maePrice = ltp;
    }

    const mfeR = +((isBuy ? (mfePrice - entry) : (entry - mfePrice)) / riskUnit).toFixed(2);
    const maeR = +((isBuy ? (entry - maePrice) : (maePrice - entry)) / riskUnit).toFixed(2);

    db.prepare(`
      INSERT INTO trade_execution_audit (trade_id, symbol, side, entry_price, init_sl, target, mfe_price, mae_price, mfe_r, mae_r, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(trade_id) DO UPDATE SET
        mfe_price = excluded.mfe_price,
        mae_price = excluded.mae_price,
        mfe_r = excluded.mfe_r,
        mae_r = excluded.mae_r,
        updated_at = CURRENT_TIMESTAMP
    `).run(t.id, sym, t.side, entry, savedInitSl, Number(t.target || 0), mfePrice, maePrice, mfeR, maeR);

    updated.push({ tradeId: t.id, symbol: sym, mfeR, maeR });
  }
  return updated;
}

/**
 * Layer 1: Market Regime Brain
 * Classifies live NSE market into BULL_TREND, RANGE_CHOP, BEAR_DRIFT, or HIGH_VOL_PANIC.
 */
function classifyMarketRegime({ nseMcpOverview = null } = {}) {
  const n50Pct = Number(nseMcpOverview?.nifty50?.percChange ?? 0);
  const nBkPct = Number(nseMcpOverview?.niftyBank?.percChange ?? 0);
  const advPct = Number(nseMcpOverview?.breadth?.advPct ?? 50);
  const hasLive = Boolean(nseMcpOverview && (nseMcpOverview.nifty50 || nseMcpOverview.breadth));

  if (!hasLive) {
    return {
      regime: 'NEUTRAL_WAIT',
      confidence: 50,
      niftyPct: 0,
      bankPct: 0,
      advPct: 50,
      allowNewLongs: true,
      allowNewShorts: true,
      allowBreakouts: true,
      preferCncSwing: true,
      sizeMultiplier: 1.0,
      directive: 'Awaiting live NSE tape — normal risk guardrails active.'
    };
  }

  if (n50Pct <= -1.45 || advPct <= 24) {
    return {
      regime: 'HIGH_VOL_PANIC',
      confidence: 90,
      niftyPct: n50Pct,
      bankPct: nBkPct,
      advPct,
      allowNewLongs: false,
      allowNewShorts: true,
      allowBreakouts: false,
      preferCncSwing: false,
      sizeMultiplier: 0.5,
      directive: `Panic sell-off (Nifty ${n50Pct}%, Adv ${advPct}%): Blocking all new longs & breakouts; capital preservation at 50% size.`
    };
  }

  if (n50Pct <= -0.45 && advPct < 43) {
    return {
      regime: 'BEAR_DRIFT',
      confidence: 78,
      niftyPct: n50Pct,
      bankPct: nBkPct,
      advPct,
      allowNewLongs: false,
      allowNewShorts: true,
      allowBreakouts: false,
      preferCncSwing: false,
      sizeMultiplier: 0.75,
      directive: `Bearish drift (Nifty ${n50Pct}%, Adv ${advPct}%): Blocking intraday longs; favoring short setups & defensive 75% sizing.`
    };
  }

  if (n50Pct >= 0.35 && advPct >= 54) {
    return {
      regime: 'BULL_TREND',
      confidence: 82,
      niftyPct: n50Pct,
      bankPct: nBkPct,
      advPct,
      allowNewLongs: true,
      allowNewShorts: false,
      allowBreakouts: true,
      preferCncSwing: true,
      sizeMultiplier: 1.0,
      directive: `Bullish trend (Nifty +${n50Pct}%, Adv ${advPct}%): Full size on proven Nifty-50 CNC Swing Champions & momentum longs.`
    };
  }

  return {
    regime: 'RANGE_CHOP',
    confidence: 70,
    niftyPct: n50Pct,
    bankPct: nBkPct,
    advPct,
    allowNewLongs: true,
    allowNewShorts: true,
    allowBreakouts: false,
    preferCncSwing: true,
    sizeMultiplier: 0.75,
    directive: `Sideways chop (Nifty ${n50Pct >= 0 ? '+' : ''}${n50Pct}%, Adv ${advPct}%): Pausing weak breakouts; favoring Mean-Reversion & CNC Champions at 75% size.`
  };
}

/**
 * Layer 2 & 3: Execution Quality Auditor (MFE/MAE) + Auto-Bench Allocator
 */
function auditExecutionQuality(db) {
  if (!db) {
    return {
      executionScore: 70,
      closedCount: 0,
      winRate: 0,
      profitFactor: 0,
      netPnlRs: 0,
      feeDragPct: 0,
      avgMfeR: 0,
      avgMaeR: 0,
      reversingWinners: 0,
      autoBenchedSymbols: [],
      diagnoses: ['No closed trades yet — Brain collecting execution telemetry.']
    };
  }

  ensureBrainTables(db);
  const closed = db.prepare(`
    SELECT p.*, a.mfe_r, a.mae_r
    FROM paper_trades p
    LEFT JOIN trade_execution_audit a ON a.trade_id = p.id
    WHERE p.status != 'OPEN' AND p.symbol NOT LIKE '%TEST%'
    ORDER BY p.id DESC
    LIMIT 100
  `).all();

  if (closed.length === 0) {
    return {
      executionScore: 75,
      closedCount: 0,
      winRate: 0,
      profitFactor: 0,
      netPnlRs: 0,
      feeDragPct: 0,
      avgMfeR: 0,
      avgMaeR: 0,
      reversingWinners: 0,
      autoBenchedSymbols: [],
      diagnoses: ['Fresh slate — Brain armed to track MFE/MAE & auto-bench underperformers.']
    };
  }

  let wins = 0, grossWin = 0, grossLoss = 0, totalFees = 0, netPnl = 0;
  let mfeSum = 0, maeSum = 0, mfeCount = 0, reversingWinners = 0;
  const bySym = {};

  for (const t of closed) {
    const pnl = Number(t.net_pnl || 0);
    const fees = Number(t.brokerage || 0) + Number(t.stt_gst || 0);
    totalFees += fees;
    netPnl += pnl;
    if (pnl > 0) { wins++; grossWin += pnl; }
    else if (pnl < 0) { grossLoss += Math.abs(pnl); }

    if (t.mfe_r != null && isFinite(Number(t.mfe_r))) {
      const mfe = Number(t.mfe_r);
      const mae = Number(t.mae_r || 0);
      mfeSum += mfe;
      maeSum += mae;
      mfeCount++;
      if (mfe >= 1.0 && pnl < 0) reversingWinners++;
    }

    const sym = String(t.symbol || '').toUpperCase();
    if (!bySym[sym]) bySym[sym] = [];
    bySym[sym].push(pnl);
  }

  const closedCount = closed.length;
  const winRate = Math.round((wins / closedCount) * 100);
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 5.0 : 0);
  const feeDragPct = grossWin > 0 ? +((totalFees / grossWin) * 100).toFixed(1) : (totalFees > 0 ? 100 : 0);
  const avgMfeR = mfeCount > 0 ? +(mfeSum / mfeCount).toFixed(2) : 0;
  const avgMaeR = mfeCount > 0 ? +(maeSum / mfeCount).toFixed(2) : 0;

  // Auto-Bench any stock with 2+ consecutive recent losses OR (3+ trades and net loss < -120)
  const autoBenchedSymbols = [];
  for (const [sym, pnls] of Object.entries(bySym)) {
    const lastTwoLosses = pnls.length >= 2 && pnls[0] < 0 && pnls[1] < 0;
    const symNet = pnls.reduce((a, b) => a + b, 0);
    const chronicLoser = pnls.length >= 3 && symNet < -120;
    if (lastTwoLosses || chronicLoser) {
      autoBenchedSymbols.push({
        symbol: sym,
        trades: pnls.length,
        netPnl: +symNet.toFixed(2),
        reason: lastTwoLosses ? '2 consecutive losses' : `Rolling net loss ₹${symNet.toFixed(0)}`
      });
    }
  }

  // Compute Execution Quality Score (0-100)
  let score = 50;
  score += Math.min(25, Math.max(-25, (winRate - 50) * 0.7));
  score += Math.min(20, Math.max(-20, (profitFactor - 1.0) * 18));
  if (feeDragPct > 40) score -= 12;
  if (reversingWinners >= 2) score -= 10;
  const executionScore = Math.max(10, Math.min(98, Math.round(score)));

  const diagnoses = [];
  if (reversingWinners >= 1) {
    diagnoses.push(`${reversingWinners} trade(s) reached ≥+1.0R then reversed to a loss — keep +0.70R ratchet strict.`);
  }
  if (feeDragPct > 35) {
    diagnoses.push(`High fee drag (${feeDragPct}% of gross wins) — shift more entries to ₹0-brokerage CNC Swing Champions.`);
  }
  if (autoBenchedSymbols.length > 0) {
    diagnoses.push(`Auto-benched ${autoBenchedSymbols.map(b => b.symbol).join(', ')} due to recent loss streaks.`);
  }
  if (diagnoses.length === 0) {
    diagnoses.push(`Execution healthy (${winRate}% WR · PF ${profitFactor}x · Avg MFE ${avgMfeR}R / MAE ${avgMaeR}R).`);
  }

  return {
    executionScore,
    closedCount,
    winRate,
    profitFactor,
    netPnlRs: +netPnl.toFixed(2),
    feeDragPct,
    avgMfeR,
    avgMaeR,
    reversingWinners,
    autoBenchedSymbols,
    diagnoses
  };
}

/**
 * Full Brain Evaluation combining Regime + Execution Audit + Nifty-50 2.5Y Champions
 */
function evaluateBrainState({ db = null, nseMcpOverview = null, swingBacktestData = null } = {}) {
  const regime = classifyMarketRegime({ nseMcpOverview });
  const execution = auditExecutionQuality(db);
  const benchedSet = new Set(execution.autoBenchedSymbols.map(b => b.symbol));
  const champions = (swingBacktestData?.provenChampions || []).filter(sym => !benchedSet.has(sym));

  return {
    updatedAt: new Date().toISOString(),
    regime,
    execution,
    activeChampions: champions,
    totalChampionsAvailable: swingBacktestData?.provenChampionsCount || 0,
    benchedCount: execution.autoBenchedSymbols.length
  };
}

module.exports = {
  ensureBrainTables,
  updateTradeExcursions,
  classifyMarketRegime,
  auditExecutionQuality,
  evaluateBrainState
};
