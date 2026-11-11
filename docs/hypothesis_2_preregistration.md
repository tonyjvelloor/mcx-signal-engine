# Pre-Registration: Hypothesis 2 (H2)
## TimesFM 2.5 Zero-Shot Quantile Forecast Filter on NSE 5-Minute Bars

> **Status:** LOCKED & PRE-REGISTERED before any H2 code exists.
> **Registration date:** 2026-11-11
> **Immutable tag:** `h2-prereg-v1` (set on the commit that introduces this file; no H2 code is present at that commit)
> **Multiple-testing budget:** k = 5 hypotheses, alpha = 0.01 (Bonferroni-adjusted bar p < 0.01)
> **Governance:** `shared/hypothesis_registry.js` entry `H2`; holdout guard in `backtest/pool.js` applies unchanged.

---

### 1. Hypothesis
A pretrained, zero-shot time-series foundation model (TimesFM 2.5, 200M parameters,
`google/timesfm-2.5-200m-pytorch`) produces a quantile forecast of the next 12 five-minute closes.
**Claim:** trading only when the *entire* uncertain side of the forecast clears the round-trip
transaction cost yields positive net expectancy that a matched random-entry null cannot reproduce.

The model is never fine-tuned. There is nothing fitted to our data, so calibration data is not
contaminated by training. All parameters below are fixed in advance. No sweeps.

### 2. Fixed configuration (no tuning permitted)
| Item | Value |
| :--- | :--- |
| Model | TimesFM 2.5 200M (PyTorch), zero-shot, weights as published |
| Universe | RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK, BHARTIARTL, SBIN, ITC, LT, KOTAKBANK, AXISBANK, MARUTI |
| Bars | 5-minute, corporate-action adjusted, from `market_data.db` |
| Context | previous 512 closes (ends at signal bar close; no future bars) |
| Horizon | 12 bars (1 hour) |
| ForecastConfig | `max_context=512, max_horizon=12, normalize_inputs=True, use_continuous_quantile_head=True, infer_is_positive=True, fix_quantile_crossing=True` |
| Signal times | session bars 12, 18, 24, ... 66 (every 6th bar), signal evaluated at bar close |
| Entry | next bar open (t+1), plus canonical slippage + half-spread |
| Exit | 12 bars after entry (time exit) or stop-loss or 15:15 IST square-off, whichever is first |
| Stop-loss | 1.5 x ATR(14) from entry; position size from canonical `risk.js` |
| Concurrency | max one open position per symbol |
| Long rule | forecast **P10 at horizon 12 > entry reference close + C** |
| Short rule | forecast **P90 at horizon 12 < entry reference close - C** |
| C (cost hurdle) | canonical round-trip fee (`risk.js`) + slippage, per share, at the sized quantity |
| Excluded sessions | special sessions (Muhurat) by explicit date, via `shared/nse_holidays.js` |

### 3. Data partition (locked)
- **Calibration:** all archived sessions through **2026-11-02** inclusive. One single run, one configuration.
- **Holdout:** all sessions **after 2026-11-02**. Archived passively, never evaluated. Guarded by `--final --hypothesis H2`,
  dual floor (N >= 150 trades AND S >= 60 sessions) and the hash-chained audit log.
- H1 is CLOSED and does not touch the holdout.

### 4. Metrics, benchmarks and decision rule
Primary: net expectancy per trade (INR) after the exact fee model, with 95% **trading-day block bootstrap** CI.

Benchmarks (all computed on identical calibration data):
1. **Matched random-entry null:** same hold time, stop geometry, trade count per symbol-day; 1,000 permutations x 5 seeds [42, 101, 777, 1337, 2026].
2. **Persistence forecast** (next 12 closes = last close): diagnostic only. It never trades.
3. Directional accuracy of the forecast median sign vs realized 12-bar sign, with a two-sided binomial test. Diagnostic only.

**Decision rule (all pre-committed):**
- **H2 FALSIFIED on calibration** if the day-block bootstrap CI **upper bound <= INR 0.00**, OR trade count < 30 (declared UNTESTABLE, not positive), OR gross expectancy per trade < average fee per trade.
- **H2 ADVANCES** to forward-data accumulation only if CI **lower bound > 0** AND empirical p < 0.01 versus the matched null.
- Anything else: **INCONCLUSIVE**, collect more data. It is **not** a pass.
- A falsified or untestable H2 is marked `CLOSED` in the registry. The result is reported as is.

### 5. Prohibited
- Changing context length, horizon, quantile thresholds, signal spacing, stop multiple or universe after seeing any result.
- Inverting / fading signals. Re-running with altered parameters to "find" a pass.
- Opening the holdout on a closed hypothesis, or before both floors are met.
- Wiring H2 into any live or paper signal path before it advances through the forward holdout.

### 6. Honest expectations (written before results)
At 5-minute resolution prices are close to a random walk and the cost hurdle is about INR 10 per trade.
The prior probability that H2 passes is low. A falsified H2 is a valid and useful result.
