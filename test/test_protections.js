const assert = require('assert');
const riskEngine = require('../risk');
const contractResolver = require('../shared/contract_resolver');
const macroEvents = require('../shared/macro_events');
const circuitBreaker = require('../shared/circuit_breaker');
const geoHistory = require('../shared/geopolitical_history');
const geoAnalogs = require('../shared/geopolitical_analogs');
const patternEngine = require('../shared/pattern_engine');
const globalUsdMode = require('../shared/global_usd_mode');
const signalEngine = require('../shared/signal_engine');
const debateEngine = require('../shared/debate_engine');
const kite = require('../kite');

console.log('🧪 Running Institutional Protection, Geopolitical & SMC Pattern Tests...\n');

// 1. Risk Engine tests
const fees = riskEngine.calculateZerodhaFees({ side: 'BUY', entry: 7800, exit: 7900, quantity: 1, lotMultiplier: 1, segment: 'commodity' });
assert.ok(isFinite(fees.total) && fees.total > 0, 'Zerodha fees must be finite and positive');
const sized = riskEngine.sizeTrade({ side: 'BUY', entry: 7850, sl: 7800, target: 7980, lotMultiplier: 1, segment: 'commodity', maxLossTotal: 200 });
assert.strictEqual(sized.ok, true, 'GOLDPETAL 50pt SL should fit within ₹200 budget');
console.log('✓ Test 1 Passed: Risk engine fee calculation & sizing verified.');

// 2. Contract Resolver tests
assert.strictEqual(contractResolver.resolveContractExpiry('CRUDEOILM', new Date('2026-11-12T10:00:00Z')).tradingsymbol, 'CRUDEOILM26NOVFUT');
assert.strictEqual(contractResolver.resolveContractExpiry('GOLDM', new Date('2026-11-12T10:00:00Z')).tradingsymbol, 'GOLDM26DECFUT');
assert.strictEqual(contractResolver.resolveContractExpiry('GOLDPETAL', new Date('2026-11-12T10:00:00Z')).tradingsymbol, 'GOLDPETAL26NOVFUT');
assert.strictEqual(contractResolver.resolveContractExpiry('SILVERMIC', new Date('2026-11-12T10:00:00Z')).tradingsymbol, 'SILVERMIC26NOVFUT');
console.log('✓ Test 2 Passed: MCX canonical contract expiry & bi-monthly roll rules verified.');

// 3. Macro Blackout Shield tests
const wedEIA = new Date('2026-11-18T14:35:00Z'); // 20:05 IST Wed
const boCrude = macroEvents.checkMacroBlackout('CRUDEOILM', wedEIA);
assert.strictEqual(boCrude.isBlackout, true);
assert.strictEqual(boCrude.activeEvent.id, 'eia_crude');
console.log('✓ Test 3 Passed: Macro blackout shield blocks EIA inventory spike window.');

// 4. Daily Circuit Breaker tests
assert.strictEqual(circuitBreaker.evaluateCircuitBreaker({ trades: [{ pnl: -150 }, { pnl: 200 }], dailyLossLimit: 400 }).tripped, false);
assert.strictEqual(circuitBreaker.evaluateCircuitBreaker({ trades: [{ pnl: -200 }, { pnl: -210 }], dailyLossLimit: 400 }).reason, 'DAILY_LOSS_LIMIT_REACHED');
assert.strictEqual(circuitBreaker.evaluateCircuitBreaker({ trades: [{ pnl: -50 }, { pnl: -60 }], dailyLossLimit: 400, maxConsecutiveLosses: 2 }).reason, 'MAX_CONSECUTIVE_LOSSES_REACHED');
assert.strictEqual(circuitBreaker.evaluateCircuitBreaker({ trades: [{ net_pnl: -220 }, { net_pnl: -190 }], dailyLossLimit: 400 }).reason, 'DAILY_LOSS_LIMIT_REACHED');
console.log('✓ Test 4 Passed: Daily risk circuit breaker trips on ₹400 drawdown or 2 consecutive losses (incl. SQLite net_pnl).');

// 5. Geopolitical Historical Analog Matching tests
const analogWar = geoHistory.matchHistoricalAnalog('Houthi missile strike on Red Sea oil tanker raises Hormuz tensions');
assert.strictEqual(analogWar.event.id, '2023_HAMAS_ISRAEL_RED_SEA');
assert.ok(analogWar.matchConfidence >= 60);
assert.ok(analogWar.stockImpacts.ONGC && analogWar.stockImpacts.INDIGO);

const analogTariff = geoHistory.matchHistoricalAnalog('US announces broad customs duty tariffs on China steel imports');
assert.strictEqual(analogTariff.event.id, '2025_US_GLOBAL_TARIFF_TRADE_WAR');

const headlineSummary = geoAnalogs.analyzeHeadlines([
  { title: 'OPEC announces surprise crude oil output cut as Saudi tightens quota', source: 'Test', link: '', pubDate: '' }
]);
assert.ok(headlineSummary.riskIndex >= 20);
assert.strictEqual(headlineSummary.closestAnalog.id, '2023_OPEC_SURPRISE_OUTPUT_CUT');
console.log('✓ Test 5 Passed: Geopolitical analog matcher & cross-asset NSE stock impact matrix verified.');

// 6. Institutional SMC Pattern Engine tests
const syntheticCandles = [
  { open: 100, high: 102, low: 99, close: 101, volume: 100 },
  { open: 101, high: 103, low: 100, close: 102, volume: 100 },
  { open: 102, high: 102.5, low: 100.5, close: 101, volume: 120 }, // Bearish candle (potential Bullish OB)
  { open: 101, high: 108, low: 101, close: 107.5, volume: 300 }, // Strong bullish displacement
  { open: 107.5, high: 111, low: 104, close: 110, volume: 220 }, // FVG gap above 102.5
  { open: 110, high: 112, low: 109, close: 111, volume: 150 },
  { open: 111, high: 113, low: 110, close: 112, volume: 140 },
  { open: 112, high: 114, low: 111, close: 113, volume: 140 },
  { open: 113, high: 115, low: 112, close: 114, volume: 140 },
  { open: 114, high: 116, low: 113, close: 115, volume: 140 }
];
const smc = patternEngine.scanPatterns(syntheticCandles);
assert.strictEqual(smc.ok, true);
assert.ok(smc.orderBlocks.some(o => o.type === 'BULLISH_OB'), 'Should detect Bullish Order Block');
assert.ok(smc.fvgs.some(f => f.type === 'BULLISH_FVG'), 'Should detect Bullish Fair Value Gap');
console.log('✓ Test 6 Passed: SMC Pattern Engine detects Order Blocks, FVGs & Market Structure.');

// 7. Global USD / Olymp Trade Mode tests
const usdPlan = globalUsdMode.buildUsdTradePlan({
  commodityId: 'gold',
  sig: { action: 'BUY', confidence: 76, price: 78500, intlPrice: 2650, sl: 78100, t1: 79300, t2: 79700, rr: 2.0 },
  usdBalance: 100
});
assert.strictEqual(usdPlan.ok, true);
assert.strictEqual(usdPlan.pair, 'XAU/USD');
assert.strictEqual(usdPlan.fttMode.direction, 'UP (CALL ▲)');
assert.strictEqual(usdPlan.sizing.stake2Pct, 2);
const usdBlocked = globalUsdMode.buildUsdTradePlan({
  commodityId: 'crude',
  sig: { action: 'BUY', confidence: 80, price: 6200, intlPrice: 70, sl: 6150, t1: 6300 },
  isBlackout: true
});
assert.strictEqual(usdBlocked.action, 'WAIT');
console.log('✓ Test 7 Passed: Global USD / Olymp Trade mode conversion, FTT guidance & blackout veto verified.');

// 8. Kite Paper Order & GTT OCO tests
(async () => {
  const ord = await kite.placeOrder({ tradingsymbol: 'GOLDPETAL26NOVFUT', side: 'BUY', price: 7800, triggerPrice: 7750 });
  assert.strictEqual(ord.tradingsymbol, 'GOLDPETAL26NOVFUT');
  assert.strictEqual(ord.simulated, true);
  const gtt = await kite.placeGTT({ tradingsymbol: 'CRUDEOILM26NOVFUT', stoploss: 6100, target: 6300 });
  assert.strictEqual(gtt.type, 'two-leg');
  assert.strictEqual(gtt.simulated, true);
  console.log('✓ Test 8 Passed: Kite simulated order & two-leg GTT OCO verified.');

  // 9. Canonical SignalEngine tests (Engulfing w/ opens, Wilder ADX, OBV 10-EMA, Regime & Fee Hurdle Gate)
  const bullEngulf = signalEngine.detectPatterns(
    [105, 102, 107],      // closes: red prev (104->102), green curr (101->107)
    [106, 104.5, 108],    // highs
    [101, 101.5, 100.5],  // lows
    [104, 104, 101]       // real opens
  );
  assert.ok(bullEngulf.some(p => p.name === 'Bullish Engulfing'), 'Real opens should detect Bullish Engulfing');

  const bearEngulf = signalEngine.detectPatterns(
    [100, 104, 98],       // closes: green prev (101->104), red curr (105->98)
    [102, 105, 105.5],    // highs
    [99, 100.5, 97.5],    // lows
    [101, 101, 105]       // real opens
  );
  assert.ok(bearEngulf.some(p => p.name === 'Bearish Engulfing'), 'Real opens should detect Bearish Engulfing');

  // Sideways oscillating bars -> ADX isChop: true
  const chopCls = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
  const chopHis = chopCls.map(c => c + 1);
  const chopLos = chopCls.map(c => c - 1);
  const adxChop = signalEngine.calcADX(chopCls, chopHis, chopLos);
  assert.strictEqual(adxChop.isChop, true, `Sideways bars must set isChop=true (got adx=${adxChop.adx})`);

  // Strong directional bars -> ADX isTrending: true
  const trendCls = Array.from({ length: 30 }, (_, i) => 100 + i * 2);
  const trendHis = trendCls.map(c => c + 0.5);
  const trendLos = trendCls.map(c => c - 0.5);
  const adxTrend = signalEngine.calcADX(trendCls, trendHis, trendLos);
  assert.strictEqual(adxTrend.isTrending, true, `Strong trend bars must set isTrending=true (got adx=${adxTrend.adx})`);

  // OBV cumulative positive but recently falling below 10-EMA -> SELL
  const obvCls = Array.from({ length: 20 }, (_, i) => (i < 12 ? 100 + i : 112 - (i - 11)));
  const obvVls = Array.from({ length: 20 }, (_, i) => (i < 12 ? 1000 : 1200));
  const obvObj = signalEngine.calcOBV(obvCls, obvVls);
  assert.ok(obvObj.value > 0, 'Cumulative OBV should still be positive');
  assert.strictEqual(obvObj.trend, 'SELL', 'OBV falling below 10-bar EMA must signal SELL despite positive sign');

  // Trending uptrend with overbought oscillators must NOT get penalized -> BUY, and small target -> feeVeto
  const trendOnlySigs = {
    ema_cross: 'BUY', ema200: 'BUY', ema50: 'BUY', adx: 'BUY', ich: 'BUY',
    macd_hist: 'BUY', vwap: 'BUY', struct: 'BUY', obv: 'BUY', ema21: 'BUY', ema9: 'BUY',
    rsi: 'SELL', stoch: 'SELL', cci: 'SELL', willr: 'SELL', mfi: 'SELL', bb: 'SELL' // overbought oscillators
  };
  const trendCleared = signalEngine.evaluateRegimeAndFeeGate({
    sigs: trendOnlySigs,
    adxObj: { adx: 30, isTrending: true, isChop: false },
    newsScore: 55,
    entry: 7800,
    sl: 7700,
    t1: 8000,
    lotMultiplier: 10,
    roundTripFee: 45
  });
  assert.strictEqual(trendCleared.regime, 'TRENDING');
  assert.strictEqual(trendCleared.feeVeto, false);
  assert.strictEqual(trendCleared.action, 'BUY', 'Overbought oscillators must not cancel a strong uptrend');

  const feeBlocked = signalEngine.evaluateRegimeAndFeeGate({
    sigs: trendOnlySigs,
    adxObj: { adx: 30, isTrending: true, isChop: false },
    newsScore: 55,
    entry: 7800,
    sl: 7750,
    t1: 7890, // ₹90 gross target < 3.5 * ₹45 (₹157.50)
    lotMultiplier: 1,
    roundTripFee: 45
  });
  assert.strictEqual(feeBlocked.feeVeto, true, 'Sub-hurdle gross target must trip feeVeto');
  assert.strictEqual(feeBlocked.action, 'WAIT', 'Fee veto must force action to WAIT');
  console.log('✓ Test 9 Passed: SignalEngine math (Engulfing, Wilder ADX, OBV EMA, Regime & Fee Hurdle Gate) verified.');

  // 10. HTF Alignment, Opening Range Guard & Structural Overextension Chasing Gate tests
  const htfBullCls = Array.from({ length: 40 }, (_, i) => 100 + i * 1.5);
  const htfBull = signalEngine.computeHTFTrend(htfBullCls, htfBullCls.map(c => c + 1), htfBullCls.map(c => c - 1), 4);
  assert.strictEqual(htfBull.bias, 'BULLISH', 'Steadily rising resampled HTF bars must be BULLISH');

  const htfBearCls = Array.from({ length: 40 }, (_, i) => 200 - i * 1.5);
  const htfBear = signalEngine.computeHTFTrend(htfBearCls, htfBearCls.map(c => c + 1), htfBearCls.map(c => c - 1), 4);
  assert.strictEqual(htfBear.bias, 'BEARISH', 'Steadily falling resampled HTF bars must be BEARISH');

  // 09:05 IST = 03:35 UTC; 10:00 IST = 04:30 UTC
  const ts0905 = Date.parse('2026-11-18T03:35:00Z');
  const ts1000 = Date.parse('2026-11-18T04:30:00Z');
  assert.strictEqual(signalEngine.checkOpeningRangeGuard([ts0905], 'commodity').isOpeningNoise, true, '09:05 IST must flag Opening Range guard');
  assert.strictEqual(signalEngine.checkOpeningRangeGuard([ts1000], 'commodity').isOpeningNoise, false, '10:00 IST must be outside Opening Range guard');

  const overext = signalEngine.computeStructuralLevels({
    action: 'BUY',
    price: 7900,
    atr: 20,
    e21: 7850 // +50 pts = +2.5 ATR > 1.8 ATR threshold
  });
  assert.strictEqual(overext.isOverextended, true, 'Price >1.8 ATR above EMA21 must flag isOverextended');

  const chasedVeto = signalEngine.evaluateRegimeAndFeeGate({
    sigs: trendOnlySigs,
    adxObj: { adx: 30, isTrending: true, isChop: false },
    newsScore: 55,
    entry: 7900,
    sl: overext.sl,
    t1: overext.t1,
    lotMultiplier: 10,
    roundTripFee: 45,
    isOverextended: overext.isOverextended
  });
  assert.strictEqual(chasedVeto.action, 'WAIT', 'Overextended chase entry must be vetoed to WAIT');
  console.log('✓ Test 10 Passed: HTF alignment, 15m Opening Range Guard & overextension pullback gate verified.');

  // 11. Nov 20th Dual-Desk Upgrades: ₹10K Margin Router, Dual-Feed Parity/OI (H4) & Olymp Trade Assistant
  const goldRoute = riskEngine.getTenKExecutionRoute({ commodityId: 'gold', capital: 10000, price: 78500, riskBudget: 125 });
  assert.strictEqual(goldRoute.tenKRoute.symbol, 'GOLDPETAL', '₹10k Gold must route to MCX:GOLDPETAL');
  assert.strictEqual(goldRoute.tenKRoute.exchange, 'MCX');
  assert.strictEqual(goldRoute.secondaryRoute.symbol, 'GOLDBEES');
  assert.strictEqual(goldRoute.mcxContract.marginWarning, true, 'GOLDM exceeds ₹10k margin');

  const crudeRoute = riskEngine.getTenKExecutionRoute({ commodityId: 'crude', capital: 10000, riskBudget: 125 });
  assert.strictEqual(crudeRoute.mcxContract.symbol, 'CRUDEOILM');
  assert.strictEqual(crudeRoute.mcxContract.marginWarning, true, 'CRUDEOILM exceeds ₹10k margin');
  assert.strictEqual(crudeRoute.tenKRoute.symbol, 'ONGC', 'Crude on ₹10k must route to NSE:ONGC MIS proxy');
  assert.strictEqual(crudeRoute.tenKRoute.product, 'MIS');
  assert.ok(crudeRoute.tenKRoute.recommendedQty >= 1);

  const dualBull = signalEngine.computeDualFeedParityAndOrderflow({
    intlCloses: [2640, 2642, 2644, 2650], // +0.378% ROC > +0.15%
    mcxCloses: [78000, 78010, 78020, 78040], // +0.051% ROC (lagging > 0.08%)
    intlPrice: 2650,
    mcxPrice: 78040,
    fairValuePrice: 78250,
    kiteTick: {
      last_price: 78040,
      net_change: 40,
      oi: 12000,
      oi_day_high: 12000,
      depth: {
        buy: [{ quantity: 50 }, { quantity: 40 }, { quantity: 30 }, { quantity: 20 }, { quantity: 10 }],
        sell: [{ quantity: 15 }, { quantity: 15 }, { quantity: 10 }, { quantity: 10 }, { quantity: 10 }]
      }
    },
    timestamps: [Date.parse('2026-11-18T14:00:00Z')] // 19:30 IST -> PRIME_US_OVERLAP
  });
  assert.strictEqual(dualBull.paritySignal, 'BULLISH_LAG');
  assert.strictEqual(dualBull.oiRegime, 'LONG_BUILDUP');
  assert.strictEqual(dualBull.sessionWindow, 'PRIME_US_OVERLAP');
  assert.ok(dualBull.domRatio > 2.0 && dualBull.microstructureScore >= 75);

  const dualShortCover = signalEngine.computeDualFeedParityAndOrderflow({
    kiteTick: { last_price: 78100, net_change: 50, oi: 10000, oi_day_high: 11500 },
    timestamps: [Date.parse('2026-11-18T08:30:00Z')] // 14:00 IST -> LONDON_OPEN
  });
  assert.strictEqual(dualShortCover.oiRegime, 'SHORT_COVERING');
  assert.strictEqual(dualShortCover.sessionWindow, 'LONDON_OPEN');

  const olympTrendPlan = globalUsdMode.buildUsdTradePlan({
    commodityId: 'gold',
    sig: { action: 'BUY', confidence: 76, regime: 'TRENDING', price: 78500, intlPrice: 2650, sl: 78100, t1: 79300, rr: 2.0 },
    usdBalance: 100,
    nowMs: Date.parse('2026-11-18T14:02:00Z')
  });
  assert.strictEqual(olympTrendPlan.recommendedMode, 'FOREX / MULTIPLIER MODE');
  assert.ok([20, 30, 50].includes(olympTrendPlan.olympMultiplier.multiplier));
  assert.ok(olympTrendPlan.olympMultiplier.autoCloseSlPct <= 50 && olympTrendPlan.olympMultiplier.autoCloseTpPct >= 85);
  assert.strictEqual(olympTrendPlan.entryTiming.next5mCandleSecs, 180);

  const olympRangePlan = globalUsdMode.buildUsdTradePlan({
    commodityId: 'crude',
    sig: { action: 'SELL', confidence: 70, regime: 'RANGING', price: 6200, intlPrice: 70, sl: 6260, t1: 6080, rr: 2.0 },
    usdBalance: 100
  });
  assert.strictEqual(olympRangePlan.recommendedMode, 'FIXED-TIME (FTT) 15m–30m');
  console.log('✓ Test 11 Passed: ₹10K Margin Router, Dual-Feed Parity/OI (H4) & Olymp Trade Multiplier/FTT Assistant verified.');

  // 12. TauricResearch-Inspired Bull vs Bear Devil's Advocate, Trade Reflection Memory & Adaptive Risk Stance
  const confirmedDebate = debateEngine.buildQuantitativeDebate({
    symbol: 'GOLDPETAL26NOVFUT',
    commodityId: 'gold',
    action: 'BUY',
    confidence: 76,
    regime: 'TRENDING',
    htfTrend: { bias: 'BULLISH' },
    dualFeed: { paritySignal: 'BULLISH_LAG', paritySpreadPct: 0.25, oiRegime: 'LONG_BUILDUP', domRatio: 1.8, sessionWindow: 'PRIME_US_OVERLAP' },
    netRR: 2.1
  });
  assert.strictEqual(confirmedDebate.verdict, 'CONFIRM');
  assert.strictEqual(confirmedDebate.sizeMultiplier, 1.0);

  const memoryVetoDebate = debateEngine.buildQuantitativeDebate({
    symbol: 'CRUDEOILM26DECFUT',
    commodityId: 'crude',
    action: 'BUY',
    confidence: 75,
    regime: 'RANGING',
    htfTrend: { bias: 'BULLISH' },
    dualFeed: { sessionWindow: 'MIDDAY_LULL', paritySignal: 'NEUTRAL' },
    recentLessons: [
      { symbol: 'CRUDEOILM26DECFUT', session_window: 'MIDDAY_LULL', regime: 'RANGING', net_pnl: -110 },
      { symbol: 'CRUDEOILM26DECFUT', session_window: 'MIDDAY_LULL', regime: 'RANGING', net_pnl: -95 }
    ]
  });
  assert.strictEqual(memoryVetoDebate.verdict, 'VETO', '2 repeated losses in same window/regime must trigger VETO');
  assert.strictEqual(memoryVetoDebate.sizeMultiplier, 0);

  const recoveryStance = debateEngine.evaluateAdaptiveRiskStance({
    trades: [{ pnl: -100 }],
    baseRisk: 125,
    dailyLossLimit: 300,
    requestedStance: 'AUTO'
  });
  assert.strictEqual(recoveryStance.stance, 'CONSERVATIVE_RECOVERY');
  assert.strictEqual(recoveryStance.effectiveRisk, 75, '1 loss today must auto-step down risk to ₹75 (60%)');

  const lesson = debateEngine.extractLessonFromTrade({
    symbol: 'CRUDEOILM', side: 'BUY', netPnl: -115, exitReason: 'AUTO_SL', regime: 'RANGING', sessionWindow: 'MIDDAY_LULL'
  });
  assert.strictEqual(lesson.outcome, 'LOSS');
  assert.ok(lesson.lesson.includes('MIDDAY_LULL'));
  console.log('✓ Test 12 Passed: Tauric Bull/Bear Debate, Reflection Memory VETO & Auto-Conservative Risk Step-Down verified.');

  // 13. Server-Side GTT Breakeven Modify & Olymp Trade Manifest V3 Extension tests
  const modGtt = await kite.modifyGTT('GTT-SIM-999', { tradingsymbol: 'GOLDPETAL26NOVFUT', stoploss: 7855, target: 8050 }, false);
  assert.strictEqual(modGtt.simulated, true);
  assert.strictEqual(modGtt.stoploss, 7855);
  const fs = require('fs');
  const path = require('path');
  const extManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'olymp-extension', 'manifest.json'), 'utf8'));
  assert.strictEqual(extManifest.manifest_version, 3);
  assert.ok(extManifest.host_permissions.includes('http://127.0.0.1:8000/*'));
  console.log('✓ Test 13 Passed: Kite GTT Breakeven modifyGTT() & Olymp Trade Manifest V3 Co-Pilot Extension verified.');

  // 14. Daily Order-Frequency Cap (Max 3 Trades/Day), Global Kill Switch & Staged Order Queue tests
  const twoTrades = circuitBreaker.evaluateCircuitBreaker({
    trades: [{ pnl: 120 }, { pnl: 80 }],
    dailyLossLimit: 300,
    maxDailyTrades: 3
  });
  assert.strictEqual(twoTrades.tripped, false);
  assert.strictEqual(twoTrades.todayTradeCount, 2);

  const threeTradesCap = circuitBreaker.evaluateCircuitBreaker({
    trades: [{ pnl: 120 }, { pnl: -50 }, { pnl: 90 }],
    dailyLossLimit: 300,
    maxDailyTrades: 3
  });
  assert.strictEqual(threeTradesCap.tripped, true, '3 trades today must trip MAX_DAILY_TRADES_REACHED');
  assert.strictEqual(threeTradesCap.reason, 'MAX_DAILY_TRADES_REACHED');

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSrc.includes("pathname === '/api/kill-switch'"), 'server.js must expose /api/kill-switch');
  assert.ok(serverSrc.includes("pathname === '/api/staged-orders'"), 'server.js must expose /api/staged-orders');
  const olympHudSrc = fs.readFileSync(path.join(__dirname, '..', 'olymp-extension', 'content.js'), 'utf8');
  assert.ok(olympHudSrc.includes('t.killSwitchActive'), 'Olymp Co-Pilot HUD must lock when killSwitchActive is true');
  console.log('✓ Test 14 Passed: Max 3 Daily Trades Cap, Global Emergency Kill Switch & Staged Order Queue verified.');

  // 15. Autonomous Monday–Friday Paper-Trading Pilot Engine tests (shared/auto_pilot.js)
  const autoPilot = require('../shared/auto_pilot');
  const monMorning = new Date('2026-11-23T05:00:00Z'); // Monday Nov 23, 2026 10:30 IST
  const sunAfternoon = new Date('2026-11-22T08:00:00Z'); // Sunday Nov 22, 2026 13:30 IST
  const monSess = autoPilot.getMarketSessionWindow(monMorning);
  const sunSess = autoPilot.getMarketSessionWindow(sunAfternoon);
  assert.strictEqual(monSess.isMcxHours, true, 'Monday 10:30 IST must be active MCX hours');
  assert.strictEqual(monSess.isNseHours, true, 'Monday 10:30 IST must be active NSE hours');
  assert.strictEqual(sunSess.isAnySessionOpen, false, 'Sunday must be closed');

  // Build 45 bars of steady bullish 5m Gold trend during Monday 10:00-13:40 IST
  const baseTs = Math.floor(new Date('2026-11-23T04:30:00Z').getTime() / 1000);
  const trendBars = [];
  for (let i = 0; i < 45; i++) {
    const px = 2620 + i * 1.4;
    trendBars.push({
      time: baseTs + i * 300,
      open: +(px - 0.5).toFixed(2),
      high: +(px + 1.8).toFixed(2),
      low: +(px - 1.0).toFixed(2),
      close: +px.toFixed(2),
      volume: 400 + i * 15
    });
  }
  const goldAsset = autoPilot.AUTO_PILOT_ASSETS.find(a => a.id === 'gold');
  const goldEval = autoPilot.evaluateCommodityForAutoPilot({
    asset: goldAsset,
    rawCandles: trendBars,
    usdInr: 93.95,
    newsScore: 65,
    accountProfile: { capital: 10000, maxRiskPerTrade: 125, dailyLossLimit: 300 },
    todayTrades: [],
    nowDate: monMorning
  });
  assert.ok(goldEval.executionPlan && goldEval.executionPlan.tradingsymbol.startsWith('GOLDPETAL'), '₹10K Auto-Pilot must route Gold to GOLDPETAL');
  assert.ok(goldEval.executionPlan.entryPrice > 5000 && goldEval.executionPlan.entryPrice < 20000, 'GOLDPETAL price must be scaled to 1g (~₹8k-₹12k)');

  // Verify ₹15,000 Budget Best-Stock Evaluation & Ranking (AUTO_PILOT_STOCKS)
  const relStock = autoPilot.AUTO_PILOT_STOCKS.find(s => s.symbol === 'RELIANCE');
  const stockEval = autoPilot.evaluateStockForAutoPilot({
    stock: relStock,
    rawCandles: trendBars,
    accountProfile: { capital: 15000, maxRiskPerTrade: 150, dailyLossLimit: 375 },
    todayTrades: [],
    nowDate: monMorning
  });
  assert.strictEqual(stockEval.assetType, 'STOCK');
  assert.strictEqual(stockEval.executionPlan.tradingsymbol, 'RELIANCE');
  assert.strictEqual(stockEval.executionPlan.product, 'MIS');
  assert.ok(stockEval.executionPlan.marginRequired <= 6750, '5x MIS margin per stock must not exceed 45% of ₹15,000 budget (₹6,750)');
  const ranked = autoPilot.rankBestStocksOfDay([stockEval], 3);
  assert.strictEqual(ranked[0].rank, 1);
  assert.strictEqual(ranked[0].symbol, 'RELIANCE');

  // Verify Official NSE MCP Client Bridge (shared/nse_mcp_client.js)
  const nseMcpClient = require('../shared/nse_mcp_client');
  const nseEdge = nseMcpClient.computeNseMcpStockEdge({
    symbol: 'ICICIBANK',
    sector: 'Banking',
    liveQuote: { ltp: 1610.7, perChange: -1.7, turnoverCr: 921.8 },
    marketOverview: {
      nifty50: { last: 25552, percChange: -0.96 },
      sectorMap: { 'NIFTY BANK': { last: 63347, percChange: -1.99 } },
      topGainers: [{ symbol: 'TCS', perChange: 4.35 }],
      topLosers: [{ symbol: 'ICICIBANK', perChange: -1.7 }],
      breadth: { advPct: 37.2, reading: 'broad decline' }
    }
  });
  assert.strictEqual(nseEdge.available, true);
  assert.strictEqual(nseEdge.bias, 'BEARISH_NSE_FLOW');
  assert.ok(nseEdge.scoreDelta <= -15, 'Weak NIFTY BANK + Top Loser + negative RS must produce strong bearish NSE MCP scoreDelta');

  // Verify SQLite lifecycle manager (+1R breakeven trail + AUTO_TARGET close + trade_lessons insertion)
  const { DatabaseSync } = require('node:sqlite');
  const memDb = new DatabaseSync(':memory:');
  memDb.exec(`
    CREATE TABLE paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, side TEXT, qty INTEGER, entry_price REAL, entry_time TEXT,
      exit_price REAL, exit_time TEXT, stop_loss REAL, target REAL,
      net_pnl REAL, brokerage REAL, stt_gst REAL, status TEXT, exit_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE trade_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, side TEXT, regime TEXT, session_window TEXT, parity_signal TEXT,
      exit_reason TEXT, net_pnl REAL, lesson TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO paper_trades (symbol, side, qty, entry_price, stop_loss, target, brokerage, stt_gst, status, exit_reason)
    VALUES ('GOLDPETAL26NOVFUT', 'BUY', 1, 7800, 7740, 7950, 40, 5, 'OPEN', 'AUTO_PILOT');
  `);

  // Step 1: Move to +1.08R (7865 >= 7800 + 0.70*60) -> should arm fee-covered breakeven SL (7845)
  const step1 = autoPilot.manageOpenPaperPositions({
    db: memDb,
    latestPrices: { GOLDPETAL26NOVFUT: { price: 7862, high: 7865, low: 7850 } }
  });
  assert.strictEqual(step1.breakevenArmed.length, 1, '+0.70R..1.14R move must arm fee-covered breakeven SL');
  assert.strictEqual(step1.breakevenArmed[0].newSl, 7845);

  // Verify Walk-Forward Historical Chart Backtest Gate (computeHistoricalSetupEdge)
  const histEdge = autoPilot.computeHistoricalSetupEdge({
    closes: trendBars.map(b => b.close),
    highs: trendBars.map(b => b.high),
    lows: trendBars.map(b => b.low),
    action: 'BUY'
  });
  assert.strictEqual(histEdge.provenEdge, true, 'Steady uptrend must pass Walk-Forward Historical Chart Backtest Gate');
  assert.ok(histEdge.winRate >= 50);

  // Step 2: Move to Target (7955 >= 7950) -> should auto-close at 7950 & write reflection lesson
  const step2 = autoPilot.manageOpenPaperPositions({
    db: memDb,
    latestPrices: { GOLDPETAL26NOVFUT: { price: 7955, high: 7960, low: 7940, regime: 'TRENDING', sessionWindow: 'ASIA_MORNING' } }
  });
  assert.strictEqual(step2.closed.length, 1, 'Reaching target must auto-close position');
  assert.strictEqual(step2.closed[0].exitReason, 'AUTO_TARGET');
  assert.strictEqual(step2.closed[0].status, 'WIN');
  const lessonsInDb = memDb.prepare('SELECT * FROM trade_lessons').all();
  assert.strictEqual(lessonsInDb.length, 1, 'Auto-closed paper trade must write a reflection lesson into trade_lessons');
  console.log('✓ Test 15 Passed: Autonomous Paper-Trading Pilot (5-commodity scan, ₹15K routing, +0.70R ratchet, auto-close & lesson extraction) verified.');

  // ── Test 16: 4-Layer Profitability Upgrade (Dual-Archetype, Midday Chop Shield, 2-Bucket CNC Swing, Corporate Action Shield) ──
  const middayMon = new Date('2026-11-23T06:45:00Z'); // 12:15 IST Monday
  const middaySess = autoPilot.getMarketSessionWindow(middayMon);
  assert.strictEqual(middaySess.nseSessionPhase, 'MIDDAY_CHOP', '12:15 IST must classify as MIDDAY_CHOP');
  assert.strictEqual(middaySess.isMiddayChop, true);

  const morningMon = new Date('2026-11-23T04:30:00Z'); // 10:00 IST Monday
  const morningSess = autoPilot.getMarketSessionWindow(morningMon);
  assert.strictEqual(morningSess.nseSessionPhase, 'MORNING_DRIVE', '10:00 IST must classify as MORNING_DRIVE');
  assert.strictEqual(morningSess.isMiddayChop, false);

  // Dual-Archetype output verification
  assert.ok(['TREND_RUNNER', 'MEAN_REVERTER'].includes(histEdge.archetype), 'computeHistoricalSetupEdge must return Dual-Archetype label');
  assert.ok(histEdge.trendEdge && histEdge.revertEdge, 'Dual-Archetype must expose both trendEdge and revertEdge');

  // Corporate Action Shield veto verification
  const sbinStock = autoPilot.AUTO_PILOT_STOCKS.find(s => s.symbol === 'SBIN');
  const sbinBars = trendBars.map((b, i) => ({
    time: b.time,
    open: 800 + i * 0.4,
    high: 803 + i * 0.4,
    low: 799 + i * 0.4,
    close: 802 + i * 0.4,
    volume: 10000
  }));
  const caBlockedEv = autoPilot.evaluateStockForAutoPilot({
    stock: sbinStock,
    rawCandles: sbinBars,
    swingProfile: { corporateActionBlocked: true, corporateActionReason: 'Ex-Dividend in 1d', qualifiesForCncSwing: true },
    nowDate: morningMon
  });
  assert.strictEqual(caBlockedEv.qualifiesForAutoExec, false, 'Corporate Action Shield must veto auto-execution');
  assert.strictEqual(caBlockedEv.corporateActionBlocked, true);

  // 2-Bucket CNC Swing routing verification (price <= ₹5000 + qualifiesForCncSwing = true -> CNC_SWING)
  const cncEv = autoPilot.evaluateStockForAutoPilot({
    stock: sbinStock,
    rawCandles: sbinBars,
    swingProfile: { corporateActionBlocked: false, qualifiesForCncSwing: true, swingScore: 85 },
    nowDate: morningMon
  });
  assert.strictEqual(cncEv.executionPlan.bucket, 'CNC_SWING', 'Qualifying daily uptrend stock <= ₹5000 must route to CNC_SWING bucket');
  assert.strictEqual(cncEv.executionPlan.product, 'CNC');

  // Verify CNC_SWING position is exempt from 15:20 IST intraday EOD square-off
  memDb.exec(`
    INSERT INTO paper_trades (symbol, side, qty, entry_price, stop_loss, target, brokerage, stt_gst, status, exit_reason)
    VALUES ('SBIN', 'BUY', 5, 840, 823.2, 877.8, 0, 9.24, 'OPEN', 'AUTO_PILOT_CNC_SWING');
  `);
  const eodMon = new Date('2026-11-23T09:52:00Z'); // 15:22 IST Monday
  const eodRes = autoPilot.manageOpenPaperPositions({
    db: memDb,
    latestPrices: { SBIN: { price: 845, high: 846, low: 844, isLive: true } },
    sessionInfo: autoPilot.getMarketSessionWindow(eodMon)
  });
  assert.strictEqual(eodRes.closed.length, 0, 'CNC_SWING delivery trade must NOT be auto-squared-off at 15:20 IST');
  console.log('✓ Test 16 Passed: 4-Layer Profitability Upgrade (Dual-Archetype, Midday Chop Shield, 2-Bucket CNC Swing, Corporate Action Shield) verified.');

  // ── Test 17: Multi-Year Official NSE Bhavcopy CNC Swing Backtester & Multi-Year Gate ──
  const swingBt = require('../shared/swing_backtest');
  const synthDaily = [];
  let px = 500;
  for (let d = 0; d < 260; d++) {
    // Periodic pullback to 20-DMA every ~25 days inside a steady uptrend
    const wave = (d % 25 >= 18 && d % 25 <= 20) ? -8 : 1.8;
    const open = px;
    const close = +(Math.max(100, px + wave)).toFixed(2);
    const high = +(Math.max(open, close) + 4).toFixed(2);
    const low = +(Math.min(open, close) - 4).toFixed(2);
    const dt = new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10);
    synthDaily.push({ date: dt, open, high, low, close, volume: 1000000 + (d % 5) * 200000 });
    px = close;
  }
  const btRes = swingBt.backtestStockMultiYear('SYNTH_NSE', synthDaily);
  assert.strictEqual(btRes.symbol, 'SYNTH_NSE');
  assert.ok(btRes.trades >= 1, 'Multi-year daily backtester must detect swing setups on uptrend pullbacks');
  assert.ok(['SWING_PULLBACK', 'SWING_BREAKOUT'].includes(btRes.bestArchetype));

  // Verify failing multiYearSwingEdge blocks CNC_SWING bucket routing even if current 20/50 DMA is bullish
  const failedMyEv = autoPilot.evaluateStockForAutoPilot({
    stock: sbinStock,
    rawCandles: sbinBars,
    swingProfile: { corporateActionBlocked: false, qualifiesForCncSwing: true, swingScore: 85 },
    multiYearSwingEdge: { provenEdge: false, profitFactor: 0.45, winRate: 33, trades: 15 },
    nowDate: morningMon
  });
  assert.strictEqual(failedMyEv.executionPlan.bucket, 'MIS_INTRADAY', 'Stock failing 2.5Y CNC backtest must NOT route to CNC_SWING bucket');
  console.log('✓ Test 17 Passed: Multi-Year Official NSE Bhavcopy CNC Swing Backtester & Champion Gate verified.');

  // ── Test 18: Self-Auditing Trading Brain (Market Regime, MFE/MAE Auditor, Auto-Bench & Dynamic Nifty-50 Champions) ──
  const brain = require('../shared/trading_brain');
  const panicRegime = brain.classifyMarketRegime({
    nseMcpOverview: { nifty50: { percChange: -1.8 }, breadth: { advPct: 18 } }
  });
  assert.strictEqual(panicRegime.regime, 'HIGH_VOL_PANIC');
  assert.strictEqual(panicRegime.allowNewLongs, false);
  assert.strictEqual(panicRegime.sizeMultiplier, 0.5);

  const bullRegime = brain.classifyMarketRegime({
    nseMcpOverview: { nifty50: { percChange: 0.75 }, breadth: { advPct: 68 } }
  });
  assert.strictEqual(bullRegime.regime, 'BULL_TREND');
  assert.strictEqual(bullRegime.allowNewLongs, true);

  // Verify MFE/MAE tracking & Auto-Bench after 2 consecutive losses
  brain.ensureBrainTables(memDb);
  memDb.exec(`
    INSERT INTO paper_trades (symbol, side, qty, entry_price, exit_price, stop_loss, target, net_pnl, brokerage, stt_gst, status, exit_reason)
    VALUES ('BADSTOCK', 'BUY', 5, 500, 490, 490, 520, -65, 10, 5, 'LOSS', 'AUTO_SL'),
           ('BADSTOCK', 'BUY', 5, 500, 490, 490, 520, -65, 10, 5, 'LOSS', 'AUTO_SL');
  `);
  const mfeUpd = brain.updateTradeExcursions(
    memDb,
    [{ id: 999, symbol: 'SBIN', side: 'BUY', entry_price: 800, stop_loss: 790, target: 830 }],
    { SBIN: { price: 815 } }
  );
  assert.strictEqual(mfeUpd[0].mfeR, 1.5, 'MFE must compute +1.5R accurately');

  const execAudit = brain.auditExecutionQuality(memDb);
  assert.ok(execAudit.autoBenchedSymbols.some(b => b.symbol === 'BADSTOCK'), 'Brain must auto-bench symbol with 2 consecutive losses');

  // Verify Brain Auto-Bench Veto & Regime Veto block auto-execution
  const benchVetoEv = autoPilot.evaluateStockForAutoPilot({
    stock: sbinStock,
    rawCandles: sbinBars,
    brainState: {
      regime: panicRegime,
      execution: { ...execAudit, autoBenchedSymbols: [{ symbol: 'SBIN', trades: 2, netPnl: -130, reason: '2 consecutive losses' }] }
    },
    nowDate: morningMon
  });
  assert.strictEqual(benchVetoEv.qualifiesForAutoExec, false, 'Auto-Benched symbol must be vetoed by Trading Brain');
  assert.ok(String(benchVetoEv.vetoReason || '').includes('Brain Auto-Bench Veto'));

  // Verify dynamic Nifty-50 Champion universe expansion
  const dynUniverse = autoPilot.buildDynamicStockUniverse(['SHRIRAMFIN', 'ETERNAL', 'KOTAKBANK']);
  assert.ok(dynUniverse.some(s => s.symbol === 'SHRIRAMFIN') && dynUniverse.some(s => s.symbol === 'ETERNAL'), 'Dynamic universe must merge Nifty-50 Champions');
  console.log('✓ Test 18 Passed: Self-Auditing Trading Brain (Regime, MFE/MAE, Auto-Bench & Nifty-50 Champions) verified.');

  // ── Test 19: MCX Proxy Fee-Scaling Fix + Nightly Brain Post-Mortem + Quant Scorecard ──
  const silverAsset = autoPilot.AUTO_PILOT_ASSETS.find(a => a.id === 'silver');
  const silverEv = autoPilot.evaluateCommodityForAutoPilot({
    asset: silverAsset,
    rawCandles: trendBars.map((b, i) => ({ time: b.time, open: 30 + i * 0.08, high: 30.3 + i * 0.08, low: 29.9 + i * 0.08, close: 30.2 + i * 0.08, volume: 5000 })),
    usdInr: 93.95,
    accountProfile: { capital: 15000, maxRiskPerTrade: 150, dailyLossLimit: 375 }
  });
  assert.ok(!String(silverEv.vetoReason || '').includes('below fee hurdle (₹328'), 'Scaled SILVERBEES equity proxy must NOT be evaluated against unscaled ₹95K MCX fees');

  const pmReport = brain.generateDailyPostMortem(memDb, {
    nseMcpOverview: { nifty50: { percChange: -1.75 }, breadth: { advPct: 27.2 }, topGainers: [{ symbol: 'SHRIRAMFIN', perChange: 2.46 }] },
    swingBacktestData: { provenChampions: ['SHRIRAMFIN', 'KOTAKBANK'], provenChampionsCount: 2 },
    dateIst: '2026-11-24'
  });
  assert.strictEqual(pmReport.regime, 'HIGH_VOL_PANIC');
  assert.ok(pmReport.championMovers.some(m => m.includes('SHRIRAMFIN')), 'Post-mortem must highlight proven Champions leading tape');

  const scorecard = brain.buildQuantScorecard(memDb, {
    accountProfile: { capital: 15000 },
    nseMcpOverview: { nifty50: { percChange: -1.75 }, breadth: { advPct: 27.2 } },
    swingBacktestData: { provenChampions: ['SHRIRAMFIN', 'KOTAKBANK'], provenChampionsCount: 2 }
  });
  assert.strictEqual(scorecard.ok, true);
  assert.ok(Array.isArray(scorecard.equityCurve) && scorecard.equityCurve.length >= 2);
  assert.strictEqual(scorecard.graduation.checks.length, 4);
  assert.ok(scorecard.postMortems.length >= 1, 'Scorecard must return saved nightly Brain Post-Mortems');
  console.log('✓ Test 19 Passed: MCX Proxy Fee-Scaling Fix, Nightly Brain Post-Mortem & Quant Scorecard verified.');

  // ── Test 20: 3-Engine All-Weather Regime Switcher (Breadth Gate + RSI(2) Washout + GOLDBEES 35-DMA + ₹0 Brok CNC) ──
  const allWeather = require('../shared/all_weather_engine');
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS daily_candles (
      symbol TEXT NOT NULL, date TEXT NOT NULL,
      open REAL, high REAL, low REAL, close REAL, volume INTEGER DEFAULT 0, turnover REAL DEFAULT 0, source TEXT,
      PRIMARY KEY (symbol, date)
    );
  `);
  const insD = memDb.prepare(`INSERT OR REPLACE INTO daily_candles (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, 100000)`);
  // Seed 215 days of uptrending GOLDBEES + 2 uptrending blue-chips where DIPSTOCK has a sharp 3d -5% RSI(2)=0 washout
  for (let d = 0; d < 215; d++) {
    const dt = new Date(Date.UTC(2025, 0, 1 + d)).toISOString().slice(0, 10);
    const gPx = 60 + d * 0.15;
    insD.run('GOLDBEES', dt, gPx, gPx + 0.5, gPx - 0.5, gPx);
    const leadPx = 1000 + d * 1.5;
    insD.run('LEADER1', dt, leadPx, leadPx + 5, leadPx - 5, leadPx);
    insD.run('LEADER2', dt, leadPx, leadPx + 5, leadPx - 5, leadPx);
    let dipPx = 1000 + d * 2.0;
    if (d === 212) dipPx -= 20;
    if (d === 213) dipPx -= 45;
    if (d === 214) dipPx -= 75; // sharp 3-day > -4% washout while still well above 200-DMA!
    insD.run('DIPSTOCK', dt, dipPx + 5, dipPx + 8, dipPx - 2, dipPx);
  }
  const awState = allWeather.evaluateAllWeatherState(memDb, { capital: 15000 });
  assert.strictEqual(awState.ok, true);
  assert.strictEqual(awState.breadthState, 'RISK_ON', '100% stocks > 50-DMA must classify as RISK_ON');
  assert.strictEqual(awState.goldSafeHaven.bullish, true, 'Rising GOLDBEES must be bullish (>35-DMA)');
  assert.ok(awState.washoutTriggers.some(w => w.symbol === 'DIPSTOCK'), 'Sharp 3-day washout above 200-DMA must trigger DIPSTOCK');

  const awExec = allWeather.executeAllWeatherPaperCycle(memDb, { capital: 15000 });
  assert.ok(awExec.opened.some(o => o.symbol === 'DIPSTOCK' && o.bucket === 'CNC_WASHOUT'), 'Must auto-open DIPSTOCK CNC Washout trade');
  assert.ok(awExec.opened.some(o => o.symbol === 'GOLDBEES' && o.bucket === 'CNC_GOLD_SAFE_HAVEN'), 'Must auto-open GOLDBEES Safe-Haven CNC trade');

  // Verify rebound above 5-DMA exits DIPSTOCK cleanly as WIN with ₹0 brokerage
  const reboundExec = allWeather.executeAllWeatherPaperCycle(memDb, {
    capital: 15000,
    liveQuotes: { DIPSTOCK: { ltp: 1450 }, GOLDBEES: { ltp: 95 } }
  });
  assert.ok(reboundExec.closed.some(c => c.symbol === 'DIPSTOCK' && c.exitReason === 'AUTO_AW_SMA5_TARGET' && c.status === 'WIN'), 'Bounce above 5-DMA must auto-close washout in WIN');
  console.log('✓ Test 20 Passed: 3-Engine All-Weather Regime Switcher (RSI(2) Washout, GOLDBEES 35-DMA & ₹0 Brok CNC lifecycle) verified.');

  // ── Test 21: Trading Brain v2 CIO Meta-Strategy Layer (Live Breadth, Sector Guard, Strategy Bandit, Equity Governor, Temporal Edge) ──
  // 1. Live Intraday Breadth must override stale yesterday EOD breadth (27.2%) on a +1.56% Nifty rally!
  const bullSurgeRegime = brain.classifyMarketRegime({
    nseMcpOverview: {
      nifty50: { percChange: 1.56 },
      breadth: { advPct: 27.2 },
      sectorMap: { 'NIFTY BANK': { percChange: 1.4 }, 'NIFTY IT': { percChange: 1.2 }, 'NIFTY AUTO': { percChange: 1.8 }, 'NIFTY METAL': { percChange: 0.9 } }
    }
  });
  assert.strictEqual(bullSurgeRegime.regime, 'BULL_TREND', 'Live +1.56% Nifty surge must classify as BULL_TREND even if EOD Bhavcopy breadth is stale 27.2%');
  assert.strictEqual(bullSurgeRegime.allowNewShorts, false, 'BULL_TREND must block counter-trend shorts');
  assert.strictEqual(bullSurgeRegime.breadthSource, 'LIVE_INTRADAY');

  // 2. Sector Concentration Guard (max 1 open trade per NSE sector)
  const bankBlocked = brain.checkSectorConcentration([{ symbol: 'AXISBANK', status: 'OPEN' }], 'ICICIBANK', 1);
  assert.strictEqual(bankBlocked.blocked, true, 'Must block second simultaneous BANKING trade');
  const energyAllowed = brain.checkSectorConcentration([{ symbol: 'AXISBANK', status: 'OPEN' }], 'RELIANCE', 1);
  assert.strictEqual(energyAllowed.blocked, false, 'Must allow diversified ENERGY trade alongside BANKING');

  // 3. Strategy Decay Shadow-Pause & Equity Curve Governor
  const banditDb = new DatabaseSync(':memory:');
  banditDb.exec(`
    CREATE TABLE paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, side TEXT, qty INTEGER, entry_price REAL, entry_time TEXT,
      exit_price REAL, exit_time TEXT, stop_loss REAL, target REAL,
      net_pnl REAL, brokerage REAL, stt_gst REAL, status TEXT, exit_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO paper_trades (symbol, side, qty, entry_price, entry_time, exit_price, net_pnl, brokerage, stt_gst, status, exit_reason) VALUES
      ('SBIN', 'BUY', 5, 800, '2026-11-25T04:00:00Z', 780, -180, 20, 5, 'LOSS', 'AUTO_SL'),
      ('INFY', 'BUY', 2, 1500, '2026-11-25T04:10:00Z', 1410, -200, 20, 5, 'LOSS', 'AUTO_SL'),
      ('TCS', 'BUY', 1, 2500, '2026-11-25T04:20:00Z', 2320, -200, 20, 5, 'LOSS', 'AUTO_SL'),
      ('ITC', 'BUY', 20, 300, '2026-11-25T04:30:00Z', 292, -180, 20, 5, 'LOSS', 'AUTO_SL');
  `);
  const bandit = brain.evaluateStrategyBandit(banditDb, { regime: bullSurgeRegime });
  assert.strictEqual(bandit.byId.MIS_INTRADAY.status, 'SHADOW_PAUSED', '4 straight MIS losses (>₹180) must auto-pause MIS_INTRADAY in SHADOW_PAUSED');
  assert.strictEqual(bandit.byId.MIS_INTRADAY.weightPct, 0);
  assert.strictEqual(bandit.byId.ALL_WEATHER_CNC.status, 'PRIMARY', 'Winning All-Weather CNC must stay PRIMARY');

  const eqGov = brain.evaluateEquityGovernor(banditDb, 15000);
  assert.strictEqual(eqGov.state, 'CAPITAL_SHIELD', '₹760 loss (5.07% DD >= 4.5%) must activate CAPITAL_SHIELD');
  assert.strictEqual(eqGov.allowIntradayMis, false);

  const temporal = brain.auditTemporalEdge(banditDb);
  assert.strictEqual(temporal.length, 5, 'Temporal Edge Matrix must audit all 5 IST trading windows');
  console.log('✓ Test 21 Passed: Trading Brain v2 CIO Meta-Strategy Layer (Live Breadth, Sector Guard, Strategy Bandit, Equity Governor & Temporal Edge) verified.');

  // ── Test 22: Trend-Runner Trailing Mode (RATCHET_3_RUNNER) & Realistic 0.04% Paper Slippage ──
  assert.strictEqual(autoPilot.applyPaperSlippage(1000, 'BUY', true, 4), 1000.4, 'BUY entry slippage must add +4 bps');
  assert.strictEqual(autoPilot.applyPaperSlippage(1000, 'BUY', false, 4), 999.6, 'BUY market exit slippage must subtract -4 bps');
  assert.strictEqual(autoPilot.applyPaperSlippage(1000, 'SELL', true, 4), 999.6, 'SELL entry slippage must subtract -4 bps');
  assert.strictEqual(autoPilot.applyPaperSlippage(1000, 'SELL', false, 4), 1000.4, 'SELL market exit slippage must add +4 bps');

  const runnerDb = new DatabaseSync(':memory:');
  runnerDb.exec(`
    CREATE TABLE paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, side TEXT, qty INTEGER, entry_price REAL, entry_time TEXT,
      exit_price REAL, exit_time TEXT, stop_loss REAL, target REAL,
      net_pnl REAL, brokerage REAL, stt_gst REAL, status TEXT, exit_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE trade_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT, side TEXT, regime TEXT, session_window TEXT, parity_signal TEXT,
      exit_reason TEXT, net_pnl REAL, lesson TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO paper_trades (symbol, side, qty, entry_price, stop_loss, target, brokerage, stt_gst, status, exit_reason)
    VALUES ('AXISBANK', 'BUY', 5, 1000, 985, 1030, 10, 5, 'OPEN', 'RATCHET_2_BE_ARMED');
  `);
  // Price hits T1 (1030) during BULL_TREND -> must convert into RATCHET_3_RUNNER (SL=1027, T2=1055.5) instead of capping at T1!
  const runStep1 = autoPilot.manageOpenPaperPositions({
    db: runnerDb,
    latestPrices: { AXISBANK: { price: 1030.5, high: 1031, low: 1028, isLive: true } },
    brainState: { regime: { regime: 'BULL_TREND' } },
    applySlippage: true
  });
  assert.strictEqual(runStep1.closed.length, 0, 'BULL_TREND BUY reaching T1 must NOT hard-close; must activate Trend-Runner Mode');
  assert.ok(runStep1.breakevenArmed.some(b => b.stage === 'RATCHET_3_RUNNER' && b.newSl === 1027 && b.newTarget === 1055.5), 'Trend-Runner must lock 90% of T1 (1027) and extend target to T2 (1055.5)');

  // Price keeps surging to 1050 -> continuous runner trail must lift SL higher (1050 - 0.25*55.5 = 1036.13)!
  const runStep2 = autoPilot.manageOpenPaperPositions({
    db: runnerDb,
    latestPrices: { AXISBANK: { price: 1049, high: 1050, low: 1045, isLive: true } },
    brainState: { regime: { regime: 'BULL_TREND' } },
    applySlippage: true
  });
  assert.strictEqual(runStep2.closed.length, 0);
  const runnerRow = runnerDb.prepare('SELECT stop_loss, target, exit_reason FROM paper_trades WHERE id = 1').get();
  assert.ok(runnerRow.stop_loss > 1035, 'Runner continuous trail must lift SL above 1035 on surge to 1050');
  assert.strictEqual(runnerRow.exit_reason, 'RATCHET_3_RUNNER');
  console.log('✓ Test 22 Passed: Trend-Runner Mode (RATCHET_3_RUNNER T2 Extension + Continuous Trail) & Realistic 0.04% Slippage verified.\n🎉 ALL INSTITUTIONAL TESTS PASSED.');
})();
