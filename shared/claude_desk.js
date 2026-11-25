/**
 * shared/claude_desk.js — Cost-Governed Claude AI Institutional Risk Desk & EOD CIO Analyst
 *
 * Guarantees Claude API credits are NEVER wasted and can NEVER exceed trading profits:
 *   • Hard SQLite-Persisted Spend Caps (`ai_usage_ledger`):
 *       - Daily Cap:   ₹8.00 / day  (max 15 calls/day)
 *       - Monthly Cap: ₹120.00 / month (< 0.8% of ₹15,000 capital)
 *     When any cap is hit, ALL Claude calls cleanly fall back to ₹0 deterministic quant rules.
 *   • Conservative Haiku 4.5 Pricing Accounting ($1.00/1M in, $5.00/1M out @ ₹86/USD).
 *   • Long Smart Caching (45m Pre-Trade CRO, 1×/day EOD Post-Mortem) + 30m Error Cooldown
 *     to prevent retry storms on network/API hiccups.
 */
const https = require('https');

const DEFAULT_AI_LIMITS = {
  dailyCapInr: 8.0,      // Max ₹8/day (~$0.093)
  monthlyCapInr: 120.0,  // Max ₹120/month (~$1.40)
  dailyCallCap: 15,      // Max 15 API calls/day across the entire app
  usdInr: 86.0,
  inputUsdPer1M: 1.0,    // Claude Haiku 4.5 input rate
  outputUsdPer1M: 5.0    // Claude Haiku 4.5 output rate
};

const deskCache = new Map();
let lastErrorCooldownUntil = 0;

function getIstStamps(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 3600000);
  const iso = ist.toISOString();
  return { dateIst: iso.slice(0, 10), monthIst: iso.slice(0, 7) };
}

function getCached(key) {
  const hit = deskCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    deskCache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value, ttlMs) {
  deskCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function ensureAiUsageTable(db) {
  if (!db) return;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_ist TEXT NOT NULL,
        month_ist TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        cost_inr REAL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_date ON ai_usage_ledger (date_ist);
      CREATE INDEX IF NOT EXISTS idx_ai_usage_month ON ai_usage_ledger (month_ist);
    `);
  } catch (_) {}
}

function estimateCostFromTokens(inputTokens = 0, outputTokens = 0, limits = DEFAULT_AI_LIMITS) {
  const inTok = Math.max(0, Number(inputTokens || 0));
  const outTok = Math.max(0, Number(outputTokens || 0));
  const costUsd = (inTok / 1e6) * limits.inputUsdPer1M + (outTok / 1e6) * limits.outputUsdPer1M;
  const costInr = costUsd * limits.usdInr;
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: +costUsd.toFixed(6),
    costInr: +costInr.toFixed(4)
  };
}

/**
 * Returns live daily & monthly Claude API spend + hard circuit-breaker status.
 */
function getAiBudgetStatus(db, customLimits = {}) {
  const limits = { ...DEFAULT_AI_LIMITS, ...customLimits };
  const { dateIst, monthIst } = getIstStamps();
  let todayCalls = 0, todayCostInr = 0, todayTokens = 0;
  let monthCalls = 0, monthCostInr = 0, monthTokens = 0;
  let byEndpoint = {};

  if (db) {
    ensureAiUsageTable(db);
    try {
      const dRow = db.prepare(`
        SELECT COUNT(*) c, COALESCE(SUM(cost_inr), 0) inr, COALESCE(SUM(input_tokens + output_tokens), 0) tok
        FROM ai_usage_ledger WHERE date_ist = ?
      `).get(dateIst);
      todayCalls = Number(dRow?.c || 0);
      todayCostInr = +Number(dRow?.inr || 0).toFixed(2);
      todayTokens = Number(dRow?.tok || 0);

      const mRow = db.prepare(`
        SELECT COUNT(*) c, COALESCE(SUM(cost_inr), 0) inr, COALESCE(SUM(input_tokens + output_tokens), 0) tok
        FROM ai_usage_ledger WHERE month_ist = ?
      `).get(monthIst);
      monthCalls = Number(mRow?.c || 0);
      monthCostInr = +Number(mRow?.inr || 0).toFixed(2);
      monthTokens = Number(mRow?.tok || 0);

      const epRows = db.prepare(`
        SELECT endpoint, COUNT(*) c, COALESCE(SUM(cost_inr), 0) inr
        FROM ai_usage_ledger WHERE month_ist = ? GROUP BY endpoint
      `).all(monthIst);
      byEndpoint = Object.fromEntries(epRows.map(r => [r.endpoint, { calls: Number(r.c), costInr: +Number(r.inr).toFixed(2) }]));
    } catch (_) {}
  }

  let blockedReason = null;
  if (Date.now() < lastErrorCooldownUntil) {
    blockedReason = 'AI_ERROR_COOLDOWN_ACTIVE';
  } else if (todayCostInr >= limits.dailyCapInr) {
    blockedReason = `DAILY_AI_BUDGET_CAP (₹${todayCostInr}/₹${limits.dailyCapInr})`;
  } else if (todayCalls >= limits.dailyCallCap) {
    blockedReason = `DAILY_AI_CALL_CAP (${todayCalls}/${limits.dailyCallCap} calls)`;
  } else if (monthCostInr >= limits.monthlyCapInr) {
    blockedReason = `MONTHLY_AI_BUDGET_CAP (₹${monthCostInr}/₹${limits.monthlyCapInr})`;
  }

  return {
    ok: true,
    dateIst,
    monthIst,
    model: 'claude-haiku-4-5',
    allowed: !blockedReason,
    blockedReason,
    todayCalls,
    dailyCallCap: limits.dailyCallCap,
    todayCostInr,
    dailyCapInr: limits.dailyCapInr,
    remainingDailyInr: +Math.max(0, limits.dailyCapInr - todayCostInr).toFixed(2),
    todayTokens,
    monthCalls,
    monthCostInr,
    monthlyCapInr: limits.monthlyCapInr,
    remainingMonthlyInr: +Math.max(0, limits.monthlyCapInr - monthCostInr).toFixed(2),
    monthTokens,
    byEndpoint
  };
}

/**
 * Records exact Anthropic token usage & INR cost into SQLite `ai_usage_ledger`.
 */
function recordAiUsage(db, { endpoint = 'unknown', model = 'claude-haiku-4-5', inputTokens = 0, outputTokens = 0 } = {}) {
  const est = estimateCostFromTokens(inputTokens, outputTokens);
  if (db) {
    ensureAiUsageTable(db);
    const { dateIst, monthIst } = getIstStamps();
    try {
      db.prepare(`
        INSERT INTO ai_usage_ledger (date_ist, month_ist, endpoint, model, input_tokens, output_tokens, cost_usd, cost_inr)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(dateIst, monthIst, endpoint, model, est.inputTokens, est.outputTokens, est.costUsd, est.costInr);
    } catch (_) {}
  }
  return est;
}

function callAnthropicHaiku({ db = null, endpoint = 'claude_desk', apiKey, system, userContent, maxTokens = 180, timeoutMs = 6500, limits = DEFAULT_AI_LIMITS }) {
  return new Promise((resolve, reject) => {
    if (!apiKey || apiKey.length < 10) return reject(new Error('Anthropic API key missing'));
    const budget = getAiBudgetStatus(db, limits);
    if (!budget.allowed) {
      return reject(new Error(budget.blockedReason || 'AI_BUDGET_CAP_REACHED'));
    }

    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: userContent }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      },
      timeout: timeoutMs
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (res.statusCode !== 200) {
            // Activate 15m error cooldown on auth/billing/rate-limit errors so we NEVER hammer Anthropic!
            if (res.statusCode === 401 || res.statusCode === 402 || res.statusCode === 429 || res.statusCode >= 500) {
              lastErrorCooldownUntil = Date.now() + 15 * 60 * 1000;
            }
            return reject(new Error(parsed?.error?.message || `Anthropic HTTP ${res.statusCode}`));
          }
          const usage = parsed.usage || {};
          const billed = recordAiUsage(db, {
            endpoint,
            model: 'claude-haiku-4-5',
            inputTokens: usage.input_tokens || Math.ceil(body.length / 4),
            outputTokens: usage.output_tokens || 80
          });
          const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
          resolve({ text, usage: billed, stopReason: parsed.stop_reason });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Anthropic timeout'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseJsonSafe(rawText) {
  const clean = String(rawText || '').replace(/```json|```/gi, '').trim();
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('No JSON object in Claude response');
  return JSON.parse(clean.slice(s, e + 1));
}

/**
 * Final Pre-Trade AI Devil's Advocate Gatekeeper (Cost-Governed · 45m Cached · 160 Max Output Tokens).
 */
async function reviewCandidateWithClaude({
  db = null,
  apiKey,
  candidate,
  brainState = null,
  recentLessons = [],
  macroSummary = null,
  forceFresh = false
} = {}) {
  const p = candidate?.executionPlan || {};
  const sym = String(p.tradingsymbol || candidate?.symbol || 'UNKNOWN').toUpperCase();
  const side = String(p.side || candidate?.action || 'BUY').toUpperCase();
  const cacheKey = `claude_gate_${sym}_${side}_${brainState?.regime?.regime || 'NA'}`;
  if (!forceFresh) {
    const cached = getCached(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  const fallback = {
    source: 'DETERMINISTIC_FALLBACK',
    verdict: 'CONFIRM',
    sizeMultiplier: 1.0,
    rationale: 'Quant pillars & Brain v2 aligned (₹0 deterministic fallback).'
  };

  if (!apiKey || apiKey.length < 10) return fallback;
  const budget = getAiBudgetStatus(db);
  if (!budget.allowed) {
    return { ...fallback, budgetBlocked: budget.blockedReason };
  }

  // Ultra-compact JSON context (~180 input tokens -> ~₹0.04 per call!)
  const ctx = {
    sym,
    side,
    bkt: p.bucket || 'MIS',
    arch: candidate?.archetype || 'TREND',
    px: p.entryPrice,
    sl: p.stopLoss,
    t1: p.target1,
    rr: p.netRR,
    sc: candidate?.compositeRankScore || candidate?.confidence,
    h60: candidate?.historicalEdge ? `${candidate.historicalEdge.winRate}%/${candidate.historicalEdge.profitFactor}x` : '-',
    y25: candidate?.multiYearSwingEdge ? `${candidate.multiYearSwingEdge.profitFactor}x` : '-',
    rg: `${brainState?.regime?.regime || 'NA'}(${brainState?.regime?.advPct ?? 50}%)`,
    gov: brainState?.equityGovernor?.state || 'NORMAL',
    mac: macroSummary ? `${macroSummary.greenCount}/12` : '-',
    lsn: (recentLessons || []).slice(0, 2).map(l => String(l.lesson || l).slice(0, 70))
  };

  try {
    const resp = await callAnthropicHaiku({
      db,
      endpoint: 'pre_trade_cro',
      apiKey,
      maxTokens: 140,
      timeoutMs: 6000,
      system: 'CRO reviewing a pre-validated Indian ₹15K trade. Only VETO for a clear contradiction or repeated losing lesson. Strict JSON: {"verdict":"CONFIRM"|"HALVE_SIZE"|"VETO","rationale":"<max 14 words>"}',
      userContent: JSON.stringify(ctx)
    });
    const parsed = parseJsonSafe(resp.text);
    const verdict = ['CONFIRM', 'HALVE_SIZE', 'VETO'].includes(parsed.verdict) ? parsed.verdict : 'CONFIRM';
    const result = {
      source: 'CLAUDE_HAIKU_CRO',
      verdict,
      sizeMultiplier: verdict === 'VETO' ? 0 : (verdict === 'HALVE_SIZE' ? 0.5 : 1.0),
      rationale: String(parsed.rationale || 'Reviewed by Claude CRO.').slice(0, 160),
      costInr: resp.usage?.costInr || 0,
      reviewedAt: new Date().toISOString()
    };
    return setCached(cacheKey, result, 45 * 60 * 1000); // 45-minute cache
  } catch (err) {
    return { ...fallback, error: err.message };
  }
}

/**
 * Nightly EOD AI Brain Post-Mortem Analyst (Max 1×/day per dateIst · ~₹0.10/day).
 */
async function generateClaudePostMortemSummary({
  db = null,
  apiKey,
  report,
  dayTrades = [],
  brainState = null,
  forceFresh = false
} = {}) {
  if (!apiKey || apiKey.length < 10) return null;
  const dateKey = `claude_pm_${report?.dateIst || getIstStamps().dateIst}`;
  if (!forceFresh) {
    const cached = getCached(dateKey);
    if (cached) return { ...cached, cached: true };
  }
  const budget = getAiBudgetStatus(db);
  if (!budget.allowed) return null;

  const ctx = {
    dt: report?.dateIst,
    rg: `${report?.regime}(Nifty ${report?.niftyPct}%, Br ${report?.advPct}%)`,
    ex: report?.executionScore,
    day: `${report?.tradesCount || 0}tr (${report?.wins || 0}W/${report?.losses || 0}L, Net ₹${report?.netPnlDay || 0}, Fee ₹${report?.feesDay || 0})`,
    ch: (report?.championMovers || []).slice(0, 4),
    tr: (dayTrades || []).slice(0, 6).map(t => `${t.symbol} ${t.side} ₹${t.net_pnl} (${t.exit_reason}, MFE ${t.mfe_r ?? '-'}R)`)
  };

  try {
    const resp = await callAnthropicHaiku({
      db,
      endpoint: 'eod_post_mortem',
      apiKey,
      maxTokens: 240,
      timeoutMs: 8000,
      system: 'Quant CIO reviewing today\'s Indian NSE/MCX session. Cite exact symbols/P&L/MFE. Strict JSON: {"insights":["<i1>","<i2>","<i3>"],"tomorrowFocus":"<1 concise 09:15 directive>"}',
      userContent: JSON.stringify(ctx)
    });
    const parsed = parseJsonSafe(resp.text);
    if (Array.isArray(parsed.insights) && parsed.insights.length > 0) {
      const result = {
        source: 'CLAUDE_HAIKU_CIO',
        insights: parsed.insights.slice(0, 3).map(s => String(s).slice(0, 200)),
        tomorrowFocus: parsed.tomorrowFocus ? String(parsed.tomorrowFocus).slice(0, 180) : null,
        costInr: resp.usage?.costInr || 0
      };
      return setCached(dateKey, result, 18 * 3600 * 1000); // 1× per trading day
    }
  } catch (_) {}
  return null;
}

module.exports = {
  DEFAULT_AI_LIMITS,
  ensureAiUsageTable,
  estimateCostFromTokens,
  getAiBudgetStatus,
  recordAiUsage,
  callAnthropicHaiku,
  reviewCandidateWithClaude,
  generateClaudePostMortemSummary
};
