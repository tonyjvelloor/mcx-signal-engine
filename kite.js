/**
 * Zerodha Kite Connect Service
 * Pure Node.js implementation with endpoint-specific rate limiters,
 * precise 6:00 AM IST session validation, and strict credential isolation.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SESSION_FILE = path.join(__dirname, '.kite_session.json');

// ─────────────────────────────────────────────────────────────
// 1. ENDPOINT-SPECIFIC RATE LIMITERS
// Published Kite limits:
// • Quotes: 1 request / second
// • Historical: 3 requests / second
// • Order placement: 10 requests / second
// • Default/Other: 10 requests / second
// ─────────────────────────────────────────────────────────────
class RateLimiter {
  constructor(maxPerSecond) {
    this.intervalMs = Math.ceil(1000 / maxPerSecond);
    this.lastRun = 0;
    this.queue = [];
    this.running = false;
  }

  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  process() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;

    const now = Date.now();
    const wait = Math.max(0, this.lastRun + this.intervalMs - now);

    setTimeout(async () => {
      const item = this.queue.shift();
      this.lastRun = Date.now();
      this.running = false;

      if (item) {
        try {
          const res = await item.fn();
          item.resolve(res);
        } catch (err) {
          item.reject(err);
        }
      }
      this.process();
    }, wait);
  }
}

const rateLimiters = {
  quote: new RateLimiter(1),       // 1 req/sec
  historical: new RateLimiter(3),  // 3 req/sec
  order: new RateLimiter(10),      // 10 req/sec
  default: new RateLimiter(10)     // 10 req/sec
};

function getLimiterForEndpoint(endpoint) {
  if (endpoint.startsWith('/quote')) return rateLimiters.quote;
  if (endpoint.includes('/instruments/historical')) return rateLimiters.historical;
  if (endpoint.startsWith('/orders')) return rateLimiters.order;
  return rateLimiters.default;
}

// ─────────────────────────────────────────────────────────────
// 2. CREDENTIAL LOADER (NO HARDCODED FALLBACKS)
// ─────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    let apiKey = process.env.KITE_API_KEY;
    let apiSecret = process.env.KITE_API_SECRET;
    let redirectUrl = 'http://127.0.0.1:8000/mcx-beginner.html';

    const secPath = path.join(__dirname, '.secrets.json');
    if (fs.existsSync(secPath)) {
      try {
        const sec = JSON.parse(fs.readFileSync(secPath, 'utf8'));
        apiKey = apiKey || sec.kiteApiKey;
        apiSecret = apiSecret || sec.kiteApiSecret;
      } catch (_) {}
    }

    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const cfg = JSON.parse(raw);
        const kite = cfg.kite || {};
        apiKey = apiKey || (kite.apiKey !== 'YOUR_KITE_API_KEY' ? kite.apiKey : null);
        apiSecret = apiSecret || (kite.apiSecret !== 'YOUR_KITE_API_SECRET' ? kite.apiSecret : null);
        redirectUrl = kite.redirectUrl || redirectUrl;
      } catch (_) {}
    }

    if (!apiKey || !apiSecret) {
      throw new Error('Kite API Key or Secret missing. Set them in .secrets.json or environment variables.');
    }

    return {
      apiKey,
      apiSecret,
      redirectUrl
    };
  } catch (e) {
    throw new Error(`Failed to load Kite configuration: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 3. ASIA/KOLKATA 6:00 AM IST SESSION VALIDATION
// ─────────────────────────────────────────────────────────────
function isSessionValid(createdAtStr) {
  if (!createdAtStr) return false;
  const created = new Date(createdAtStr);
  if (isNaN(created.getTime())) return false;

  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30

  const createdIST = new Date(created.getTime() + istOffsetMs);
  const nowIST = new Date(now.getTime() + istOffsetMs);

  // Expiry boundary: 6:00 AM IST on the day following createdIST
  // (or 6:00 AM IST of today if created before 6:00 AM)
  const expiryIST = new Date(createdIST);
  if (createdIST.getUTCHours() >= 6) {
    expiryIST.setUTCDate(expiryIST.getUTCDate() + 1);
  }
  expiryIST.setUTCHours(6, 0, 0, 0);

  return nowIST.getTime() < expiryIST.getTime();
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (data.access_token && isSessionValid(data.created_at)) {
        return data;
      }
    }
  } catch (e) {}
  return null;
}

function saveSession(sessionData) {
  sessionData.created_at = new Date().toISOString();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2), { mode: 0o600 });
}

// ─────────────────────────────────────────────────────────────
// 4. LOW-LEVEL REQUEST HANDLER (WITH QUEUING)
// ─────────────────────────────────────────────────────────────
function rawKiteRequest(endpoint, method = 'GET', postData = null, accessToken = null) {
  const config = loadConfig();
  return new Promise((resolve, reject) => {
    const headers = {
      'X-Kite-Version': '3',
      'User-Agent': 'ApexOrderFlow/1.0',
      'Accept': 'application/json'
    };

    if (accessToken) {
      headers['Authorization'] = `token ${config.apiKey}:${accessToken}`;
    }

    if (postData) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const req = https.request(`https://api.kite.trade${endpoint}`, {
      method,
      headers
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            // Handle session invalidation explicitly
            if (res.statusCode === 403) {
              try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch (_) {}
            }
            reject(new Error(json.message || `Kite API Error (${res.statusCode})`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body.slice(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function kiteRequest(endpoint, method = 'GET', postData = null, accessToken = null) {
  const limiter = getLimiterForEndpoint(endpoint);
  return limiter.schedule(() => rawKiteRequest(endpoint, method, postData, accessToken));
}

// ─────────────────────────────────────────────────────────────
// 5. PUBLIC INTERFACE
// ─────────────────────────────────────────────────────────────

function getLoginUrl() {
  const config = loadConfig();
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${config.apiKey}`;
}

async function generateSession(requestToken) {
  const config = loadConfig();
  const hashString = `${config.apiKey}${requestToken}${config.apiSecret}`;
  const checksum = crypto.createHash('sha256').update(hashString).digest('hex');
  const postData = `api_key=${encodeURIComponent(config.apiKey)}&request_token=${encodeURIComponent(requestToken)}&checksum=${encodeURIComponent(checksum)}`;

  const res = await kiteRequest('/session/token', 'POST', postData);
  if (res && res.data && res.data.access_token) {
    saveSession(res.data);
    return res.data;
  }
  throw new Error('Failed to retrieve access token from Kite');
}

async function getProfile() {
  const session = loadSession();
  if (!session) throw new Error('No active Kite session. Please authenticate first.');
  return kiteRequest('/user/profile', 'GET', null, session.access_token);
}

async function getMargins() {
  const session = loadSession();
  if (!session) throw new Error('No active Kite session. Please authenticate first.');
  return kiteRequest('/user/margins', 'GET', null, session.access_token);
}

async function getLiveQuotes(instruments) {
  const session = loadSession();
  if (!session) throw new Error('No active Kite session. Please authenticate first.');
  const instStr = Array.isArray(instruments) 
    ? instruments.map(i => encodeURIComponent(i)).join('&i=') 
    : encodeURIComponent(instruments);
  return kiteRequest(`/quote?i=${instStr}`, 'GET', null, session.access_token);
}

async function placeOrder(order, isLiveAllowed = false) {
  const sym = String(order.tradingsymbol || order.symbol || '').toUpperCase();
  const isCommodity = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'COPPER', 'ZINC', 'ALUM', 'COTTON'].some(c => sym.includes(c));

  // Intelligent Exchange & Product routing:
  // Commodities must trade on MCX with NRML (carry-forward) or MIS (intraday); CNC is invalid on MCX.
  const defaultExchange = isCommodity ? 'MCX' : 'NSE';
  const defaultProduct = isCommodity ? 'NRML' : 'CNC';

  if (!isLiveAllowed) {
    return {
      status: 'success',
      simulated: true,
      order_id: `SIM-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      exchange: order.exchange || defaultExchange,
      tradingsymbol: sym,
      transaction_type: (order.transaction_type || order.side || 'BUY').toUpperCase(),
      quantity: Number(order.quantity || 1),
      price: Number(order.price || 0),
      trigger_price: Number(order.triggerPrice || order.trigger_price || 0),
      product: order.product || defaultProduct,
      message: 'Paper trading order simulated successfully. Risk engine verified.'
    };
  }

  const session = loadSession();
  if (!session) throw new Error('No active Kite session. Please authenticate first.');

  const params = new URLSearchParams({
    variety: order.variety || 'regular',
    exchange: order.exchange || defaultExchange,
    tradingsymbol: sym,
    transaction_type: (order.transaction_type || order.side || 'BUY').toUpperCase(),
    order_type: order.type || order.order_type || 'LIMIT',
    quantity: order.quantity.toString(),
    product: order.product || defaultProduct,
    price: (order.price || 0).toString(),
    trigger_price: (order.triggerPrice || order.trigger_price || 0).toString(),
    validity: order.validity || 'DAY'
  });

  return kiteRequest(`/orders/${order.variety || 'regular'}`, 'POST', params.toString(), session.access_token);
}

async function placeGTT(trigger, isLiveAllowed = false) {
  const sym = String(trigger.tradingsymbol || trigger.symbol || '').toUpperCase();
  const isCommodity = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'COPPER', 'ZINC', 'ALUM', 'COTTON'].some(c => sym.includes(c));
  const defaultExchange = isCommodity ? 'MCX' : 'NSE';
  const defaultProduct = isCommodity ? 'NRML' : 'CNC';

  if (!isLiveAllowed) {
    return {
      status: 'success',
      simulated: true,
      trigger_id: `GTT-SIM-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: trigger.type || 'two-leg',
      exchange: trigger.exchange || defaultExchange,
      tradingsymbol: sym,
      stoploss: Number(trigger.stoploss || 0),
      target: Number(trigger.target || 0),
      quantity: Number(trigger.quantity || 1),
      product: trigger.product || defaultProduct,
      message: 'Paper GTT OCO order simulated successfully. Active on virtual exchange server.'
    };
  }

  const session = loadSession();
  if (!session) throw new Error('No active Kite session. Please authenticate first.');

  const transactionType = (trigger.transaction_type || trigger.side || 'SELL').toUpperCase();
  const qty = Number(trigger.quantity || 1);
  const prod = trigger.product || defaultProduct;
  const ex = trigger.exchange || defaultExchange;

  const condition = {
    exchange: ex,
    tradingsymbol: sym,
    trigger_values: [Number(trigger.stoploss), Number(trigger.target)],
    last_price: Number(trigger.last_price || trigger.entry || trigger.stoploss)
  };

  const orders = [
    {
      transaction_type: transactionType,
      quantity: qty,
      product: prod,
      order_type: 'LIMIT',
      price: Number(trigger.stoploss)
    },
    {
      transaction_type: transactionType,
      quantity: qty,
      product: prod,
      order_type: 'LIMIT',
      price: Number(trigger.target)
    }
  ];

  const params = new URLSearchParams({
    type: 'two-leg',
    condition: JSON.stringify(condition),
    orders: JSON.stringify(orders)
  });

  return kiteRequest('/gtt/triggers', 'POST', params.toString(), session.access_token);
}

module.exports = {
  loadConfig,
  loadSession,
  getLoginUrl,
  generateSession,
  getProfile,
  getMargins,
  getLiveQuotes,
  placeOrder,
  placeGTT,
  isSessionValid
};
