const assert = require('assert');
const riskEngine = require('../risk');
const contractResolver = require('../shared/contract_resolver');
const macroEvents = require('../shared/macro_events');
const circuitBreaker = require('../shared/circuit_breaker');
const geoHistory = require('../shared/geopolitical_history');
const geoAnalogs = require('../shared/geopolitical_analogs');
const patternEngine = require('../shared/pattern_engine');
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
console.log('✓ Test 4 Passed: Daily risk circuit breaker trips on ₹400 drawdown or 2 consecutive losses.');

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

// 7. Kite Paper Order & GTT OCO tests
(async () => {
  const ord = await kite.placeOrder({ tradingsymbol: 'GOLDPETAL26NOVFUT', side: 'BUY', price: 7800, triggerPrice: 7750 });
  assert.strictEqual(ord.tradingsymbol, 'GOLDPETAL26NOVFUT');
  assert.strictEqual(ord.simulated, true);
  const gtt = await kite.placeGTT({ tradingsymbol: 'CRUDEOILM26NOVFUT', stoploss: 6100, target: 6300 });
  assert.strictEqual(gtt.type, 'two-leg');
  assert.strictEqual(gtt.simulated, true);
  console.log('✓ Test 7 Passed: Kite simulated order & two-leg GTT OCO verified.\n🎉 ALL INSTITUTIONAL TESTS PASSED.');
})();
