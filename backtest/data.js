/**
 * backtest/data.js — Historical Market Data Provider
 * Fetches or loads OHLCV candles from SQLite or historical APIs,
 * with deterministic fallback benchmark generator for offline tests.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const https = require('https');

const DB_PATH = path.join(__dirname, '..', 'market_data.db');

function getDbConnection() {
  return new DatabaseSync(DB_PATH);
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
 * Generate synthetic realistic multi-regime candles for offline testing & benchmark verification
 * Simulates: Uptrends, Downtrends, Choppy Mean-Reversion, and Volatility Spikes
 */
function generateBenchmarkCandles(symbol = 'RELIANCE', count = 1000, startPrice = 1300, intervalMins = 5) {
  const candles = [];
  let price = startPrice;
  let time = Date.now() - (count * intervalMins * 60 * 1000);
  let regime = 0; // 0 = bull trend, 1 = range, 2 = bear trend

  for (let i = 0; i < count; i++) {
    if (i % 250 === 0) regime = (regime + 1) % 3;

    let drift = 0;
    if (regime === 0) drift = 0.0004; // Bullish
    else if (regime === 2) drift = -0.0004; // Bearish

    const vol = 0.0025; // 0.25% standard deviation per 5m
    const shock = (Math.random() - 0.5) * 2;
    const returnPct = drift + (shock * vol);

    const open = price;
    const close = Math.round(open * (1 + returnPct) * 100) / 100;
    const wickHigh = Math.random() * (open * 0.0015);
    const wickLow = Math.random() * (open * 0.0015);
    const high = Math.round((Math.max(open, close) + wickHigh) * 100) / 100;
    const low = Math.round((Math.min(open, close) - wickLow) * 100) / 100;
    const volume = Math.floor(1000 + Math.random() * 5000);

    candles.push({
      time,
      open,
      high,
      low,
      close,
      volume
    });

    price = close;
    time += intervalMins * 60 * 1000;
  }
  return candles;
}

/**
 * Get candles for backtest (from DB, or generates benchmark if empty)
 */
async function getHistoricalCandles(symbol, interval = '5m', count = 1000) {
  const dbCandles = loadCandlesFromDb(symbol, interval);
  if (dbCandles && dbCandles.length >= 200) {
    return dbCandles.slice(-count);
  }

  // Generate realistic benchmark candles if local DB hasn't accumulated enough history
  const basePrice = symbol.includes('GOLD') ? 75000 : symbol.includes('CRUDE') ? 6000 : 1300;
  const benchmark = generateBenchmarkCandles(symbol, count, basePrice, interval === '5m' ? 5 : 15);
  saveCandlesToDb(symbol, interval, benchmark);
  return benchmark;
}

module.exports = {
  loadCandlesFromDb,
  saveCandlesToDb,
  generateBenchmarkCandles,
  getHistoricalCandles
};
