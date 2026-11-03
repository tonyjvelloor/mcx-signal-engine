# Institutional Strategy Pre-Registration: Hypothesis 1
## Multi-Timeframe Trend Filter & Session VWAP Mean Reversion

> **Status:** LOCKED & PRE-REGISTERED (Awaiting Prospective Forward Data Accumulation)  
> **Registration Date:** 2026-11-03  
> **Authors:** Quantitative Engineering Team & User  
> **Target Universe:** 12 Liquid NSE Large-Caps (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`, `BHARTIARTL`, `SBIN`, `ITC`, `LT`, `KOTAKBANK`, `AXISBANK`, `MARUTI`)  
> **Data Provenance:** Local SQLite Archive (`market_data.db`) via Yahoo Finance Proxy (Unofficial NSE Intraday Delayed Feed)  
> **Execution Engine:** Zero Lookahead Walk-Forward Sim (`backtest/sim.js`)  
> **Cost Model:** Canonical `risk.js` (Zerodha NSE Cash Equity Schedule + 1 Tick Slippage + 0.10 Spread)  

---

### 1. Context & Scientific Boundaries
In retrospective walk-forward backtests across ~52,500 5-minute bars (August 7, 2026 to November 2, 2026), three specific retail lagging indicator rules failed to achieve positive net expectancy:
- **EMA (9/21) Crossover:** 142 trades, 33.8% win rate, Expectancy **-₹5.77 / trade** (Block Bootstrap 95% CI: ₹-15.26 to ₹3.48).
- **EMA (20/50) + RSI Pullback:** 435 trades, 25.3% win rate, Expectancy **-₹15.91 / trade** (Block Bootstrap 95% CI: ₹-20.82 to ₹-10.90).
- **Supertrend (10, 3) + Stoch + ADX:** 322 trades, 25.2% win rate, Expectancy **-₹16.37 / trade** (Block Bootstrap 95% CI: ₹-23.11 to ₹-9.21).

**Careful Scientific Phrasing:**  
These results demonstrate that **these specific indicator rules** produced negative net expectancy on this 12-symbol universe over this 3-month sample. They do not constitute a universal proof about all trend-following or breakout models across all assets and time horizons.

However, an empirical random-entry benchmark loses **-₹9.75 per trade**, establishing that statutory brokerage, STT, exchange turnover fees, GST, stamp duty, and execution slippage create a **~₹9.75 / trade hurdle**. Any viable quantitative model must overcome this hurdle before generating a single rupee of true profit.

---

### 2. Theoretical Hypothesis & Failure Mode Analysis
The observable failure mode of the three tested retail rules on 5-minute bars was **chasing overextended impulses**:
- When 5-minute Supertrend turns green or an EMA crossover prints, price has already traveled multiple bars. Buying at that point purchases the exhaustion of the impulse immediately prior to an intraday mean-reverting pullback.
- In choppy or range-bound intraday sessions, this produces repeated stop-outs, driving the win rate down to ~25%.

**Hypothesis 1 Core Thesis:**
To overcome the ~₹9.75 statutory cost hurdle, an intraday strategy must:
1. Align with the **higher-timeframe macro trend (1-Hour)** to capture institutional momentum.
2. Wait for an intraday **mean-reverting pullback into value (Session VWAP)** to enter at a discount rather than at peak impulse extension.
3. Require an explicit **candlestick price rejection trigger** (Hammer / Engulfing) confirming responsive buyers/sellers defending VWAP.
4. Set an asymmetric **1:3.0 Target Multiple** so that infrequent winning trades substantially exceed accumulated transaction drag.

---

### 3. Fixed Conventional Parameters (Zero Tuning / No Parameter Sweeps)
To prevent $p$-hacking, data snooping, and overfitting, all parameters are fixed in advance based on standard market convention:

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| **Higher-Timeframe (HTF)** | 1-Hour (`resampleBars(bars5m, 12)`) | Filters 5m noise while capturing multi-session institutional direction. |
| **HTF Trend Indicator** | 50-Period Exponential Moving Average (EMA) | Conventional benchmark. Requires 50 hourly bars (~7 sessions) warmup. |
| **HTF Trend Filter** | **Bullish:** 1H Close > 1H EMA(50) & EMA Slope > 0<br>**Bearish:** 1H Close < 1H EMA(50) & EMA Slope < 0 | Binary regime filter. Zero counter-trend positions permitted. |
| **Intraday Value Anchor** | Session VWAP ($\sum P \cdot V / \sum V$) | Reset daily at 09:15 IST. Benchmark for institutional fair value. |
| **Pullback Tolerance Band** | Within $0.20 \times \text{ATR}(14)$ of Session VWAP | Price must test or penetrate the VWAP band. No chasing when extended. |
| **Rejection Triggers** | **Long:** Strict Hammer OR Bullish Engulfing<br>**Short:** Strict Shooting Star OR Bearish Engulfing | Confirms responsive liquidity reacting at the VWAP level. |
| **Stop Loss Distance** | $1.5 \times \text{ATR}(14)$ beyond candle extreme | Volatility-adaptive stop; respects canonical volatility floor ($\ge 1.0\times\text{ATR}$). |
| **Target Multiple** | $1 : 3.0$ Gross R:R ($\text{Net R:R} \ge 2.2$) | Necessary to dilute the ~₹9.75/trade transaction cost drag. |
| **Execution Modeling** | Signal at Bar $t$ close $\implies$ Fill at Bar $t+1$ Open | Strict zero lookahead. Includes 1 tick slippage + half-spread. |
| **EOD Square-Off** | 15:15 IST (Bar 72 of session) | Force closes any open intraday trade before the 15:20 auction. Zero overnight risk. |

---

### 4. Matching Null Hypothesis Baseline Specification
To ensure that Hypothesis 1 is tested against a mathematically fair null baseline, the random entry generator must mirror H1's exit geometry:
- **Matched Exit Geometry:** Exact same $1.5\times\text{ATR}(14)$ stop loss, exact same $1:3.0$ target multiple, and exact same 15:15 IST intraday close.
- **Matched Session Window:** Random entries restricted to 09:30 to 15:00 IST (excluding opening/closing auction extremes).
- **Matched Long/Short Balance:** 50% Long / 50% Short random allocation.
- This isolates the informational quality of the entry setup, ensuring H1 cannot "beat" or "lose to" the baseline purely due to exit geometry interactions with transaction costs.

---

### 5. Data Partition: Retrospective Calibration vs True Locked Holdout
Because observations from the existing archive (August 7 to November 2, 2026) were inspected to formulate Hypothesis 1, **none of that data qualifies as an unseen holdout**.

- **Retrospective Calibration Set (Exploratory Only):**
  - Date Range: August 7, 2026 to November 2, 2026 (~52,575 bars across 12 large-caps).
  - Purpose: Calibration, sanity checking, and code verification.
- **True Locked Holdout (Prospective Forward Data Only):**
  - Date Range: **All live market sessions accumulated post-November 2, 2026**.
  - Rule: **Hypothesis 1 will NOT be evaluated on the holdout partition until forward collection accumulates.** Zero backfill. True out-of-sample forward execution only.

---

### 6. Statistical Framework & 3-Outcome Decision Matrix
Because 12 large-cap equities move contemporaneously with the broad Nifty 50 index on any given trading day, individual trades are not cross-sectionally independent.

#### Required Statistical Procedures:
1. **Block Bootstrap by Trading Day:**
   - Both the 95% Confidence Interval and the Monte Carlo permutation tests must resample **entire calendar trading days** with replacement, preserving intra-day correlation across stocks.
2. **Bonferroni Multi-Testing Correction:**
   - Current count of tested strategy families: $k = 4$ (Baseline, Beginner, Pro, Hypothesis 1).
   - Significance threshold:
     $$\alpha_{\text{adjusted}} = \frac{0.05}{k} = \frac{0.05}{4} = 0.0125 \quad (p < 0.0125)$$
   - *Rule:* If variants or parameter sweeps of H1 are tested in the future, $k$ must be incremented accordingly.
3. **Statistical Power & Sample Size Requirement:**
   - H1's strict filters (1H trend alignment + VWAP touch + rejection candle) will yield substantially fewer trades per session than retail breakout rules.
   - Minimum trade count threshold: **$\ge 150$ completed prospective holdout trades**.

#### Formal 3-Outcome Matrix:
- **Outcome A (Statistically Validated Edge):**
  - Total Prospective Trades $\ge 150$.
  - Empirical $p < 0.0125$ against the matched null baseline under trading-day block bootstrap.
  - Stressed Cost Test (2x slippage, 1.5x fees) 95% Bootstrap CI Lower Bound $> ₹0.00$.
  - *Action:* Proceed to 4–8 weeks forward paper trading before allocating micro live capital.
- **Outcome B (Falsified / No Edge Demonstrated):**
  - Total Prospective Trades $\ge 150$.
  - Empirical $p \ge 0.0125$ OR negative net expectancy.
  - *Action:* Accept "no edge found" with finality. Permanently lock live trading and maintain the platform strictly as an institutional paper-trading, risk governance, and journaling workstation.
- **Outcome C (Inconclusive / Underpowered):**
  - Total Prospective Trades $< 150$.
  - *Action:* Explicitly report as **"Inconclusive due to insufficient sample size"**. Do NOT declare "no edge" prematurely. Continue prospective forward data accumulation until 150 trades are recorded or a pre-agreed sunset horizon is reached.

---

### Addendum 1 (2026-11-03): Calibration Stopping Rule & Empirical Power Projection

> **Provenance Transparency Note:**  
> The baseline pre-registration (Sections 1–6 above) was locked and committed at git commit [`6c5c743`](https://github.com/tonyjvelloor/mcx-signal-engine/commit/6c5c743) and tagged [`h1-prereg-v1`](https://github.com/tonyjvelloor/mcx-signal-engine/releases/tag/h1-prereg-v1). This Addendum 1 was authored in commit [`3b6e128`](https://github.com/tonyjvelloor/mcx-signal-engine/commit/3b6e128) after the H1 strategy code existed and before the calibration results were formally reported. Git tags establish disciplined internal source versioning, recognizing that git commit timestamps are self-reported.

#### 1. Calibration Stopping Rule
To prevent quiet parameter tweaking or data snooping if a strategy fails on historical calibration, the pre-registration establishes an explicit gatekeeper rule:
* **The Rule:** If Hypothesis 1's 95% Day-Block Bootstrap Confidence Interval upper bound on the retrospective calibration set (Aug 7 – Nov 2, 2026) is $\le ₹0.00$ after realistic costs (1 tick slippage, 0.10 spread, Zerodha statutory fee schedule), **the hypothesis is FALSIFIED immediately on calibration**.
* **Consequence:** The prospective holdout partition is **NEVER OPENED OR SPENT**. The strategy is rejected as structurally incapable of overcoming micro-equity statutory transaction friction without risking holdout contamination.

#### 2. Empirical Calibration Findings across 12 NSE Large-Caps
Execution of Hypothesis 1 on the 60-session retrospective calibration archive (52,575 5-minute bars) yielded:
* **Gross Performance:**
  * Gross Profit: ₹19,816.36 | Gross Loss: ₹17,283.59 | Profit Factor: **1.15**
  * Average Gross P&L: **+₹3.81 / trade** (The directional signal demonstrates positive gross selection edge).
* **Statutory Drag:**
  * Statutory Fees + Slippage: ₹7,355.17
  * Average Fee Burden: **₹11.06 / trade**
* **Net Performance:**
  * Net Trades: 665
  * Net Win Rate: 28.7%
  * Net Expectancy: **-₹7.25 / trade**
  * **Day-Block Bootstrap 95% CI:** **[-₹12.62, -₹1.94]**
* **Calibration Stopping Rule Verdict:**
  * Because the upper bound of the Day-Block Bootstrap CI (**-₹1.94**) is strictly negative ($\le ₹0.00$), **Hypothesis 1 is dropped on calibration**.
  * The directional signal (+₹3.81) is mathematically insufficient to clear the ₹11.06/trade micro-equity friction hurdle on a ₹50 risk budget.
  * **Holdout integrity is 100% preserved:** The prospective forward dataset remains unspent and untouched.

#### 3. Observed Arrival Rate & Initial Horizon Calculation
* **Observed Arrival Rate:** 665 trades over 60 trading days = **11.08 trades / session across 12 stocks** (~0.92 trades / session per stock).
* **Nominal Trade Horizon to $N = 150$:** 
  $$\frac{150\text{ trades}}{11.08\text{ trades/session}} \approx 14\text{ trading sessions}$$

---

### Addendum 2 (2026-11-03): Cluster Correlation Correction, Dual-Floor Holdout Standard, and Governance Protocol

#### 1. Correction: Cluster Correlation & Dual-Floor Holdout Floor
The initial projection of evaluating holdout data in 14 trading sessions was methodologically flawed:
* **Cluster Dependence:** The Trading-Day Block Bootstrap clusters trades by calendar session to account for contemporaneous index correlation among the 12 large-caps. Evaluating after 14 sessions provides only **14 cluster blocks**, which produces severe sampling instability and excessively wide, volatile confidence intervals.
* **Dual-Floor Pre-Registration Standard:**
  Any future holdout evaluation requires meeting **both** criteria simultaneously before the holdout can be unlocked:
  1. **Trade Count Floor:** $N \ge 150$ completed holdout trades.
  2. **Session Cluster Floor:** $S \ge 60$ independent completed trading sessions (~3 full calendar months of continuous forward data).
* **Mechanical Enforcement:** The `--final` execution guard checks both `trades >= 150` and `sessions >= 60`. If either condition is unmet, execution aborts with exit code 1 to protect holdout power.

#### 2. Absolute Ban on Mining the Calibration Gross Edge
The observation that H1 achieved a gross expectancy of **+₹3.81 / trade** (profit factor 1.15) must not be exploited to justify retrospective parameter tuning on the Aug 07 – Nov 02 calibration data:
* **No Curve-Fitting:** Attempting to "engineer down fees" by tuning profit targets, stop distances, or pullback tolerances on the same 3 months of historical data burns the calibration set and invalidates prospective testing.
* **Structural Reality:** Micro-equity statutory fees + slippage average **₹11.06 / trade** on ₹50 risk, which is ~3x the gross edge. This gap cannot be bridged by parameter optimization at 5-minute bar resolution.
* **Future Research Protocols:**
  If another hypothesis is proposed in the future:
  1. It must possess a fundamentally new economic or structural rationale (e.g., daily swing holding periods where fees are < 5% of expected return, or MCX commodity futures with lower turnover friction).
  2. It must be pre-registered in full before writing any strategy code.
  3. The multiple testing comparison count must be incremented ($k = 5 \implies \alpha_{\text{adjusted}} = 0.05 / 5 = 0.01$).
  4. Forward data post-Nov 02 is a single-shot holdout. Once evaluated, it converts permanently to historical calibration data for any subsequent inquiries.

#### 3. Statutory Calendar Reconciliation & Special Session Exclusions
* **Official NSE Weekday Trading Holidays (Circular NSE/CMTR/71775):** Reconciled exactly 15 statutory weekday holidays for 2026.
* **Diwali Muhurat Trading Schedule (Circular NSE/CMTR/76941):**
  * Date: **Sunday, November 8, 2026**.
  * Timing: Pre-Open 14:05–14:17 IST; **Continuous Trading 14:20 to 15:15 IST** (for CAS / Nifty large-caps, 11 bars) and up to 15:30 IST for non-CAS securities.
  * System Recognition: Handled as an active trading session by `shared/nse_holidays.js` and the Sunday scheduler, but marked optional for upstream third-party freshness audits.
* **Special Session Exclusion Policy:**
  * All truncated special sessions (e.g. Muhurat trading) are **strictly excluded from backtest calibration and holdout evaluation**, keyed on explicit calendar dates rather than bar counts.
  * Truncated sessions distort Session VWAP accumulation, ATR smoothing, and execution fills, introducing non-stationary anomalies into quantitative model testing.

---

### Addendum 3 (2026-11-03): Hypothesis Lifecycle Registry, Signal Inversion Prohibition, and Standing Review Date

#### 1. Mechanical Hypothesis Lifecycle & Guard Enforcement
To prevent future accidental or erroneous holdout evaluations on dead hypotheses:
* **Registry Status:** In [`shared/hypothesis_registry.js`](file:///Volumes/One%20Touch/GOLD%20INVESTMNET/shared/hypothesis_registry.js), Hypothesis 1 is assigned permanent status: **`CLOSED_FALSIFIED_ON_CALIBRATION`**.
* **Mandatory Flag Requirement:** Running holdout evaluation via `--final` strictly requires passing `--hypothesis <ID>` (e.g., `--final --hypothesis H2`).
* **Mechanical Refusal of Closed IDs:** Passing `--final --hypothesis H1` immediately terminates execution with exit code 1:
  > *🚫 [HOLDOUT GUARD ABORT] Refusing holdout evaluation for Hypothesis H1: Status: CLOSED_FALSIFIED_ON_CALIBRATION. Unlocking holdout data on a dead hypothesis violates pre-registration and wastes unspent forward data.*
* **Cryptographic Tamper-Evident Audit Chain:** All evaluation attempts are appended to [`docs/holdout_evaluation_audit.log`](file:///Volumes/One%20Touch/GOLD%20INVESTMNET/docs/holdout_evaluation_audit.log) using a SHA-256 hash chain linking to previous blocks. Test and verification runs must pass `--dry-run` or `--test` to be segregated from production attempts.

#### 2. Explicit Prohibition on Signal Inversion ("Fading")
A multi-seed empirical $p$-value of $\approx 0.967$ indicates that the Pro strategy underperforms a random coin toss. This statistical failure must **NOT** be inverted into a "fade" or contrarian system:
* **The Arithmetic of Signal Inversion:** Pro's gross expectancy was already negative (-₹6.33/trade). Inverting entry direction would at best yield $\approx +₹6.33$/trade gross, which is immediately wiped out by $\approx ₹10.14$/trade in statutory transaction costs and slippage, leaving a net negative expectation ($\approx -₹3.81$/trade).
* **Data-Mining Boundary:** Fading a strategy that failed out-of-sample is post-hoc calibration data mining. Signal inversion is officially prohibited across the platform.

#### 3. Standing Calendar Review Date & Sunset Horizon
* **Formal Review Horizon:** **February 1, 2027** (or upon accumulation of $\ge 60$ completed forward trading sessions in `market_data.db`).
* **Standing Decision Framework at Review Date:**
  When the archiver reaches 60 forward sessions, the project will execute one of two predefined paths:
  1. **Option A (Final Structural Hypothesis):** Pre-register exactly ONE structurally different hypothesis targeting higher timeframes (daily/swing holding periods where statutory friction is $< 5\%$ of expected price moves) or lower-friction instruments (MCX commodity futures). Test against the unspent prospective holdout with $k = 5 \implies \alpha = 0.01$.
  2. **Option B (Permanent Platform Closure):** Accept the conclusion that retail quantitative models on 5-minute equity bars possess no institutional edge after statutory friction, and permanently transition the engine to a research, journaling, and paper risk workstation.
