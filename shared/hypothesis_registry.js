/**
 * shared/hypothesis_registry.js — Formal Quantitative Hypothesis Lifecycle Registry
 * 
 * Enforces pre-registration governance and lifecycle state machine:
 * - Hypotheses must be formally registered and assigned an immutable ID.
 * - Hypotheses falsified on historical calibration (e.g. H1) are marked CLOSED.
 * - The holdout evaluation guard mechanically REFUSES evaluation on CLOSED hypotheses,
 *   preserving unseen prospective forward data strictly for future valid inquiries.
 */

const HYPOTHESIS_REGISTRY = {
  'H1': {
    id: 'H1',
    name: 'Multi-Timeframe Macro Trend (1H EMA-50) & Session VWAP Pullback with Candlestick Rejection',
    status: 'CLOSED_FALSIFIED_ON_CALIBRATION',
    preRegCommit: '6c5c743',
    preRegTag: 'h1-prereg-v1',
    closureCommit: '3b6e128',
    stoppingRule: 'Retrospective calibration Day-Block Bootstrap 95% CI upper bound <= ₹0.00 after realistic transaction friction',
    calibrationResult: {
      samplePeriod: '2026-08-07 to 2026-11-02',
      totalTrades: 665,
      sessions: 60,
      tradesPerSession: 11.08,
      grossExpectancy: +3.81,
      averageFeePerTrade: 11.06,
      netExpectancy: -7.25,
      profitFactor: 1.15,
      ci95Low: -12.62,
      ci95High: -1.94
    },
    holdoutStatus: 'LOCKED_AND_PRESERVED_UNTOUCHED',
    eligibleForHoldoutEvaluation: false,
    refusalReason: 'Hypothesis H1 was definitively FALSIFIED on retrospective calibration under Addendum 1 stopping rule (95% CI upper bound was -₹1.94, strictly <= ₹0.00). Unlocking holdout data on a dead hypothesis violates pre-registration and wastes unspent forward data.'
  }
};

/**
 * Retrieve hypothesis metadata by ID
 */
function getHypothesis(id) {
  if (!id) return null;
  return HYPOTHESIS_REGISTRY[id.toUpperCase()] || null;
}

/**
 * Check whether a hypothesis is currently eligible to open/evaluate prospective holdout data
 */
function isHypothesisEligibleForHoldout(id) {
  const hyp = getHypothesis(id);
  return Boolean(hyp && hyp.eligibleForHoldoutEvaluation);
}

/**
 * List all registered hypotheses
 */
function listRegisteredHypotheses() {
  return Object.values(HYPOTHESIS_REGISTRY);
}

module.exports = {
  HYPOTHESIS_REGISTRY,
  getHypothesis,
  isHypothesisEligibleForHoldout,
  listRegisteredHypotheses
};
