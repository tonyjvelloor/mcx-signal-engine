/**
 * background.js — Polls local MCX Signal Engine (http://127.0.0.1:8000/api/olymp/live-ticket)
 * and broadcasts the latest Olymp Trade USD plan to open olymptrade.com tabs.
 */

const TICKET_URL = 'http://127.0.0.1:8000/api/olymp/live-ticket';

async function pollLocalEngine() {
  try {
    const res = await fetch(TICKET_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const ticket = await res.json();
    await chrome.storage.local.set({ latestTicket: ticket, lastPollOk: true, lastPollAt: Date.now() });

    const tabs = await chrome.tabs.query({ url: 'https://*.olymptrade.com/*' });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'MCX_TICKET_UPDATE', ticket }).catch(() => {});
      }
    }
  } catch (err) {
    await chrome.storage.local.set({ lastPollOk: false, lastError: err.message });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('mcxPollAlarm', { periodInMinutes: 0.1 }); // ~6s poll
  pollLocalEngine();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mcxPollAlarm') {
    pollLocalEngine();
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'MCX_FORCE_POLL') {
    pollLocalEngine().then(() => sendResponse({ ok: true }));
    return true;
  }
});
