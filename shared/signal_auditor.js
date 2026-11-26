'use strict';

const fs = require('fs');
const path = require('path');
const riskEngine = require('../risk');

const CDSL_CNC_DP_CHARGE_RS = 15.34;
const PAPER_SLIPPAGE_BPS = 4; // 0.04% realistic market-order slippage per side
const DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 minutes per symbol+side+decision

function getIstDateStr(date = new Date()) {
  const istMs = date.getTime() + 5.5 * 3600 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

function applySlippage(price, side, isEntry, bps = PAPER_SLIPPAGE_BPS) {
  const px = Number(price || 0);
  if (!px || bps <= 0) return px;
  const frac = bps / 10000;
  const isBuyOrder = (side === 'BUY' && isEntry) || (side === 'SELL' && !isEntry);
  const slipped = isBuyOrder ? px * (1 + frac) : px * (1 - frac);
  return Math.round(slipped * 100) / 100;
}

/**
 * Ensures the `signal_audit_log` SQLite table and indexes exist.
 * Purely observational — never modifies execution logic or live capital.
 */
function ensureSignalAuditSchema(db) {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      date_ist TEXT NOT NULL,
      symbol TEXT NOT NULL,
      asset_type TEXT NOT NULL DEFAULT 'STOCK',
      exchange TEXT NOT NULL DEFAULT 'NSE',
      side TEXT NOT NULL,
      bucket TEXT DEFAULT 'MIS_INTRADAY',
      archetype TEXT DEFAULT 'TREND_RUNNER',
      regime TEXT DEFAULT 'TRANSITIONAL',
      session_window TEXT DEFAULT 'MORNING_DRIVE',
      confidence REAL DEFAULT 0,
      composite_rank REAL DEFAULT 0,
      net_rr REAL DEFAULT 0,
      entry_price REAL NOT NULL,
      stop_loss REAL NOT NULL,
      target1 REAL NOT NULL,
      target2 REAL,
      qty REAL DEFAULT 1,
      lot_multiplier REAL DEFAULT 1,
      decision TEXT NOT NULL,
      decision_reason TEXT,
      claude_verdict TEXT,
      paper_trade_id INTEGER,
      status TEXT NOT NULL DEFAULT 'OPEN',
      exit_price REAL,
      exit_time TEXT,
      exit_reason TEXT,
      mfe_r REAL DEFAULT 0,
      mae_r REAL DEFAULT 0,
      sim_gross_pnl REAL,
      sim_fees REAL,
      sim_net_pnl REAL,
      sim_r_multiple REAL,
      is_correct INTEGER,
      source TEXT NOT NULL DEFAULT 'LIVE_SCAN'
    );
    CREATE INDEX IF NOT EXISTS idx_sal_status ON signal_audit_log(status);
    CREATE INDEX IF NOT EXISTS idx_sal_date ON signal_audit_log(date_ist);
    CREATE INDEX IF NOT EXISTS idx_sal_sym_side ON signal_audit_log(symbol, side, created_at);
  `);
}

/**
 * Maps a raw `vetoReason` string from `evaluateStockForAutoPilot` or
 * `evaluateCommodityForAutoPilot` into a clean, queryable filter category.
 */
function classifyVetoCategory(vetoReason) {
  const r = String(vetoReason || '').toLowerCase();
  if (!r) return 'BLOCKED_OTHER';
  if (r.includes('claude')) return 'VETOED_CLAUDE_CRO';
  if (r.includes('debate')) return 'VETOED_DEBATE';
  if (r.includes('midday chop')) return 'BLOCKED_CHOP_SHIELD';
  if (r.includes('closing cutoff')) return 'BLOCKED_CLOSING_CUTOFF';
  if (r.includes('historical chart')) return 'BLOCKED_HISTORICAL_EDGE';
  if (r.includes('risk/fee') || r.includes('fee') || r.includes('net r:r')) return 'BLOCKED_FEE_GATE';
  if (r.includes('nse mcp flow')) return 'BLOCKED_NSE_FLOW';
  if (r.includes('sector')) return 'BLOCKED_SECTOR_GUARD';
  if (r.includes('macro blackout')) return 'BLOCKED_MACRO_SHIELD';
  if (r.includes('corporate action')) return 'BLOCKED_CORP_ACTION';
  if (r.includes('brain') || r.includes('regime') || r.includes('bench') || r.includes('shadow-pause') || r.includes('equity shield')) {
    return 'BLOCKED_REGIME_BRAIN';
  }
  return 'BLOCKED_OTHER';
}

/**
 * Computes simulated net P&L for a graded shadow signal using realistic
 * Zerodha statutory charges + brokerage (+ CDSL ₹15.34 DP sell fee for CNC).
 */
function computeSimulatedOutcome({
  side,
  exchange = 'NSE',
  bucket = 'MIS_INTRADAY',
  entryPrice,
  exitPrice,
  stopLoss,
  qty = 1,
  lotMultiplier = 1
}) {
  const entry = Number(entryPrice || 0);
  const exit = Number(exitPrice || 0);
  const sl = Number(stopLoss || entry);
  const q = Math.max(1, Number(qty || 1));
  const lm = Math.max(1, Number(lotMultiplier || 1));

  const priceDiff = side === 'BUY' ? (exit - entry) : (entry - exit);
  const grossPnl = +(priceDiff * q * lm).toFixed(2);

  let fees = 0;
  const isCnc = String(bucket || '').toUpperCase().includes('CNC');
  if (isCnc) {
    // ₹0 Zerodha CNC brokerage + 0.22% round-trip STT/exchange/stamp + ₹15.34 CDSL DP sell charge
    const turnover = (entry + exit) * q;
    fees = +(turnover * 0.0011 + CDSL_CNC_DP_CHARGE_RS).toFixed(2);
  } else {
    const segment = exchange === 'MCX' ? 'mcx' : 'equity';
    const feeObj = riskEngine.calculateZerodhaFees({
      segment,
      buyPrice: side === 'BUY' ? entry : exit,
      sellPrice: side === 'BUY' ? exit : entry,
      qty: q,
      lotMultiplier: lm
    });
    fees = +(Number(feeObj?.totalFees || 0)).toFixed(2);
  }

  const netPnl = +(grossPnl - fees).toFixed(2);
  const riskPerUnit = Math.max(0.05, Math.abs(entry - sl));
  const riskRs = Math.max(1, riskPerUnit * q * lm);
  const rMultiple = +(netPnl / riskRs).toFixed(2);
  const isCorrect = netPnl > 0 ? 1 : 0;

  return {
    grossPnl,
    fees,
    netPnl,
    rMultiple,
    isCorrect
  };
}

/**
 * Records a generated directional signal (`BUY` / `SELL`) into `signal_audit_log`
 * with 30-minute deduplication per `(symbol, side)`.
 * If an OPEN shadow record for `(symbol, side)` already exists today and the
 * signal is now `EXECUTED`, upgrades that row in place and links `paper_trade_id`.
 */
function recordAuditedSignal(db, {
  evalObj,
  decision = 'SKIPPED_OTHER',
  decisionReason = null,
  claudeVerdict = null,
  paperTradeId = null,
  nowDate = new Date(),
  source = 'LIVE_SCAN',
  applyEntrySlippage = true
} = {}) {
  if (!db || !evalObj) return { recorded: false, reason: 'missing_args' };
  const side = String(evalObj.action || evalObj.executionPlan?.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') return { recorded: false, reason: 'not_directional' };

  const p = evalObj.executionPlan || {};
  const symbol = String(p.tradingsymbol || evalObj.symbol || evalObj.name || '').toUpperCase();
  const rawEntry = Number(p.entryPrice || evalObj.price || 0);
  const sl = Number(p.stopLoss || 0);
  const t1 = Number(p.target1 || 0);
  const t2 = p.target2 != null ? Number(p.target2) : null;

  if (!symbol || rawEntry <= 0 || sl <= 0 || t1 <= 0) {
    return { recorded: false, reason: 'missing_levels' };
  }
  // Sanity-check directional geometry
  if (side === 'BUY' && !(sl < rawEntry && t1 > rawEntry)) return { recorded: false, reason: 'invalid_buy_levels' };
  if (side === 'SELL' && !(sl > rawEntry && t1 < rawEntry)) return { recorded: false, reason: 'invalid_sell_levels' };

  ensureSignalAuditSchema(db);

  const nowIso = nowDate.toISOString();
  const dateIst = getIstDateStr(nowDate);
  const entryPrice = applyEntrySlippage ? applySlippage(rawEntry, side, true) : rawEntry;

  // Check if there's an existing OPEN shadow record for this symbol+side today
  const existingOpen = db.prepare(`
    SELECT id, decision, created_at FROM signal_audit_log
    WHERE symbol = ? AND side = ? AND date_ist = ? AND status = 'OPEN' AND source = ?
    ORDER BY id DESC LIMIT 1
  `).get(symbol, side, dateIst, source);

  if (existingOpen) {
    // Upgrade existing open record if this signal just got EXECUTED or VETOED_CLAUDE_CRO
    if (decision === 'EXECUTED' && existingOpen.decision !== 'EXECUTED') {
      db.prepare(`
        UPDATE signal_audit_log
        SET decision = 'EXECUTED', decision_reason = ?, claude_verdict = COALESCE(?, claude_verdict),
            paper_trade_id = COALESCE(?, paper_trade_id), entry_price = ?, qty = ?
        WHERE id = ?
      `).run(
        decisionReason || 'Auto-Pilot executed',
        claudeVerdict || null,
        paperTradeId || null,
        entryPrice,
        Math.max(1, Number(p.qty || 1)),
        existingOpen.id
      );
      return { recorded: true, updated: true, id: existingOpen.id };
    }
    if (decision === 'VETOED_CLAUDE_CRO' && existingOpen.decision !== 'EXECUTED' && existingOpen.decision !== 'VETOED_CLAUDE_CRO') {
      db.prepare(`
        UPDATE signal_audit_log
        SET decision = 'VETOED_CLAUDE_CRO', decision_reason = ?, claude_verdict = 'VETO'
        WHERE id = ?
      `).run(decisionReason || 'Claude CRO Veto', existingOpen.id);
      return { recorded: true, updated: true, id: existingOpen.id };
    }
    return { recorded: false, reason: 'already_open_shadow', id: existingOpen.id };
  }

  // Deduplicate within 30 minutes even if a previous signal closed quickly
  const recent = db.prepare(`
    SELECT id, created_at FROM signal_audit_log
    WHERE symbol = ? AND side = ? AND source = ?
    ORDER BY id DESC LIMIT 1
  `).get(symbol, side, source);
  if (recent && decision !== 'EXECUTED') {
    const ageMs = nowDate.getTime() - new Date(recent.created_at).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < DEDUP_WINDOW_MS) {
      return { recorded: false, reason: 'dedup_cooldown', id: recent.id };
    }
  }

  const info = db.prepare(`
    INSERT INTO signal_audit_log (
      created_at, date_ist, symbol, asset_type, exchange, side, bucket, archetype,
      regime, session_window, confidence, composite_rank, net_rr,
      entry_price, stop_loss, target1, target2, qty, lot_multiplier,
      decision, decision_reason, claude_verdict, paper_trade_id, status, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
  `).run(
    nowIso,
    dateIst,
    symbol,
    evalObj.assetType || (p.exchange === 'MCX' ? 'COMMODITY' : 'STOCK'),
    p.exchange || (evalObj.assetType === 'COMMODITY' ? 'MCX' : 'NSE'),
    side,
    p.bucket || evalObj.bucket || (p.exchange === 'MCX' ? 'MCX_COMMODITY' : 'MIS_INTRADAY'),
    evalObj.archetype || 'TREND_RUNNER',
    evalObj.regime || 'TRANSITIONAL',
    evalObj.sessionWindow || 'MORNING_DRIVE',
    Number(evalObj.confidence || 0),
    Number(evalObj.compositeRankScore || evalObj.confidence || 0),
    Number(p.netRR || 0),
    entryPrice,
    sl,
    t1,
    t2,
    Math.max(1, Number(p.qty || 1)),
    Math.max(1, Number(p.lotMultiplier || 1)),
    decision,
    decisionReason ? String(decisionReason).slice(0, 220) : null,
    claudeVerdict || null,
    paperTradeId || null,
    source
  );

  return { recorded: true, id: Number(info.lastInsertRowid) };
}

/**
 * Automatically grades all OPEN shadow signals in `signal_audit_log` against
 * live market highs/lows and session cutoffs (SL checked first conservatively).
 */
function gradeOpenShadowSignals(db, {
  latestPrices = {},
  sessionInfo = {},
  nowDate = new Date(),
  applyExitSlippage = true
} = {}) {
  if (!db) return { checked: 0, graded: [] };
  ensureSignalAuditSchema(db);

  const openRows = db.prepare(`SELECT * FROM signal_audit_log WHERE status = 'OPEN' ORDER BY id ASC`).all();
  if (!openRows.length) return { checked: 0, graded: [] };

  const todayIst = getIstDateStr(nowDate);
  const nowIso = nowDate.toISOString();
  const graded = [];

  for (const row of openRows) {
    const sym = String(row.symbol || '').toUpperCase();
    const baseSym = sym.replace(/\d{2}[A-Z]{3}FUT$/, '');
    const pxObj = latestPrices[sym] || latestPrices[baseSym] || null;
    if (!pxObj || !(pxObj.price > 0)) continue;

    // Skip stale offline quotes on NSE unless closing an overdue prior-day signal
    const isPriorDay = row.date_ist && row.date_ist < todayIst;
    const isCnc = String(row.bucket || '').toUpperCase().includes('CNC');
    if (row.exchange === 'NSE' && pxObj.isLive === false && !isPriorDay) continue;

    const entry = Number(row.entry_price);
    const sl = Number(row.stop_loss);
    const t1 = Number(row.target1);
    const side = row.side;
    const riskPts = Math.max(0.05, Math.abs(entry - sl));

    const curPrice = Number(pxObj.price);
    const barHigh = Math.max(curPrice, Number(pxObj.high || curPrice));
    const barLow = Math.min(curPrice, Number(pxObj.low || curPrice));

    // Update running MFE / MAE in R-multiples
    const favPts = side === 'BUY' ? (barHigh - entry) : (entry - barLow);
    const advPts = side === 'BUY' ? (entry - barLow) : (barHigh - entry);
    const mfeR = Math.max(Number(row.mfe_r || 0), +(Math.max(0, favPts) / riskPts).toFixed(2));
    const maeR = Math.max(Number(row.mae_r || 0), +(Math.max(0, advPts) / riskPts).toFixed(2));

    let exitReason = null;
    let rawExitPrice = null;

    // 1. Check SL FIRST (conservative — never assumes favorable intrabar ordering)
    if (side === 'BUY' && barLow <= sl) {
      exitReason = 'SHADOW_SL_LOSS';
      rawExitPrice = sl;
    } else if (side === 'SELL' && barHigh >= sl) {
      exitReason = 'SHADOW_SL_LOSS';
      rawExitPrice = sl;
    } else if (side === 'BUY' && barHigh >= t1) {
      exitReason = 'SHADOW_T1_WIN';
      rawExitPrice = t1;
    } else if (side === 'SELL' && barLow <= t1) {
      exitReason = 'SHADOW_T1_WIN';
      rawExitPrice = t1;
    } else if (!isCnc) {
      // Intraday EOD square-off (NSE MIS 15:20 IST, MCX 23:20 IST, or overdue prior day)
      const isNseCutoff = row.exchange === 'NSE' && Boolean(sessionInfo.isNseEodCutoff);
      const isMcxCutoff = row.exchange === 'MCX' && Boolean(sessionInfo.isMcxEodCutoff);
      if (isNseCutoff || isMcxCutoff || isPriorDay) {
        exitReason = 'SHADOW_EOD_CLOSE';
        rawExitPrice = curPrice;
      }
    } else {
      // CNC Swing shadow signal max hold 14 calendar days
      const ageDays = (nowDate.getTime() - new Date(row.created_at).getTime()) / 86400000;
      if (ageDays >= 14) {
        exitReason = 'SHADOW_TIME_EXIT';
        rawExitPrice = curPrice;
      }
    }

    if (exitReason && rawExitPrice > 0) {
      const fillExit = applyExitSlippage ? applySlippage(rawExitPrice, side, false) : rawExitPrice;
      const out = computeSimulatedOutcome({
        side,
        exchange: row.exchange,
        bucket: row.bucket,
        entryPrice: entry,
        exitPrice: fillExit,
        stopLoss: sl,
        qty: row.qty,
        lotMultiplier: row.lot_multiplier
      });
      const finalStatus = out.netPnl > 0 ? 'WIN' : 'LOSS';
      db.prepare(`
        UPDATE signal_audit_log
        SET status = ?, exit_price = ?, exit_time = ?, exit_reason = ?,
            mfe_r = ?, mae_r = ?, sim_gross_pnl = ?, sim_fees = ?,
            sim_net_pnl = ?, sim_r_multiple = ?, is_correct = ?
        WHERE id = ?
      `).run(
        finalStatus, fillExit, nowIso, exitReason,
        mfeR, maeR, out.grossPnl, out.fees,
        out.netPnl, out.rMultiple, out.isCorrect,
        row.id
      );
      graded.push({
        id: row.id,
        symbol: sym,
        side,
        decision: row.decision,
        status: finalStatus,
        exitReason,
        exitPrice: fillExit,
        simNetPnl: out.netPnl,
        simR: out.rMultiple,
        mfeR,
        maeR
      });
    } else if (mfeR !== Number(row.mfe_r || 0) || maeR !== Number(row.mae_r || 0)) {
      db.prepare(`UPDATE signal_audit_log SET mfe_r = ?, mae_r = ? WHERE id = ?`).run(mfeR, maeR, row.id);
    }
  }

  return { checked: openRows.length, graded };
}

function summarizeGroup(rows) {
  const total = rows.length;
  const open = rows.filter(r => r.status === 'OPEN').length;
  const closed = rows.filter(r => r.status !== 'OPEN');
  const wins = closed.filter(r => Number(r.sim_net_pnl || 0) > 0).length;
  const losses = closed.length - wins;
  const grossWin = closed.filter(r => Number(r.sim_net_pnl || 0) > 0).reduce((s, r) => s + Number(r.sim_net_pnl || 0), 0);
  const grossLoss = Math.abs(closed.filter(r => Number(r.sim_net_pnl || 0) <= 0).reduce((s, r) => s + Number(r.sim_net_pnl || 0), 0));
  const netPnlRs = +closed.reduce((s, r) => s + Number(r.sim_net_pnl || 0), 0).toFixed(2);
  const avgR = closed.length > 0 ? +(closed.reduce((s, r) => s + Number(r.sim_r_multiple || 0), 0) / closed.length).toFixed(2) : 0;
  const avgMfeR = closed.length > 0 ? +(closed.reduce((s, r) => s + Number(r.mfe_r || 0), 0) / closed.length).toFixed(2) : 0;
  const avgMaeR = closed.length > 0 ? +(closed.reduce((s, r) => s + Number(r.mae_r || 0), 0) / closed.length).toFixed(2) : 0;
  const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 9.99 : 0);
  const expectancyRs = closed.length > 0 ? +(netPnlRs / closed.length).toFixed(2) : 0;
  return {
    total,
    open,
    graded: closed.length,
    wins,
    losses,
    winRate,
    profitFactor,
    netPnlRs,
    expectancyRs,
    avgR,
    avgMfeR,
    avgMaeR
  };
}

function loadHistoricalReplayReport() {
  try {
    const filePath = path.join(__dirname, '..', 'signal_replay_results.json');
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (_) {}
  return null;
}

/**
 * Detects "Forming Setups" (54–61% conviction or 1 gate away from qualifying)
 * so the 15s Fast-Pulse radar gives 1–3 minutes of early warning before entry triggers.
 */
function detectFormingSetups(stockEvaluations = [], commodityEvaluations = []) {
  const all = [...(stockEvaluations || []), ...(commodityEvaluations || [])];
  const forming = [];
  for (const ev of all) {
    if (!ev || !ev.executionPlan) continue;
    const conf = Number(ev.confidence || 0);
    const p = ev.executionPlan;
    if (!(p.entryPrice > 0 && p.stopLoss > 0 && p.target1 > 0)) continue;

    // Type A: Near-trigger (54–61% WAIT, building momentum toward 62% threshold)
    const isNearTrigger = ev.action === 'WAIT' && conf >= 54 && conf < 62;
    // Type B: Triggered directional signal that is currently blocked by a temporary window/filter
    const isTriggeredBlocked = (ev.action === 'BUY' || ev.action === 'SELL') && !ev.qualifiesForAutoExec && conf >= 62;
    // Type C: Live qualifying setup ready now
    const isReadyNow = Boolean(ev.qualifiesForAutoExec) && (ev.action === 'BUY' || ev.action === 'SELL');

    if (!isNearTrigger && !isTriggeredBlocked && !isReadyNow) continue;

    const stage = isReadyNow ? 'READY_NOW' : (isNearTrigger ? 'FORMING' : 'TRIGGERED_FILTERED');
    const gapToTrigger = isNearTrigger ? +(62 - conf).toFixed(1) : 0;
    const distanceToT1Pct = +((Math.abs(p.target1 - p.entryPrice) / Math.max(0.01, p.entryPrice)) * 100).toFixed(2);
    forming.push({
      symbol: p.tradingsymbol || ev.symbol || ev.name,
      assetType: ev.assetType || 'STOCK',
      side: p.side || ev.action,
      stage,
      confidence: Math.round(conf),
      compositeRank: Math.round(ev.compositeRankScore || conf),
      gapToTrigger,
      archetype: ev.archetype || 'TREND_RUNNER',
      bucket: p.bucket || ev.bucket || 'MIS_INTRADAY',
      price: p.entryPrice,
      stopLoss: p.stopLoss,
      target1: p.target1,
      netRR: p.netRR || 0,
      distanceToT1Pct,
      note: isReadyNow
        ? `Qualifies now · Net R:R 1:${p.netRR}`
        : isNearTrigger
          ? `${gapToTrigger}% away from 62% trigger (${ev.htfBias || 'NEUTRAL'} HTF · ${ev.smcState || 'RANGING'})`
          : String(ev.vetoReason || 'Filtered').slice(0, 95)
    });
  }
  const order = { READY_NOW: 0, FORMING: 1, TRIGGERED_FILTERED: 2 };
  return forming
    .sort((a, b) => (order[a.stage] - order[b.stage]) || (b.confidence - a.confidence) || (b.compositeRank - a.compositeRank))
    .slice(0, 12);
}

/**
 * Generates actionable daily self-improvement insights from graded signal telemetry
 * (Filter Proof, SL/T1 MFE-MAE Calibration, Confidence Band Sweet-Spot, Weak Session Alerts).
 */
function generateDailySignalInsights(report) {
  const insights = [];
  if (!report) return insights;

  const s = report.summary || {};
  const cmp = report.comparison || {};
  const byConf = report.byConfidence || [];
  const byWin = report.bySessionWindow || [];
  const byDec = report.byDecision || [];

  // 1. Executed vs. Filtered Out proof
  if ((cmp.executed?.graded || 0) >= 3 && (cmp.filteredOut?.graded || 0) >= 3) {
    const deltaWr = cmp.executed.winRate - cmp.filteredOut.winRate;
    if (deltaWr >= 5 || cmp.filteredOut.netPnlRs < 0) {
      insights.push({
        type: 'FILTER_PROOF',
        severity: 'GOOD',
        text: `Filters are adding real edge: Executed WR ${cmp.executed.winRate}% (${cmp.executed.netPnlRs >= 0 ? '+' : ''}₹${cmp.executed.netPnlRs}) vs Filtered-Out WR ${cmp.filteredOut.winRate}% (${cmp.filteredOut.netPnlRs >= 0 ? '+' : ''}₹${cmp.filteredOut.netPnlRs}).`
      });
    } else if (cmp.filteredOut.netPnlRs > 150 && cmp.filteredOut.winRate > cmp.executed.winRate + 8) {
      insights.push({
        type: 'FILTER_OVERBLOCK',
        severity: 'WARN',
        text: `Caution: Filtered-out signals beat executed ones (${cmp.filteredOut.winRate}% WR, +₹${cmp.filteredOut.netPnlRs}). Inspect which gate is blocking winners before tightening rules.`
      });
    }
  }

  // 2. Claude CRO Counterfactual Value-Add
  if ((cmp.claudeVetoes?.graded || 0) >= 2) {
    const cv = cmp.claudeVetoes;
    const saved = -cv.netPnlRs;
    insights.push({
      type: 'CLAUDE_CALIBRATION',
      severity: saved >= 0 ? 'GOOD' : 'WARN',
      text: saved >= 0
        ? `Claude CRO Vetoes saved ₹${Math.round(saved)} across ${cv.graded} graded vetoes (vetoed setups had ${cv.winRate}% WR).`
        : `Claude CRO Vetoes blocked +₹${Math.round(Math.abs(saved))} across ${cv.graded} graded vetoes (${cv.winRate}% WR) — review CRO prompt strictness.`
    });
  }

  // 3. Capacity Cap Check (Are we missing profitable setups because of 4–6/day or 2-slot cap?)
  if ((cmp.capacitySkipped?.graded || 0) >= 5) {
    const cs = cmp.capacitySkipped;
    insights.push({
      type: 'CAPACITY_CHECK',
      severity: cs.profitFactor >= 1.35 && cs.netPnlRs > 0 ? 'INFO' : 'GOOD',
      text: cs.netPnlRs > 0
        ? `Cap-skipped qualifying setups (${cs.graded} graded): ${cs.winRate}% WR, PF ${cs.profitFactor}x, +₹${cs.netPnlRs}. Keep collecting 100+ samples before considering higher daily slots.`
        : `Daily/Slot caps protected capital: ${cs.graded} cap-skipped setups netted ₹${cs.netPnlRs} (${cs.winRate}% WR).`
    });
  }

  // 4. Confidence Calibration Sweet-Spot
  const scoredBands = byConf.filter(b => b.graded >= 5);
  if (scoredBands.length >= 2) {
    const bestBand = [...scoredBands].sort((a, b) => b.expectancyRs - a.expectancyRs)[0];
    const worstBand = [...scoredBands].sort((a, b) => a.expectancyRs - b.expectancyRs)[0];
    if (bestBand && worstBand && bestBand.band !== worstBand.band) {
      insights.push({
        type: 'CONFIDENCE_CALIBRATION',
        severity: worstBand.expectancyRs < 0 ? 'WARN' : 'INFO',
        text: `Best confidence band: ${bestBand.band} (${bestBand.winRate}% WR, PF ${bestBand.profitFactor}x, avg ₹${bestBand.expectancyRs}/sig) vs weakest ${worstBand.band} (${worstBand.winRate}% WR, avg ₹${worstBand.expectancyRs}/sig).`
      });
    }
  }

  // 5. MFE / MAE Stop-Loss & Target Precision
  if (s.graded >= 10) {
    if (s.avgMfeR >= 0.75 && s.avgR < 0.15) {
      insights.push({
        type: 'MFE_LEAKAGE',
        severity: 'WARN',
        text: `Signals reach +${s.avgMfeR}R MFE on average but realize only ${s.avgR}R net — winners are giving back gains before T1 (consider faster ratchet / earlier partial lock in Shadow Challenger).`
      });
    }
    if (s.avgMaeR >= 0.85 && s.winRate < 45) {
      insights.push({
        type: 'MAE_STOPOUT',
        severity: 'WARN',
        text: `High adverse excursion (avg MAE -${s.avgMaeR}R, WR ${s.winRate}%) — entries are chasing extended 5m bars or stops sit inside noise; test 15s fast-pulse earlier entries.`
      });
    }
  }

  // 6. Weak Session Window Alert
  const toxicWin = byWin.find(w => w.graded >= 5 && w.netPnlRs < -100 && w.winRate < 40);
  if (toxicWin) {
    insights.push({
      type: 'SESSION_TOXIC',
      severity: 'WARN',
      text: `Weakest window: ${toxicWin.sessionWindow} (${toxicWin.graded} graded, ${toxicWin.winRate}% WR, ₹${toxicWin.netPnlRs}) — candidate for Shadow Challenger time filter.`
    });
  }

  // 7. Most valuable filter overall
  const bestFilter = byDec
    .filter(d => (d.decision.startsWith('BLOCKED_') || d.decision.startsWith('VETOED_')) && d.graded >= 3 && d.netPnlRs < 0)
    .sort((a, b) => a.netPnlRs - b.netPnlRs)[0];
  if (bestFilter) {
    insights.push({
      type: 'TOP_SHIELD',
      severity: 'GOOD',
      text: `Top protective shield: ${bestFilter.decision} avoided ₹${Math.abs(Math.round(bestFilter.netPnlRs))} in losses across ${bestFilter.graded} blocked signals (${bestFilter.winRate}% WR).`
    });
  }

  if (insights.length === 0) {
    insights.push({
      type: 'COLLECTING',
      severity: 'INFO',
      text: `Collecting forward shadow signals (${s.graded || 0}/${s.targetSignals || 100} graded). Daily calibration insights activate automatically once ≥5 graded signals accumulate per category.`
    });
  }
  return insights;
}

/**
 * Generates the complete Signal Accuracy & Filter Proof report for the UI and API.
 */
function getSignalAccuracyReport(db, { days = 30, limitRecent = 60, formingSetups = [] } = {}) {
  if (!db) return { ok: false, error: 'Database unavailable' };
  ensureSignalAuditSchema(db);

  const todayIst = getIstDateStr(new Date());
  const cutoffDate = new Date(Date.now() - Math.max(1, days) * 86400000);
  const cutoffIst = getIstDateStr(cutoffDate);

  const rows = db.prepare(`
    SELECT * FROM signal_audit_log
    WHERE date_ist >= ? AND source = 'LIVE_SCAN'
    ORDER BY id DESC
  `).all(cutoffIst);

  const todayRows = rows.filter(r => r.date_ist === todayIst);
  const summary = summarizeGroup(rows);
  const todaySummary = summarizeGroup(todayRows);

  // Group by Decision / Filter
  const decisionMap = {};
  for (const r of rows) {
    const k = r.decision || 'UNKNOWN';
    if (!decisionMap[k]) decisionMap[k] = [];
    decisionMap[k].push(r);
  }
  const byDecision = Object.entries(decisionMap)
    .map(([decision, list]) => {
      const st = summarizeGroup(list);
      let filterVerdict = 'TRACKING';
      if (st.graded >= 3) {
        if (decision === 'EXECUTED') {
          filterVerdict = st.netPnlRs >= 0 ? '✅ PROFITABLE EXECUTION' : '⚠️ NEGATIVE EXECUTION';
        } else if (decision.startsWith('VETOED_') || decision.startsWith('BLOCKED_')) {
          filterVerdict = st.netPnlRs < 0
            ? `🛡️ SAVED ₹${Math.abs(Math.round(st.netPnlRs))}`
            : `⚠️ BLOCKED +₹${Math.round(st.netPnlRs)}`;
        } else {
          filterVerdict = st.netPnlRs > 0
            ? `💡 MISSED +₹${Math.round(st.netPnlRs)} (CAP)`
            : `🛡️ CAP AVOIDED ₹${Math.abs(Math.round(st.netPnlRs))}`;
        }
      }
      return { decision, ...st, filterVerdict };
    })
    .sort((a, b) => b.total - a.total);

  // Executed vs. Filtered (Blocked/Vetoed) vs. Capacity-Skipped high-level comparison
  const execRows = rows.filter(r => r.decision === 'EXECUTED');
  const capSkippedRows = rows.filter(r => String(r.decision || '').startsWith('SKIPPED_'));
  const filteredRows = rows.filter(r => String(r.decision || '').startsWith('BLOCKED_') || String(r.decision || '').startsWith('VETOED_'));
  const claudeVetoRows = rows.filter(r => r.decision === 'VETOED_CLAUDE_CRO');

  // Calibration by Confidence Band
  const confBands = [
    { label: '80%+ (High)', test: c => c >= 80 },
    { label: '70–79% (Strong)', test: c => c >= 70 && c < 80 },
    { label: '62–69% (Standard)', test: c => c >= 62 && c < 70 },
    { label: '<62% (Low)', test: c => c < 62 }
  ];
  const byConfidence = confBands.map(b => ({
    band: b.label,
    ...summarizeGroup(rows.filter(r => b.test(Number(r.confidence || 0))))
  })).filter(b => b.total > 0);

  // By Archetype
  const archMap = {};
  for (const r of rows) {
    const k = r.archetype || 'UNKNOWN';
    if (!archMap[k]) archMap[k] = [];
    archMap[k].push(r);
  }
  const byArchetype = Object.entries(archMap).map(([archetype, list]) => ({
    archetype,
    ...summarizeGroup(list)
  })).sort((a, b) => b.total - a.total);

  // By Session Window
  const winMap = {};
  for (const r of rows) {
    const k = r.session_window || 'UNKNOWN';
    if (!winMap[k]) winMap[k] = [];
    winMap[k].push(r);
  }
  const bySessionWindow = Object.entries(winMap).map(([sessionWindow, list]) => ({
    sessionWindow,
    ...summarizeGroup(list)
  })).sort((a, b) => b.total - a.total);

  // By Symbol (Top 12)
  const symMap = {};
  for (const r of rows) {
    const k = r.symbol || 'UNKNOWN';
    if (!symMap[k]) symMap[k] = [];
    symMap[k].push(r);
  }
  const bySymbol = Object.entries(symMap).map(([symbol, list]) => ({
    symbol,
    ...summarizeGroup(list)
  })).sort((a, b) => b.total - a.total || b.netPnlRs - a.netPnlRs).slice(0, 12);

  // Statistical Pre-Real-Money Readiness (100+ live graded signals)
  const targetSignals = 100;
  const samplePct = Math.min(100, Math.round((summary.graded / targetSignals) * 100));
  const hasPositiveEdge = summary.graded >= 20 && summary.profitFactor >= 1.20 && summary.expectancyRs > 0;
  const readinessVerdict = summary.graded >= targetSignals && hasPositiveEdge
    ? 'STATISTICALLY_VALIDATED'
    : (summary.graded >= 30 && !hasPositiveEdge ? 'EDGE_UNDER_REVIEW' : 'COLLECTING_DATA');

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    todayIst,
    windowDays: days,
    summary: {
      ...summary,
      todayTotal: todaySummary.total,
      todayGraded: todaySummary.graded,
      todayWins: todaySummary.wins,
      todayLosses: todaySummary.losses,
      todayWinRate: todaySummary.winRate,
      targetSignals,
      samplePct,
      readinessVerdict
    },
    comparison: {
      executed: summarizeGroup(execRows),
      capacitySkipped: summarizeGroup(capSkippedRows),
      filteredOut: summarizeGroup(filteredRows),
      claudeVetoes: summarizeGroup(claudeVetoRows)
    },
    byDecision,
    byConfidence,
    byArchetype,
    bySessionWindow,
    bySymbol,
    formingSetups: Array.isArray(formingSetups) ? formingSetups : [],
    recentSignals: rows.slice(0, limitRecent),
    historicalReplay: loadHistoricalReplayReport()
  };
  report.dailyInsights = generateDailySignalInsights(report);
  return report;
}

module.exports = {
  CDSL_CNC_DP_CHARGE_RS,
  PAPER_SLIPPAGE_BPS,
  ensureSignalAuditSchema,
  classifyVetoCategory,
  computeSimulatedOutcome,
  recordAuditedSignal,
  gradeOpenShadowSignals,
  detectFormingSetups,
  generateDailySignalInsights,
  getSignalAccuracyReport,
  loadHistoricalReplayReport,
  applySlippage,
  getIstDateStr
};
