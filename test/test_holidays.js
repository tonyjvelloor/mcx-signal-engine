/**
 * test/test_holidays.js — Automated Holiday Calendar & Special Session Integrity Test
 * 
 * Asserts conformity with:
 * - NSE Circular No. NSE/CMTR/71775 (Ref 172/2025, Dec 12, 2025)
 * - NSE Circular No. NSE/CMTR/76941 (Ref 149/2026, Oct 19, 2026)
 * 
 * Usage:
 *   node test/test_holidays.js
 */

const assert = require('assert');
const {
  NSE_HOLIDAYS_2026,
  NSE_WEEKEND_FESTIVALS_2026,
  SPECIAL_SESSIONS_2026,
  isNseTradingDay,
  isExcludedSpecialSession,
  getSpecialSessionInfo
} = require('../shared/nse_holidays');

console.log('🧪 Running NSE Trading Holiday & Special Session Integrity Tests...\n');

// 1. Assert exactly 15 weekday trading holidays as announced in Circular NSE/CMTR/71775
const holidayDates = Object.keys(NSE_HOLIDAYS_2026);
assert.strictEqual(holidayDates.length, 15, `Expected exactly 15 weekday holidays, found ${holidayDates.length}`);
console.log('✓ Test 1 Passed: Exactly 15 official weekday holidays confirmed.');

// 2. Assert specific key 2026 dates
const expectedDates = [
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Sri Guru Nanak Dev Jayanti
  '2026-12-25'  // Christmas
];

for (const d of expectedDates) {
  assert.ok(NSE_HOLIDAYS_2026[d], `Expected holiday date ${d} missing from calendar`);
  assert.strictEqual(isNseTradingDay(d), false, `Expected ${d} to be closed, but isNseTradingDay returned true`);
}
console.log('✓ Test 2 Passed: All 15 specific statutory holiday dates verified closed.');

// 3. Assert Muhurat Trading Schedule (Circular NSE/CMTR/76941)
const muhuratDate = '2026-11-08';
const muhuratInfo = getSpecialSessionInfo(muhuratDate);
assert.ok(muhuratInfo, 'Diwali Muhurat session 2026-11-08 missing from SPECIAL_SESSIONS_2026');
assert.strictEqual(muhuratInfo.circular, 'NSE/CMTR/76941', 'Circular reference mismatch');
assert.strictEqual(muhuratInfo.openTime, '14:20', `Expected openTime 14:20, got ${muhuratInfo.openTime}`);
assert.strictEqual(muhuratInfo.closeTime, '15:30', `Expected closeTime 15:30, got ${muhuratInfo.closeTime}`);
assert.strictEqual(muhuratInfo.dayOfWeek, 'Sunday', 'Muhurat 2026 should fall on Sunday');
assert.strictEqual(isNseTradingDay(muhuratDate), true, 'Special Sunday session must register as trading day');
assert.strictEqual(isExcludedSpecialSession(muhuratDate), true, 'Muhurat session must be excluded from quant backtests');
console.log('✓ Test 3 Passed: Sunday Nov 8, 2026 Muhurat trading session schedule (14:20 - 15:30) verified.');

// 4. Assert Regular Weekends
assert.strictEqual(isNseTradingDay('2026-11-01'), false, 'Regular Sunday 2026-11-01 should be closed');
assert.strictEqual(isNseTradingDay('2026-11-07'), false, 'Regular Saturday 2026-11-07 should be closed');
assert.strictEqual(isNseTradingDay('2026-11-02'), true, 'Regular Monday 2026-11-02 should be open');
console.log('✓ Test 4 Passed: Regular weekday vs weekend status verified.');

console.log('\n🎉 ALL 4 CALENDAR INTEGRITY TESTS PASSED SUCCESSFULLY.\n');
