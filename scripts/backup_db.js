/**
 * scripts/backup_db.js — Institutional SQLite Database Backup & Multi-Tier Retention
 * 
 * Safety Mechanisms:
 * 1. Online Atomic Snapshot: Uses SQLite's native `VACUUM INTO` via node:sqlite.
 *    Guarantees zero corrupt reads even if the database is actively being written to.
 * 2. Multi-Tier Retention:
 *    - Rolling Daily: Retains the latest 7 daily snapshots in backups/daily/.
 *    - Tiered Weekly: Saves 1 snapshot per ISO week in backups/weekly/ (retaining 12 weeks)
 *      to protect against silent data corruption that would otherwise overwrite all 7 rolling daily backups.
 * 3. Off-Machine Secondary Mirror: If SECONDARY_BACKUP_DIR environment variable is defined
 *    and points to a mounted external disk or cloud drive, mirrors the snapshot there.
 * 
 * Usage:
 *   node scripts/backup_db.js
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { getKolkataTime } = require('../shared/nse_holidays');

const DB_PATH = path.join(__dirname, '..', 'market_data.db');
const BACKUP_ROOT = path.join(__dirname, '..', 'backups');
const DAILY_DIR = path.join(BACKUP_ROOT, 'daily');
const WEEKLY_DIR = path.join(BACKUP_ROOT, 'weekly');

const MAX_DAILY_BACKUPS = 7;
const MAX_WEEKLY_BACKUPS = 12;

function getIsoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function createBackup() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ [BACKUP ERROR] Database not found at ${DB_PATH}. Backup aborted.`);
    return null;
  }

  // Ensure directories exist
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  fs.mkdirSync(WEEKLY_DIR, { recursive: true });

  const kt = getKolkataTime();
  const timestamp = `${kt.year}${kt.month}${kt.day}_${String(kt.hour).padStart(2, '0')}${String(kt.minute).padStart(2, '0')}${String(kt.second).padStart(2, '0')}`;
  const dailyFilename = `market_data_daily_${timestamp}.db`;
  const dailyPath = path.join(DAILY_DIR, dailyFilename);

  // 1. Perform Atomic SQLite VACUUM INTO
  try {
    if (fs.existsSync(dailyPath)) {
      fs.unlinkSync(dailyPath);
    }

    const db = new DatabaseSync(DB_PATH);
    // VACUUM INTO requires single-quoted path with escaped single quotes
    const escapedPath = dailyPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedPath}'`);
    db.close();

    const stat = fs.statSync(dailyPath);
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
    console.log(`📦 [BACKUP] Atomic VACUUM snapshot created: ${dailyFilename} (${sizeMb} MB)`);
  } catch (err) {
    console.error(`❌ [BACKUP FAILED] VACUUM INTO failed: ${err.message}`);
    return null;
  }

  // 2. Weekly Snapshot Archival (Protecting against silent daily corruption)
  try {
    const currentWeek = getIsoWeek();
    const weeklyFilename = `market_data_weekly_${currentWeek}.db`;
    const weeklyPath = path.join(WEEKLY_DIR, weeklyFilename);

    if (!fs.existsSync(weeklyPath)) {
      fs.copyFileSync(dailyPath, weeklyPath);
      console.log(`📅 [BACKUP] Archived new weekly snapshot: ${weeklyFilename}`);
    }
  } catch (err) {
    console.warn('⚠️ [BACKUP] Weekly archive warning:', err.message);
  }

  // 3. Rotate Rolling Daily Backups (Keep latest MAX_DAILY_BACKUPS)
  try {
    const dailyFiles = fs.readdirSync(DAILY_DIR)
      .filter(f => f.startsWith('market_data_daily_') && f.endsWith('.db'))
      .map(f => ({ name: f, path: path.join(DAILY_DIR, f), time: fs.statSync(path.join(DAILY_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    if (dailyFiles.length > MAX_DAILY_BACKUPS) {
      for (let i = MAX_DAILY_BACKUPS; i < dailyFiles.length; i++) {
        fs.unlinkSync(dailyFiles[i].path);
        console.log(`🗑️ [BACKUP] Rotated old daily snapshot: ${dailyFiles[i].name}`);
      }
    }
  } catch (err) {
    console.warn('⚠️ [BACKUP] Daily rotation warning:', err.message);
  }

  // 4. Rotate Weekly Backups (Keep latest MAX_WEEKLY_BACKUPS)
  try {
    const weeklyFiles = fs.readdirSync(WEEKLY_DIR)
      .filter(f => f.startsWith('market_data_weekly_') && f.endsWith('.db'))
      .map(f => ({ name: f, path: path.join(WEEKLY_DIR, f), time: fs.statSync(path.join(WEEKLY_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    if (weeklyFiles.length > MAX_WEEKLY_BACKUPS) {
      for (let i = MAX_WEEKLY_BACKUPS; i < weeklyFiles.length; i++) {
        fs.unlinkSync(weeklyFiles[i].path);
        console.log(`🗑️ [BACKUP] Rotated old weekly snapshot: ${weeklyFiles[i].name}`);
      }
    }
  } catch (err) {
    console.warn('⚠️ [BACKUP] Weekly rotation warning:', err.message);
  }

  // 5. Off-Machine Secondary Mirror (e.g. secondary disk, NAS, or cloud sync directory)
  const secondaryDir = process.env.SECONDARY_BACKUP_DIR;
  if (secondaryDir && fs.existsSync(secondaryDir)) {
    try {
      const secondaryDest = path.join(secondaryDir, dailyFilename);
      fs.copyFileSync(dailyPath, secondaryDest);
      console.log(`☁️ [BACKUP] Secondary off-machine backup mirrored to: ${secondaryDest}`);
    } catch (err) {
      console.warn(`⚠️ [BACKUP] Secondary mirror write failed: ${err.message}`);
    }
  }

  return dailyPath;
}

if (require.main === module) {
  createBackup();
}

module.exports = { createBackup };
