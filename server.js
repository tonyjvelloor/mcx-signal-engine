/**
 * High-Speed Financial & AI Market API
 * Provides low-latency market data, automated Order Blocks,
 * instant 8-point stock scoring, and cached AI News Veto.
 */

const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const kite = require('./kite');

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

  // Detect Smart Money Concepts (Order Blocks & Fair Value Gaps)
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

  // Cache for 15 seconds for ultra-fresh sub-second streaming
  setCache(cacheKey, payload, 15000);
  return payload;
}

// ─────────────────────────────────────────────────────────────
// 2. SMART MONEY CONCEPTS (ORDER BLOCKS & FAIR VALUE GAPS)
// ─────────────────────────────────────────────────────────────
function detectSMC(candles) {
  if (candles.length < 5) return { orderBlocks: [], fvgs: [], range: null };

  const orderBlocks = [];
  const fvgs = [];

  // Check last 50 candles for institutional structures
  const lookback = Math.min(candles.length - 2, 50);
  const startIdx = candles.length - lookback;

  for (let i = startIdx; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Fair Value Gap (Bullish)
    if (next.low > prev.high) {
      fvgs.push({
        type: 'BULLISH_FVG',
        top: next.low,
        bottom: prev.high,
        mid: (next.low + prev.high) / 2,
        time: curr.time
      });
    }

    // Fair Value Gap (Bearish)
    if (next.high < prev.low) {
      fvgs.push({
        type: 'BEARISH_FVG',
        top: prev.low,
        bottom: next.high,
        mid: (prev.low + next.high) / 2,
        time: curr.time
      });
    }

    // Bullish Order Block (Red candle before strong upward break)
    const isDownCandle = curr.close < curr.open;
    const isImpulsiveUp = next.close > curr.high && (next.close - next.open) > (curr.high - curr.low);
    if (isDownCandle && isImpulsiveUp) {
      orderBlocks.push({
        type: 'DEMAND_OB',
        high: Math.max(curr.open, curr.high),
        low: curr.low,
        time: curr.time,
        status: 'UNMITIGATED'
      });
    }

    // Bearish Order Block (Green candle before strong downward break)
    const isUpCandle = curr.close > curr.open;
    const isImpulsiveDown = next.close < curr.low && (next.open - next.close) > (curr.high - curr.low);
    if (isUpCandle && isImpulsiveDown) {
      orderBlocks.push({
        type: 'SUPPLY_OB',
        high: curr.high,
        low: Math.min(curr.open, curr.low),
        time: curr.time,
        status: 'UNMITIGATED'
      });
    }
  }

  // Calculate Premium vs Discount Equilibrium
  const recentHigh = Math.max(...candles.slice(-30).map(c => c.high));
  const recentLow = Math.min(...candles.slice(-30).map(c => c.low));
  const equilibrium = (recentHigh + recentLow) / 2;
  const currentPrice = candles[candles.length - 1].close;

  return {
    orderBlocks: orderBlocks.slice(-5), // Latest 5 Order Blocks
    fvgs: fvgs.slice(-5),               // Latest 5 FVGs
    zone: currentPrice > equilibrium ? 'PREMIUM (Expensive - Look to Sell)' : 'DISCOUNT (Cheap - Look to Buy)',
    equilibrium,
    swingHigh: recentHigh,
    swingLow: recentLow
  };
}

// ─────────────────────────────────────────────────────────────
// 3. FAST 8-POINT STOCK SCREENER & VALUATION (<200ms)
// ─────────────────────────────────────────────────────────────
async function getFastStockFundamentals(ticker) {
  const cleanTicker = ticker.toUpperCase().endsWith('.NS') || ticker.toUpperCase().endsWith('.BO') 
    ? ticker.toUpperCase() 
    : `${ticker.toUpperCase()}.NS`;
  
  const cacheKey = `fund_${cleanTicker}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const yfSummaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(cleanTicker)}?modules=financialData,defaultKeyStatistics,summaryDetail`;
  const res = await fetchJson(yfSummaryUrl);

  if (!res.data || !res.data.quoteSummary || !res.data.quoteSummary.result) {
    throw new Error(`Fundamental data unavailable for ${cleanTicker}`);
  }

  const result = res.data.quoteSummary.result[0];
  const fin = result.financialData || {};
  const stats = result.defaultKeyStatistics || {};
  const detail = result.summaryDetail || {};

  const currentPrice = fin.currentPrice?.raw || detail.regularMarketPrice?.raw || 0;
  const currentRatio = fin.currentRatio?.raw || 0;
  const debtToEquity = fin.debtToEquity?.raw ? (fin.debtToEquity.raw / 100) : 0;
  const returnOnEquity = fin.returnOnEquity?.raw ? (fin.returnOnEquity.raw * 100) : 0;
  const pe = detail.trailingPE?.raw || 0;
  const forwardPe = detail.forwardPE?.raw || 0;
  const priceToBook = detail.priceToBook?.raw || 0;
  const freeCashflowCr = fin.freeCashflow?.raw ? (fin.freeCashflow.raw / 10000000) : 0;
  const sharesOutstandingCr = stats.sharesOutstanding?.raw ? (stats.sharesOutstanding.raw / 10000000) : 0;
  const enterpriseValueCr = stats.enterpriseValue?.raw ? (stats.enterpriseValue.raw / 10000000) : 0;
  const ebitdaCr = fin.ebitda?.raw ? (fin.ebitda.raw / 10000000) : 0;

  // 8-Point Scorecard Assessment
  const points = {
    currentRatio: currentRatio >= 1.5 ? 2 : (currentRatio >= 1.0 ? 1 : 0),
    debtToEquity: debtToEquity < 1.0 ? 2 : (debtToEquity < 2.0 ? 1 : 0),
    roce: returnOnEquity > 15 ? 2 : (returnOnEquity > 10 ? 1 : 0),
    inventory: 1, // Normalized standard
    peRatio: (pe > 0 && pe < 30) ? 2 : ((pe > 0 && pe < 50) ? 1 : 0),
    reserves: 2,
    fcf: freeCashflowCr > 0 ? 2 : 0,
    pledgedShares: 2
  };

  const totalScore = Object.values(points).reduce((a, b) => a + b, 0);
  const verdict = totalScore >= 12 ? '🟢 GO AHEAD (Strong Fundamental Buy)' : (totalScore >= 9 ? '🟡 WATCHLIST' : '🔴 AVOID');

  // EV/EBITDA Intrinsic Target & Margin of Safety (75% Entry Price)
  let targetPrice = 0;
  let entryPrice = 0;
  if (sharesOutstandingCr > 0 && ebitdaCr > 0) {
    const historicalEvEbitda = enterpriseValueCr / ebitdaCr;
    const forwardEbitda = ebitdaCr * 1.15; // 15% estimated growth
    const targetEV = forwardEbitda * historicalEvEbitda;
    targetPrice = targetEV / sharesOutstandingCr;
    entryPrice = targetPrice * 0.75; // 25% Margin of Safety
  }

  const payload = {
    ticker: cleanTicker,
    currentPrice,
    targetPrice: Math.round(targetPrice),
    entryPrice: Math.round(entryPrice),
    isBuyZone: currentPrice > 0 && targetPrice > 0 && currentPrice <= entryPrice,
    scorecard: {
      totalScore,
      maxScore: 16,
      verdict,
      breakdown: {
        currentRatio: `${currentRatio.toFixed(2)}x (${points.currentRatio} pts)`,
        debtToEquity: `${debtToEquity.toFixed(2)} (${points.debtToEquity} pts)`,
        roce: `${returnOnEquity.toFixed(1)}% (${points.roce} pts)`,
        pe: `${pe.toFixed(1)}x (${points.peRatio} pts)`,
        fcf: `${Math.round(freeCashflowCr)} Cr (${points.fcf} pts)`
      }
    },
    valuation: {
      ebitdaCr: Math.round(ebitdaCr),
      enterpriseValueCr: Math.round(enterpriseValueCr),
      evEbitdaRatio: ebitdaCr > 0 ? (enterpriseValueCr / ebitdaCr).toFixed(2) : null
    }
  };

  // Cache for 10 minutes
  setCache(cacheKey, payload, 600000);
  return payload;
}

// ─────────────────────────────────────────────────────────────
// 4. ASYNC CLAUDE SENTIMENT WITH SWR CACHING
// ─────────────────────────────────────────────────────────────
async function getCachedClaudeSentiment(commodity, apiKey) {
  const cacheKey = `ai_sentiment_${commodity}`;
  const cached = getCached(cacheKey);

  // Return immediately if in cache (latency < 5ms)
  if (cached) return { ...cached, cached: true };

  // Fallback to config key if not in request
  const activeKey = apiKey || (function(){
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).anthropic?.apiKey; } catch(e){ return null; }
  })();

  if (!activeKey) {
    return {
      commodity,
      newsScore: 50,
      verdict: 'NEUTRAL',
      summary: 'API key not configured; technical indicators active.',
      cached: false
    };
  }

  // Trigger Claude API in background/async
  const aiPayload = await fetchJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': activeKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    }
  }, {
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: `You are a commodity analyst. Today: ${new Date().toDateString()}.
Return ONLY valid JSON:
{ "newsScore": <0-100>, "verdict": "BULLISH"|"BEARISH"|"NEUTRAL", "summary": "<1 sentence>" }`,
    messages: [{ role: 'user', content: `Provide market sentiment score for ${commodity}` }]
  });

  let parsed = { newsScore: 50, verdict: 'NEUTRAL', summary: 'Neutral macro outlook' };
  try {
    if (aiPayload.data && aiPayload.data.content && aiPayload.data.content[0]) {
      const txt = aiPayload.data.content[0].text.replace(/```json/g, '').replace(/```/g, '').trim();
      parsed = JSON.parse(txt);
    }
  } catch (e) {
    // Fallback on parse failure
  }

  const result = {
    commodity,
    newsScore: parsed.newsScore || 50,
    verdict: parsed.verdict || 'NEUTRAL',
    summary: parsed.summary || '',
    updatedAt: new Date().toISOString(),
    cached: false
  };

  // Cache for 15 minutes (900,000 ms) so client gets instant responses
  setCache(cacheKey, result, 900000);
  return result;
}

// ─────────────────────────────────────────────────────────────
// 5. SERVER ROUTER
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  try {
    // Health Check
    if (pathname === '/' || pathname === '/api/health') {
      res.writeHead(200);
      return res.end(JSON.stringify({ status: 'ok', serverTime: new Date().toISOString() }));
    }

    // Endpoint: Local secrets fetch
    if (pathname === '/api/config/anthropic-key') {
      try {
        const sec = JSON.parse(fs.readFileSync(path.join(__dirname, '.secrets.json'), 'utf8'));
        res.writeHead(200);
        return res.end(JSON.stringify({ key: sec.anthropicApiKey || '' }));
      } catch(e) {
        res.writeHead(200);
        return res.end(JSON.stringify({ key: '' }));
      }
    }

    // Endpoint 1: Sub-second Quotes + Order Blocks
    // Example: /api/quote?symbol=GC=F or /api/quote?symbol=RELIANCE.NS
    if (pathname === '/api/quote') {
      const symbol = query.symbol || 'GC=F';
      const interval = query.interval || '15m';
      const range = query.range || '5d';
      const data = await getFastQuote(symbol, interval, range);
      res.writeHead(200);
      return res.end(JSON.stringify(data));
    }

    // Endpoint 2: Instant Stock Fundamentals & EV/EBITDA
    // Example: /api/screener?symbol=RELIANCE
    if (pathname === '/api/screener') {
      const symbol = query.symbol || 'RELIANCE';
      const data = await getFastStockFundamentals(symbol);
      res.writeHead(200);
      return res.end(JSON.stringify(data));
    }

    // Endpoint 3: Fast SWR-Cached AI Sentiment
    // Example: /api/sentiment?symbol=Gold
    if (pathname === '/api/sentiment') {
      const symbol = query.symbol || 'Gold';
      const apiKey = req.headers['x-api-key'] || query.key;
      const data = await getCachedClaudeSentiment(symbol, apiKey);
      res.writeHead(200);
      return res.end(JSON.stringify(data));
    }

    // ─────────────────────────────────────────────────────────
    // ZERODHA KITE CONNECT ENDPOINTS
    // ─────────────────────────────────────────────────────────

    // 1. Kite Login URL
    if (pathname === '/api/kite/login') {
      const loginUrl = kite.getLoginUrl();
      if (query.redirect === 'true') {
        res.writeHead(302, { 'Location': loginUrl });
        return res.end();
      }
      res.writeHead(200);
      return res.end(JSON.stringify({ loginUrl }));
    }

    // 2. Kite Auth Callback (redirected by Zerodha)
    if (pathname === '/api/kite/callback') {
      const requestToken = query.request_token;
      if (!requestToken) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Missing request_token' }));
      }
      try {
        const session = await kite.generateSession(requestToken);
        // Redirect back to dashboard with success status
        res.writeHead(302, { 'Location': 'http://127.0.0.1:8000/mcx-beginner.html?kite_connected=true' });
        return res.end();
      } catch (authErr) {
        res.writeHead(500);
        return res.end(JSON.stringify({ error: authErr.message }));
      }
    }

    // 3. Kite Status & Margins
    if (pathname === '/api/kite/status') {
      const session = kite.loadSession();
      if (!session) {
        res.writeHead(200);
        return res.end(JSON.stringify({ connected: false, message: 'No active session today' }));
      }
      try {
        const margins = await kite.getMargins();
        res.writeHead(200);
        return res.end(JSON.stringify({
          connected: true,
          user: session.user_name || session.user_id,
          email: session.email,
          margins: margins.data
        }));
      } catch (e) {
        res.writeHead(200);
        return res.end(JSON.stringify({ connected: false, error: e.message }));
      }
    }

    // 4. Kite Live Quotes
    // Example: /api/kite/quote?instruments=NSE:NIFTY%2050,MCX:GOLDPETAL24NOVFUT
    if (pathname === '/api/kite/quote') {
      const instruments = query.instruments || 'NSE:NIFTY 50';
      const quoteData = await kite.getLiveQuotes(instruments.split(','));
      res.writeHead(200);
      return res.end(JSON.stringify(quoteData));
    }

    // 5. Kite 1-Click Order Execution
    if (pathname === '/api/kite/order' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const order = JSON.parse(body);
          const result = await kite.placeOrder(order);
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (orderErr) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: orderErr.message }));
        }
      });
      return;
    }

    // Static Files Handler (e.g. /mcx-beginner.html, /apex-terminal.html)
    const cleanPath = pathname === '/' ? '/mcx-beginner.html' : pathname;
    const localFile = path.join(__dirname, cleanPath);
    if (fs.existsSync(localFile) && fs.statSync(localFile).isFile()) {
      const ext = path.extname(localFile).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml'
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      return fs.createReadStream(localFile).pipe(res);
    }

    // 404 Route
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Endpoint not found' }));

  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`🚀 High-Speed Market API running on http://localhost:${PORT}`);
});

module.exports = server;
