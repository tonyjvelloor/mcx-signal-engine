/**
 * scripts/archive_candles.js — Resilient Historical Candle Archiver & Corporate Actions Tracker
 * 
 * Purpose:
 * Accumulates real 5m exchange candles daily into SQLite (market_data.db) to build
 * a permanent, non-expiring multi-month historical dataset that Kite/Yahoo API lookback
 * limits prevent backfilling later.
 * 
 * Institutional Enhancements:
 * 1. Startup Catch-Up: On every server/archiver launch, detects any missing sessions
 *    from the last 60 days and automatically backfills them via idempotent INSERT OR REPLACE.
 * 2. Exchange Holiday Awareness: Cross-references shared/nse_holidays.js; quietly skips
 *    non-trading days without false alerts.
 * 3. Freshness Alert: If the latest candle date in DB lags the last completed trading day,
 *    emits prominent freshness alerts to prevent silent failure.
 * 4. Pinned Timezone: Strictly pinned to Asia/Kolkata (UTC+5:30) to eliminate host drift.
 * 5. Atomic Vacuum Backup: Automatically creates an atomic VACUUM INTO backup snapshot.
 * 
 * Usage:
 *   node scripts/archive_candles.js
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createBackup } = require('./backup_db');
const {
  getKolkataTime,
  isNseTradingDay,
  getHolidayReason,
  getLastCompletedTradingDay
} = require('../shared/nse_holidays');

const DB_PATH = path.join(__dirname, '..', 'market_data.db');
const STATUS_FILE = path.join(__dirname, '..', 'archive_status.json');

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

/**
 * Fetch raw upstream data from local proxy
 */
function fetchProxy(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`Proxy status ${res.statusCode}: ${data.substring(0, 100)}`));
          }
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Ingest corporate actions (splits, cash dividends) from 1-year daily history
 */
async function archiveCorporateActions(db, symbol, ticker) {
  try {
    const url = `http://127.0.0.1:8000/api/yahoo?ticker=${encodeURIComponent(ticker)}&interval=1d&range=1y&events=div%7Csplit`;
    const data = await fetchProxy(url);
    const result = data?.chart?.result?.[0];
    if (!result) return;

    const events = result.events || {};
    const splits = events.splits || {};
    const dividends = events.dividends || {};

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO corporate_actions (symbol, action_type, date, ratio, details)
      VALUES (?, ?, ?, ?, ?)
    `);

    // Ingest splits
    for (const [timestamp, split] of Object.entries(splits)) {
      const date = new Date(parseInt(timestamp, 10) * 1000 + (5.5 * 3600 * 1000)).toISOString().split('T')[0];
      const ratio = split.numerator && split.denominator ? (split.numerator / split.denominator) : 1;
      const details = `${split.numerator}:${split.denominator}`;
      insertStmt.run(symbol, 'SPLIT', date, ratio, details);
    }

    // Ingest dividends
    for (const [timestamp, div] of Object.entries(dividends)) {
      const date = new Date(parseInt(timestamp, 10) * 1000 + (5.5 * 3600 * 1000)).toISOString().split('T')[0];
      const amount = div.amount || 0;
      insertStmt.run(symbol, 'DIVIDEND', date, amount, `Amount: ₹${amount}`);
    }
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Fetch and upsert 5-minute candles for a single symbol
 */
async function archiveSymbol(db, symbol, ticker, interval = '5m', range = '60d') {
  console.log(`📡 Ingesting ${symbol} (${ticker}) [interval=${interval}, range=${range}]...`);

  // 1. Corporate Actions
  await archiveCorporateActions(db, symbol, ticker);

  // 2. 5-Minute Candles
  const url = `http://127.0.0.1:8000/api/yahoo?ticker=${encodeURIComponent(ticker)}&interval=${interval}&range=${range}`;
  const data = await fetchProxy(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data returned for ${ticker}`);

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjQuote = result.indicators?.adjclose?.[0]?.adjclose || [];
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const volumes = quote.volume || [];

  const minLen = Math.min(timestamps.length, closes.length, highs.length, lows.length);
  if (minLen === 0) throw new Error(`Empty candle array for ${ticker}`);

  const insertCandle = db.prepare(`
    INSERT OR REPLACE INTO candles (symbol, interval, time, open, high, low, close, volume, adj_close)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec('BEGIN TRANSACTION');
  let validCount = 0;

  for (let i = 0; i < minLen; i++) {
    const ts = timestamps[i] * 1000;
    const cl = closes[i];
    const hi = highs[i];
    const lo = lows[i];
    const op = opens[i] != null && isFinite(opens[i]) ? opens[i] : cl;
    const vl = volumes[i] != null && isFinite(volumes[i]) ? volumes[i] : 0;
    const adj = adjQuote[i] != null && isFinite(adjQuote[i]) ? adjQuote[i] : cl;

    if (cl != null && isFinite(cl) && hi != null && isFinite(hi) && lo != null && isFinite(lo) && cl > 0) {
      if (hi >= lo && hi >= Math.max(op, cl) * 0.999 && lo <= Math.min(op, cl) * 1.001) {
        insertCandle.run(
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

  const totalInDb = db.prepare(`SELECT COUNT(*) as count, MIN(time) as minTime, MAX(time) as maxTime FROM candles WHERE symbol = ? AND interval = ?`).get(symbol, interval);
  const minDate = new Date(totalInDb.minTime + (5.5 * 3600 * 1000)).toISOString().split('T')[0];
  const maxDate = new Date(totalInDb.maxTime + (5.5 * 3600 * 1000)).toISOString().split('T')[0];

  console.log(`   ✓ ${symbol.padEnd(10)}: Stored ${validCount} candles. Total in DB: ${totalInDb.count} bars (${minDate} to ${maxDate})`);
  return { symbol, validCount, total: totalInDb.count, minDate, maxDate };
}

/**
 * Audit database data freshness and detect any missing trading sessions
 */
function checkDataFreshness(db) {
  const lastCompletedDay = getLastCompletedTradingDay();
  const maxTimeRow = db.prepare(`SELECT MAX(time) as maxTime, COUNT(*) as totalCandles FROM candles WHERE interval = '5m'`).get();
  
  if (!maxTimeRow || !maxTimeRow.maxTime) {
    return {
      status: 'stale',
      message: 'Database is completely empty',
      latestDate: null,
      lastCompletedDay,
      totalCandles: 0,
      missingDays: [lastCompletedDay]
    };
  }

  const latestDate = new Date(maxTimeRow.maxTime + (5.5 * 3600 * 1000)).toISOString().split('T')[0];
  
  // Find all expected trading days in the last 60 calendar days up to lastCompletedDay
  const missingDays = [];
  const refDate = new Date();
  for (let d = 1; d <= 60; d++) {
    const checkDate = new Date(refDate.getTime() - d * 24 * 3600 * 1000);
    const checkKt = getKolkataTime(checkDate);
    if (checkKt.dateStr > lastCompletedDay) continue;

    if (isNseTradingDay(checkKt.dateStr)) {
      // Check if DB has bars for this trading day across universe
      const countRow = db.prepare(`
        SELECT COUNT(DISTINCT symbol) as symCount 
        FROM candles 
        WHERE interval = '5m' 
          AND date(time/1000, 'unixepoch', '+330 minutes') = ?
      `).get(checkKt.dateStr);

      if (!countRow || countRow.symCount < Object.keys(UNIVERSE).length) {
        missingDays.push(checkKt.dateStr);
      }
    }
  }

  const isStale = latestDate < lastCompletedDay || missingDays.length > 0;
  const status = isStale ? 'stale' : 'fresh';

  const statusPayload = {
    updatedAt: new Date().toISOString(),
    status,
    latestCandleDate: latestDate,
    lastCompletedTradingDay: lastCompletedDay,
    totalCandles5m: maxTimeRow.totalCandles,
    universeCount: Object.keys(UNIVERSE).length,
    missingSessions: missingDays.sort()
  };

  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(statusPayload, null, 2));
  } catch (_) {}

  return statusPayload;
}

/**
 * Startup catch-up: Automatically verifies and fills any missing historical sessions
 */
async function catchUpMissingSessions(db) {
  const freshness = checkDataFreshness(db);
  console.log(`🔍 [STARTUP ARCHIVE CHECK] Status: ${freshness.status.toUpperCase()} | Latest: ${freshness.latestCandleDate} | Last Completed Session: ${freshness.lastCompletedTradingDay}`);

  if (freshness.status === 'stale') {
    console.warn(`⚠️ [STARTUP CATCH-UP] Detected missing or lagging market data (missing sessions: ${freshness.missingSessions.join(', ') || freshness.lastCompletedTradingDay}). Ingesting catch-up candles now...`);
    await runArchiver(db);
  } else {
    console.log(`✅ [STARTUP ARCHIVE CHECK] Market archive is completely up-to-date through ${freshness.latestCandleDate}.`);
  }
}

async function runArchiver(existingDb = null) {
  const kt = getKolkataTime();
  console.log('================================================================================');
  console.log('       HISTORICAL CANDLE ARCHIVER & CORPORATE ACTIONS INGESTION');
  console.log('================================================================================');
  console.log(`IST Time: ${kt.dateStr} ${String(kt.hour).padStart(2, '0')}:${String(kt.minute).padStart(2, '0')}:${String(kt.second).padStart(2, '0')} (${kt.weekday})`);
  console.log(`Database: ${DB_PATH}\n`);

  // Check if today is a valid trading day
  const holiday = getHolidayReason(kt.dateStr);
  if (holiday) {
    console.log(`📅 [NSE EXCHANGE HOLIDAY] Market is closed today for ${holiday}. Archiver skipped cleanly.\n`);
    return { skipped: true, reason: holiday };
  }

  const db = existingDb || initDb();
  const summary = [];

  for (const [symbol, ticker] of Object.entries(UNIVERSE)) {
    try {
      const res = await archiveSymbol(db, symbol, ticker, '5m', '60d');
      summary.push(res);
      // Polite rate delay between symbols
      await new Promise(r => setTimeout(r, 1200));
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

  // Verify freshness and update archive_status.json
  const freshness = checkDataFreshness(db);
  if (freshness.status === 'stale') {
    console.warn(`🚨 [FRESHNESS ALERT] Database remains behind! Latest: ${freshness.latestCandleDate}, Target: ${freshness.lastCompletedTradingDay}`);
  } else {
    console.log(`🟢 [FRESHNESS OK] Database verified fresh up to ${freshness.latestCandleDate}.`);
  }

  // Automatically take an atomic VACUUM backup snapshot
  createBackup();

  return { success: true, grandTotal: grandTotal.count, freshness };
}

if (require.main === module) {
  runArchiver().catch(err => {
    console.error('Archiver fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  runArchiver,
  checkDataFreshness,
  catchUpMissingSessions,
  UNIVERSE
};
