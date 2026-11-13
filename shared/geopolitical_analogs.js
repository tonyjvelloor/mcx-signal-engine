/**
 * shared/geopolitical_analogs.js — Live Web Geopolitical Scraper & Historical Analog Matcher
 *
 * Fetches real-time geopolitical, tariff, OPEC, and macroeconomic news from live RSS feeds,
 * scores global threat intensity (0–100), and matches incoming headlines against
 * shared/geopolitical_history.js to forecast MCX commodity & NSE stock trajectories.
 */

const https = require('https');
const geoHistory = require('./geopolitical_history');

const FEED_URLS = [
  {
    name: 'Google News Commodities & Geopolitics',
    url: 'https://news.google.com/rss/search?q=crude+oil+gold+geopolitics+OPEC+tariffs&hl=en-US&gl=US&ceid=US:en'
  },
  {
    name: 'BBC World News',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml'
  }
];

const HIGH_RISK_KEYWORDS = {
  'war': 18,
  'missile': 18,
  'strike': 15,
  'blockade': 18,
  'hormuz': 22,
  'red sea': 16,
  'houthi': 16,
  'sanctions': 14,
  'embargo': 18,
  'opec': 14,
  'output cut': 16,
  'tariff': 12,
  'trade war': 14,
  'iran': 12,
  'russia': 10,
  'ukraine': 10,
  'israel': 12,
  'gaza': 10,
  'china': 8,
  'fed': 8,
  'inflation': 8,
  'cpi': 8,
  'oil': 6,
  'gold': 5
};

let cache = {
  timestamp: 0,
  ttlMs: 15 * 60 * 1000, // 15 minutes
  data: null
};

function fetchUrl(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'MCX-Signal-Engine/2.0 (+https://github.com/tonyjvelloor/mcx-signal-engine)' },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve(raw));
    });
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', reject);
  });
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

function parseRssItems(xml, sourceLabel, limit = 8) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1];
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const pubMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const srcMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);

    const title = titleMatch ? decodeXmlEntities(titleMatch[1]) : '';
    if (!title) continue;

    items.push({
      title,
      link: linkMatch ? decodeXmlEntities(linkMatch[1]) : '',
      pubDate: pubMatch ? decodeXmlEntities(pubMatch[1]) : '',
      source: srcMatch ? decodeXmlEntities(srcMatch[1]) : sourceLabel
    });
  }
  return items;
}

function scoreHeadlineRisk(headline) {
  const lower = String(headline || '').toLowerCase();
  let score = 0;
  const triggers = [];
  for (const [kw, weight] of Object.entries(HIGH_RISK_KEYWORDS)) {
    if (lower.includes(kw)) {
      score += weight;
      triggers.push(kw);
    }
  }
  return { score: Math.min(100, score), triggers };
}

function classifyThreatLevel(riskIndex) {
  if (riskIndex >= 70) return 'CRITICAL';
  if (riskIndex >= 45) return 'HIGH';
  if (riskIndex >= 25) return 'ELEVATED';
  return 'CALM';
}

function analyzeHeadlines(items) {
  const scoredItems = items.map(item => {
    const { score, triggers } = scoreHeadlineRisk(item.title);
    return { ...item, riskScore: score, triggers };
  });

  // Sort by highest risk relevance first
  scoredItems.sort((a, b) => b.riskScore - a.riskScore);

  const topHeadlines = scoredItems.slice(0, 10);
  const top5Avg = topHeadlines.slice(0, 5).reduce((acc, x) => acc + x.riskScore, 0) / Math.max(1, Math.min(5, topHeadlines.length));
  const riskIndex = Math.min(100, Math.round(top5Avg * 1.6 + 15));
  const threatLevel = classifyThreatLevel(riskIndex);

  const combinedText = topHeadlines.map(h => h.title).join(' ');
  const analog = geoHistory.matchHistoricalAnalog(combinedText);

  return {
    updatedAt: new Date().toISOString(),
    sourceMode: items.length > 0 ? 'LIVE_WEB_RSS' : 'OFFLINE_BASELINE',
    riskIndex,
    threatLevel,
    headlineCount: scoredItems.length,
    topHeadlines,
    closestAnalog: {
      id: analog.event.id,
      name: analog.event.name,
      startDate: analog.event.startDate,
      category: analog.event.category,
      severity: analog.event.severity,
      matchConfidence: analog.matchConfidence,
      matchingKeywords: analog.matchingKeywords,
      summary: analog.event.summary
    },
    commodityImpacts: analog.commodityImpacts,
    stockImpacts: analog.stockImpacts,
    institutionalPlaybook: analog.institutionalPlaybook
  };
}

async function getLiveGeopoliticalIntelligence(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache.data && (now - cache.timestamp) < cache.ttlMs) {
    return { ...cache.data, cached: true };
  }

  let allItems = [];
  const feedErrors = [];

  const results = await Promise.allSettled(
    FEED_URLS.map(async (f) => {
      const xml = await fetchUrl(f.url, 5000);
      return parseRssItems(xml, f.name, 8);
    })
  );

  results.forEach((res, idx) => {
    if (res.status === 'fulfilled') {
      allItems = allItems.concat(res.value);
    } else {
      feedErrors.push(`${FEED_URLS[idx].name}: ${res.reason.message}`);
    }
  });

  const analysis = analyzeHeadlines(allItems);
  analysis.feedErrors = feedErrors;
  analysis.cached = false;

  cache = {
    timestamp: now,
    ttlMs: cache.ttlMs,
    data: analysis
  };

  return analysis;
}

module.exports = {
  getLiveGeopoliticalIntelligence,
  analyzeHeadlines,
  scoreHeadlineRisk,
  parseRssItems
};
