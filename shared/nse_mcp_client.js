/**
 * shared/nse_mcp_client.js — Native Streamable-HTTP Client for Official NSE India MCP Servers
 *
 * Bridges our MCX & NSE ₹15,000 Auto-Paper Pilot directly to NSE India's official
 * Model Context Protocol (MCP) endpoints:
 *   1. cm-market (`https://mcp.nseindia.in/cmmkt/mcp`):
 *      - `cm_get_stock_quote`: Live NSE equity quotes (LTP, Open, High, Low, PrevClose, %Chg, Volume, Turnover ₹Cr, 52W High/Low)
 *      - `cm_get_live_indices`: Live NIFTY 50, NIFTY BANK, INDIA VIX & ~140 sectoral/thematic indices
 *      - `nse_get_market_movers`: Official live NIFTY Top Gainers & Top Losers with turnover
 *   2. nse-bhavcopy (`https://mcp.nseindia.in/bhavcopy/cm/mcp`):
 *      - `get_market_mood` & `get_market_breadth`: Official Advance/Decline ratio, VIX regime & index breadth
 *      - `get_volume_analysis`: 20-day institutional volume spike (>2x avg) & accumulation detector
 */

const https = require('https');

const NSE_MCP_ENDPOINTS = {
  cm: 'https://mcp.nseindia.in/cmmkt/mcp',
  bhavcopy: 'https://mcp.nseindia.in/bhavcopy/cm/mcp'
};

// Session & Response Caches
const sessionIds = { cm: null, bhavcopy: null };
const cache = new Map();

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCached(key, value, ttlMs = 20000) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/**
 * Low-level HTTP POST helper supporting Streamable HTTP MCP (`application/json, text/event-stream`).
 */
function postMcpRpc(endpointUrl, payload, sessionId = null, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(endpointUrl);
    const bodyStr = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(bodyStr),
      'User-Agent': 'MCX-NSE-AutoPilot/2.0'
    };
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId;
    }

    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
      timeout: timeoutMs
    }, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        const newSid = res.headers['mcp-session-id'] || sessionId;
        try {
          let jsonObj = null;
          for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
              jsonObj = JSON.parse(trimmed.slice(5).trim());
              break;
            }
          }
          if (!jsonObj) {
            jsonObj = JSON.parse(raw);
          }
          resolve({ status: res.statusCode, sessionId: newSid, data: jsonObj });
        } catch (err) {
          reject(new Error(`NSE MCP parse error (${res.statusCode}): ${raw.slice(0, 120)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`NSE MCP timeout (${endpointUrl})`));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function ensureSession(serverKey = 'cm') {
  if (sessionIds[serverKey]) return sessionIds[serverKey];
  const url = NSE_MCP_ENDPOINTS[serverKey];
  if (!url) throw new Error(`Unknown NSE MCP server key: ${serverKey}`);

  const initPayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mcx-signal-engine', version: '2.0.0' }
    }
  };
  const res = await postMcpRpc(url, initPayload, null, 4500);
  if (res.sessionId) {
    sessionIds[serverKey] = res.sessionId;
  }
  return sessionIds[serverKey];
}

/**
 * Invokes an MCP tool on `cm` or `bhavcopy` and parses the JSON payload inside `result.content[0].text`.
 */
async function callNseMcpTool(serverKey, toolName, args = {}, timeoutMs = 4500) {
  const url = NSE_MCP_ENDPOINTS[serverKey];
  if (!url) throw new Error(`Unknown NSE MCP server: ${serverKey}`);

  let sid = await ensureSession(serverKey).catch(() => null);
  const rpcPayload = {
    jsonrpc: '2.0',
    id: Date.now() % 100000,
    method: 'tools/call',
    params: { name: toolName, arguments: args }
  };

  let res;
  try {
    res = await postMcpRpc(url, rpcPayload, sid, timeoutMs);
    if (res.status === 400 || res.status === 404 || res.data?.error) {
      // Session may have expired; re-initialize once
      sessionIds[serverKey] = null;
      sid = await ensureSession(serverKey);
      res = await postMcpRpc(url, rpcPayload, sid, timeoutMs);
    }
  } catch (err) {
    sessionIds[serverKey] = null;
    throw err;
  }

  const textBlock = res.data?.result?.content?.[0]?.text;
  if (typeof textBlock === 'string') {
    try {
      return JSON.parse(textBlock);
    } catch (_) {
      return { rawText: textBlock };
    }
  }
  return res.data?.result || null;
}

/**
 * Fetches official live quote for a single NSE symbol via `cm_get_stock_quote` (with 1 automatic retry).
 */
async function getLiveStockQuote(symbol) {
  const sym = String(symbol || '').toUpperCase().replace('.NS', '').replace('NSE:', '').trim();
  if (!sym) return null;
  const cacheKey = `quote_${sym}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callNseMcpTool('cm', 'cm_get_stock_quote', { symbol: sym }, 4500);
      const st = raw?.stock;
      if (st && Number.isFinite(Number(st.lastTradedPrice)) && Number(st.lastTradedPrice) > 0) {
        const normalized = {
          symbol: sym,
          ltp: Number(st.lastTradedPrice),
          open: Number(st.openPrice || st.lastTradedPrice),
          high: Number(st.highPrice || st.lastTradedPrice),
          low: Number(st.lowPrice || st.lastTradedPrice),
          prevClose: Number(st.preClosePrice || st.lastTradedPrice),
          change: Number(st.change || 0),
          perChange: Number(st.perChange || 0),
          volume: Number(st.volume || 0),
          turnoverCr: Math.round(Number(st.value || 0) * 100) / 100,
          high52w: Number(st.fiftyTwoWeekHigh || 0),
          low52w: Number(st.fiftyTwoWeekLow || 0),
          perChange30d: Number(st.perChange30d || 0),
          timestamp: st.latestTimestamp || raw.updatedAt || new Date().toISOString(),
          source: 'NSE_MCP_LIVE'
        };
        return setCached(cacheKey, normalized, 15000);
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Fetches official live NSE quotes for an array of symbols in controlled chunks of 4 to avoid SSE multiplexing drops.
 */
async function getBatchStockQuotes(symbols = []) {
  const unique = [...new Set(symbols.map(s => String(s || '').toUpperCase().replace('.NS', '').replace('NSE:', '').trim()).filter(Boolean))];
  const out = {};
  const chunkSize = 4;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const slice = unique.slice(i, i + chunkSize);
    await Promise.all(slice.map(async (sym) => {
      const q = await getLiveStockQuote(sym);
      if (q) out[sym] = q;
    }));
  }
  return out;
}

/**
 * Fetches official live NSE Market Overview:
 * - NIFTY 50, NIFTY BANK, INDIA VIX & Sectoral Indices (`cm_get_live_indices`)
 * - Top NIFTY Gainers & Losers (`nse_get_market_movers`)
 * - Official NSE Market Mood & Advance/Decline Breadth (`get_market_mood`)
 */
async function getLiveMarketOverview(force = false) {
  const cacheKey = 'nse_mcp_market_overview';
  if (!force) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const [indicesRaw, moversRaw, moodRaw] = await Promise.all([
    callNseMcpTool('cm', 'cm_get_live_indices', { group: 'all', nameFilter: '' }, 4500).catch(() => null),
    callNseMcpTool('cm', 'nse_get_market_movers', { indexName: 'NIFTY', limit: 10 }, 4500).catch(() => null),
    callNseMcpTool('bhavcopy', 'get_market_mood', {}, 4500).catch(() => null)
  ]);

  const flatIndices = [];
  if (indicesRaw && indicesRaw.indices && typeof indicesRaw.indices === 'object') {
    for (const grp of Object.values(indicesRaw.indices)) {
      if (Array.isArray(grp)) flatIndices.push(...grp);
    }
  }

  const findIdx = (name) => flatIndices.find(i => String(i.indexName || '').toUpperCase() === name.toUpperCase()) || null;
  const nifty50 = findIdx('NIFTY 50');
  const niftyBank = findIdx('NIFTY BANK');
  const indiaVix = findIdx('INDIA VIX');

  const sectorMap = {};
  for (const idx of flatIndices) {
    const nm = String(idx.indexName || '').toUpperCase();
    if (nm.startsWith('NIFTY ')) {
      sectorMap[nm] = {
        last: Number(idx.last || 0),
        percChange: Number(idx.percChange || 0),
        change: Number(idx.change || 0)
      };
    }
  }

  const topGainers = Array.isArray(moversRaw?.gainers)
    ? moversRaw.gainers.slice(0, 10).map(g => ({
        symbol: String(g.symbol || '').toUpperCase(),
        ltp: Number(g.ltp || 0),
        prevClose: Number(g.prev_price || 0),
        perChange: Number(g.perChange || 0),
        turnover: g.turnover || null
      }))
    : [];

  const topLosers = Array.isArray(moversRaw?.losers)
    ? moversRaw.losers.slice(0, 10).map(l => ({
        symbol: String(l.symbol || '').toUpperCase(),
        ltp: Number(l.ltp || 0),
        prevClose: Number(l.prev_price || 0),
        perChange: Number(l.perChange || 0),
        turnover: l.turnover || null
      }))
    : [];

  const stockBreadth = moodRaw?.stock_breadth || null;
  const indexBreadth = moodRaw?.index_breadth || null;

  const overview = {
    ok: Boolean(nifty50 || topGainers.length > 0 || moodRaw),
    nseTimestamp: indicesRaw?.nseTimestamp || moversRaw?.gainersUpdatedAt || new Date().toISOString(),
    nifty50: nifty50 ? {
      last: Number(nifty50.last),
      change: Number(nifty50.change),
      percChange: Number(nifty50.percChange),
      high: Number(nifty50.high),
      low: Number(nifty50.low)
    } : null,
    niftyBank: niftyBank ? {
      last: Number(niftyBank.last),
      change: Number(niftyBank.change),
      percChange: Number(niftyBank.percChange),
      high: Number(niftyBank.high),
      low: Number(niftyBank.low)
    } : null,
    indiaVix: indiaVix ? {
      last: Number(indiaVix.last),
      change: Number(indiaVix.change),
      percChange: Number(indiaVix.percChange)
    } : (moodRaw?.india_vix ? {
      last: Number(moodRaw.india_vix.close || moodRaw.india_vix.value || 0),
      percChange: Number(moodRaw.india_vix.change_1d_pct || 0)
    } : null),
    sectorMap,
    topGainers,
    topLosers,
    breadth: {
      advances: stockBreadth?.up ?? null,
      declines: stockBreadth?.down ?? null,
      advPct: stockBreadth?.up_pct ?? null,
      reading: stockBreadth?.reading || indexBreadth?.reading || 'NEUTRAL'
    }
  };

  if (overview.ok) {
    setCached(cacheKey, overview, 25000);
  }
  return overview;
}

/**
 * Computes an institutional NSE MCP Factor Adjustment for a given stock & proposed side.
 * Uses:
 * 1. Official NSE Intraday Relative Strength vs NIFTY 50 & Sector Index (`NIFTY BANK`, `NIFTY IT`, `NIFTY AUTO`, etc.)
 * 2. Official NSE Top Gainer / Top Loser institutional turnover leadership
 * 3. Official NSE Market Breadth & India VIX regime
 */
function computeNseMcpStockEdge({ symbol, sector = '', liveQuote = null, marketOverview = null }) {
  const sym = String(symbol || '').toUpperCase();
  if (!liveQuote && !marketOverview) {
    return { available: false, scoreDelta: 0, bias: 'NEUTRAL', notes: [] };
  }

  let scoreDelta = 0; // Positive favors BUY, Negative favors SELL
  const notes = [];

  const stockPct = Number(liveQuote?.perChange ?? 0);
  const niftyPct = Number(marketOverview?.nifty50?.percChange ?? 0);
  const relStrength = +(stockPct - niftyPct).toFixed(2);

  // 1. Sector Index Alignment from live NSE indices
  const secUpper = String(sector || '').toUpperCase();
  let secIdxName = 'NIFTY 50';
  if (secUpper.includes('PSU')) secIdxName = 'NIFTY PSU BANK';
  else if (secUpper.includes('BANK')) secIdxName = 'NIFTY BANK';
  else if (secUpper.includes('IT')) secIdxName = 'NIFTY IT';
  else if (secUpper.includes('AUTO')) secIdxName = 'NIFTY AUTO';
  else if (secUpper.includes('FMCG')) secIdxName = 'NIFTY FMCG';
  else if (secUpper.includes('METAL')) secIdxName = 'NIFTY METAL';
  else if (secUpper.includes('ENERGY') || secUpper.includes('OIL')) secIdxName = 'NIFTY OIL & GAS';

  const secObj = marketOverview?.sectorMap?.[secIdxName] || marketOverview?.sectorMap?.['NIFTY BANK'];
  const secPct = secObj ? Number(secObj.percChange || 0) : niftyPct;

  if (secPct <= -1.0) {
    scoreDelta -= 8;
    notes.push(`${secIdxName} weak (${secPct.toFixed(2)}%)`);
  } else if (secPct >= 1.0) {
    scoreDelta += 8;
    notes.push(`${secIdxName} strong (+${secPct.toFixed(2)}%)`);
  }

  // 2. Stock Intraday Momentum & Relative Strength vs NIFTY 50
  if (liveQuote) {
    if (stockPct >= 1.5 && relStrength >= 1.0) {
      scoreDelta += 10;
      notes.push(`NSE Live +${stockPct.toFixed(2)}% (RS +${relStrength}% vs Nifty)`);
    } else if (stockPct <= -1.2 && relStrength <= -0.5) {
      scoreDelta -= 10;
      notes.push(`NSE Live ${stockPct.toFixed(2)}% (RS ${relStrength}% vs Nifty)`);
    } else {
      notes.push(`NSE LTP ₹${liveQuote.ltp} (${stockPct >= 0 ? '+' : ''}${stockPct.toFixed(2)}%)`);
    }
  }

  // 3. Official NSE Top Gainer / Top Loser Leadership
  const isTopGainer = marketOverview?.topGainers?.some(g => g.symbol === sym);
  const isTopLoser = marketOverview?.topLosers?.some(l => l.symbol === sym);
  if (isTopGainer) {
    scoreDelta += 9;
    notes.push('Official NSE Top Nifty Gainer');
  } else if (isTopLoser) {
    scoreDelta -= 9;
    notes.push('Official NSE Top Nifty Loser');
  }

  // 4. NSE Market Breadth Alignment
  const advPct = Number(marketOverview?.breadth?.advPct ?? 50);
  if (advPct < 40) {
    scoreDelta -= 4;
  } else if (advPct > 60) {
    scoreDelta += 4;
  }

  const bias = scoreDelta >= 8 ? 'BULLISH_NSE_FLOW' : (scoreDelta <= -8 ? 'BEARISH_NSE_FLOW' : 'NEUTRAL');
  return {
    available: true,
    scoreDelta,
    bias,
    stockPct,
    niftyPct,
    sectorIndex: secIdxName,
    sectorPct: secPct,
    relStrength,
    isTopGainer: Boolean(isTopGainer),
    isTopLoser: Boolean(isTopLoser),
    turnoverCr: liveQuote?.turnoverCr || null,
    summary: notes.join(' · ') || 'NSE MCP Live synced'
  };
}

/**
 * Corporate Action Shield (`get_corporate_actions` via official `nse-bhavcopy` MCP).
 * Blocks stocks within ±3 days of an ex-dividend, split, or bonus date so unadjusted
 * gap-downs never trigger false signals or overnight stop-outs.
 */
async function getCorporateActionShield(symbol, refDate = new Date()) {
  const sym = String(symbol || '').toUpperCase().replace('.NS', '').trim();
  if (!sym) return { blocked: false, upcomingEvent: null };
  const cacheKey = `corp_act_${sym}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const fromD = new Date(refDate.getTime() - 5 * 86400000).toISOString().slice(0, 10);
    const toD = new Date(refDate.getTime() + 10 * 86400000).toISOString().slice(0, 10);
    const raw = await callNseMcpTool('bhavcopy', 'get_corporate_actions', { symbol: sym, fromDate: fromD, toDate: toD }, 4000);
    const events = Array.isArray(raw?.events) ? raw.events : (Array.isArray(raw?.corporate_actions) ? raw.corporate_actions : (Array.isArray(raw) ? raw : []));
    const nowMs = refDate.getTime();
    let blocked = false;
    let upcomingEvent = null;
    for (const ev of events) {
      const exDateStr = ev.ex_date || ev.exDate || ev.date;
      if (!exDateStr) continue;
      const exMs = new Date(exDateStr).getTime();
      if (!isNaN(exMs) && Math.abs(exMs - nowMs) <= 3 * 86400000) {
        blocked = true;
        upcomingEvent = {
          exDate: exDateStr,
          purpose: ev.purpose || ev.subject || ev.action_type || 'Corporate Action'
        };
        break;
      }
    }
    return setCached(cacheKey, { blocked, upcomingEvent }, 30 * 60 * 1000);
  } catch (_) {
    return { blocked: false, upcomingEvent: null };
  }
}

/**
 * Multi-Day CNC Swing Profile (`nse-bhavcopy` MCP: 20-DMA, 50-DMA, 52W High/Low, 20d Volume Analysis).
 * Powers Bucket 1 (₹10,000 CNC Swing — ₹0 Zerodha delivery brokerage) by verifying multi-day institutional
 * uptrend + volume expansion + proximity to 52W highs.
 */
async function getSwingDailyProfile(symbol, liveLtp = 0) {
  const sym = String(symbol || '').toUpperCase().replace('.NS', '').trim();
  if (!sym) return { ok: false };
  const cacheKey = `swing_prof_${sym}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const [ma20Raw, ma50Raw, volRaw, hl52Raw, corpShield] = await Promise.all([
      callNseMcpTool('bhavcopy', 'moving_average', { symbol: sym, days: 20 }, 4000).catch(() => null),
      callNseMcpTool('bhavcopy', 'moving_average', { symbol: sym, days: 50 }, 4000).catch(() => null),
      callNseMcpTool('bhavcopy', 'get_volume_analysis', { symbol: sym, days: 20 }, 4000).catch(() => null),
      callNseMcpTool('bhavcopy', 'get_52_week_high_low', { symbol: sym }, 4000).catch(() => null),
      getCorporateActionShield(sym)
    ]);

    const sma20 = Number(ma20Raw?.sma || ma20Raw?.moving_average || ma20Raw?.value || 0);
    const sma50 = Number(ma50Raw?.sma || ma50Raw?.moving_average || ma50Raw?.value || 0);
    const high52w = Number(hl52Raw?.high_52w || hl52Raw?.fifty_two_week_high || hl52Raw?.high || 0);
    const refPx = Number(liveLtp || ma20Raw?.latest_close || hl52Raw?.current_price || 0);
    const distFrom52wHighPct = (high52w > 0 && refPx > 0) ? +(((high52w - refPx) / high52w) * 100).toFixed(2) : null;
    const avgVol20 = Number(volRaw?.average_volume || volRaw?.avg_volume || 0);
    const spikeDays = Number(volRaw?.volume_spike_days?.length ?? volRaw?.spike_days ?? 0);

    const aboveSma20 = sma20 > 0 && refPx > sma20;
    const aboveSma50 = sma50 > 0 && refPx > sma50;
    const bullishAlignment = aboveSma20 && (sma50 <= 0 || sma20 >= sma50 * 0.99);
    const near52wHigh = distFrom52wHighPct != null && distFrom52wHighPct <= 14;

    let swingScore = 50;
    if (aboveSma20) swingScore += 15;
    if (aboveSma50) swingScore += 12;
    if (near52wHigh) swingScore += 12;
    if (spikeDays >= 1) swingScore += 8;
    if (corpShield.blocked) swingScore = 0;

    const profile = {
      ok: Boolean(sma20 > 0 || sma50 > 0 || high52w > 0),
      symbol: sym,
      sma20: sma20 || null,
      sma50: sma50 || null,
      high52w: high52w || null,
      distFrom52wHighPct,
      avgVol20: avgVol20 || null,
      spikeDays,
      aboveSma20,
      aboveSma50,
      bullishAlignment,
      near52wHigh,
      corporateActionBlocked: corpShield.blocked,
      corporateActionEvent: corpShield.upcomingEvent,
      swingScore: Math.min(98, Math.max(0, swingScore)),
      qualifiesForCncSwing: !corpShield.blocked && bullishAlignment && swingScore >= 72
    };
    return setCached(cacheKey, profile, 30 * 60 * 1000);
  } catch (_) {
    return { ok: false, symbol: sym, corporateActionBlocked: false, qualifiesForCncSwing: false, swingScore: 50 };
  }
}

/**
 * Fetches multi-year official NSE Bhavcopy daily OHLCV history by chaining 3-month chunks
 * via `get_stock_history` (`next_end_date`) and automatically back-adjusts corporate-action
 * split/bonus price discontinuities (>22% single-day drop with split/bonus ratio) so
 * multi-year backtests have zero false split crashes.
 */
async function getMultiYearDailyHistory(symbol, chunks = 10) {
  const sym = String(symbol || '').toUpperCase().replace('.NS', '').trim();
  if (!sym) return { symbol: sym, bars: [], adjustments: [] };

  const byDate = new Map();
  let endDate = 'today';

  for (let i = 0; i < chunks; i++) {
    try {
      const res = await callNseMcpTool('bhavcopy', 'get_stock_history', {
        symbol: sym,
        months: 3,
        endDate
      }, 6000);
      const rows = Array.isArray(res?.data) ? res.data : [];
      if (rows.length === 0) break;
      for (const r of rows) {
        if (!r || !r.date || !(Number(r.close) > 0)) continue;
        byDate.set(r.date, {
          symbol: sym,
          date: r.date,
          open: Number(r.open || r.close),
          high: Number(r.high || r.close),
          low: Number(r.low || r.close),
          close: Number(r.close),
          prevClose: Number(r.prevClose || 0),
          volume: Number(r.volume || 0),
          turnover: Number(r.totalTradedValue || 0)
        });
      }
      if (!res.next_end_date || res.next_end_date === endDate) break;
      endDate = res.next_end_date;
    } catch (_) {
      break;
    }
  }

  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const adjustments = [];

  // Auto back-adjust raw unadjusted Bhavcopy splits/bonuses (e.g. 1:1 bonus = -50%, 1:2 split = -50%, 1:5 split = -80%)
  // Walk backwards so multiple corporate actions compound accurately onto earlier bars.
  for (let i = bars.length - 1; i >= 1; i--) {
    const cur = bars[i];
    const prev = bars[i - 1];
    if (prev.close > 0 && cur.open > 0) {
      const dropRatio = cur.open / prev.close;
      // Only treat as split/bonus if overnight drop exceeds 24% AND matches a clean split/bonus adjustment
      // (NSE Bhavcopy also resets prevClose on ex-date to the adjusted close, so cur.prevClose << prev.close!)
      const bhavAdjustedPrev = cur.prevClose > 0 && (cur.prevClose / prev.close) < 0.78;
      if (bhavAdjustedPrev || dropRatio < 0.65) {
        const factor = bhavAdjustedPrev ? (cur.prevClose / prev.close) : dropRatio;
        if (factor > 0.05 && factor < 0.85) {
          adjustments.push({
            date: cur.date,
            factor: +factor.toFixed(4),
            prevCloseBefore: prev.close,
            openAfter: cur.open
          });
          for (let j = 0; j < i; j++) {
            bars[j].open = +(bars[j].open * factor).toFixed(2);
            bars[j].high = +(bars[j].high * factor).toFixed(2);
            bars[j].low = +(bars[j].low * factor).toFixed(2);
            bars[j].close = +(bars[j].close * factor).toFixed(2);
            bars[j].volume = Math.round(bars[j].volume / factor);
          }
        }
      }
    }
  }

  return {
    symbol: sym,
    tradingDays: bars.length,
    fromDate: bars[0]?.date || null,
    toDate: bars[bars.length - 1]?.date || null,
    adjustments,
    bars
  };
}

module.exports = {
  NSE_MCP_ENDPOINTS,
  callNseMcpTool,
  getLiveStockQuote,
  getBatchStockQuotes,
  getLiveMarketOverview,
  computeNseMcpStockEdge,
  getCorporateActionShield,
  getSwingDailyProfile,
  getMultiYearDailyHistory
};
