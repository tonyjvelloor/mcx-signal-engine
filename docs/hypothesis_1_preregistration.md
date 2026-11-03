# Institutional Strategy Pre-Registration: Hypothesis 1
## Multi-Timeframe Trend Filter & Session VWAP Mean Reversion

> **Status:** LOCKED & PRE-REGISTERED (Pending Data Accumulation)  
> **Registration Date:** 2026-11-03  
> **Author:** Antigravity Research Lab & User  
> **Target Universe:** Liquid NSE Nifty 50 Equities (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`, `BHARTIARTL`, `SBIN`, `ITC`, `LT`, `KOTAKBANK`, `AXISBANK`, `MARUTI`)  
> **Execution Engine:** Zero Lookahead Walk-Forward Sim (`backtest/sim.js`)  
> **Cost Model:** Canonical `risk.js` (Zerodha NSE Cash Equity Schedule + 1 Tick Slippage + 0.10 Spread)  

---

### 1. Theoretical Rationale & Failure Mode Analysis
Previous walk-forward tests on real exchange data proved that retail lagging indicator breakout strategies (Supertrend, EMA 9/21 cross, EMA 20/50 + RSI) have negative net expectancy ($-₹13.42$ / trade) and fail to beat a random-entry coin toss ($p = 0.756$).

Their core structural flaw is **chasing overextended impulses**:
1. When Supertrend flips green or EMA 9 crosses EMA 21 on a 5-minute chart, price has already made a multi-bar run. Buying at that point purchases the top of the impulse just as mean-reversion occurs.
2. In choppy or ranging intraday markets, this produces repeated whipsaws where stops are triggered before price resumes, dragging the net win rate down to $25\% - 27\%$.
3. Transaction costs and slippage create a **₹8.76 / trade hurdle** (the exact average loss of a random-entry portfolio). A strategy must generate $> ₹9.00$ in gross edge per trade just to break even.

**Hypothesis 1 Core Thesis:**
Rather than buying breakouts at local highs, an institutional edge requires:
1. Aligning with the **higher-timeframe macro trend (1-Hour)** to trade with institutional flow.
2. Waiting for an intraday **mean reversion pullback into value (Session VWAP)** to buy at discount rather than premium.
3. Requiring an explicit **candlestick rejection confirmation** (Hammer / Engulfing) before entry.
4. Setting a **1:3.0 Target Multiple** so winning trades substantially overwhelm the statutory fee hurdle.

---

### 2. Fixed Conventional Parameters (Zero Tuning / Sweeping)
To prevent p-hacking, overfitting, and edge fabrication, all parameters are fixed in advance based on standard market convention:

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| **Higher-Timeframe (HTF)** | 1-Hour (`resampleBars(bars5m, 12)`) | Filters out intraday 5m noise while capturing multi-session direction. |
| **HTF Trend Metric** | 50-Period Exponential Moving Average (EMA) | Standard institutional benchmark. Requires 50 hourly bars (~7 sessions) warmup. |
| **HTF Bias Rule** | **Bullish:** 1H Close > 1H EMA(50) & EMA Slope > 0<br>**Bearish:** 1H Close < 1H EMA(50) & EMA Slope < 0 | Binary regime filter. No counter-trend trades permitted. |
| **Intraday Value Anchor** | Session VWAP ($\sum P \cdot V / \sum V$) | Reset daily at 09:15 IST market open. Benchmark for institutional value. |
| **Pullback Zone** | Within $0.20 \times \text{ATR}(14)$ of Session VWAP | Price must test or penetrate the VWAP band. No chasing when extended. |
| **Rejection Triggers** | **Long:** Strict Hammer OR Bullish Engulfing<br>**Short:** Strict Shooting Star OR Bearish Engulfing | Confirms that responsive buyers/sellers are defending the VWAP level. |
| **Stop Loss Distance** | $1.5 \times \text{ATR}(14)$ beyond candle extreme | Volatility-adaptive stop, subject to canonical volatility floor ($\ge 1.0\times\text{ATR}$). |
| **Target Multiple** | $1 : 3.0$ Gross R:R ($\text{Net R:R} \ge 2.2$) | Essential to overcome the ₹9/trade statutory fee drag. |
| **Execution Timing** | Signal at Bar $t$ close $\implies$ Fill at Bar $t+1$ Open | Strict zero lookahead. Includes 1 tick slippage + spread. |
| **EOD Square-Off** | 15:15 IST (Bar 72 of session) | Force close any open position at market close. No overnight gap risk. |

---

### 3. Multiple Testing Penalty & Statistical Threshold
Because multiple strategies are evaluated across this project ($k = 4$: Baseline, Beginner, Pro, Hypothesis 1), standard $p < 0.05$ thresholds are insufficient due to the cumulative false-discovery rate.

Applying the **Bonferroni Correction**:
$$\alpha_{\text{adjusted}} = \frac{0.05}{k} = \frac{0.05}{4} = 0.0125$$

**Hypothesis 1 will only be declared to possess a valid statistical edge if:**
1. Empirical Monte Carlo permutation test (1,000 runs) yields **$p < 0.0125$**.
2. Stressed Cost Test (2x slippage, 1.5x fees) 95% Bootstrap Confidence Interval Lower Bound is **$> 0.00$**.
3. Total Out-of-Sample Trades across the universe $\ge 150$.

---

### 4. Strict Holdout Partition
To guarantee that parameters are not tuned on familiar data:
- **Calibration Partition (70%):** Bars from 2026-08-06 to 2026-10-08.
- **Strictly Locked Holdout (30%):** Bars from 2026-10-09 to 2026-11-02.
- **Rule:** The holdout partition remains strictly sealed and un-run until the strategy implementation is frozen and verified on calibration data.

---

### 5. Implementation Commitment
- Do not write code for Hypothesis 1 until the historical candle archive reaches continuous statistical sufficiency.
- If Hypothesis 1 fails the pre-registered standards on the holdout partition, **"No edge found"** will be accepted as the definitive scientific outcome, and the application will remain a pure paper-trading, risk governance, and journaling workstation.
