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
