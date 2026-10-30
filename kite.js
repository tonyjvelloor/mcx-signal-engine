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
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const kite = cfg.kite || {};
    const apiKey = process.env.KITE_API_KEY || kite.apiKey;
    const apiSecret = process.env.KITE_API_SECRET || kite.apiSecret;

    if (!apiKey || !apiSecret) {
      throw new Error('Kite API Key or Secret missing. Set them in config.json or environment variables.');
    }

    return {
      apiKey,
      apiSecret,
      redirectUrl: kite.redirectUrl || 'http://127.0.0.1:8000/mcx-beginner.html'
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
  if (!isLiveAllowed) {
    throw new Error('SAFETY LOCK: Live execution blocked. Paper trading mode is active.');
  }

  const session = loadSession();
  if (!session) throw new Error('No active Kite session. Please authenticate first.');

  const params = new URLSearchParams({
    variety: order.variety || 'regular',
    exchange: order.exchange || 'NSE',
    tradingsymbol: order.symbol,
    transaction_type: order.side,
    order_type: order.type || 'LIMIT',
    quantity: order.quantity.toString(),
    product: order.product || 'CNC', // Cash CNC default for equity safety
    price: (order.price || 0).toString(),
    trigger_price: (order.triggerPrice || 0).toString(),
    validity: order.validity || 'DAY'
  });

  return kiteRequest(`/orders/${order.variety || 'regular'}`, 'POST', params.toString(), session.access_token);
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
  isSessionValid
};
