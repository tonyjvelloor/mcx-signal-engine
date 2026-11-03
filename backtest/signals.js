/**
 * backtest/signals.js — Pure Strategy Evaluators (Zero Lookahead)
 * 
 * Takes candles up to bar t (strictly <= t) and outputs:
 *   { action: 'BUY' | 'SELL' | null, entry, sl, target, atr }
 */

const ind = require('../shared/indicators');

/**
 * 0. Null Baseline: Random-Entry Generator
 * Enters at random intervals with the exact same 1.5x ATR stop & 2.2x ATR target geometry.
 * Used for Monte Carlo permutation tests to verify if an edge is statistically real.
 */
function evaluateRandomStrategy(candles, entryProb = 0.05, prngFn = Math.random) {
  if (!candles || candles.length < 30) return null;

  const slice = candles.length > 30 ? candles.slice(-30) : candles;
  const closes = slice.map(c => c.close);
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);

  const currentClose = closes[closes.length - 1];
  const atr = ind.calcATR(closes, highs, lows, 14) || (currentClose * 0.005);
  const slDist = Math.max(atr * 1.5, currentClose * 0.003);

  // Random coin toss with configurable frequency
  const rand = prngFn ? prngFn() : Math.random();
  if (rand < entryProb) {
    return {
      action: 'BUY',
      entry: currentClose,
      sl: currentClose - slDist,
      target: currentClose + (slDist * 2.2),
      atr
    };
  } else if (rand > (1 - entryProb)) {
    return {
      action: 'SELL',
      entry: currentClose,
      sl: currentClose + slDist,
      target: currentClose - (slDist * 2.2),
      atr
    };
  }

  return null;
}

/**
 * 1. Benchmark Control Strategy: Simple EMA Crossover (9 / 21) with 1.5x ATR Stop
 */
function evaluateBaselineStrategy(candles) {
  if (!candles || candles.length < 30) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const len = closes.length;
  const currentClose = closes[len - 1];

  const ema9 = ind.calcEMA(closes, 9);
  const ema21 = ind.calcEMA(closes, 21);

  const prevCloses = closes.slice(0, -1);
  const prevEma9 = ind.calcEMA(prevCloses, 9);
  const prevEma21 = ind.calcEMA(prevCloses, 21);

  const atr = ind.calcATR(closes, highs, lows, 14) || (currentClose * 0.005);
  const slDist = Math.max(atr * 1.5, currentClose * 0.003);

  // Bullish Crossover
  if (prevEma9 <= prevEma21 && ema9 > ema21) {
    return {
      action: 'BUY',
      entry: currentClose,
      sl: currentClose - slDist,
      target: currentClose + (slDist * 2.2),
      atr
    };
  }

  // Bearish Crossover
  if (prevEma9 >= prevEma21 && ema9 < ema21) {
    return {
      action: 'SELL',
      entry: currentClose,
      sl: currentClose + slDist,
      target: currentClose - (slDist * 2.2),
      atr
    };
  }

  return null;
}

/**
 * 2. Beginner Strategy (Pillar 1 Trend + Pillar 3 Momentum)
 * Evaluates EMA(20)/EMA(50) alignment, RSI pullbacks, and ATR volatility
 */
function evaluateBeginnerStrategy(candles) {
  if (!candles || candles.length < 55) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const len = closes.length;
  const currentClose = closes[len - 1];

  const ema20 = ind.calcEMA(closes, 20);
  const ema50 = ind.calcEMA(closes, 50);
  const rsi = ind.calcRSI(closes, 14);
  const atr = ind.calcATR(closes, highs, lows, 14) || (currentClose * 0.005);

  const slDist = Math.max(atr * 1.5, currentClose * 0.003);

  // Trend Up + Healthy Pullback
  if (ema20 > ema50 && currentClose > ema20 && rsi >= 45 && rsi <= 65) {
    return {
      action: 'BUY',
      entry: currentClose,
      sl: currentClose - slDist,
      target: currentClose + (slDist * 2.2),
      atr
    };
  }

  // Trend Down + Relief Rally Failure
  if (ema20 < ema50 && currentClose < ema20 && rsi >= 35 && rsi <= 55) {
    return {
      action: 'SELL',
      entry: currentClose,
      sl: currentClose + slDist,
      target: currentClose - (slDist * 2.2),
      atr
    };
  }

  return null;
}

/**
 * 3. Pro Multi-Factor Strategy
 * Evaluates Supertrend, 3-Period Stochastic, Wilder's ADX > 20, and Candlestick Rejections
 */
function evaluateProStrategy(candles) {
  if (!candles || candles.length < 40) return null;

  const opens = candles.map(c => c.open);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const currentClose = closes[closes.length - 1];

  const st = ind.calcSupertrend(highs, lows, closes, 10, 3);
  const stoch = ind.calcStoch(closes, highs, lows, 14, 3);
  const adxData = ind.calcADX(closes, highs, lows, 14);
  const atr = ind.calcATR(closes, highs, lows, 14) || (currentClose * 0.005);
  const patterns = ind.detectCandlePatterns(opens, highs, lows, closes);

  // ADX filter: requires trending conditions
  if (adxData.adx < 20) return null;

  const hasBullRejection = patterns.some(p => p.action === 'BUY');
  const hasBearRejection = patterns.some(p => p.action === 'SELL');

  const slDist = Math.max(atr * 1.5, currentClose * 0.003);

  // Bullish confluence: Supertrend BUY, Stoch crossing out of oversold (< 40), or Bullish Rejection
  if (st.dir === 'BUY' && (stoch.k < 60 || hasBullRejection) && adxData.plusDI > adxData.minusDI) {
    return {
      action: 'BUY',
      entry: currentClose,
      sl: currentClose - slDist,
      target: currentClose + (slDist * 2.2),
      atr
    };
  }

  // Bearish confluence: Supertrend SELL, Stoch crossing out of overbought (> 60), or Bearish Rejection
  if (st.dir === 'SELL' && (stoch.k > 40 || hasBearRejection) && adxData.minusDI > adxData.plusDI) {
    return {
      action: 'SELL',
      entry: currentClose,
      sl: currentClose + slDist,
      target: currentClose - (slDist * 2.2),
      atr
    };
  }

  return null;
}

/**
 * 4. Hypothesis 1: Multi-Timeframe Macro Trend + Session VWAP Pullback + Candlestick Rejection
 * Pre-registered institutional hypothesis designed to overcome the ~₹9.75 statutory cost hurdle.
 * Parameters fixed by market convention (Zero tuning / No sweeps):
 * - 1H 50-EMA Trend Filter & Slope
 * - Intraday Session VWAP with 09:15 daily reset
 * - Pullback within 0.20x ATR of Session VWAP
 * - Rejection: Hammer / Bullish Engulfing for Long; Shooting Star / Bearish Engulfing for Short
 * - Geometry: 1.5x ATR Stop Loss, 1:3.0 Target Multiple (Net R:R >= 2.2)
 */
function evaluateHypothesis1(candles) {
  // Requires at least 50 hourly bars (600 5m bars) for 1H EMA(50) warmup
  if (!candles || candles.length < 600) return null;

  // Slice to last 750 bars to bound runtime while preserving >60 1H bars and complete intraday session VWAP
  const windowCandles = candles.length > 750 ? candles.slice(-750) : candles;

  const closes = windowCandles.map(c => c.close);
  const highs = windowCandles.map(c => c.high);
  const lows = windowCandles.map(c => c.low);
  const opens = windowCandles.map(c => c.open);
  const currentClose = closes[closes.length - 1];

  // 1. Resample to 1-Hour Bars for Higher-Timeframe Macro Trend Filter
  const hourlyBars = ind.resampleBars(windowCandles, 12);
  if (hourlyBars.length < 52) return null;

  const hourlyCloses = hourlyBars.map(b => b.close);
  const currentHourlyClose = hourlyCloses[hourlyCloses.length - 1];
  const ema50Current = ind.calcEMA(hourlyCloses, 50);
  const prevHourlyCloses = hourlyCloses.slice(0, -1);
  const ema50Prev = ind.calcEMA(prevHourlyCloses, 50);

  const isBullTrend = currentHourlyClose > ema50Current && ema50Current > ema50Prev;
  const isBearTrend = currentHourlyClose < ema50Current && ema50Current < ema50Prev;

  if (!isBullTrend && !isBearTrend) return null;

  // 2. Session VWAP & Volatility Calculation
  const vwapSeries = ind.calcSessionVWAP(windowCandles);
  const currentVWAP = vwapSeries[vwapSeries.length - 1];
  const atr = ind.calcATR(closes, highs, lows, 14) || (currentClose * 0.005);
  const vwapTolerance = 0.20 * atr;

  // 3. Price Pullback into VWAP Value Zone
  const lastLow = lows[lows.length - 1];
  const lastHigh = highs[highs.length - 1];
  const bullVwapTouch = lastLow <= (currentVWAP + vwapTolerance) && currentClose >= (currentVWAP - vwapTolerance);
  const bearVwapTouch = lastHigh >= (currentVWAP - vwapTolerance) && currentClose <= (currentVWAP + vwapTolerance);

  // 4. Candlestick Price Rejection Confirmation Trigger
  const patterns = ind.detectCandlePatterns(opens, highs, lows, closes);
  const hasBullRejection = patterns.some(p => p.name === 'Hammer' || p.name === 'Bullish Engulfing');
  const hasBearRejection = patterns.some(p => p.name === 'Shooting Star' || p.name === 'Bearish Engulfing');

  // 5. Symmetric Geometry: 1.5x ATR Stop Loss, 1:3.0 Target Multiple
  const slDist = Math.max(atr * 1.5, currentClose * 0.003);

  if (isBullTrend && bullVwapTouch && hasBullRejection) {
    return {
      action: 'BUY',
      entry: currentClose,
      sl: currentClose - slDist,
      target: currentClose + (slDist * 3.0),
      atr
    };
  }

  if (isBearTrend && bearVwapTouch && hasBearRejection) {
    return {
      action: 'SELL',
      entry: currentClose,
      sl: currentClose + slDist,
      target: currentClose - (slDist * 3.0),
      atr
    };
  }

  return null;
}

/**
 * Matched Null Baseline Generator for Hypothesis 1
 * Mirrors H1's exact 1.5x ATR stop loss & 1:3.0 target multiple geometry
 */
function evaluateHypothesis1Baseline(candles, entryProb = 0.03, prngFn = Math.random) {
  if (!candles || candles.length < 30) return null;

  const slice = candles.length > 30 ? candles.slice(-30) : candles;
  const closes = slice.map(c => c.close);
  const highs = slice.map(c => c.high);
  const lows = slice.map(c => c.low);

  const currentClose = closes[closes.length - 1];
  const atr = ind.calcATR(closes, highs, lows, 14) || (currentClose * 0.005);
  const slDist = Math.max(atr * 1.5, currentClose * 0.003);

  const rand = prngFn ? prngFn() : Math.random();
  if (rand < entryProb) {
    return {
      action: 'BUY',
      entry: currentClose,
      sl: currentClose - slDist,
      target: currentClose + (slDist * 3.0),
      atr
    };
  } else if (rand > (1 - entryProb)) {
    return {
      action: 'SELL',
      entry: currentClose,
      sl: currentClose + slDist,
      target: currentClose - (slDist * 3.0),
      atr
    };
  }

  return null;
}

module.exports = {
  evaluateRandomStrategy,
  evaluateBaselineStrategy,
  evaluateBeginnerStrategy,
  evaluateProStrategy,
  evaluateHypothesis1,
  evaluateHypothesis1Baseline
};
