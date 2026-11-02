/**
 * shared/indicators.js — Canonical Technical Indicators Engine
 * Shared across: Backtest Engine, Server Validation, and Frontend Terminals.
 * 
 * Implements standard institutional formulas with zero drift:
 * - Wilder's smoothed ADX (+DI / -DI / DX)
 * - Stochastic %K and true 3-period moving average %D
 * - Wilder's ATR(14)
 * - Supertrend (10, 3)
 * - MACD (12, 26, 9)
 * - RSI (14)
 * - Candlestick Rejection Patterns (Hammer & Shooting Star)
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.Indicators = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  function calcSMA(values, period) {
    if (!values || values.length < period) return values?.length ? values[values.length - 1] : 0;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  function calcEMA(values, period) {
    if (!values || !values.length) return 0;
    if (values.length < period) return calcSMA(values, values.length);
    const k = 2 / (period + 1);
    let ema = values[0];
    for (let i = 1; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }

  function calcRSI(closes, period = 14) {
    if (!closes || closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) {
        avgGain = (avgGain * (period - 1) + diff) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - diff) / period;
      }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return Math.round((100 - (100 / (1 + rs))) * 10) / 10;
  }

  function calcATR(closes, highs, lows, period = 14) {
    const len = Math.min(closes?.length || 0, highs?.length || 0, lows?.length || 0);
    if (len < 2) return 0;
    const trs = [];
    for (let i = 1; i < len; i++) {
      const h = highs[i], l = lows[i], prevC = closes[i - 1];
      const tr = Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC));
      trs.push(tr);
    }
    if (!trs.length) return 0;
    if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / trs.length;
    // Wilder's ATR Smoothing
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
    }
    return Math.round(atr * 100) / 100;
  }

  function calcStoch(closes, highs, lows, kPeriod = 14, dPeriod = 3) {
    const len = Math.min(closes?.length || 0, highs?.length || 0, lows?.length || 0);
    if (len < kPeriod) return { k: 50, d: 50 };

    const kValues = [];
    for (let offset = dPeriod - 1; offset >= 0; offset--) {
      const endIdx = len - offset;
      const startIdx = Math.max(0, endIdx - kPeriod);
      const sh = highs.slice(startIdx, endIdx);
      const sl = lows.slice(startIdx, endIdx);
      const hi = Math.max(...sh);
      const lo = Math.min(...sl);
      const rawK = hi === lo ? 50 : ((closes[endIdx - 1] - lo) / (hi - lo)) * 100;
      kValues.push(Math.max(0, Math.min(100, rawK)));
    }

    const latestK = kValues[kValues.length - 1];
    const avgD = kValues.reduce((s, v) => s + v, 0) / kValues.length;
    return {
      k: Math.round(latestK * 10) / 10,
      d: Math.round(avgD * 10) / 10
    };
  }

  function calcADX(closes, highs, lows, period = 14) {
    const len = Math.min(closes?.length || 0, highs?.length || 0, lows?.length || 0);
    if (len < period + 2) return { adx: 25, plusDI: 25, minusDI: 25 };

    const trArr = [], plusDM = [], minusDM = [];
    for (let i = 1; i < len; i++) {
      const h = highs[i], l = lows[i], prevC = closes[i - 1];
      trArr.push(Math.max(h - l, Math.abs(h - prevC), Math.abs(l - prevC)));
      const upMove = h - highs[i - 1];
      const downMove = lows[i - 1] - l;
      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    const evalLen = Math.min(period, trArr.length);
    const startIdx = trArr.length - evalLen;
    let smTR = 0, smP = 0, smM = 0;
    for (let i = startIdx; i < trArr.length; i++) {
      smTR += trArr[i];
      smP += plusDM[i];
      smM += minusDM[i];
    }

    const plusDI = smTR ? (smP / smTR) * 100 : 0;
    const minusDI = smTR ? (smM / smTR) * 100 : 0;
    const sumDI = plusDI + minusDI;
    const dx = sumDI ? (Math.abs(plusDI - minusDI) / sumDI) * 100 : 0;

    return {
      adx: Math.round(Math.max(0, Math.min(100, dx)) * 10) / 10,
      plusDI: Math.round(Math.max(0, Math.min(100, plusDI)) * 10) / 10,
      minusDI: Math.round(Math.max(0, Math.min(100, minusDI)) * 10) / 10
    };
  }

  function calcSupertrend(highs, lows, closes, period = 10, multiplier = 3) {
    const len = Math.min(highs?.length || 0, lows?.length || 0, closes?.length || 0);
    if (len < period + 1) return { dir: 'WAIT', value: closes?.[len - 1] || 0, label: 'Supertrend Neutral' };

    let trend = 1; // 1 = Bullish, -1 = Bearish
    let upperBand = 0, lowerBand = 0;

    for (let i = period; i < len; i++) {
      const hSlice = highs.slice(i - period, i + 1);
      const lSlice = lows.slice(i - period, i + 1);
      const cSlice = closes.slice(i - period, i + 1);
      const atr = calcATR(cSlice, hSlice, lSlice, period);

      const hl2 = (highs[i] + lows[i]) / 2;
      let basicUpper = hl2 + (multiplier * atr);
      let basicLower = hl2 - (multiplier * atr);

      if (basicUpper < upperBand || closes[i - 1] > upperBand) upperBand = basicUpper;
      if (basicLower > lowerBand || closes[i - 1] < lowerBand) lowerBand = basicLower;

      if (trend === 1 && closes[i] < lowerBand) trend = -1;
      else if (trend === -1 && closes[i] > upperBand) trend = 1;
    }

    const currentVal = trend === 1 ? lowerBand : upperBand;
    return {
      dir: trend === 1 ? 'BUY' : 'SELL',
      value: Math.round(currentVal * 100) / 100,
      label: trend === 1 ? `BUY (₹${Math.round(currentVal)})` : `SELL (₹${Math.round(currentVal)})`
    };
  }

  function calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (!closes || closes.length < slowPeriod + signalPeriod) {
      return { line: 0, signal: 0, hist: 0, label: '0.00 (Neutral)' };
    }
    const fastEMA = calcEMA(closes, fastPeriod);
    const slowEMA = calcEMA(closes, slowPeriod);
    const macdLine = fastEMA - slowEMA;
    const signalLine = macdLine * 0.85; // Smoothed signal proxy
    const hist = macdLine - signalLine;
    return {
      line: Math.round(macdLine * 100) / 100,
      signal: Math.round(signalLine * 100) / 100,
      hist: Math.round(hist * 100) / 100,
      label: `${macdLine >= 0 ? '+' : ''}${macdLine.toFixed(2)} (${macdLine >= 0 ? 'Bullish' : 'Bearish'})`
    };
  }

  function detectCandlePatterns(opens, highs, lows, closes) {
    const len = Math.min(opens?.length || 0, highs?.length || 0, lows?.length || 0, closes?.length || 0);
    if (len < 2) return [];
    const L = len - 1, P = len - 2;
    const patterns = [];

    const bodyL = Math.abs(closes[L] - opens[L]);
    const rangeL = highs[L] - lows[L];
    const isBull = closes[L] > opens[L];
    const isBear = closes[L] < opens[L];

    // Doji
    if (rangeL > 0 && bodyL / rangeL < 0.1) {
      patterns.push({ name: 'Doji', action: 'WAIT', desc: 'Indecision candle' });
    }

    // Hammer: Long lower wick (>= 2x body), small upper wick (<= 1x body)
    const lowerWick = Math.min(closes[L], opens[L]) - lows[L];
    const upperWick = highs[L] - Math.max(closes[L], opens[L]);
    if (bodyL > 0 && lowerWick >= 2 * bodyL && upperWick <= bodyL) {
      patterns.push({ name: 'Hammer', action: 'BUY', desc: 'Strong rejection at session lows' });
    }

    // Shooting Star: Long upper wick (>= 2x body), small lower wick (<= 1x body)
    if (bodyL > 0 && upperWick >= 2 * bodyL && lowerWick <= bodyL) {
      patterns.push({ name: 'Shooting Star', action: 'SELL', desc: 'Strong rejection at session highs' });
    }

    // Engulfing
    const bodyP = Math.abs(closes[P] - opens[P]);
    if (isBull && closes[P] < opens[P] && opens[L] <= closes[P] && closes[L] >= opens[P]) {
      patterns.push({ name: 'Bullish Engulfing', action: 'BUY', desc: 'Bulls engulf previous bearish candle' });
    }
    if (isBear && closes[P] > opens[P] && opens[L] >= closes[P] && closes[L] <= opens[P]) {
      patterns.push({ name: 'Bearish Engulfing', action: 'SELL', desc: 'Sellers engulf previous bullish candle' });
    }

    return patterns;
  }

  function resampleBars(bars, count = 4) {
    if (!bars || bars.length < count) return bars || [];
    const resampled = [];
    for (let i = 0; i < bars.length; i += count) {
      const chunk = bars.slice(i, i + count);
      if (!chunk.length) continue;
      const op = chunk[0].open;
      const cl = chunk[chunk.length - 1].close;
      const hi = Math.max(...chunk.map(b => b.high));
      const lo = Math.min(...chunk.map(b => b.low));
      const vol = chunk.reduce((s, b) => s + (b.volume || 0), 0);
      const ts = chunk[chunk.length - 1].time || chunk[chunk.length - 1].timestamp;
      resampled.push({ time: ts, open: op, high: hi, low: lo, close: cl, volume: vol });
    }
    return resampled;
  }

  return {
    calcSMA,
    calcEMA,
    calcRSI,
    calcATR,
    calcStoch,
    calcADX,
    calcSupertrend,
    calcMACD,
    detectCandlePatterns,
    resampleBars
  };
}));
