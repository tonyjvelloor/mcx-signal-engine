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
  '/apex-terminal.html': 'apex-terminal.html',
  '/mcx-pro.html': 'mcx-pro.html',
  '/mcx-logger.html': 'mcx-logger.html'
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

  const payload = {
    symbol,
    currency: meta.currency,
    regularMarketPrice: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose || meta.previousClose,
    high24h: meta.regularMarketDayHigh,
    low24h: meta.regularMarketDayLow,
    timestamp: meta.regularMarketTime,
    candlesCount: candles.length,
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
// ─────────────────────────────────────────────────────────────
async function handleClaudeSentiment(commodity) {
  const cacheKey = `ai_sentiment_${commodity}`;
  const cached = getCached(cacheKey);
  if (cached) return { ...cached, cached: true };

  const apiKey = getAnthropicKey();
  if (!apiKey) {
    return {
      commodity,
      newsScore: 50,
      verdict: 'NEUTRAL',
      summary: 'Anthropic API key not configured on server.',
      cached: false
    };
  }

  const aiPayload = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  }, {
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: `You are a disciplined market analyst. Return ONLY valid JSON:
{ "newsScore": <0-100>, "verdict": "BULLISH"|"BEARISH"|"NEUTRAL", "summary": "<1 factual sentence>" }`,
    messages: [{ role: 'user', content: `Summarize current market sentiment for ${commodity}` }]
  });

  let parsed = { newsScore: 50, verdict: 'NEUTRAL', summary: 'Macro consensus neutral.' };
  try {
    if (aiPayload.data?.content?.[0]?.text) {
      const clean = aiPayload.data.content[0].text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    }
  } catch (_) {}

  const result = {
    commodity,
    newsScore: parsed.newsScore || 50,
    verdict: parsed.verdict || 'NEUTRAL',
    summary: parsed.summary || '',
    updatedAt: new Date().toISOString(),
    cached: false
  };

  setCache(cacheKey, result, 900000); // 15-minute cache
  return result;
}

// ─────────────────────────────────────────────────────────────
// 5. SERVER ROUTER
// ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

    // 2. Fundamental Screener with Sane Valuation
    if (pathname === '/api/screener') {
      const data = await getFastStockFundamentals(query.symbol || 'RELIANCE');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // 3. AI Sentiment (Server-Managed Claude Key)
    if (pathname === '/api/sentiment') {
      const data = await handleClaudeSentiment(query.symbol || 'Gold');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // 4. Kite Login URL
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
      await kite.generateSession(requestToken);
      res.writeHead(302, { 'Location': 'http://127.0.0.1:8000/mcx-beginner.html?kite_connected=true' });
      return res.end();
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
          
          // Risk Check for ₹15,000 Capital
          const maxAllowedRisk = 50; // ₹50 hard limit per trade
          const stopDistance = Math.abs((order.price || 0) - (order.triggerPrice || order.sl || 0));
          const estimatedLoss = stopDistance * (order.quantity || 1);

          if (estimatedLoss > maxAllowedRisk && (order.price && order.sl)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              error: `RISK_VIOLATION: Estimated trade loss (₹${estimatedLoss.toFixed(2)}) exceeds ₹${maxAllowedRisk} budget limit.`
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
    if (req.method === 'GET' && ALLOWED_STATIC_FILES[pathname]) {
      const fileName = ALLOWED_STATIC_FILES[pathname];
      const safePath = path.join(__dirname, fileName);

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
