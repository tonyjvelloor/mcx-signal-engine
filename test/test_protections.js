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
  console.log('✓ Test 11 Passed: ₹10K Margin Router, Dual-Feed Parity/OI (H4) & Olymp Trade Multiplier/FTT Assistant verified.\n🎉 ALL INSTITUTIONAL TESTS PASSED.');
})();
