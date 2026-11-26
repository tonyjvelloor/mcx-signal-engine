'use strict';

const CDSL_CNC_DP_CHARGE_RS = 15.34;

const MCX_PROXY_MARGIN_EST = {
  GOLDM: 6750,
  SILVERMIC: 5500,
  CRUDEOILM: 6000,
  NATGASM: 4500,
  COPPER: 5000
};

function classifyBucketFromRow(row) {
  const r = String(row?.exit_reason || '').toUpperCase();
  const sym = String(row?.symbol || '').toUpperCase();
  if (r.includes('CNC_WASHOUT')) return 'ALL_WEATHER_WASHOUT';
  if (r.includes('CNC_GOLD') || sym === 'GOLDBEES') return 'ALL_WEATHER_GOLD';
  if (r.includes('CNC_SWING')) return 'CNC_SWING';
  if (sym.includes('GOLDM') || sym.includes('SILVER') || sym.includes('CRUDE') || sym.includes('NATGAS') || sym.includes('COPPER')) {
    return 'MCX_COMMODITY';
  }
  return 'MIS_INTRADAY';
}

function getMcxLotMultiplier(sym) {
  const s = String(sym || '').toUpperCase();
  if (s.includes('GOLDM')) return 10;
  if (s.includes('SILVERMIC')) return 1;
  if (s.includes('CRUDEOILM')) return 10;
  if (s.includes('NATGASM')) return 250;
  if (s.includes('COPPER')) return 2500;
  return 1;
}

/**
 * P0.1 & P0.2: Single Source of Truth for Portfolio Capital & Cross-Engine Exposure.
 * Reconciles All-Weather CNC, CNC Swing, NSE MIS, and MCX against one shared ₹15K+ equity pool.
 */
function computePortfolioCapitalLedger(db, baseCapital = 15000) {
  const baseCap = Number(baseCapital) || 15000;
  if (!db) {
    return {
      baseCapital: baseCap,
      realizedNetPnl: 0,
      totalEquity: baseCap,
      lockedCncCash: 0,
      lockedMisMargin: 0,
      lockedMcxMargin: 0,
      totalLocked: 0,
      freeCash: baseCap,
      utilizationPct: 0,
      openCount: 0,
      openSymbols: [],
      hasGoldOpen: false
    };
  }

  let realizedNetPnl = 0;
  let openRows = [];
  try {
    const realized = db.prepare(`
      SELECT COALESCE(SUM(net_pnl), 0) AS pnl
      FROM paper_trades
      WHERE status != 'OPEN' AND symbol NOT LIKE '%TEST%'
    `).get();
    realizedNetPnl = +(Number(realized?.pnl || 0)).toFixed(2);
    openRows = db.prepare(`SELECT * FROM paper_trades WHERE status = 'OPEN' AND symbol NOT LIKE '%TEST%'`).all();
  } catch (_) {}

  const totalEquity = +(Math.max(1000, baseCap + realizedNetPnl)).toFixed(2);
  let lockedCncCash = 0;
  let lockedMisMargin = 0;
  let lockedMcxMargin = 0;
  const openSymbols = new Set();
  let hasGoldOpen = false;

  for (const t of openRows) {
    const sym = String(t.symbol || '').toUpperCase();
    openSymbols.add(sym);
    if (sym.includes('GOLD')) hasGoldOpen = true;
    const bucket = classifyBucketFromRow(t);
    const notional = Number(t.entry_price || 0) * Number(t.qty || 1);

    if (bucket === 'CNC_SWING' || bucket === 'ALL_WEATHER_WASHOUT' || bucket === 'ALL_WEATHER_GOLD') {
      lockedCncCash += notional;
    } else if (bucket === 'MCX_COMMODITY') {
      const baseSym = Object.keys(MCX_PROXY_MARGIN_EST).find(k => sym.includes(k));
      lockedMcxMargin += baseSym ? MCX_PROXY_MARGIN_EST[baseSym] : Math.min(totalEquity * 0.45, 6000);
    } else {
      // Zerodha NSE MIS 5x intraday leverage
      lockedMisMargin += notional / 5;
    }
  }

  lockedCncCash = +lockedCncCash.toFixed(2);
  lockedMisMargin = +lockedMisMargin.toFixed(2);
  lockedMcxMargin = +lockedMcxMargin.toFixed(2);
  const totalLocked = +(lockedCncCash + lockedMisMargin + lockedMcxMargin).toFixed(2);
  const freeCash = +Math.max(0, totalEquity - totalLocked).toFixed(2);
  const utilizationPct = totalEquity > 0 ? Math.min(100, Math.round((totalLocked / totalEquity) * 100)) : 0;

  return {
    baseCapital: baseCap,
    realizedNetPnl,
    totalEquity,
    lockedCncCash,
    lockedMisMargin,
    lockedMcxMargin,
    totalLocked,
    freeCash,
    utilizationPct,
    openCount: openRows.length,
    openSymbols: Array.from(openSymbols),
    hasGoldOpen
  };
}

function classifyTradeDnaTag({ status, netPnl, grossPnl, totalCharges, mfeR, maeR, exitReason }) {
  if (status === 'OPEN') return 'ACTIVE';
  const r = String(exitReason || '').toUpperCase();
  if (netPnl > 0) {
    if (mfeR >= 1.2 && maeR <= 0.35) return 'SNIPER_WIN';
    if (r.includes('PROFIT_LOCK') || r.includes('RATCHET')) return 'PROFIT_LOCKED';
    return 'CLEAN_WIN';
  }
  if (grossPnl > 0 && netPnl <= 0) return 'FEE_DRAG_LOSS';
  if (mfeR >= 0.50 && netPnl <= 0) return 'REVERSED_WINNER';
  if (maeR >= 0.95 && totalCharges > 0) return 'CHOP_STOPOUT';
  return 'CONTROLLED_LOSS';
}

/**
 * Enriches every paper_trades row with Execution Audit (MFE/MAE), Signal Context
 * (Archetype, Regime, Session Window, Confidence, Claude Verdict), Gross vs Fees, and Lesson.
 */
function getEnrichedPaperTrades(db, { limit = 150 } = {}) {
  if (!db) return [];
  let rows = [];
  try {
    rows = db.prepare(`SELECT * FROM paper_trades ORDER BY id DESC LIMIT ?`).all(limit);
  } catch (_) {
    return [];
  }

  // Load lookup tables safely
  const auditByTradeId = new Map();
  try {
    const audits = db.prepare(`SELECT * FROM trade_execution_audit`).all();
    for (const a of audits) auditByTradeId.set(Number(a.trade_id), a);
  } catch (_) {}

  const sigByTradeId = new Map();
  try {
    const sigs = db.prepare(`
      SELECT paper_trade_id, archetype, regime, session_window, confidence, net_rr, claude_verdict
      FROM signal_audit_log WHERE paper_trade_id IS NOT NULL
    `).all();
    for (const s of sigs) sigByTradeId.set(Number(s.paper_trade_id), s);
  } catch (_) {}

  let lessons = [];
  try {
    lessons = db.prepare(`SELECT * FROM trade_lessons ORDER BY id DESC LIMIT 400`).all();
  } catch (_) {}

  return rows.map(t => {
    const audit = auditByTradeId.get(Number(t.id)) || null;
    const sig = sigByTradeId.get(Number(t.id)) || null;
    const bucket = classifyBucketFromRow(t);
    const totalCharges = +((Number(t.brokerage || 0) + Number(t.stt_gst || 0))).toFixed(2);
    const netPnl = t.net_pnl != null ? +Number(t.net_pnl).toFixed(2) : null;
    const grossPnl = netPnl != null ? +(netPnl + totalCharges).toFixed(2) : null;
    const feeDragPct = grossPnl && grossPnl > 0 ? Math.min(999, Math.round((totalCharges / grossPnl) * 100)) : null;

    let holdMinutes = null;
    if (t.entry_time && t.exit_time) {
      const ms = new Date(t.exit_time).getTime() - new Date(t.entry_time).getTime();
      if (Number.isFinite(ms) && ms >= 0) holdMinutes = Math.round(ms / 60000);
    }

    // Match closest lesson by symbol + side + netPnl
    const matchedLesson = lessons.find(l =>
      String(l.symbol || '').toUpperCase() === String(t.symbol || '').toUpperCase() &&
      String(l.side || '').toUpperCase() === String(t.side || '').toUpperCase() &&
      (netPnl == null || Math.abs(Number(l.net_pnl || 0) - netPnl) < 2.0)
    ) || null;

    const mfeR = audit?.mfe_r != null ? +Number(audit.mfe_r).toFixed(2) : null;
    const maeR = audit?.mae_r != null ? +Number(audit.mae_r).toFixed(2) : null;
    const dnaTag = classifyTradeDnaTag({
      status: t.status,
      netPnl: netPnl ?? 0,
      grossPnl: grossPnl ?? 0,
      totalCharges,
      mfeR: mfeR ?? 0,
      maeR: maeR ?? 0,
      exitReason: t.exit_reason
    });

    return {
      ...t,
      bucket,
      archetype: sig?.archetype || (bucket === 'CNC_SWING' ? 'SWING_CHAMPION' : 'TREND_RUNNER'),
      regime: sig?.regime || matchedLesson?.regime || 'LIVE',
      session_window: sig?.session_window || matchedLesson?.session_window || null,
      confidence: sig?.confidence != null ? Math.round(sig.confidence) : null,
      net_rr: sig?.net_rr != null ? +Number(sig.net_rr).toFixed(2) : null,
      claude_verdict: sig?.claude_verdict || null,
      mfe_r: mfeR,
      mae_r: maeR,
      gross_pnl: grossPnl,
      total_charges: totalCharges,
      fee_drag_pct: feeDragPct,
      hold_minutes: holdMinutes,
      dna_tag: dnaTag,
      lesson: matchedLesson?.lesson || null
    };
  });
}

/**
 * Extracts "Winning vs Losing Trade DNA" and actionable pattern rules from
 * closed paper trades + graded shadow signals so the system understands every trade.
 */
function analyzeTradeDNA(enrichedTrades = [], patternMemory = null) {
  const realClosed = enrichedTrades.filter(t => t.status !== 'OPEN' && !String(t.symbol || '').includes('TEST'));
  const winners = realClosed.filter(t => Number(t.net_pnl || 0) > 0);
  const losers = realClosed.filter(t => Number(t.net_pnl || 0) <= 0);

  const avg = (arr, fn) => arr.length ? +(arr.reduce((s, x) => s + fn(x), 0) / arr.length).toFixed(2) : 0;
  const winMfeList = winners.filter(w => w.mfe_r != null);
  const loseMfeList = losers.filter(l => l.mfe_r != null);
  const loseMaeList = losers.filter(l => l.mae_r != null);

  const reversedWinnersCount = losers.filter(l => l.dna_tag === 'REVERSED_WINNER').length;
  const feeDragLossesCount = losers.filter(l => l.dna_tag === 'FEE_DRAG_LOSS').length;
  const sniperWinsCount = winners.filter(w => w.dna_tag === 'SNIPER_WIN').length;

  const totalGross = +realClosed.reduce((s, t) => s + Number(t.gross_pnl || 0), 0).toFixed(2);
  const totalFees = +realClosed.reduce((s, t) => s + Number(t.total_charges || 0), 0).toFixed(2);
  const totalNet = +realClosed.reduce((s, t) => s + Number(t.net_pnl || 0), 0).toFixed(2);

  const groupBest = (keyFn) => {
    const map = {};
    for (const t of realClosed) {
      const k = keyFn(t);
      if (!k) continue;
      if (!map[k]) map[k] = { key: k, trades: 0, wins: 0, netPnl: 0 };
      map[k].trades++;
      if (Number(t.net_pnl || 0) > 0) map[k].wins++;
      map[k].netPnl = +(map[k].netPnl + Number(t.net_pnl || 0)).toFixed(2);
    }
    return Object.values(map).sort((a, b) => b.netPnl - a.netPnl);
  };

  const buckets = groupBest(t => t.bucket);
  const windows = groupBest(t => t.session_window);

  const activeRules = [];
  if (patternMemory && patternMemory.bySymbolSide) {
    for (const [k, st] of Object.entries(patternMemory.bySymbolSide)) {
      if (st.trades >= 3 && st.winRate >= 67 && st.netPnl > 0) {
        activeRules.push(`🚀 BOOST +6% conf / 1.15× size on ${k} (${st.wins}W/${st.losses}L, +₹${Math.round(st.netPnl)})`);
      } else if (st.trades >= 3 && st.winRate <= 25 && st.netPnl < 0) {
        activeRules.push(`🛡️ DAMPEN -10% conf / 0.50× size on ${k} (${st.wins}W/${st.losses}L, ₹${Math.round(st.netPnl)})`);
      }
    }
  }
  if (reversedWinnersCount >= 2) {
    activeRules.push(`⚡ ${reversedWinnersCount} losers reached ≥+0.50R MFE before reversing — +0.70R ratchet is protecting future winners.`);
  }
  if (feeDragLossesCount >= 1) {
    activeRules.push(`💸 ${feeDragLossesCount} trade(s) were green gross but red after Zerodha fees — Fee Hurdle Gate enforces ≥1.20 Net R:R.`);
  }

  return {
    closedCount: realClosed.length,
    winnersCount: winners.length,
    losersCount: losers.length,
    sniperWinsCount,
    reversedWinnersCount,
    feeDragLossesCount,
    avgWinnerMfeR: avg(winMfeList, x => Number(x.mfe_r || 0)),
    avgLoserMfeR: avg(loseMfeList, x => Number(x.mfe_r || 0)),
    avgLoserMaeR: avg(loseMaeList, x => Number(x.mae_r || 0)),
    avgWinnerRs: avg(winners, x => Number(x.net_pnl || 0)),
    avgLoserRs: avg(losers, x => Number(x.net_pnl || 0)),
    totalGrossPnl: totalGross,
    totalFees,
    totalNetPnl: totalNet,
    bestBucket: buckets[0] || null,
    bestWindow: windows[0] || null,
    worstWindow: windows.length > 1 ? windows[windows.length - 1] : null,
    activeRules: activeRules.slice(0, 6)
  };
}

/**
 * Builds an O(1) Pattern Memory lookup from closed paper_trades + graded live shadow signals
 * so the scanner learns from every outcome and actively tilts toward winning DNA.
 */
function buildPatternMemory(db) {
  const bySymbolSide = {};
  if (!db) return { bySymbolSide };

  const add = (sym, side, pnl) => {
    const k = `${String(sym || '').toUpperCase()}_${String(side || '').toUpperCase()}`;
    if (!bySymbolSide[k]) bySymbolSide[k] = { trades: 0, wins: 0, losses: 0, netPnl: 0, winRate: 0 };
    const b = bySymbolSide[k];
    b.trades++;
    if (pnl > 0) b.wins++;
    else b.losses++;
    b.netPnl = +(b.netPnl + pnl).toFixed(2);
    b.winRate = Math.round((b.wins / b.trades) * 100);
  };

  try {
    const closedTrades = db.prepare(`
      SELECT symbol, side, net_pnl FROM paper_trades
      WHERE status != 'OPEN' AND symbol NOT LIKE '%TEST%'
    `).all();
    for (const t of closedTrades) add(t.symbol, t.side, Number(t.net_pnl || 0));

    // Include graded forward shadow signals not already counted via paper_trade_id
    const shadows = db.prepare(`
      SELECT symbol, side, sim_net_pnl FROM signal_audit_log
      WHERE status != 'OPEN' AND source = 'LIVE_SCAN' AND paper_trade_id IS NULL
    `).all();
    for (const s of shadows) add(s.symbol, s.side, Number(s.sim_net_pnl || 0));
  } catch (_) {}

  return { bySymbolSide };
}

function evaluatePatternAdjustment(patternMemory, { symbol, side } = {}) {
  if (!patternMemory || !patternMemory.bySymbolSide || !symbol || !side) {
    return { confDelta: 0, sizeMult: 1.0, tag: 'NEUTRAL' };
  }
  const k = `${String(symbol).toUpperCase()}_${String(side).toUpperCase()}`;
  const st = patternMemory.bySymbolSide[k];
  if (!st || st.trades < 3) return { confDelta: 0, sizeMult: 1.0, tag: 'CALIBRATING' };

  if (st.winRate >= 67 && st.netPnl > 0) {
    return {
      confDelta: 6,
      sizeMult: 1.15,
      tag: 'PROVEN_WINNER_BOOST',
      reason: `${k} proven edge (${st.wins}W/${st.losses}L, +₹${Math.round(st.netPnl)})`
    };
  }
  if (st.winRate <= 25 && st.netPnl < 0) {
    return {
      confDelta: -10,
      sizeMult: 0.50,
      tag: 'LOSING_PATTERN_DAMPEN',
      reason: `${k} cold streak (${st.wins}W/${st.losses}L, ₹${Math.round(st.netPnl)})`
    };
  }
  return { confDelta: 0, sizeMult: 1.0, tag: 'NEUTRAL' };
}

module.exports = {
  CDSL_CNC_DP_CHARGE_RS,
  computePortfolioCapitalLedger,
  getEnrichedPaperTrades,
  analyzeTradeDNA,
  buildPatternMemory,
  evaluatePatternAdjustment,
  getMcxLotMultiplier
};
