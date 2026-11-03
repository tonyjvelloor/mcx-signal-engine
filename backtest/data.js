/**
 * backtest/data.js — Historical Market Data Provider
 * Fetches real market history from local proxy (Yahoo/NSE) into SQLite,
 * with explicit provenance tracking (Source, Date Range, Bar Count).
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const http = require('http');

const DB_PATH = path.join(__dirname, '..', 'market_data.db');

function getDbConnection() {
  return new DatabaseSync(DB_PATH);
}

const SYMBOL_MAP = {
  'RELIANCE': 'RELIANCE.NS',
  'TCS': 'TCS.NS',
  'INFY': 'INFY.NS',
  'HDFCBANK': 'HDFCBANK.NS',
  'TATAMOTORS': 'TATAMOTORS.NS',
  'GOLD': 'GC=F',
  'SILVER': 'SI=F',
  'CRUDE': 'CL=F',
  'NATGAS': 'NG=F',
  'COPPER': 'HG=F'
};

/**
 * Fetch real historical candles via local server proxy
 */
function fetchUpstreamCandles(ticker, interval = '5m', range = '1mo') {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:8000/api/yahoo?ticker=${encodeURIComponent(ticker)}&interval=${interval}&range=${range}`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`Upstream returned ${res.statusCode}: ${data.substring(0, 100)}`));
          }
          const parsed = JSON.parse(data);
          const chartResult = parsed?.chart?.result?.[0];
          if (!chartResult) return reject(new Error('No chart result in upstream response'));

          const q = chartResult.indicators?.quote?.[0] || {};
          const timestamps = chartResult.timestamp || [];
          const opens = q.open || [];
          const highs = q.high || [];
          const lows = q.low || [];
          const closes = q.close || [];
          const vols = q.volume || [];

          const validRows = [];
          const minLen = Math.min(timestamps.length, closes.length, highs.length, lows.length);

          for (let i = 0; i < minLen; i++) {
            const ts = timestamps[i] * 1000; // to ms
            const cl = closes[i];
            const hi = highs[i];
            const lo = lows[i];
            const op = opens[i] != null && isFinite(opens[i]) ? opens[i] : cl;
            const vl = vols[i] != null && isFinite(vols[i]) ? vols[i] : 0;

            if (cl != null && isFinite(cl) && hi != null && isFinite(hi) && lo != null && isFinite(lo) && cl > 0) {
              if (hi >= lo && hi >= Math.max(op, cl) * 0.999 && lo <= Math.min(op, cl) * 1.001) {
                validRows.push({
                  time: ts,
                  open: Math.round(op * 100) / 100,
                  high: Math.round(hi * 100) / 100,
                  low: Math.round(lo * 100) / 100,
                  close: Math.round(cl * 100) / 100,
                  volume: vl
                });
              }
            }
          }

          resolve(validRows);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Load candles from SQLite table 'candles'
 */
function loadCandlesFromDb(symbol, interval = '5m') {
  try {
    const db = getDbConnection();
    const rows = db.prepare(`
      SELECT time, open, high, low, close, volume 
      FROM candles 
      WHERE symbol = ? AND interval = ? 
      ORDER BY time ASC
    `).all(symbol, interval);
    return rows;
  } catch (err) {
    return [];
  }
}

/**
 * Save candles into SQLite table 'candles'
 */
function saveCandlesToDb(symbol, interval, candles) {
  try {
    const db = getDbConnection();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO candles (symbol, interval, time, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN TRANSACTION');
    for (const c of candles) {
      stmt.run(symbol, interval, c.time, c.open, c.high, c.low, c.close, c.volume || 0);
    }
    db.exec('COMMIT');
  } catch (err) {
    console.warn('saveCandlesToDb warning:', err.message);
  }
}

/**
 * Synthetic fallback benchmark generator (ONLY used if upstream network is completely offline)
 */
function generateBenchmarkCandles(symbol = 'RELIANCE', count = 1000, startPrice = 1300, intervalMins = 5) {
  const candles = [];
  let price = startPrice;
  let time = Date.now() - (count * intervalMins * 60 * 1000);
  let regime = 0;

  for (let i = 0; i < count; i++) {
    if (i % 250 === 0) regime = (regime + 1) % 3;

    let drift = 0;
    if (regime === 0) drift = 0.0002;
    else if (regime === 2) drift = -0.0002;

    const vol = 0.0020;
    const shock = (Math.random() - 0.5) * 2;
    const returnPct = drift + (shock * vol);

    const open = price;
    const close = Math.round(open * (1 + returnPct) * 100) / 100;
    const wickHigh = Math.random() * (open * 0.001);
    const wickLow = Math.random() * (open * 0.001);
    const high = Math.round((Math.max(open, close) + wickHigh) * 100) / 100;
    const low = Math.round((Math.min(open, close) - wickLow) * 100) / 100;
    const volume = Math.floor(1000 + Math.random() * 5000);

    candles.push({ time, open, high, low, close, volume });
    price = close;
    time += intervalMins * 60 * 1000;
  }
  return candles;
}

/**
 * Get historical candles with honest source attribution
 */
async function getHistoricalCandles(rawSymbol, interval = '5m', count = 1500) {
  const symbol = rawSymbol.toUpperCase().replace('.NS', '');
  const ticker = SYMBOL_MAP[symbol] || rawSymbol;

  // 1. Try Loading from Local SQLite Database first
  let candles = loadCandlesFromDb(symbol, interval);
  if (candles && candles.length >= 300) {
    return {
      candles: candles.slice(-count),
      source: 'LOCAL_SQLITE_CACHE',
      ticker,
      startDate: new Date(candles[0].time).toISOString().split('T')[0],
      endDate: new Date(candles[candles.length - 1].time).toISOString().split('T')[0]
    };
  }

  // 2. Fetch Real Candles from Upstream Proxy
  try {
    const upstreamCandles = await fetchUpstreamCandles(ticker, interval, '1mo');
    if (upstreamCandles && upstreamCandles.length >= 200) {
      saveCandlesToDb(symbol, interval, upstreamCandles);
      return {
        candles: upstreamCandles.slice(-count),
        source: ticker.includes('.NS') ? 'REAL_NSE_EXCHANGE' : 'REAL_COMMODITY_FUTURES',
        ticker,
        startDate: new Date(upstreamCandles[0].time).toISOString().split('T')[0],
        endDate: new Date(upstreamCandles[upstreamCandles.length - 1].time).toISOString().split('T')[0]
      };
    }
  } catch (err) {
    console.warn(`Upstream fetch failed for ${ticker}: ${err.message}. Using synthetic benchmark for test.`);
  }

  // 3. Fallback to Benchmark Generator only if network fails
  const basePrice = symbol.includes('GOLD') ? 75000 : symbol.includes('CRUDE') ? 6000 : 1300;
  const benchmark = generateBenchmarkCandles(symbol, count, basePrice, interval === '5m' ? 5 : 15);
  return {
    candles: benchmark,
    source: 'SYNTHETIC_BENCHMARK_GENERATOR (UNREALISTIC - UNIT TEST ONLY)',
    ticker,
    startDate: new Date(benchmark[0].time).toISOString().split('T')[0],
    endDate: new Date(benchmark[benchmark.length - 1].time).toISOString().split('T')[0]
  };
}

module.exports = {
  loadCandlesFromDb,
  saveCandlesToDb,
  getHistoricalCandles,
  fetchUpstreamCandles
};
