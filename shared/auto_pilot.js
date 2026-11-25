/**
 * shared/auto_pilot.js — Autonomous Paper-Trading Execution, Best-Stock Selector & Position Lifecycle Engine
 *
 * Configured for a ₹15,000 Starting Budget (₹150 max risk/trade, ₹375 daily circuit breaker, 4 max trades/day):
 * 1. Best NSE Stock Identifier & Daily Auto-Trader (09:15–15:20 IST):
 *    - Scans all 12 liquid Nifty-50 large-caps in SQLite (RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK,
 *      BHARTIARTL, SBIN, ITC, LT, KOTAKBANK, AXISBANK, MARUTI).
 *    - Ranks them by a 4-Pillar Composite Conviction Score (17-Indicator Regime + 1H HTF + SMC Order Blocks/FVGs
 *      + Geopolitical Sector Impact + Tauric Bull/Bear Debate & Reflection Memory + Net R:R after Zerodha MIS fees).
 *    - Sizes share quantity under Zerodha MIS (5x intraday leverage, max 45% capital margin = ₹6,750/trade)
 *      and caps net loss at Stop Loss to ₹150 (or ₹90 auto-recovery after 1 loss).
 * 2. Commodity Auto-Trader (09:15–23:20 IST):
 *    - Scans Gold, Silver, Crude, NatGas, Copper and routes to ₹15,000-compatible contracts (GOLDPETAL, NATGASM, etc.).
 * 3. Autonomous Position Lifecycle Manager (Every 60s):
 *    - +1R Fee-Covered Breakeven Stop Trailing
 *    - Auto-Close on SL / Target / Mandatory 15:20 IST (NSE MIS) & 23:20 IST (MCX) EOD Square-Off
 *    - Auto-inserts Post-Trade Reflection Lessons into `trade_lessons` to train Edge Finder.
 */

const riskEngine = require('../risk');
const contractResolver = require('./contract_resolver');
const macroEvents = require('./macro_events');
const circuitBreaker = require('./circuit_breaker');
const patternEngine = require('./pattern_engine');
const signalEngine = require('./signal_engine');
const debateEngine = require('./debate_engine');
const nseHolidays = require('./nse_holidays');
const nseMcpClient = require('./nse_mcp_client');

const AUTO_PILOT_STOCKS = [
  { id: 'reliance',   symbol: 'RELIANCE',   ticker: 'RELIANCE.NS',   name: 'Reliance Ind',   sector: 'Energy/Telecom', sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'tcs',        symbol: 'TCS',        ticker: 'TCS.NS',        name: 'TCS',            sector: 'IT Services',    sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'infy',       symbol: 'INFY',       ticker: 'INFY.NS',       name: 'Infosys',        sector: 'IT Services',    sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'hdfcbank',   symbol: 'HDFCBANK',   ticker: 'HDFCBANK.NS',   name: 'HDFC Bank',      sector: 'Banking',        sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'icicibank',  symbol: 'ICICIBANK',  ticker: 'ICICIBANK.NS',  name: 'ICICI Bank',     sector: 'Banking',        sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'bhartiartl', symbol: 'BHARTIARTL', ticker: 'BHARTIARTL.NS', name: 'Bharti Airtel',  sector: 'Telecom',        sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'sbin',       symbol: 'SBIN',       ticker: 'SBIN.NS',       name: 'State Bank',     sector: 'PSU Banking',    sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'itc',        symbol: 'ITC',        ticker: 'ITC.NS',        name: 'ITC Ltd',        sector: 'FMCG',           sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'lt',         symbol: 'LT',         ticker: 'LT.NS',         name: 'Larsen & Toubro',sector: 'Infrastructure', sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'kotakbank',  symbol: 'KOTAKBANK',  ticker: 'KOTAKBANK.NS',  name: 'Kotak Bank',     sector: 'Banking',        sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'axisbank',   symbol: 'AXISBANK',   ticker: 'AXISBANK.NS',   name: 'Axis Bank',      sector: 'Banking',        sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 },
  { id: 'maruti',     symbol: 'MARUTI',     ticker: 'MARUTI.NS',     name: 'Maruti Suzuki',  sector: 'Auto',           sl_atr: 1.8, t1_atr: 2.8, t2_atr: 4.5 }
];

const AUTO_PILOT_ASSETS = [
  {
    id: 'gold',
    name: 'GOLD',
    ticker: 'GC=F',
    dbSym: 'GOLDM',
    conv: (p, r) => p * r * 10 / 31.1035 * 1.0426,
    sl_atr: 2.5,
    t1_atr: 4.0,
    t2_atr: 7.0,
    proxyBasePrice: { GOLDPETAL: 11070, GOLDBEES: 92 }
  },
  {
    id: 'silver',
    name: 'SILVER',
    ticker: 'SI=F',
    dbSym: 'SILVERMIC',
    conv: (p, r) => p * r * 1000 / 31.1035 * 1.0771,
    sl_atr: 2.0,
    t1_atr: 3.0,
    t2_atr: 6.0,
    proxyBasePrice: { SILVERBEES: 124 }
  },
  {
    id: 'crude',
    name: 'CRUDE',
    ticker: 'CL=F',
    dbSym: 'CRUDEOILM',
    conv: (p, r) => p * r,
    sl_atr: 2.0,
    t1_atr: 3.0,
    t2_atr: 5.0,
    proxyBasePrice: { ONGC: 255 }
  },
  {
    id: 'natgas',
    name: 'NATGAS',
    ticker: 'NG=F',
    dbSym: 'NATGASM',
    conv: (p, r) => p * r,
    sl_atr: 2.0,
    t1_atr: 3.0,
    t2_atr: 5.5,
    proxyBasePrice: {}
  },
  {
    id: 'copper',
    name: 'COPPER',
    ticker: 'HG=F',
    dbSym: 'COPPER',
    conv: (p, r) => p * r * 2.20462,
    sl_atr: 2.5,
    t1_atr: 3.5,
    t2_atr: 6.0,
    proxyBasePrice: { HINDCOPPER: 310 }
  }
];

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function ema(arr, n) {
  if (!arr || !arr.length) return 0;
  const k = 2 / (n + 1);
  const initLen = Math.min(n, arr.length);
  let e = arr.slice(0, initLen).reduce((s, v) => s + v, 0) / initLen;
  for (let i = initLen; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function sma(arr, n) {
  const s = arr.slice(-Math.min(n, arr.length));
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
}

function calcRSI(arr, n = 14) {
  if (!arr || arr.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = arr.length - n; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) g += d;
    else l += Math.abs(d);
  }
  const rs = (g / n) / ((l / n) || 0.001);
  return clamp(100 - 100 / (1 + rs), 1, 99);
}

function calcMACD(arr) {
  const e12 = ema(arr, 12), e26 = ema(arr, 26), line = e12 - e26;
  const signal = ema(arr.slice(-35).map((_, i, s) => ema(s.slice(0, i + 1), 12) - ema(s.slice(0, i + 1), 26)), 9);
  return { line, signal, hist: line - signal };
}

function calcBB(arr, n = 20, mult = 2) {
  const mid = sma(arr, n);
  const sl = arr.slice(-Math.min(n, arr.length));
  const std = Math.sqrt(sl.reduce((s, p) => s + (p - mid) ** 2, 0) / (sl.length || 1));
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

function calcATR(cls, his, los, n = 14) {
  const l = Math.min(cls.length, his.length, los.length);
  const trs = [];
  for (let i = 1; i < l; i++) {
    trs.push(Math.max(his[i] - los[i], Math.abs(his[i] - cls[i - 1]), Math.abs(los[i] - cls[i - 1])));
  }
  if (!trs.length) return 0;
  return trs.slice(-n).reduce((a, b) => a + b, 0) / Math.min(n, trs.length);
}

function calcStoch(cls, his, los, n = 14) {
  const l = Math.min(cls.length, his.length, los.length);
  if (l < n) return { k: 50, d: 50 };
  const sh = his.slice(-n), sl = los.slice(-n);
  const hi = Math.max(...sh), lo = Math.min(...sl);
  const k = hi === lo ? 50 : clamp(((cls[l - 1] - lo) / (hi - lo)) * 100, 0, 100);
  return { k, d: k };
}

/**
 * Checks whether the current IST time is within active Monday–Friday trading hours.
 */
function getMarketSessionWindow(nowDate = new Date()) {
  const kt = nseHolidays.getKolkataTime(nowDate);
  const isNseDay = nseHolidays.isNseTradingDay(kt.dateStr);
  const holidayReason = isNseDay ? null : nseHolidays.getHolidayReason(kt.dateStr);
  const mins = kt.hour * 60 + kt.minute;

  const isWeekday = kt.dayOfWeek >= 1 && kt.dayOfWeek <= 5;
  const isMcxHours = isWeekday && mins >= (9 * 60 + 15) && mins <= (23 * 60 + 15);
  const isNseHours = isNseDay && mins >= (9 * 60 + 15) && mins <= (15 * 60 + 15);
  const isMcxEodSquareOff = isWeekday && mins >= (23 * 60 + 20) && mins <= (23 * 60 + 35);
  const isNseEodSquareOff = isNseDay && mins >= (15 * 60 + 20) && mins <= (15 * 60 + 35);

  let nseSessionPhase = 'CLOSED';
  if (isNseDay) {
    if (mins >= (9 * 60 + 20) && mins < (11 * 60 + 15)) nseSessionPhase = 'MORNING_DRIVE';
    else if (mins >= (11 * 60 + 15) && mins < (13 * 60 + 30)) nseSessionPhase = 'MIDDAY_CHOP';
    else if (mins >= (13 * 60 + 30) && mins < (14 * 60 + 45)) nseSessionPhase = 'AFTERNOON_DRIVE';
    else if (mins >= (14 * 60 + 45) && mins <= (15 * 60 + 30)) nseSessionPhase = 'CLOSING_CUTOFF';
  }

  return {
    istDate: kt.dateStr,
    istTime: `${String(kt.hour).padStart(2, '0')}:${String(kt.minute).padStart(2, '0')}`,
    dayOfWeek: kt.dayOfWeek,
    isWeekday,
    isNseDay,
    holidayReason,
    isMcxHours,
    isNseHours,
    nseSessionPhase,
    isMiddayChop: nseSessionPhase === 'MIDDAY_CHOP',
    isMcxEodSquareOff,
    isNseEodSquareOff,
    isAnySessionOpen: isMcxHours || isNseHours
  };
}

/**
 * Dual-Archetype Walk-Forward Historical Chart Backtest Gate (`computeHistoricalSetupEdge`)
 * Tests BOTH:
 *  1) TREND_RUNNER (EMA9/21 continuation + momentum)
 *  2) MEAN_REVERTER (VWAP/EMA21 Snap-Back from >1.25 ATR stretch + reversal candle)
 * on the stock's own historical 5m candles using our 3-Stage Progressive Profit Ratchet,
 * and automatically selects the stock's highest-expectancy proven archetype.
 */
function computeHistoricalSetupEdge({
  closes = [],
  highs = [],
  lows = [],
  action = 'BUY',
  slAtrMult = 1.8,
  t1AtrMult = 2.8
}) {
  const n = Math.min(closes.length, highs.length, lows.length);
  if (n < 45 || (action !== 'BUY' && action !== 'SELL')) {
    return { archetype: 'TREND_RUNNER', samples: 0, wins: 0, losses: 0, winRate: 55, profitFactor: 1.35, expectancyR: 0.25, provenEdge: true };
  }

  const targetR = +(t1AtrMult / Math.max(0.5, slAtrMult)).toFixed(2);
  const k9 = 2 / 10, k21 = 2 / 22;
  const e9 = [closes[0]], e21 = [closes[0]];
  for (let i = 1; i < n; i++) {
    e9.push(closes[i] * k9 + e9[i - 1] * (1 - k9));
    e21.push(closes[i] * k21 + e21[i - 1] * (1 - k21));
  }

  const simulateArchetype = (mode) => {
    let samples = 0, wins = 0, losses = 0, grossWinR = 0, grossLossR = 0;
    let i = 25;
    while (i < n - 16) {
      let trSum = 0;
      for (let j = i - 13; j <= i; j++) {
        trSum += Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j - 1]), Math.abs(lows[j] - closes[j - 1]));
      }
      const localAtr = Math.max(closes[i] * 0.0025, trSum / 14);

      let matches = false;
      if (mode === 'TREND_RUNNER') {
        const isBuy = e9[i] > e21[i] && closes[i] > e9[i] && closes[i] > closes[i - 3];
        const isSell = e9[i] < e21[i] && closes[i] < e9[i] && closes[i] < closes[i - 3];
        matches = (action === 'BUY' && isBuy) || (action === 'SELL' && isSell);
      } else {
        // MEAN_REVERTER: Snap-back from >1.15 ATR stretch away from EMA21 with reversal tick
        const distFromEma = (closes[i] - e21[i]) / localAtr;
        const isBuyRevert = distFromEma <= -1.15 && closes[i] > closes[i - 1];
        const isSellRevert = distFromEma >= 1.15 && closes[i] < closes[i - 1];
        matches = (action === 'BUY' && isBuyRevert) || (action === 'SELL' && isSellRevert);
      }

      if (!matches) {
        i++;
        continue;
      }

      const riskPts = localAtr * slAtrMult;
      const entry = closes[i];
      let lockedR = -1.0;
      let outcomeR = null;

      for (let f = i + 1; f <= Math.min(n - 1, i + 24); f++) {
        const favPts = action === 'BUY' ? (highs[f] - entry) : (entry - lows[f]);
        const advPts = action === 'BUY' ? (entry - lows[f]) : (highs[f] - entry);
        const favR = favPts / riskPts;
        const advR = advPts / riskPts;

        if (-advR <= lockedR) {
          outcomeR = lockedR;
          break;
        }
        if (favR >= targetR) {
          outcomeR = targetR - 0.08;
          break;
        }
        if (favR >= 1.50 && lockedR < 0.95) lockedR = 0.95;
        else if (favR >= 1.15 && lockedR < 0.50) lockedR = 0.50;
        else if (favR >= 0.70 && lockedR < 0.05) lockedR = 0.05;
      }

      if (outcomeR === null) {
        const endExit = closes[Math.min(n - 1, i + 24)];
        const rawEndR = ((action === 'BUY' ? (endExit - entry) : (entry - endExit)) / riskPts) - 0.08;
        outcomeR = Math.max(lockedR, rawEndR);
      }

      samples++;
      if (outcomeR > 0) {
        wins++;
        grossWinR += outcomeR;
      } else {
        losses++;
        grossLossR += Math.abs(outcomeR);
      }
      i += 6;
    }

    if (samples === 0) {
      return { archetype: mode, samples: 0, wins: 0, losses: 0, winRate: 50, profitFactor: 1.0, expectancyR: 0, provenEdge: false };
    }
    const winRate = Math.round((wins / samples) * 100);
    const profitFactor = grossLossR > 0 ? +(grossWinR / grossLossR).toFixed(2) : +(grossWinR || 2.0).toFixed(2);
    const expectancyR = +((grossWinR - grossLossR) / samples).toFixed(2);
    const provenEdge = samples < 4 ? (winRate >= 50) : (winRate >= 50 && profitFactor >= 1.15);
    return { archetype: mode, samples, wins, losses, winRate, profitFactor, expectancyR, provenEdge };
  };

  const trendEdge = simulateArchetype('TREND_RUNNER');
  const revertEdge = simulateArchetype('MEAN_REVERTER');

  // Pick whichever archetype has stronger proven Profit Factor / Expectancy on this stock
  let best = trendEdge;
  if (revertEdge.samples >= 4 && revertEdge.provenEdge && (!trendEdge.provenEdge || revertEdge.profitFactor > trendEdge.profitFactor * 1.15)) {
    best = revertEdge;
  } else if (trendEdge.samples === 0 && revertEdge.samples === 0) {
    best = { archetype: 'TREND_RUNNER', samples: 0, wins: 0, losses: 0, winRate: 55, profitFactor: 1.35, expectancyR: 0.25, provenEdge: true };
  }

  return {
    ...best,
    trendEdge: { samples: trendEdge.samples, winRate: trendEdge.winRate, profitFactor: trendEdge.profitFactor },
    revertEdge: { samples: revertEdge.samples, winRate: revertEdge.winRate, profitFactor: revertEdge.profitFactor }
  };
}

/**
 * Evaluates an NSE Large-Cap Stock through the 4-Pillar Multi-Factor Pipeline for a ₹15,000 Budget
 * (MIS 5x intraday leverage, max 45% capital margin per trade = ₹6,750, max ₹150 net risk at SL).
 */
function evaluateStockForAutoPilot({
  stock,
  rawCandles = [],
  nseMcpQuote = null,
  nseMcpOverview = null,
  swingProfile = null,
  multiYearSwingEdge = null,
  brainState = null,
  recentLessons = [],
  geoIntel = null,
  accountProfile = { capital: 15000, maxRiskPerTrade: 150, dailyLossLimit: 375 },
  todayTrades = [],
  nowDate = new Date()
}) {
  if (!stock || !Array.isArray(rawCandles) || rawCandles.length < 25) {
    return {
      assetType: 'STOCK',
      commodityId: stock?.id || 'unknown',
      symbol: stock?.symbol || 'UNKNOWN',
      name: stock?.name || 'UNKNOWN',
      sector: stock?.sector || 'Equity',
      action: 'WAIT',
      confidence: 0,
      compositeRankScore: 0,
      qualifiesForAutoExec: false,
      vetoReason: 'Insufficient 5m candle history (<25 bars)'
    };
  }

  const opens = rawCandles.map(r => Number(r.open || r.close));
  const highs = rawCandles.map(r => Number(r.high || r.close));
  const lows = rawCandles.map(r => Number(r.low || r.close));
  const closes = rawCandles.map(r => Number(r.close));
  const vols = rawCandles.map(r => Number(r.volume || 0));
  const timestamps = rawCandles.map(r => Number(r.time || 0));

  // If official live NSE MCP quote is available, append/update as a fresh current bar (never mix with an older day's bar high/low)
  if (nseMcpQuote && Number.isFinite(nseMcpQuote.ltp) && nseMcpQuote.ltp > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const lastTs = timestamps[timestamps.length - 1] || 0;
    const lastSec = lastTs > 1e12 ? Math.floor(lastTs / 1000) : lastTs;
    if (nowSec - lastSec > 600) {
      opens.push(nseMcpQuote.ltp);
      highs.push(nseMcpQuote.ltp);
      lows.push(nseMcpQuote.ltp);
      closes.push(nseMcpQuote.ltp);
      vols.push(Number(nseMcpQuote.volume || vols[vols.length - 1] || 1000));
      timestamps.push(nowSec);
    } else {
      const lastIdx = closes.length - 1;
      closes[lastIdx] = nseMcpQuote.ltp;
      highs[lastIdx] = Math.max(highs[lastIdx], nseMcpQuote.ltp);
      lows[lastIdx] = Math.min(lows[lastIdx], nseMcpQuote.ltp);
    }
  }

  const price = +(closes[closes.length - 1]).toFixed(2);
  const prevClose = (nseMcpQuote && nseMcpQuote.prevClose > 0) ? nseMcpQuote.prevClose : (closes[0] || price);
  const dayChgPct = (nseMcpQuote && Number.isFinite(nseMcpQuote.perChange))
    ? Number(nseMcpQuote.perChange)
    : (prevClose > 0 ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : 0);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const bb = calcBB(closes, 20, 2);
  const atr = Math.max(price * 0.003, calcATR(closes, highs, lows, 14));
  const stoch = calcStoch(closes, highs, lows, 14);
  const adx = signalEngine.calcADX(closes, highs, lows, 14);
  const obv = signalEngine.calcOBV(closes, vols);
  const vwap = signalEngine.calcSessionVWAP(closes, highs, lows, vols, 30);

  const last5 = closes.slice(-5), prev5 = closes.slice(-10, -5);
  const lA = last5.reduce((a, b) => a + b, 0) / (last5.length || 1);
  const pA = prev5.reduce((a, b) => a + b, 0) / (prev5.length || 1);
  const mom = pA ? ((lA - pA) / pA) * 100 : 0;
  const structTrend = mom > 0.2 ? 'BUY' : mom < -0.2 ? 'SELL' : 'NEUTRAL';

  const sigs = {
    rsi: rsi < 38 ? 'BUY' : rsi > 64 ? 'SELL' : 'NEUTRAL',
    macd_hist: macd.hist > 0 ? 'BUY' : 'SELL',
    bb: price < bb.lower ? 'BUY' : price > bb.upper ? 'SELL' : 'NEUTRAL',
    ema_cross: ema9 > ema21 && ema21 > ema50 ? 'BUY' : ema9 < ema21 && ema21 < ema50 ? 'SELL' : (ema9 > ema21 ? 'BUY' : 'SELL'),
    ema9: price > ema9 ? 'BUY' : 'SELL',
    ema21: price > ema21 ? 'BUY' : 'SELL',
    ema50: price > ema50 ? 'BUY' : 'SELL',
    ema200: price > ema200 ? 'BUY' : 'SELL',
    stoch: stoch.k < 25 ? 'BUY' : stoch.k > 75 ? 'SELL' : 'NEUTRAL',
    adx: adx.plus > adx.minus ? 'BUY' : 'SELL',
    cci: price > bb.mid ? 'BUY' : 'SELL',
    willr: stoch.k < 20 ? 'BUY' : stoch.k > 80 ? 'SELL' : 'NEUTRAL',
    obv: obv.trend,
    vwap: price > vwap ? 'BUY' : 'SELL',
    ich: price > ema21 && ema9 > ema21 ? 'BUY' : price < ema21 && ema9 < ema21 ? 'SELL' : 'NEUTRAL',
    mfi: rsi < 32 ? 'BUY' : rsi > 68 ? 'SELL' : 'NEUTRAL',
    struct: structTrend
  };

  // Geopolitical & Official NSE MCP Exchange Flow Catalyst Score (5th Pillar)
  let newsScore = 50;
  const geoStock = geoIntel?.stockImpacts?.[stock.symbol];
  if (geoStock && geoStock.impact) {
    const imp = String(geoStock.impact).toUpperCase();
    if (imp.includes('BULLISH')) newsScore = 68;
    else if (imp.includes('BEARISH')) newsScore = 32;
  }

  const nseEdge = nseMcpClient.computeNseMcpStockEdge({
    symbol: stock.symbol,
    sector: stock.sector,
    liveQuote: nseMcpQuote,
    marketOverview: nseMcpOverview
  });
  if (nseEdge.available) {
    newsScore = clamp(Math.round(newsScore + nseEdge.scoreDelta), 12, 88);
  }
  const nseMicroScore = nseEdge.available ? clamp(Math.round(50 + nseEdge.scoreDelta * 1.4), 10, 90) : 55;

  const smc = patternEngine.scanPatterns({ opens, closes, highs, lows, volumes: vols });
  const htfTrend = signalEngine.computeHTFTrend(closes, highs, lows);
  const openingRangeGuard = signalEngine.checkOpeningRangeGuard(timestamps, closes, highs, lows, atr);
  const isOverextended = atr > 0 ? Math.abs(price - ema21) > 1.9 * atr : false;

  const preliminarySide = sigs.ema_cross === 'SELL' ? 'SELL' : 'BUY';
  const prelimLevels = signalEngine.computeStructuralLevels({
    action: preliminarySide,
    price,
    atr,
    slAtrMult: stock.sl_atr || 1.8,
    t1AtrMult: stock.t1_atr || 3.2,
    t2AtrMult: stock.t2_atr || 5.0,
    smc
  });

  // Estimate round-trip Zerodha NSE MIS fees for ~₹20,000 notional position (~12-18 ₹)
  const estNotionalShares = Math.max(1, Math.floor(20000 / Math.max(1, price)));
  const estRoundTripFee = riskEngine.calculateZerodhaFees({
    segment: 'equity',
    buyPrice: preliminarySide === 'BUY' ? prelimLevels.entry : prelimLevels.t1,
    sellPrice: preliminarySide === 'BUY' ? prelimLevels.t1 : prelimLevels.entry,
    qty: estNotionalShares,
    lotMultiplier: 1
  }).totalFees;
  const perShareFee = estRoundTripFee / estNotionalShares;

  const gate = signalEngine.evaluateRegimeAndFeeGate({
    sigs,
    adxObj: adx,
    smc,
    newsScore,
    volConfirmed: true,
    entry: prelimLevels.entry,
    sl: prelimLevels.sl,
    t1: prelimLevels.t1,
    lotMultiplier: estNotionalShares,
    roundTripFee: estRoundTripFee,
    minGrossTargetMultiple: 2.8,
    minNetRR: 1.20,
    threshold: 62,
    htfTrend,
    openingRangeGuard,
    isOverextended,
    dualFeed: {
      sessionWindow: 'NSE_INTRADAY',
      paritySignal: nseEdge.bias !== 'NEUTRAL' ? nseEdge.bias : 'NEUTRAL',
      microstructureScore: nseMicroScore
    }
  });

  const action = gate.action;
  const confidence = action === 'BUY'
    ? gate.combined
    : action === 'SELL'
      ? (100 - gate.combined)
      : Math.max(gate.combined, 100 - gate.combined);

  const debate = debateEngine.buildQuantitativeDebate({
    symbol: stock.symbol,
    commodityId: stock.id,
    action,
    confidence,
    regime: gate.regime,
    htfTrend,
    dualFeed: { sessionWindow: 'ASIA_MORNING', paritySignal: 'NEUTRAL' },
    smc,
    geoIntel,
    recentLessons,
    netRR: gate.netRR
  });

  const stance = debateEngine.evaluateAdaptiveRiskStance({
    trades: todayTrades,
    baseRisk: accountProfile.maxRiskPerTrade || 150,
    dailyLossLimit: accountProfile.dailyLossLimit || 375,
    requestedStance: 'AUTO'
  });

  const capital = Number(accountProfile.capital) || 15000;
  const brainSizeMult = Number(brainState?.combinedSizeMultiplier || brainState?.regime?.sizeMultiplier || 1.0);
  const effectiveBudget = Math.max(50, Math.round(stance.effectiveRisk * (debate.sizeMultiplier || 1) * brainSizeMult));

  const finalSide = action === 'SELL' ? 'SELL' : 'BUY';
  const finalLevels = signalEngine.computeStructuralLevels({
    action: finalSide,
    price,
    atr,
    slAtrMult: stock.sl_atr || 1.8,
    t1AtrMult: stock.t1_atr || 3.2,
    t2AtrMult: stock.t2_atr || 5.0,
    smc
  });

  // Cap share quantity by both:
  // (A) Net risk budget at SL (₹150 balanced / ₹90 recovery) via riskEngine.sizeTrade
  // (B) 45% of ₹15,000 capital under 5x MIS leverage (= ₹6,750 max margin = ₹33,750 max notional per stock)
  const misLeverage = 5;
  const maxMarginPerTrade = Math.round(capital * 0.45); // ₹6,750 on ₹15,000 capital
  const maxNotionalPerTrade = maxMarginPerTrade * misLeverage; // ₹33,750 notional
  const maxSharesByMargin = Math.max(1, Math.floor(maxNotionalPerTrade / Math.max(1, price)));

  const sized = riskEngine.sizeTrade({
    side: finalSide,
    entry: finalLevels.entry,
    sl: finalLevels.sl,
    target: finalLevels.t1,
    lotMultiplier: 1,
    segment: 'equity',
    maxLossTotal: effectiveBudget,
    minNetRR: 1.20
  });

  const rawQty = sized.ok ? Number(sized.qty ?? sized.lots ?? 1) : 0;
  const finalQty = rawQty > 0 ? Math.min(rawQty, maxSharesByMargin) : 0;
  const marginRequired = +(finalQty * (price / misLeverage)).toFixed(2);

  // Recalculate exact planned loss & Net R:R for finalQty
  let plannedLoss = null;
  let actualStopFees = estRoundTripFee;
  let finalNetRR = gate.netRR;
  if (finalQty >= 1) {
    const slFees = riskEngine.calculateZerodhaFees({
      segment: 'equity',
      buyPrice: finalSide === 'BUY' ? finalLevels.entry : finalLevels.sl,
      sellPrice: finalSide === 'BUY' ? finalLevels.sl : finalLevels.entry,
      qty: finalQty,
      lotMultiplier: 1
    }).totalFees;
    const t1Fees = riskEngine.calculateZerodhaFees({
      segment: 'equity',
      buyPrice: finalSide === 'BUY' ? finalLevels.entry : finalLevels.t1,
      sellPrice: finalSide === 'BUY' ? finalLevels.t1 : finalLevels.entry,
      qty: finalQty,
      lotMultiplier: 1
    }).totalFees;
    actualStopFees = slFees;
    const grossRisk = Math.abs(finalLevels.entry - finalLevels.sl) * finalQty;
    const grossReward = Math.abs(finalLevels.t1 - finalLevels.entry) * finalQty;
    plannedLoss = +(grossRisk + slFees).toFixed(2);
    finalNetRR = +((grossReward - t1Fees) / Math.max(1, grossRisk + slFees)).toFixed(2);
  }

  // 6th Pillar: Dual-Archetype Walk-Forward Historical Chart Backtest Gate (`TREND_RUNNER` vs `MEAN_REVERTER`)
  const histEdge = computeHistoricalSetupEdge({
    closes,
    highs,
    lows,
    action: finalSide,
    slAtrMult: stock.sl_atr || 1.8,
    t1AtrMult: stock.t1_atr || 2.8
  });

  // 2-Bucket ₹15,000 Capital Allocator:
  // - Bucket 1 (₹10,000 CNC Swing — ₹0 brokerage): Up to ₹5,000 per multi-day BUY position when above 20/50 DMA & near 52W high
  // - Bucket 2 (₹5,000 MIS Intraday — 5x = ₹25,000 buying power): Max ₹2,500 margin per intraday sniper trade
  const sessionInfo = getMarketSessionWindow(nowDate);
  const multiYearPasses = !multiYearSwingEdge || multiYearSwingEdge.provenEdge === true;
  const isCncSwingEligible = Boolean(
    swingProfile && swingProfile.qualifiesForCncSwing && multiYearPasses && finalSide === 'BUY' && price <= 5000
  );
  const assignedBucket = isCncSwingEligible ? 'CNC_SWING' : 'MIS_INTRADAY';
  const assignedProduct = isCncSwingEligible ? 'CNC' : 'MIS';

  let execQty = Math.max(1, finalQty);
  let execSl = finalLevels.sl;
  let execT1 = finalLevels.t1;
  let execMargin = finalQty >= 1 ? marginRequired : +(price / misLeverage).toFixed(2);
  let execNetRR = finalNetRR;

  if (isCncSwingEligible) {
    // ₹5,000 per CNC Swing slot (2 slots = ₹10,000 Swing Bucket), ₹0 delivery brokerage, -2.0% SL / +4.5% Target
    execQty = Math.max(1, Math.floor(5000 / Math.max(1, price)));
    execSl = +(price * 0.98).toFixed(2);
    execT1 = +(price * 1.045).toFixed(2);
    execMargin = +(execQty * price).toFixed(2);
    execNetRR = 2.15;
  }

  const benchedEntry = (brainState?.execution?.autoBenchedSymbols || []).find(b => b.symbol === stock.symbol);
  const regimeObj = brainState?.regime || null;
  const eqGov = brainState?.equityGovernor || null;
  const stratKey = isCncSwingEligible ? 'CNC_SWING_CHAMPIONS' : 'MIS_INTRADAY';
  const stratInfo = brainState?.strategyAllocator?.byId?.[stratKey] || null;

  let vetoReason = gate.vetoReason || null;
  let qualifiesForAutoExec = false;
  if (benchedEntry) {
    vetoReason = `Brain Auto-Bench Veto: ${benchedEntry.reason} (${benchedEntry.trades} trades, Net ₹${benchedEntry.netPnl})`;
  } else if (stratInfo && stratInfo.status === 'SHADOW_PAUSED') {
    vetoReason = `Brain CIO Shadow-Pause (${stratKey}): ${stratInfo.shadowReason || 'Strategy decaying — paused until recovery'}`;
  } else if (!isCncSwingEligible && eqGov && eqGov.allowIntradayMis === false) {
    vetoReason = `Brain Equity Shield (${eqGov.state}): ${eqGov.rationale}`;
  } else if (regimeObj && action === 'BUY' && regimeObj.allowNewLongs === false) {
    vetoReason = `Brain Regime Veto (${regimeObj.regime}): ${regimeObj.directive}`;
  } else if (regimeObj && action === 'SELL' && regimeObj.allowNewShorts === false) {
    vetoReason = `Brain Regime Veto (${regimeObj.regime}): ${regimeObj.directive}`;
  } else if (swingProfile && swingProfile.corporateActionBlocked) {
    vetoReason = `Corporate Action Shield: ${swingProfile.corporateActionEvent?.purpose || 'Ex-date'} on ${swingProfile.corporateActionEvent?.exDate}`;
  } else if (action === 'WAIT') {
    vetoReason = vetoReason || 'Conviction below 62% threshold';
  } else if (!histEdge.provenEdge) {
    vetoReason = `Historical Chart Veto (${histEdge.archetype}): Past setup win rate ${histEdge.winRate}% (PF ${histEdge.profitFactor}x over ${histEdge.samples} setups) below 50% / 1.15x threshold`;
  } else if (!isCncSwingEligible && sessionInfo.isMiddayChop && (histEdge.archetype !== 'MEAN_REVERTER' || histEdge.profitFactor < 1.60)) {
    vetoReason = `Midday Chop Shield (11:15–13:30 IST): Trend breakouts paused during thin liquidity; only A+ Mean-Reversion (PF ≥ 1.6x) or CNC Swing allowed`;
  } else if (!isCncSwingEligible && sessionInfo.nseSessionPhase === 'CLOSING_CUTOFF') {
    vetoReason = `Closing Cutoff (14:45–15:20 IST): No new intraday MIS entries near square-off`;
  } else if (nseEdge.available && action === 'BUY' && (nseEdge.isTopLoser || nseEdge.stockPct <= -1.5)) {
    vetoReason = `NSE MCP Flow Veto: Stock is down ${nseEdge.stockPct}% on official NSE tape`;
  } else if (nseEdge.available && action === 'SELL' && (nseEdge.isTopGainer || nseEdge.stockPct >= 1.5)) {
    vetoReason = `NSE MCP Flow Veto: Stock is up +${nseEdge.stockPct}% on official NSE tape`;
  } else if (debate.verdict === 'VETO') {
    vetoReason = `Bull/Bear Debate VETO: ${debate.rationale}`;
  } else if (!isCncSwingEligible && (!sized.ok || finalQty < 1 || finalNetRR < 1.20)) {
    vetoReason = `Risk/Fee Veto: ${sized.reason || 'Net R:R ' + finalNetRR + ' below 1.20 hurdle'}`;
  } else {
    qualifiesForAutoExec = true;
  }

  // 6-Pillar Composite Rank Score (0-100) including Dual-Archetype Historical Edge, CNC Swing & Official NSE MCP Flow
  const smcScore = (smc && typeof smc.confluenceScore === 'number') ? smc.confluenceScore : 50;
  const smcDirectional = finalSide === 'BUY' ? smcScore : (100 - smcScore);
  const debateEdge = clamp(50 + ((debate.bullScore || 50) - (debate.bearScore || 50)) * (finalSide === 'BUY' ? 0.5 : -0.5), 10, 95);
  const nseFlowDirectional = nseEdge.available
    ? clamp(50 + (finalSide === 'BUY' ? nseEdge.scoreDelta * 2 : -nseEdge.scoreDelta * 2), 10, 98)
    : 50;
  const histScore = clamp(Math.round(histEdge.winRate * 0.65 + Math.min(3.0, histEdge.profitFactor) * 12), 20, 98);
  const rrBonus = clamp(execNetRR * 35, 0, 100);
  const multiYearBonus = (multiYearSwingEdge && multiYearSwingEdge.provenEdge) ? 6 : 0;
  const compositeRankScore = clamp(Math.round(
    confidence * 0.34 +
    histScore * 0.18 +
    smcDirectional * 0.14 +
    debateEdge * 0.14 +
    nseFlowDirectional * 0.12 +
    rrBonus * 0.08 +
    multiYearBonus
  ), 0, 100);

  return {
    assetType: 'STOCK',
    commodityId: stock.id,
    symbol: stock.symbol,
    name: stock.name,
    sector: stock.sector,
    price,
    dayChgPct,
    action,
    confidence,
    compositeRankScore,
    archetype: histEdge.archetype,
    bucket: assignedBucket,
    regime: gate.regime,
    sessionWindow: sessionInfo.nseSessionPhase,
    paritySignal: nseEdge.available ? nseEdge.bias : (geoStock?.impact || 'NEUTRAL'),
    nseMcp: nseEdge,
    swingProfile: swingProfile || null,
    multiYearSwingEdge: multiYearSwingEdge || null,
    corporateActionBlocked: Boolean(swingProfile && swingProfile.corporateActionBlocked),
    corporateActionReason: (swingProfile && swingProfile.corporateActionReason) || null,
    historicalEdge: histEdge,
    htfBias: htfTrend.bias,
    smcState: smc?.structure?.state || 'RANGING',
    debateVerdict: debate.verdict,
    debateRationale: debate.rationale,
    riskStance: stance.stance,
    effectiveBudget,
    qualifiesForAutoExec,
    vetoReason,
    executionPlan: {
      tradingsymbol: stock.symbol,
      exchange: 'NSE',
      segment: 'equity',
      product: assignedProduct,
      bucket: assignedBucket,
      side: action === 'WAIT' ? finalSide : action,
      qty: execQty,
      lotMultiplier: 1,
      entryPrice: finalLevels.entry,
      currentHigh: highs[highs.length - 1],
      currentLow: lows[lows.length - 1],
      stopLoss: execSl,
      target1: execT1,
      target2: finalLevels.t2,
      marginRequired: execMargin,
      plannedLoss: isCncSwingEligible ? +(execQty * (price - execSl)).toFixed(2) : plannedLoss,
      stopFees: isCncSwingEligible ? 0 : +(actualStopFees || perShareFee).toFixed(2),
      netRR: execNetRR
    }
  };
}

/**
 * Ranks all evaluated NSE stocks and returns the Top Best Stocks of the Day for ₹15,000 capital.
 */
function rankBestStocksOfDay(stockEvaluations = [], topN = 5) {
  const sorted = [...stockEvaluations].sort((a, b) => {
    if (a.qualifiesForAutoExec && !b.qualifiesForAutoExec) return -1;
    if (!a.qualifiesForAutoExec && b.qualifiesForAutoExec) return 1;
    if (a.action !== 'WAIT' && b.action === 'WAIT') return -1;
    if (a.action === 'WAIT' && b.action !== 'WAIT') return 1;
    return (b.compositeRankScore || 0) - (a.compositeRankScore || 0) || (b.confidence || 0) - (a.confidence || 0);
  });
  return sorted.slice(0, topN).map((s, idx) => ({
    rank: idx + 1,
    ...s
  }));
}

/**
 * Evaluates a single commodity's 5m candle series through the full institutional pipeline
 * and returns the signal, Bull/Bear debate verdict, and ₹15K-compliant execution plan.
 */
function evaluateCommodityForAutoPilot({
  asset,
  rawCandles = [],
  usdInr = 93.95,
  newsScore = 50,
  recentLessons = [],
  geoIntel = null,
  accountProfile = { capital: 15000, maxRiskPerTrade: 150, dailyLossLimit: 375 },
  todayTrades = [],
  nowDate = new Date()
}) {
  if (!asset || !Array.isArray(rawCandles) || rawCandles.length < 25) {
    return {
      assetType: 'COMMODITY',
      commodityId: asset?.id || 'unknown',
      name: asset?.name || 'UNKNOWN',
      action: 'WAIT',
      confidence: 0,
      qualifiesForAutoExec: false,
      vetoReason: 'Insufficient 5m candle history (<25 bars)'
    };
  }

  const conv = asset.alreadyInr ? (p) => p : (p) => asset.conv(p, usdInr);
  const opens = rawCandles.map(r => conv(Number(r.open || r.close)));
  const highs = rawCandles.map(r => conv(Number(r.high || r.close)));
  const lows = rawCandles.map(r => conv(Number(r.low || r.close)));
  const closes = rawCandles.map(r => conv(Number(r.close)));
  const intlCloses = rawCandles.map(r => Number(r.close));
  const vols = rawCandles.map(r => Number(r.volume || 0));
  const timestamps = rawCandles.map(r => Number(r.time || 0));

  const price = closes[closes.length - 1];
  const intlPrice = intlCloses[intlCloses.length - 1];
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const bb = calcBB(closes, 20, 2);
  const atr = calcATR(closes, highs, lows, 14);
  const stoch = calcStoch(closes, highs, lows, 14);
  const adx = signalEngine.calcADX(closes, highs, lows, 14);
  const obv = signalEngine.calcOBV(closes, vols);
  const vwap = signalEngine.calcSessionVWAP(closes, highs, lows, vols, 30);

  const last5 = closes.slice(-5), prev5 = closes.slice(-10, -5);
  const lA = last5.reduce((a, b) => a + b, 0) / (last5.length || 1);
  const pA = prev5.reduce((a, b) => a + b, 0) / (prev5.length || 1);
  const mom = pA ? ((lA - pA) / pA) * 100 : 0;
  const structTrend = mom > 0.25 ? 'BUY' : mom < -0.25 ? 'SELL' : 'NEUTRAL';

  const sigs = {
    rsi: rsi < 35 ? 'BUY' : rsi > 65 ? 'SELL' : 'NEUTRAL',
    macd_hist: macd.hist > 0 ? 'BUY' : 'SELL',
    bb: price < bb.lower ? 'BUY' : price > bb.upper ? 'SELL' : 'NEUTRAL',
    ema_cross: ema9 > ema21 && ema21 > ema50 ? 'BUY' : ema9 < ema21 && ema21 < ema50 ? 'SELL' : (ema9 > ema21 ? 'BUY' : 'SELL'),
    ema9: price > ema9 ? 'BUY' : 'SELL',
    ema21: price > ema21 ? 'BUY' : 'SELL',
    ema50: price > ema50 ? 'BUY' : 'SELL',
    ema200: price > ema200 ? 'BUY' : 'SELL',
    stoch: stoch.k < 25 ? 'BUY' : stoch.k > 75 ? 'SELL' : 'NEUTRAL',
    adx: adx.plus > adx.minus ? 'BUY' : 'SELL',
    cci: price > bb.mid ? 'BUY' : 'SELL',
    willr: stoch.k < 20 ? 'BUY' : stoch.k > 80 ? 'SELL' : 'NEUTRAL',
    obv: obv.trend,
    vwap: price > vwap ? 'BUY' : 'SELL',
    ich: price > ema21 && ema9 > ema21 ? 'BUY' : price < ema21 && ema9 < ema21 ? 'SELL' : 'NEUTRAL',
    mfi: rsi < 30 ? 'BUY' : rsi > 70 ? 'SELL' : 'NEUTRAL',
    struct: structTrend
  };

  const smc = patternEngine.scanPatterns({ opens, closes, highs, lows, volumes: vols });
  const htfTrend = signalEngine.computeHTFTrend(closes, highs, lows);
  const openingRangeGuard = signalEngine.checkOpeningRangeGuard(timestamps, closes, highs, lows, atr);
  const isOverextended = atr > 0 ? Math.abs(price - ema21) > 1.8 * atr : false;
  const dualFeed = signalEngine.computeDualFeedParityAndOrderflow({
    commodityId: asset.id,
    intlCloses,
    mcxCloses: closes,
    intlPrice,
    mcxPrice: price,
    fairValuePrice: price,
    timestamps
  });

  // Determine Smart Margin Route & Contract Spec for user capital (default ₹15,000)
  const route = riskEngine.getTenKExecutionRoute({
    commodityId: asset.id,
    capital: accountProfile.capital || 15000,
    price,
    riskBudget: accountProfile.maxRiskPerTrade || 150
  });
  const primaryRoute = (route && (route.tenKRoute || route.recommended)) || { symbol: asset.dbSym, exchange: 'MCX', multiplier: 1, segment: 'commodity', product: 'NRML' };
  const resolvedContract = primaryRoute.exchange === 'MCX'
    ? contractResolver.resolveContractExpiry(primaryRoute.symbol, nowDate)
    : { tradingsymbol: primaryRoute.symbol, exchange: primaryRoute.exchange || 'NSE' };

  const preliminarySide = sigs.ema_cross === 'SELL' ? 'SELL' : 'BUY';
  const structLevels = signalEngine.computeStructuralLevels({
    action: preliminarySide,
    price,
    atr,
    slAtrMult: asset.sl_atr,
    t1AtrMult: asset.t1_atr,
    t2AtrMult: asset.t2_atr,
    smc
  });

  // Note: For routed micro/proxy contracts (GOLDPETAL 1g, SILVERBEES, ONGC, HINDCOPPER), scale levels FIRST
  let scaleFactor = 1.0;
  if (primaryRoute.symbol === 'GOLDPETAL' && price > 50000) {
    scaleFactor = 0.1; // 1g vs 10g
  } else if (asset.proxyBasePrice && asset.proxyBasePrice[primaryRoute.symbol] && price > 0) {
    scaleFactor = asset.proxyBasePrice[primaryRoute.symbol] / price;
  }

  const scaledEntry = +(price * scaleFactor).toFixed(2);
  const scaledHigh = +(highs[highs.length - 1] * scaleFactor).toFixed(2);
  const scaledLow = +(lows[lows.length - 1] * scaleFactor).toFixed(2);
  const scaledSl = +(structLevels.sl * scaleFactor).toFixed(2);
  const scaledT1 = +(structLevels.t1 * scaleFactor).toFixed(2);
  const scaledT2 = +(structLevels.t2 * scaleFactor).toFixed(2);

  // Compute realistic ₹15K-sized unit multiplier BEFORE evaluating Zerodha fees & fee-hurdle gate
  const isEqProxy = (primaryRoute.segment === 'equity');
  const routeMult = primaryRoute.multiplier || 1;
  const riskDistPerUnit = Math.max(0.5, Math.abs(scaledEntry - scaledSl));
  const estProxyQty = isEqProxy
    ? Math.max(
        1,
        Math.min(
          Math.floor(((accountProfile.capital || 15000) * 0.45 * 5) / Math.max(1, scaledEntry)),
          Math.floor((accountProfile.maxRiskPerTrade || 150) / riskDistPerUnit)
        )
      )
    : 1;
  const gateLotMult = isEqProxy ? estProxyQty : routeMult;

  const roundTripFee = riskEngine.calculateZerodhaFees({
    side: preliminarySide,
    entry: scaledEntry,
    exit: scaledT1,
    qty: isEqProxy ? estProxyQty : 1,
    lotMultiplier: isEqProxy ? 1 : routeMult,
    segment: primaryRoute.segment || 'commodity'
  }).totalFees;

  const gate = signalEngine.evaluateRegimeAndFeeGate({
    sigs,
    adxObj: adx,
    smc,
    newsScore,
    volConfirmed: true,
    entry: scaledEntry,
    sl: scaledSl,
    t1: scaledT1,
    lotMultiplier: gateLotMult,
    roundTripFee,
    minGrossTargetMultiple: 2.0,
    minNetRR: 1.20,
    threshold: 62,
    htfTrend,
    openingRangeGuard,
    isOverextended,
    dualFeed
  });

  const action = gate.action;
  const confidence = action === 'BUY' ? gate.combined : action === 'SELL' ? (100 - gate.combined) : Math.max(gate.combined, 100 - gate.combined);

  // Run Quantitative Bull vs. Bear Devil's Advocate Debate + Reflection Memory
  const debate = debateEngine.buildQuantitativeDebate({
    symbol: resolvedContract.tradingsymbol,
    commodityId: asset.id,
    action,
    confidence,
    regime: gate.regime,
    htfTrend,
    dualFeed,
    smc,
    geoIntel,
    recentLessons,
    netRR: gate.netRR
  });

  // Evaluate Adaptive Risk Stance (₹150 Balanced -> ₹90 Recovery on 1 loss)
  const stance = debateEngine.evaluateAdaptiveRiskStance({
    trades: todayTrades,
    baseRisk: accountProfile.maxRiskPerTrade || 150,
    dailyLossLimit: accountProfile.dailyLossLimit || 375,
    requestedStance: 'AUTO'
  });

  const effectiveBudget = Math.max(45, Math.round(stance.effectiveRisk * (debate.sizeMultiplier || 1)));

  // Recompute final directional SL/T1/T2 for actual action ('BUY' or 'SELL')
  const finalLevels = signalEngine.computeStructuralLevels({
    action: action === 'SELL' ? 'SELL' : 'BUY',
    price,
    atr,
    slAtrMult: asset.sl_atr,
    t1AtrMult: asset.t1_atr,
    t2AtrMult: asset.t2_atr,
    smc
  });

  const execEntry = +(price * scaleFactor).toFixed(2);
  const execSl = +(finalLevels.sl * scaleFactor).toFixed(2);
  const execT1 = +(finalLevels.t1 * scaleFactor).toFixed(2);
  const execT2 = +(finalLevels.t2 * scaleFactor).toFixed(2);

  const sized = riskEngine.sizeTrade({
    side: action === 'SELL' ? 'SELL' : 'BUY',
    entry: execEntry,
    sl: execSl,
    target: execT1,
    lotMultiplier: primaryRoute.multiplier || 1,
    segment: primaryRoute.segment || 'commodity',
    maxLossTotal: effectiveBudget,
    minNetRR: 1.35
  });

  // Macro Blackout check
  const blackout = macroEvents.checkMacroBlackout(asset.id, nowDate);

  let vetoReason = gate.vetoReason || null;
  let qualifiesForAutoExec = false;
  const sizedQty = Number(sized.qty ?? sized.lots ?? 0);

  if (action === 'WAIT') {
    vetoReason = vetoReason || 'Signal conviction below 65% threshold';
  } else if (blackout && blackout.isBlackout) {
    vetoReason = `Macro Blackout: ${blackout.warningText}`;
  } else if (debate.verdict === 'VETO') {
    vetoReason = `Bull/Bear Debate VETO: ${debate.rationale}`;
  } else if (!sized.ok || sizedQty < 1) {
    vetoReason = `Risk Sizing Veto: ${sized.reason || 'Exceeds ₹' + effectiveBudget + ' budget'}`;
  } else {
    qualifiesForAutoExec = true;
  }

  return {
    assetType: 'COMMODITY',
    commodityId: asset.id,
    name: asset.name,
    action,
    confidence,
    regime: gate.regime,
    sessionWindow: dualFeed.sessionWindow,
    paritySignal: dualFeed.paritySignal,
    htfBias: htfTrend.bias,
    debateVerdict: debate.verdict,
    debateRationale: debate.rationale,
    riskStance: stance.stance,
    effectiveBudget,
    qualifiesForAutoExec,
    vetoReason,
    executionPlan: {
      tradingsymbol: resolvedContract.tradingsymbol,
      exchange: resolvedContract.exchange || primaryRoute.exchange || 'MCX',
      segment: primaryRoute.segment || 'commodity',
      product: primaryRoute.product || 'NRML',
      side: action,
      qty: sized.ok ? sizedQty : 1,
      lotMultiplier: primaryRoute.multiplier || 1,
      entryPrice: execEntry,
      currentHigh: scaledHigh,
      currentLow: scaledLow,
      stopLoss: execSl,
      target1: execT1,
      target2: execT2,
      plannedLoss: sized.ok ? (sized.totalPlannedLoss ?? sized.totalStopLoss) : null,
      stopFees: sized.ok ? sized.stopFees : roundTripFee,
      netRR: sized.ok ? sized.netRR : gate.netRR
    }
  };
}

/**
 * Realistic Paper Execution Slippage Model (default 4 bps = 0.04% per side on market orders).
 * Ensures Paper Mode scorecard P&L mirrors real Zerodha market fills before live graduation.
 */
function applyPaperSlippage(price, side = 'BUY', isEntry = true, bps = 4) {
  const px = Number(price || 0);
  if (!(px > 0) || !(bps > 0)) return px;
  const slip = px * (bps / 10000);
  const isBuy = String(side).toUpperCase() === 'BUY';
  // Adverse fill: BUY entry fills higher (+slip), BUY exit fills lower (-slip); opposite for SELL
  const delta = isEntry ? (isBuy ? slip : -slip) : (isBuy ? -slip : slip);
  return +(px + delta).toFixed(2);
}

/**
 * Manages all currently OPEN paper trades in SQLite:
 * 1. 3-Stage Progressive Profit Ratchet (+0.70R BE, +1.15R +0.55R, +1.50R +1.00R).
 * 2. Trend-Runner Mode (`RATCHET_3_RUNNER`): On Brain-aligned strong trend regimes, reaching T1
 *    locks SL at 90% of T1 profit and extends target to T2 (1.85× T1) with trailing SL instead of capping winners.
 * 3. Auto-closes on SL / Target / EOD Square-Off (with optional realistic 0.04% slippage) & writes `trade_lessons`.
 */
function manageOpenPaperPositions({ db, latestPrices = {}, sessionInfo = null, brainState = null, applySlippage = false }) {
  if (!db) return { checked: 0, breakevenArmed: [], closed: [] };
  let openTrades = [];
  try {
    openTrades = db.prepare(`SELECT * FROM paper_trades WHERE status = 'OPEN' ORDER BY id ASC`).all();
  } catch (_) {
    return { checked: 0, breakevenArmed: [], closed: [] };
  }

  const breakevenArmed = [];
  const closed = [];

  for (const t of openTrades) {
    const sym = String(t.symbol || '').toUpperCase();
    const baseSym = sym.replace(/\d{2}[A-Z]{3}FUT$/, '');
    const pxObj = latestPrices[sym] || latestPrices[baseSym];
    if (!pxObj || !Number.isFinite(pxObj.price) || pxObj.price <= 0) continue;
    // Never evaluate an open trade against a stale SQLite fallback candle from an older day
    if (pxObj.isLive === false) continue;

    const curPrice = pxObj.price;
    const candleHigh = Number.isFinite(pxObj.high) ? pxObj.high : curPrice;
    const candleLow = Number.isFinite(pxObj.low) ? pxObj.low : curPrice;

    const spec = riskEngine.getContractSpec(sym);
    const lotMult = Number(t.lot_multiplier) || spec.multiplier || 1;
    const segment = spec.segment || 'commodity';
    const entry = Number(t.entry_price);
    let sl = Number(t.stop_loss);
    let tgt = Number(t.target || 0);
    const qty = Number(t.qty || 1);
    const totalFees = Number(t.brokerage || 40) + Number(t.stt_gst || 5);
    const feePerUnit = totalFees / Math.max(1, lotMult * qty);
    const curReason = String(t.exit_reason || '');
    // All-Weather multi-day CNC Delivery positions (Washout & GOLDBEES) are managed strictly on daily close/open rules
    if (curReason.includes('CNC_WASHOUT') || curReason.includes('CNC_GOLD')) continue;
    const isAlreadyBe = curReason.includes('BE_ARMED') || curReason.includes('RUNNER');
    const isRatchet1 = curReason.includes('RATCHET_1');
    const isRatchet2 = curReason.includes('RATCHET_2');
    const isRunner = curReason.includes('RATCHET_3_RUNNER');

    const brainRegime = String(brainState?.regime?.regime || '');
    const isTrendAligned =
      (t.side === 'BUY' && brainRegime === 'BULL_TREND') ||
      (t.side === 'SELL' && (brainRegime === 'BEAR_DRIFT' || brainRegime === 'HIGH_VOL_PANIC'));

    // Derive initial 1R distance (if already ratcheted, derive from target distance / 1.44)
    const initRisk = (!isAlreadyBe && Math.abs(entry - sl) > 0)
      ? Math.abs(entry - sl)
      : (tgt > 0 ? (Math.abs(tgt - entry) / 1.44) : Math.abs(entry * 0.005));

    // 1. Progressive Profit Ratchet (+0.70R BE -> +1.15R +0.55R -> +1.50R +1.00R -> Continuous Runner Trail)
    if (initRisk > 0) {
      const favMove = t.side === 'BUY' ? (candleHigh - entry) : (entry - candleLow);
      const favR = favMove / initRisk;

      let nextSl = null;
      let nextTag = null;

      if (isRunner && tgt > 0) {
        // Continuous trailing stop behind price while riding from T1 -> T2
        const trailSpan = Math.abs(tgt - entry) * 0.25;
        const candidateSl = t.side === 'BUY' ? +(candleHigh - trailSpan).toFixed(2) : +(candleLow + trailSpan).toFixed(2);
        if ((t.side === 'BUY' && candidateSl > sl) || (t.side === 'SELL' && candidateSl < sl)) {
          nextSl = candidateSl;
          nextTag = 'RATCHET_3_RUNNER';
        }
      } else if (favR >= 1.50 && !isRatchet2) {
        nextSl = t.side === 'BUY' ? +(entry + initRisk * 1.00).toFixed(2) : +(entry - initRisk * 1.00).toFixed(2);
        nextTag = 'RATCHET_2_BE_ARMED';
      } else if (favR >= 1.15 && !isRatchet1 && !isRatchet2) {
        nextSl = t.side === 'BUY' ? +(entry + initRisk * 0.55).toFixed(2) : +(entry - initRisk * 0.55).toFixed(2);
        nextTag = 'RATCHET_1_BE_ARMED';
      } else if (favR >= 0.70 && !isAlreadyBe) {
        nextSl = t.side === 'BUY' ? +(entry + feePerUnit).toFixed(2) : +(entry - feePerUnit).toFixed(2);
        nextTag = 'BE_ARMED';
      }

      if (nextSl !== null && ((t.side === 'BUY' && nextSl > sl) || (t.side === 'SELL' && nextSl < sl))) {
        try {
          db.prepare(`UPDATE paper_trades SET stop_loss = ?, exit_reason = ? WHERE id = ?`).run(nextSl, nextTag, t.id);
          sl = nextSl;
          breakevenArmed.push({ tradeId: t.id, symbol: sym, newSl: nextSl, stage: nextTag });
        } catch (_) {}
      }
    }

    // 2. Check Stop Loss (or Ratcheted Profit Lock), Target 1 (with Trend-Runner Extension), or EOD Square-Off
    const isNowProtected = isAlreadyBe || breakevenArmed.some(b => b.tradeId === t.id);
    const isNowProfitLocked = isRatchet1 || isRatchet2 || isRunner || breakevenArmed.some(b => b.tradeId === t.id && String(b.stage || '').includes('RATCHET'));
    let exitReason = null;
    let fillPrice = curPrice;
    if (t.side === 'BUY') {
      if (sl > 0 && candleLow <= sl) {
        exitReason = isNowProfitLocked ? 'AUTO_PROFIT_LOCK' : (isNowProtected ? 'AUTO_BREAKEVEN_SL' : 'AUTO_SL');
        fillPrice = sl;
      } else if (tgt > 0 && candleHigh >= tgt) {
        if (isTrendAligned && !isRunner) {
          // Trend-Runner Mode: Lock 90% of T1 profit & extend target to T2 (1.85× T1) instead of capping winner!
          const t1Dist = Math.abs(tgt - entry);
          const runnerSl = +(entry + t1Dist * 0.90).toFixed(2);
          const runnerT2 = +(entry + t1Dist * 1.85).toFixed(2);
          try {
            db.prepare(`UPDATE paper_trades SET stop_loss = ?, target = ?, exit_reason = 'RATCHET_3_RUNNER' WHERE id = ?`).run(runnerSl, runnerT2, t.id);
            sl = runnerSl;
            tgt = runnerT2;
            breakevenArmed.push({ tradeId: t.id, symbol: sym, newSl: runnerSl, newTarget: runnerT2, stage: 'RATCHET_3_RUNNER' });
          } catch (_) {}
        } else {
          exitReason = 'AUTO_TARGET';
          fillPrice = tgt;
        }
      }
    } else if (t.side === 'SELL') {
      if (sl > 0 && candleHigh >= sl) {
        exitReason = isNowProfitLocked ? 'AUTO_PROFIT_LOCK' : (isNowProtected ? 'AUTO_BREAKEVEN_SL' : 'AUTO_SL');
        fillPrice = sl;
      } else if (tgt > 0 && candleLow <= tgt) {
        if (isTrendAligned && !isRunner) {
          const t1Dist = Math.abs(entry - tgt);
          const runnerSl = +(entry - t1Dist * 0.90).toFixed(2);
          const runnerT2 = +(entry - t1Dist * 1.85).toFixed(2);
          try {
            db.prepare(`UPDATE paper_trades SET stop_loss = ?, target = ?, exit_reason = 'RATCHET_3_RUNNER' WHERE id = ?`).run(runnerSl, runnerT2, t.id);
            sl = runnerSl;
            tgt = runnerT2;
            breakevenArmed.push({ tradeId: t.id, symbol: sym, newSl: runnerSl, newTarget: runnerT2, stage: 'RATCHET_3_RUNNER' });
          } catch (_) {}
        } else {
          exitReason = 'AUTO_TARGET';
          fillPrice = tgt;
        }
      }
    }

    if (!exitReason && sessionInfo) {
      const isEq = segment === 'equity';
      const isCncSwing = curReason.includes('CNC_SWING');
      // Exempt Bucket 1 (CNC_SWING multi-day delivery) from 15:20 IST intraday square-off
      if ((isEq && !isCncSwing && sessionInfo.isNseEodSquareOff) || (!isEq && sessionInfo.isMcxEodSquareOff)) {
        exitReason = 'AUTO_EOD_SQUARE_OFF';
        fillPrice = curPrice;
      }
    }

    if (exitReason) {
      // Apply realistic 0.04% market slippage on stop & market exits (resting limit AUTO_TARGET fills cleanly)
      if (applySlippage && exitReason !== 'AUTO_TARGET') {
        fillPrice = applyPaperSlippage(fillPrice, t.side, false, 4);
      }
      const actualFees = riskEngine.calculateZerodhaFees({
        segment,
        buyPrice: t.side === 'BUY' ? entry : fillPrice,
        sellPrice: t.side === 'BUY' ? fillPrice : entry,
        qty,
        lotMultiplier: lotMult
      });
      const grossPnl = t.side === 'BUY'
        ? (fillPrice - entry) * qty * lotMult
        : (entry - fillPrice) * qty * lotMult;
      const netPnl = Math.round((grossPnl - actualFees.totalFees) * 100) / 100;
      const status = netPnl > 0 ? 'WIN' : 'LOSS';

      try {
        db.prepare(`
          UPDATE paper_trades
          SET exit_price = ?, exit_time = ?, net_pnl = ?, brokerage = ?, stt_gst = ?, status = ?, exit_reason = ?
          WHERE id = ?
        `).run(
          fillPrice,
          new Date().toISOString(),
          netPnl,
          actualFees.brokerage,
          Math.round((actualFees.totalFees - actualFees.brokerage) * 100) / 100,
          status,
          exitReason,
          t.id
        );

        // Extract and persist Post-Trade Reflection Lesson into `trade_lessons`
        const lessonObj = debateEngine.extractLessonFromTrade({
          symbol: sym,
          side: t.side,
          netPnl,
          exitReason,
          regime: pxObj.regime || 'TRENDING',
          sessionWindow: pxObj.sessionWindow || 'ASIA_MORNING',
          paritySignal: pxObj.paritySignal || 'NEUTRAL'
        });
        db.prepare(`
          INSERT INTO trade_lessons (symbol, side, regime, session_window, parity_signal, exit_reason, net_pnl, lesson)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          lessonObj.symbol,
          lessonObj.side,
          lessonObj.regime,
          lessonObj.sessionWindow,
          lessonObj.paritySignal,
          lessonObj.exitReason,
          lessonObj.netPnl,
          lessonObj.lesson
        );

        closed.push({
          tradeId: t.id,
          symbol: sym,
          side: t.side,
          exitPrice: fillPrice,
          exitReason,
          netPnl,
          status,
          lesson: lessonObj.lesson
        });
      } catch (_) {}
    }
  }

  return { checked: openTrades.length, breakevenArmed, closed };
}

/**
 * Dynamically merges the core 12 Nifty-50 watchlist with all Proven 2.5-Year Nifty-50
 * CNC Swing Champions so Auto-Pilot actively monitors & trades every proven Champion.
 */
function buildDynamicStockUniverse(provenChampions = []) {
  const existing = new Set(AUTO_PILOT_STOCKS.map(s => s.symbol));
  const merged = [...AUTO_PILOT_STOCKS];
  for (const rawSym of (provenChampions || [])) {
    const sym = String(rawSym || '').toUpperCase().trim();
    if (!sym || existing.has(sym)) continue;
    existing.add(sym);
    merged.push({
      id: `nse_${sym.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      symbol: sym,
      ticker: `${sym}.NS`,
      name: sym,
      sector: 'Nifty-50 Champion',
      sl_atr: 1.8,
      t1_atr: 2.8,
      t2_atr: 5.0
    });
  }
  return merged;
}

module.exports = {
  AUTO_PILOT_STOCKS,
  AUTO_PILOT_ASSETS,
  buildDynamicStockUniverse,
  applyPaperSlippage,
  getMarketSessionWindow,
  computeHistoricalSetupEdge,
  evaluateStockForAutoPilot,
  rankBestStocksOfDay,
  evaluateCommodityForAutoPilot,
  manageOpenPaperPositions
};
