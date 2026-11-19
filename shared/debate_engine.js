/**
 * shared/debate_engine.js — TauricResearch-Inspired Bull vs. Bear Devil's Advocate,
 * Post-Trade Reflection Memory & Adaptive 3-Tier Risk Stance Engine
 *
 * Adapts the highest-value institutional desk concepts from TradingAgents into
 * sub-millisecond deterministic guardrails + optional on-demand LLM synthesis:
 *  1. Bull vs. Bear Devil's Advocate Debate (anti-confirmation-bias filter)
 *  2. Post-Trade Reflection Memory (extracts & applies lessons from past wins/losses)
 *  3. Adaptive 3-Tier Risk Stance (Auto-shifts to Conservative 60% size after 1 loss)
 *
 * UMD module: exports to Node.js (`module.exports`) and browsers (`window.DebateEngine`).
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.DebateEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Builds a structured Bull vs. Bear Devil's Advocate debate from live desk evidence
   * and recent SQLite trade lessons.
   */
  function buildQuantitativeDebate({
    symbol = 'GOLDM',
    commodityId = 'gold',
    action = 'WAIT',
    confidence = 0,
    regime = 'TRANSITIONAL',
    htfTrend = null,
    dualFeed = null,
    smc = null,
    geoIntel = null,
    recentLessons = [],
    netRR = 0
  } = {}) {
    const act = String(action || 'WAIT').toUpperCase();
    const bullPoints = [];
    const bearPoints = [];
    let bullScore = 0;
    let bearScore = 0;

    // 1. Higher-Timeframe (1H) Structural Alignment
    const htfBias = htfTrend?.bias || 'NEUTRAL';
    if (htfBias === 'BULLISH') {
      bullPoints.push('1H HTF trend is BULLISH (EMA9 >= EMA21, price above 1H mean).');
      bullScore += 25;
    } else if (htfBias === 'BEARISH') {
      bearPoints.push('1H HTF trend is BEARISH (EMA9 <= EMA21, downward structural pressure).');
      bearScore += 25;
    } else {
      bearPoints.push('1H HTF trend is NEUTRAL — lacking higher-timeframe directional tailwind.');
      bearScore += 8;
    }

    // 2. ADX Regime & Net R:R Quality
    if (regime === 'TRENDING') {
      const msg = `Trending regime confirmed (Net R:R 1:${Number(netRR || 0).toFixed(2)} after fees).`;
      if (act === 'SELL') { bearPoints.push(msg); bearScore += 18; }
      else { bullPoints.push(msg); bullScore += 18; }
    } else if (regime === 'RANGING') {
      const warn = 'Ranging/Chop regime — breakout trades face high false-breakout stop hunts.';
      bullPoints.push('Mean-reversion bounces near range edges can offer quick T1 scalps.');
      bearPoints.push(warn);
      bearScore += 12;
      bullScore += 6;
    }

    // 3. Dual-Feed Parity, Kite OI & Session Window (H4)
    const sessionWindow = dualFeed?.sessionWindow || 'UNKNOWN';
    if (dualFeed) {
      if (dualFeed.paritySignal === 'BULLISH_LAG') {
        bullPoints.push(`International USD benchmark leading higher (${dualFeed.paritySpreadPct >= 0 ? '+' : ''}${dualFeed.paritySpreadPct}% parity spread).`);
        bullScore += 20;
      } else if (dualFeed.paritySignal === 'BEARISH_LAG') {
        bearPoints.push(`International USD benchmark leading lower (${dualFeed.paritySpreadPct}% parity spread).`);
        bearScore += 20;
      }

      if (dualFeed.oiRegime === 'LONG_BUILDUP' || dualFeed.oiRegime === 'SHORT_COVERING') {
        bullPoints.push(`Kite Futures OI confirms ${dualFeed.oiRegime.replace('_', ' ')}${dualFeed.domRatio ? ` (DOM ${dualFeed.domRatio}x)` : ''}.`);
        bullScore += 18;
      } else if (dualFeed.oiRegime === 'SHORT_BUILDUP' || dualFeed.oiRegime === 'LONG_UNWINDING') {
        bearPoints.push(`Kite Futures OI confirms ${dualFeed.oiRegime.replace('_', ' ')}${dualFeed.domRatio ? ` (DOM ${dualFeed.domRatio}x)` : ''}.`);
        bearScore += 18;
      }

      if (sessionWindow === 'PRIME_US_OVERLAP' || sessionWindow === 'LONDON_OPEN') {
        const winMsg = `High-liquidity institutional window active (${sessionWindow}).`;
        if (act === 'SELL') { bearPoints.push(winMsg); bearScore += 12; }
        else { bullPoints.push(winMsg); bullScore += 12; }
      } else if (sessionWindow === 'MIDDAY_LULL') {
        const lullMsg = 'MIDDAY_LULL window — thin volume often causes choppy stop-outs.';
        if (act === 'BUY') { bearPoints.push(lullMsg); bearScore += 16; }
        else if (act === 'SELL') { bullPoints.push(lullMsg); bullScore += 16; }
        else { bearPoints.push(lullMsg); bearScore += 10; }
      }
    }

    // 4. Smart Money Concepts (SMC) Confluence & Traps
    if (smc && smc.ok) {
      const freshBullOB = (smc.orderBlocks || []).some(o => o.type === 'BULLISH_OB' && !o.mitigated);
      const freshBearOB = (smc.orderBlocks || []).some(o => o.type === 'BEARISH_OB' && !o.mitigated);
      if (freshBullOB) { bullPoints.push('Unmitigated Bullish Order Block providing institutional demand floor.'); bullScore += 12; }
      if (freshBearOB) { bearPoints.push('Unmitigated Bearish Order Block creating overhead supply ceiling.'); bearScore += 12; }

      const sweeps = smc.sweeps || [];
      if (sweeps.length > 0) {
        const lastSweep = sweeps[sweeps.length - 1];
        if (lastSweep.type === 'BUY_SIDE_SWEEP') {
          bearPoints.push('Trap Alert: Recent Buy-Side Liquidity Sweep detected (retail breakout buyers trapped).');
          bearScore += 22;
        } else if (lastSweep.type === 'SELL_SIDE_SWEEP') {
          bullPoints.push('Reversal Fuel: Recent Sell-Side Liquidity Sweep cleared weak lows.');
          bullScore += 22;
        }
      }
    }

    // 5. Geopolitical Shock Overlay
    if (geoIntel && geoIntel.threatLevel && (geoIntel.threatLevel === 'HIGH' || geoIntel.threatLevel === 'CRITICAL')) {
      const analogName = geoIntel.closestAnalog?.name || 'Elevated Geopolitical Risk';
      if (commodityId === 'gold' || commodityId === 'silver' || commodityId === 'crude') {
        bullPoints.push(`Macro tailwind: ${geoIntel.threatLevel} geopolitical regime (${analogName}) supports safe-haven/energy premium.`);
        bullScore += 10;
      }
      bearPoints.push(`Headline whiplash risk: ${geoIntel.threatLevel} geopolitical wires can trigger sudden 2-way stop spikes.`);
      bearScore += 10;
    }

    // 6. Episodic Reflection Memory (Check repeated losses in same symbol + session/regime)
    const relevantLessons = Array.isArray(recentLessons) ? recentLessons.slice(0, 8) : [];
    const matchingWindowLosses = relevantLessons.filter(l => {
      const pnl = Number(l.net_pnl ?? l.netPnl ?? l.pnl ?? 0);
      if (pnl >= 0) return false;
      const sameWindow = sessionWindow !== 'UNKNOWN' && l.session_window === sessionWindow;
      const sameRegime = regime && l.regime === regime;
      return sameWindow || sameRegime;
    });

    const memoryWarnings = [];
    if (matchingWindowLosses.length >= 2) {
      const warn = `Reflection Memory Alert: ${matchingWindowLosses.length} recent losses on ${symbol} in ${sessionWindow}/${regime} — historically unfavorable setup.`;
      memoryWarnings.push(warn);
      if (act === 'BUY') { bearPoints.push(warn); bearScore += 30; }
      else if (act === 'SELL') { bullPoints.push(warn); bullScore += 30; }
      else { bearPoints.push(warn); bearScore += 20; }
    } else if (matchingWindowLosses.length === 1) {
      const warn = `Memory Caution: 1 recent loss in ${sessionWindow}/${regime} — tighten discipline or halve size.`;
      memoryWarnings.push(warn);
      if (act === 'BUY') { bearPoints.push(warn); bearScore += 12; }
      else if (act === 'SELL') { bullPoints.push(warn); bullScore += 12; }
    }

    // 7. Synthesize Final Verdict (CONFIRM / HALVE_SIZE / VETO / WAIT)
    let verdict = 'WAIT';
    let sizeMultiplier = 1.0;
    let rationale = 'No active directional signal — wait for alignment.';

    if (act === 'BUY' || act === 'SELL') {
      const alignedScore = act === 'BUY' ? bullScore : bearScore;
      const opposingScore = act === 'BUY' ? bearScore : bullScore;
      const netEdge = alignedScore - opposingScore;

      if (matchingWindowLosses.length >= 2 || netEdge <= -15) {
        verdict = 'VETO';
        sizeMultiplier = 0;
        rationale = matchingWindowLosses.length >= 2
          ? `Devil's Advocate VETO: Repeated recent losses in ${sessionWindow}/${regime}. Skip this trade.`
          : `Devil's Advocate VETO: Opposing risk factors (${opposingScore}) outweigh thesis (${alignedScore}).`;
      } else if (netEdge < 12 || sessionWindow === 'MIDDAY_LULL' || Number(confidence || 0) < 70) {
        verdict = 'HALVE_SIZE';
        sizeMultiplier = 0.5;
        rationale = `Proceed with 50% size: Thesis (${alignedScore}) faces notable counter-risks (${opposingScore}) or sub-optimal window (${sessionWindow}).`;
      } else {
        verdict = 'CONFIRM';
        sizeMultiplier = 1.0;
        rationale = `Confirmed ${act}: Bull/Bear debate favors thesis (${alignedScore} vs ${opposingScore}) with clean structure.`;
      }
    }

    return {
      symbol,
      action: act,
      verdict,
      sizeMultiplier,
      bullScore,
      bearScore,
      bullCase: bullPoints.slice(0, 4),
      bearCase: bearPoints.slice(0, 4),
      memoryWarnings,
      rationale,
      source: 'QUANT_DEBATE_V1'
    };
  }

  /**
   * Adaptive 3-Tier Risk Stance (Inspired by TauricResearch's Risk Management Team).
   * Automatically steps down risk from ₹125 to ₹75 (60%) after 1 loss today until a win resets it.
   */
  function evaluateAdaptiveRiskStance({
    trades = [],
    baseRisk = 125,
    dailyLossLimit = 300,
    requestedStance = 'AUTO',
    refDate
  } = {}) {
    const base = Math.max(25, Number(baseRisk) || 125);
    const limit = Math.max(50, Number(dailyLossLimit) || 300);
    const req = String(requestedStance || 'AUTO').toUpperCase();

    const d = refDate ? new Date(refDate) : new Date();
    const todayIST = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    const todayClosed = (Array.isArray(trades) ? trades : []).filter(t => {
      const rawPnl = t.pnl ?? t.netPnl ?? t.net_pnl;
      if (rawPnl == null) return false;
      const rawTs = t.timestamp || t.exit_time || t.created_at;
      const tDate = t.date || (rawTs ? new Date(rawTs).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : null);
      if (!tDate) return true;
      return tDate === todayIST;
    });

    let dailyNetPnl = 0;
    let consecutiveLosses = 0;
    let consecutiveWins = 0;
    for (const t of todayClosed.slice().reverse()) {
      const p = Number(t.pnl ?? t.netPnl ?? t.net_pnl ?? 0);
      dailyNetPnl += p;
      if (p < 0) {
        consecutiveLosses++;
        consecutiveWins = 0;
      } else if (p > 0) {
        consecutiveWins++;
        consecutiveLosses = 0;
      }
    }

    const remainingBudget = Math.max(0, limit + dailyNetPnl);

    if (req === 'CONSERVATIVE') {
      const eff = Math.min(remainingBudget || base, Math.round(base * 0.60));
      return {
        stance: 'CONSERVATIVE',
        effectiveRisk: Math.max(25, eff),
        minNetRR: 1.5,
        label: '🛡️ CONSERVATIVE (60% Size)',
        reason: 'Manual conservative risk stance active.'
      };
    }

    if (req === 'AGGRESSIVE') {
      const eff = Math.min(200, Math.min(remainingBudget || base, Math.round(base * 1.20)));
      return {
        stance: 'AGGRESSIVE',
        effectiveRisk: Math.max(25, eff),
        minNetRR: 1.3,
        label: '⚡ AGGRESSIVE (120% Cap)',
        reason: 'Manual aggressive stance (capped by daily remaining risk budget).'
      };
    }

    // AUTO / BALANCED: Auto-shift to CONSERVATIVE_RECOVERY after 1 loss or >=35% daily drawdown
    if (consecutiveLosses >= 1 || dailyNetPnl <= -(limit * 0.35)) {
      const eff = Math.min(remainingBudget || base, Math.round(base * 0.60));
      return {
        stance: 'CONSERVATIVE_RECOVERY',
        effectiveRisk: Math.max(25, eff),
        minNetRR: 1.5,
        label: '🛡️ AUTO-CONSERVATIVE (Recovery 60%)',
        reason: `Stepped down risk to ₹${Math.max(25, eff)} after ${consecutiveLosses} loss / ₹${Math.round(dailyNetPnl)} day P&L. Resets after 1 win.`
      };
    }

    if (consecutiveWins >= 2 && dailyNetPnl > 0) {
      return {
        stance: 'BALANCED_LOCKED',
        effectiveRisk: base,
        minNetRR: 1.35,
        label: '✅ BALANCED (Profits Protected)',
        reason: `${consecutiveWins} wins today (+₹${Math.round(dailyNetPnl)}). Keeping flat ₹${base} risk — never over-leveraging after wins.`
      };
    }

    return {
      stance: 'BALANCED',
      effectiveRisk: Math.min(remainingBudget || base, base),
      minNetRR: 1.35,
      label: '⚖️ BALANCED (1.25% Risk)',
      reason: `Standard ₹${base} risk budget active on ₹10,000 capital.`
    };
  }

  /**
   * Distills a closed trade into a compact post-trade reflection lesson for SQLite memory.
   */
  function extractLessonFromTrade({
    symbol = 'GOLDM',
    side = 'BUY',
    netPnl = 0,
    exitReason = 'MANUAL_CLOSE',
    regime = 'UNKNOWN',
    sessionWindow = 'UNKNOWN',
    paritySignal = 'NEUTRAL'
  } = {}) {
    const pnl = Math.round(Number(netPnl || 0) * 100) / 100;
    const outcome = pnl >= 0 ? 'WIN' : 'LOSS';
    const pnlStr = `${pnl >= 0 ? '+₹' : '-₹'}${Math.abs(pnl).toFixed(0)}`;

    let lesson;
    if (outcome === 'LOSS') {
      if (sessionWindow === 'MIDDAY_LULL') {
        lesson = `${outcome} (${pnlStr}) on ${symbol} ${side} during MIDDAY_LULL (${regime}): Avoid thin mid-day chop; wait for LONDON_OPEN or PRIME_US_OVERLAP.`;
      } else if (exitReason === 'AUTO_SL' || exitReason === 'SL_HIT') {
        lesson = `${outcome} (${pnlStr}) on ${symbol} ${side} (${regime}/${sessionWindow}, parity ${paritySignal}): Stop-loss protected capital; verify 1H HTF & OB before re-entry.`;
      } else {
        lesson = `${outcome} (${pnlStr}) on ${symbol} ${side} (${regime}/${sessionWindow}): Closed via ${exitReason}. Step down next trade risk to Conservative (60%).`;
      }
    } else {
      lesson = `${outcome} (${pnlStr}) on ${symbol} ${side} (${regime}/${sessionWindow}, parity ${paritySignal}): Clean execution via ${exitReason}; repeat aligned setups.`;
    }

    return {
      symbol,
      side,
      outcome,
      netPnl: pnl,
      regime,
      sessionWindow,
      paritySignal,
      exitReason,
      lesson
    };
  }

  return {
    buildQuantitativeDebate,
    evaluateAdaptiveRiskStance,
    extractLessonFromTrade
  };

}));
