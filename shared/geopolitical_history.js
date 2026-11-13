/**
 * shared/geopolitical_history.js — Institutional Geopolitical & Trade Shock Event Encyclopedia
 *
 * Quantitative historical repository of major geopolitical conflicts, trade wars,
 * OPEC supply shocks, and macroeconomic crises.
 *
 * Provides empirical price shock trajectories (T+1, T+3, T+7, T+30 days) for MCX commodities
 * and cross-asset impact projections for major Indian NSE equities.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.GeopoliticalHistory = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const HISTORICAL_EVENTS = [
    {
      id: '2023_HAMAS_ISRAEL_RED_SEA',
      name: 'Israel-Gaza Conflict & Red Sea Shipping Blockade',
      startDate: '2023-10-07',
      category: 'WAR_CONFLICT',
      region: 'Middle East / Red Sea',
      severity: 'CRITICAL',
      keywords: ['israel', 'gaza', 'hamas', 'red sea', 'houthi', 'yemen', 'shipping', 'bab el-mandeb', 'tanker', 'iran'],
      summary: 'Surprise attack escalation followed by Houthi missile strikes on commercial tankers transiting the Bab el-Mandeb strait, forcing rerouting around Africa.',
      commodityImpacts: {
        crude: { immediate: '+4.2%', day3: '+6.1%', day7: '+7.8%', day30: '+2.1%', peakReturn: '+9.4%', tendency: 'Initial sharp spike followed by 60% retracement once supply was rerouted rather than destroyed.' },
        gold: { immediate: '+1.6%', day3: '+3.4%', day7: '+5.2%', day30: '+8.1%', peakReturn: '+10.2%', tendency: 'Sustained safe-haven accumulation; flight-to-safety bid remained elevated for 45+ days.' },
        silver: { immediate: '+2.1%', day3: '+4.0%', day7: '+6.5%', day30: '+7.4%', peakReturn: '+8.9%', tendency: 'High-beta catch-up following Gold safe-haven rally.' },
        natgas: { immediate: '+6.8%', day3: '+12.4%', day7: '+14.2%', day30: '-3.5%', peakReturn: '+18.5%', tendency: 'Violent initial spike due to European LNG tanker rerouting fears, followed by sharp mean-reversion.' },
        copper: { immediate: '-0.8%', day3: '-1.4%', day7: '+0.5%', day30: '+2.2%', peakReturn: '-2.1%', tendency: 'Initial risk-off selling followed by recovery.' }
      },
      stockImpacts: {
        'ONGC': { impact: 'BULLISH', expMove: '+4% to +7%', reason: 'Surging Brent crude benchmarks directly increase upstream crude realizations and EBITDA.' },
        'BPCL': { impact: 'BEARISH', expMove: '-3% to -6%', reason: 'Retail fuel prices frozen while crude import costs jump, squeezing marketing margins.' },
        'INDIGO': { impact: 'BEARISH', expMove: '-4% to -8%', reason: 'Aviation Turbine Fuel (ATF) constitutes ~40% of operating expenses.' },
        'ASIANPAINT': { impact: 'BEARISH', expMove: '-2% to -5%', reason: 'Crude derivatives, solvents, and titanium dioxide account for ~50% of raw material input costs.' },
        'TITAN': { impact: 'NEUTRAL_VOLATILE', expMove: '-2% to +3%', reason: 'Gold price surge leads to inventory revaluation gains, but high domestic prices depress short-term wedding volume.' },
        'TATASTEEL': { impact: 'NEUTRAL', expMove: '-1% to +2%', reason: 'Freight inflation increases export shipping costs, balanced by global commodity inflation bid.' },
        'NIFTY50': { impact: 'BEARISH_CORRECTION', expMove: '-1.5% to -3.5%', reason: 'India imports >85% of crude requirements; higher oil widens current account deficit and prompts FII outflows.' }
      },
      institutionalPlaybook: [
        'The Headline Fade Heuristic: If physical crude infrastructure (pipelines, refineries, offshore wells) remains undamaged after 48h, fade crude breakout rallies exceeding 2.5 standard deviations.',
        'Gold vs Crude Divergence: When both Gold and Crude rally together, it signals war premium. If Crude fades while Gold stays high, systemic fear is rising; maintain long gold hedges.'
      ]
    },
    {
      id: '2022_RUSSIA_UKRAINE_INVASION',
      name: 'Russia-Ukraine Military Invasion & Western Sanctions',
      startDate: '2022-02-24',
      category: 'WAR_CONFLICT',
      region: 'Eastern Europe / Global Energy',
      severity: 'CRITICAL',
      keywords: ['russia', 'ukraine', 'invasion', 'sanctions', 'gazprom', 'nord stream', 'putin', 'oil embargo', 'swift'],
      summary: 'Russian troops crossed into Ukraine triggering SWIFT sanctions, G7 crude price caps, and Nord Stream pipeline shutdown, causing the biggest global energy disruption since 1973.',
      commodityImpacts: {
        crude: { immediate: '+8.5%', day3: '+14.2%', day7: '+28.5%', day30: '+32.0%', peakReturn: '+42.1%', tendency: 'Sustained structural bull market lasting 4 months as physical supply of 3M bpd was rerouted.' },
        gold: { immediate: '+3.2%', day3: '+5.8%', day7: '+8.2%', day30: '+4.5%', peakReturn: '+9.8%', tendency: 'Initial surge to all-time high before US Fed rate hikes triggered dollar rally.' },
        silver: { immediate: '+4.1%', day3: '+7.2%', day7: '+11.5%', day30: '+3.2%', peakReturn: '+13.4%', tendency: 'Extreme volatility; outpaced gold on initial upswing then sold off as global growth slowed.' },
        natgas: { immediate: '+15.2%', day3: '+28.0%', day7: '+45.0%', day30: '+70.0%', peakReturn: '+180.0%', tendency: 'Historic multi-month parabolic squeeze due to complete physical cutoff of Russian pipeline gas to Europe.' },
        copper: { immediate: '+2.5%', day3: '+4.8%', day7: '+7.2%', day30: '+1.5%', peakReturn: '+8.5%', tendency: 'Supply shock rally in non-ferrous metals followed by stagflation fears.' }
      },
      stockImpacts: {
        'ONGC': { impact: 'STRONG_BULLISH', expMove: '+10% to +18%', reason: 'Crude surged past $120/bbl; windfall profits soared until windfall tax (SAED) was introduced.' },
        'BPCL': { impact: 'STRONG_BEARISH', expMove: '-8% to -16%', reason: 'Marketing under-recoveries as retail pump rates held steady against surging crude.' },
        'INDIGO': { impact: 'STRONG_BEARISH', expMove: '-10% to -20%', reason: 'ATF prices doubled in 90 days, compressing route profitability.' },
        'ASIANPAINT': { impact: 'BEARISH', expMove: '-6% to -12%', reason: 'Crude at $120/bbl forced consecutive retail price hikes.' },
        'TITAN': { impact: 'MILD_BEARISH', expMove: '-3% to -7%', reason: 'Spike in domestic 24K gold rates caused consumers to postpone discretionary jewelry purchases.' },
        'TATASTEEL': { impact: 'STRONG_BULLISH_THEN_BEARISH', expMove: '+8% then -15%', reason: 'Initial global steel shortage rally followed by high energy input costs.' },
        'NIFTY50': { impact: 'BEARISH_VOLATILITY', expMove: '-4.5% to -8.0%', reason: 'Heavy FII liquidations and rapid INR depreciation.' }
      },
      institutionalPlaybook: [
        'Sanctions vs War Reality: Direct physical embargoes on a top-3 global producer create multi-month structural shifts, NOT 48-hour fades.',
        'Sector Pair Trade: Long Upstream (ONGC) / Short Downstream (BPCL/IOC) captures spread expansion with low market beta.'
      ]
    },
    {
      id: '2023_OPEC_SURPRISE_OUTPUT_CUT',
      name: 'OPEC+ Surprise 1.16M bpd Production Quota Cut',
      startDate: '2023-04-02',
      category: 'SUPPLY_SHOCK',
      region: 'OPEC / Middle East',
      severity: 'HIGH',
      keywords: ['opec', 'saudi', 'output cut', 'quota', 'production', 'crude supply', 'brent', 'barrel'],
      summary: 'Saudi Arabia and OPEC+ ministers announced a surprise weekend production cut of 1.16 million barrels per day ahead of an official ministerial meeting.',
      commodityImpacts: {
        crude: { immediate: '+6.2%', day3: '+7.5%', day7: '+5.1%', day30: '-2.4%', peakReturn: '+8.3%', tendency: 'Gapped up Sunday night. Rallied 4 sessions, then completely filled the gap over the next 22 days.' },
        gold: { immediate: '+0.8%', day3: '+1.5%', day7: '+2.1%', day30: '+3.4%', peakReturn: '+4.0%', tendency: 'Inflation expectation hedge; gold benefited steadily.' },
        silver: { immediate: '+1.2%', day3: '+2.8%', day7: '+3.5%', day30: '+4.1%', peakReturn: '+5.0%', tendency: 'Tracked gold with positive momentum.' },
        natgas: { immediate: '-1.0%', day3: '-2.2%', day7: '+0.5%', day30: '+3.0%', peakReturn: '+3.5%', tendency: 'Minimal direct impact; driven by weather and storage.' },
        copper: { immediate: '-0.5%', day3: '-1.1%', day7: '-1.8%', day30: '-3.2%', peakReturn: '-3.5%', tendency: 'Negative correlation as higher energy costs threaten manufacturing margins.' }
      },
      stockImpacts: {
        'ONGC': { impact: 'BULLISH_GAP', expMove: '+3% to +5%', reason: 'Direct gap up on higher crude realization expectation.' },
        'BPCL': { impact: 'BEARISH_GAP', expMove: '-2% to -4%', reason: 'Immediate downgrade of refining crack spreads.' },
        'INDIGO': { impact: 'BEARISH', expMove: '-2% to -4%', reason: 'Higher jet fuel expectations.' },
        'ASIANPAINT': { impact: 'MILD_BEARISH', expMove: '-1% to -2.5%', reason: 'Input cost inflation sentiment.' },
        'TITAN': { impact: 'NEUTRAL', expMove: '0% to +1%', reason: 'Limited sensitivity to OPEC quota changes.' },
        'TATASTEEL': { impact: 'NEUTRAL', expMove: '-1% to +1%', reason: 'No material impact.' },
        'NIFTY50': { impact: 'MILD_BEARISH', expMove: '-0.8% to -1.5%', reason: 'Macro headwind due to imported inflation.' }
      },
      institutionalPlaybook: [
        'The OPEC Gap Fill Principle: OPEC headline cuts without real economic demand support fill their opening gap ~78% of the time within 25 trading sessions.',
        'Short-term Long / Medium-term Fade: Capture the immediate momentum on day 1-2, but do not chase after day 3.'
      ]
    },
    {
      id: '2020_COVID_DEMAND_CRASH_NEGATIVE_OIL',
      name: 'Covid-19 Global Lockdowns & Negative Oil Crash',
      startDate: '2020-03-09',
      category: 'FINANCIAL_PANIC',
      region: 'Global',
      severity: 'CRITICAL',
      keywords: ['covid', 'lockdown', 'negative oil', 'wti crash', 'demand collapse', 'pandemic', 'recession', 'bank run'],
      summary: 'Global aviation and ground transportation halted simultaneously; storage tanks filled to capacity, driving prompt WTI futures negative on expiry day.',
      commodityImpacts: {
        crude: { immediate: '-24.0%', day3: '-35.0%', day7: '-48.0%', day30: '-65.0%', peakReturn: '-100.0%+', tendency: 'Unprecedented physical storage saturation.' },
        gold: { immediate: '-3.5%', day3: '-8.2%', day7: '-12.0%', day30: '+14.0%', peakReturn: '+35.0%', tendency: 'Initial liquidity liquidation (margin calls forced gold selling), followed by multi-year bull run.' },
        silver: { immediate: '-8.0%', day3: '-15.0%', day7: '-28.0%', day30: '+25.0%', peakReturn: '+120.0%', tendency: 'Crashed first on industrial drag before massive rebound.' },
        natgas: { immediate: '-5.0%', day3: '-8.0%', day7: '-12.0%', day30: '-15.0%', peakReturn: '-25.0%', tendency: 'Industrial shutdown reduced electrical generation demand.' },
        copper: { immediate: '-4.0%', day3: '-9.0%', day7: '-18.0%', day30: '+15.0%', peakReturn: '+80.0%', tendency: 'Crashed on recession fear then initiated secular bull market on stimulus.' }
      },
      stockImpacts: {
        'ONGC': { impact: 'SEVERE_BEARISH', expMove: '-25% to -40%', reason: 'Crude realization below cost of extraction.' },
        'BPCL': { impact: 'VOLATILE_CRASH_THEN_EXPAND', expMove: '-20% then +30%', reason: 'Crude input plummeted; marketing margins expanded once travel resumed.' },
        'INDIGO': { impact: 'CATASTROPHIC_BEARISH', expMove: '-35% to -50%', reason: 'Complete grounding of domestic and international fleets.' },
        'ASIANPAINT': { impact: 'INITIAL_CRASH_THEN_OUTPERFORM', expMove: '-15% then +45%', reason: 'Input costs collapsed while pent-up home improvement demand surged.' },
        'TITAN': { impact: 'INITIAL_CRASH_THEN_RECOVERY', expMove: '-20% then +35%', reason: 'Gold asset appreciation boosted balance sheet equity.' },
        'TATASTEEL': { impact: 'CRASH_THEN_MEGA_CYCLE', expMove: '-35% then +200%', reason: 'Initiated historic commodity supercycle on stimulus.' },
        'NIFTY50': { impact: 'CIRCUIT_BREAKER_CRASH', expMove: '-38%', reason: 'Rapid panic liquidation triggering circuit breakers.' }
      },
      institutionalPlaybook: [
        'The Liquidity Dash Principle: During acute liquidity crises, even pristine safe havens (Gold, Silver) are dumped to cover equity margin calls. Wait for central bank liquidity backstops.',
        'The Super-Cycle Seed: Major commodity crashes eliminate high-cost producers, planting the seeds for multi-year bull markets.'
      ]
    },
    {
      id: '2025_US_GLOBAL_TARIFF_TRADE_WAR',
      name: 'US Comprehensive Trade Tariffs & Countermeasures',
      startDate: '2025-02-15',
      category: 'TARIFF_TRADE_WAR',
      region: 'US / China / Global',
      severity: 'HIGH',
      keywords: ['tariff', 'tariffs', 'trade war', 'china', 'export restriction', 'customs duty', 'fed', 'cpi', 'inflation', 'rate cut'],
      summary: 'Aggressive across-the-board tariffs imposed on steel, aluminium, consumer goods, and critical minerals, prompting reciprocal sanctions and inflation concerns.',
      commodityImpacts: {
        crude: { immediate: '-2.1%', day3: '-4.2%', day7: '-5.8%', day30: '-7.2%', peakReturn: '-9.5%', tendency: 'Bearish pressure due to expected slowdown in global industrial manufacturing.' },
        gold: { immediate: '+2.4%', day3: '+4.5%', day7: '+6.2%', day30: '+9.4%', peakReturn: '+12.0%', tendency: 'Prime beneficiary of reserve diversification and macro hedging.' },
        silver: { immediate: '-1.2%', day3: '+1.5%', day7: '+3.8%', day30: '+5.2%', peakReturn: '+7.0%', tendency: 'Initial industrial drag, followed by monetary catch-up to gold.' },
        natgas: { immediate: '-1.5%', day3: '-3.0%', day7: '-4.2%', day30: '-5.0%', peakReturn: '-6.5%', tendency: 'LNG trade frictions softened benchmarks.' },
        copper: { immediate: '-3.8%', day3: '-6.2%', day7: '-8.4%', day30: '-11.0%', peakReturn: '-13.2%', tendency: 'Primary casualty of global manufacturing friction.' }
      },
      stockImpacts: {
        'ONGC': { impact: 'BEARISH', expMove: '-3% to -6%', reason: 'Softer global crude benchmarks compress net revenues.' },
        'BPCL': { impact: 'BULLISH', expMove: '+2% to +5%', reason: 'Cheaper crude feedstock expands domestic retail fuel distribution margins.' },
        'INDIGO': { impact: 'BULLISH', expMove: '+3% to +6%', reason: 'Lower fuel expenses directly expand bottom-line profitability.' },
        'ASIANPAINT': { impact: 'STRONG_BULLISH', expMove: '+4% to +8%', reason: 'Deflating crude derivatives expand gross margins.' },
        'TITAN': { impact: 'STRONG_BULLISH', expMove: '+5% to +10%', reason: 'Gold bull market drives inventory valuation.' },
        'TATASTEEL': { impact: 'BEARISH', expMove: '-5% to -10%', reason: 'Direct tariff exposure and steel dumping risks.' },
        'NIFTY50': { impact: 'MIXED_SECTORAL_DIVERGENCE', expMove: '-1% to +2%', reason: 'Domestic consumption stocks rally while export metals drag.' }
      },
      institutionalPlaybook: [
        'The Tariff Divergence Rule: Trade wars hurt industrial base metals (Copper, Steel), but are accretive for Sovereign Safe Havens (Gold) and Domestic Consumption (Paints, FMCG).',
        'Sector Rotation: Rotate out of cyclicals/metals into downstream refiners, aviation, and paints when tariff escalation dominates headlines.'
      ]
    }
  ];

  const ASSET_DEPENDENCY_GRAPH = {
    crude: {
      name: 'Crude Oil (MCX)',
      correlatedStocks: [
        { symbol: 'ONGC', correlation: 0.78, beta: 0.85, type: 'UPSTREAM_PRODUCER', impactRule: 'Directly benefits from rising crude realizations.' },
        { symbol: 'OIL', correlation: 0.74, beta: 0.82, type: 'UPSTREAM_PRODUCER', impactRule: 'Tracks crude realization closely.' },
        { symbol: 'BPCL', correlation: -0.65, beta: -0.75, type: 'DOWNSTREAM_OMC', impactRule: 'Marketing margins compressed when crude surges without pump hikes.' },
        { symbol: 'IOC', correlation: -0.62, beta: -0.70, type: 'DOWNSTREAM_OMC', impactRule: 'Working capital drag when crude spikes.' },
        { symbol: 'INDIGO', correlation: -0.72, beta: -0.90, type: 'AVIATION_CONSUMER', impactRule: 'ATF jet fuel is ~40% of OpEx.' },
        { symbol: 'ASIANPAINT', correlation: -0.58, beta: -0.65, type: 'CHEMICAL_CONSUMER', impactRule: 'Crude-linked solvents and monomers impact gross margin.' }
      ]
    },
    gold: {
      name: 'Gold (MCX)',
      correlatedStocks: [
        { symbol: 'TITAN', correlation: 0.45, beta: 0.55, type: 'JEWELLERY_RETAIL', impactRule: 'Inventory gains vs near-term demand elasticity on sharp spikes.' },
        { symbol: 'MUTHOOTFIN', correlation: 0.62, beta: 0.70, type: 'GOLD_LENDING_NBFC', impactRule: 'Higher collateral value improves LTV headroom.' },
        { symbol: 'MANAPPURAM', correlation: 0.59, beta: 0.68, type: 'GOLD_LENDING_NBFC', impactRule: 'Underlying gold pledge value expands.' }
      ]
    },
    copper: {
      name: 'Copper / Base Metals (MCX)',
      correlatedStocks: [
        { symbol: 'HINDALCO', correlation: 0.82, beta: 1.10, type: 'NON_FERROUS_MINER', impactRule: 'Tracks global LME/MCX non-ferrous benchmarks.' },
        { symbol: 'VEDL', correlation: 0.76, beta: 1.15, type: 'DIVERSIFIED_MINER', impactRule: 'Zinc, aluminium, copper swings drive operating cash flows.' },
        { symbol: 'TATASTEEL', correlation: 0.65, beta: 0.95, type: 'STEEL_PRODUCER', impactRule: 'Tracks global industrial capex cycles.' }
      ]
    }
  };

  function getAllEvents() {
    return HISTORICAL_EVENTS;
  }

  function getEventById(id) {
    return HISTORICAL_EVENTS.find(e => e.id === id) || null;
  }

  function getDependencyGraph() {
    return ASSET_DEPENDENCY_GRAPH;
  }

  function matchHistoricalAnalog(text) {
    if (!text || typeof text !== 'string') {
      const fallback = HISTORICAL_EVENTS[0];
      return {
        event: fallback,
        matchConfidence: 50,
        matchingKeywords: [],
        commodityImpacts: fallback.commodityImpacts,
        stockImpacts: fallback.stockImpacts,
        institutionalPlaybook: fallback.institutionalPlaybook
      };
    }

    const clean = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
    let bestEvent = HISTORICAL_EVENTS[0];
    let maxScore = -1;
    let bestMatchedWords = [];

    for (const evt of HISTORICAL_EVENTS) {
      const matched = [];
      let score = 0;

      for (const kw of evt.keywords) {
        if (clean.includes(kw)) {
          matched.push(kw);
          score += (kw.length > 5 ? 2.5 : 1.5);
        }
      }

      if (clean.includes('war') || clean.includes('strike') || clean.includes('attack') || clean.includes('missile')) {
        if (evt.category === 'WAR_CONFLICT') score += 2.0;
      }
      if (clean.includes('opec') || clean.includes('quota') || clean.includes('saudi')) {
        if (evt.category === 'SUPPLY_SHOCK') score += 3.0;
      }
      if (clean.includes('tariff') || clean.includes('trade war') || clean.includes('duty') || clean.includes('fed') || clean.includes('cpi')) {
        if (evt.category === 'TARIFF_TRADE_WAR') score += 3.0;
      }

      if (score > maxScore) {
        maxScore = score;
        bestEvent = evt;
        bestMatchedWords = matched;
      }
    }

    const normalizedConfidence = Math.min(0.96, Math.max(0.45, (maxScore / 10.0) * 0.45 + 0.48));

    return {
      event: bestEvent,
      matchConfidence: Math.round(normalizedConfidence * 100),
      matchingKeywords: bestMatchedWords,
      commodityImpacts: bestEvent.commodityImpacts,
      stockImpacts: bestEvent.stockImpacts,
      institutionalPlaybook: bestEvent.institutionalPlaybook
    };
  }

  return {
    HISTORICAL_EVENTS,
    ASSET_DEPENDENCY_GRAPH,
    getAllEvents,
    getEventById,
    getDependencyGraph,
    matchHistoricalAnalog
  };

}));
