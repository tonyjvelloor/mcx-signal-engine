/**
 * risk.js — Canonical Risk Management & Position Sizing Engine
 * Shared across: Node.js server, Paper Trading Ledger, Frontend Terminals, and Backtest Simulator.
 * 
 * Enforces:
 * 1. Realistic Zerodha Fee Schedule (Intraday Equity vs MCX Futures).
 * 2. Absolute Loss Cap (₹50 total risk on ₹15,000 pilot capital).
 * 3. Volatility Floor: Stop-loss must be >= 1.0x ATR(14) to avoid market noise-outs.
 * 4. Fee-Adjusted R:R Gate: Net Reward / Net Risk >= 1.5. Rejects trades where fees eat the edge.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.RiskEngine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * Calculate realistic Zerodha round-trip fees and statutory taxes
   * 
   * Schedule:
   * - Equity Intraday (MIS):
   *     Brokerage: min(₹20, 0.03% turnover) per side
   *     STT: 0.025% on sell turnover
   *     Exchange Txn (NSE): 0.00297% turnover
   *     SEBI: ₹10 per crore (0.0001%)
   *     GST: 18% on (Brokerage + Exchange Txn + SEBI)
   *     Stamp Duty: 0.003% on buy turnover
   * 
   * - MCX Commodity Futures:
   *     Brokerage: min(₹20, 0.03% turnover) per side
   *     CTT: 0.01% on sell turnover
   *     Exchange Txn (MCX): 0.0021% turnover
   *     SEBI: ₹10 per crore (0.0001%)
   *     GST: 18% on (Brokerage + Exchange Txn + SEBI)
   *     Stamp Duty: 0.002% on buy turnover
   */
  function calculateZerodhaFees(params = {}) {
    const segment = params.segment || 'equity';
    const qty = Number(params.qty || params.quantity || 1);
    const lotMultiplier = Number(params.lotMultiplier || 1);

    let buyPrice = Number(params.buyPrice);
    let sellPrice = Number(params.sellPrice);

    // Dynamic aliasing for entry/exit & side callers
    if (!buyPrice || !sellPrice || isNaN(buyPrice) || isNaN(sellPrice)) {
      const side = (params.side || 'BUY').toUpperCase();
      const entry = Number(params.entry || params.price || 0);
      const exit = Number(params.exit || params.triggerPrice || params.sl || entry || 0);
      if (side === 'BUY') {
        buyPrice = entry;
        sellPrice = exit;
      } else {
        buyPrice = exit;
        sellPrice = entry;
      }
    }

    const buyVal = buyPrice * qty * lotMultiplier;
    const sellVal = sellPrice * qty * lotMultiplier;
    const totalTurnover = buyVal + sellVal;

    let buyBrokerage = 0;
    let sellBrokerage = 0;
    let stt = 0;
    let exchangeTxn = 0;
    let stampDuty = 0;
    const sebiCharges = totalTurnover * 0.000001; // ₹10 per crore

    let dpCharge = 0;

    if (segment === 'equity_delivery' || segment === 'equity_swing') {
      // Equity Delivery / Multi-Day Swing (holding overnight)
      buyBrokerage = 0; // Zerodha delivery brokerage is ₹0
      sellBrokerage = 0;
      stt = (buyVal * 0.001) + (sellVal * 0.001); // 0.1% on buy & 0.1% on sell
      exchangeTxn = totalTurnover * 0.0000297; // 0.00297%
      stampDuty = buyVal * 0.00015; // 0.015% on buy
      dpCharge = 15.93; // Flat DP charge (₹13.50 + 18% GST) on debit/sell
    } else if (segment === 'equity') {
      buyBrokerage = Math.min(20, buyVal * 0.0003);
      sellBrokerage = Math.min(20, sellVal * 0.0003);
      stt = sellVal * 0.00025; // 0.025% on sell
      exchangeTxn = totalTurnover * 0.0000297; // 0.00297%
      stampDuty = buyVal * 0.00003; // 0.003% on buy
    } else {
      // Commodity Futures (MCX)
      buyBrokerage = Math.min(20, buyVal * 0.0003);
      sellBrokerage = Math.min(20, sellVal * 0.0003);
      stt = sellVal * 0.0001; // CTT 0.01% on sell
      exchangeTxn = totalTurnover * 0.000021; // 0.0021%
      stampDuty = buyVal * 0.00002; // 0.002% on buy
    }

    const totalBrokerage = buyBrokerage + sellBrokerage;
    const gst = (totalBrokerage + exchangeTxn + sebiCharges) * 0.18;
    const totalFees = totalBrokerage + stt + exchangeTxn + sebiCharges + gst + stampDuty + dpCharge;

    const roundedTotal = Math.round(totalFees * 100) / 100;
    return {
      brokerage: Math.round(totalBrokerage * 100) / 100,
      stt: Math.round(stt * 100) / 100,
      exchangeTxn: Math.round(exchangeTxn * 100) / 100,
      gst: Math.round(gst * 100) / 100,
      stampDuty: Math.round(stampDuty * 100) / 100,
      totalFees: roundedTotal,
      total: roundedTotal
    };
  }

  /**
   * Sizing and Pre-Trade Risk Evaluation Gate
   * 
   * @param {Object} params
   * @param {string} params.side - 'BUY' or 'SELL'
   * @param {number} params.entry - Planned entry price
   * @param {number} params.sl - Planned stop loss price
   * @param {number} params.target - Planned target price
   * @param {number} params.lotMultiplier - Contract multiplier (default: 1)
   * @param {string} params.segment - 'equity' or 'commodity' (default: 'equity')
   * @param {number} params.maxLossTotal - Hard loss budget in ₹ (default: 50.0)
   * @param {number} params.minNetRR - Minimum acceptable fee-adjusted R:R (default: 1.5)
   * @param {number} params.atr - 14-period ATR for volatility floor (optional)
   * 
   * @returns {Object} { ok: boolean, qty: number, grossRisk, grossReward, totalPlannedLoss, netProfitAtTarget, netRR, reason?: string }
   */
  function sizeTrade(params) {
    const {
      side = 'BUY',
      entry,
      sl,
      target,
      lotMultiplier = 1,
      segment = 'equity',
      maxLossTotal = 50.0,
      minNetRR = 1.5,
      atr = null
    } = params;

    if (!entry || !sl || !target || entry <= 0 || sl <= 0 || target <= 0) {
      return { ok: false, reason: 'INVALID_PRICES: Entry, Stop Loss, and Target must be positive numbers.' };
    }

    // 1. Structural Geometry Validation
    const isBuy = side.toUpperCase() === 'BUY';
    if (isBuy) {
      if (sl >= entry) return { ok: false, reason: 'GEOMETRY_ERROR: Long trade stop loss must be strictly below entry price.' };
      if (target <= entry) return { ok: false, reason: 'GEOMETRY_ERROR: Long trade target must be strictly above entry price.' };
    } else {
      if (sl <= entry) return { ok: false, reason: 'GEOMETRY_ERROR: Short trade stop loss must be strictly above entry price.' };
      if (target >= entry) return { ok: false, reason: 'GEOMETRY_ERROR: Short trade target must be strictly below entry price.' };
    }

    const slDist = Math.abs(entry - sl);
    const targetDist = Math.abs(target - entry);

    // 2. Volatility Floor: Stop loss must respect market noise (>= 1.0x ATR)
    if (atr && Number(atr) > 0) {
      const minSafeStop = Number(atr) * 0.95; // 5% tolerance
      if (slDist < minSafeStop) {
        return {
          ok: false,
          reason: `NOISE_OUT_RISK: Planned stop distance (₹${slDist.toFixed(2)}) is narrower than 1x ATR(14) (₹${Number(atr).toFixed(2)}). Stops this tight are noise.`
        };
      }
    }

    // 3. Evaluate 1-unit minimum viability
    const perUnitRisk = slDist * lotMultiplier;
    const test1Fee = calculateZerodhaFees({
      segment,
      buyPrice: isBuy ? entry : sl,
      sellPrice: isBuy ? sl : entry,
      qty: 1,
      lotMultiplier
    }).totalFees;

    const minUnitPlannedLoss = perUnitRisk + test1Fee;
    if (minUnitPlannedLoss > maxLossTotal) {
      return {
        ok: false,
        reason: `RISK_CAP_EXCEEDED: Minimum size of 1 unit requires ₹${minUnitPlannedLoss.toFixed(2)} planned loss (₹${perUnitRisk.toFixed(2)} market risk + ₹${test1Fee.toFixed(2)} fees), exceeding your ₹${maxLossTotal.toFixed(2)} budget on ₹15,000 capital.`
      };
    }

    // 4. Determine largest integer quantity that fits within maxLossTotal
    let bestQty = 1;
    let low = 1, high = Math.max(1, Math.floor(maxLossTotal / perUnitRisk));

    for (let q = high; q >= 1; q--) {
      const feeAtStop = calculateZerodhaFees({
        segment,
        buyPrice: isBuy ? entry : sl,
        sellPrice: isBuy ? sl : entry,
        qty: q,
        lotMultiplier
      }).totalFees;
      const totalLoss = (perUnitRisk * q) + feeAtStop;
      if (totalLoss <= maxLossTotal) {
        bestQty = q;
        break;
      }
    }

    // 5. Calculate Final Risk, Reward, Fees and Fee-Adjusted R:R
    const grossRisk = perUnitRisk * bestQty;
    const grossReward = targetDist * lotMultiplier * bestQty;

    const stopFees = calculateZerodhaFees({
      segment,
      buyPrice: isBuy ? entry : sl,
      sellPrice: isBuy ? sl : entry,
      qty: bestQty,
      lotMultiplier
    }).totalFees;

    const targetFees = calculateZerodhaFees({
      segment,
      buyPrice: isBuy ? entry : target,
      sellPrice: isBuy ? target : entry,
      qty: bestQty,
      lotMultiplier
    }).totalFees;

    const totalPlannedLoss = grossRisk + stopFees;
    const netProfitAtTarget = grossReward - targetFees;

    // Fee-adjusted Net R:R = Net Reward / Total Risk
    const netRR = (grossReward - targetFees) / (grossRisk + stopFees);

    // 6. Fee-Adjusted R:R Gate: Rejects trades where transaction costs consume the edge
    if (netRR < minNetRR) {
      return {
        ok: false,
        reason: `FEE_DRAG_REJECTED: Fee-adjusted R:R is 1:${netRR.toFixed(2)} (below 1:${minNetRR}). Gross reward ₹${grossReward.toFixed(2)} loses ₹${targetFees.toFixed(2)} in fees. Expectancy is unviable.`
      };
    }

    return {
      ok: true,
      side: isBuy ? 'BUY' : 'SELL',
      entryPrice: Math.round(entry * 100) / 100,
      stopLoss: Math.round(sl * 100) / 100,
      target: Math.round(target * 100) / 100,
      qty: bestQty,
      slDist: Math.round(slDist * 100) / 100,
      targetDist: Math.round(targetDist * 100) / 100,
      grossRisk: Math.round(grossRisk * 100) / 100,
      grossReward: Math.round(grossReward * 100) / 100,
      stopFees: Math.round(stopFees * 100) / 100,
      targetFees: Math.round(targetFees * 100) / 100,
      totalPlannedLoss: Math.round(totalPlannedLoss * 100) / 100,
      netProfitAtTarget: Math.round(netProfitAtTarget * 100) / 100,
      netRR: Math.round(netRR * 100) / 100
    };
  }

  // MCX Commodity Specifications, Multipliers & Estimated Zerodha SPAN+Exposure Margins
  const MCX_SPECS = {
    'GOLDPETAL': { name: 'Gold Petal', multiplier: 1, unit: '₹/g', tickSize: 1.0, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 1750 },
    'GOLDM':     { name: 'Gold Mini', multiplier: 10, unit: '₹/10g', tickSize: 1.0, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 16500 },
    'GOLD':      { name: 'Gold Mega', multiplier: 100, unit: '₹/10g', tickSize: 1.0, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 165000 },
    'SILVERMIC': { name: 'Silver Micro', multiplier: 1, unit: '₹/kg', tickSize: 1.0, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 26000 },
    'SILVERM':   { name: 'Silver Mini', multiplier: 5, unit: '₹/kg', tickSize: 1.0, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 130000 },
    'SILVER':    { name: 'Silver Mega', multiplier: 30, unit: '₹/kg', tickSize: 1.0, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 780000 },
    'CRUDEOILM': { name: 'Crude Oil Mini', multiplier: 10, unit: '₹/bbl', tickSize: 1.0, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 15500 },
    'CRUDEOIL':  { name: 'Crude Oil Mega', multiplier: 100, unit: '₹/bbl', tickSize: 1.0, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 155000 },
    'NATGASM':   { name: 'Natural Gas Mini', multiplier: 250, unit: '₹/MMBtu', tickSize: 0.10, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 16000 },
    'NATGAS':    { name: 'Natural Gas Mega', multiplier: 1250, unit: '₹/MMBtu', tickSize: 0.10, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 80000 },
    'COPPER':    { name: 'Copper', multiplier: 2500, unit: '₹/kg', tickSize: 0.05, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 38000 },
    'ZINC':      { name: 'Zinc', multiplier: 5000, unit: '₹/kg', tickSize: 0.05, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 45000 },
    'ALUM':      { name: 'Aluminium', multiplier: 5000, unit: '₹/kg', tickSize: 0.05, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 42000 },
    'COTTON':    { name: 'Cotton Candy', multiplier: 48, unit: '₹/bale', tickSize: 10.0, exchange: 'MCX', segment: 'commodity', baseLot: 1, estMargin: 28000 }
  };

  // NSE MIS (5x Intraday) / ETF Proxies compatible with ₹10,000 Zerodha capital
  const NSE_PROXY_SPECS = {
    'GOLDBEES':   { name: 'Nippon Gold ETF', multiplier: 1, unit: '₹/unit', tickSize: 0.01, exchange: 'NSE', segment: 'equity', baseLot: 1, misLeverage: 5, refPrice: 72 },
    'SILVERBEES': { name: 'Nippon Silver ETF', multiplier: 1, unit: '₹/unit', tickSize: 0.01, exchange: 'NSE', segment: 'equity', baseLot: 1, misLeverage: 5, refPrice: 95 },
    'ONGC':       { name: 'ONGC (Crude Proxy)', multiplier: 1, unit: '₹/share', tickSize: 0.05, exchange: 'NSE', segment: 'equity', baseLot: 1, misLeverage: 5, refPrice: 260 },
    'GAIL':       { name: 'GAIL India (Gas Proxy)', multiplier: 1, unit: '₹/share', tickSize: 0.05, exchange: 'NSE', segment: 'equity', baseLot: 1, misLeverage: 5, refPrice: 200 },
    'HINDCOPPER': { name: 'Hindustan Copper (Copper Proxy)', multiplier: 1, unit: '₹/share', tickSize: 0.05, exchange: 'NSE', segment: 'equity', baseLot: 1, misLeverage: 5, refPrice: 290 },
    'NATIONALUM': { name: 'NALCO (Aluminium Proxy)', multiplier: 1, unit: '₹/share', tickSize: 0.05, exchange: 'NSE', segment: 'equity', baseLot: 1, misLeverage: 5, refPrice: 240 },
    'VEDL':       { name: 'Vedanta (Zinc/Metals Proxy)', multiplier: 1, unit: '₹/share', tickSize: 0.05, exchange: 'NSE', segment: 'equity', baseLot: 1, misLeverage: 5, refPrice: 450 },
    'WELSPUNLIV': { name: 'Welspun Living (Cotton Proxy)', multiplier: 1, unit: '₹/share', tickSize: 0.05, exchange: 'NSE', segment: 'equity', baseLot: 1, misLeverage: 5, refPrice: 160 }
  };

  function getContractSpec(symbol) {
    if (!symbol) return { name: 'Default Equity', multiplier: 1, unit: '₹/share', tickSize: 0.05, exchange: 'NSE', segment: 'equity', baseLot: 1 };
    const clean = symbol.toUpperCase().replace('NSE:', '').replace('MCX:', '').replace('.NS', '').replace('.BO', '');
    if (NSE_PROXY_SPECS[clean]) return NSE_PROXY_SPECS[clean];
    for (const key of Object.keys(NSE_PROXY_SPECS)) {
      if (clean.startsWith(key)) return NSE_PROXY_SPECS[key];
    }
    const sortedMcxKeys = Object.keys(MCX_SPECS).sort((a, b) => b.length - a.length);
    for (const key of sortedMcxKeys) {
      if (clean === key || clean.startsWith(key)) return MCX_SPECS[key];
    }
    return { name: clean, multiplier: 1, unit: '₹/share', tickSize: 0.05, exchange: 'NSE', segment: 'equity', baseLot: 1 };
  }

  /**
   * Smart ₹10,000 Margin & Instrument Router for Zerodha
   * Checks if a commodity's primary MCX Mini contract fits within user capital (default ₹10,000),
   * and routes to MCX:GOLDPETAL or NSE MIS 5x liquid proxies when MCX margin exceeds capital.
   */
  function getTenKExecutionRoute({ commodityId = '', symbol = '', capital = 10000, price = 0, riskBudget = 125 } = {}) {
    const cap = Math.max(1000, Number(capital) || 10000);
    const budget = Math.max(25, Number(riskBudget) || 125);
    const symUpper = String(symbol || '').toUpperCase();

    let cid = String(commodityId || '').toLowerCase().trim();
    if (!cid) {
      if (symUpper.includes('GOLD')) cid = 'gold';
      else if (symUpper.includes('SILVER')) cid = 'silver';
      else if (symUpper.includes('CRUDE')) cid = 'crude';
      else if (symUpper.includes('NATGAS')) cid = 'natgas';
      else if (symUpper.includes('COPPER')) cid = 'copper';
      else if (symUpper.includes('ZINC')) cid = 'zinc';
      else if (symUpper.includes('ALUM')) cid = 'alum';
      else if (symUpper.includes('COTTON')) cid = 'cotton';
      else cid = 'gold';
    }

    const defaultMcxMap = {
      gold: 'GOLDM',
      silver: 'SILVERMIC',
      crude: 'CRUDEOILM',
      natgas: 'NATGASM',
      copper: 'COPPER',
      zinc: 'ZINC',
      alum: 'ALUM',
      cotton: 'COTTON'
    };

    const proxyMap = {
      gold: 'GOLDBEES',
      silver: 'SILVERBEES',
      crude: 'ONGC',
      natgas: 'GAIL',
      copper: 'HINDCOPPER',
      alum: 'NATIONALUM',
      zinc: 'VEDL',
      cotton: 'WELSPUNLIV'
    };

    const mcxKey = symUpper.includes('GOLDPETAL') ? 'GOLDPETAL' : (defaultMcxMap[cid] || 'GOLDM');
    const mcxSpec = MCX_SPECS[mcxKey] || MCX_SPECS.GOLDM;
    const mcxMargin = mcxSpec.estMargin || 16500;
    const mcxFits = cap >= mcxMargin;

    const mcxContract = {
      symbol: mcxKey,
      exchange: 'MCX',
      name: mcxSpec.name,
      multiplier: mcxSpec.multiplier,
      unit: mcxSpec.unit,
      product: 'NRML',
      estMargin: mcxMargin,
      fitsCapital: mcxFits,
      marginWarning: !mcxFits,
      shortfall: Math.max(0, Math.round(mcxMargin - cap)),
      maxLots: mcxFits ? Math.max(1, Math.floor(cap / mcxMargin)) : 0
    };

    const proxySym = proxyMap[cid] || 'GOLDBEES';
    const proxySpec = NSE_PROXY_SPECS[proxySym];
    const proxyRefPrice = proxySpec.refPrice || 100;
    const misLeverage = proxySpec.misLeverage || 5; // 20% intraday margin
    const proxyMarginPerShare = +(proxyRefPrice / misLeverage).toFixed(2);
    const estStopPts = Math.max(0.5, proxyRefPrice * 0.015);
    const estFees = 15;
    const maxQtyByRisk = Math.max(1, Math.floor(Math.max(1, budget - estFees) / estStopPts));
    const maxQtyByMargin = Math.max(1, Math.floor((cap * 0.85) / Math.max(1, proxyMarginPerShare)));
    const proxyRecQty = Math.min(maxQtyByRisk, maxQtyByMargin);

    const secondaryProxy = {
      symbol: proxySym,
      tradingsymbol: proxySym,
      exchange: 'NSE',
      name: proxySpec.name,
      product: 'MIS',
      segment: 'equity',
      multiplier: 1,
      misLeverage,
      estPrice: proxyRefPrice,
      marginPerUnit: proxyMarginPerShare,
      recommendedQty: proxyRecQty,
      estMarginUsed: +(proxyRecQty * proxyMarginPerShare).toFixed(2),
      riskBudget: budget,
      estStopDist: +estStopPts.toFixed(2),
      fitsCapital: proxyMarginPerShare <= cap,
      correlationNote: `Liquid 5x MIS NSE proxy tracking ${cid.toUpperCase()} direction`
    };

    let tenKRoute;
    if (cid === 'gold') {
      const petalSpec = MCX_SPECS.GOLDPETAL;
      const petalMargin = petalSpec.estMargin; // ~₹1,750 per 1g lot
      const petalPrice = price > 25000 ? price / 10 : (price > 0 ? price : 7800);
      const safeMaxLots = Math.min(4, Math.max(1, Math.floor(cap / petalMargin)));
      const petalFees = 28;
      const safeStopDist = Math.max(25, +(budget - petalFees).toFixed(2));
      tenKRoute = {
        symbol: 'GOLDPETAL',
        tradingsymbol: 'GOLDPETAL',
        exchange: 'MCX',
        name: petalSpec.name,
        product: 'NRML',
        segment: 'commodity',
        multiplier: petalSpec.multiplier,
        unit: petalSpec.unit,
        estPrice: Math.round(petalPrice * 100) / 100,
        marginPerUnit: petalMargin,
        recommendedQty: 1,
        maxLotsWithinCapital: safeMaxLots,
        estMarginUsed: petalMargin,
        riskBudget: budget,
        maxSafeStopPts: safeStopDist,
        fitsCapital: cap >= petalMargin,
        isDirectMcx: true,
        secondaryProxy,
        reason: `Primary ₹10K MCX contract: GOLDPETAL (~₹${petalMargin.toLocaleString('en-IN')}/lot fits up to ${safeMaxLots} lots safely). Secondary: NSE:${proxySym}.`
      };
    } else if (mcxFits) {
      tenKRoute = {
        symbol: mcxKey,
        tradingsymbol: mcxKey,
        exchange: 'MCX',
        name: mcxSpec.name,
        product: 'NRML',
        segment: 'commodity',
        multiplier: mcxSpec.multiplier,
        unit: mcxSpec.unit,
        estPrice: price > 0 ? price : 0,
        marginPerUnit: mcxMargin,
        recommendedQty: 1,
        maxLotsWithinCapital: mcxContract.maxLots,
        estMarginUsed: mcxMargin,
        riskBudget: budget,
        fitsCapital: true,
        isDirectMcx: true,
        secondaryProxy,
        reason: `MCX:${mcxKey} fits your ₹${cap.toLocaleString('en-IN')} capital (~₹${mcxMargin.toLocaleString('en-IN')}/lot).`
      };
    } else {
      tenKRoute = {
        ...secondaryProxy,
        isDirectMcx: false,
        secondaryProxy,
        reason: `MCX:${mcxKey} requires ~₹${mcxMargin.toLocaleString('en-IN')} margin (> ₹${cap.toLocaleString('en-IN')} capital). Routed to NSE:${proxySym} (MIS 5x, ~₹${secondaryProxy.estMarginUsed.toLocaleString('en-IN')} margin for ${proxyRecQty} shares).`
      };
    }

    return {
      ok: true,
      commodityId: cid,
      capital: cap,
      riskBudget: budget,
      mcxContract,
      tenKRoute,
      secondaryRoute: secondaryProxy
    };
  }

  return {
    calculateZerodhaFees,
    sizeTrade,
    getContractSpec,
    getTenKExecutionRoute,
    MCX_SPECS,
    NSE_PROXY_SPECS
  };
}));
