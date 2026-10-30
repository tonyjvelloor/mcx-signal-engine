/**
 * Zerodha Kite Connect Service
 * Pure Node.js implementation with zero external dependencies.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const SESSION_FILE = path.join(__dirname, '.kite_session.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).kite;
  } catch (e) {
    return {
      apiKey: process.env.KITE_API_KEY || 'yec641x53e88b3gu',
      apiSecret: process.env.KITE_API_SECRET || 'eqlk91edm8j4dayfey2htzvmsle0zebe',
      redirectUrl: 'http://127.0.0.1:8000/mcx-beginner.html'
    };
  }
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      // Check if session is from today (Kite tokens expire daily at 6:00 AM)
      const sessionDate = new Date(data.created_at).toDateString();
      const today = new Date().toDateString();
      if (sessionDate === today && data.access_token) {
        return data;
      }
    }
  } catch (e) {}
  return null;
}

function saveSession(sessionData) {
  sessionData.created_at = new Date().toISOString();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
}

function kiteRequest(endpoint, method = 'GET', postData = null, accessToken = null) {
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
            reject(new Error(json.message || `Kite API Error (${res.statusCode})`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body}`));
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────
// PUBLIC METHODS
// ─────────────────────────────────────────────────────────────

function getLoginUrl() {
  const config = loadConfig();
  return `https://kite.zerodha.com/connect/login?v=3&api_key=${config.apiKey}`;
}

async function generateSession(requestToken) {
  const config = loadConfig();
  // Checksum formula: SHA-256(api_key + request_token + api_secret)
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
  // instruments array or comma-separated string: e.g. "NSE:NIFTY 50,MCX:GOLDPETAL24NOVFUT"
  const instStr = Array.isArray(instruments) ? instruments.map(i => encodeURIComponent(i)).join('&i=') : encodeURIComponent(instruments);
  return kiteRequest(`/quote?i=${instStr}`, 'GET', null, session.access_token);
}

async function placeOrder(order) {
  const session = loadSession();
  if (!session) throw new Error('No active Kite session. Please authenticate first.');

  const params = new URLSearchParams({
    variety: order.variety || 'regular',
    exchange: order.exchange || 'MCX',
    tradingsymbol: order.symbol,
    transaction_type: order.side, // 'BUY' or 'SELL'
    order_type: order.type || 'LIMIT', // 'MARKET', 'LIMIT', 'SL', 'SL-M'
    quantity: order.quantity.toString(),
    product: order.product || 'NRML', // 'MIS' (Intraday) or 'NRML' (Overnight)
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
  placeOrder
};
