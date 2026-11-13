/**
 * shared/pattern_engine.js — Institutional Smart Money Concepts (SMC) & Price Action Scanner
 *
 * Detects:
 * - Institutional Order Blocks (Bullish / Bearish OB + 50% equilibrium & mitigation status)
 * - Fair Value Gaps (FVG / 3-candle liquidity imbalances, virgin vs mitigated)
 * - Liquidity Sweeps ("Turtle Soup" stop-hunts above swing highs / below swing lows)
 * - Market Structure (Break of Structure BOS & Change of Character CHoCH)
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.PatternEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Normalizes separate arrays (closes, highs, lows, opens, volumes) or candle objects into OHLCV array.
   */
  function normalizeCandles(input) {
    if (Array.isArray(input) && input.length > 0 && typeof input[0] === 'object' && input[0] !== null) {
      return input.map(c => ({
        open: Number(c.open != null ? c.open : c.o),
        high: Number(c.high != null ? c.high : c.h),
        low: Number(c.low != null ? c.low : c.l),
        close: Number(c.close != null ? c.close : c.c),
        volume: Number(c.volume != null ? c.volume : (c.v || 0)),
        time: c.time || c.t || null
      })).filter(c => isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
    }
    return [];
  }

  function buildCandlesFromArrays({ opens, highs, lows, closes, volumes }) {
    if (!Array.isArray(closes) || closes.length === 0) return [];
    const n = closes.length;
    const candles = [];
    for (let i = 0; i < n; i++) {
      const c = Number(closes[i]);
      const o = Array.isArray(opens) && opens[i] != null ? Number(opens[i]) : (i > 0 ? Number(closes[i - 1]) : c);
      const h = Array.isArray(highs) && highs[i] != null ? Number(highs[i]) : Math.max(o, c);
      const l = Array.isArray(lows) && lows[i] != null ? Number(lows[i]) : Math.min(o, c);
      const v = Array.isArray(volumes) && volumes[i] != null ? Number(volumes[i]) : 1;
      candles.push({ open: o, high: h, low: l, close: c, volume: v, index: i });
    }
    return candles;
  }

  function detectFairValueGaps(candles) {
    const fvgs = [];
    const n = candles.length;
    if (n < 3) return fvgs;

    for (let i = 2; i < n; i++) {
      const c0 = candles[i - 2];
      const c2 = candles[i];

      // Bullish FVG: candle[i].low > candle[i-2].high
      if (c2.low > c0.high) {
        const gapSize = c2.low - c0.high;
        const pct = c0.high > 0 ? (gapSize / c0.high) * 100 : 0;
        if (pct >= 0.05) {
          let mitigated = false;
          for (let j = i + 1; j < n; j++) {
            if (candles[j].low <= c2.low && candles[j].low >= c0.high) {
              mitigated = true;
              break;
            }
          }
          fvgs.push({
            type: 'BULLISH_FVG',
            index: i - 1,
            top: Number(c2.low.toFixed(2)),
            bottom: Number(c0.high.toFixed(2)),
            midpoint: Number(((c2.low + c0.high) / 2).toFixed(2)),
            mitigated
          });
        }
      }

      // Bearish FVG: candle[i].high < candle[i-2].low
      if (c2.high < c0.low) {
        const gapSize = c0.low - c2.high;
        const pct = c0.low > 0 ? (gapSize / c0.low) * 100 : 0;
        if (pct >= 0.05) {
          let mitigated = false;
          for (let j = i + 1; j < n; j++) {
            if (candles[j].high >= c2.high && candles[j].high <= c0.low) {
              mitigated = true;
              break;
            }
          }
          fvgs.push({
            type: 'BEARISH_FVG',
            index: i - 1,
            top: Number(c0.low.toFixed(2)),
            bottom: Number(c2.high.toFixed(2)),
            midpoint: Number(((c0.low + c2.high) / 2).toFixed(2)),
            mitigated
          });
        }
      }
    }

    return fvgs.slice(-6);
  }

  function detectOrderBlocks(candles) {
    const orderBlocks = [];
    const n = candles.length;
    if (n < 5) return orderBlocks;

    // Average body size for displacement threshold
    let bodySum = 0;
    for (let i = 0; i < n; i++) {
      bodySum += Math.abs(candles[i].close - candles[i].open);
    }
    const avgBody = bodySum / n || 1;
    const latestClose = candles[n - 1].close;

    for (let i = 1; i < n - 1; i++) {
      const prev = candles[i];
      const disp = candles[i + 1];
      const dispBody = Math.abs(disp.close - disp.open);

      // Bullish Order Block: bearish candle followed by strong bullish displacement > 1.5x avgBody
      if (prev.close < prev.open && disp.close > disp.open && dispBody >= avgBody * 1.4 && disp.close > prev.high) {
        const eq = (prev.high + prev.low) / 2;
        let mitigated = false;
        for (let j = i + 2; j < n; j++) {
          if (candles[j].low <= eq) {
            mitigated = true;
            break;
          }
        }
        orderBlocks.push({
          type: 'BULLISH_OB',
          index: i,
          high: Number(prev.high.toFixed(2)),
          low: Number(prev.low.toFixed(2)),
          equilibrium: Number(eq.toFixed(2)),
          mitigated,
          distancePct: latestClose > 0 ? Number((((latestClose - eq) / latestClose) * 100).toFixed(2)) : 0
        });
      }

      // Bearish Order Block: bullish candle followed by strong bearish displacement > 1.5x avgBody
      if (prev.close > prev.open && disp.close < disp.open && dispBody >= avgBody * 1.4 && disp.close < prev.low) {
        const eq = (prev.high + prev.low) / 2;
        let mitigated = false;
        for (let j = i + 2; j < n; j++) {
          if (candles[j].high >= eq) {
            mitigated = true;
            break;
          }
        }
        orderBlocks.push({
          type: 'BEARISH_OB',
          index: i,
          high: Number(prev.high.toFixed(2)),
          low: Number(prev.low.toFixed(2)),
          equilibrium: Number(eq.toFixed(2)),
          mitigated,
          distancePct: latestClose > 0 ? Number((((eq - latestClose) / latestClose) * 100).toFixed(2)) : 0
        });
      }
    }

    return orderBlocks.slice(-6);
  }

  function detectLiquiditySweeps(candles, lookback = 15) {
    const sweeps = [];
    const n = candles.length;
    if (n <= lookback) return sweeps;

    const start = Math.max(lookback, n - 5);
    for (let i = start; i < n; i++) {
      const window = candles.slice(i - lookback, i);
      const swingHigh = Math.max(...window.map(c => c.high));
      const swingLow = Math.min(...window.map(c => c.low));
      const cur = candles[i];

      // Buy-Side Liquidity Sweep (pierced above swingHigh, closed below swingHigh)
      if (cur.high > swingHigh && cur.close < swingHigh) {
        sweeps.push({
          type: 'BUY_SIDE_SWEEP',
          sig: 'SELL',
          index: i,
          sweptLevel: Number(swingHigh.toFixed(2)),
          wickHigh: Number(cur.high.toFixed(2)),
          desc: `Turtle-Soup stop hunt above ₹${swingHigh.toFixed(2)} followed by rejection close`
        });
      }

      // Sell-Side Liquidity Sweep (pierced below swingLow, closed above swingLow)
      if (cur.low < swingLow && cur.close > swingLow) {
        sweeps.push({
          type: 'SELL_SIDE_SWEEP',
          sig: 'BUY',
          index: i,
          sweptLevel: Number(swingLow.toFixed(2)),
          wickLow: Number(cur.low.toFixed(2)),
          desc: `Turtle-Soup stop hunt below ₹${swingLow.toFixed(2)} followed by reclaim close`
        });
      }
    }

    return sweeps;
  }

  function detectMarketStructure(candles) {
    const n = candles.length;
    if (n < 10) return { state: 'INSUFFICIENT_DATA', bias: 'NEUTRAL', bos: false, choch: false };

    const recent = candles.slice(-5);
    const prior = candles.slice(-10, -5);

    const recentHigh = Math.max(...recent.map(c => c.high));
    const recentLow = Math.min(...recent.map(c => c.low));
    const priorHigh = Math.max(...prior.map(c => c.high));
    const priorLow = Math.min(...prior.map(c => c.low));

    const lastClose = candles[n - 1].close;
    const brokeUp = lastClose > priorHigh;
    const brokeDown = lastClose < priorLow;

    let state = 'RANGING';
    let bias = 'NEUTRAL';
    let bos = false;
    let choch = false;

    if (brokeUp && recentLow >= priorLow) {
      state = 'BULLISH_BOS';
      bias = 'BULLISH';
      bos = true;
    } else if (brokeUp && recentLow < priorLow) {
      state = 'BULLISH_CHOCH';
      bias = 'BULLISH';
      choch = true;
    } else if (brokeDown && recentHigh <= priorHigh) {
      state = 'BEARISH_BOS';
      bias = 'BEARISH';
      bos = true;
    } else if (brokeDown && recentHigh > priorHigh) {
      state = 'BEARISH_CHOCH';
      bias = 'BEARISH';
      choch = true;
    } else if (recentHigh > priorHigh && recentLow > priorLow) {
      state = 'HIGHER_HIGHS';
      bias = 'BULLISH';
    } else if (recentHigh < priorHigh && recentLow < priorLow) {
      state = 'LOWER_LOWS';
      bias = 'BEARISH';
    }

    return {
      state,
      bias,
      bos,
      choch,
      swingHigh: Number(recentHigh.toFixed(2)),
      swingLow: Number(recentLow.toFixed(2))
    };
  }

  /**
   * Runs full Smart Money Concepts pattern scan on OHLCV candles or parallel arrays.
   */
  function scanPatterns(input) {
    const candles = Array.isArray(input)
      ? normalizeCandles(input)
      : buildCandlesFromArrays(input || {});

    if (candles.length < 5) {
      return {
        ok: false,
        candleCount: candles.length,
        structure: { state: 'INSUFFICIENT_DATA', bias: 'NEUTRAL' },
        orderBlocks: [],
        fvgs: [],
        sweeps: [],
        confluenceScore: 50,
        summary: 'Insufficient candle history for SMC pattern scan.'
      };
    }

    const structure = detectMarketStructure(candles);
    const orderBlocks = detectOrderBlocks(candles);
    const fvgs = detectFairValueGaps(candles);
    const sweeps = detectLiquiditySweeps(candles);

    const activeBullOB = orderBlocks.filter(o => o.type === 'BULLISH_OB' && !o.mitigated).length;
    const activeBearOB = orderBlocks.filter(o => o.type === 'BEARISH_OB' && !o.mitigated).length;
    const virginBullFVG = fvgs.filter(f => f.type === 'BULLISH_FVG' && !f.mitigated).length;
    const virginBearFVG = fvgs.filter(f => f.type === 'BEARISH_FVG' && !f.mitigated).length;

    let bullPts = (structure.bias === 'BULLISH' ? 20 : 0) + activeBullOB * 12 + virginBullFVG * 10;
    let bearPts = (structure.bias === 'BEARISH' ? 20 : 0) + activeBearOB * 12 + virginBearFVG * 10;

    for (const sw of sweeps) {
      if (sw.sig === 'BUY') bullPts += 20;
      if (sw.sig === 'SELL') bearPts += 20;
    }

    const confluenceScore = Math.max(10, Math.min(95, Math.round(50 + (bullPts - bearPts) * 0.7)));
    const action = confluenceScore >= 65 ? 'BULLISH_SMC' : (confluenceScore <= 35 ? 'BEARISH_SMC' : 'NEUTRAL_SMC');

    return {
      ok: true,
      candleCount: candles.length,
      structure,
      orderBlocks,
      fvgs,
      sweeps,
      confluenceScore,
      action,
      summary: `${structure.state} · ${orderBlocks.length} OB · ${fvgs.length} FVG · ${sweeps.length} Sweeps`
    };
  }

  return {
    scanPatterns,
    detectOrderBlocks,
    detectFairValueGaps,
    detectLiquiditySweeps,
    detectMarketStructure
  };

}));
