/**
 * shared/claude_desk.js — Unified Claude AI Institutional Risk Desk & EOD Brain Analyst
 *
 * Bridges Anthropic Claude (`claude-haiku-4-5`) safely into the autonomous trading loop:
 *   1. Pre-Trade AI Risk-Desk Gatekeeper (`reviewCandidateWithClaude`):
 *      Called ONLY on candidates that have already passed all 6 deterministic quant pillars.
 *      Synthesizes live setup + Brain v2 Regime + 12-Pillar Macro + recent SQLite `trade_lessons`
 *      and returns { verdict: 'CONFIRM' | 'HALVE_SIZE' | 'VETO', sizeMultiplier, rationale }.
 *      15-minute cache per symbol+side & 6s hard timeout with clean deterministic fallback.
 *   2. Nightly EOD AI Post-Mortem Analyst (`generateClaudePostMortemSummary`):
 *      Reads today's real closed trades, MFE/MAE R-multiples, fee drag, Brain regime, and
 *      All-Weather / Champion movers to produce 3 sharp institutional coaching takeaways.
 */
const https = require('https');

const deskCache = new Map();

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

function callAnthropicHaiku({ apiKey, system, userContent, maxTokens = 320, timeoutMs = 6500 }) {
  return new Promise((resolve, reject) => {
    if (!apiKey || apiKey.length < 10) return reject(new Error('Anthropic API key missing'));
    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: maxTokens,
      system,
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
            return reject(new Error(parsed?.error?.message || `Anthropic HTTP ${res.statusCode}`));
          }
          const text = (parsed.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
          resolve(text);
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
 * Final Pre-Trade AI Devil's Advocate Gatekeeper.
 * Never invents prices; strictly evaluates qualitative risk alignment & lesson avoidance.
 */
async function reviewCandidateWithClaude({
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
    rationale: 'Quant pillars & Brain v2 aligned (Claude fallback).'
  };

  if (!apiKey || apiKey.length < 10) return fallback;

  const ctx = {
    symbol: sym,
    side,
    bucket: p.bucket || 'MIS_INTRADAY',
    archetype: candidate?.archetype || 'TREND_RUNNER',
    entry: p.entryPrice,
    sl: p.stopLoss,
    target1: p.target1,
    netRR: p.netRR,
    score: candidate?.compositeRankScore || candidate?.confidence,
    hist60d: candidate?.historicalEdge ? `${candidate.historicalEdge.winRate}% WR, PF ${candidate.historicalEdge.profitFactor}x` : 'n/a',
    swing2_5y: candidate?.multiYearSwingEdge ? `PF ${candidate.multiYearSwingEdge.profitFactor}x, proven=${candidate.multiYearSwingEdge.provenEdge}` : 'n/a',
    nseFlow: candidate?.nseMcp?.summary || 'n/a',
    brainRegime: brainState?.regime?.regime || 'UNKNOWN',
    liveBreadthPct: brainState?.regime?.advPct ?? null,
    equityGovernor: brainState?.equityGovernor?.state || 'NORMAL',
    macroVerdict: macroSummary ? `${macroSummary.verdict} (${macroSummary.greenCount}/12 green)` : 'n/a',
    pastLessons: (recentLessons || []).slice(0, 4).map(l => l.lesson || String(l))
  };

  try {
    const text = await callAnthropicHaiku({
      apiKey,
      maxTokens: 220,
      timeoutMs: 6000,
      system: 'You are an institutional Chief Risk Officer reviewing a pre-validated Indian NSE/MCX trade setup on a ₹15,000 account. All technical & fee gates already passed. Only VETO if there is a glaring qualitative contradiction, severe chasing risk, or direct repeat of a past losing lesson. Respond ONLY with strict JSON: {"verdict":"CONFIRM"|"HALVE_SIZE"|"VETO","rationale":"<max 18 words>"}',
      userContent: JSON.stringify(ctx)
    });
    const parsed = parseJsonSafe(text);
    const verdict = ['CONFIRM', 'HALVE_SIZE', 'VETO'].includes(parsed.verdict) ? parsed.verdict : 'CONFIRM';
    const result = {
      source: 'CLAUDE_HAIKU_CRO',
      verdict,
      sizeMultiplier: verdict === 'VETO' ? 0 : (verdict === 'HALVE_SIZE' ? 0.5 : 1.0),
      rationale: String(parsed.rationale || 'Reviewed by Claude Risk Desk.').slice(0, 180),
      reviewedAt: new Date().toISOString()
    };
    return setCached(cacheKey, result, 15 * 60 * 1000);
  } catch (err) {
    return { ...fallback, error: err.message };
  }
}

/**
 * Nightly EOD AI Brain Post-Mortem Analyst (16:30 IST or on-demand).
 * Produces 3 crisp, evidence-backed executive insights from real SQLite trade/MFE/MAE telemetry.
 */
async function generateClaudePostMortemSummary({
  apiKey,
  report,
  dayTrades = [],
  brainState = null
} = {}) {
  if (!apiKey || apiKey.length < 10) return null;

  const ctx = {
    dateIst: report?.dateIst,
    regime: report?.regime,
    niftyPct: report?.niftyPct,
    liveBreadthPct: report?.advPct,
    executionScore: report?.executionScore,
    daySummary: `${report?.tradesCount || 0} trades (${report?.wins || 0}W/${report?.losses || 0}L, Net ₹${report?.netPnlDay || 0}, Fees ₹${report?.feesDay || 0})`,
    championMovers: report?.championMovers || [],
    equityGovernor: brainState?.equityGovernor?.state || 'NORMAL',
    trades: (dayTrades || []).slice(0, 8).map(t => ({
      sym: t.symbol,
      side: t.side,
      pnl: t.net_pnl,
      reason: t.exit_reason,
      mfeR: t.mfe_r,
      maeR: t.mae_r
    }))
  };

  try {
    const text = await callAnthropicHaiku({
      apiKey,
      maxTokens: 320,
      timeoutMs: 8000,
      system: 'You are a Quantitative Chief Investment Officer reviewing today\'s Indian NSE/MCX paper-trading session. Be blunt, data-driven, and specific using the exact symbols, MFE/MAE R-multiples, and P&L provided. Respond ONLY with strict JSON: {"insights":["<insight 1>","<insight 2>","<insight 3>"],"tomorrowFocus":"<1 concise directive for 09:15 IST open>"}',
      userContent: JSON.stringify(ctx)
    });
    const parsed = parseJsonSafe(text);
    if (Array.isArray(parsed.insights) && parsed.insights.length > 0) {
      return {
        source: 'CLAUDE_HAIKU_CIO',
        insights: parsed.insights.slice(0, 3).map(s => String(s).slice(0, 220)),
        tomorrowFocus: parsed.tomorrowFocus ? String(parsed.tomorrowFocus).slice(0, 200) : null
      };
    }
  } catch (_) {}
  return null;
}

module.exports = {
  reviewCandidateWithClaude,
  generateClaudePostMortemSummary
};
