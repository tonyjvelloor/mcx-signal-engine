/**
 * shared/global_usd_mode.js — Global USD / CFD & Olymp Trade Signal Adapter
 *
 * Translates MCX INR commodity signals into international USD spot/CFD levels
 * (XAU/USD, XAG/USD, WTI/USOIL, NATGAS, COPPER) with:
 * - Forex / CFD Stop-Loss & Take-Profit levels in USD
 * - Fixed-Time (FTT) expiry window guidance (never < 15m) & break-even math
 * - Strict 1%-2% USD account stake sizing
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.GlobalUsdMode = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const USD_INSTRUMENTS = {
    gold:   { pair: 'XAU/USD',       label: 'Gold Spot (USD/oz)',      decimals: 2 },
    silver: { pair: 'XAG/USD',       label: 'Silver Spot (USD/oz)',    decimals: 3 },
    crude:  { pair: 'WTI / USOIL',   label: 'WTI Crude Oil (USD/bbl)', decimals: 2 },
    natgas: { pair: 'NATGAS / XNG',  label: 'Natural Gas (USD/MMBtu)', decimals: 3 },
    copper: { pair: 'COPPER',        label: 'High-Grade Copper',       decimals: 3 },
    zinc:   { pair: 'ZINC',          label: 'LME Zinc',                decimals: 2 },
    alum:   { pair: 'ALUMINIUM',     label: 'LME Aluminium',           decimals: 2 },
    cotton: { pair: 'COTTON',        label: 'ICE Cotton #2',           decimals: 2 }
  };

  /**
   * Builds a Global USD / Olymp Trade signal & sizing plan from an active signal.
   */
  function buildUsdTradePlan({ commodityId, sig, usdBalance = 100, payoutPct = 82, isBlackout = false, isCircuitTripped = false, nowMs = Date.now() }) {
    const meta = USD_INSTRUMENTS[commodityId] || { pair: String(commodityId || 'XAU/USD').toUpperCase(), label: 'Global Commodity', decimals: 2 };
    const dec = meta.decimals;

    if (!sig || !sig.price || !sig.intlPrice || sig.intlPrice <= 0) {
      return {
        ok: false,
        pair: meta.pair,
        label: meta.label,
        reason: 'Live international USD feed unavailable for this asset.'
      };
    }

    // Scale INR Entry/SL/T1/T2 into USD using exact live parity ratio
    const scale = sig.intlPrice / sig.price;
    const entryUsd = sig.intlPrice;
    const slUsd = (sig.sl || sig.price * 0.995) * scale;
    const t1Usd = (sig.t1 || sig.price * 1.01) * scale;
    const t2Usd = (sig.t2 || sig.price * 1.015) * scale;
    const riskDistUsd = Math.abs(entryUsd - slUsd);
    const rrNum = sig.rr ? Number(sig.rr) : (riskDistUsd > 0 ? Math.abs(t1Usd - entryUsd) / riskDistUsd : 2.0);
    const rr = rrNum.toFixed(2);

    const conf = Number(sig.confidence || 0);
    const action = (isBlackout || isCircuitTripped) ? 'WAIT' : (sig.action || 'WAIT');
    const regime = String(sig.regime || '').toUpperCase();

    // Best Olymp Trade Mode Selector
    let recommendedMode = 'WAIT — DO NOT ENTER';
    if (action === 'BUY' || action === 'SELL') {
      if (regime === 'TRENDING' && conf >= 72) {
        recommendedMode = 'FOREX / MULTIPLIER MODE';
      } else if ((regime === 'RANGING' || regime === 'TRANSITIONAL') && conf >= 68) {
        recommendedMode = 'FIXED-TIME (FTT) 15m–30m';
      } else if (conf >= 72) {
        recommendedMode = 'FOREX / MULTIPLIER MODE';
      } else if (conf >= 68) {
        recommendedMode = 'FIXED-TIME (FTT) 15m–30m';
      }
    }

    let fttExpiry = 'NO TRADE — WAIT';
    let fttDirection = 'HOLD';
    if (action === 'BUY' || action === 'SELL') {
      fttDirection = action === 'BUY' ? 'UP (CALL ▲)' : 'DOWN (PUT ▼)';
      if (conf >= 75) {
        fttExpiry = '15m – 30m (High-Conviction Trend)';
      } else if (conf >= 65) {
        fttExpiry = '30m – 45m (Standard Swing)';
      } else {
        fttExpiry = 'WAIT (< 65% Confidence — Skip FTT)';
        fttDirection = 'HOLD';
      }
    }

    const bal = Math.max(10, Number(usdBalance) || 100);
    const stake1Pct = +(bal * 0.01).toFixed(2);
    const stake2Pct = +(bal * 0.02).toFixed(2);
    const breakEvenWinRate = +((100 / (100 + Number(payoutPct || 82))) * 100).toFixed(1);

    // Safe Olymp Trade Forex/CFD Multiplier Calculation
    const stopFrac = (entryUsd > 0 && riskDistUsd > 0) ? (riskDistUsd / entryUsd) : 0.015;
    const tpFrac = (entryUsd > 0 && Math.abs(t1Usd - entryUsd) > 0) ? (Math.abs(t1Usd - entryUsd) / entryUsd) : (stopFrac * 2);
    const maxSafeMult = 0.50 / Math.max(0.001, stopFrac);
    let multiplier = 20;
    if (maxSafeMult >= 45) multiplier = 50;
    else if (maxSafeMult >= 28) multiplier = 30;

    const autoCloseSlPct = Math.min(50, Math.max(25, Math.round(multiplier * stopFrac * 100)));
    const rawTpPct = Math.round(multiplier * tpFrac * 100);
    const autoCloseTpPct = Math.min(150, Math.max(85, rawTpPct));

    // Candle Entry Countdown to next 5m boundary
    const nowSec = Math.floor((Number(nowMs) || Date.now()) / 1000);
    const next5mCandleSecs = 300 - (nowSec % 300);
    const remM = Math.floor(next5mCandleSecs / 60);
    const remS = String(next5mCandleSecs % 60).padStart(2, '0');
    const instruction = (action === 'BUY' || action === 'SELL')
      ? `Enter ${action} on next 5m candle open (${remM}m ${remS}s) or pullback near $${entryUsd.toFixed(dec)}`
      : `Wait for alignment before next 5m candle (${remM}m ${remS}s)`;

    return {
      ok: true,
      pair: meta.pair,
      label: meta.label,
      action,
      confidence: conf,
      recommendedMode,
      forexMode: {
        entry: +entryUsd.toFixed(dec),
        sl: +slUsd.toFixed(dec),
        t1: +t1Usd.toFixed(dec),
        t2: +t2Usd.toFixed(dec),
        slDistance: +riskDistUsd.toFixed(dec),
        rr
      },
      olympMultiplier: {
        multiplier,
        stakeUsd: stake2Pct,
        autoCloseSlPct,
        autoCloseTpPct,
        stopDistancePct: +(stopFrac * 100).toFixed(2),
        summary: `$${stake2Pct} × ${multiplier}x · Auto-SL -${autoCloseSlPct}% · Auto-TP +${autoCloseTpPct}%`
      },
      fttMode: {
        direction: fttDirection,
        recommendedExpiry: fttExpiry,
        payoutPct: Number(payoutPct || 82),
        breakEvenWinRate
      },
      entryTiming: {
        next5mCandleSecs,
        countdownFormatted: `${remM}m ${remS}s`,
        instruction
      },
      sizing: {
        usdBalance: bal,
        stake1Pct,
        stake2Pct,
        maxDailyLossUsd: +(bal * 0.04).toFixed(2)
      },
      blockedReason: isBlackout ? 'Blocked by Macro Volatility Blackout' : (isCircuitTripped ? 'Blocked by Daily Circuit Breaker' : null)
    };
  }

  return {
    USD_INSTRUMENTS,
    buildUsdTradePlan
  };

}));
