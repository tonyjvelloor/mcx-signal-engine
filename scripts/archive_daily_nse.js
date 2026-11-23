#!/usr/bin/env node
/**
 * scripts/archive_daily_nse.js — Official NSE Bhavcopy Multi-Year Daily OHLCV Archiver
 * Pulls 2.5+ years (10 × 3-month chunks) of official NSE daily Bhavcopy candles via
 * nse-bhavcopy MCP (`get_stock_history`), auto-adjusts splits/bonuses, and persists
 * into SQLite `daily_candles` in market_data.db.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const nseMcp = require('../shared/nse_mcp_client');
const { AUTO_PILOT_STOCKS } = require('../shared/auto_pilot');

const DB_PATH = path.join(__dirname, '..', 'market_data.db');

function ensureDailyCandlesTable(db) {
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

async function archiveDailyNseHistory({ db = null, chunks = 10, symbols = null } = {}) {
  const ownDb = !db;
  const database = db || new DatabaseSync(DB_PATH);
  ensureDailyCandlesTable(database);

  const targetSymbols = Array.isArray(symbols) && symbols.length > 0
    ? symbols
    : AUTO_PILOT_STOCKS.map(s => s.symbol);

  const upsert = database.prepare(`
    INSERT OR REPLACE INTO daily_candles (symbol, date, open, high, low, close, volume, turnover, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NSE_BHAVCOPY_MCP')
  `);

  const summary = [];
  for (const sym of targetSymbols) {
    const res = await nseMcp.getMultiYearDailyHistory(sym, chunks);
    if (res.bars.length > 0) {
      database.exec('BEGIN');
      try {
        for (const b of res.bars) {
          upsert.run(sym, b.date, b.open, b.high, b.low, b.close, b.volume, b.turnover);
        }
        database.exec('COMMIT');
      } catch (err) {
        database.exec('ROLLBACK');
        throw err;
      }
    }
    summary.push({
      symbol: sym,
      tradingDays: res.tradingDays,
      fromDate: res.fromDate,
      toDate: res.toDate,
      adjustments: res.adjustments
    });
  }

  if (ownDb) database.close();
  return summary;
}

if (require.main === module) {
  console.log('🏛️ Archiving Multi-Year Official NSE Bhavcopy Daily OHLCV into market_data.db...');
  archiveDailyNseHistory({ chunks: 10 })
    .then(rows => {
      let total = 0;
      for (const r of rows) {
        total += r.tradingDays;
        const adjNote = r.adjustments.length ? ` | Split/Bonus Adj: ${r.adjustments.map(a => `${a.date} (×${a.factor})`).join(', ')}` : '';
        console.log(`  ✔ ${r.symbol.padEnd(11)} ${String(r.tradingDays).padStart(4)} days (${r.fromDate} → ${r.toDate})${adjNote}`);
      }
      console.log(`✅ Archived ${total} official NSE daily candles across ${rows.length} Nifty-50 stocks.`);
    })
    .catch(err => {
      console.error('❌ Daily NSE archive failed:', err.message);
      process.exit(1);
    });
}

module.exports = { ensureDailyCandlesTable, archiveDailyNseHistory };
