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
  function buildUsdTradePlan({ commodityId, sig, usdBalance = 100, payoutPct = 82, isBlackout = false, isCircuitTripped = false }) {
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
    const rr = sig.rr ? Number(sig.rr).toFixed(2) : (riskDistUsd > 0 ? (Math.abs(t1Usd - entryUsd) / riskDistUsd).toFixed(2) : '2.00');

    const conf = Number(sig.confidence || 0);
    const action = (isBlackout || isCircuitTripped) ? 'WAIT' : (sig.action || 'WAIT');

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

    return {
      ok: true,
      pair: meta.pair,
      label: meta.label,
      action,
      confidence: conf,
      forexMode: {
        entry: +entryUsd.toFixed(dec),
        sl: +slUsd.toFixed(dec),
        t1: +t1Usd.toFixed(dec),
        t2: +t2Usd.toFixed(dec),
        slDistance: +riskDistUsd.toFixed(dec),
        rr
      },
      fttMode: {
        direction: fttDirection,
        recommendedExpiry: fttExpiry,
        payoutPct: Number(payoutPct || 82),
        breakEvenWinRate
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
