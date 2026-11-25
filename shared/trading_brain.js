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
 * Layer 1: Live Intraday Market Regime Brain (v2)
 * Computes TRUE live intraday breadth from live NSE sectoral indices & live stock quotes
 * (never fooled by stale yesterday EOD Bhavcopy breadth during live trading hours!).
 */
function classifyMarketRegime({ nseMcpOverview = null, nseMcpQuotes = null } = {}) {
  const n50Pct = Number(nseMcpOverview?.nifty50?.percChange ?? 0);
  const nBkPct = Number(nseMcpOverview?.niftyBank?.percChange ?? 0);
  const eodAdvPct = Number(nseMcpOverview?.breadth?.advPct ?? 50);
  const hasLive = Boolean(nseMcpOverview && (nseMcpOverview.nifty50 || nseMcpOverview.breadth));

  // Derive TRUE real-time intraday breadth from live sectoral indices + live batch quotes
  let liveBreadthSamples = 0;
  let liveBreadthGreen = 0;
  const secMap = nseMcpOverview?.sectorMap || {};
  for (const val of Object.values(secMap)) {
    if (val && typeof val.percChange === 'number' && isFinite(val.percChange)) {
      liveBreadthSamples++;
      if (val.percChange > 0.05) liveBreadthGreen++;
    }
  }
  if (nseMcpQuotes && typeof nseMcpQuotes === 'object') {
    for (const q of Object.values(nseMcpQuotes)) {
      if (q && typeof q.percChange === 'number' && isFinite(q.percChange)) {
        liveBreadthSamples++;
        if (q.percChange > 0.05) liveBreadthGreen++;
      }
    }
  }
  const hasLiveIntradayBreadth = liveBreadthSamples >= 4;
  const advPct = hasLiveIntradayBreadth
    ? +((liveBreadthGreen / liveBreadthSamples) * 100).toFixed(1)
    : eodAdvPct;
  const breadthSource = hasLiveIntradayBreadth ? 'LIVE_INTRADAY' : 'EOD_BHAVCOPY';

  if (!hasLive) {
    return {
      regime: 'NEUTRAL_WAIT',
      confidence: 50,
      niftyPct: 0,
      bankPct: 0,
      advPct: 50,
      eodAdvPct: 50,
      breadthSource: 'NONE',
      allowNewLongs: true,
      allowNewShorts: true,
      allowBreakouts: true,
      preferCncSwing: true,
      sizeMultiplier: 1.0,
      directive: 'Awaiting live NSE tape — normal risk guardrails active.'
    };
  }

  // Strong directional panic override (protects immediately on -1.25%+ sell-offs)
  if (n50Pct <= -1.25 || (n50Pct <= -0.60 && advPct <= 24)) {
    return {
      regime: 'HIGH_VOL_PANIC',
      confidence: 92,
      niftyPct: n50Pct,
      bankPct: nBkPct,
      advPct,
      eodAdvPct,
      breadthSource,
      allowNewLongs: false,
      allowNewShorts: true,
      allowBreakouts: false,
      preferCncSwing: false,
      sizeMultiplier: 0.5,
      directive: `Panic sell-off (Nifty ${n50Pct}%, Live Breadth ${advPct}%): Blocking all new longs & breakouts; capital preservation at 50% size.`
    };
  }

  // Strong directional bull trend override (blocks counter-trend shorts on +0.65%+ Nifty rallies!)
  if (n50Pct >= 0.65 || (n50Pct >= 0.30 && advPct >= 56)) {
    return {
      regime: 'BULL_TREND',
      confidence: n50Pct >= 1.0 ? 90 : 82,
      niftyPct: n50Pct,
      bankPct: nBkPct,
      advPct,
      eodAdvPct,
      breadthSource,
      allowNewLongs: true,
      allowNewShorts: false,
      allowBreakouts: true,
      preferCncSwing: true,
      sizeMultiplier: 1.0,
      directive: `Bullish trend (Nifty +${n50Pct}%, Live Breadth ${advPct}%): Blocking counter-trend shorts; full size on CNC Champions & aligned longs.`
    };
  }

  if (n50Pct <= -0.40 && advPct < 44) {
    return {
      regime: 'BEAR_DRIFT',
      confidence: 78,
      niftyPct: n50Pct,
      bankPct: nBkPct,
      advPct,
      eodAdvPct,
      breadthSource,
      allowNewLongs: false,
      allowNewShorts: true,
      allowBreakouts: false,
      preferCncSwing: false,
      sizeMultiplier: 0.75,
      directive: `Bearish drift (Nifty ${n50Pct}%, Live Breadth ${advPct}%): Blocking intraday longs; favoring short setups & defensive 75% sizing.`
    };
  }

  return {
    regime: 'RANGE_CHOP',
    confidence: 70,
    niftyPct: n50Pct,
    bankPct: nBkPct,
    advPct,
    eodAdvPct,
    breadthSource,
    allowNewLongs: true,
    allowNewShorts: true,
    allowBreakouts: false,
    preferCncSwing: true,
    sizeMultiplier: 0.75,
    directive: `Sideways chop (Nifty ${n50Pct >= 0 ? '+' : ''}${n50Pct}%, Live Breadth ${advPct}%): Pausing weak breakouts; favoring Mean-Reversion & CNC Champions at 75% size.`
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

// ─────────────────────────────────────────────────────────────
// BRAIN v2 CIO MODULES:
//   • Sector Concentration & Correlation Guard
//   • Live Equity Curve Anti-Tilt Governor
//   • Multi-Strategy Meta-Allocator (Empirical Prior + Live Decay Bandit)
//   • Time-of-Day Edge Matrix (Golden vs Toxic IST Windows)
// ─────────────────────────────────────────────────────────────

const SYMBOL_SECTOR_MAP = {
  HDFCBANK: 'BANKING', ICICIBANK: 'BANKING', KOTAKBANK: 'BANKING', AXISBANK: 'BANKING',
  SBIN: 'BANKING', INDUSINDBK: 'BANKING', CANBK: 'BANKING', BANKBARODA: 'BANKING', PNB: 'BANKING',
  BAJFINANCE: 'NBFC_FIN', BAJAJFINSV: 'NBFC_FIN', SHRIRAMFIN: 'NBFC_FIN', JIOFIN: 'NBFC_FIN',
  SBILIFE: 'INSURANCE', HDFCLIFE: 'INSURANCE', ICICIGI: 'INSURANCE', LICI: 'INSURANCE',
  TCS: 'IT', INFY: 'IT', HCLTECH: 'IT', TECHM: 'IT', WIPRO: 'IT', LTIM: 'IT',
  RELIANCE: 'ENERGY', ONGC: 'ENERGY', BPCL: 'ENERGY', IOC: 'ENERGY', GAIL: 'ENERGY',
  NTPC: 'POWER', POWERGRID: 'POWER', ADANIPOWER: 'POWER', TATAPOWER: 'POWER', ADANIGREEN: 'POWER',
  MARUTI: 'AUTO', 'M&M': 'AUTO', 'BAJAJ-AUTO': 'AUTO', HEROMOTOCO: 'AUTO', EICHERMOT: 'AUTO', TATAMOTORS: 'AUTO', TVSMOTOR: 'AUTO',
  ITC: 'FMCG', HINDUNILVR: 'FMCG', NESTLEIND: 'FMCG', TATACONSUM: 'FMCG', BRITANNIA: 'FMCG',
  TATASTEEL: 'METALS', HINDALCO: 'METALS', JSWSTEEL: 'METALS', VEDL: 'METALS', COALINDIA: 'METALS',
  SUNPHARMA: 'PHARMA', CIPLA: 'PHARMA', DRREDDY: 'PHARMA', APOLLOHOSP: 'PHARMA', DIVISLAB: 'PHARMA',
  BHARTIARTL: 'TELECOM', LT: 'INFRA', ADANIPORTS: 'INFRA', ADANIENT: 'INFRA', ULTRACEMCO: 'INFRA', GRASIM: 'INFRA',
  ETERNAL: 'CONSUMER_TECH', TITAN: 'CONSUMER', TRENT: 'CONSUMER', ASIANPAINT: 'CONSUMER',
  GOLDBEES: 'GOLD_SAFE_HAVEN', LIQUIDBEES: 'CASH_RESERVE'
};

function getSymbolSector(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/\d{2}[A-Z]{3}FUT$/, '').trim();
  if (/GOLD|SILVER/.test(s)) return 'PRECIOUS_METALS';
  if (/CRUDE|NATGAS/.test(s)) return 'ENERGY_MCX';
  if (/COPPER|ZINC|ALUM/.test(s)) return 'BASE_METALS_MCX';
  return SYMBOL_SECTOR_MAP[s] || 'OTHER';
}

/**
 * Sector Concentration Guard: Prevents opening 2 simultaneous positions in the exact same
 * correlated sector (e.g., AXISBANK + ICICIBANK + HDFCBANK all stopping out on one Bank Nifty spike).
 */
function checkSectorConcentration(openTrades = [], candidateSymbol = '', maxPerSector = 1) {
  const sector = getSymbolSector(candidateSymbol);
  if (sector === 'OTHER' || sector === 'GOLD_SAFE_HAVEN' || sector === 'CASH_RESERVE') {
    return { blocked: false, sector, activeInSector: [] };
  }
  const activeInSector = (openTrades || [])
    .filter(t => String(t.status || 'OPEN').toUpperCase() === 'OPEN')
    .filter(t => getSymbolSector(t.symbol) === sector)
    .map(t => String(t.symbol).toUpperCase());
  const blocked = activeInSector.length >= maxPerSector;
  return {
    blocked,
    sector,
    activeInSector,
    reason: blocked ? `Brain Sector Guard: Already holding ${activeInSector.join(', ')} in ${sector} (max ${maxPerSector}/sector)` : null
  };
}

/**
 * Live Equity Curve Governor (Anti-Tilt Capital Shield):
 * Compares live paper equity against peak equity & its own 5-trade moving average.
 */
function evaluateEquityGovernor(db, baseCapital = 15000) {
  const base = Number(baseCapital || 15000);
  if (!db) {
    return { state: 'NORMAL', riskMultiplier: 1.0, allowIntradayMis: true, currentEquity: base, peakEquity: base, drawdownPct: 0, consecutiveLosses: 0, above5TradeMa: true, rationale: 'Baseline equity healthy.' };
  }
  const closed = db.prepare(`
    SELECT id, net_pnl FROM paper_trades
    WHERE status != 'OPEN' AND symbol NOT LIKE '%TEST%'
    ORDER BY id ASC
  `).all();

  let eq = base, peak = base;
  const curve = [base];
  for (const t of closed) {
    eq = +(eq + Number(t.net_pnl || 0)).toFixed(2);
    if (eq > peak) peak = eq;
    curve.push(eq);
  }

  const drawdownPct = peak > 0 ? +(((peak - eq) / peak) * 100).toFixed(2) : 0;
  let consecutiveLosses = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    if (Number(closed[i].net_pnl || 0) < 0) consecutiveLosses++;
    else break;
  }

  const recentCurve = curve.slice(-5);
  const ma5 = recentCurve.reduce((a, b) => a + b, 0) / recentCurve.length;
  const above5TradeMa = eq >= ma5 - 1;

  let state = 'NORMAL';
  let riskMultiplier = 1.0;
  let allowIntradayMis = true;
  let rationale = `Equity ₹${eq.toLocaleString('en-IN')} at/above 5-trade MA (DD ${drawdownPct}%) — full 100% risk active.`;

  if (drawdownPct >= 4.5) {
    state = 'CAPITAL_SHIELD';
    riskMultiplier = 0.5;
    allowIntradayMis = false;
    rationale = `Drawdown ${drawdownPct}% ≥ 4.5% — Intraday MIS paused; capital shielded in ₹0-brok All-Weather CNC & Cash only.`;
  } else if (drawdownPct >= 2.5 || consecutiveLosses >= 2 || (!above5TradeMa && closed.length >= 5)) {
    state = 'DEFENSIVE';
    riskMultiplier = 0.6;
    allowIntradayMis = true;
    rationale = `Defensive throttle (DD ${drawdownPct}%, ${consecutiveLosses} loss streak, ${above5TradeMa ? 'above' : 'below'} 5-trade MA) — stepping risk down to 60%.`;
  }

  return {
    state,
    riskMultiplier,
    allowIntradayMis,
    currentEquity: eq,
    peakEquity: peak,
    drawdownPct,
    consecutiveLosses,
    above5TradeMa,
    ma5Equity: +ma5.toFixed(2),
    rationale
  };
}

/**
 * Multi-Strategy CIO Capital Allocator (Empirical 2.5Y Prior + Live Rolling Bandit):
 * Ensures capital always concentrates in winning engines and auto-pauses any decaying strategy
 * into SHADOW_PAUSED until it recovers.
 */
function evaluateStrategyBandit(db, { regime = null, swingBacktestData = null, allWeatherBacktest = null } = {}) {
  const engines = {
    ALL_WEATHER_CNC: {
      id: 'ALL_WEATHER_CNC',
      label: 'All-Weather CNC (RSI2 + Gold)',
      brokerageMode: '₹0 Brok CNC',
      priorScore: allWeatherBacktest?.returnToDd ? Math.min(95, Math.round(58 + allWeatherBacktest.returnToDd * 10)) : 88,
      trades: 0, wins: 0, netPnl: 0, recentPnls: []
    },
    CNC_SWING_CHAMPIONS: {
      id: 'CNC_SWING_CHAMPIONS',
      label: '2.5Y CNC Swing Champions',
      brokerageMode: '₹0 Brok CNC',
      priorScore: swingBacktestData?.avgChampionPF ? Math.min(92, Math.round(55 + swingBacktestData.avgChampionPF * 16)) : 80,
      trades: 0, wins: 0, netPnl: 0, recentPnls: []
    },
    MIS_INTRADAY: {
      id: 'MIS_INTRADAY',
      label: 'MIS Intraday Dual-Archetype',
      brokerageMode: '5x MIS',
      priorScore: 60,
      trades: 0, wins: 0, netPnl: 0, recentPnls: []
    },
    MCX_COMMODITY: {
      id: 'MCX_COMMODITY',
      label: 'MCX Commodities Evening',
      brokerageMode: 'MCX / Proxy',
      priorScore: 55,
      trades: 0, wins: 0, netPnl: 0, recentPnls: []
    }
  };

  if (db) {
    const closed = db.prepare(`
      SELECT symbol, net_pnl, brokerage, exit_reason FROM paper_trades
      WHERE status != 'OPEN' AND symbol NOT LIKE '%TEST%'
      ORDER BY id ASC
    `).all();
    for (const t of closed) {
      const reason = String(t.exit_reason || '').toUpperCase();
      const sym = String(t.symbol || '').toUpperCase();
      let key = 'MIS_INTRADAY';
      if (reason.includes('AUTO_AW_') || reason.includes('CNC_WASHOUT') || reason.includes('CNC_GOLD')) {
        key = 'ALL_WEATHER_CNC';
      } else if (reason.includes('CNC_SWING') || (Number(t.brokerage || 0) === 0 && !/GOLD|SILVER|CRUDE|NATGAS|COPPER/.test(sym))) {
        key = 'CNC_SWING_CHAMPIONS';
      } else if (/GOLD|SILVER|CRUDE|NATGAS|COPPER|ZINC|ALUM|COTTON/.test(sym)) {
        key = 'MCX_COMMODITY';
      }
      const pnl = Number(t.net_pnl || 0);
      const e = engines[key];
      e.trades++;
      if (pnl > 0) e.wins++;
      e.netPnl = +(e.netPnl + pnl).toFixed(2);
      e.recentPnls.push(pnl);
    }
  }

  const rg = regime?.regime || 'NEUTRAL_WAIT';
  const list = Object.values(engines).map(e => {
    const wr = e.trades > 0 ? Math.round((e.wins / e.trades) * 100) : null;
    const last4 = e.recentPnls.slice(-4);
    const last4Wins = last4.filter(p => p > 0).length;
    const last4Net = last4.reduce((a, b) => a + b, 0);

    // Bayesian blend: starts at empirical 2.5Y prior and smoothly shifts weight to live realized edge as N grows
    let liveAdj = 0;
    if (e.trades > 0) {
      const confidenceWeight = Math.min(0.65, e.trades / 12);
      const liveScore = Math.max(15, Math.min(95, 50 + (wr - 50) * 0.8 + (e.netPnl > 0 ? Math.min(20, e.netPnl / 15) : Math.max(-25, e.netPnl / 12))));
      liveAdj = (liveScore - e.priorScore) * confidenceWeight;
    }

    // Regime fit bonus/penalty
    let regimeAdj = 0;
    if (rg === 'HIGH_VOL_PANIC' || rg === 'BEAR_DRIFT') {
      if (e.id === 'ALL_WEATHER_CNC') regimeAdj += 10; // Built-in Gold/LiquidBees shield shines in panics
      if (e.id === 'CNC_SWING_CHAMPIONS') regimeAdj -= 15; // Long-only swing pauses in bear drifts
    } else if (rg === 'BULL_TREND') {
      if (e.id === 'CNC_SWING_CHAMPIONS' || e.id === 'ALL_WEATHER_CNC') regimeAdj += 6;
    }

    const compositeScore = Math.max(5, Math.min(98, Math.round(e.priorScore + liveAdj + regimeAdj)));
    const isDecaying = last4.length >= 4 && (last4Wins / last4.length) < 0.35 && last4Net < -180;

    let status = 'ACTIVE';
    let sizeMultiplier = 1.0;
    if (isDecaying) {
      status = 'SHADOW_PAUSED';
      sizeMultiplier = 0.0;
    } else if (compositeScore >= 75) {
      status = 'PRIMARY';
      sizeMultiplier = 1.0;
    } else if (compositeScore < 52) {
      status = 'REDUCED';
      sizeMultiplier = 0.6;
    }

    return {
      id: e.id,
      label: e.label,
      brokerageMode: e.brokerageMode,
      priorScore: e.priorScore,
      compositeScore,
      trades: e.trades,
      wins: e.wins,
      winRate: wr,
      netPnl: e.netPnl,
      status,
      sizeMultiplier,
      shadowReason: isDecaying ? `Strategy decay: ${last4Wins}/4 wins (₹${last4Net.toFixed(0)}) — paused in shadow mode` : null
    };
  });

  // Convert active composite scores into normalized capital weights (%)
  const activeSum = list.reduce((s, x) => s + (x.status === 'SHADOW_PAUSED' ? 0 : Math.pow(x.compositeScore / 50, 2)), 0) || 1;
  for (const x of list) {
    x.weightPct = x.status === 'SHADOW_PAUSED'
      ? 0
      : Math.round((Math.pow(x.compositeScore / 50, 2) / activeSum) * 100);
  }
  list.sort((a, b) => b.compositeScore - a.compositeScore);

  return {
    primaryStrategy: list[0]?.id || 'ALL_WEATHER_CNC',
    pausedStrategies: list.filter(x => x.status === 'SHADOW_PAUSED').map(x => x.id),
    strategies: list,
    byId: Object.fromEntries(list.map(x => [x.id, x]))
  };
}

/**
 * Time-of-Day Temporal Edge Matrix (IST Entry Windows):
 * Identifies your Golden Hours vs Toxic Hours from real SQLite history.
 */
function auditTemporalEdge(db) {
  const buckets = {
    OPEN_DRIVE: { id: 'OPEN_DRIVE', label: '09:15–10:30 Open Drive', trades: 0, wins: 0, netPnl: 0 },
    MID_MORNING: { id: 'MID_MORNING', label: '10:30–11:15 Mid-Morning', trades: 0, wins: 0, netPnl: 0 },
    MIDDAY_CHOP: { id: 'MIDDAY_CHOP', label: '11:15–13:30 Midday', trades: 0, wins: 0, netPnl: 0 },
    AFTERNOON: { id: 'AFTERNOON', label: '13:30–15:20 Afternoon', trades: 0, wins: 0, netPnl: 0 },
    MCX_EVENING: { id: 'MCX_EVENING', label: '15:20–23:30 MCX Evening', trades: 0, wins: 0, netPnl: 0 }
  };
  if (!db) return Object.values(buckets);

  const rows = db.prepare(`
    SELECT entry_time, created_at, net_pnl FROM paper_trades
    WHERE status != 'OPEN' AND symbol NOT LIKE '%TEST%'
  `).all();

  for (const r of rows) {
    const ts = new Date(r.entry_time || r.created_at || Date.now());
    if (isNaN(ts.getTime())) continue;
    const ist = new Date(ts.getTime() + 5.5 * 3600000);
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    let k = 'MCX_EVENING';
    if (mins >= 555 && mins < 630) k = 'OPEN_DRIVE';
    else if (mins >= 630 && mins < 675) k = 'MID_MORNING';
    else if (mins >= 675 && mins < 810) k = 'MIDDAY_CHOP';
    else if (mins >= 810 && mins <= 920) k = 'AFTERNOON';
    const b = buckets[k];
    const pnl = Number(r.net_pnl || 0);
    b.trades++;
    if (pnl > 0) b.wins++;
    b.netPnl = +(b.netPnl + pnl).toFixed(2);
  }

  return Object.values(buckets).map(b => ({
    ...b,
    winRate: b.trades > 0 ? Math.round((b.wins / b.trades) * 100) : null,
    verdict: b.trades < 2 ? 'COLLECTING' : (b.netPnl > 0 ? 'GOLDEN_HOUR' : 'TOXIC_HOUR')
  }));
}

/**
 * Session-Aware House-Money Daily Slot Budget & 60% Daily Profit-Floor Lock:
 *   • Separates ₹0-brokerage CNC Delivery trades from MIS/MCX intraday slots
 *   • Base cap = 4 MIS/MCX trades/day (max 3 in Morning Drive so Afternoon Drive always keeps fresh ammo!)
 *   • Unlocks +2 House-Money Bonus slots (up to 6/day) ONLY when today's realized net P&L >= +₹150,
 *     0 consecutive losses, and inside a prime drive window (never MIDDAY_CHOP)
 *   • Enforces a hard 60% Daily Profit-Floor Lock once peak daily profit >= ₹150, and caps
 *     bonus-trade risk strictly inside the 40% profit cushion so a winning day can NEVER turn red!
 */
function evaluateDailySlotBudget({
  todayTrades = [],
  baseMaxMisTrades = 4,
  bonusSlots = 2,
  maxMorningBaseTrades = 3,
  houseMoneyThresholdRs = 150,
  profitFloorRatio = 0.60,
  baseRiskRs = 150,
  sessionPhase = 'MORNING_DRIVE',
  isMcxHours = false
} = {}) {
  const realToday = (todayTrades || []).filter(t => !String(t.symbol || '').toUpperCase().includes('TEST'));
  const isCncTrade = (t) => {
    const r = String(t.exit_reason || '').toUpperCase();
    return r.includes('CNC_SWING') || r.includes('CNC_WASHOUT') || r.includes('CNC_GOLD') || r.includes('AUTO_AW_');
  };

  const cncToday = realToday.filter(isCncTrade);
  const intradayToday = realToday.filter(t => !isCncTrade(t));

  // Sort intraday closed trades in true chronological order by id / entry_time
  const closedIntraday = intradayToday
    .filter(t => t.status !== 'OPEN' && (t.net_pnl != null || t.pnl != null))
    .sort((a, b) => (Number(a.id || 0) - Number(b.id || 0)));

  let realizedPnl = 0;
  let peakRealizedPnl = 0;
  let consecutiveLosses = 0;
  for (const t of closedIntraday) {
    const pnl = Number(t.net_pnl ?? t.pnl ?? 0);
    realizedPnl = +(realizedPnl + pnl).toFixed(2);
    if (realizedPnl > peakRealizedPnl) peakRealizedPnl = realizedPnl;
    if (pnl < 0) consecutiveLosses++;
    else if (pnl > 0) consecutiveLosses = 0;
  }

  // Count how many intraday trades were opened during Morning Drive (09:15–11:15 IST)
  let morningIntradayCount = 0;
  for (const t of intradayToday) {
    const ts = new Date(t.entry_time || t.created_at || Date.now());
    if (isNaN(ts.getTime())) continue;
    const ist = new Date(ts.getTime() + 5.5 * 3600000);
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (mins >= 555 && mins < 675) morningIntradayCount++;
  }

  // 60% Daily Profit-Floor Lock once peak realized daily profit >= ₹150
  const profitFloorArmed = peakRealizedPnl >= houseMoneyThresholdRs;
  const profitFloorRs = profitFloorArmed ? +(peakRealizedPnl * profitFloorRatio).toFixed(2) : null;
  const profitLocked = profitFloorArmed && realizedPnl <= profitFloorRs;

  // Prime drive window check (never unlock House-Money bonus slots during MIDDAY_CHOP or CLOSING_CUTOFF)
  const isPrimeWindow = sessionPhase === 'MORNING_DRIVE' || sessionPhase === 'AFTERNOON_DRIVE' || (sessionPhase === 'CLOSED' && isMcxHours);
  const houseMoneyUnlocked = !profitLocked && realizedPnl >= houseMoneyThresholdRs && consecutiveLosses === 0 && isPrimeWindow;
  const effectiveMaxMisTrades = houseMoneyUnlocked ? (baseMaxMisTrades + bonusSlots) : baseMaxMisTrades;

  // Preserve at least 1 slot for Afternoon Drive on normal (non-house-money) mornings
  const morningLimit = houseMoneyUnlocked ? (maxMorningBaseTrades + bonusSlots) : maxMorningBaseTrades;
  const morningCapReached = sessionPhase === 'MORNING_DRIVE' && morningIntradayCount >= morningLimit;

  const isBonusSlotNext = houseMoneyUnlocked && intradayToday.length >= baseMaxMisTrades;
  // Cap bonus trade risk strictly within the 40% profit cushion so even a full SL stays above the 60% floor!
  const profitCushionRs = profitFloorArmed ? Math.max(0, realizedPnl - profitFloorRs) : 0;
  const effectiveTradeRiskRs = isBonusSlotNext
    ? Math.min(baseRiskRs, Math.max(50, Math.round(profitCushionRs * 0.85)))
    : baseRiskRs;

  const misSlotsRemaining = profitLocked || morningCapReached
    ? 0
    : Math.max(0, effectiveMaxMisTrades - intradayToday.length);

  let statusLabel = `${intradayToday.length}/${effectiveMaxMisTrades} MIS`;
  let reason = null;
  if (profitLocked) {
    statusLabel = `🔒 PROFIT FLOOR LOCKED (+₹${realizedPnl})`;
    reason = `Daily Profit Floor Hit: Realized +₹${realizedPnl} reached 60% floor (+₹${profitFloorRs} of +₹${peakRealizedPnl} peak) — halting MIS to lock green day`;
  } else if (morningCapReached) {
    statusLabel = `⏳ MORNING CAP (${morningIntradayCount}/${morningLimit} · Saving Afternoon Ammo)`;
    reason = `Session Partition Guard: ${morningIntradayCount}/${morningLimit} morning trades used — reserving fresh slots for 13:30 IST Afternoon Drive`;
  } else if (houseMoneyUnlocked) {
    statusLabel = `🔥 HOUSE-MONEY ${intradayToday.length}/${effectiveMaxMisTrades} (Floor +₹${profitFloorRs})`;
  }

  return {
    intradayCount: intradayToday.length,
    cncCount: cncToday.length,
    morningIntradayCount,
    baseMaxMisTrades,
    effectiveMaxMisTrades,
    misSlotsRemaining,
    houseMoneyUnlocked,
    isBonusSlotNext,
    effectiveTradeRiskRs,
    todayRealizedPnl: realizedPnl,
    peakRealizedPnl,
    profitFloorArmed,
    profitFloorRs,
    profitLocked,
    morningCapReached,
    statusLabel,
    reason
  };
}

/**
 * Reads latest 12-Pillar Claude Macro Snapshot from SQLite `macro_snapshots`
 * so Trading Brain v2 incorporates macro climate (RBI, US Yields, Brent, FII/DII, SIP flows).
 */
function readLatestMacroSnapshot(db) {
  if (!db) return { available: false, verdict: 'UNKNOWN', greenCount: 6, macroMultiplier: 1.0 };
  try {
    const row = db.prepare(`SELECT generated_at, verdict, green_count FROM macro_snapshots ORDER BY id DESC LIMIT 1`).get();
    if (!row) return { available: false, verdict: 'UNKNOWN', greenCount: 6, macroMultiplier: 1.0 };
    const greenCount = Number(row.green_count || 0);
    const verdict = String(row.verdict || 'Watch closely');
    const isWait = verdict.toLowerCase() === 'wait' || greenCount <= 3;
    const macroMultiplier = isWait ? 0.75 : (greenCount >= 7 ? 1.0 : 0.90);
    return {
      available: true,
      generatedAt: row.generated_at,
      verdict,
      greenCount,
      macroMultiplier
    };
  } catch (_) {
    return { available: false, verdict: 'UNKNOWN', greenCount: 6, macroMultiplier: 1.0 };
  }
}

/**
 * Full Brain v2 Evaluation combining:
 * Live Intraday Regime + 12-Pillar Macro + MFE/MAE Execution Audit + Strategy Bandit + Equity Governor + Temporal Edge + Champions
 */
function evaluateBrainState({
  db = null,
  nseMcpOverview = null,
  nseMcpQuotes = null,
  swingBacktestData = null,
  allWeatherBacktest = null,
  baseCapital = 15000
} = {}) {
  const regime = classifyMarketRegime({ nseMcpOverview, nseMcpQuotes });
  const macroAlignment = readLatestMacroSnapshot(db);
  const execution = auditExecutionQuality(db);
  const equityGovernor = evaluateEquityGovernor(db, baseCapital);
  const strategyAllocator = evaluateStrategyBandit(db, { regime, swingBacktestData, allWeatherBacktest });
  const temporalEdge = auditTemporalEdge(db);
  const toxicWindows = temporalEdge.filter(w => w.verdict === 'TOXIC_HOUR' && w.trades >= 3).map(w => w.id);
  const benchedSet = new Set(execution.autoBenchedSymbols.map(b => b.symbol));
  const champions = (swingBacktestData?.provenChampions || []).filter(sym => !benchedSet.has(sym));

  // Combined conservative size multiplier (Regime × Equity Curve Governor × 12-Pillar Macro)
  const combinedSizeMultiplier = +(Math.min(
    regime.sizeMultiplier || 1,
    equityGovernor.riskMultiplier || 1,
    macroAlignment.macroMultiplier || 1
  )).toFixed(2);

  return {
    version: '2.5-UNIFIED-AI-CIO',
    updatedAt: new Date().toISOString(),
    regime,
    macroAlignment,
    execution,
    equityGovernor,
    liveCompoundedEquity: Math.max(Number(baseCapital || 15000), Number(equityGovernor.currentEquity || baseCapital || 15000)),
    strategyAllocator,
    temporalEdge,
    toxicWindows,
    combinedSizeMultiplier,
    activeChampions: champions,
    totalChampionsAvailable: swingBacktestData?.provenChampionsCount || 0,
    benchedCount: execution.autoBenchedSymbols.length
  };
}

function getIstDateStr(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 3600000);
  return ist.toISOString().slice(0, 10);
}

function classifyTradeBucket(t) {
  const sym = String(t.symbol || '').toUpperCase();
  const reason = String(t.exit_reason || '').toUpperCase();
  if (reason.includes('CNC_SWING') || (Number(t.brokerage || 0) === 0 && !/GOLD|SILVER|CRUDE|NATGAS|COPPER/.test(sym))) {
    return 'CNC_SWING';
  }
  if (/GOLD|SILVER|CRUDE|NATGAS|COPPER|ZINC|ALUM|COTTON/.test(sym)) {
    return 'MCX_COMMODITY';
  }
  return 'MIS_INTRADAY';
}

/**
 * Layer 4: Automated Nightly EOD Brain Post-Mortem (16:30 IST or on-demand)
 * Summarizes the trading day's execution, MFE/MAE leaks, regime alignment, and
 * missed Nifty-50 Champion movers, persisting a structured snapshot in SQLite.
 */
function generateDailyPostMortem(db, {
  nseMcpOverview = null,
  nseMcpQuotes = null,
  swingBacktestData = null,
  allWeatherBacktest = null,
  claudeEnrichment = null,
  dateIst = null
} = {}) {
  const todayIst = dateIst || getIstDateStr();
  const brain = evaluateBrainState({ db, nseMcpOverview, nseMcpQuotes, swingBacktestData, allWeatherBacktest });
  let dayTrades = [];
  if (db) {
    ensureBrainTables(db);
    dayTrades = db.prepare(`
      SELECT p.*, a.mfe_r, a.mae_r
      FROM paper_trades p
      LEFT JOIN trade_execution_audit a ON a.trade_id = p.id
      WHERE p.status != 'OPEN'
        AND p.symbol NOT LIKE '%TEST%'
        AND date(COALESCE(p.exit_time, p.created_at), '+5 hours', '+30 minutes') = ?
      ORDER BY p.id ASC
    `).all(todayIst);
  }

  const wins = dayTrades.filter(t => Number(t.net_pnl || 0) > 0);
  const losses = dayTrades.filter(t => Number(t.net_pnl || 0) < 0);
  const netPnlDay = +dayTrades.reduce((s, t) => s + Number(t.net_pnl || 0), 0).toFixed(2);
  const feesDay = +dayTrades.reduce((s, t) => s + Number(t.brokerage || 0) + Number(t.stt_gst || 0), 0).toFixed(2);
  const dayWinRate = dayTrades.length ? Math.round((wins.length / dayTrades.length) * 100) : 0;

  const champSet = new Set(swingBacktestData?.provenChampions || []);
  const topGainers = Array.isArray(nseMcpOverview?.topGainers) ? nseMcpOverview.topGainers : [];
  const championMovers = topGainers
    .filter(g => champSet.has(String(g.symbol || '').toUpperCase()))
    .map(g => `${g.symbol} (+${g.perChange}%)`);

  const insights = [];
  if (dayTrades.length === 0) {
    insights.push(`0 closed trades on ${todayIst} (Regime: ${brain.regime.regime} — ${brain.regime.directive})`);
  } else {
    insights.push(`${dayTrades.length} trades closed (${wins.length}W/${losses.length}L · ${dayWinRate}% WR) for Net ${netPnlDay >= 0 ? '+' : ''}₹${netPnlDay} (Fees ₹${feesDay}).`);
  }
  if (championMovers.length > 0) {
    insights.push(`Proven 2.5Y CNC Champions bucking/leading tape: ${championMovers.join(', ')}.`);
  }
  if (brain.execution.diagnoses && brain.execution.diagnoses[0]) {
    insights.push(brain.execution.diagnoses[0]);
  }

  const finalInsights = (claudeEnrichment && Array.isArray(claudeEnrichment.insights) && claudeEnrichment.insights.length > 0)
    ? claudeEnrichment.insights
    : insights;

  const report = {
    dateIst: todayIst,
    generatedAt: new Date().toISOString(),
    source: claudeEnrichment?.source || 'DETERMINISTIC_BRAIN',
    regime: brain.regime.regime,
    niftyPct: brain.regime.niftyPct,
    advPct: brain.regime.advPct,
    macroVerdict: brain.macroAlignment?.verdict || 'UNKNOWN',
    executionScore: brain.execution.executionScore,
    tradesCount: dayTrades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: dayWinRate,
    netPnlDay,
    feesDay,
    championMovers,
    autoBenched: brain.execution.autoBenchedSymbols.map(b => b.symbol),
    tomorrowFocus: claudeEnrichment?.tomorrowFocus || null,
    insights: finalInsights
  };

  if (db) {
    try {
      db.prepare(`
        INSERT INTO brain_snapshots (date_ist, regime, execution_score, payload_json)
        VALUES (?, ?, ?, ?)
      `).run(todayIst, report.regime, report.executionScore, JSON.stringify(report));
    } catch (_) {}
  }

  return { ...report, dayTrades };
}

/**
 * Complete Institutional Quant Scorecard payload for mcx-logger.html:
 * Equity curve, Bucket attribution (CNC Swing vs MIS vs MCX), MFE/MAE Audit,
 * 30-Day Paper-to-Live Graduation Gauge, and Daily Brain Post-Mortems.
 */
function buildQuantScorecard(db, {
  accountProfile = { capital: 15000 },
  nseMcpOverview = null,
  nseMcpQuotes = null,
  swingBacktestData = null,
  allWeatherBacktest = null
} = {}) {
  const baseCap = Number(accountProfile?.capital || 15000);
  const brain = evaluateBrainState({ db, nseMcpOverview, nseMcpQuotes, swingBacktestData, allWeatherBacktest, baseCapital: baseCap });
  if (!db) {
    return {
      ok: true,
      baseCapital: baseCap,
      summary: { currentEquity: baseCap, totalNetPnl: 0, returnPct: 0, closedTrades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, maxDrawdownPct: 0, totalFees: 0, feeDragPct: 0 },
      equityCurve: [{ label: 'Start', equity: baseCap, pnl: 0 }],
      attribution: { CNC_SWING: { trades: 0, wins: 0, netPnl: 0, fees: 0 }, MIS_INTRADAY: { trades: 0, wins: 0, netPnl: 0, fees: 0 }, MCX_COMMODITY: { trades: 0, wins: 0, netPnl: 0, fees: 0 } },
      mfeMaeAudit: [],
      graduation: { readyForLive: false, scorePct: 0, checks: [] },
      postMortems: [],
      brain
    };
  }

  ensureBrainTables(db);
  const allRealTrades = db.prepare(`
    SELECT p.*, a.mfe_r, a.mae_r, a.mfe_price, a.mae_price
    FROM paper_trades p
    LEFT JOIN trade_execution_audit a ON a.trade_id = p.id
    WHERE p.symbol NOT LIKE '%TEST%'
    ORDER BY p.id ASC
  `).all();

  const closed = allRealTrades.filter(t => t.status !== 'OPEN');
  let equity = baseCap;
  let peak = baseCap;
  let maxDdPct = 0;
  let wins = 0, grossWin = 0, grossLoss = 0, totalFees = 0;

  const equityCurve = [{ label: 'Start', equity: baseCap, pnl: 0, symbol: 'BASE' }];
  const attribution = {
    CNC_SWING: { trades: 0, wins: 0, netPnl: 0, fees: 0 },
    MIS_INTRADAY: { trades: 0, wins: 0, netPnl: 0, fees: 0 },
    MCX_COMMODITY: { trades: 0, wins: 0, netPnl: 0, fees: 0 }
  };

  for (const t of closed) {
    const pnl = Number(t.net_pnl || 0);
    const fees = Number(t.brokerage || 0) + Number(t.stt_gst || 0);
    equity = +(equity + pnl).toFixed(2);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDdPct) maxDdPct = dd;

    totalFees += fees;
    if (pnl > 0) { wins++; grossWin += pnl; }
    else if (pnl < 0) { grossLoss += Math.abs(pnl); }

    const bucket = classifyTradeBucket(t);
    attribution[bucket].trades++;
    if (pnl > 0) attribution[bucket].wins++;
    attribution[bucket].netPnl = +(attribution[bucket].netPnl + pnl).toFixed(2);
    attribution[bucket].fees = +(attribution[bucket].fees + fees).toFixed(2);

    const ts = String(t.exit_time || t.created_at || '').slice(5, 16).replace('T', ' ');
    equityCurve.push({
      tradeId: t.id,
      label: `#${t.id} ${t.symbol}`,
      time: ts,
      symbol: t.symbol,
      pnl,
      equity
    });
  }

  const totalNetPnl = +(equity - baseCap).toFixed(2);
  const returnPct = +((totalNetPnl / baseCap) * 100).toFixed(2);
  const winRate = closed.length ? Math.round((wins / closed.length) * 100) : 0;
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 5.0 : 0);
  const feeDragPct = grossWin > 0 ? +((totalFees / grossWin) * 100).toFixed(1) : (totalFees > 0 ? 100 : 0);

  // Build MFE/MAE Audit table (most recent 15 real trades)
  const mfeMaeAudit = [...allRealTrades].reverse().slice(0, 15).map(t => {
    const pnl = t.net_pnl != null ? Number(t.net_pnl) : null;
    const mfeR = t.mfe_r != null ? Number(t.mfe_r) : null;
    const maeR = t.mae_r != null ? Number(t.mae_r) : null;
    let verdict = t.status === 'OPEN' ? 'LIVE_OPEN' : 'RECORDED';
    if (t.status !== 'OPEN' && mfeR != null) {
      if (pnl > 0 && maeR <= 0.25) verdict = 'SNIPER_WIN';
      else if (pnl > 0) verdict = 'PROFIT_LOCKED';
      else if (pnl < 0 && mfeR >= 1.0) verdict = 'REVERSED_WINNER';
      else verdict = 'STOP_PROTECTED';
    }
    return {
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      bucket: classifyTradeBucket(t),
      entry: Number(t.entry_price),
      exit: t.exit_price != null ? Number(t.exit_price) : null,
      netPnl: pnl,
      status: t.status,
      exitReason: t.exit_reason,
      mfeR,
      maeR,
      verdict
    };
  });

  // 30-Day Paper-to-Live Graduation Checklist
  const checks = [
    { id: 'trades', label: 'Sample Size (≥ 20 Closed Trades)', current: `${closed.length} / 20`, passed: closed.length >= 20, pct: Math.min(100, Math.round((closed.length / 20) * 100)) },
    { id: 'pf', label: 'Profit Factor (≥ 1.40x)', current: `${profitFactor}x`, passed: closed.length >= 4 && profitFactor >= 1.40, pct: Math.min(100, Math.round((profitFactor / 1.40) * 100)) },
    { id: 'wr', label: 'Win Rate (≥ 50%)', current: `${winRate}%`, passed: closed.length >= 4 && winRate >= 50, pct: Math.min(100, Math.round((winRate / 50) * 100)) },
    { id: 'dd', label: 'Max Drawdown (< 5.0%)', current: `${maxDdPct.toFixed(2)}%`, passed: maxDdPct < 5.0, pct: maxDdPct < 5.0 ? 100 : Math.max(0, Math.round((1 - (maxDdPct - 5) / 10) * 100)) }
  ];
  const passedCount = checks.filter(c => c.passed).length;
  const graduation = {
    readyForLive: passedCount === checks.length,
    passedCount,
    totalChecks: checks.length,
    scorePct: Math.round(checks.reduce((s, c) => s + c.pct, 0) / checks.length),
    checks
  };

  // Load recent nightly Brain Post-Mortems
  let postMortems = [];
  try {
    const snapRows = db.prepare(`SELECT id, date_ist, regime, execution_score, payload_json, created_at FROM brain_snapshots ORDER BY id DESC LIMIT 8`).all();
    postMortems = snapRows.map(r => {
      try { return { id: r.id, ...JSON.parse(r.payload_json) }; }
      catch (_) { return { id: r.id, dateIst: r.date_ist, regime: r.regime, executionScore: r.execution_score, insights: [] }; }
    });
  } catch (_) {}

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    baseCapital: baseCap,
    summary: {
      currentEquity: equity,
      totalNetPnl,
      returnPct,
      closedTrades: closed.length,
      wins,
      losses: closed.length - wins,
      winRate,
      profitFactor,
      maxDrawdownPct: +maxDdPct.toFixed(2),
      totalFees: +totalFees.toFixed(2),
      feeDragPct
    },
    equityCurve,
    attribution,
    mfeMaeAudit,
    graduation,
    postMortems,
    brain
  };
}

module.exports = {
  ensureBrainTables,
  readLatestMacroSnapshot,
  updateTradeExcursions,
  classifyMarketRegime,
  auditExecutionQuality,
  getSymbolSector,
  checkSectorConcentration,
  evaluateEquityGovernor,
  evaluateStrategyBandit,
  auditTemporalEdge,
  evaluateDailySlotBudget,
  evaluateBrainState,
  generateDailyPostMortem,
  buildQuantScorecard
};
