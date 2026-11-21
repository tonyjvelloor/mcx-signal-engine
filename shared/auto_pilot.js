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

const AUTO_PILOT_STOCKS = [
  { id: 'reliance',   symbol: 'RELIANCE',   ticker: 'RELIANCE.NS',   name: 'Reliance Ind',   sector: 'Energy/Telecom', sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'tcs',        symbol: 'TCS',        ticker: 'TCS.NS',        name: 'TCS',            sector: 'IT Services',    sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'infy',       symbol: 'INFY',       ticker: 'INFY.NS',       name: 'Infosys',        sector: 'IT Services',    sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'hdfcbank',   symbol: 'HDFCBANK',   ticker: 'HDFCBANK.NS',   name: 'HDFC Bank',      sector: 'Banking',        sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'icicibank',  symbol: 'ICICIBANK',  ticker: 'ICICIBANK.NS',  name: 'ICICI Bank',     sector: 'Banking',        sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'bhartiartl', symbol: 'BHARTIARTL', ticker: 'BHARTIARTL.NS', name: 'Bharti Airtel',  sector: 'Telecom',        sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'sbin',       symbol: 'SBIN',       ticker: 'SBIN.NS',       name: 'State Bank',     sector: 'PSU Banking',    sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'itc',        symbol: 'ITC',        ticker: 'ITC.NS',        name: 'ITC Ltd',        sector: 'FMCG',           sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'lt',         symbol: 'LT',         ticker: 'LT.NS',         name: 'Larsen & Toubro',sector: 'Infrastructure', sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'kotakbank',  symbol: 'KOTAKBANK',  ticker: 'KOTAKBANK.NS',  name: 'Kotak Bank',     sector: 'Banking',        sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'axisbank',   symbol: 'AXISBANK',   ticker: 'AXISBANK.NS',   name: 'Axis Bank',      sector: 'Banking',        sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 },
  { id: 'maruti',     symbol: 'MARUTI',     ticker: 'MARUTI.NS',     name: 'Maruti Suzuki',  sector: 'Auto',           sl_atr: 1.8, t1_atr: 3.2, t2_atr: 5.0 }
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

  return {
    istDate: kt.dateStr,
    istTime: `${String(kt.hour).padStart(2, '0')}:${String(kt.minute).padStart(2, '0')}`,
    dayOfWeek: kt.dayOfWeek,
    isWeekday,
    isNseDay,
    holidayReason,
    isMcxHours,
    isNseHours,
    isMcxEodSquareOff,
    isNseEodSquareOff,
    isAnySessionOpen: isMcxHours || isNseHours
  };
}

/**
 * Evaluates an NSE Large-Cap Stock through the 4-Pillar Multi-Factor Pipeline for a ₹15,000 Budget
 * (MIS 5x intraday leverage, max 45% capital margin per trade = ₹6,750, max ₹150 net risk at SL).
 */
function evaluateStockForAutoPilot({
  stock,
  rawCandles = [],
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

  const price = +(closes[closes.length - 1]).toFixed(2);
  const prevClose = closes[0] || price;
  const dayChgPct = prevClose > 0 ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : 0;

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

  // Geopolitical & Macro Sector Catalyst Score
  let newsScore = 50;
  const geoStock = geoIntel?.stockImpacts?.[stock.symbol];
  if (geoStock && geoStock.impact) {
    const imp = String(geoStock.impact).toUpperCase();
    if (imp.includes('BULLISH')) newsScore = 70;
    else if (imp.includes('BEARISH')) newsScore = 30;
  }

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
    minGrossTargetMultiple: 3.0,
    minNetRR: 1.35,
    threshold: 62,
    htfTrend,
    openingRangeGuard,
    isOverextended,
    dualFeed: { sessionWindow: 'ASIA_MORNING', paritySignal: 'NEUTRAL', microstructureScore: 55 }
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
  const effectiveBudget = Math.max(50, Math.round(stance.effectiveRisk * (debate.sizeMultiplier || 1)));

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
    minNetRR: 1.35
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

  let vetoReason = gate.vetoReason || null;
  let qualifiesForAutoExec = false;
  if (action === 'WAIT') {
    vetoReason = vetoReason || 'Conviction below 62% threshold';
  } else if (debate.verdict === 'VETO') {
    vetoReason = `Bull/Bear Debate VETO: ${debate.rationale}`;
  } else if (!sized.ok || finalQty < 1 || finalNetRR < 1.35) {
    vetoReason = `Risk/Fee Veto: ${sized.reason || 'Net R:R ' + finalNetRR + ' below 1.35 hurdle'}`;
  } else {
    qualifiesForAutoExec = true;
  }

  // 4-Pillar Composite Rank Score (0-100) to rank the Best Stocks of the Day
  const smcScore = (smc && typeof smc.confluenceScore === 'number') ? smc.confluenceScore : 50;
  const smcDirectional = finalSide === 'BUY' ? smcScore : (100 - smcScore);
  const debateEdge = clamp(50 + ((debate.bullScore || 50) - (debate.bearScore || 50)) * (finalSide === 'BUY' ? 0.5 : -0.5), 10, 95);
  const rrBonus = clamp(finalNetRR * 35, 0, 100);
  const compositeRankScore = Math.round(
    confidence * 0.50 +
    smcDirectional * 0.20 +
    debateEdge * 0.20 +
    rrBonus * 0.10
  );

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
    regime: gate.regime,
    sessionWindow: 'NSE_INTRADAY',
    paritySignal: geoStock?.impact || 'NEUTRAL',
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
      product: 'MIS',
      side: action === 'WAIT' ? finalSide : action,
      qty: Math.max(1, finalQty),
      lotMultiplier: 1,
      entryPrice: finalLevels.entry,
      currentHigh: highs[highs.length - 1],
      currentLow: lows[lows.length - 1],
      stopLoss: finalLevels.sl,
      target1: finalLevels.t1,
      target2: finalLevels.t2,
      marginRequired: finalQty >= 1 ? marginRequired : +(price / misLeverage).toFixed(2),
      plannedLoss,
      stopFees: +(actualStopFees || perShareFee).toFixed(2),
      netRR: finalNetRR
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

  const roundTripFee = riskEngine.calculateZerodhaFees({
    side: preliminarySide,
    entry: structLevels.entry,
    exit: structLevels.t1,
    quantity: 1,
    lotMultiplier: primaryRoute.multiplier || 1,
    segment: primaryRoute.segment || 'commodity'
  }).total;

  // Note: For routed micro/proxy contracts (GOLDPETAL 1g, SILVERBEES, ONGC, HINDCOPPER), scale levels proportionally
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

  const gate = signalEngine.evaluateRegimeAndFeeGate({
    sigs,
    adxObj: adx,
    smc,
    newsScore,
    volConfirmed: true,
    entry: scaledEntry,
    sl: scaledSl,
    t1: scaledT1,
    lotMultiplier: primaryRoute.multiplier || 1,
    roundTripFee,
    minGrossTargetMultiple: 3.5,
    minNetRR: 1.35,
    threshold: 65,
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
 * Manages all currently OPEN paper trades in SQLite:
 * 1. Arms +1R Fee-Covered Breakeven Stop when price moves +1R in favor.
 * 2. Auto-closes when price hits SL or Target (or EOD Square-Off window).
 * 3. Writes Post-Trade Reflection Lesson into `trade_lessons` on close.
 */
function manageOpenPaperPositions({ db, latestPrices = {}, sessionInfo = null }) {
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

    const curPrice = pxObj.price;
    const candleHigh = Number.isFinite(pxObj.high) ? pxObj.high : curPrice;
    const candleLow = Number.isFinite(pxObj.low) ? pxObj.low : curPrice;

    const spec = riskEngine.getContractSpec(sym);
    const lotMult = Number(t.lot_multiplier) || spec.multiplier || 1;
    const segment = spec.segment || 'commodity';
    const entry = Number(t.entry_price);
    let sl = Number(t.stop_loss);
    const tgt = Number(t.target || 0);
    const qty = Number(t.qty || 1);
    const totalFees = Number(t.brokerage || 40) + Number(t.stt_gst || 5);
    const feePerUnit = totalFees / Math.max(1, lotMult * qty);
    const isAlreadyBe = String(t.exit_reason || '').includes('BE_ARMED');

    // 1. Check +1R Fee-Covered Breakeven Trailing Stop
    const initRisk = Math.abs(entry - sl);
    if (!isAlreadyBe && initRisk > 0) {
      if (t.side === 'BUY' && candleHigh >= entry + initRisk && sl < entry) {
        const newSl = +(entry + feePerUnit).toFixed(2);
        try {
          db.prepare(`UPDATE paper_trades SET stop_loss = ?, exit_reason = 'BE_ARMED' WHERE id = ?`).run(newSl, t.id);
          sl = newSl;
          breakevenArmed.push({ tradeId: t.id, symbol: sym, newSl });
        } catch (_) {}
      } else if (t.side === 'SELL' && candleLow <= entry - initRisk && sl > entry) {
        const newSl = +(entry - feePerUnit).toFixed(2);
        try {
          db.prepare(`UPDATE paper_trades SET stop_loss = ?, exit_reason = 'BE_ARMED' WHERE id = ?`).run(newSl, t.id);
          sl = newSl;
          breakevenArmed.push({ tradeId: t.id, symbol: sym, newSl });
        } catch (_) {}
      }
    }

    // 2. Check Stop Loss, Target 1, or EOD Square-Off
    let exitReason = null;
    let fillPrice = curPrice;
    if (t.side === 'BUY') {
      if (sl > 0 && candleLow <= sl) {
        exitReason = isAlreadyBe ? 'AUTO_BREAKEVEN_SL' : 'AUTO_SL';
        fillPrice = sl;
      } else if (tgt > 0 && candleHigh >= tgt) {
        exitReason = 'AUTO_TARGET';
        fillPrice = tgt;
      }
    } else if (t.side === 'SELL') {
      if (sl > 0 && candleHigh >= sl) {
        exitReason = isAlreadyBe ? 'AUTO_BREAKEVEN_SL' : 'AUTO_SL';
        fillPrice = sl;
      } else if (tgt > 0 && candleLow <= tgt) {
        exitReason = 'AUTO_TARGET';
        fillPrice = tgt;
      }
    }

    if (!exitReason && sessionInfo) {
      const isEq = segment === 'equity';
      if ((isEq && sessionInfo.isNseEodSquareOff) || (!isEq && sessionInfo.isMcxEodSquareOff)) {
        exitReason = 'AUTO_EOD_SQUARE_OFF';
        fillPrice = curPrice;
      }
    }

    if (exitReason) {
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

module.exports = {
  AUTO_PILOT_STOCKS,
  AUTO_PILOT_ASSETS,
  getMarketSessionWindow,
  evaluateStockForAutoPilot,
  rankBestStocksOfDay,
  evaluateCommodityForAutoPilot,
  manageOpenPaperPositions
};
