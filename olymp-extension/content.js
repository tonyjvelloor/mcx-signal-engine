/**
 * content.js — Floating Demo-First Semi-Auto Co-Pilot HUD for Olymp Trade.
 * Displays live pair, Bull/Bear Debate verdict, safe Multiplier & Auto-Close SL/TP %,
 * FTT 15m-30m expiry, 5m candle countdown, and a safe 1-click "Auto-Fill Stake" button.
 * NEVER clicks Buy/Sell/Up/Down unattended (protects account from anti-bot bans & bugs).
 */

(function () {
  if (window.__mcxOlympHudMounted) return;
  window.__mcxOlympHudMounted = true;

  const hud = document.createElement('div');
  hud.id = 'mcx-olymp-copilot-hud';
  hud.style.cssText = [
    'position:fixed',
    'bottom:16px',
    'right:16px',
    'width:320px',
    'background:#0E0E14',
    'color:#D8D6E8',
    'border:1px solid rgba(245,197,66,0.4)',
    'border-radius:10px',
    'padding:12px',
    'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
    'font-size:11px',
    'line-height:1.5',
    'z-index:2147483647',
    'box-shadow:0 12px 32px rgba(0,0,0,0.65)'
  ].join(';');

  hud.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:6px;margin-bottom:8px">
      <strong style="color:#F5C542">🌐 MCX → OLYMP CO-PILOT</strong>
      <div style="display:flex;gap:5px;align-items:center">
        <span id="mcx-hud-status" style="font-size:9px;color:#6A6880">SYNCING...</span>
        <button id="mcx-hud-min" style="background:transparent;border:1px solid rgba(255,255,255,0.15);color:#D8D6E8;border-radius:4px;padding:1px 6px;cursor:pointer;font-size:10px">−</button>
      </div>
    </div>
    <div id="mcx-hud-body" style="color:#6A6880">Waiting for http://127.0.0.1:8000/mcx-beginner.html...</div>
  `;
  document.body.appendChild(hud);

  let minimized = false;
  document.getElementById('mcx-hud-min').addEventListener('click', () => {
    minimized = !minimized;
    document.getElementById('mcx-hud-body').style.display = minimized ? 'none' : 'block';
    document.getElementById('mcx-hud-min').textContent = minimized ? '+' : '−';
  });

  function isDemoAccountVisible() {
    const txt = (document.body.innerText || '').toUpperCase();
    return txt.includes('DEMO ACCOUNT') || txt.includes('DEMO') || txt.includes('Đ');
  }

  function autoFillStake(stakeUsd) {
    const isDemo = isDemoAccountVisible();
    if (!isDemo) {
      const ok = confirm(`⚠️ LIVE ACCOUNT DETECTED!\nAuto-fill $${stakeUsd} stake? (Cancel to switch to Demo first)`);
      if (!ok) return;
    }
    const candidates = [
      'input[data-test="deal-amount-input"]',
      'input[name="amount"]',
      'input[inputmode="decimal"]',
      'input[type="number"]'
    ];
    let targetInput = null;
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        targetInput = el;
        break;
      }
    }
    if (!targetInput) {
      alert(`Could not locate Olymp Trade amount box automatically. Enter $${stakeUsd} manually.`);
      return;
    }
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(targetInput, String(stakeUsd));
    else targetInput.value = String(stakeUsd);
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
    targetInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function renderTicket(t) {
    const stEl = document.getElementById('mcx-hud-status');
    const bodyEl = document.getElementById('mcx-hud-body');
    if (!bodyEl) return;

    if (!t || !t.ok) {
      if (stEl) { stEl.textContent = 'WAITING'; stEl.style.color = '#F59E0B'; }
      bodyEl.innerHTML = `<div style="color:#6A6880">Open <strong>http://127.0.0.1:8000/mcx-beginner.html</strong> to stream live USD plans.</div>`;
      return;
    }

    if (stEl) {
      stEl.textContent = isDemoAccountVisible() ? 'DEMO SAFE' : 'LIVE ACCT';
      stEl.style.color = isDemoAccountVisible() ? '#22C55E' : '#EF4444';
    }

    const actCol = t.action === 'BUY' ? '#22C55E' : t.action === 'SELL' ? '#EF4444' : '#6A6880';
    const isBlocked = Boolean(t.blockedReason || t.usdCircuitTripped || String(t.debateVerdict || '').includes('VETO'));
    const stake = t.olympMultiplier?.stakeUsd || t.sizing?.stake2Pct || 2;

    bodyEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:5px">
        <span>Pair: <strong style="color:#F5C542">${t.pair}</strong></span>
        <span>Signal: <strong style="color:${actCol}">${t.action} (${t.confidence || 0}%)</strong></span>
      </div>
      <div style="background:#14141C;padding:6px 8px;border-radius:6px;margin-bottom:6px">
        <div>Mode: <strong style="color:#06B6D4">${t.recommendedMode || 'WAIT'}</strong></div>
        <div>Debate: <strong style="color:${isBlocked ? '#EF4444' : '#22C55E'}">${t.debateVerdict || 'STANDBY'}</strong></div>
        <div>Multiplier: <strong style="color:#D8D6E8">${t.olympMultiplier?.summary || '—'}</strong></div>
        <div>FTT: <strong style="color:#D8D6E8">${t.fttMode?.direction || 'HOLD'} · ${t.fttMode?.recommendedExpiry || '—'}</strong></div>
      </div>
      <div style="color:#F59E0B;font-size:10px;margin-bottom:7px">⏱ 5m Candle: <strong>${t.entryTiming?.countdownFormatted || '—'}</strong> · Losses: ${t.usdConsecLosses || 0}/2</div>
      ${isBlocked
        ? `<div style="background:rgba(239,68,68,0.12);border:1px solid #EF4444;color:#EF4444;padding:5px 7px;border-radius:5px;font-size:10px">🛑 LOCKED: ${t.blockedReason || 'VETO / Circuit Breaker'}</div>`
        : `<button id="mcx-autofill-btn" style="width:100%;background:rgba(34,197,94,0.15);border:1px solid #22C55E;color:#22C55E;border-radius:6px;padding:6px;font-family:inherit;font-weight:700;cursor:pointer">⚡ Auto-Fill $${stake} Stake (Human Confirm Click)</button>`
      }
    `;

    const fillBtn = document.getElementById('mcx-autofill-btn');
    if (fillBtn) {
      fillBtn.addEventListener('click', () => autoFillStake(stake));
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'MCX_TICKET_UPDATE') {
      renderTicket(msg.ticket);
    }
  });

  chrome.storage.local.get(['latestTicket'], (res) => {
    if (res && res.latestTicket) renderTicket(res.latestTicket);
  });
  chrome.runtime.sendMessage({ type: 'MCX_FORCE_POLL' }).catch(() => {});
})();
