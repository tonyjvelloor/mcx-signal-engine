/**
 * Hardened Financial & AI Market Server
 * 
 * Security & Reliability Specifications:
 * 1. Binds strictly to loopback (127.0.0.1).
 * 2. Origin-validated CORS (blocks unauthorized browser cross-origin requests).
 * 3. Static file allowlist (protects .secrets, .kite_session, .git, and source code from HTTP access).
 * 4. Zero key leakage (Anthropic API keys remain strictly server-side).
 * 5. Mathematically sound valuation bridge: Equity Value = Target EV - Debt + Cash.
 * 6. Hard-coded risk controls: Paper trading default; max risk per trade capped at ₹50 for ₹15k capital.
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const kite = require('./kite');

const PORT = process.env.PORT || 8000;
const HOST = '127.0.0.1'; // Strict loopback binding

const ALLOWED_ORIGINS = new Set([
  'http://localhost:8000',
  'http://127.0.0.1:8000'
]);

const ALLOWED_STATIC_FILES = {
  '/': 'mcx-beginner.html',
  '/mcx-beginner.html': 'mcx-beginner.html',
  '/mcx-pro.html': 'mcx-pro.html',
  '/apex-terminal.html': 'apex-terminal.html',
  '/mcx-logger.html': 'mcx-logger.html',
  '/terminal.html': 'index.html',
  '/index.html': 'index.html'
};

// In-Memory High-Speed Cache (Symbol/Key -> { data, timestamp, ttl })
const memoryCache = new Map();

function getCached(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > item.ttl) {
    memoryCache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data, ttlMs = 60000) {
  memoryCache.set(key, { data, timestamp: Date.now(), ttl: ttlMs });
}

// ─────────────────────────────────────────────────────────────
// SQLITE PERSISTENT STORE (market_data.db via native node:sqlite)
// ─────────────────────────────────────────────────────────────
let db = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(__dirname, 'market_data.db');
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      symbol TEXT NOT NULL,
      interval TEXT NOT NULL,
      time INTEGER NOT NULL,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      PRIMARY KEY (symbol, interval, time)
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      time TEXT NOT NULL,
      action TEXT NOT NULL,
      confidence REAL,
      price REAL,
      stop_loss REAL,
      target1 REAL,
      target2 REAL,
      reason TEXT,
      status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      entry_price REAL NOT NULL,
      entry_time TEXT NOT NULL,
      stop_loss REAL NOT NULL,
      target REAL NOT NULL,
      exit_price REAL,
      exit_time TEXT,
      brokerage REAL DEFAULT 40.0,
      stt_gst REAL DEFAULT 5.0,
      net_pnl REAL,
      status TEXT NOT NULL,
      exit_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS macro_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at TEXT,
      verdict TEXT,
      green_count INTEGER,
      payload_json TEXT NOT NULL,
      stop_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ai_sentiment_cache (
      symbol TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,
      news_score REAL NOT NULL,
      summary TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_settings (
      id INTEGER PRIMARY KEY,
      capital REAL DEFAULT 15000,
      max_risk_per_trade REAL DEFAULT 50,
      daily_loss_limit REAL DEFAULT 150,
      pilot_drawdown_limit REAL DEFAULT 750,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO account_settings (id, capital, max_risk_per_trade, daily_loss_limit, pilot_drawdown_limit)
    VALUES (1, 15000, 50, 150, 750);
  `);
  console.log('📦 SQLite database initialized: market_data.db');
} catch (e) {
  console.warn('⚠️ SQLite initialization warning:', e.message);
}

function getAnthropicKey() {
  try {
    const secPath = path.join(__dirname, '.secrets.json');
    if (fs.existsSync(secPath)) {
      const data = JSON.parse(fs.readFileSync(secPath, 'utf8'));
      if (data.anthropicApiKey) return data.anthropicApiKey;
    }
  } catch (_) {}
  return process.env.ANTHROPIC_API_KEY || null;
}

// Helper: HTTP Request with Timeout
function fetchJson(targetUrl, options = {}, postData = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(options.headers || {})
      },
      timeout: options.timeout || 8000
    };

    const req = client.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: body });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${targetUrl}`));
    });

    req.on('error', reject);

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// 1. FAST QUOTES & CANDLES (Yahoo Finance Direct API)
// ─────────────────────────────────────────────────────────────
async function getFastQuote(symbol, interval = '15m', range = '5d') {
  const cacheKey = `quote_${symbol}_${interval}_${range}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const response = await fetchJson(yfUrl);
  
  if (!response.data || !response.data.chart || !response.data.chart.result) {
    throw new Error('Failed to retrieve market data');
  }

  const result = response.data.chart.result[0];
  const meta = result.meta || {};
  const quote = result.indicators.quote[0] || {};
  const timestamps = result.timestamp || [];

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quote.open[i] != null && quote.close[i] != null) {
      candles.push({
        time: timestamps[i],
        open: quote.open[i],
        high: quote.high[i],
        low: quote.low[i],
        close: quote.close[i],
        volume: quote.volume[i] || 0
      });
    }
  }

  const smc = detectSMC(candles);

  // Persist real candles to SQLite
  if (db && candles.length > 0) {
    try {
      const insertCandle = db.prepare(`
        INSERT OR REPLACE INTO candles (symbol, interval, time, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of candles) {
        insertCandle.run(symbol, interval, c.time, c.open, c.high, c.low, c.close, c.volume);
      }
    } catch (_) {}
  }

  const payload = {
    symbol,
    currency: meta.currency,
    regularMarketPrice: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose || meta.previousClose,
    high24h: meta.regularMarketDayHigh,
    low24h: meta.regularMarketDayLow,
    timestamp: meta.regularMarketTime,
    candlesCount: candles.length,
    candles: candles,
    latestCandle: candles[candles.length - 1] || null,
    smc
  };

  setCache(cacheKey, payload, 15000);
  return payload;
}

// ─────────────────────────────────────────────────────────────
// 2. SMART MONEY CONCEPTS (ORDER BLOCKS & FAIR VALUE GAPS)
// Note: These identify algorithmic candle footprints; they do
// NOT represent guaranteed institutional buying/selling.
// ─────────────────────────────────────────────────────────────
function detectSMC(candles) {
  if (candles.length < 5) return { orderBlocks: [], fvgs: [], zone: null };

  const orderBlocks = [];
  const fvgs = [];
  const lookback = Math.min(candles.length - 2, 50);
  const startIdx = candles.length - lookback;

  for (let i = startIdx; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish Fair Value Gap
    if (next.low > prev.high) {
      fvgs.push({
        type: 'BULLISH_FVG',
        top: next.low,
        bottom: prev.high,
        mid: (next.low + prev.high) / 2,
        detectedAtCandleTime: next.time
      });
    }

    // Bearish Fair Value Gap
    if (next.high < prev.low) {
      fvgs.push({
        type: 'BEARISH_FVG',
        top: prev.low,
        bottom: next.high,
        mid: (prev.low + next.high) / 2,
        detectedAtCandleTime: next.time
      });
    }

    // Bullish Order Block (requires displacement confirmation on next candle)
    const isDownCandle = curr.close < curr.open;
    const isImpulsiveUp = next.close > curr.high && (next.close - next.open) > (curr.high - curr.low);
    if (isDownCandle && isImpulsiveUp) {
      orderBlocks.push({
        type: 'DEMAND_OB',
        high: Math.max(curr.open, curr.high),
        low: curr.low,
        candleTime: curr.time,
        confirmedAtTime: next.time,
        status: 'UNMITIGATED'
      });
    }

    // Bearish Order Block
    const isUpCandle = curr.close > curr.open;
    const isImpulsiveDown = next.close < curr.low && (next.open - next.close) > (curr.high - curr.low);
    if (isUpCandle && isImpulsiveDown) {
      orderBlocks.push({
        type: 'SUPPLY_OB',
        high: curr.high,
        low: Math.min(curr.open, curr.low),
        candleTime: curr.time,
        confirmedAtTime: next.time,
        status: 'UNMITIGATED'
      });
    }
  }

  const recentHigh = Math.max(...candles.slice(-30).map(c => c.high));
  const recentLow = Math.min(...candles.slice(-30).map(c => c.low));
  const equilibrium = (recentHigh + recentLow) / 2;
  const currentPrice = candles[candles.length - 1].close;

  return {
    orderBlocks: orderBlocks.slice(-5),
    fvgs: fvgs.slice(-5),
    zone: currentPrice > equilibrium ? 'PREMIUM (Above 50% Range)' : 'DISCOUNT (Below 50% Range)',
    equilibrium,
    swingHigh: recentHigh,
    swingLow: recentLow
  };
}

// ─────────────────────────────────────────────────────────────
// 3. SOUND VALUATION & FINANCIAL BRIDGE (<200ms)
// Equity Value = Target Enterprise Value - Total Debt + Cash
// ─────────────────────────────────────────────────────────────
async function getFastStockFundamentals(ticker) {
  const cleanTicker = ticker.toUpperCase().endsWith('.NS') || ticker.toUpperCase().endsWith('.BO') 
    ? ticker.toUpperCase() 
    : `${ticker.toUpperCase()}.NS`;
  
  const cacheKey = `fund_${cleanTicker}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const yfSummaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(cleanTicker)}?modules=financialData,defaultKeyStatistics,summaryDetail`;
  let res = null;
  try {
    res = await fetchJson(yfSummaryUrl);
  } catch (_) {}

  if (!res || !res.data || !res.data.quoteSummary || !res.data.quoteSummary.result) {
    // Return structured unavailable state instead of crashing with 500
    const fallback = {
      ticker: cleanTicker,
      currentPrice: null,
      scorecard: {
        score: null,
        maxPossible: 10,
        completeness: '0/5 verified metrics',
        note: 'Live fundamental API requires session cookies. Use AI Research or Kite Quotes.',
        breakdown: {
          currentRatio: 'DATA_UNAVAILABLE',
          debtToEquity: 'DATA_UNAVAILABLE',
          roe: 'DATA_UNAVAILABLE',
          roce: 'DATA_UNAVAILABLE',
          pe: 'DATA_UNAVAILABLE',
          fcf: 'DATA_UNAVAILABLE'
        }
      },
      valuation: {
        totalDebtCr: null,
        totalCashCr: null,
        netDebtCr: null,
        scenarios: null
      }
    };
    setCache(cacheKey, fallback, 60000);
    return fallback;
  }

  const result = res.data.quoteSummary.result[0];
  const fin = result.financialData || {};
  const stats = result.defaultKeyStatistics || {};
  const detail = result.summaryDetail || {};

  const currentPrice = fin.currentPrice?.raw || detail.regularMarketPrice?.raw || 0;
  const currentRatio = fin.currentRatio?.raw ?? null;
  const debtToEquity = fin.debtToEquity?.raw ? (fin.debtToEquity.raw / 100) : null;
  const returnOnEquity = fin.returnOnEquity?.raw ? (fin.returnOnEquity.raw * 100) : null; // Labelled as ROE
  const pe = detail.trailingPE?.raw ?? null;
  const freeCashflowCr = fin.freeCashflow?.raw ? (fin.freeCashflow.raw / 10000000) : null;
  const sharesOutstandingCr = stats.sharesOutstanding?.raw ? (stats.sharesOutstanding.raw / 10000000) : null;
  const enterpriseValueCr = stats.enterpriseValue?.raw ? (stats.enterpriseValue.raw / 10000000) : null;
  const ebitdaCr = fin.ebitda?.raw ? (fin.ebitda.raw / 10000000) : null;
  const totalDebtCr = fin.totalDebt?.raw ? (fin.totalDebt.raw / 10000000) : 0;
  const totalCashCr = fin.totalCash?.raw ? (fin.totalCash.raw / 10000000) : 0;

  // Transparent scoring without awarding arbitrary fixed points
  const points = {
    currentRatio: currentRatio !== null ? (currentRatio >= 1.5 ? 2 : (currentRatio >= 1.0 ? 1 : 0)) : null,
    debtToEquity: debtToEquity !== null ? (debtToEquity < 1.0 ? 2 : (debtToEquity < 2.0 ? 1 : 0)) : null,
    roe: returnOnEquity !== null ? (returnOnEquity > 15 ? 2 : (returnOnEquity > 10 ? 1 : 0)) : null,
    peRatio: (pe !== null && pe > 0) ? (pe < 25 ? 2 : (pe < 40 ? 1 : 0)) : null,
    fcf: freeCashflowCr !== null ? (freeCashflowCr > 0 ? 2 : 0) : null
  };

  const scoredPoints = Object.values(points).filter(p => p !== null);
  const totalScore = scoredPoints.reduce((a, b) => a + b, 0);
  const maxPossible = scoredPoints.length * 2;

  // Valuation Bridge: Equity Value = EV - Debt + Cash
  let valuationScenarios = null;
  if (sharesOutstandingCr && ebitdaCr && enterpriseValueCr && ebitdaCr > 0) {
    const currentEvEbitdaMultiple = enterpriseValueCr / ebitdaCr;
    const calculateTarget = (growthPct) => {
      const forwardEbitda = ebitdaCr * (1 + growthPct / 100);
      const targetEV = forwardEbitda * currentEvEbitdaMultiple;
      const targetEquityValue = targetEV - totalDebtCr + totalCashCr;
      const targetPerShare = targetEquityValue / sharesOutstandingCr;
      return {
        targetPrice: Math.round(targetPerShare),
        entryPrice25PctMargin: Math.round(targetPerShare * 0.75) // 25% Margin of safety
      };
    };

    valuationScenarios = {
      currentMultiple: currentEvEbitdaMultiple.toFixed(2) + 'x',
      bearCase: calculateTarget(5),   // 5% growth
      baseCase: calculateTarget(12),  // 12% growth
      bullCase: calculateTarget(20)   // 20% growth
    };
  }

  const payload = {
    ticker: cleanTicker,
    currentPrice,
    scorecard: {
      score: totalScore,
      maxPossible,
      completeness: `${scoredPoints.length}/5 verified metrics`,
      breakdown: {
        currentRatio: currentRatio !== null ? `${currentRatio.toFixed(2)}x` : 'DATA_UNAVAILABLE',
        debtToEquity: debtToEquity !== null ? `${debtToEquity.toFixed(2)}` : 'DATA_UNAVAILABLE',
        roe: returnOnEquity !== null ? `${returnOnEquity.toFixed(1)}%` : 'DATA_UNAVAILABLE',
        roce: 'REQUIRES_DETAILED_FINANCIALS',
        pe: pe !== null ? `${pe.toFixed(1)}x` : 'DATA_UNAVAILABLE',
        fcf: freeCashflowCr !== null ? `₹${Math.round(freeCashflowCr)} Cr` : 'DATA_UNAVAILABLE'
      }
    },
    valuation: {
      totalDebtCr: Math.round(totalDebtCr),
      totalCashCr: Math.round(totalCashCr),
      netDebtCr: Math.round(totalDebtCr - totalCashCr),
      sharesOutstandingCr: sharesOutstandingCr ? sharesOutstandingCr.toFixed(2) : null,
      scenarios: valuationScenarios
    }
  };

  setCache(cacheKey, payload, 600000);
  return payload;
}

// ─────────────────────────────────────────────────────────────
// 4. CLAUDE AI PROXIES (KEY NEVER EXPOSED TO CLIENT)
// COST-OPTIMIZED WITH SQLITE 4-HOUR PERSISTENCE & HAIKU 4.5
// ─────────────────────────────────────────────────────────────
async function handleClaudeSentiment(commodity, force = false) {
  const sym = String(commodity || 'Gold').toUpperCase().trim();
  const cacheKey = `ai_sentiment_${sym}`;
  
  if (!force) {
    const memoryCached = getCached(cacheKey);
    if (memoryCached) return { ...memoryCached, cached: true, cacheSource: 'memory' };

    // Check SQLite Persistent Store (4-Hour Validity)
    if (db) {
      try {
        const row = db.prepare('SELECT * FROM ai_sentiment_cache WHERE symbol = ?').get(sym);
        if (row && new Date(row.expires_at).getTime() > Date.now()) {
          const parsed = JSON.parse(row.payload_json);
          setCache(cacheKey, parsed, 1800000); // 30 min in-memory
          return { ...parsed, cached: true, cacheSource: 'sqlite' };
        }
      } catch (dbErr) {
        console.warn('SQLite sentiment read error:', dbErr.message);
      }
    }
  }

  const apiKey = getAnthropicKey();
  if (!apiKey) {
    return {
      commodity: sym,
      newsScore: 50,
      verdict: 'NEUTRAL',
      summary: 'Anthropic API key not configured on server.',
      cached: false
    };
  }

  try {
    // Ultra-efficient single-turn prompt (~120 tokens total). Uses claude-haiku-4-5.
    const aiPayload = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 15000
    }, {
      model: 'claude-haiku-4-5',
      max_tokens: 250,
      system: 'You are a disciplined MCX commodity analyst. Respond ONLY with valid JSON: {"newsScore": <0-100>, "verdict": "BULLISH"|"BEARISH"|"NEUTRAL", "summary": "<1 factual sentence on price trend and macro driver.>"}',
      messages: [{ role: 'user', content: `Commodity: ${sym}. Summarize current macro sentiment and driver impact.` }]
    });

    let parsed = { newsScore: 50, verdict: 'NEUTRAL', summary: 'Macro consensus neutral.' };
    try {
      if (aiPayload.data?.content?.[0]?.text) {
        const clean = aiPayload.data.content[0].text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      }
    } catch (_) {}

    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + 4 * 3600000).toISOString(); // 4 hours TTL

    const result = {
      commodity: sym,
      newsScore: typeof parsed.newsScore === 'number' ? parsed.newsScore : 50,
      verdict: ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(parsed.verdict) ? parsed.verdict : 'NEUTRAL',
      summary: parsed.summary || 'Market trading in expected band.',
      updatedAt: nowIso,
      cached: false
    };

    if (db) {
      try {
        db.prepare(`
          INSERT INTO ai_sentiment_cache (symbol, verdict, news_score, summary, payload_json, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol) DO UPDATE SET
            verdict = excluded.verdict,
            news_score = excluded.news_score,
            summary = excluded.summary,
            payload_json = excluded.payload_json,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at
        `).run(sym, result.verdict, result.newsScore, result.summary, JSON.stringify(result), nowIso, expiresIso);
      } catch (dbSaveErr) {
        console.warn('Failed saving sentiment to SQLite:', dbSaveErr.message);
      }
    }

    setCache(cacheKey, result, 1800000);
    return result;
  } catch (err) {
    console.warn(`Sentiment fetch error for ${sym}:`, err.message);
    if (db) {
      try {
        const row = db.prepare('SELECT * FROM ai_sentiment_cache WHERE symbol = ?').get(sym);
        if (row) {
          const fallback = JSON.parse(row.payload_json);
          return { ...fallback, cached: true, warning: 'API error; serving last verified sentiment.' };
        }
      } catch (_) {}
    }
    return {
      commodity: sym,
      newsScore: 50,
      verdict: 'NEUTRAL',
      summary: 'Market data monitored.',
      cached: false
    };
  }
}

// ─────────────────────────────────────────────────────────────
// 5. SERVER-MANAGED INDIA MACRO DASHBOARD WITH ROBUST SCHEMA VALIDATION
// 6-HOUR PERSISTENT SQLITE CACHE WITH CLAUDE HAIKU 4.5
// ─────────────────────────────────────────────────────────────
async function handleClaudeMacro(force = false) {
  const cacheKey = 'claude_macro_latest';
  if (!force) {
    const cached = getCached(cacheKey);
    if (cached) return { ...cached, cached: true };
    if (db) {
      try {
        const stmt = db.prepare('SELECT * FROM macro_snapshots ORDER BY id DESC LIMIT 1');
        const latest = stmt.get();
        if (latest && latest.payload_json) {
          const parsed = JSON.parse(latest.payload_json);
          const age = Date.now() - new Date(latest.created_at).getTime();
          if (age < 6 * 3600000) { // 6-Hour Persistent Cache
            setCache(cacheKey, parsed, 300000);
            return { ...parsed, cached: true, dbSaved: true };
          }
        }
      } catch (e) {
        console.warn('Macro db read error:', e.message);
      }
    }
  }

  const apiKey = getAnthropicKey();
  if (!apiKey) {
    if (db) {
      try {
        const stmt = db.prepare('SELECT * FROM macro_snapshots ORDER BY id DESC LIMIT 1');
        const latest = stmt.get();
        if (latest && latest.payload_json) {
          return { ...JSON.parse(latest.payload_json), cached: true, note: 'Serving last valid snapshot from database.' };
        }
      } catch (_) {}
    }
    return getFallbackMacro('Anthropic API Key not configured in .secrets.json.');
  }

  const today = new Date().toDateString();
  const prompt = `You are a macro analyst for Indian financial markets. Today: ${today}. Return ONLY valid JSON in this exact schema:
{
  "overall_verdict": "Watch closely" | "Wait" | "Recovery signals building",
  "signals": [
    { "id": 1, "category": "GLOBAL", "label": "Strait of Hormuz", "icon": "🚢", "level": "Normal transit", "change": "Stable in 24h", "signal": "NEUTRAL", "detail": "Vessel traffic moving without disruption." },
    { "id": 2, "category": "GLOBAL", "label": "US-Iran / Red Sea", "icon": "⚔️", "level": "Elevated", "change": "Caution in place", "signal": "RED", "detail": "Missile and drone defense active around shipping corridors." },
    { "id": 3, "category": "GLOBAL", "label": "Brent Crude", "icon": "🛢️", "level": "$85-$92", "change": "Range-bound", "signal": "NEUTRAL", "detail": "Crude fluctuating around OPEC+ targets and geopolitical risk premium." },
    { "id": 4, "category": "INDIA",  label: "USD/INR", icon: "💵", level: "₹93-₹94", change: "RBI intervening", signal: "NEUTRAL", detail: "RBI foreign reserves supporting rupee stability." },
    { "id": 5, "category": "INDIA",  label: "FII / DII Flows", icon: "📊", level: "DII absorbing", change: "FII net sellers", signal: "NEUTRAL", detail: "Domestic institutional buying counteracting foreign portfolio outflows." },
    { "id": 6, "category": "GLOBAL", label: "US 10Y Yield", icon: "📈", level: "4.2%-4.4%", change: "Consolidating", signal: "NEUTRAL", detail: "Fed interest rate trajectory depends on sticky core services inflation." },
    { "id": 7, "category": "INDIA",  label: "RBI & CPI Inflation", icon: "🏛️", level: "Target band", change: "Repo rate stable", signal: "GREEN", detail: "RBI maintains withdrawal of accommodation stance with inflation under control." },
    { "id": 8, "category": "INDIA",  label: "Fiscal & Fuel", icon: "⛽", level: "Controlled", change: "Excise stable", signal: "GREEN", detail: "Government fiscal deficit glide path remains intact toward 4.9% of GDP." },
    { "id": 9, "category": "INDIA",  label: "Monsoon & Food", icon: "🌾", level: "Satisfactory", change: "Kharif sowing normal", signal: "GREEN", detail: "Normal monsoon distribution cushions rural agricultural output." },
    { "id": 10, "category": "INDIA", label: "Festive & GST", icon: "🛍️", level: "₹1.87L Cr+", change: "Healthy collections", signal: "GREEN", detail: "Monthly GST collections reflect resilient domestic commercial activity." },
    { "id": 11, "category": "INDIA", label: "Corporate Earnings", icon: "📑", level: "Balanced", change: "Selective margin beats", signal: "NEUTRAL", detail: "Banking and capital goods lead earnings growth." },
    { "id": 12, "category": "INDIA", label: "SIP & Retail Flows", icon: "💰", level: "₹25,000 Cr+/mo", change: "All-time highs", signal: "GREEN", detail: "Record monthly mutual fund SIP inflows provide persistent structural liquidity." }
  ],
  "key_events": [
    { "date": "Current Week", "event": "RBI Policy Watch", "impact": "HIGH" },
    { "date": "Upcoming", "event": "US Non-Farm Payrolls & CPI", "impact": "HIGH" },
    { "date": "Continuous", "event": "Domestic SIP Inflows & Corporate Results", "impact": "MEDIUM" }
  ]
}`;

  try {
    const aiResp = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 30000
    }, {
      model: 'claude-haiku-4-5',
      max_tokens: 1800,
      messages: [{ role: 'user', content: prompt }]
    });

    if (aiResp.status !== 200) {
      console.warn('Anthropic API returned status:', aiResp.status);
      throw new Error(aiResp.data?.error?.message || `Anthropic HTTP ${aiResp.status}`);
    }

    const stopReason = aiResp.data.stop_reason;
    let rawText = '';
    for (const b of (aiResp.data.content || [])) {
      if (b.type === 'text') rawText += b.text;
    }

    if (!rawText) throw new Error('Empty text content in AI response');

    let clean = rawText.replace(/```json|```/g, '').trim();
    const s = clean.indexOf('{');
    const e = clean.lastIndexOf('}');
    if (s < 0 || e < 0) throw new Error('No valid JSON boundary in response');

    let jsonSlice = clean.slice(s, e + 1);
    let parsed = null;
    try {
      parsed = JSON.parse(jsonSlice);
    } catch (parseErr) {
      let repaired = jsonSlice.replace(/,\s*([}\]])/g, '$1');
      parsed = JSON.parse(repaired);
    }

    if (!parsed || !Array.isArray(parsed.signals) || parsed.signals.length < 8) {
      throw new Error(`Incomplete signals in AI response (${parsed?.signals?.length || 0} of 12)`);
    }

    parsed.signals.forEach((sig, idx) => {
      sig.id = sig.id || (idx + 1);
      sig.category = sig.category || (sig.id <= 6 ? 'GLOBAL' : 'INDIA');
      sig.signal = ['GREEN', 'RED', 'NEUTRAL'].includes(sig.signal) ? sig.signal : 'NEUTRAL';
      sig.detail = sig.detail || 'Data monitored.';
    });

    parsed.green_count = parsed.signals.filter(s => s.signal === 'GREEN').length;
    parsed.generated_at = new Date().toISOString();
    parsed.stop_reason = stopReason;

    if (db) {
      try {
        const stmt = db.prepare(`
          INSERT INTO macro_snapshots (generated_at, verdict, green_count, payload_json, stop_reason)
          VALUES (?, ?, ?, ?, ?)
        `);
        stmt.run(parsed.generated_at, parsed.overall_verdict || 'Watch closely', parsed.green_count, JSON.stringify(parsed), stopReason);
      } catch (dbErr) {
        console.warn('Failed saving macro snapshot to SQLite:', dbErr.message);
      }
    }

    setCache(cacheKey, parsed, 3600000);
    return parsed;
  } catch (err) {
    console.warn('handleClaudeMacro fallback triggered:', err.message);
    if (db) {
      try {
        const stmt = db.prepare('SELECT * FROM macro_snapshots ORDER BY id DESC LIMIT 1');
        const latest = stmt.get();
        if (latest && latest.payload_json) {
          const fallback = JSON.parse(latest.payload_json);
          return {
            ...fallback,
            cached: true,
            warning: `Fresh AI query notice (${err.message}); retaining verified snapshot from ${fallback.generated_at}`
          };
        }
      } catch (_) {}
    }
    return getFallbackMacro(`AI research notice: ${err.message}`);
  }
}

function getFallbackMacro(notice) {
  return {
    status: 'UNAVAILABLE',
    generated_at: null,
    overall_verdict: 'Research Unavailable',
    green_count: 0,
    warning: notice,
    signals: [],
    key_events: []
  };
}

// ─────────────────────────────────────────────────────────────
// 5. SERVER ROUTER
// ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  // Strict Hostile Origin Rejection for Mutations
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'FORBIDDEN_ORIGIN: Cross-origin mutations rejected.' }));
    }
  }

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  try {
    // Health Check
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', serverTime: new Date().toISOString() }));
    }

    // 1. Fast Quotes + SMC
    if (pathname === '/api/quote') {
      const data = await getFastQuote(query.symbol || 'GC=F', query.interval || '15m', query.range || '5d');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // 1b. Local Yahoo Proxy (Reliable upstream candle fetch)
    if (pathname === '/api/yahoo') {
      const ticker = query.ticker || query.symbol || 'GC=F';
      const interval = query.interval || '5m';
      const range = query.range || '5d';
      const cacheKey = `yf_raw_${ticker}_${interval}_${range}`;
      const cached = getCached(cacheKey);
      if (cached) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(cached));
      }
      try {
        const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`;
        const yfResp = await fetchJson(yfUrl);
        if (!yfResp.data || !yfResp.data.chart) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Market data unavailable from upstream' }));
        }
        setCache(cacheKey, yfResp.data, 15000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(yfResp.data));
      } catch (yfErr) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: yfErr.message }));
      }
    }

    // 1c. Server-Managed Macro Dashboard
    if (pathname === '/api/macro') {
      const force = query.force === 'true';
      const macroData = await handleClaudeMacro(force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(macroData));
    }

    // 1d. Capital Profile & Risk Policy (₹15,000 Capital, ₹50 Risk Cap)
    if (pathname === '/api/account') {
      let profile = { capital: 15000, maxRiskPerTrade: 50, dailyLossLimit: 150, pilotDrawdownLimit: 750, currency: 'INR' };
      if (db) {
        try {
          const row = db.prepare('SELECT * FROM account_settings WHERE id = 1').get();
          if (row) profile = { ...profile, capital: row.capital, maxRiskPerTrade: row.max_risk_per_trade, dailyLossLimit: row.daily_loss_limit, pilotDrawdownLimit: row.pilot_drawdown_limit };
        } catch (_) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(profile));
    }

    // 1e. Paper Trading Engine (Enforcing ₹50 max risk & realistic Zerodha charges)
    if (pathname === '/api/paper-trades') {
      if (req.method === 'GET') {
        let trades = [];
        if (db) {
          try {
            trades = db.prepare('SELECT * FROM paper_trades ORDER BY id DESC').all();
          } catch (_) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(trades));
      }

      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            if (!db) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'DATABASE_UNAVAILABLE: Paper trade cannot be safely recorded.' }));
            }

            const data = JSON.parse(body);
            const symbol = String(data.symbol || 'GOLDM').toUpperCase().trim();
            const side = String(data.side || 'BUY').toUpperCase().trim();
            if (!['BUY', 'SELL'].includes(side)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Order side must be BUY or SELL.' }));
            }

            const rawQty = Number(data.qty);
            if (!Number.isInteger(rawQty) || rawQty <= 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Quantity must be a positive integer.' }));
            }

            const entryPrice = Number(data.entryPrice || data.price);
            const stopLoss = Number(data.stopLoss || data.sl);
            const target = Number(data.target || data.tp) || 0;

            if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Valid positive entry price and Stop Loss are mandatory.' }));
            }

            // Stop Loss Geometry Check
            if (side === 'BUY' && stopLoss >= entryPrice) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: `GEOMETRY_ERROR: Long stop loss (₹${stopLoss}) must be strictly below entry price (₹${entryPrice}).` }));
            }
            if (side === 'SELL' && stopLoss <= entryPrice) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: `GEOMETRY_ERROR: Short stop loss (₹${stopLoss}) must be strictly above entry price (₹${entryPrice}).` }));
            }

            // Target Geometry Check (if provided)
            if (target > 0) {
              if (side === 'BUY' && target <= entryPrice) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: `GEOMETRY_ERROR: Long target (₹${target}) must be strictly above entry price (₹${entryPrice}).` }));
              }
              if (side === 'SELL' && target >= entryPrice) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: `GEOMETRY_ERROR: Short target (₹${target}) must be strictly below entry price (₹${entryPrice}).` }));
              }
            }

            const brokerage = 40.0; // Zerodha flat ₹20 buy + ₹20 sell
            const sttGst = 5.0;     // Taxes & STT
            const stopDistance = Math.abs(entryPrice - stopLoss);
            const plannedLoss = (stopDistance * rawQty) + brokerage + sttGst;

            if (plannedLoss > 50.0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                error: `RISK_VIOLATION: Planned loss of ₹${plannedLoss.toFixed(2)} (including ₹45 Zerodha brokerage & taxes) exceeds strict ₹50 cap on ₹15,000 account.`
              }));
            }

            const stmt = db.prepare(`
              INSERT INTO paper_trades (symbol, side, qty, entry_price, entry_time, stop_loss, target, brokerage, stt_gst, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
            `);
            const resDb = stmt.run(symbol, side, rawQty, entryPrice, new Date().toISOString(), stopLoss, target, brokerage, sttGst);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              tradeId: resDb.lastInsertRowid,
              symbol,
              side,
              qty: rawQty,
              entryPrice,
              stopLoss,
              target,
              plannedLoss: plannedLoss.toFixed(2),
              status: 'OPEN'
            }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (req.method === 'PUT') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            if (!db) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'DATABASE_UNAVAILABLE: Trade close cannot be safely acknowledged.' }));
            }

            const data = JSON.parse(body);
            const tradeId = parseInt(data.tradeId, 10);
            const exitPrice = Number(data.exitPrice);
            const exitReason = String(data.exitReason || 'MANUAL_CLOSE').trim();

            if (!Number.isInteger(tradeId) || tradeId <= 0 || !Number.isFinite(exitPrice) || exitPrice <= 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Valid positive tradeId and exitPrice are required.' }));
            }

            const trade = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(tradeId);
            if (!trade) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'Trade not found.' }));
            }

            // Idempotency: Reject closing an already closed trade
            if (trade.status !== 'OPEN' || trade.exit_price != null) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: `IDEMPOTENCY_CONFLICT: Trade #${tradeId} is already closed and immutable.` }));
            }

            const grossPnl = trade.side === 'BUY'
              ? (exitPrice - trade.entry_price) * trade.qty
              : (trade.entry_price - exitPrice) * trade.qty;
            const netPnl = grossPnl - (trade.brokerage || 40.0) - (trade.stt_gst || 5.0);
            const status = netPnl > 0 ? 'WIN' : 'LOSS';

            db.prepare(`
              UPDATE paper_trades
              SET exit_price = ?, exit_time = ?, net_pnl = ?, status = ?, exit_reason = ?
              WHERE id = ?
            `).run(exitPrice, new Date().toISOString(), netPnl, status, exitReason, tradeId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              tradeId,
              netPnl: netPnl.toFixed(2),
              status,
              exitReason
            }));
          } catch(e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
    }

    // 1f. Recorded Signals Store
    if (pathname === '/api/signals') {
      if (req.method === 'GET') {
        let sigs = [];
        if (db) {
          try {
            sigs = db.prepare('SELECT * FROM signals ORDER BY id DESC LIMIT 50').all();
          } catch (_) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(sigs));
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (db && data.symbol && data.action) {
              const stmt = db.prepare(`
                INSERT INTO signals (symbol, time, action, confidence, price, stop_loss, target1, target2, reason, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `);
              stmt.run(data.symbol, data.time || new Date().toISOString(), data.action, data.confidence || 0, data.price || 0, data.stopLoss || 0, data.target1 || 0, data.target2 || 0, data.reason || '', data.status || 'OPEN');
            }
            res.writeHead(201, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      if (req.method === 'PUT') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const tradeId = parseInt(data.tradeId, 10);
            const exitPrice = parseFloat(data.exitPrice) || 0;
            const exitReason = data.exitReason || 'MANUAL_CLOSE';

            if (!tradeId || !exitPrice) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: 'tradeId and exitPrice are required' }));
            }

            if (db) {
              const trade = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(tradeId);
              if (!trade) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Trade not found' }));
              }
              const grossPnl = trade.side === 'BUY'
                ? (exitPrice - trade.entry_price) * trade.qty
                : (trade.entry_price - exitPrice) * trade.qty;
              const netPnl = grossPnl - (trade.brokerage || 40.0) - (trade.stt_gst || 5.0);
              const status = exitReason === 'SL_HIT' ? 'SL HIT' : (exitReason === 'T1_HIT' ? 'T1 HIT' : (netPnl >= 0 ? 'WIN' : 'LOSS'));

              db.prepare(`
                UPDATE paper_trades
                SET exit_price = ?, exit_time = ?, net_pnl = ?, status = ?, exit_reason = ?
                WHERE id = ?
              `).run(exitPrice, new Date().toISOString(), netPnl, status, exitReason, tradeId);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                success: true,
                tradeId,
                netPnl: netPnl.toFixed(2),
                status
              }));
            }
          } catch(e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
    }

    // 2. Fundamental Screener with Sane Valuation
    if (pathname === '/api/screener') {
      const data = await getFastStockFundamentals(query.symbol || 'RELIANCE');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // 3. AI Sentiment (Server-Managed Claude Key, 4h SQLite Cache)
    if (pathname === '/api/sentiment') {
      const force = query.force === 'true';
      const data = await handleClaudeSentiment(query.symbol || 'Gold', force);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // 4. Kite Universal Request Token Interceptor & Login
    if (query.request_token) {
      try {
        await kite.generateSession(query.request_token);
        console.log('✅ Kite session successfully authenticated via request_token');
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, message: 'Kite connected successfully' }));
        }
        res.writeHead(302, { 'Location': 'http://127.0.0.1:8000/mcx-beginner.html?kite_connected=true' });
        return res.end();
      } catch (err) {
        console.warn('⚠️ Kite token exchange notice:', err.message);
        res.writeHead(302, { 'Location': 'http://127.0.0.1:8000/mcx-beginner.html?kite_error=' + encodeURIComponent(err.message) });
        return res.end();
      }
    }

    if (pathname === '/api/kite/login') {
      const loginUrl = kite.getLoginUrl();
      if (query.redirect === 'true') {
        res.writeHead(302, { 'Location': loginUrl });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ loginUrl }));
    }

    // 5. Kite Auth Callback
    if (pathname === '/api/kite/callback') {
      const requestToken = query.request_token;
      if (!requestToken) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing request_token' }));
      }
      try {
        await kite.generateSession(requestToken);
        res.writeHead(302, { 'Location': 'http://127.0.0.1:8000/mcx-beginner.html?kite_connected=true' });
        return res.end();
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 6. Kite Status
    if (pathname === '/api/kite/status') {
      const session = kite.loadSession();
      if (!session) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ connected: false, message: 'No active session' }));
      }
      try {
        const margins = await kite.getMargins();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          connected: true,
          user: session.user_name || session.user_id,
          margins: margins.data
        }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ connected: false, error: e.message }));
      }
    }

    // 7. Kite Quotes (Rate-limited through queue)
    if (pathname === '/api/kite/quote') {
      const quoteData = await kite.getLiveQuotes((query.instruments || 'NSE:NIFTY 50').split(','));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(quoteData));
    }

    // 8. Order Placement (Protected with Safety Controls)
    if (pathname === '/api/kite/order' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const order = JSON.parse(body);
          
          const qty = Number(order.quantity);
          if (!Number.isInteger(qty) || qty <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Order quantity must be a positive integer.' }));
          }

          const price = Number(order.price);
          const stopLoss = Number(order.triggerPrice || order.stopLoss || order.sl);
          if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Order price and Stop Loss trigger are mandatory.' }));
          }

          const txType = String(order.transaction_type || order.side || 'BUY').toUpperCase();
          if (txType === 'BUY' && stopLoss >= price) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `GEOMETRY_ERROR: Long stop loss (₹${stopLoss}) must be strictly below entry price (₹${price}).` }));
          }
          if (txType === 'SELL' && stopLoss <= price) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `GEOMETRY_ERROR: Short stop loss (₹${stopLoss}) must be strictly above entry price (₹${price}).` }));
          }

          const stopDistance = Math.abs(price - stopLoss);
          const totalEstimatedLoss = (stopDistance * qty) + 45.0; // ₹45 Zerodha brokerage + taxes

          if (totalEstimatedLoss > 50.0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              error: `RISK_VIOLATION: Estimated trade loss (₹${totalEstimatedLoss.toFixed(2)} with charges) exceeds ₹50 budget limit.`
            }));
          }

          const isLiveAllowed = process.env.ENABLE_LIVE_ORDERS === 'true';
          const result = await kite.placeOrder(order, isLiveAllowed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (orderErr) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: orderErr.message }));
        }
      });
      return;
    }

    // 9. Static File Serving (STRICT ALLOWLIST)
    if ((req.method === 'GET' || req.method === 'HEAD') && ALLOWED_STATIC_FILES[pathname]) {
      const fileName = ALLOWED_STATIC_FILES[pathname];
      const safePath = path.join(__dirname, fileName);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(safePath).pipe(res);
    }

    // Forbidden / Not Found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found or file access forbidden.' }));

  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// Explicitly bind to loopback 127.0.0.1
server.listen(PORT, HOST, () => {
  console.log(`🔒 Hardened Server running securely on http://${HOST}:${PORT}`);
  console.log(`🛡️ Paper Trading Mode: ${process.env.ENABLE_LIVE_ORDERS === 'true' ? 'DISABLED (LIVE)' : 'ACTIVE (SAFE)'}`);
});

module.exports = server;
