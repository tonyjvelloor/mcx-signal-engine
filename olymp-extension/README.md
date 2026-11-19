# MCX Desk — Olymp Trade Semi-Auto Co-Pilot Extension (Manifest V3)

This Chrome/Edge extension bridges your local **MCX Signal Engine** (`http://127.0.0.1:8000`) directly onto `https://olymptrade.com` as a floating **Demo-First Co-Pilot HUD**.

## Safety Design
- **No unattended auto-clicking**: Pre-fills your exact `1%–2%` USD stake and displays live **Multiplier + Auto-Close SL/TP %**, **FTT 15m–30m expiry**, **5m candle countdown**, and **Bull/Bear Debate Verdict** while keeping the final Buy/Sell click human-confirmed (avoids anti-bot bans and misfires).
- **Demo Account Guard**: Flags live accounts before auto-filling and locks execution whenever your **2-loss / 4% USD circuit breaker** or **Devil's Advocate `VETO`** triggers.

## Install in 3 Steps (Chrome / Brave / Edge)
1. Start your local engine:
   ```bash
   cd /Users/tonyvelloor/mcx-signal-engine && node server.js
   ```
   and keep [`http://127.0.0.1:8000/mcx-beginner.html`](http://127.0.0.1:8000/mcx-beginner.html) open.
2. Open `chrome://extensions` in your browser and enable **Developer mode** (top right).
3. Click **Load unpacked** and select `/Users/tonyvelloor/mcx-signal-engine/olymp-extension`.
4. Open `https://olymptrade.com` — the floating **MCX → OLYMP CO-PILOT** HUD appears automatically in the bottom-right corner.
