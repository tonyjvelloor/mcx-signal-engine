/**
 * backtest/audit_logger.js — Cryptographically Hash-Chained Holdout Evaluation Audit Log
 * 
 * Provides tamper-evident logging of all holdout evaluation attempts:
 * - Each entry stores its own SHA-256 hash and links back to the previous entry's hash.
 * - Test invocations (--test / --dry-run) are clearly segregated as TEST_DRY_RUN.
 * - Production holdout evaluations are permanently recorded with git commit context.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_FILE = path.join(__dirname, '..', 'docs', 'holdout_evaluation_audit.log');
const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

function getLastHash() {
  if (!fs.existsSync(LOG_FILE)) return GENESIS_HASH;
  const content = fs.readFileSync(LOG_FILE, 'utf8').trim();
  if (!content) return GENESIS_HASH;

  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (!lines.length) return GENESIS_HASH;

  const lastLine = lines[lines.length - 1];
  const match = lastLine.match(/Hash:([a-f0-9]{64})/i);
  return match ? match[1] : GENESIS_HASH;
}

function logHoldoutAttempt(details = {}, isDryRun = false) {
  const prevHash = getLastHash();
  const timestamp = new Date().toISOString();
  const typeTag = isDryRun ? 'TEST_DRY_RUN' : 'PROD_EVALUATION';

  const payload = {
    timestamp,
    type: typeTag,
    details
  };

  const currentHash = crypto
    .createHash('sha256')
    .update(prevHash + timestamp + JSON.stringify(payload))
    .digest('hex');

  const logLine = `[${timestamp}] [${typeTag}] Hash:${currentHash} PrevHash:${prevHash} Data:${JSON.stringify(payload)}\n`;

  fs.appendFileSync(LOG_FILE, logLine, 'utf8');
  return { currentHash, prevHash, timestamp, typeTag };
}

module.exports = {
  LOG_FILE,
  GENESIS_HASH,
  getLastHash,
  logHoldoutAttempt
};
