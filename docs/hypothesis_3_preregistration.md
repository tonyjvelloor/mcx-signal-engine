# Pre-Registration: Hypothesis 3 (H3)
## Multi-Day Trend & Volatility Breakout on NSE Large-Caps (Daily Swing)

> **Status:** LOCKED & PRE-REGISTERED before any H3 evaluation runs.  
> **Registration Date:** 2026-11-11  
> **Immutable Tag:** `h3-prereg-v1`  
> **Multiple-Testing Budget:** k = 5 hypotheses, alpha = 0.01 (Bonferroni-adjusted bar p < 0.01)  
> **Governance:** `shared/hypothesis_registry.js` entry `H3`; holdout guard in `backtest/pool.js` applies.

---

### 1. Scientific Rationale & Failure Mode Resolution
In Hypotheses 1 and 2, 5-minute intraday trading on NSE large-caps failed because:
1. Price movement at the 5-minute resolution is dominated by microstructure noise (TimesFM 2.5 directional accuracy was 50.7%, indistinguishable from a coin flip).
2. Statutory friction (Zerodha brokerage, STT, turnover charges, GST, stamp duty, slippage) consumes 25% to 50% of the entire risk budget on ₹50-capped intraday trades.

**Hypothesis 3 Core Thesis:**  
Moving from 5-minute intraday bars to **Daily (1D) bars** resolves both structural flaws:
- Target swings of 3% to 6% (₹45 to ₹100 per share) dilute round-trip statutory costs to **< 5% of gross profit** (down from ~50%).
- Multi-day institutional accumulation and macro momentum (Donchian 20-day channel breakouts with 50-day / 200-day trend filters) have decades of documented empirical momentum persistence.

---

### 2. Fixed Strategy Configuration (Zero Tuning / No Parameter Sweeps)

| Parameter | Value | Rationale |
| :--- | :--- | :--- |
| **Asset Universe** | 12 Liquid NSE Large-Caps (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`, `BHARTIARTL`, `SBIN`, `ITC`, `LT`, `KOTAKBANK`, `AXISBANK`, `MARUTI`) | Core institutional large-caps with deep liquidity and zero circuit lockup. |
| **Timeframe** | Daily (1D) Bars | Filters intraday noise; dilutes transaction friction to <5%. |
| **Macro Trend Filter** | 50-Day SMA > 200-Day SMA (Golden Cross Regime) AND Close > 50-Day SMA | Long-only regime filter. Disables buying during secular market downtrends. |
| **Entry Trigger** | Daily Close > 20-Day High (Donchian Breakout) | Classic Richard Dennis / Turtle momentum breakout trigger. |
| **Stop Loss Distance** | $2.0 \times \text{ATR}(14)$ below entry price | Volatility-adaptive stop avoiding normal daily consolidation wicks. |
| **Trailing Exit / Profit Target** | Daily Close < 10-Day Low OR $1 : 2.5$ Net R:R | Asymmetric reward structure capturing multi-week trend extensions. |
| **Execution Modeling** | Signal at Day $t$ Close $\implies$ Fill at Day $t+1$ Open | Strict zero lookahead. 1 tick slippage + half-spread included. |
| **Cost Model** | Zerodha Equity Delivery Schedule (`equity_delivery`) | ₹0 brokerage, 0.1% STT buy + 0.1% sell, exchange turnover, GST, stamp duty, ₹15.93 DP charge on sell. |
| **Risk Cap** | ₹150 max risk per trade on ₹15,000 capital (1% risk) | Sized via canonical `risk.js`. |

---

### 3. Data Partitioning & Holdout Boundary
- **Historical Calibration Window:** 2024-11-11 to 2026-11-02 (2 full years, ~490 trading days per symbol).
- **Prospective Forward Holdout:** All trading days post **2026-11-02**. Strictly locked and protected by the dual floor ($N \ge 150$, $S \ge 60$) and hash-chained audit logging.

---

### 4. Stopping Rules & Pre-Registered Decision Criteria
1. **FALSIFIED on Calibration:** If Day-Block Bootstrap 95% Confidence Interval upper bound $\le ₹0.00$, OR Trade Count $< 30$, OR failure to beat matched null ($p \ge 0.01$).
2. **ADVANCES to Forward Accumulation:** If 95% CI lower bound $> 0$ AND empirical $p < 0.01$ against matched random null.
3. **No Inversion / No Snooping:** Fading failed signals or tweaking parameters after viewing results is strictly prohibited.
