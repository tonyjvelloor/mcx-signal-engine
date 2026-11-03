/**
 * test/test_ticker.js — Unit tests for kite-ticker.js binary packet decoder
 * 
 * Tests the parseBinaryMessage and parsePacket functions without
 * needing an actual Kite session/network connection.
 * 
 * Run: node test/test_ticker.js
 */

'use strict';

const { parseBinaryMessage, getDivisor, MODE_LTP, MODE_QUOTE, MODE_FULL } = require('../kite-ticker');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`✓ ${msg}`);
    passed++;
  } else {
    console.error(`✗ FAIL: ${msg}`);
    failed++;
  }
}

function assertNear(a, b, msg, tol = 0.001) {
  assert(Math.abs(a - b) < tol, `${msg} (expected ${b}, got ${a})`);
}

console.log('\n🧪 Running kite-ticker binary decoder tests...\n');

// ─── Helper to build a fake Kite binary message ───────────────────────────────

/**
 * Build a Kite binary message buffer from an array of packet buffers.
 * Layout: [num_packets: uint16][packet_len: uint16][packet_bytes]...
 */
function buildMessage(packets) {
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(packets.length, 0);
  const parts = [header];
  for (const p of packets) {
    const lenBuf = Buffer.allocUnsafe(2);
    lenBuf.writeUInt16BE(p.length, 0);
    parts.push(lenBuf, p);
  }
  return Buffer.concat(parts);
}

/**
 * Write a uint32 big-endian into a buffer at offset.
 */
function writeU32(buf, offset, val) {
  buf.writeUInt32BE(val >>> 0, offset);
}

// ─── Test 1: getDivisor ───────────────────────────────────────────────────────
{
  // NSE CM segment = token & 0xff === 1
  const nseToken  = (1234 << 8) | 1;  // segment 1 = NSE_CM
  const cdToken   = (5678 << 8) | 3;  // segment 3 = NSE_CD
  const mcxToken  = (9012 << 8) | 7;  // segment 7 = MCX_FO
  assert(getDivisor(nseToken) === 100.0,         'NSE_CM token → divisor 100');
  assert(getDivisor(cdToken)  === 10000000.0,    'NSE_CD token → divisor 10,000,000');
  assert(getDivisor(mcxToken) === 100.0,         'MCX_FO token → divisor 100');
}

// ─── Test 2: Empty message ────────────────────────────────────────────────────
{
  const msg = Buffer.from([0x00, 0x00]); // 0 packets
  const ticks = parseBinaryMessage(msg);
  assert(ticks.length === 0, 'Empty message → 0 ticks');
}

// ─── Test 3: LTP mode (8-byte packet) ────────────────────────────────────────
{
  const NSE_CM_TOKEN = 0x000101; // segment=1 (NSE CM), divisor=100
  const LTP_INT      = 250000;   // represents ₹2500.00

  const pkt = Buffer.allocUnsafe(8);
  writeU32(pkt, 0, NSE_CM_TOKEN);  // instrument_token
  writeU32(pkt, 4, LTP_INT);       // last_price raw

  const msg = buildMessage([pkt]);
  const ticks = parseBinaryMessage(msg);

  assert(ticks.length === 1, 'LTP packet → 1 tick');
  assert(ticks[0].instrument_token === NSE_CM_TOKEN, 'LTP token matches');
  assertNear(ticks[0].last_price, 2500.00, 'LTP price decoded correctly');
  assert(ticks[0].mode === MODE_LTP, 'LTP tick has mode=ltp');
  assert(ticks[0].ohlc === undefined, 'LTP tick has no OHLC');
}

// ─── Test 4: Quote mode (44-byte packet) ─────────────────────────────────────
{
  const TOKEN  = 0x000101;
  const pkt    = Buffer.alloc(44, 0);
  writeU32(pkt,  0, TOKEN);
  writeU32(pkt,  4, 230000);  // last_price = ₹2300.00
  writeU32(pkt,  8, 235000);  // high       = ₹2350.00
  writeU32(pkt, 12, 228000);  // low        = ₹2280.00
  writeU32(pkt, 16, 231000);  // open       = ₹2310.00
  writeU32(pkt, 20, 229000);  // close      = ₹2290.00
  writeU32(pkt, 24, 100);     // net_change = ₹1.00
  writeU32(pkt, 28, 50);      // ltq
  writeU32(pkt, 32, 100000);  // volume
  writeU32(pkt, 36, 229500);  // avg_price  = ₹2295.00
  writeU32(pkt, 40, 0);       // oi

  const msg   = buildMessage([pkt]);
  const ticks = parseBinaryMessage(msg);

  assert(ticks.length === 1, 'Quote packet → 1 tick');
  assert(ticks[0].mode === MODE_QUOTE, 'Quote tick mode=quote');
  assertNear(ticks[0].last_price, 2300.00, 'Quote last_price');
  assertNear(ticks[0].ohlc.high,  2350.00, 'Quote high');
  assertNear(ticks[0].ohlc.low,   2280.00, 'Quote low');
  assertNear(ticks[0].ohlc.open,  2310.00, 'Quote open');
  assertNear(ticks[0].ohlc.close, 2290.00, 'Quote close');
  assert(ticks[0].volume_traded === 100000, 'Quote volume');
  assert(ticks[0].last_traded_quantity === 50, 'Quote LTQ');
  assertNear(ticks[0].average_traded_price, 2295.00, 'Quote avg_price');
}

// ─── Test 5: Full mode (184-byte packet) ─────────────────────────────────────
{
  const TOKEN = 0x000101;
  const pkt   = Buffer.alloc(184, 0);
  writeU32(pkt,  0, TOKEN);
  writeU32(pkt,  4, 248000);  // last_price = ₹2480.00
  writeU32(pkt,  8, 250000);  // high
  writeU32(pkt, 12, 245000);  // low
  writeU32(pkt, 16, 246000);  // open
  writeU32(pkt, 20, 247000);  // close
  // Market depth: first bid at byte 64
  writeU32(pkt, 64, 500);     // bid qty
  writeU32(pkt, 68, 247800);  // bid price = ₹2478.00
  pkt.writeUInt16BE(3, 72);   // bid orders

  const msg   = buildMessage([pkt]);
  const ticks = parseBinaryMessage(msg);

  assert(ticks.length === 1, 'Full packet → 1 tick');
  assert(ticks[0].mode === MODE_FULL, 'Full tick mode=full');
  assertNear(ticks[0].last_price, 2480.00, 'Full last_price');
  assert(ticks[0].depth !== undefined, 'Full tick has depth');
  assert(ticks[0].depth.buy.length === 5, 'Full tick has 5 bid levels');
  assert(ticks[0].depth.sell.length === 5, 'Full tick has 5 ask levels');
  assert(ticks[0].depth.buy[0].quantity === 500, 'Full tick bid[0] qty');
  assertNear(ticks[0].depth.buy[0].price, 2478.00, 'Full tick bid[0] price');
  assert(ticks[0].depth.buy[0].orders === 3, 'Full tick bid[0] orders');
}

// ─── Test 6: Multiple packets in one message ──────────────────────────────────
{
  const pkt1 = Buffer.alloc(8, 0);
  writeU32(pkt1, 0, 0x000201);
  writeU32(pkt1, 4, 150000);  // ₹1500.00

  const pkt2 = Buffer.alloc(44, 0);
  writeU32(pkt2, 0, 0x000401);
  writeU32(pkt2, 4, 320000);  // ₹3200.00

  const msg   = buildMessage([pkt1, pkt2]);
  const ticks = parseBinaryMessage(msg);

  assert(ticks.length === 2, 'Two-packet message → 2 ticks');
  assertNear(ticks[0].last_price, 1500.00, 'Tick 1 price');
  assertNear(ticks[1].last_price, 3200.00, 'Tick 2 price');
}

// ─── Test 7: NSE CD segment (CDS divisor = 10,000,000) ───────────────────────
{
  // NSE_CD segment = 3
  const CD_TOKEN = (100 << 8) | 3;
  const pkt      = Buffer.alloc(8, 0);
  writeU32(pkt, 0, CD_TOKEN);
  writeU32(pkt, 4, 836450000); // raw = 836450000 → ₹83.645000 (USD/INR)

  const msg   = buildMessage([pkt]);
  const ticks = parseBinaryMessage(msg);
  assertNear(ticks[0].last_price, 83.645, 'NSE CD (CDS) price decoded with 10M divisor', 0.0001);
}

// ─── Test 8: Truncated / corrupt message handled gracefully ──────────────────
{
  const truncated = Buffer.from([0x00, 0x01, 0x00, 0x08, 0x00]); // claims 1 packet of 8 bytes, only 1 byte provided
  let threw = false;
  try {
    const ticks = parseBinaryMessage(truncated);
    assert(Array.isArray(ticks), 'Truncated message returns array (no throw)');
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'Truncated binary frame does not throw');
}

// ─── Test 9: ArrayBuffer input (as WebSocket delivers) ───────────────────────
{
  const pkt = Buffer.alloc(8, 0);
  writeU32(pkt, 0, 0x000101);
  writeU32(pkt, 4, 180000);

  const msgBuf  = buildMessage([pkt]);
  const ab      = msgBuf.buffer.slice(msgBuf.byteOffset, msgBuf.byteOffset + msgBuf.byteLength);
  const ticks   = parseBinaryMessage(ab);
  assert(ticks.length === 1, 'ArrayBuffer input works (WebSocket arraybuffer type)');
  assertNear(ticks[0].last_price, 1800.00, 'ArrayBuffer price correct');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed.\n`);
if (failed > 0) {
  console.error(`❌ ${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log('🎉 ALL TICKER BINARY DECODER TESTS PASSED.\n');
}
