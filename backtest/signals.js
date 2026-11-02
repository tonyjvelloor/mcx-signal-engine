/**
 * backtest/signals.js — Pure Strategy Evaluators (Zero Lookahead)
 * 
 * Takes candles up to bar t (strictly <= t) and outputs:
 *   { action: 'BUY' | 'SELL' | null, entry, sl, target, atr }
 */

const ind = require('../shared/indicators');

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
      target: currentClose + (slDist * 2.0),
      atr
    };
  }

  // Bearish Crossover
  if (prevEma9 >= prevEma21 && ema9 < ema21) {
    return {
      action: 'SELL',
      entry: currentClose,
      sl: currentClose + slDist,
      target: currentClose - (slDist * 2.0),
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
      target: currentClose + (slDist * 2.0),
      atr
    };
  }

  // Trend Down + Relief Rally Failure
  if (ema20 < ema50 && currentClose < ema20 && rsi >= 35 && rsi <= 55) {
    return {
      action: 'SELL',
      entry: currentClose,
      sl: currentClose + slDist,
      target: currentClose - (slDist * 2.0),
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

module.exports = {
  evaluateBaselineStrategy,
  evaluateBeginnerStrategy,
  evaluateProStrategy
};
