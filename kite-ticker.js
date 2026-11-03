/**
 * kite-ticker.js — Zerodha Kite Connect v3 WebSocket Ticker
 *
 * Pure Node.js implementation using the built-in WebSocket global (Node 22+).
 * No external dependencies.
 *
 * Implements the full binary protocol from:
 *   https://kite.trade/docs/connect/v3/websocket/
 *
 * Architecture:
 *  • One WebSocket to wss://ws.kite.trade (per Kite session)
 *  • Decodes binary frames → structured tick objects
 *  • Fans out ticks to all registered SSE clients
 *  • Auto-reconnects with exponential backoff (cap: 60s)
 *  • Gracefully handles session expiry and market-hours awareness
 */

'use strict';

const { loadSession, loadConfig } = require('./kite');

// ─────────────────────────────────────────────────────────────
// 1. CONSTANTS & BINARY PROTOCOL
// ─────────────────────────────────────────────────────────────
const KITE_WS_URL = 'wss://ws.kite.trade';

// Kite text-frame modes
const MODE_LTP   = 'ltp';
const MODE_QUOTE = 'quote';
const MODE_FULL  = 'full';

// Packet sizes per mode (as per Kite v3 docs)
const PACKET_LTP   = 8;
const PACKET_QUOTE = 44;
const PACKET_FULL  = 184;

// Segment divisors (instrument_token & 0xff determines segment)
const SEGMENT_NSE_CM    = 1;
const SEGMENT_NSE_FO    = 2;
const SEGMENT_NSE_CD    = 3;
const SEGMENT_BSE_CM    = 4;
const SEGMENT_BSE_FO    = 5;
const SEGMENT_BSE_CD    = 6;
const SEGMENT_MCX_FO    = 7;
const SEGMENT_MCXSX     = 8;
const SEGMENT_INDICES   = 9;

/**
 * Return the price divisor for a given instrument_token.
 * CDS segments use 10,000,000; all others use 100.
 */
function getDivisor(token) {
  const segment = token & 0xff;
  if (segment === SEGMENT_NSE_CD || segment === SEGMENT_BSE_CD) {
    return 10000000.0;
  }
  return 100.0;
}

/**
 * Parse a single packet from the binary message buffer.
 * Returns a tick object. Packet length determines mode.
 *
 * @param {Buffer} buf   - Slice of the raw binary frame for this packet
 * @returns {object|null}
 */
function parsePacket(buf) {
  const len = buf.length;
  if (len < 8) return null;

  const token   = buf.readUInt32BE(0);
  const divisor = getDivisor(token);

  const tick = {
    instrument_token: token,
    mode: len === PACKET_LTP ? MODE_LTP : len === PACKET_QUOTE ? MODE_QUOTE : MODE_FULL,
    tradable: (token & 0xff) !== SEGMENT_INDICES,
    last_price: buf.readUInt32BE(4) / divisor,
    timestamp: Date.now()
  };

  if (len >= PACKET_QUOTE) {
    tick.ohlc = {
      high:  buf.readUInt32BE(8)  / divisor,
      low:   buf.readUInt32BE(12) / divisor,
      open:  buf.readUInt32BE(16) / divisor,
      close: buf.readUInt32BE(20) / divisor,
    };
    tick.net_change                = buf.readUInt32BE(24) / divisor;
    tick.last_traded_quantity      = buf.readUInt32BE(28);
    tick.volume_traded             = buf.readUInt32BE(32);
    tick.average_traded_price      = buf.readUInt32BE(36) / divisor;
    tick.oi                        = buf.readUInt32BE(40);
  }

  if (len >= PACKET_FULL) {
    tick.last_trade_time           = buf.readUInt32BE(44);  // unix epoch
    tick.oi_day_high               = buf.readUInt32BE(48);
    tick.oi_day_low                = buf.readUInt32BE(52);
    tick.exchange_timestamp        = buf.readUInt32BE(60);  // unix epoch

    // Market depth: 5 bids + 5 offers, each 12 bytes, starting at byte 64
    const depth = { buy: [], sell: [] };
    for (let i = 0; i < 5; i++) {
      const base = 64 + i * 12;
      depth.buy.push({
        quantity: buf.readUInt32BE(base),
        price:    buf.readUInt32BE(base + 4) / divisor,
        orders:   buf.readUInt16BE(base + 8)
      });
    }
    for (let i = 0; i < 5; i++) {
      const base = 64 + 60 + i * 12;
      depth.sell.push({
        quantity: buf.readUInt32BE(base),
        price:    buf.readUInt32BE(base + 4) / divisor,
        orders:   buf.readUInt16BE(base + 8)
      });
    }
    tick.depth = depth;
  }

  return tick;
}

/**
 * Parse a complete Kite binary message frame.
 * Layout: [num_packets: uint16][packet_len: uint16][packet_bytes: N] ...
 *
 * @param {ArrayBuffer|Buffer} arrayBuffer
 * @returns {object[]} Array of tick objects
 */
function parseBinaryMessage(arrayBuffer) {
  const buf = Buffer.isBuffer(arrayBuffer)
    ? arrayBuffer
    : Buffer.from(arrayBuffer);

  if (buf.length < 2) return [];

  const numPackets = buf.readUInt16BE(0);
  const ticks = [];
  let offset = 2;

  for (let i = 0; i < numPackets; i++) {
    if (offset + 2 > buf.length) break;
    const packetLen = buf.readUInt16BE(offset);
    offset += 2;
    if (offset + packetLen > buf.length) break;
    const packetBuf = buf.slice(offset, offset + packetLen);
    offset += packetLen;
    const tick = parsePacket(packetBuf);
    if (tick) ticks.push(tick);
  }

  return ticks;
}

// ─────────────────────────────────────────────────────────────
// 2. TICKER STATE
// ─────────────────────────────────────────────────────────────
let ws = null;
let isConnected = false;
let reconnectTimer = null;
let reconnectDelay = 1000; // ms, doubles on each failure, capped at 60s
const MAX_RECONNECT_DELAY = 60000;

// instruments to subscribe: Map<token(number), mode(string)>
const subscriptions = new Map();

// SSE client registry: Set of { res, id }
const sseClients = new Set();

// last known tick per token for snapshot delivery to new SSE clients
const tickCache = new Map();

// ─────────────────────────────────────────────────────────────
// 3. SSE CLIENT MANAGEMENT
// ─────────────────────────────────────────────────────────────
function addSseClient(res, clientId) {
  const client = { res, id: clientId };
  sseClients.add(client);
  console.log(`🔴 [TICKER] SSE client connected: ${clientId} (total: ${sseClients.size})`);

  // Send current connection state immediately
  sendSseEvent(client, 'status', {
    connected: isConnected,
    subscriptions: [...subscriptions.entries()].map(([t, m]) => ({ token: t, mode: m })),
    time: new Date().toISOString()
  });

  // Deliver cached ticks as a snapshot
  if (tickCache.size > 0) {
    sendSseEvent(client, 'snapshot', Object.fromEntries(tickCache));
  }

  res.on('close', () => {
    sseClients.delete(client);
    console.log(`⚫ [TICKER] SSE client disconnected: ${clientId} (total: ${sseClients.size})`);
  });

  return client;
}

function sendSseEvent(client, event, data) {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {}
}

function broadcastTicks(ticks) {
  if (sseClients.size === 0) return;
  const payload = JSON.stringify(ticks);
  for (const client of sseClients) {
    try {
      client.res.write(`event: tick\ndata: ${payload}\n\n`);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

function broadcastStatus(statusObj) {
  for (const client of sseClients) {
    sendSseEvent(client, 'status', statusObj);
  }
}

// ─────────────────────────────────────────────────────────────
// 4. WEBSOCKET LIFECYCLE
// ─────────────────────────────────────────────────────────────
function buildWsUrl(session, config) {
  return `${KITE_WS_URL}?api_key=${encodeURIComponent(config.apiKey)}&access_token=${encodeURIComponent(session.access_token)}`;
}

/**
 * Send a text command frame to Kite WebSocket.
 * Kite control messages are JSON text frames.
 */
function sendCommand(command) {
  if (!ws || ws.readyState !== 1 /* OPEN */) return false;
  try {
    ws.send(JSON.stringify(command));
    return true;
  } catch (e) {
    console.error('[TICKER] send error:', e.message);
    return false;
  }
}

/**
 * Re-apply all current subscriptions after a reconnect.
 */
function resubscribeAll() {
  if (subscriptions.size === 0) return;
  const byMode = {};
  for (const [token, mode] of subscriptions) {
    if (!byMode[mode]) byMode[mode] = [];
    byMode[mode].push(token);
  }
  for (const [mode, tokens] of Object.entries(byMode)) {
    sendCommand({ a: 'subscribe', v: tokens });
    sendCommand({ a: 'mode',      v: [mode, tokens] });
  }
  console.log(`[TICKER] Resubscribed to ${subscriptions.size} instruments.`);
}

function connect() {
  const session = loadSession();
  if (!session) {
    console.warn('[TICKER] No Kite session — ticker paused. Retry after login.');
    broadcastStatus({ connected: false, reason: 'no_session' });
    scheduleReconnect();
    return;
  }

  let config;
  try { config = loadConfig(); } catch (e) {
    console.error('[TICKER] Config error:', e.message);
    return;
  }

  const wsUrl = buildWsUrl(session, config);
  console.log('[TICKER] Connecting to Kite WebSocket...');

  try {
    // Node 22+ has a built-in global WebSocket
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
  } catch (e) {
    console.error('[TICKER] WebSocket construction failed:', e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnected = true;
    reconnectDelay = 1000; // reset backoff on success
    console.log('✅ [TICKER] Kite WebSocket connected.');
    broadcastStatus({ connected: true, time: new Date().toISOString() });
    resubscribeAll();
  };

  ws.onmessage = (event) => {
    const data = event.data;

    // Text frame: Kite sends heartbeat pings and error text
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'error') {
          console.error('[TICKER] Kite error frame:', msg.data);
          broadcastStatus({ connected: false, reason: 'kite_error', message: msg.data });
        }
        // type: 'message' with code: 11001 = OK/connected ack
      } catch (_) {}
      return;
    }

    // Binary frame: market data
    const ticks = parseBinaryMessage(data);
    if (ticks.length === 0) return;

    // Update cache
    for (const tick of ticks) {
      tickCache.set(tick.instrument_token, tick);
    }

    broadcastTicks(ticks);
  };

  ws.onerror = (event) => {
    console.error('[TICKER] WebSocket error.');
  };

  ws.onclose = (event) => {
    isConnected = false;
    ws = null;
    console.warn(`[TICKER] WebSocket closed (code=${event.code}). Reconnecting...`);
    broadcastStatus({ connected: false, reason: 'disconnected', code: event.code });
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  console.log(`[TICKER] Reconnecting in ${reconnectDelay / 1000}s...`);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  isConnected = false;
}

// ─────────────────────────────────────────────────────────────
// 5. SUBSCRIPTION API
// ─────────────────────────────────────────────────────────────

/**
 * Subscribe to a list of instrument tokens.
 *
 * @param {number[]} tokens   - Kite instrument tokens (integers)
 * @param {string}   [mode]   - 'ltp' | 'quote' | 'full'  (default: 'quote')
 */
function subscribe(tokens, mode = MODE_QUOTE) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  const valid = tokens.map(Number).filter(t => t > 0 && Number.isFinite(t));
  if (valid.length === 0) return;

  for (const t of valid) subscriptions.set(t, mode);

  if (isConnected) {
    sendCommand({ a: 'subscribe', v: valid });
    sendCommand({ a: 'mode',      v: [mode, valid] });
    console.log(`[TICKER] Subscribed to ${valid.length} tokens in ${mode} mode.`);
  } else {
    console.log(`[TICKER] Queued ${valid.length} tokens (will subscribe on connect).`);
  }
}

/**
 * Unsubscribe from a list of instrument tokens.
 *
 * @param {number[]} tokens
 */
function unsubscribe(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return;
  const valid = tokens.map(Number).filter(t => subscriptions.has(t));
  if (valid.length === 0) return;

  for (const t of valid) {
    subscriptions.delete(t);
    tickCache.delete(t);
  }

  if (isConnected) {
    sendCommand({ a: 'unsubscribe', v: valid });
    console.log(`[TICKER] Unsubscribed from ${valid.length} tokens.`);
  }
}

/**
 * Change the mode of already-subscribed tokens.
 *
 * @param {number[]} tokens
 * @param {string}   mode   - 'ltp' | 'quote' | 'full'
 */
function setMode(tokens, mode) {
  const valid = tokens.map(Number).filter(t => subscriptions.has(t));
  if (valid.length === 0) return;
  for (const t of valid) subscriptions.set(t, mode);
  if (isConnected) {
    sendCommand({ a: 'mode', v: [mode, valid] });
  }
}

/**
 * Return the current status object.
 */
function getStatus() {
  return {
    connected: isConnected,
    subscriptions: [...subscriptions.entries()].map(([t, m]) => ({ token: t, mode: m })),
    sseClients: sseClients.size,
    cachedTicks: tickCache.size,
    time: new Date().toISOString()
  };
}

/**
 * Return the last known tick for a token (or null).
 * @param {number} token
 */
function getLastTick(token) {
  return tickCache.get(Number(token)) || null;
}

/**
 * Start the ticker. Called once from server.js after boot.
 * Connects only if there's an active Kite session.
 */
function start() {
  console.log('[TICKER] Starting Kite WebSocket ticker...');
  connect();
}

module.exports = {
  start,
  disconnect,
  connect,
  subscribe,
  unsubscribe,
  setMode,
  addSseClient,
  getStatus,
  getLastTick,
  MODE_LTP,
  MODE_QUOTE,
  MODE_FULL,
  // Expose for testing
  parseBinaryMessage,
  parsePacket,
  getDivisor
};
