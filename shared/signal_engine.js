/**
 * shared/signal_engine.js — Canonical Regime-Conditional & Fee-Aware MCX Signal Engine
 *
 * Centralizes technical math, candlestick pattern recognition (with real OHLC opens),
 * Wilder-smoothed ADX regime detection, OBV 10-EMA flow, session-anchored VWAP,
 * and the pre-trade Fee-to-Target Hurdle Gate.
 *
 * UMD module: exports to Node.js (`module.exports`) and browsers (`window.SignalEngine`).
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.SignalEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function emaSeries(arr, n) {
    if (!arr || !arr.length) return [];
    const k = 2 / (n + 1);
    const out = [arr[0]];
    for (let i = 1; i < arr.length; i++) {
      out.push(arr[i] * k + out[i - 1] * (1 - k));
    }
    return out;
  }

  /**
   * Wilder-smoothed ADX(n) with trend/chop classification.
   */
  function calcADX(cls, his, los, n = 14) {
    const l = Math.min(cls ? cls.length : 0, his ? his.length : 0, los ? los.length : 0);
    if (l < 4) {
      return { adx: 0, plus: 0, minus: 0, isTrending: false, isChop: true };
    }

    const trArr = [];
    const plusDM = [];
    const minusDM = [];

    for (let i = 1; i < l; i++) {
      const h = his[i];
      const lo = los[i];
      const prevC = cls[i - 1];
      trArr.push(Math.max(h - lo, Math.abs(h - prevC), Math.abs(lo - prevC)));

      const upMove = h - his[i - 1];
      const downMove = los[i - 1] - lo;
      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    const period = Math.min(n, trArr.length);
    if (period <= 0) {
      return { adx: 0, plus: 0, minus: 0, isTrending: false, isChop: true };
    }

    let smTR = 0;
    let smP = 0;
    let smM = 0;
    for (let i = 0; i < period; i++) {
      smTR += trArr[i];
      smP += plusDM[i];
      smM += minusDM[i];
    }

    const dxList = [];
    let lastPDI = 0;
    let lastMDI = 0;

    const pushDX = () => {
      lastPDI = smTR > 0 ? (smP / smTR) * 100 : 0;
      lastMDI = smTR > 0 ? (smM / smTR) * 100 : 0;
      const sumDI = lastPDI + lastMDI;
      dxList.push(sumDI > 0 ? (Math.abs(lastPDI - lastMDI) / sumDI) * 100 : 0);
    };

    pushDX();

    for (let i = period; i < trArr.length; i++) {
      smTR = smTR - (smTR / period) + trArr[i];
      smP = smP - (smP / period) + plusDM[i];
      smM = smM - (smM / period) + minusDM[i];
      pushDX();
    }

    // Wilder smoothing over DX series
    let adxVal = 0;
    if (dxList.length <= period) {
      adxVal = dxList.reduce((a, b) => a + b, 0) / dxList.length;
    } else {
      adxVal = dxList.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < dxList.length; i++) {
        adxVal = ((adxVal * (period - 1)) + dxList[i]) / period;
      }
    }

    const adx = clamp(Math.round(adxVal * 10) / 10, 0, 100);
    const plus = clamp(Math.round(lastPDI * 10) / 10, 0, 100);
    const minus = clamp(Math.round(lastMDI * 10) / 10, 0, 100);

    return {
      adx,
      plus,
      minus,
      isTrending: adx >= 22,
      isChop: adx < 20
    };
  }

  /**
   * OBV evaluated against its own 10-bar EMA instead of arbitrary cumulative sign.
   */
  function calcOBV(cls, vls) {
    const l = Math.min(cls ? cls.length : 0, vls ? vls.length : 0);
    if (l < 2) {
      return { value: 0, ema10: 0, trend: 'NEUTRAL' };
    }

    const series = [0];
    let obv = 0;
    for (let i = 1; i < l; i++) {
      const vol = Number(vls[i]) || 0;
      if (cls[i] > cls[i - 1]) obv += vol;
      else if (cls[i] < cls[i - 1]) obv -= vol;
      series.push(obv);
    }

    const emaArr = emaSeries(series, 10);
    const obvNow = series[series.length - 1];
    const obvEma10 = emaArr[emaArr.length - 1];

    let trend = 'NEUTRAL';
    if (obvNow > obvEma10) trend = 'BUY';
    else if (obvNow < obvEma10) trend = 'SELL';

    return {
      value: obvNow,
      ema10: Math.round(obvEma10 * 100) / 100,
      trend
    };
  }

  /**
   * Session-anchored VWAP using typical price (H+L+C)/3 over the latest sessionBars.
   */
  function calcSessionVWAP(cls, his, los, vls, sessionBars = 30) {
    const l = cls ? cls.length : 0;
    if (l === 0) return 0;

    const start = Math.max(0, l - sessionBars);
    let tv = 0;
    let tpv = 0;
    let eqSum = 0;
    let eqCount = 0;

    for (let i = start; i < l; i++) {
      const c = cls[i];
      const h = (his && his[i] != null) ? his[i] : c;
      const lo = (los && los[i] != null) ? los[i] : c;
      const tp = (h + lo + c) / 3;
      const vol = (vls && vls[i] != null && vls[i] > 0) ? vls[i] : 0;

      if (vol > 0) {
        tv += vol;
        tpv += tp * vol;
      }
      eqSum += tp;
      eqCount++;
    }

    if (tv > 0) return tpv / tv;
    return eqCount > 0 ? eqSum / eqCount : (cls[l - 1] || 0);
  }

  /**
   * Candlestick Pattern Recognition using true OHLC opens (when provided).
   */
  function detectPatterns(cls, his, los, ops) {
    const pats = [];
    const n = cls ? cls.length : 0;
    if (n < 3) return pats;

    const L = n - 1, P = n - 2, P2 = n - 3;
    const op = cls.map((p, i) => (Array.isArray(ops) && ops[i] != null && isFinite(ops[i]))
      ? ops[i]
      : (i > 0 ? cls[i - 1] : p));

    const bL = Math.abs(cls[L] - op[L]);
    const rL = (his[L] || cls[L]) - (los[L] || cls[L]);
    const bull = cls[L] > op[L];
    const bear = cls[L] < op[L];
    const bP = Math.abs(cls[P] - op[P]);

    if (rL > 0 && bL / rL < 0.1) {
      pats.push({ name: 'Doji', icon: '〤', sig: 'WAIT', desc: 'Market indecision — neither bulls nor bears winning' });
    }

    const lowerWick = Math.min(cls[L], op[L]) - los[L];
    const upperWick = his[L] - Math.max(cls[L], op[L]);

    if (bL > 0 && lowerWick >= 2 * bL && upperWick <= bL) {
      pats.push({ name: 'Hammer', icon: '🔨', sig: 'BUY', desc: 'Buyers stepped in strongly at lows' });
    }
    if (bL > 0 && upperWick >= 2 * bL && lowerWick <= bL) {
      pats.push({ name: 'Shooting Star', icon: '⭐', sig: 'SELL', desc: 'Sellers rejected the high — bearish reversal' });
    }

    // Real-open engulfing logic (fixes op[L]===cls[P] bug)
    if (bull && cls[P] < op[P] && op[L] <= cls[P] && cls[L] >= op[P] && bL > bP) {
      pats.push({ name: 'Bullish Engulfing', icon: '🟢', sig: 'BUY', desc: 'Bulls completely engulfed prior red body — strong reversal' });
    }
    if (bear && cls[P] > op[P] && op[L] >= cls[P] && cls[L] <= op[P] && bL > bP) {
      pats.push({ name: 'Bearish Engulfing', icon: '🔴', sig: 'SELL', desc: 'Bears completely engulfed prior green body — strong reversal' });
    }

    if (n >= 3 && cls[P2] < op[P2] && bP < bL * 0.4 && cls[L] > op[L] && cls[L] > cls[P2]) {
      pats.push({ name: 'Morning Star', icon: '🌅', sig: 'BUY', desc: '3-candle bullish reversal pattern' });
    }
    if (n >= 3 && cls[P2] > op[P2] && bP < bL * 0.4 && cls[L] < op[L] && cls[L] < cls[P2]) {
      pats.push({ name: 'Evening Star', icon: '🌆', sig: 'SELL', desc: '3-candle bearish reversal pattern' });
    }

    if (rL > 0 && bL / rL > 0.9) {
      pats.push({
        name: bull ? 'Bull Marubozu' : 'Bear Marubozu',
        icon: bull ? '📗' : '📕',
        sig: bull ? 'BUY' : 'SELL',
        desc: bull ? 'Full bull control — no selling pressure' : 'Full bear control — no buying pressure'
      });
    }

    if (n >= 3 && cls[L] > op[L] && cls[P] > op[P] && cls[P2] > op[P2] && cls[L] > cls[P] && cls[P] > cls[P2]) {
      pats.push({ name: '3 White Soldiers', icon: '🪖', sig: 'BUY', desc: 'Strong consecutive bullish candles' });
    }
    if (n >= 3 && cls[L] < op[L] && cls[P] < op[P] && cls[P2] < op[P2] && cls[L] < cls[P] && cls[P] < cls[P2]) {
      pats.push({ name: '3 Black Crows', icon: '🐦', sig: 'SELL', desc: 'Strong consecutive bearish candles' });
    }

    return pats.slice(0, 6);
  }

  /**
   * Resamples LTF candles into Higher-Timeframe (HTF) bars and determines structural bias.
   */
  function computeHTFTrend(cls, his, los, groupSize = 4) {
    const n = cls ? cls.length : 0;
    const step = Math.max(1, Number(groupSize) || 1);
    const htfCloses = [];
    for (let i = 0; i + step <= n; i += step) {
      const sliceC = cls.slice(i, i + step);
      htfCloses.push(sliceC[sliceC.length - 1]);
    }
    if (htfCloses.length < 3) {
      return { bias: 'NEUTRAL', e9: 0, e21: 0, barCount: htfCloses.length };
    }
    const e9Arr = emaSeries(htfCloses, 9);
    const e21Arr = emaSeries(htfCloses, 21);
    const last = htfCloses[htfCloses.length - 1];
    const e9 = e9Arr[e9Arr.length - 1];
    const e21 = e21Arr[e21Arr.length - 1];
    let bias = 'NEUTRAL';
    if (last > e21 && e9 >= e21) bias = 'BULLISH';
    else if (last < e21 && e9 <= e21) bias = 'BEARISH';
    return {
      bias,
      e9: Math.round(e9 * 100) / 100,
      e21: Math.round(e21 * 100) / 100,
      barCount: htfCloses.length
    };
  }

  /**
   * Blocks fresh entries during the volatile first 15m Opening Range formation (IST).
   */
  function checkOpeningRangeGuard(timestamps, segment = 'commodity') {
    if (!Array.isArray(timestamps) || timestamps.length === 0) {
      return { isOpeningNoise: false, reason: null };
    }
    const rawTs = Number(timestamps[timestamps.length - 1]);
    if (!isFinite(rawTs) || rawTs <= 0) {
      return { isOpeningNoise: false, reason: null };
    }
    const ms = rawTs < 1e12 ? rawTs * 1000 : rawTs;
    const ist = new Date(ms + 5.5 * 3600 * 1000);
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const isOpeningNoise = segment === 'equity'
      ? (mins >= 9 * 60 + 15 && mins < 9 * 60 + 30)
      : (mins >= 9 * 60 && mins < 9 * 60 + 15);
    return {
      isOpeningNoise,
      reason: isOpeningNoise ? 'Waiting for 15m Opening Range formation' : null
    };
  }

  /**
   * Computes structural Stop Loss anchored near swing/OB invalidation + overextension check.
   */
  function computeStructuralLevels({
    action = 'WAIT',
    price = 0,
    atr = 0,
    e21 = 0,
    vwap = 0,
    smc = null,
    slAtrMult = 1.5,
    t1AtrMult = 2.5,
    t2AtrMult = 4.0
  }) {
    const distFromE21 = (e21 > 0 && atr > 0) ? Math.abs(price - e21) / atr : 0;
    const isOverextended = (action === 'BUY' && price > e21 && distFromE21 > 1.8) ||
                           (action === 'SELL' && price < e21 && distFromE21 > 1.8);

    const rawSlDist = atr * slAtrMult;
    let slDist = rawSlDist;

    if (atr > 0 && smc && smc.structure) {
      if (action === 'BUY' && smc.structure.swingLow > 0 && smc.structure.swingLow < price) {
        const swingDist = (price - smc.structure.swingLow) + 0.2 * atr;
        slDist = clamp(swingDist, 0.8 * rawSlDist, 1.5 * rawSlDist);
      } else if (action === 'SELL' && smc.structure.swingHigh > price) {
        const swingDist = (smc.structure.swingHigh - price) + 0.2 * atr;
        slDist = clamp(swingDist, 0.8 * rawSlDist, 1.5 * rawSlDist);
      }
    }

    const ratioScale = rawSlDist > 0 ? (slDist / rawSlDist) : 1;
    const t1Dist = atr * t1AtrMult * Math.max(1, ratioScale);
    const t2Dist = atr * t2AtrMult * Math.max(1, ratioScale);

    const isSell = action === 'SELL';
    const sl = isSell ? price + slDist : price - slDist;
    const t1 = isSell ? price - t1Dist : price + t1Dist;
    const t2 = isSell ? price - t2Dist : price + t2Dist;
    const breakevenTrigger = isSell ? price - slDist : price + slDist;

    return {
      entry: price,
      sl,
      t1,
      t2,
      slDist,
      isOverextended,
      distFromE21: Math.round(distFromE21 * 100) / 100,
      breakevenTrigger
    };
  }

  /**
   * Evaluates Regime-Conditional Technical Score + HTF / Opening / Fee Hurdle Gates.
   */
  function evaluateRegimeAndFeeGate({
    sigs = {},
    adxObj = { adx: 20, isTrending: false, isChop: false },
    smc = null,
    newsScore = 50,
    volConfirmed = true,
    entry = 0,
    sl = 0,
    t1 = 0,
    lotMultiplier = 1,
    roundTripFee = 45,
    minGrossTargetMultiple = 3.5,
    minNetRR = 1.35,
    threshold = 65,
    htfTrend = null,
    openingRangeGuard = null,
    isOverextended = false
  }) {
    const val = (k) => (sigs[k] === 'BUY' ? 1 : sigs[k] === 'SELL' ? -1 : 0);

    const trendSpecs = [
      ['ema_cross', 3.0],
      ['ema200', 2.5],
      ['ema50', 2.0],
      ['adx', 2.0],
      ['ich', 2.0],
      ['macd_hist', 1.5],
      ['vwap', 1.5],
      ['struct', 1.5],
      ['obv', 1.0],
      ['ema21', 1.0],
      ['ema9', 0.5]
    ];
    const oscSpecs = [
      ['rsi', 1.2],
      ['stoch', 1.0],
      ['bb', 1.0],
      ['mfi', 0.8],
      ['cci', 0.6],
      ['willr', 0.6]
    ];

    let trendRaw = 0, trendMax = 0;
    for (const [k, w] of trendSpecs) {
      trendRaw += val(k) * w;
      trendMax += w;
    }
    const trendScore = clamp(50 + (trendRaw / (trendMax || 1)) * 50, 5, 95);
    const trendBias = trendRaw > 0.5 ? 'BUY' : (trendRaw < -0.5 ? 'SELL' : 'NEUTRAL');

    const adxVal = Number(adxObj?.adx ?? 20);
    const isTrending = Boolean(adxObj?.isTrending || adxVal >= 22 || smc?.structure?.bos);
    const isChop = !isTrending && (Boolean(adxObj?.isChop) || adxVal < 20);
    const regime = isTrending ? 'TRENDING' : (isChop ? 'RANGING' : 'TRANSITIONAL');

    let oscRaw = 0, oscMax = 0;
    for (const [k, w] of oscSpecs) {
      let v = val(k);
      // In a trending regime, oscillators only confirm pullbacks; do NOT penalize overbought/oversold against the trend
      if (isTrending) {
        if (trendBias === 'BUY' && v < 0) v = 0;
        if (trendBias === 'SELL' && v > 0) v = 0;
      }
      oscRaw += v * w;
      oscMax += w;
    }
    const oscScore = clamp(50 + (oscRaw / (oscMax || 1)) * 50, 5, 95);
    const smcScore = (smc && smc.ok && typeof smc.confluenceScore === 'number') ? smc.confluenceScore : 50;

    let techScore;
    if (isTrending) {
      // 75% trend structure, 10% aligned oscillator confirmation, 15% SMC confluence
      techScore = clamp(Math.round(trendScore * 0.75 + oscScore * 0.10 + smcScore * 0.15), 5, 95);
    } else if (isChop) {
      // Ranging market: 70% mean-reversion oscillators, 15% trend boundary, 15% SMC (sweeps/FVG)
      techScore = clamp(Math.round(oscScore * 0.70 + trendScore * 0.15 + smcScore * 0.15), 5, 95);
    } else {
      techScore = clamp(Math.round(trendScore * 0.55 + oscScore * 0.30 + smcScore * 0.15), 5, 95);
    }

    const isNewsStrong = (newsScore >= 70 || newsScore <= 30);
    const newsWeight = isNewsStrong ? 0.45 : 0.20;
    const techWeight = 1 - newsWeight;
    const combined = clamp(Math.round(techScore * techWeight + newsScore * newsWeight), 5, 95);

    const lowThreshold = 100 - threshold;
    let action = 'WAIT';
    if (combined >= threshold) action = 'BUY';
    else if (combined <= lowThreshold) action = 'SELL';

    // Fundamental News Veto
    if (action === 'BUY' && newsScore < 40) action = 'WAIT';
    if (action === 'SELL' && newsScore > 60) action = 'WAIT';

    // Volume Confirmation Gate
    if (!volConfirmed) {
      if (action === 'BUY' && combined < Math.max(75, threshold)) action = 'WAIT';
      if (action === 'SELL' && combined > Math.min(25, lowThreshold)) action = 'WAIT';
    }

    // SMC Liquidity Sweep Guard
    if (smc && Array.isArray(smc.sweeps) && smc.sweeps.length > 0) {
      const latestSweep = smc.sweeps[smc.sweeps.length - 1];
      if (action === 'BUY' && latestSweep.type === 'BUY_SIDE_SWEEP') action = 'WAIT';
      if (action === 'SELL' && latestSweep.type === 'SELL_SIDE_SWEEP') action = 'WAIT';
    }

    // Opening Range, Overextension Chasing & 1H HTF Alignment Gates
    let vetoReason = null;
    if (action !== 'WAIT' && openingRangeGuard && openingRangeGuard.isOpeningNoise) {
      action = 'WAIT';
      vetoReason = openingRangeGuard.reason;
    }
    if (action !== 'WAIT' && isOverextended) {
      action = 'WAIT';
      vetoReason = 'Price overextended (>1.8 ATR from EMA21) — wait for pullback';
    }
    if (action !== 'WAIT' && htfTrend && htfTrend.bias && htfTrend.bias !== 'NEUTRAL') {
      if (action === 'BUY' && htfTrend.bias === 'BEARISH' && combined < 78) {
        action = 'WAIT';
        vetoReason = 'Opposes 1H Bearish HTF trend';
      } else if (action === 'SELL' && htfTrend.bias === 'BULLISH' && combined > 22) {
        action = 'WAIT';
        vetoReason = 'Opposes 1H Bullish HTF trend';
      }
    }

    // Fee-to-Target Hurdle Gate
    let grossTarget1 = 0;
    let netRR = 0;
    let feeVeto = false;
    let feeVetoReason = null;

    if (entry > 0 && sl > 0 && t1 > 0 && lotMultiplier > 0) {
      grossTarget1 = Math.abs(t1 - entry) * lotMultiplier;
      const grossRisk = Math.abs(entry - sl) * lotMultiplier;
      const netReward = grossTarget1 - roundTripFee;
      const netRisk = grossRisk + roundTripFee;
      netRR = netRisk > 0 ? netReward / netRisk : 0;

      const minTargetRupees = roundTripFee * minGrossTargetMultiple;
      if (grossTarget1 < minTargetRupees) {
        feeVeto = true;
        feeVetoReason = `Gross Target (₹${grossTarget1.toFixed(0)}) below fee hurdle (₹${minTargetRupees.toFixed(0)} = ${minGrossTargetMultiple}x ₹${roundTripFee} fees)`;
      } else if (netRR < minNetRR) {
        feeVeto = true;
        feeVetoReason = `Net R:R after fees (${netRR.toFixed(2)}) below ${minNetRR} minimum`;
      }

      if (feeVeto) {
        action = 'WAIT';
        vetoReason = vetoReason || feeVetoReason;
      }
    }

    return {
      regime,
      techScore,
      combined,
      action,
      feeVeto,
      feeVetoReason,
      vetoReason,
      netRR: Math.round(netRR * 100) / 100,
      grossTarget1: Math.round(grossTarget1 * 100) / 100
    };
  }

  return {
    calcADX,
    calcOBV,
    calcSessionVWAP,
    detectPatterns,
    computeHTFTrend,
    checkOpeningRangeGuard,
    computeStructuralLevels,
    evaluateRegimeAndFeeGate
  };

}));
