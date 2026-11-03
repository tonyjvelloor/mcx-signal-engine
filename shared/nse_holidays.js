/**
 * shared/nse_holidays.js — Official NSE Equity Trading Calendar & Timezone Utilities
 * 
 * Pinned strictly to Asia/Kolkata (Indian Standard Time, UTC+5:30) to eliminate
 * host machine timezone drift.
 */

// Official NSE Equity Trading Holidays for 2026 (Excluding regular Saturday/Sunday)
const NSE_HOLIDAYS_2026 = {
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Mahashivratri',
  '2026-03-25': 'Holi',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-27': 'Bakri Id / Eid-ul-Adha',
  '2026-07-17': 'Muharram',
  '2026-09-14': 'Milad-un-Nabi / Id-e-Milad',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali Balipratipada',
  '2026-11-24': 'Guru Nanak Jayanti',
  '2026-12-25': 'Christmas'
};

// Special / truncated trading sessions (e.g. Diwali Muhurat Trading)
const SPECIAL_SESSIONS_2026 = {
  '2026-11-08': {
    name: 'Diwali Laxmi Pujan (Muhurat Trading)',
    openTime: '18:15',
    closeTime: '19:15',
    expectedBars5m: 12
  }
};

/**
 * Returns current timestamp breakdown strictly in Asia/Kolkata timezone
 */
function getKolkataTime(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short'
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const second = parseInt(parts.second, 10);
  const dayOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    dateStr,
    hour,
    minute,
    second,
    dayOfWeek,
    weekday: parts.weekday,
    isWeekend
  };
}

/**
 * Checks whether a given calendar date (YYYY-MM-DD) is an active NSE trading day
 */
function isNseTradingDay(dateStr) {
  if (SPECIAL_SESSIONS_2026[dateStr]) return true;

  // Check day of week
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcDate = new Date(Date.UTC(y, m - 1, d, 6, 0, 0)); // ~11:30 IST
  const dow = utcDate.getUTCDay();
  if (dow === 0 || dow === 6) return false; // Weekend

  // Check holiday
  if (NSE_HOLIDAYS_2026[dateStr]) return false;

  return true;
}

/**
 * Returns the holiday name if dateStr is a holiday, otherwise null
 */
function getHolidayReason(dateStr) {
  return NSE_HOLIDAYS_2026[dateStr] || null;
}

/**
 * Returns special session info if dateStr is a special session, otherwise null
 */
function getSpecialSessionInfo(dateStr) {
  return SPECIAL_SESSIONS_2026[dateStr] || null;
}

/**
 * Returns the YYYY-MM-DD of the most recent completed NSE trading session.
 * Regular NSE trading session is complete after 15:30 IST.
 */
function getLastCompletedTradingDay(refDate = new Date()) {
  const kt = getKolkataTime(refDate);
  let cur = new Date(refDate.getTime());

  // If today is a trading day but market has NOT yet closed (before 15:30 IST), step back to yesterday
  if (isNseTradingDay(kt.dateStr) && (kt.hour < 15 || (kt.hour === 15 && kt.minute < 30))) {
    cur = new Date(cur.getTime() - 24 * 3600 * 1000);
  }

  // Walk backwards day-by-day until we find a valid trading day
  for (let i = 0; i < 30; i++) {
    const curKt = getKolkataTime(cur);
    if (isNseTradingDay(curKt.dateStr)) {
      return curKt.dateStr;
    }
    cur = new Date(cur.getTime() - 24 * 3600 * 1000);
  }

  return kt.dateStr;
}

module.exports = {
  NSE_HOLIDAYS_2026,
  SPECIAL_SESSIONS_2026,
  getKolkataTime,
  isNseTradingDay,
  getHolidayReason,
  getSpecialSessionInfo,
  getLastCompletedTradingDay
};
