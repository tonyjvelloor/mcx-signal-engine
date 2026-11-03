/**
 * scripts/backup_db.js — Automated SQLite Database Backup & Rotation
 * 
 * Creates a timestamped atomic copy of market_data.db into backups/
 * and retains the last 7 daily backup snapshots.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'market_data.db');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const MAX_BACKUPS = 7;

function createBackup() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}. Backup aborted.`);
    return null;
  }

  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  const now = new Date();
  const dateStr = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupFilename = `market_data_${dateStr}.db`;
  const backupPath = path.join(BACKUP_DIR, backupFilename);

  fs.copyFileSync(DB_PATH, backupPath);
  const stat = fs.statSync(backupPath);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  console.log(`📦 Backup successfully created: ${backupFilename} (${sizeMb} MB)`);

  // Rotate old backups (Keep latest MAX_BACKUPS)
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('market_data_') && f.endsWith('.db'))
      .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time);

    if (files.length > MAX_BACKUPS) {
      for (let i = MAX_BACKUPS; i < files.length; i++) {
        const toDelete = path.join(BACKUP_DIR, files[i].name);
        fs.unlinkSync(toDelete);
        console.log(`🗑️ Rotated old backup: ${files[i].name}`);
      }
    }
  } catch (err) {
    console.warn('Backup rotation warning:', err.message);
  }

  return backupPath;
}

if (require.main === module) {
  createBackup();
}

module.exports = { createBackup };
