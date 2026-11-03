/**
 * scripts/archive_candles.js — Daily Market Data Archiver & Corporate Actions Tracker
 * 
 * Purpose:
 * Accumulates real 5m exchange candles daily into SQLite (market_data.db) to build
 * a permanent, non-expiring multi-month historical dataset that Kite/Yahoo API lookback
 * limits prevent backfilling later.
 * 
 * Features:
 * - Upserts 5m candles with (symbol, interval, time) primary key.
 * - Captures adj_close from upstream quotes.
 * - Tracks corporate actions (splits, dividends) in `corporate_actions` table.
 * - Replaces any delisted/demerged tickers with liquid Nifty 50 large-caps.
 * - Reports date ranges, bar counts, and data gaps.
 * 
 * Usage:
 *   node scripts/archive_candles.js
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const http = require('http');
const { createBackup } = require('./backup_db');

const DB_PATH = path.join(__dirname, '..', 'market_data.db');

const UNIVERSE = {
  'RELIANCE': 'RELIANCE.NS',
  'TCS': 'TCS.NS',
  'INFY': 'INFY.NS',
  'HDFCBANK': 'HDFCBANK.NS',
  'ICICIBANK': 'ICICIBANK.NS',
  'BHARTIARTL': 'BHARTIARTL.NS',
  'SBIN': 'SBIN.NS',
  'ITC': 'ITC.NS',
  'LT': 'LT.NS',
  'KOTAKBANK': 'KOTAKBANK.NS',
  'AXISBANK': 'AXISBANK.NS',
  'MARUTI': 'MARUTI.NS'
};

function initDb() {
  const db = new DatabaseSync(DB_PATH);

  // 1. Ensure corporate_actions table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS corporate_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      action_type TEXT NOT NULL,
      date TEXT NOT NULL,
      ratio REAL,
      details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(symbol, action_type, date)
    );
  `);

  // 2. Ensure candles table has adj_close column
  try {
    const cols = db.prepare("PRAGMA table_info(candles)").all();
    const hasAdj = cols.some(c => c.name === 'adj_close');
    if (!hasAdj) {
      db.exec("ALTER TABLE candles ADD COLUMN adj_close REAL;");
    }
  } catch (err) {
    console.warn('DB pragma check warning:', err.message);
  }

  return db;
}

function fetchYahooChart(ticker, interval = '5m', range = '60d') {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:8000/api/yahoo?ticker=${encodeURIComponent(ticker)}&interval=${interval}&range=${range}&events=div%7Csplit`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`Upstream status ${res.statusCode}: ${data.substring(0, 100)}`));
          }
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function fetchCorporateActions(ticker) {
  return new Promise((resolve) => {
    const url = `http://127.0.0.1:8000/api/yahoo?ticker=${encodeURIComponent(ticker)}&interval=1d&range=1y&events=div%7Csplit`;
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json?.chart?.result?.[0]?.events || null);
        } catch (_) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

async function archiveSymbol(db, symbol, ticker, interval = '5m', range = '60d') {
  console.log(`📡 Ingesting ${symbol} (${ticker}) [${interval}, ${range}]...`);
  const data = await fetchYahooChart(ticker, interval, range);
  const result = data?.chart?.result?.[0];

  if (!result) {
    throw new Error(`No chart data returned for ${ticker}`);
  }

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjclose = result.indicators?.adjclose?.[0]?.adjclose || [];

  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const vols = quote.volume || [];

  const minLen = Math.min(timestamps.length, closes.length, highs.length, lows.length);
  if (minLen === 0) {
    throw new Error(`Empty candle array for ${ticker}`);
  }

  // 1. Fetch & Record Corporate Actions (from 1y daily events)
  try {
    const events = await fetchCorporateActions(ticker);
    if (events) {
      const actStmt = db.prepare(`
        INSERT OR IGNORE INTO corporate_actions (symbol, action_type, date, ratio, details)
        VALUES (?, ?, ?, ?, ?)
      `);

      if (events.splits) {
        for (const [epoch, s] of Object.entries(events.splits)) {
          const d = new Date(parseInt(epoch, 10) * 1000).toISOString().split('T')[0];
          actStmt.run(symbol, 'SPLIT', d, s.numerator / s.denominator, s.splitRatio || `${s.numerator}:${s.denominator}`);
          console.log(`   📌 [SPLIT] ${symbol} on ${d}: ${s.splitRatio}`);
        }
      }
      if (events.dividends) {
        for (const [epoch, div] of Object.entries(events.dividends)) {
          const d = new Date(parseInt(epoch, 10) * 1000).toISOString().split('T')[0];
          actStmt.run(symbol, 'DIVIDEND', d, div.amount, `Amount: ₹${div.amount}`);
        }
      }
    }
  } catch (err) {
    console.warn(`   ⚠️ Corporate actions fetch warning for ${symbol}:`, err.message);
  }

  // Insert or Replace Candles into DB
  const candleStmt = db.prepare(`
    INSERT OR REPLACE INTO candles (symbol, interval, time, open, high, low, close, volume, adj_close)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let validCount = 0;
  db.exec('BEGIN TRANSACTION');
  for (let i = 0; i < minLen; i++) {
    const ts = timestamps[i] * 1000;
    const cl = closes[i];
    const hi = highs[i];
    const lo = lows[i];
    const op = opens[i] != null && isFinite(opens[i]) ? opens[i] : cl;
    const vl = vols[i] != null && isFinite(vols[i]) ? vols[i] : 0;
    const adj = adjclose[i] != null && isFinite(adjclose[i]) ? adjclose[i] : cl;

    if (cl != null && isFinite(cl) && hi != null && isFinite(hi) && lo != null && isFinite(lo) && cl > 0) {
      // Basic integrity check
      if (hi >= lo && hi >= Math.max(op, cl) * 0.999 && lo <= Math.min(op, cl) * 1.001) {
        candleStmt.run(
          symbol,
          interval,
          ts,
          Math.round(op * 100) / 100,
          Math.round(hi * 100) / 100,
          Math.round(lo * 100) / 100,
          Math.round(cl * 100) / 100,
          vl,
          Math.round(adj * 100) / 100
        );
        validCount++;
      }
    }
  }
  db.exec('COMMIT');

  // Verify total stored in DB for this symbol
  const totalInDb = db.prepare(`SELECT COUNT(*) as count, MIN(time) as minTime, MAX(time) as maxTime FROM candles WHERE symbol = ? AND interval = ?`).get(symbol, interval);
  const minDate = new Date(totalInDb.minTime).toISOString().split('T')[0];
  const maxDate = new Date(totalInDb.maxTime).toISOString().split('T')[0];

  console.log(`   ✓ ${symbol.padEnd(10)}: Stored ${validCount} candles. Total in DB: ${totalInDb.count} bars (${minDate} to ${maxDate})`);
  return { symbol, validCount, total: totalInDb.count, minDate, maxDate };
}

async function runArchiver() {
  console.log('================================================================================');
  console.log('       HISTORICAL CANDLE ARCHIVER & CORPORATE ACTIONS INGESTION');
  console.log('================================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Database:  ${DB_PATH}\n`);

  const db = initDb();
  const summary = [];

  for (const [symbol, ticker] of Object.entries(UNIVERSE)) {
    try {
      const res = await archiveSymbol(db, symbol, ticker, '5m', '60d');
      summary.push(res);
      // Polite rate delay between symbols to avoid Yahoo 429
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`   ✗ Error archiving ${symbol}: ${err.message}`);
    }
  }

  console.log('\n================================================================================');
  console.log('                        ARCHIVE SUMMARY REPORT');
  console.log('================================================================================');
  console.table(summary);

  const grandTotal = db.prepare(`SELECT COUNT(*) as count FROM candles WHERE interval = '5m'`).get();
  console.log(`Total 5-minute candles stored across all symbols: ${grandTotal.count}`);
  console.log('✅ Archive run complete.\n');

  // Automatically take a rotating backup snapshot after every archive run
  createBackup();
}

if (require.main === module) {
  runArchiver().catch(err => {
    console.error('Archiver fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  runArchiver,
  UNIVERSE
};
