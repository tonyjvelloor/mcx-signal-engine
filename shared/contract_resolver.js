/**
 * shared/contract_resolver.js — Canonical MCX Commodity Contract Expiry Resolver
 * Resolves base commodity identifiers (e.g. CRUDEOILM, GOLDPETAL, SILVERMIC) into
 * exact Zerodha Kite trading symbols (e.g. CRUDEOILM26NOVFUT, GOLDPETAL26NOVFUT).
 * 
 * Handles month roll-overs before tender period to protect traders from delivery margins.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.ContractResolver = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  // MCX Commodity Contract Expiry & Roll Rules (Approximate tender/expiry day of month)
  const COMMODITY_ROLL_RULES = {
    'CRUDEOILM': { rollDay: 17, cycle: 'all' },    // Expires ~19th-21st, roll 3 days before
    'CRUDEOIL':  { rollDay: 17, cycle: 'all' },
    'NATGASM':   { rollDay: 22, cycle: 'all' },    // Expires ~25th-27th, roll 3 days before
    'NATGAS':    { rollDay: 22, cycle: 'all' },
    'GOLDPETAL': { rollDay: 24, cycle: 'all' },    // Monthly contract
    'GOLDM':     { rollDay: 23, cycle: [1, 3, 5, 7, 9, 11] }, // Bi-monthly: Feb, Apr, Jun, Aug, Oct, Dec (0-indexed)
    'GOLD':      { rollDay: 23, cycle: [1, 3, 5, 7, 9, 11] },
    'SILVERMIC': { rollDay: 22, cycle: [1, 3, 5, 7, 10] },    // Feb, Apr, Jun, Aug, Nov
    'SILVERM':   { rollDay: 22, cycle: [1, 3, 5, 7, 10] },
    'SILVER':    { rollDay: 22, cycle: [2, 4, 6, 8, 11] },    // Mar, May, Jul, Sep, Dec
    'COPPER':    { rollDay: 24, cycle: 'all' },
    'ZINC':      { rollDay: 24, cycle: 'all' },
    'ALUM':      { rollDay: 24, cycle: 'all' },
    'COTTON':    { rollDay: 24, cycle: 'all' }
  };

  /**
   * Resolves a base symbol to its active near-month Zerodha MCX trading symbol.
   * @param {string} symbol - e.g. "CRUDEOILM", "GOLDPETAL", "SILVERMIC"
   * @param {Date} [referenceDate] - optional date, defaults to current IST date
   * @returns {Object} { tradingsymbol, baseSymbol, expiryMonth, expiryYear, isRolledOver, exchange: 'MCX' }
   */
  function resolveContractExpiry(symbol, referenceDate) {
    if (!symbol) return { tradingsymbol: '', baseSymbol: '', exchange: 'NSE' };
    const cleanSym = String(symbol).toUpperCase().replace('.NS', '').replace('.BO', '').replace(/2[0-9][A-Z]{3}FUT$/, '');

    // If it is not an MCX commodity or is an equity, return as-is
    if (!COMMODITY_ROLL_RULES[cleanSym]) {
      return {
        tradingsymbol: symbol,
        baseSymbol: cleanSym,
        exchange: 'NSE',
        isCommodity: false
      };
    }

    const d = referenceDate ? new Date(referenceDate) : new Date();
    // Convert to IST
    const istStr = d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const ist = new Date(istStr);

    let year = ist.getFullYear();
    let month = ist.getMonth(); // 0 = Jan, 11 = Dec
    const day = ist.getDate();

    const rule = COMMODITY_ROLL_RULES[cleanSym];
    let isRolledOver = false;

    // Check if we need to roll over to next contract
    if (day >= rule.rollDay) {
      month++;
      isRolledOver = true;
      if (month > 11) {
        month = 0;
        year++;
      }
    }

    // If commodity has a specific cycle (e.g. bi-monthly), find next valid contract month
    if (Array.isArray(rule.cycle)) {
      while (!rule.cycle.includes(month)) {
        month++;
        isRolledOver = true;
        if (month > 11) {
          month = 0;
          year++;
        }
      }
    }

    const yr2 = String(year).slice(-2);
    const mmm = MONTHS[month];
    const tradingsymbol = `${cleanSym}${yr2}${mmm}FUT`;

    return {
      tradingsymbol,
      baseSymbol: cleanSym,
      exchange: 'MCX',
      expiryMonth: mmm,
      expiryYear: year,
      isRolledOver,
      isCommodity: true
    };
  }

  return {
    resolveContractExpiry,
    COMMODITY_ROLL_RULES,
    MONTHS
  };
}));
