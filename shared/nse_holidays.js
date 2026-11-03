/**
 * shared/nse_holidays.js — Official NSE Equity Trading Calendar & Timezone Utilities
 * 
 * Sources:
 * - NSE Circular No. NSE/CMTR/71775 (Ref 172/2025, Dec 12, 2025): Calendar Year 2026 Trading Holidays
 * - NSE Circular No. NSE/CMTR/76941 (Ref 149/2026, Oct 19, 2026): Diwali Muhurat Trading for Samvat 2083
 * 
 * Pinned strictly to Asia/Kolkata (Indian Standard Time, UTC+5:30).
 */

// Official NSE Equity Trading Holidays for 2026 (15 Weekday Holidays as per Circular NSE/CMTR/71775)
const NSE_HOLIDAYS_2026 = {
  '2026-01-26': 'Republic Day',
  '2026-03-03': 'Holi',
  '2026-03-26': 'Shri Ram Navami',
  '2026-03-31': 'Shri Mahavir Jayanti',
  '2026-04-03': 'Good Friday',
  '2026-04-14': 'Dr. Baba Saheb Ambedkar Jayanti',
  '2026-05-01': 'Maharashtra Day',
  '2026-05-28': 'Bakri Id',
  '2026-06-26': 'Muharram',
  '2026-09-14': 'Ganesh Chaturthi',
  '2026-10-02': 'Mahatma Gandhi Jayanti',
  '2026-10-20': 'Dussehra',
  '2026-11-10': 'Diwali-Balipratipada',
  '2026-11-24': 'Prakash Gurpurb Sri Guru Nanak Dev',
  '2026-12-25': 'Christmas'
};

// Official Weekend Festival Days (Falling on Saturday/Sunday per Circular NSE/CMTR/71775)
const NSE_WEEKEND_FESTIVALS_2026 = {
  '2026-02-15': 'Mahashivratri (Sunday)',
  '2026-03-21': 'Id-Ul-Fitr (Saturday)',
  '2026-08-15': 'Independence Day (Saturday)',
  '2026-11-08': 'Diwali Laxmi Pujan (Sunday)'
};

// Special / Truncated trading sessions (e.g. Diwali Muhurat Trading per Circular NSE/CMTR/76941)
const SPECIAL_SESSIONS_2026 = {
  '2026-11-08': {
    name: 'Diwali Laxmi Pujan (Muhurat Trading Samvat 2083)',
    circular: 'NSE/CMTR/76941',
    dayOfWeek: 'Sunday',
    preOpenTime: '14:05',
    openTime: '14:20',
    closeTime: '15:30',
    expectedBars5m: 14,
    excludeFromQuantitativeEvaluation: true // Exclude from calibration & holdout
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
 * Checks whether a given calendar date (YYYY-MM-DD) is an active NSE trading day.
 * Accounts for regular weekdays, official holidays, and special weekend sessions (e.g. Muhurat).
 */
function isNseTradingDay(dateStr) {
  // If it is explicitly scheduled as a special session, it is an active trading day (even on weekends)
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
 * Returns the holiday description if dateStr is an official weekday trading holiday
 */
function getHolidayReason(dateStr) {
  return NSE_HOLIDAYS_2026[dateStr] || null;
}

/**
 * Returns special session info if dateStr is a special trading session
 */
function getSpecialSessionInfo(dateStr) {
  return SPECIAL_SESSIONS_2026[dateStr] || null;
}

/**
 * Checks whether a session should be excluded from backtesting & holdout evaluation.
 * Special sessions (e.g. 1-hour Muhurat trading) have truncated duration, unusual liquidity,
 * and distorted VWAP/ATR that contaminate quantitative model testing.
 */
function isExcludedSpecialSession(dateStr) {
  const info = SPECIAL_SESSIONS_2026[dateStr];
  return Boolean(info && info.excludeFromQuantitativeEvaluation);
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
  NSE_WEEKEND_FESTIVALS_2026,
  SPECIAL_SESSIONS_2026,
  getKolkataTime,
  isNseTradingDay,
  getHolidayReason,
  getSpecialSessionInfo,
  isExcludedSpecialSession,
  getLastCompletedTradingDay
};
