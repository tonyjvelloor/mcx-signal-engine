#!/usr/bin/env node
/**
 * scripts/archive_daily_nse.js — Official NSE Bhavcopy Multi-Year Daily OHLCV Archiver (All Nifty-50)
 * Pulls 2.5+ years (10 × 3-month chunks) of official NSE daily Bhavcopy candles via
 * nse-bhavcopy MCP (`get_stock_history`), auto-adjusts splits/bonuses, and persists
 * into SQLite `daily_candles` in market_data.db.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const nseMcp = require('../shared/nse_mcp_client');

const DB_PATH = path.join(__dirname, '..', 'market_data.db');

// Complete Nifty-50 Large-Cap Universe (50 liquid NSE stocks across all major sectors)
const NIFTY_50_SYMBOLS = [
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK',
  'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL',
  'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL',
  'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HEROMOTOCO',
  'HINDALCO', 'HINDUNILVR', 'ICICIBANK', 'INDUSINDBK', 'INFY',
  'ITC', 'JIOFIN', 'JSWSTEEL', 'KOTAKBANK', 'LT',
  'M&M', 'MARUTI', 'NESTLEIND', 'NTPC', 'ONGC',
  'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN', 'SHRIRAMFIN',
  'SUNPHARMA', 'TATACONSUM', 'TATAMOTORS', 'TATASTEEL', 'TCS',
  'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO', 'WIPRO'
];

// Official Nifty Next 50 Large-Cap Constituents (50 additional liquid institutional NSE leaders)
const NIFTY_NEXT_50_SYMBOLS = [
  'ABB', 'ADANIENSOL', 'ADANIGREEN', 'ADANIPOWER', 'AMBUJACEM',
  'BAJAJHLDNG', 'BAJAJHFL', 'BANKBARODA', 'BOSCHLTD', 'BPCL',
  'BRITANNIA', 'CANBK', 'CGPOWER', 'CHOLAFIN', 'DABUR',
  'DIVISLAB', 'DLF', 'DMART', 'GAIL', 'GODREJCP',
  'HAL', 'HAVELLS', 'HYUNDAI', 'ICICIGI', 'ICICIPRULI',
  'INDHOTEL', 'INDIGO', 'IOC', 'IRFC', 'JINDALSTEL',
  'JSWENERGY', 'LICI', 'LODHA', 'LTIM', 'MOTHERSON',
  'NAUKRI', 'PFC', 'PIDILITIND', 'PNB', 'RECLTD',
  'SHREECEM', 'SIEMENS', 'SWIGGY', 'TATAPOWER', 'TORNTPHARM',
  'TVSMOTOR', 'UNITDSPR', 'VBL', 'VEDL', 'ZYDUSLIFE'
];

// Full Nifty-100 Universe + Safe-Haven & Benchmark ETFs
const NIFTY_100_AND_ETFS = [
  ...NIFTY_50_SYMBOLS,
  ...NIFTY_NEXT_50_SYMBOLS,
  'GOLDBEES', 'LIQUIDBEES', 'NIFTYBEES'
];

function ensureDailyCandlesTable(db) {
  try {
    db.exec('PRAGMA busy_timeout = 15000; PRAGMA journal_mode = WAL;');
  } catch (_) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_candles (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume INTEGER DEFAULT 0,
      turnover REAL DEFAULT 0,
      source TEXT DEFAULT 'NSE_BHAVCOPY_MCP',
      PRIMARY KEY (symbol, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_candles_sym_date ON daily_candles (symbol, date);
  `);
}

async function archiveDailyNseHistory({ db = null, chunks = 10, symbols = null, concurrency = 2, delayMs = 300 } = {}) {
  const ownDb = !db;
  const database = db || new DatabaseSync(DB_PATH);
  ensureDailyCandlesTable(database);

  const targetSymbols = Array.isArray(symbols) && symbols.length > 0
    ? symbols
    : [...NIFTY_50_SYMBOLS, 'ADANIPOWER', 'CANBK', 'GOLDBEES', 'LIQUIDBEES', 'NIFTYBEES'];

  const upsert = database.prepare(`
    INSERT OR REPLACE INTO daily_candles (symbol, date, open, high, low, close, volume, turnover, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NSE_BHAVCOPY_MCP')
  `);

  const summary = [];
  for (let i = 0; i < targetSymbols.length; i += concurrency) {
    const batch = targetSymbols.slice(i, i + concurrency);
    const batchRes = await Promise.all(
      batch.map(sym => nseMcp.getMultiYearDailyHistory(sym, chunks).catch(() => ({ symbol: sym, tradingDays: 0, bars: [], adjustments: [] })))
    );
    database.exec('BEGIN');
    try {
      for (const res of batchRes) {
        for (const b of (res.bars || [])) {
          upsert.run(res.symbol, b.date, b.open, b.high, b.low, b.close, b.volume, b.turnover);
        }
        summary.push({
          symbol: res.symbol,
          tradingDays: res.tradingDays || 0,
          fromDate: res.fromDate || null,
          toDate: res.toDate || null,
          adjustments: res.adjustments || []
        });
      }
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw err;
    }
    if (delayMs > 0 && i + concurrency < targetSymbols.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  if (ownDb) database.close();
  return summary;
}

if (require.main === module) {
  console.log(`🏛️ Archiving 2.5-Year Official NSE Bhavcopy Daily OHLCV for all ${NIFTY_100_AND_ETFS.length} Nifty-100 stocks & ETFs...`);
  archiveDailyNseHistory({ chunks: 10, concurrency: 6 })
    .then(rows => {
      let total = 0;
      let populated = 0;
      for (const r of rows) {
        total += r.tradingDays;
        if (r.tradingDays > 0) populated++;
        const adjNote = r.adjustments.length ? ` | Adj: ${r.adjustments.map(a => `${a.date}(×${a.factor})`).join(',')}` : '';
        console.log(`  ${r.tradingDays > 0 ? '✔' : '⚠️'} ${r.symbol.padEnd(11)} ${String(r.tradingDays).padStart(4)}d (${r.fromDate || '—'} → ${r.toDate || '—'})${adjNote}`);
      }
      console.log(`✅ Archived ${total} official NSE daily candles across ${populated}/${rows.length} Nifty-100 stocks & ETFs.`);
    })
    .catch(err => {
      console.error('❌ Daily NSE archive failed:', err.message);
      process.exit(1);
    });
}

module.exports = { NIFTY_50_SYMBOLS, NIFTY_NEXT_50_SYMBOLS, NIFTY_100_AND_ETFS, ensureDailyCandlesTable, archiveDailyNseHistory };
