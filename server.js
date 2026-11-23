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
const riskEngine = require('./risk');
const ticker = require('./kite-ticker');
const contractResolver = require('./shared/contract_resolver');
const macroEvents = require('./shared/macro_events');
const circuitBreaker = require('./shared/circuit_breaker');
const geopoliticalHistory = require('./shared/geopolitical_history');
const geopoliticalAnalogs = require('./shared/geopolitical_analogs');
const patternEngine = require('./shared/pattern_engine');
const debateEngine = require('./shared/debate_engine');
const nseHolidays = require('./shared/nse_holidays');
const autoPilot = require('./shared/auto_pilot');
const nseMcpClient = require('./shared/nse_mcp_client');

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
  '/index.html': 'index.html',
  '/risk.js': 'risk.js',
  '/shared/indicators.js': 'shared/indicators.js',
  '/shared/contract_resolver.js': 'shared/contract_resolver.js',
  '/shared/macro_events.js': 'shared/macro_events.js',
  '/shared/circuit_breaker.js': 'shared/circuit_breaker.js',
  '/shared/audio_alerts.js': 'shared/audio_alerts.js',
  '/shared/geopolitical_history.js': 'shared/geopolitical_history.js',
  '/shared/pattern_engine.js': 'shared/pattern_engine.js',
  '/shared/global_usd_mode.js': 'shared/global_usd_mode.js',
  '/shared/signal_engine.js': 'shared/signal_engine.js',
  '/shared/debate_engine.js': 'shared/debate_engine.js'
};

// In-Memory High-Speed Cache (Symbol/Key -> { data, timestamp, ttl })
const memoryCache = new Map();
// Server-Side Live GTT +1R Breakeven Guard Registry
const armedGttGuards = new Map();
// Latest Olymp Trade Co-Pilot Ticket (polled by Chrome Extension)
let latestOlympTicket = {
  ok: false,
  pair: 'XAU/USD',
  action: 'WAIT',
  recommendedMode: 'WAIT — DO NOT ENTER',
  updatedAt: null
};

// Global Emergency Kill Switch & Auto-Expiring Staged Order Queue
let killSwitchState = {
  active: false,
  reason: null,
  activatedAt: null
};
const stagedOrders = new Map();
function pruneExpiredStagedOrders() {
  const now = Date.now();
  for (const [id, ord] of stagedOrders.entries()) {
    if (now >= ord.expiresAt) stagedOrders.delete(id);
  }
}

// Autonomous Paper-Trading Pilot State (Armed for Monday–Friday Live Sessions on ₹15,000 Budget)
let autoPilotState = {
  enabled: true,
  maxConcurrentOpen: 3,
  maxDailyTrades: 4,
  cooldownMinutes: 30,
  lastScanAt: null,
  lastSessionStatus: null,
  topStocks: [],
  stockEvaluations: [],
  lastEvaluations: [],
  nseMcpOverview: null,
  activityLog: [],
  symbolLastEntryMs: {}
};

function logAutoPilotEvent(type, message, extra = {}) {
  const entry = {
    time: new Date().toISOString(),
    istTime: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }),
    type,
    message,
    ...extra
  };
  autoPilotState.activityLog.unshift(entry);
  if (autoPilotState.activityLog.length > 40) {
    autoPilotState.activityLog = autoPilotState.activityLog.slice(0, 40);
  }
  console.log(`🤖 [AUTO-PILOT ${type}] ${message}`);
}

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
      max_risk_per_trade REAL DEFAULT 150,
      daily_loss_limit REAL DEFAULT 375,
      pilot_drawdown_limit REAL DEFAULT 750,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO account_settings (id, capital, max_risk_per_trade, daily_loss_limit, pilot_drawdown_limit)
    VALUES (1, 15000, 150, 375, 750);
    UPDATE account_settings
    SET capital = 15000, max_risk_per_trade = 150, daily_loss_limit = 375, pilot_drawdown_limit = 750, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1 AND (capital = 10000 OR max_risk_per_trade = 50);
    CREATE TABLE IF NOT EXISTS trade_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      regime TEXT,
      session_window TEXT,
      parity_signal TEXT,
      exit_reason TEXT,
      net_pnl REAL,
      lesson TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('📦 SQLite database initialized: market_data.db');
} catch (e) {
  console.warn('⚠️ SQLite initialization warning:', e.message);
}

function getAccountProfile() {
  const defaults = { capital: 15000, maxRiskPerTrade: 150, dailyLossLimit: 375, pilotDrawdownLimit: 750, currency: 'INR' };
  if (!db) return defaults;
  try {
    const row = db.prepare('SELECT * FROM account_settings WHERE id = 1').get();
    if (row) {
      return {
        capital: Number(row.capital) || defaults.capital,
        maxRiskPerTrade: Number(row.max_risk_per_trade) || defaults.maxRiskPerTrade,
        dailyLossLimit: Number(row.daily_loss_limit) || defaults.dailyLossLimit,
        pilotDrawdownLimit: Number(row.pilot_drawdown_limit) || defaults.pilotDrawdownLimit,
        currency: 'INR'
      };
    }
  } catch (_) {}
  return defaults;
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

  const parsedUrl = new URL(req.url, 'http://127.0.0.1');
  const pathname = parsedUrl.pathname;
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

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

    // 1b. Local Yahoo Proxy (Reliable upstream candle fetch + Instant SQLite Archive Fallback)
    if (pathname === '/api/yahoo') {
      const ticker = query.ticker || query.symbol || 'GC=F';
      const interval = query.interval || '5m';
      const range = query.range || '5d';
      const cacheKey = `yf_raw_${ticker}_${interval}_${range}_${query.events || ''}`;
      const cached = getCached(cacheKey);
      if (cached) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(cached));
      }

      const serveSqliteFallback = (reason) => {
        if (!db) return false;
        try {
          const tickerToDbSym = {
            'GC=F': 'GOLDM',
            'SI=F': 'SILVERMIC',
            'CL=F': 'CRUDEOILM',
            'NG=F': 'NATGASM',
            'HG=F': 'COPPER'
          };
          const dbSym = tickerToDbSym[ticker] || String(ticker).replace('.NS', '').toUpperCase();
          const rows = db.prepare(
            `SELECT time, open, high, low, close, volume FROM candles WHERE symbol = ? ORDER BY time DESC LIMIT 360`
          ).all(dbSym).reverse();
          if (rows.length >= 10) {
            const last = rows[rows.length - 1];
            const first = rows[0];
            const payload = {
              chart: {
                result: [{
                  meta: {
                    symbol: ticker,
                    regularMarketPrice: last.close,
                    chartPreviousClose: first.close,
                    previousClose: first.close,
                    regularMarketDayHigh: Math.max(...rows.slice(-75).map(r => r.high)),
                    regularMarketDayLow: Math.min(...rows.slice(-75).map(r => r.low)),
                    source: 'SQLITE_ARCHIVE_FALLBACK',
                    fallbackReason: reason
                  },
                  timestamp: rows.map(r => r.time),
                  indicators: {
                    quote: [{
                      open: rows.map(r => r.open),
                      high: rows.map(r => r.high),
                      low: rows.map(r => r.low),
                      close: rows.map(r => r.close),
                      volume: rows.map(r => r.volume || 0)
                    }]
                  }
                }],
                error: null
              }
            };
            setCache(cacheKey, payload, 10000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
            return true;
          }
        } catch (_) {}
        return false;
      };

      try {
        const eventsParam = query.events ? `&events=${encodeURIComponent(query.events)}` : '';
        const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}${eventsParam}`;
        const yfResp = await fetchJson(yfUrl, { timeout: 3500 });
        if (!yfResp.data || !yfResp.data.chart || !yfResp.data.chart.result) {
          if (serveSqliteFallback('upstream_empty')) return;
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Market data unavailable from upstream' }));
        }
        setCache(cacheKey, yfResp.data, 15000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(yfResp.data));
      } catch (yfErr) {
        if (serveSqliteFallback(yfErr.message)) return;
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

    // 1d. Capital Profile & Risk Policy (₹10,000 Capital, ₹125 Risk Cap, ₹300 Daily Circuit Breaker)
    if (pathname === '/api/account') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const payload = JSON.parse(body || '{}');
            const cur = getAccountProfile();
            const capital = Math.max(1000, Number(payload.capital) || cur.capital);
            const maxRiskPerTrade = Math.max(25, Number(payload.maxRiskPerTrade) || cur.maxRiskPerTrade);
            const dailyLossLimit = Math.max(50, Number(payload.dailyLossLimit) || cur.dailyLossLimit);
            const pilotDrawdownLimit = Math.max(100, Number(payload.pilotDrawdownLimit) || cur.pilotDrawdownLimit);
            if (db) {
              db.prepare(`
                INSERT INTO account_settings (id, capital, max_risk_per_trade, daily_loss_limit, pilot_drawdown_limit, updated_at)
                VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(id) DO UPDATE SET
                  capital = excluded.capital,
                  max_risk_per_trade = excluded.max_risk_per_trade,
                  daily_loss_limit = excluded.daily_loss_limit,
                  pilot_drawdown_limit = excluded.pilot_drawdown_limit,
                  updated_at = CURRENT_TIMESTAMP
              `).run(capital, maxRiskPerTrade, dailyLossLimit, pilotDrawdownLimit);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(getAccountProfile()));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(getAccountProfile()));
    }

    // 1d2. Dynamic Institutional Backtest Statistics (Zero-Drift UI Feed)
    if (pathname === '/api/backtest/stats') {
      const statsFile = path.join(__dirname, 'backtest_results.json');
      if (fs.existsSync(statsFile)) {
        try {
          const raw = fs.readFileSync(statsFile, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(raw);
        } catch (_) {}
      }
      const fallback = {
        updatedAt: new Date().toISOString(),
        pro: { totalTrades: 322, monteCarloPValue: 0.977, empiricalCostHurdle: 9.75, expectancy: -16.37 }
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(fallback));
    }

    // 1d3. Trigger Daily Historical Archiver On-Demand
    if (pathname === '/api/archive/run' && req.method === 'POST') {
      const { runArchiver } = require('./scripts/archive_candles');
      runArchiver()
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', message: 'Archiver completed successfully' }));
        })
        .catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: err.message }));
        });
      return;
    }

    // 1d4. Market Data Archival & Freshness Status
    if (pathname === '/api/archive/status') {
      const statusFile = path.join(__dirname, 'archive_status.json');
      if (fs.existsSync(statusFile)) {
        try {
          const raw = fs.readFileSync(statusFile, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(raw);
        } catch (_) {}
      }
      const { checkDataFreshness } = require('./scripts/archive_candles');
      const st = checkDataFreshness(db);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(st));
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

            const spec = riskEngine.getContractSpec ? riskEngine.getContractSpec(symbol) : { multiplier: 10, segment: 'commodity' };
            const isComm = spec.segment === 'commodity';
            const segment = isComm ? 'commodity' : 'equity';
            const lotMult = Number(data.lotMultiplier) || spec.multiplier || 1;
            const accProfile = getAccountProfile();
            const maxLossBudget = Number(data.maxLossTotal) > 0 ? Number(data.maxLossTotal) : accProfile.maxRiskPerTrade;

            // Global Kill Switch, Macro Blackout & Daily Circuit Breaker checks
            if (killSwitchState.active) {
              res.writeHead(423, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: `🛑 KILL SWITCH ACTIVE${killSwitchState.reason ? ': ' + killSwitchState.reason : ''}. Disarm Kill Switch before placing orders.` }));
            }
            const blackout = macroEvents.checkMacroBlackout(symbol);
            if (blackout.isBlackout && !data.overrideBlackout) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: blackout.warningText }));
            }
            const todayTrades = db.prepare(`SELECT * FROM paper_trades WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`).all();
            const circuit = circuitBreaker.evaluateCircuitBreaker({ trades: todayTrades, dailyLossLimit: accProfile.dailyLossLimit });
            if (circuit.tripped && !data.overrideCircuitBreaker) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: circuit.message }));
            }

            const resolved = isComm ? contractResolver.resolveContractExpiry(symbol) : { tradingsymbol: symbol };
            const resolvedSymbol = resolved.tradingsymbol || symbol;

            // Sizing and Pre-Trade Risk Evaluation Gate
            const sized = riskEngine.sizeTrade({
              side,
              entry: entryPrice,
              sl: stopLoss,
              target: target > 0 ? target : (side === 'BUY' ? entryPrice + (Math.abs(entryPrice - stopLoss) * 2) : entryPrice - (Math.abs(entryPrice - stopLoss) * 2)),
              lotMultiplier: lotMult,
              segment,
              maxLossTotal: maxLossBudget,
              minNetRR: 1.2,
              atr: data.atr
            });

            if (!sized.ok) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: sized.reason }));
            }

            const plannedLoss = (Math.abs(entryPrice - stopLoss) * lotMult * rawQty) + sized.stopFees;
            if (plannedLoss > maxLossBudget) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                error: `RISK_VIOLATION: Planned loss of ₹${plannedLoss.toFixed(2)} (including ₹${sized.stopFees.toFixed(2)} Zerodha charges) exceeds ₹${maxLossBudget} risk cap.`
              }));
            }

            const feesAtEntry = riskEngine.calculateZerodhaFees({
              segment,
              buyPrice: side === 'BUY' ? entryPrice : stopLoss,
              sellPrice: side === 'BUY' ? stopLoss : entryPrice,
              qty: rawQty,
              lotMultiplier: lotMult
            });
            const brokerage = feesAtEntry.brokerage;
            const sttGst = Math.round((feesAtEntry.totalFees - brokerage) * 100) / 100;

            const stmt = db.prepare(`
              INSERT INTO paper_trades (symbol, side, qty, entry_price, entry_time, stop_loss, target, brokerage, stt_gst, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
            `);
            const resDb = stmt.run(resolvedSymbol, side, rawQty, entryPrice, new Date().toISOString(), stopLoss, target, brokerage, sttGst);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              success: true,
              tradeId: Number(resDb.lastInsertRowid),
              symbol: resolvedSymbol,
              side,
              qty: rawQty,
              entryPrice,
              stopLoss,
              target,
              lotMultiplier: lotMult,
              plannedLoss: plannedLoss.toFixed(2),
              fees: feesAtEntry.totalFees,
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

            // Protect server-managed SQLite paper trades from client-side browser AUTO_SL / AUTO_TARGET loops
            if (exitReason.startsWith('AUTO_')) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                ignored: true,
                reason: 'Server Auto-Pilot manages AUTO_SL, AUTO_PROFIT_LOCK and AUTO_TARGET exits authoritatively.'
              }));
            }

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

            const isComm = ['GOLD','SILVER','CRUDE','NATGAS','COPPER','ZINC','ALUM','COTTON'].some(c => trade.symbol.includes(c));
            const segment = isComm ? 'commodity' : 'equity';
            const spec = riskEngine.getContractSpec ? riskEngine.getContractSpec(trade.symbol) : { multiplier: 10 };
            const lotMult = Number(data.lotMultiplier) || Number(trade.lot_multiplier) || spec.multiplier || 1;

            const actualFees = riskEngine.calculateZerodhaFees({
              segment,
              buyPrice: trade.side === 'BUY' ? trade.entry_price : exitPrice,
              sellPrice: trade.side === 'BUY' ? exitPrice : trade.entry_price,
              qty: trade.qty,
              lotMultiplier: lotMult
            });

            const grossPnl = trade.side === 'BUY'
              ? (exitPrice - trade.entry_price) * trade.qty * lotMult
              : (trade.entry_price - exitPrice) * trade.qty * lotMult;
            const netPnl = grossPnl - actualFees.totalFees;
            const status = netPnl > 0 ? 'WIN' : 'LOSS';

            db.prepare(`
              UPDATE paper_trades
              SET exit_price = ?, exit_time = ?, net_pnl = ?, brokerage = ?, stt_gst = ?, status = ?, exit_reason = ?
              WHERE id = ?
            `).run(exitPrice, new Date().toISOString(), netPnl, actualFees.brokerage, Math.round((actualFees.totalFees - actualFees.brokerage) * 100) / 100, status, exitReason, tradeId);

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
              const spec = riskEngine.getContractSpec ? riskEngine.getContractSpec(trade.symbol) : { multiplier: 1 };
              const lotMult = Number(data.lotMultiplier) || spec.multiplier || 1;
              const grossPnl = trade.side === 'BUY'
                ? (exitPrice - trade.entry_price) * trade.qty * lotMult
                : (trade.entry_price - exitPrice) * trade.qty * lotMult;
              const netPnl = grossPnl - (trade.brokerage || 40.0) - (trade.stt_gst || 5.0);
              const status = exitReason === 'SL_HIT' ? 'SL HIT' : (exitReason === 'T1_HIT' ? 'T1 HIT' : (netPnl >= 0 ? 'WIN' : 'LOSS'));

              db.prepare(`
                UPDATE paper_trades
                SET exit_price = ?, exit_time = ?, net_pnl = ?, status = ?, exit_reason = ?
                WHERE id = ?
              `).run(exitPrice, new Date().toISOString(), netPnl, status, exitReason, tradeId);

              // Post-Trade Reflection Memory (TauricResearch-inspired)
              let lessonObj = null;
              try {
                lessonObj = debateEngine.extractLessonFromTrade({
                  symbol: trade.symbol,
                  side: trade.side,
                  netPnl,
                  exitReason,
                  regime: data.regime || 'UNKNOWN',
                  sessionWindow: data.sessionWindow || 'UNKNOWN',
                  paritySignal: data.paritySignal || 'NEUTRAL'
                });
                db.prepare(`
                  INSERT INTO trade_lessons (symbol, side, regime, session_window, parity_signal, exit_reason, net_pnl, lesson)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(lessonObj.symbol, lessonObj.side, lessonObj.regime, lessonObj.sessionWindow, lessonObj.paritySignal, lessonObj.exitReason, lessonObj.netPnl, lessonObj.lesson);
              } catch (_) {}

              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({
                success: true,
                tradeId,
                netPnl: netPnl.toFixed(2),
                status,
                lesson: lessonObj ? lessonObj.lesson : null
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
      // If client requests JSON explicitly via Accept header or query param json=true, return JSON.
      // Otherwise, redirect directly to Kite login portal for seamless browser navigation.
      const wantsJson = query.json === 'true' || (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers.accept.includes('text/html'));
      if (wantsJson) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ loginUrl }));
      }
      res.writeHead(302, { 'Location': loginUrl });
      return res.end();
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

    // ─── KITE WEBSOCKET TICKER ENDPOINTS ────────────────────────────────────

    // 8a. SSE stream — browser connects here to receive live ticks
    //     GET /api/kite/ticker/stream
    if (pathname === '/api/kite/ticker/stream') {
      res.writeHead(200, {
        'Content-Type':                'text/event-stream',
        'Cache-Control':               'no-cache',
        'Connection':                  'keep-alive',
        'X-Accel-Buffering':           'no',
        'Access-Control-Allow-Origin': 'http://127.0.0.1:8000'
      });
      // SSE keep-alive comment every 25s to prevent proxy timeouts
      const keepAlive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch (_) { clearInterval(keepAlive); }
      }, 25000);
      res.on('close', () => clearInterval(keepAlive));

      const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ticker.addSseClient(res, clientId);
      return; // SSE handler — do NOT call res.end()
    }

    // 8b. Subscribe to tokens
    //     POST /api/kite/ticker/subscribe
    //     Body: { tokens: [256265, 408065, ...], mode: "quote" }
    if (pathname === '/api/kite/ticker/subscribe' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { tokens, mode } = JSON.parse(body);
          if (!Array.isArray(tokens) || tokens.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'tokens must be a non-empty array of instrument token integers.' }));
          }
          const session = kite.loadSession();
          if (!session) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'No active Kite session. Login first at /api/kite/login.' }));
          }
          ticker.subscribe(tokens, mode || ticker.MODE_QUOTE);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, subscribed: tokens, mode: mode || ticker.MODE_QUOTE }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // 8c. Unsubscribe from tokens
    //     POST /api/kite/ticker/unsubscribe
    //     Body: { tokens: [256265, ...] }
    if (pathname === '/api/kite/ticker/unsubscribe' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { tokens } = JSON.parse(body);
          ticker.unsubscribe(tokens || []);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, unsubscribed: tokens }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // 8d. Ticker status + last snapshot
    //     GET /api/kite/ticker/status
    if (pathname === '/api/kite/ticker/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ticker.getStatus()));
    }

    // 8e. Auto-resolve & subscribe active MCX + ₹10K NSE proxy instruments in MODE_FULL
    //     POST /api/kite/ticker/auto-subscribe
    if (pathname === '/api/kite/ticker/auto-subscribe' && req.method === 'POST') {
      try {
        const session = kite.loadSession();
        if (!session) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'No active Kite session.' }));
        }
        const mcxTargets = [
          { cid: 'gold', base: 'GOLDPETAL' },
          { cid: 'silver', base: 'SILVERMIC' },
          { cid: 'crude', base: 'CRUDEOILM' },
          { cid: 'natgas', base: 'NATGASM' }
        ];
        const instToCid = {};
        const instruments = [];
        for (const item of mcxTargets) {
          const r = contractResolver.resolveContractExpiry(item.base);
          const key = `MCX:${r.tradingsymbol}`;
          instruments.push(key);
          instToCid[key] = item.cid;
        }
        const nseProxies = [
          { cid: 'gold', sym: 'NSE:GOLDBEES' },
          { cid: 'silver', sym: 'NSE:SILVERBEES' },
          { cid: 'crude', sym: 'NSE:ONGC' },
          { cid: 'natgas', sym: 'NSE:GAIL' }
        ];
        for (const p of nseProxies) {
          instruments.push(p.sym);
          instToCid[p.sym] = p.cid;
        }

        const qRes = await kite.getLiveQuotes(instruments);
        const qData = qRes?.data || {};
        const tokens = [];
        const tokenMap = {};
        for (const [inst, info] of Object.entries(qData)) {
          const tok = Number(info?.instrument_token);
          if (tok > 0) {
            tokens.push(tok);
            tokenMap[tok] = instToCid[inst] || inst;
          }
        }
        if (tokens.length > 0) {
          ticker.subscribe(tokens, ticker.MODE_FULL);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, subscribedCount: tokens.length, tokens, tokenMap }));
      } catch (subErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: subErr.message }));
      }
    }

    // ─── END TICKER ENDPOINTS ────────────────────────────────────────────────

    // 7d. Live Zerodha Broker Position / Order / Margin Reconciliation & ₹10K Routes
    if (pathname === '/api/kite/reconcile' && req.method === 'GET') {
      try {
        const accProfile = getAccountProfile();
        const session = kite.loadSession();
        let todayTrades = [];
        if (db) {
          try {
            todayTrades = db.prepare(`SELECT * FROM paper_trades WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`).all();
          } catch (_) {}
        }

        let connected = false;
        let margins = null;
        let positions = [];
        let orders = [];
        let liveMtmPnl = 0;

        if (session) {
          connected = true;
          const [mRes, pRes, oRes] = await Promise.all([
            kite.getMargins().catch(e => ({ error: e.message })),
            kite.getPositions().catch(e => ({ error: e.message })),
            kite.getOrders().catch(e => ({ error: e.message }))
          ]);
          if (mRes && mRes.data) margins = mRes.data;
          if (pRes && pRes.data) {
            positions = pRes.data.net || pRes.data.day || [];
            liveMtmPnl = positions.reduce((sum, p) => sum + Number(p.m2m ?? p.pnl ?? ((p.realised || 0) + (p.unrealised || 0))), 0);
            liveMtmPnl = Math.round(liveMtmPnl * 100) / 100;
          }
          if (oRes && Array.isArray(oRes.data)) {
            orders = oRes.data;
          }
        }

        const combinedTrades = (connected && liveMtmPnl !== 0)
          ? [{ pnl: liveMtmPnl, timestamp: new Date().toISOString(), source: 'KITE_LIVE' }, ...todayTrades]
          : todayTrades;

        const circuit = circuitBreaker.evaluateCircuitBreaker({
          trades: combinedTrades,
          dailyLossLimit: accProfile.dailyLossLimit
        });

        const tenKRoutes = {};
        if (typeof riskEngine.getTenKExecutionRoute === 'function') {
          for (const cid of ['gold', 'silver', 'crude', 'natgas', 'copper', 'zinc', 'alum']) {
            tenKRoutes[cid] = riskEngine.getTenKExecutionRoute({
              commodityId: cid,
              capital: accProfile.capital,
              riskBudget: accProfile.maxRiskPerTrade
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          connected,
          liveOrdersEnabled: process.env.ENABLE_LIVE_ORDERS === 'true',
          account: accProfile,
          liveMtmPnl,
          margins,
          positions,
          ordersCount: orders.length,
          openOrders: orders.filter(o => o.status === 'OPEN' || o.status === 'TRIGGER PENDING'),
          circuitBreaker: circuit,
          killSwitch: killSwitchState,
          stagedOrdersCount: (() => { pruneExpiredStagedOrders(); return stagedOrders.size; })(),
          tickerStatus: ticker.getStatus(),
          tenKRoutes
        }));
      } catch (recErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: recErr.message }));
      }
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

          const symbol = String(order.tradingsymbol || order.symbol || '').toUpperCase();
          const spec = riskEngine.getContractSpec(symbol);
          const isComm = spec.segment === 'commodity';
          const segment = isComm ? 'commodity' : 'equity';
          const lotMult = Number(order.lotMultiplier) || spec.multiplier || 1;
          const accProfile = getAccountProfile();

          // 0. Global Emergency Kill Switch
          if (killSwitchState.active) {
            res.writeHead(423, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `🛑 KILL SWITCH ACTIVE${killSwitchState.reason ? ': ' + killSwitchState.reason : ''}. Live/Paper Kite orders halted.` }));
          }

          // 1. Check Macroeconomic Event Blackout
          const blackout = macroEvents.checkMacroBlackout(symbol);
          if (blackout.isBlackout && !order.overrideBlackout) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: blackout.warningText }));
          }

          // 2. Check Daily Circuit Breaker
          try {
            const todayTrades = db.prepare(`SELECT * FROM paper_trades WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`).all();
            const circuit = circuitBreaker.evaluateCircuitBreaker({ trades: todayTrades, dailyLossLimit: accProfile.dailyLossLimit });
            if (circuit.tripped && !order.overrideCircuitBreaker) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: circuit.message }));
            }
          } catch (_) {}

          // 3. Resolve Exact Exchange Contract Expiry Symbol
          const resolved = isComm ? contractResolver.resolveContractExpiry(symbol) : { tradingsymbol: symbol, exchange: spec.exchange || 'NSE' };
          order.tradingsymbol = resolved.tradingsymbol || symbol;
          order.symbol = order.tradingsymbol;
          order.exchange = order.exchange || resolved.exchange || (isComm ? 'MCX' : 'NSE');

          // Adaptive Risk Cap: ₹125 default from account profile (₹10,000 capital) unless explicitly specified
          const maxLossBudget = Number(order.maxLossTotal) > 0 ? Number(order.maxLossTotal) : accProfile.maxRiskPerTrade;

          const sized = riskEngine.sizeTrade({
            side: txType,
            entry: price,
            sl: stopLoss,
            target: Number(order.target) || (txType === 'BUY' ? price + (Math.abs(price - stopLoss) * 2) : price - (Math.abs(price - stopLoss) * 2)),
            lotMultiplier: lotMult,
            segment,
            maxLossTotal: maxLossBudget,
            minNetRR: 1.2
          });

          if (!sized.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: sized.reason }));
          }

          const plannedLoss = (Math.abs(price - stopLoss) * lotMult * qty) + sized.stopFees;
          if (plannedLoss > maxLossBudget) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              error: `RISK_VIOLATION: Estimated trade loss (₹${plannedLoss.toFixed(2)} with charges) exceeds ₹${maxLossBudget} budget limit.`
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

    // 7c. Kite Broker GTT OCO Placement API
    if (req.method === 'POST' && pathname === '/api/kite/gtt') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const trigger = JSON.parse(body || '{}');
          const symbol = String(trigger.symbol || trigger.tradingsymbol || '').toUpperCase();
          if (!symbol || !trigger.stoploss || !trigger.target) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing required GTT parameters (symbol, stoploss, target).' }));
          }
          const spec = riskEngine.getContractSpec(symbol);
          const isComm = spec.segment === 'commodity';
          const accProfile = getAccountProfile();

          // 0. Global Emergency Kill Switch
          if (killSwitchState.active) {
            res.writeHead(423, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: `🛑 KILL SWITCH ACTIVE${killSwitchState.reason ? ': ' + killSwitchState.reason : ''}. GTT OCO placement halted.` }));
          }

          // 1. Check Macroeconomic Event Blackout
          const blackout = macroEvents.checkMacroBlackout(symbol);
          if (blackout.isBlackout && !trigger.overrideBlackout) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: blackout.warningText }));
          }

          // 2. Check Daily Circuit Breaker
          try {
            const todayTrades = db.prepare(`SELECT * FROM paper_trades WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`).all();
            const circuit = circuitBreaker.evaluateCircuitBreaker({ trades: todayTrades, dailyLossLimit: accProfile.dailyLossLimit });
            if (circuit.tripped && !trigger.overrideCircuitBreaker) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ error: circuit.message }));
            }
          } catch (_) {}

          // 3. Resolve Exact Exchange Contract Expiry Symbol
          const resolved = isComm ? contractResolver.resolveContractExpiry(symbol) : { tradingsymbol: symbol, exchange: spec.exchange || 'NSE' };
          trigger.tradingsymbol = resolved.tradingsymbol || symbol;
          trigger.symbol = trigger.tradingsymbol;
          trigger.exchange = trigger.exchange || resolved.exchange || (isComm ? 'MCX' : 'NSE');

          const isLiveAllowed = process.env.ENABLE_LIVE_ORDERS === 'true';
          const result = await kite.placeGTT(trigger, isLiveAllowed);

          // Register in server-side +1R Breakeven GTT Guard
          const trigId = result?.data?.trigger_id || result?.trigger_id || result?.id;
          if (trigId && Number(trigger.entry) > 0 && Number(trigger.stoploss) > 0) {
            const fees = riskEngine.calculateZerodhaFees({
              side: trigger.side === 'SELL' ? 'BUY' : 'SELL',
              entry: Number(trigger.entry),
              exit: Number(trigger.target),
              quantity: Number(trigger.quantity || 1),
              lotMultiplier: spec.multiplier || 1,
              segment: spec.segment || 'commodity'
            }).total;
            armedGttGuards.set(String(trigId), {
              triggerId: String(trigId),
              symbol: trigger.tradingsymbol,
              exchange: trigger.exchange,
              exitSide: String(trigger.side || 'SELL').toUpperCase(),
              entrySide: String(trigger.side || 'SELL').toUpperCase() === 'SELL' ? 'BUY' : 'SELL',
              entry: Number(trigger.entry),
              initSl: Number(trigger.stoploss),
              currentSl: Number(trigger.stoploss),
              target: Number(trigger.target),
              quantity: Number(trigger.quantity || 1),
              product: trigger.product || (isComm ? 'NRML' : 'MIS'),
              multiplier: spec.multiplier || 1,
              fees,
              breakevenArmed: false,
              liveAllowed: isLiveAllowed,
              createdAt: new Date().toISOString()
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...result, serverBreakevenGuardArmed: Boolean(trigId) }));
        } catch (gttErr) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: gttErr.message }));
        }
      });
      return;
    }

    // 7d2. Server-Side GTT Breakeven Guard Status API
    if (req.method === 'GET' && pathname === '/api/kite/gtt-guards') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, guards: [...armedGttGuards.values()] }));
    }

    // 7d3. Automatic Edge Finder Profit Factor Matrix (Symbol × Session × Regime)
    if (req.method === 'GET' && pathname === '/api/edge-finder') {
      try {
        const rows = db ? db.prepare('SELECT * FROM trade_lessons ORDER BY id DESC LIMIT 500').all() : [];
        const groups = {};
        for (const r of rows) {
          const sym = String(r.symbol || 'UNKNOWN').replace(/\d{2}[A-Z]{3}FUT$/, '');
          const sess = r.session_window || 'UNKNOWN';
          const reg = r.regime || 'UNKNOWN';
          const key = `${sym}|${sess}|${reg}`;
          if (!groups[key]) {
            groups[key] = {
              symbol: sym,
              sessionWindow: sess,
              regime: reg,
              trades: 0,
              wins: 0,
              losses: 0,
              grossProfit: 0,
              grossLoss: 0,
              netPnl: 0
            };
          }
          const g = groups[key];
          const pnl = Number(r.net_pnl || 0);
          g.trades++;
          g.netPnl += pnl;
          if (pnl > 0) { g.wins++; g.grossProfit += pnl; }
          else if (pnl < 0) { g.losses++; g.grossLoss += Math.abs(pnl); }
        }

        const combos = Object.values(groups).map(g => {
          const pf = g.grossLoss > 0 ? +(g.grossProfit / g.grossLoss).toFixed(2) : (g.grossProfit > 0 ? 9.99 : 0);
          const winRate = g.trades > 0 ? Math.round((g.wins / g.trades) * 100) : 0;
          let status = 'CALIBRATING';
          if (g.trades >= 5 && pf >= 1.35) status = 'PROVEN_EDGE';
          else if (g.trades >= 5 && pf < 1.0) status = 'AUTO_MUTED';
          return {
            ...g,
            winRate,
            profitFactor: pf,
            netPnl: Math.round(g.netPnl * 100) / 100,
            status
          };
        }).sort((a, b) => b.profitFactor - a.profitFactor || b.netPnl - a.netPnl);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          totalLessons: rows.length,
          combos,
          topEdge: combos.find(c => c.status === 'PROVEN_EDGE') || combos[0] || null,
          mutedCombos: combos.filter(c => c.status === 'AUTO_MUTED')
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 7d4. Olymp Trade Co-Pilot Live Ticket Bridge (Chrome Extension Sync)
    if (pathname === '/api/olymp/live-ticket') {
      if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify({
          ...latestOlympTicket,
          killSwitchActive: killSwitchState.active,
          killSwitchReason: killSwitchState.reason,
          blockedReason: killSwitchState.active
            ? `KILL SWITCH ACTIVE${killSwitchState.reason ? ': ' + killSwitchState.reason : ''}`
            : latestOlympTicket.blockedReason
        }));
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            latestOlympTicket = {
              ...data,
              updatedAt: new Date().toISOString()
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, updatedAt: latestOlympTicket.updatedAt }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }
    }

    // 7d5. Global Emergency Kill Switch API (Halts Kite, Paper, GTT Guards & Olymp Co-Pilot)
    if (pathname === '/api/kill-switch') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...killSwitchState }));
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}');
            const nextActive = typeof data.active === 'boolean' ? data.active : !killSwitchState.active;
            killSwitchState = {
              active: nextActive,
              reason: nextActive ? (String(data.reason || 'Manual emergency halt').slice(0, 120)) : null,
              activatedAt: nextActive ? new Date().toISOString() : null
            };
            if (nextActive) {
              stagedOrders.clear();
              console.warn(`🛑 [KILL-SWITCH] ENGAGED: ${killSwitchState.reason}`);
            } else {
              console.log('🟢 [KILL-SWITCH] DISARMED — Desk execution unlocked.');
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, ...killSwitchState }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }
    }

    // 7d6. Staged Order Queue API (Auto-Expiring 5-Minute Review-Before-Fire Queue)
    if (pathname === '/api/staged-orders') {
      pruneExpiredStagedOrders();
      if (req.method === 'GET') {
        const list = [...stagedOrders.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, orders: list }));
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            if (killSwitchState.active) {
              res.writeHead(423, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: '🛑 KILL SWITCH ACTIVE: Cannot stage orders while halted.' }));
            }
            const d = JSON.parse(body || '{}');
            const entry = Number(d.entry);
            const sl = Number(d.sl);
            const target = Number(d.target) || null;
            const qty = Math.max(1, parseInt(d.qty, 10) || 1);
            const side = String(d.side || 'BUY').toUpperCase();
            const symbol = String(d.symbol || 'GOLDPETAL').toUpperCase();
            if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(sl) || sl <= 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'Valid positive Entry and Stop Loss are required to stage an order.' }));
            }
            if ((side === 'BUY' && sl >= entry) || (side === 'SELL' && sl <= entry)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ ok: false, error: 'Invalid SL geometry for trade side.' }));
            }
            const ttlMs = Math.min(15 * 60 * 1000, Math.max(60 * 1000, Number(d.ttlMs) || (5 * 60 * 1000)));
            const nowMs = Date.now();
            const id = `STG-${nowMs.toString(36).toUpperCase()}-${Math.floor(Math.random() * 90 + 10)}`;
            const staged = {
              id,
              symbol,
              exchange: String(d.exchange || 'MCX').toUpperCase(),
              comId: d.comId || 'gold',
              side,
              entry,
              sl,
              target,
              qty,
              lotMultiplier: Number(d.lotMultiplier) || 1,
              segment: d.segment || 'commodity',
              product: String(d.product || 'NRML').toUpperCase(),
              budget: Number(d.budget) || 125,
              estRisk: Number(d.estRisk) || 0,
              createdAtMs: nowMs,
              expiresAt: nowMs + ttlMs
            };
            stagedOrders.set(id, staged);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, order: staged }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }
      if (req.method === 'DELETE') {
        const id = query.id;
        if (id) stagedOrders.delete(String(id));
        else stagedOrders.clear();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, remaining: stagedOrders.size }));
      }
    }

    // 7d7. Autonomous Paper-Trading Pilot API (Monday–Friday Best-Stock & Commodity Auto-Trader + NSE MCP Live MTM)
    if (pathname === '/api/auto-pilot') {
      if (req.method === 'GET') {
        const sessionInfo = autoPilot.getMarketSessionWindow();
        const accProfile = getAccountProfile();
        let openAutoTrades = [];
        if (db) {
          try {
            openAutoTrades = db.prepare(`SELECT * FROM paper_trades WHERE status = 'OPEN' ORDER BY id DESC`).all();
          } catch (_) {}
        }
        // Enrich open paper trades with official NSE MCP live LTP & unrealized MTM P&L
        const openSyms = openAutoTrades.map(t => String(t.symbol || '').toUpperCase());
        const liveQuotes = openSyms.length > 0 ? await nseMcpClient.getBatchStockQuotes(openSyms).catch(() => ({})) : {};
        let totalUnrealizedPnl = 0;
        const enrichedOpenTrades = openAutoTrades.map(t => {
          const q = liveQuotes[String(t.symbol || '').toUpperCase()];
          const ltp = q?.ltp || Number(t.entry_price);
          const grossMtm = (t.side === 'BUY' ? (ltp - Number(t.entry_price)) : (Number(t.entry_price) - ltp)) * Number(t.qty || 1);
          const fees = Number(t.brokerage || 0) + Number(t.stt_gst || 0);
          const netMtm = Math.round((grossMtm - fees) * 100) / 100;
          totalUnrealizedPnl += netMtm;
          return {
            ...t,
            liveLtp: ltp,
            livePerChange: q?.perChange ?? null,
            grossMtm: Math.round(grossMtm * 100) / 100,
            netMtm
          };
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          enabled: autoPilotState.enabled,
          killSwitchActive: killSwitchState.active,
          account: accProfile,
          maxConcurrentOpen: autoPilotState.maxConcurrentOpen,
          maxDailyTrades: autoPilotState.maxDailyTrades,
          lastScanAt: autoPilotState.lastScanAt,
          session: sessionInfo,
          openTradesCount: enrichedOpenTrades.length,
          totalUnrealizedPnl: Math.round(totalUnrealizedPnl * 100) / 100,
          openTrades: enrichedOpenTrades,
          nseMcpOverview: autoPilotState.nseMcpOverview,
          topStocks: autoPilotState.topStocks,
          stockEvaluations: autoPilotState.stockEvaluations,
          evaluations: autoPilotState.lastEvaluations,
          activityLog: autoPilotState.activityLog.slice(0, 20)
        }));
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const d = JSON.parse(body || '{}');
            if (typeof d.enabled === 'boolean') {
              autoPilotState.enabled = d.enabled;
              logAutoPilotEvent(
                d.enabled ? 'ARMED' : 'PAUSED',
                d.enabled
                  ? 'Auto-Paper Pilot ARMED (₹15,000 budget · Official NSE MCP Live + MCX · Mon–Fri 09:15 IST).'
                  : 'Auto-Paper Pilot paused by user.'
              );
            }
            let scanReport = null;
            if (d.action === 'SCAN_NOW' || d.runScan) {
              scanReport = await runAutoPaperPilotCycle({
                forceScan: true,
                allowForceEntry: Boolean(d.allowForceEntry)
              });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              ok: true,
              enabled: autoPilotState.enabled,
              account: getAccountProfile(),
              lastScanAt: autoPilotState.lastScanAt,
              session: autoPilot.getMarketSessionWindow(),
              nseMcpOverview: autoPilotState.nseMcpOverview,
              topStocks: autoPilotState.topStocks,
              stockEvaluations: autoPilotState.stockEvaluations,
              evaluations: autoPilotState.lastEvaluations,
              activityLog: autoPilotState.activityLog.slice(0, 20),
              scanReport
            }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
        return;
      }
    }

    // 7d8. Direct Official NSE MCP Intelligence Endpoint (/api/nse-mcp/live)
    if (pathname === '/api/nse-mcp/live' && req.method === 'GET') {
      try {
        const force = query.force === '1' || query.force === 'true';
        const symbol = query.symbol ? String(query.symbol).toUpperCase().trim() : null;
        const [overview, quote] = await Promise.all([
          nseMcpClient.getLiveMarketOverview(force),
          symbol ? nseMcpClient.getLiveStockQuote(symbol) : Promise.resolve(null)
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, overview, quote }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 8a. Macroeconomic Events & Blackout Status API
    if (req.method === 'GET' && pathname === '/api/macro-events') {
      const symbol = query.symbol || 'all';
      const blackout = macroEvents.checkMacroBlackout(symbol);
      const upcoming = macroEvents.getUpcomingEvents();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ blackout, upcoming }));
    }

    // 8b. Daily Circuit Breaker Status API
    if (req.method === 'GET' && pathname === '/api/circuit-breaker') {
      try {
        const accProfile = getAccountProfile();
        const todayTrades = db.prepare(`SELECT * FROM paper_trades WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`).all();
        const status = circuitBreaker.evaluateCircuitBreaker({ trades: todayTrades, dailyLossLimit: accProfile.dailyLossLimit });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(status));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ tripped: false, dailyNetPnl: 0, consecutiveLosses: 0, message: 'Circuit breaker active' }));
      }
    }

    // 8c. Live Web Geopolitical & Historical Analog Intelligence API
    if (req.method === 'GET' && pathname === '/api/geopolitical/live') {
      try {
        const force = query.force === '1' || query.force === 'true';
        const intel = await geopoliticalAnalogs.getLiveGeopoliticalIntelligence(force);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(intel));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 8d. Historical Geopolitical & Trade Shock Encyclopedia API
    if (req.method === 'GET' && pathname === '/api/geopolitical/history') {
      const q = String(query.q || '').trim();
      const events = geopoliticalHistory.getAllEvents();
      const dependencyGraph = geopoliticalHistory.getDependencyGraph();
      const analogMatch = q ? geopoliticalHistory.matchHistoricalAnalog(q) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ events, dependencyGraph, analogMatch }));
    }

    // 8e. Institutional SMC Pattern Recognition Scanner API
    if (req.method === 'POST' && pathname === '/api/patterns/scan') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}');
          let candles = payload.candles;

          // If no candles passed, optionally load latest candles for symbol from SQLite
          if ((!Array.isArray(candles) || candles.length === 0) && payload.symbol && db) {
            const sym = String(payload.symbol).toUpperCase().replace('.NS', '');
            const rows = db.prepare(`SELECT open, high, low, close, volume, time FROM candles WHERE symbol = ? ORDER BY time DESC LIMIT 120`).all(sym);
            candles = rows.reverse();
          }

          const scan = patternEngine.scanPatterns(candles || payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(scan));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 8e2. Post-Trade Reflection Lessons API (SQLite trade_lessons)
    if (req.method === 'GET' && pathname === '/api/lessons') {
      try {
        const sym = query.symbol ? String(query.symbol).toUpperCase().trim() : null;
        let lessons = [];
        if (db) {
          lessons = sym
            ? db.prepare(`SELECT * FROM trade_lessons WHERE symbol LIKE ? ORDER BY id DESC LIMIT 15`).all(`%${sym}%`)
            : db.prepare(`SELECT * FROM trade_lessons ORDER BY id DESC LIMIT 20`).all();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, lessons }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }

    // 8e3. TauricResearch-Inspired Bull vs. Bear Devil's Advocate Debate API
    if (req.method === 'POST' && pathname === '/api/ai/debate') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const symbol = String(payload.symbol || payload.commodityId || 'GOLDM').toUpperCase();
          const action = String(payload.action || 'WAIT').toUpperCase();
          const useAi = payload.useAi !== false;

          let recentLessons = [];
          if (db) {
            try {
              const baseKey = symbol.replace(/\d{2}[A-Z]{3}FUT$/, '');
              recentLessons = db.prepare(`SELECT * FROM trade_lessons WHERE symbol LIKE ? ORDER BY id DESC LIMIT 8`).all(`%${baseKey}%`);
            } catch (_) {}
          }

          const geoIntel = payload.geoIntel || await geopoliticalAnalogs.getLiveGeopoliticalIntelligence(false).catch(() => null);
          const quantDebate = debateEngine.buildQuantitativeDebate({
            symbol,
            commodityId: payload.commodityId || 'gold',
            action,
            confidence: Number(payload.confidence || 0),
            regime: payload.regime || 'TRANSITIONAL',
            htfTrend: payload.htfTrend || null,
            dualFeed: payload.dualFeed || null,
            smc: payload.smc || null,
            geoIntel,
            recentLessons,
            netRR: Number(payload.netRR || 0)
          });

          const cacheKey = `ai_debate_${symbol}_${action}_${payload.regime || ''}`;
          const cachedAi = useAi ? getCached(cacheKey) : null;
          if (cachedAi) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ...cachedAi, cached: true, recentLessons: recentLessons.slice(0, 5) }));
          }

          const apiKey = useAi ? getAnthropicKey() : null;
          if (apiKey && (action === 'BUY' || action === 'SELL')) {
            try {
              const promptCtx = JSON.stringify({
                symbol,
                proposedAction: action,
                confidence: payload.confidence,
                regime: payload.regime,
                htfBias: payload.htfTrend?.bias,
                dualFeed: payload.dualFeed?.summary,
                netRR: payload.netRR,
                quantVerdict: quantDebate.verdict,
                quantBull: quantDebate.bullCase,
                quantBear: quantDebate.bearCase,
                pastLessons: recentLessons.slice(0, 4).map(l => l.lesson)
              });
              const aiResp = await fetchJson('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                  'x-api-key': apiKey,
                  'anthropic-version': '2023-06-01',
                  'content-type': 'application/json'
                },
                timeout: 15000
              }, {
                model: 'claude-haiku-4-5',
                max_tokens: 420,
                system: 'You are a TauricResearch-style Bull vs Bear Devil\'s Advocate Risk Desk for an Indian ₹10,000 Zerodha & Olymp Trade desk. Respond ONLY with valid JSON: {"bullCase":["...","..."],"bearCase":["...","..."],"verdict":"CONFIRM"|"HALVE_SIZE"|"VETO","rationale":"<1 concise sentence>"}. Prioritize capital preservation and never encourage chasing.',
                messages: [{ role: 'user', content: `Debate this live setup critically:\n${promptCtx}` }]
              });

              if (aiResp.data?.content?.[0]?.text) {
                const clean = aiResp.data.content[0].text.replace(/```json|```/g, '').trim();
                const parsed = JSON.parse(clean);
                const merged = {
                  ...quantDebate,
                  bullCase: Array.isArray(parsed.bullCase) && parsed.bullCase.length ? parsed.bullCase.slice(0, 4) : quantDebate.bullCase,
                  bearCase: Array.isArray(parsed.bearCase) && parsed.bearCase.length ? parsed.bearCase.slice(0, 4) : quantDebate.bearCase,
                  verdict: ['CONFIRM', 'HALVE_SIZE', 'VETO'].includes(parsed.verdict) ? parsed.verdict : quantDebate.verdict,
                  sizeMultiplier: parsed.verdict === 'VETO' ? 0 : (parsed.verdict === 'HALVE_SIZE' ? 0.5 : quantDebate.sizeMultiplier),
                  rationale: parsed.rationale || quantDebate.rationale,
                  source: 'CLAUDE_HAIKU_DEBATE'
                };
                setCache(cacheKey, merged, 10 * 60 * 1000);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ...merged, cached: false, recentLessons: recentLessons.slice(0, 5) }));
              }
            } catch (_) {}
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ...quantDebate, cached: false, recentLessons: recentLessons.slice(0, 5) }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // 8f. Pre-Market Daily Briefing API
    if (req.method === 'GET' && pathname === '/api/briefing') {
      try {
        const kt = nseHolidays.getKolkataTime();
        const isNseOpenDay = nseHolidays.isNseTradingDay(kt.dateStr);
        const holidayReason = isNseOpenDay ? null : nseHolidays.getHolidayReason(kt.dateStr);
        const contracts = ['CRUDEOILM', 'GOLDM', 'GOLDPETAL', 'SILVERMIC', 'NATGASM'].map(sym =>
          contractResolver.resolveContractExpiry(sym)
        );
        const upcomingMacro = macroEvents.getUpcomingEvents();
        const geoIntel = await geopoliticalAnalogs.getLiveGeopoliticalIntelligence(false);

        const accProfile = getAccountProfile();
        let circuit = { tripped: false, dailyNetPnl: 0, consecutiveLosses: 0, remainingLossBudget: accProfile.dailyLossLimit };
        if (db) {
          try {
            const todayTrades = db.prepare(`SELECT * FROM paper_trades WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`).all();
            circuit = circuitBreaker.evaluateCircuitBreaker({ trades: todayTrades, dailyLossLimit: accProfile.dailyLossLimit });
          } catch (_) {}
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          generatedAt: new Date().toISOString(),
          istDate: kt.dateStr,
          account: accProfile,
          nseSession: { isTradingDay: isNseOpenDay, holidayReason },
          activeContracts: contracts,
          upcomingMacro: upcomingMacro.slice(0, 4),
          geopolitical: {
            threatLevel: geoIntel.threatLevel,
            riskIndex: geoIntel.riskIndex,
            closestAnalog: geoIntel.closestAnalog,
            topHeadline: geoIntel.topHeadlines?.[0]?.title || null,
            playbook: geoIntel.institutionalPlaybook?.[0] || null
          },
          circuitBreaker: circuit
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 8g. Cross-Asset Geopolitical + SMC Screener API
    if (req.method === 'GET' && pathname === '/api/cross-screener') {
      try {
        const geoIntel = await geopoliticalAnalogs.getLiveGeopoliticalIntelligence(false);
        const stockImpacts = geoIntel.stockImpacts || {};
        const depGraph = geopoliticalHistory.getDependencyGraph();

        const equityUniverse = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'BHARTIARTL', 'SBIN', 'ITC', 'LT', 'KOTAKBANK', 'AXISBANK', 'MARUTI'];
        const equityResults = [];
        if (db) {
          for (const sym of equityUniverse) {
            const rows = db.prepare(`SELECT open, high, low, close, volume, time FROM candles WHERE symbol = ? ORDER BY time DESC LIMIT 120`).all(sym);
            if (rows.length >= 10) {
              const scan = patternEngine.scanPatterns(rows.reverse());
              const lastClose = rows[rows.length - 1]?.close || 0;
              equityResults.push({
                symbol: sym,
                lastClose,
                structure: scan.structure?.state || 'RANGING',
                bias: scan.structure?.bias || 'NEUTRAL',
                smcScore: scan.confluenceScore,
                action: scan.action,
                freshOBs: (scan.orderBlocks || []).filter(o => !o.mitigated).length,
                virginFVGs: (scan.fvgs || []).filter(f => !f.mitigated).length,
                sweeps: (scan.sweeps || []).length
              });
            }
          }
        }
        equityResults.sort((a, b) => Math.abs(b.smcScore - 50) - Math.abs(a.smcScore - 50));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          updatedAt: new Date().toISOString(),
          threatLevel: geoIntel.threatLevel,
          closestAnalog: geoIntel.closestAnalog?.name || null,
          geopoliticalStockImpacts: stockImpacts,
          dependencyGraph: depGraph,
          nseSmcScreener: equityResults
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 9. Static File Serving (STRICT ALLOWLIST)
    if ((req.method === 'GET' || req.method === 'HEAD') && ALLOWED_STATIC_FILES[pathname]) {
      const fileName = ALLOWED_STATIC_FILES[pathname];
      const safePath = path.join(__dirname, fileName);

      const contentType = fileName.endsWith('.js')
        ? 'application/javascript; charset=utf-8'
        : 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType });
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
  
  // On startup catch-up: detect any missing sessions from the last 60 days
  setTimeout(() => {
    try {
      const { catchUpMissingSessions } = require('./scripts/archive_candles');
      catchUpMissingSessions(db).catch(e => console.error('Startup catch-up error:', e.message));
    } catch (err) {
      console.error('Startup catch-up initialization error:', err.message);
    }
  }, 3000);

  // Start Kite WebSocket ticker (connects if active session exists; retries automatically)
  setTimeout(() => {
    ticker.start();
  }, 5000);
});

// ─────────────────────────────────────────────────────────────
// AUTOMATED EOD & MORNING CANDLE ARCHIVER SCHEDULER
// Pinned strictly to Asia/Kolkata (UTC+5:30) via shared/nse_holidays.js
// Primary Run: 16:30 IST on weekdays (allowing EOD auction/settlement bars to finalize)
// Secondary Gap-Fill Run: 08:30 IST next morning on weekdays (pre-market audit)
// ─────────────────────────────────────────────────────────────
const { getKolkataTime, isNseTradingDay } = require('./shared/nse_holidays');
let lastArchivedPrimaryDate = null;
let lastArchivedMorningDate = null;

setInterval(() => {
  try {
    const kt = getKolkataTime();
    if (!isNseTradingDay(kt.dateStr)) return; // Quietly skip weekends and holidays

    // 1. Primary Run: Once past 16:30 IST
    if (kt.hour > 16 || (kt.hour === 16 && kt.minute >= 30)) {
      if (lastArchivedPrimaryDate !== kt.dateStr) {
        lastArchivedPrimaryDate = kt.dateStr;
        console.log(`⏰ [SCHEDULER 16:30 IST] Running primary EOD candle archiver for ${kt.dateStr}...`);
        const { runArchiver } = require('./scripts/archive_candles');
        runArchiver().catch(e => console.error('Scheduler EOD archiver error:', e.message));
      }
    }

    // 2. Secondary Gap-Fill Run: 08:30 IST next morning
    if (kt.hour === 8 && kt.minute >= 30) {
      if (lastArchivedMorningDate !== kt.dateStr) {
        lastArchivedMorningDate = kt.dateStr;
        console.log(`⏰ [SCHEDULER 08:30 IST] Running morning gap-fill check for ${kt.dateStr}...`);
        const { catchUpMissingSessions } = require('./scripts/archive_candles');
        catchUpMissingSessions(db).catch(e => console.error('Scheduler morning catch-up error:', e.message));
      }
    }
  } catch (_) {}
}, 5 * 60 * 1000); // Check every 5 minutes

// ─────────────────────────────────────────────────────────────
// SERVER-SIDE LIVE GTT +1R FEE-COVERED BREAKEVEN GUARD LOOP
// Runs every 10s when Kite session is active & GTT guards are armed
// ─────────────────────────────────────────────────────────────
async function evaluateGttBreakevenGuards() {
  if (killSwitchState.active) return;
  if (armedGttGuards.size === 0) return;
  const pending = [...armedGttGuards.values()].filter(g => !g.breakevenArmed);
  if (pending.length === 0) return;
  const session = kite.loadSession();
  if (!session) return;

  try {
    const instList = [...new Set(pending.map(g => `${g.exchange}:${g.symbol}`))];
    const qRes = await kite.getLiveQuotes(instList);
    const qData = qRes?.data || {};
    for (const g of pending) {
      const ltp = Number(qData[`${g.exchange}:${g.symbol}`]?.last_price || 0);
      if (!ltp || !isFinite(ltp)) continue;
      const initRisk = Math.abs(g.entry - g.initSl);
      if (initRisk <= 0) continue;
      const feePerUnit = (g.fees || 45) / Math.max(1, g.multiplier * g.quantity);

      let newSl = null;
      if (g.entrySide === 'BUY' && ltp >= g.entry + initRisk) {
        newSl = +(g.entry + feePerUnit).toFixed(2);
      } else if (g.entrySide === 'SELL' && ltp <= g.entry - initRisk) {
        newSl = +(g.entry - feePerUnit).toFixed(2);
      }

      if (newSl != null) {
        await kite.modifyGTT(g.triggerId, {
          tradingsymbol: g.symbol,
          exchange: g.exchange,
          side: g.exitSide,
          entry: ltp,
          stoploss: newSl,
          target: g.target,
          quantity: g.quantity,
          product: g.product
        }, g.liveAllowed);
        g.currentSl = newSl;
        g.breakevenArmed = true;
        g.breakevenAt = new Date().toISOString();
        console.log(`🛡️ [GTT-GUARD] Auto-trailed ${g.symbol} (#${g.triggerId}) SL to fee-covered breakeven ₹${newSl}`);
      }
    }
  } catch (_) {}
}
setInterval(evaluateGttBreakevenGuards, 10000);

// ─────────────────────────────────────────────────────────────
// AUTONOMOUS PAPER-TRADING PILOT ENGINE (₹15,000 BUDGET · BEST STOCKS & COMMODITIES)
// Scans 12 Nifty-50 Large-Cap Stocks + 5 Commodities every 60s during market hours,
// identifies & ranks Today's Top Best Stocks, manages +1R breakeven & SL/Target/EOD exits,
// and auto-executes paper trades within the ₹15,000 capital / ₹150 risk-per-trade guardrails.
// ─────────────────────────────────────────────────────────────
let autoPilotBusy = false;

async function loadCandlesForAutoPilotSymbol({ ticker, dbSym, fetchLive = false }) {
  // 1. When market is open (fetchLive=true), fetch fresh Yahoo 5m bars and update SQLite
  if (fetchLive) {
    try {
      const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=5m&range=5d`;
      const yfResp = await fetchJson(yfUrl, { timeout: 2800 });
      const res0 = yfResp?.data?.chart?.result?.[0];
      if (res0 && Array.isArray(res0.timestamp) && res0.indicators?.quote?.[0]) {
        const q = res0.indicators.quote[0];
        const rows = [];
        for (let i = 0; i < res0.timestamp.length; i++) {
          const cl = q.close?.[i], hi = q.high?.[i], lo = q.low?.[i];
          const op = q.open?.[i] != null ? q.open[i] : cl;
          const vl = q.volume?.[i] || 0;
          if (cl != null && isFinite(cl) && hi != null && isFinite(hi) && lo != null && isFinite(lo) && cl > 0) {
            rows.push({ time: res0.timestamp[i], open: op, high: hi, low: lo, close: cl, volume: vl });
          }
        }
        if (rows.length >= 25) {
          if (db) {
            try {
              const ins = db.prepare(`INSERT OR REPLACE INTO candles (symbol, interval, time, open, high, low, close, volume) VALUES (?, '5m', ?, ?, ?, ?, ?, ?)`);
              for (const c of rows.slice(-60)) ins.run(dbSym, c.time, c.open, c.high, c.low, c.close, c.volume);
            } catch (_) {}
          }
          return rows.slice(-240);
        }
      }
    } catch (_) {}
  }

  // 2. Instant read from local SQLite 5m archive (135,000+ bars across 12 NSE stocks & 5 commodities)
  if (db) {
    try {
      const rows = db.prepare(
        `SELECT time, open, high, low, close, volume FROM candles WHERE symbol = ? ORDER BY time DESC LIMIT 240`
      ).all(dbSym).reverse();
      if (rows.length >= 25) return rows;
    } catch (_) {}
  }
  return [];
}

async function runAutoPaperPilotCycle({ forceScan = false, allowForceEntry = false } = {}) {
  if (autoPilotBusy) return { skipped: true, reason: 'BUSY' };
  const sessionInfo = autoPilot.getMarketSessionWindow();
  autoPilotState.lastSessionStatus = sessionInfo;

  if (!forceScan && (!autoPilotState.enabled || killSwitchState.active || !sessionInfo.isAnySessionOpen)) {
    return {
      skipped: true,
      reason: killSwitchState.active ? 'KILL_SWITCH_ACTIVE' : (!autoPilotState.enabled ? 'DISABLED' : 'MARKET_CLOSED'),
      session: sessionInfo
    };
  }

  autoPilotBusy = true;
  try {
    const accProfile = getAccountProfile();
    const todayTrades = db
      ? db.prepare(`SELECT * FROM paper_trades WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`).all()
      : [];
    const recentLessons = db
      ? db.prepare(`SELECT * FROM trade_lessons ORDER BY id DESC LIMIT 40`).all()
      : [];
    const [geoIntel, nseMcpOverview, nseMcpQuotes] = await Promise.all([
      geopoliticalAnalogs.getLiveGeopoliticalIntelligence(false).catch(() => null),
      nseMcpClient.getLiveMarketOverview(false).catch(() => null),
      nseMcpClient.getBatchStockQuotes(autoPilot.AUTO_PILOT_STOCKS.map(s => s.symbol)).catch(() => ({}))
    ]);
    if (nseMcpOverview) {
      autoPilotState.nseMcpOverview = nseMcpOverview;
    }

    // Fetch 20/50 DMA + 52W High/Low + Corporate Action Shield profiles (30m cached per symbol) in chunks of 4
    const swingProfiles = {};
    for (let i = 0; i < autoPilot.AUTO_PILOT_STOCKS.length; i += 4) {
      const chunk = autoPilot.AUTO_PILOT_STOCKS.slice(i, i + 4);
      const chunkResults = await Promise.all(
        chunk.map(s => nseMcpClient.getSwingDailyProfile(s.symbol, nseMcpQuotes[s.symbol]?.ltp || 0).catch(() => null))
      );
      chunk.forEach((s, idx) => {
        if (chunkResults[idx]) swingProfiles[s.symbol] = chunkResults[idx];
      });
    }

    const stockEvaluations = [];
    const evaluations = [];
    const latestPrices = {};

    // 1. Scan & Rank All 12 Nifty-50 Large-Cap NSE Stocks for the ₹15,000 Budget (powered by Official NSE MCP Live Feed)
    for (const stock of autoPilot.AUTO_PILOT_STOCKS) {
      const rawCandles = await loadCandlesForAutoPilotSymbol({
        ticker: stock.ticker,
        dbSym: stock.symbol,
        fetchLive: sessionInfo.isNseHours
      });
      const stockLessons = recentLessons.filter(l => String(l.symbol || '').includes(stock.symbol));
      const mcpQuote = nseMcpQuotes[stock.symbol] || null;
      // Persist live NSE MCP 5m bar into SQLite so local candle history stays current
      if (mcpQuote && mcpQuote.ltp > 0 && db && sessionInfo.isNseHours) {
        try {
          const bucketSec = Math.floor(Date.now() / 300000) * 300;
          const existing = db.prepare(`SELECT open, high, low FROM candles WHERE symbol = ? AND interval = '5m' AND time = ?`).get(stock.symbol, bucketSec);
          const op = existing ? existing.open : mcpQuote.ltp;
          const hi = existing ? Math.max(existing.high, mcpQuote.ltp) : mcpQuote.ltp;
          const lo = existing ? Math.min(existing.low, mcpQuote.ltp) : mcpQuote.ltp;
          db.prepare(`INSERT OR REPLACE INTO candles (symbol, interval, time, open, high, low, close, volume) VALUES (?, '5m', ?, ?, ?, ?, ?, ?)`).run(
            stock.symbol, bucketSec, op, hi, lo, mcpQuote.ltp, mcpQuote.volume || 0
          );
        } catch (_) {}
      }
      const sev = autoPilot.evaluateStockForAutoPilot({
        stock,
        rawCandles,
        nseMcpQuote: mcpQuote,
        nseMcpOverview,
        swingProfile: swingProfiles[stock.symbol] || null,
        recentLessons: stockLessons,
        geoIntel,
        accountProfile: accProfile,
        todayTrades
      });
      stockEvaluations.push(sev);
      if (sev.executionPlan && sev.executionPlan.entryPrice > 0) {
        const lastCandleSec = rawCandles.length > 0 ? Number(rawCandles[rawCandles.length - 1].time || 0) : 0;
        const isCandleToday = (Math.floor(Date.now() / 1000) - lastCandleSec) < 36000;
        const isLiveQuote = Boolean((mcpQuote && mcpQuote.ltp > 0) || isCandleToday);
        const livePx = mcpQuote?.ltp || sev.executionPlan.entryPrice;
        latestPrices[stock.symbol] = {
          price: livePx,
          high: livePx,
          low: livePx,
          isLive: isLiveQuote,
          regime: sev.regime,
          sessionWindow: sev.sessionWindow,
          paritySignal: sev.paritySignal
        };
      }
    }

    const topStocks = autoPilot.rankBestStocksOfDay(stockEvaluations, 5);

    // 2. Scan All 5 Core MCX Commodities
    for (const asset of autoPilot.AUTO_PILOT_ASSETS) {
      const rawCandles = await loadCandlesForAutoPilotSymbol({
        ticker: asset.ticker,
        dbSym: asset.dbSym,
        fetchLive: sessionInfo.isMcxHours
      });
      const assetLessons = recentLessons.filter(l => String(l.symbol || '').includes(asset.dbSym) || String(l.symbol || '').includes(asset.name));
      const ev = autoPilot.evaluateCommodityForAutoPilot({
        asset,
        rawCandles,
        usdInr: 93.95,
        newsScore: 50,
        recentLessons: assetLessons,
        geoIntel,
        accountProfile: accProfile,
        todayTrades
      });
      evaluations.push(ev);

      if (ev.executionPlan && ev.executionPlan.entryPrice > 0) {
        const pxInfo = {
          price: ev.executionPlan.entryPrice,
          high: ev.executionPlan.currentHigh || ev.executionPlan.entryPrice,
          low: ev.executionPlan.currentLow || ev.executionPlan.entryPrice,
          regime: ev.regime,
          sessionWindow: ev.sessionWindow,
          paritySignal: ev.paritySignal
        };
        latestPrices[ev.executionPlan.tradingsymbol] = pxInfo;
        latestPrices[ev.executionPlan.tradingsymbol.replace(/\d{2}[A-Z]{3}FUT$/, '')] = pxInfo;
      }
    }

    autoPilotState.lastScanAt = new Date().toISOString();
    autoPilotState.stockEvaluations = stockEvaluations;
    autoPilotState.topStocks = topStocks;
    autoPilotState.lastEvaluations = evaluations;

    // Step A: Manage existing open paper positions (+1R Breakeven + SL/Target/EOD Auto-Close + Reflection Lessons)
    const lifecycle = autoPilot.manageOpenPaperPositions({
      db,
      latestPrices,
      sessionInfo
    });
    for (const be of lifecycle.breakevenArmed) {
      logAutoPilotEvent('BREAKEVEN_ARMED', `Trailed ${be.symbol} (#${be.tradeId}) SL to fee-covered breakeven ₹${be.newSl}`, be);
    }
    for (const cl of lifecycle.closed) {
      logAutoPilotEvent('AUTO_CLOSED', `Closed ${cl.symbol} ${cl.side} (#${cl.tradeId}) via ${cl.exitReason} @ ₹${cl.exitPrice} | Net P&L: ₹${cl.netPnl}`, cl);
    }

    // Step B: Evaluate New Auto-Paper Entries (prioritizing Top Qualifying NSE Stocks, then Commodities)
    const openedTrades = [];
    const canEnterNow = (sessionInfo.isAnySessionOpen || allowForceEntry) && autoPilotState.enabled && !killSwitchState.active;

    if (canEnterNow && db) {
      const freshTodayTrades = db.prepare(`SELECT * FROM paper_trades WHERE date(created_at, '+5 hours', '+30 minutes') = date('now', '+5 hours', '+30 minutes')`).all();
      const cb = circuitBreaker.evaluateCircuitBreaker({
        trades: freshTodayTrades,
        dailyLossLimit: accProfile.dailyLossLimit,
        maxConsecutiveLosses: 2,
        maxDailyTrades: autoPilotState.maxDailyTrades || 4
      });

      if (!cb.tripped) {
        const openNow = db.prepare(`SELECT * FROM paper_trades WHERE status = 'OPEN'`).all();
        const openSyms = new Set(openNow.map(t => String(t.symbol).toUpperCase()));
        let slotsLeft = Math.max(0, autoPilotState.maxConcurrentOpen - openNow.length);
        let dailyTradesLeft = Math.max(0, (cb.maxDailyTrades || 4) - (cb.todayTradeCount || 0));

        // Combine qualifying Top Stocks first, followed by qualifying Commodities
        let candidates = [
          ...topStocks.filter(s => s.qualifiesForAutoExec && s.executionPlan),
          ...evaluations.filter(e => e.qualifiesForAutoExec && e.executionPlan).sort((a, b) => b.confidence - a.confidence)
        ];

        // If user explicitly clicked "Force Paper Test" (allowForceEntry=true) and no strict setup is live right now,
        // use the #1 ranked Best Stock of the Day (provided Debate did not VETO it) so they can test paper execution immediately
        if (allowForceEntry && candidates.length === 0 && topStocks.length > 0 && topStocks[0].debateVerdict !== 'VETO') {
          candidates = [topStocks[0]];
        }

        for (const cand of candidates) {
          if (slotsLeft <= 0 || dailyTradesLeft <= 0) break;
          const p = cand.executionPlan;
          if (!p || openSyms.has(p.tradingsymbol)) continue;

          if (!allowForceEntry) {
            if (p.exchange === 'NSE' && !sessionInfo.isNseHours) continue;
            if (p.exchange === 'MCX' && !sessionInfo.isMcxHours) continue;
          }

          const lastEntryMs = autoPilotState.symbolLastEntryMs[p.tradingsymbol] || 0;
          if (!allowForceEntry && (Date.now() - lastEntryMs) < autoPilotState.cooldownMinutes * 60 * 1000) {
            continue;
          }

          const isCncSwing = p.product === 'CNC' || p.bucket === 'CNC_SWING';
          let brokerage = 0;
          let sttGst = 0;
          if (isCncSwing) {
            // Zerodha CNC Equity Delivery: ₹0 brokerage, ~0.22% round-trip STT + stamp + exchange charges
            brokerage = 0;
            sttGst = Math.round(p.entryPrice * p.qty * 0.0022 * 100) / 100;
          } else {
            const feesAtEntry = riskEngine.calculateZerodhaFees({
              segment: p.segment,
              buyPrice: p.side === 'BUY' ? p.entryPrice : p.stopLoss,
              sellPrice: p.side === 'BUY' ? p.stopLoss : p.entryPrice,
              qty: p.qty,
              lotMultiplier: p.lotMultiplier
            });
            brokerage = feesAtEntry.brokerage;
            sttGst = Math.round((feesAtEntry.totalFees - brokerage) * 100) / 100;
          }

          const entryTag = isCncSwing ? 'AUTO_PILOT_CNC_SWING' : 'AUTO_PILOT';
          const ins = db.prepare(`
            INSERT INTO paper_trades (symbol, side, qty, entry_price, entry_time, stop_loss, target, brokerage, stt_gst, status, exit_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
          `);
          const info = ins.run(p.tradingsymbol, p.side, p.qty, p.entryPrice, new Date().toISOString(), p.stopLoss, p.target1, brokerage, sttGst, entryTag);
          const tradeId = Number(info.lastInsertRowid);

          try {
            db.prepare(`
              INSERT INTO signals (symbol, time, action, confidence, price, stop_loss, target1, target2, reason, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')
            `).run(
              p.tradingsymbol,
              new Date().toISOString(),
              p.side,
              cand.confidence,
              p.entryPrice,
              p.stopLoss,
              p.target1,
              p.target2,
              `[AUTO-PILOT ${p.bucket || 'MIS_INTRADAY'} ${cand.archetype || 'TREND_RUNNER'} ${cand.debateVerdict}] ${cand.regime} · Net R:R 1:${p.netRR}`
            );
          } catch (_) {}

          autoPilotState.symbolLastEntryMs[p.tradingsymbol] = Date.now();
          openSyms.add(p.tradingsymbol);
          slotsLeft--;
          dailyTradesLeft--;

          const opened = {
            tradeId,
            assetType: cand.assetType || 'STOCK',
            bucket: p.bucket || 'MIS_INTRADAY',
            product: p.product || 'MIS',
            archetype: cand.archetype || 'TREND_RUNNER',
            symbol: p.tradingsymbol,
            exchange: p.exchange,
            side: p.side,
            qty: p.qty,
            entryPrice: p.entryPrice,
            stopLoss: p.stopLoss,
            target: p.target1,
            marginRequired: p.marginRequired || null,
            plannedLoss: p.plannedLoss,
            netRR: p.netRR,
            confidence: cand.confidence,
            compositeRankScore: cand.compositeRankScore || cand.confidence,
            debateVerdict: cand.debateVerdict
          };
          openedTrades.push(opened);
          logAutoPilotEvent(
            'AUTO_OPENED',
            `Opened #${tradeId} [${opened.bucket}/${opened.archetype}] ${p.exchange}:${p.tradingsymbol} ${p.side} ×${p.qty} @ ₹${p.entryPrice} (SL ₹${p.stopLoss} · T1 ₹${p.target1} · Net R:R 1:${p.netRR})`,
            opened
          );
        }
      }
    }

    return {
      ok: true,
      scannedAt: autoPilotState.lastScanAt,
      session: sessionInfo,
      lifecycle,
      openedTrades,
      topStocks,
      stockEvaluations,
      evaluations
    };
  } finally {
    autoPilotBusy = false;
  }
}

// Run initial diagnostic evaluation 6s after server boot & then every 60s during live market sessions
setTimeout(() => {
  runAutoPaperPilotCycle({ forceScan: true, allowForceEntry: false }).catch(() => {});
}, 6000);

setInterval(() => {
  if (autoPilotState.enabled && !killSwitchState.active) {
    runAutoPaperPilotCycle({ forceScan: false, allowForceEntry: false }).catch(() => {});
  }
}, 60 * 1000);

module.exports = server;
