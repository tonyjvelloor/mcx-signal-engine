/**
 * h2/export_candles.js — Export CALIBRATION-ONLY candles for the H2 (TimesFM) experiment.
 *
 * Uses getHistoricalCandles(), which enforces the 2026-11-02 holdout freeze and excludes
 * special sessions. This script deliberately refuses to run with --final.
 *
 * Output: h2/data/candles_calibration.json  (+ SHA-256 printed for the run report)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getHistoricalCandles } = require('../backtest/data');

const UNIVERSE = ['RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK','BHARTIARTL','SBIN','ITC','LT','KOTAKBANK','AXISBANK','MARUTI'];

(async () => {
  if (process.argv.includes('--final') || process.env.EVALUATE_HOLDOUT === 'true') {
    console.error('H2 export refuses --final / EVALUATE_HOLDOUT: calibration data only.');
    process.exit(1);
  }
  const out = {};
  for (const sym of UNIVERSE) {
    const res = await getHistoricalCandles(sym, '5m', 100000);
    if (!/LOCAL_SQLITE_ARCHIVE/.test(res.source)) {
      console.error(`Refusing non-archive source for ${sym}: ${res.source}`);
      process.exit(1);
    }
    out[sym] = res.candles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]);
    console.log(`  ${sym.padEnd(10)} ${res.candles.length} bars  ${res.startDate} -> ${res.endDate}`);
  }
  const dir = path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'candles_calibration.json');
  const body = JSON.stringify(out);
  fs.writeFileSync(file, body);
  console.log(`\nWrote ${file}\nSHA-256: ${crypto.createHash('sha256').update(body).digest('hex')}`);
})();
