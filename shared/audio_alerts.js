/**
 * shared/audio_alerts.js — Synthesized Web Audio Chimes & Desktop Notifications
 * Zero external mp3 dependencies. Uses browser AudioContext to synthesize
 * distinct, pleasant musical alerts for BUY, SELL, and Risk Warning events.
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.AudioAlerts = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  let audioCtx = null;

  function getAudioContext() {
    if (typeof window === 'undefined') return null;
    if (!audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        audioCtx = new AudioContext();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function isAudioEnabled() {
    if (typeof localStorage === 'undefined') return true;
    const setting = localStorage.getItem('mcx_audio_enabled');
    return setting !== 'false'; // Enabled by default
  }

  function setAudioEnabled(enabled) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('mcx_audio_enabled', enabled ? 'true' : 'false');
    }
  }

  /**
   * Unlock AudioContext on first user interaction so background auto-trade
   * profit/loss alerts always play reliably in Chrome/Safari.
   */
  function unlockAudio() {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const _unlockOnce = () => {
      unlockAudio();
      window.removeEventListener('pointerdown', _unlockOnce);
      window.removeEventListener('keydown', _unlockOnce);
    };
    window.addEventListener('pointerdown', _unlockOnce, { passive: true });
    window.addEventListener('keydown', _unlockOnce, { passive: true });
  }

  function toggleMute() {
    const nextEnabled = !isAudioEnabled();
    setAudioEnabled(nextEnabled);
    return !nextEnabled; // returns isMuted
  }

  function requestDesktopPermission() {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }

  /**
   * Synthesize a tone with exponential volume decay.
   */
  function playTone(freq, startTime, duration, type = 'sine', gainVal = 0.15) {
    const ctx = getAudioContext();
    if (!ctx) return;

    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(gainVal, startTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + duration);
    } catch (_) {}
  }

  /**
   * Dedicated PROFIT Sound:
   * Bright ascending major-chord bell chime (C5 -> E5 -> G5 -> sparkling C6).
   */
  function playProfitSound() {
    if (!isAudioEnabled()) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    playTone(523.25, now, 0.16, 'sine', 0.22);          // C5
    playTone(659.25, now + 0.09, 0.18, 'sine', 0.24);   // E5
    playTone(783.99, now + 0.18, 0.22, 'triangle', 0.26); // G5
    playTone(1046.50, now + 0.27, 0.55, 'sine', 0.28);  // C6 bright bell
    playTone(2093.00, now + 0.27, 0.35, 'sine', 0.08);  // C7 shimmer overtone
  }

  /**
   * Dedicated LOSS Beep Sound:
   * Clear, unmistakable double low warning beep (330Hz -> 220Hz).
   */
  function playLossBeep() {
    if (!isAudioEnabled()) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    // First crisp beep
    playTone(330.00, now, 0.15, 'square', 0.14);
    playTone(330.00, now, 0.15, 'triangle', 0.18);
    // Second lower beep after brief pause
    playTone(220.00, now + 0.21, 0.28, 'square', 0.14);
    playTone(220.00, now + 0.21, 0.28, 'triangle', 0.20);
  }

  function playAlertTone() {
    playProfitSound();
  }

  /**
   * Plays harmonic chime for trade signals:
   * BUY: Rising arpeggio (C5 -> E5 -> G5)
   * SELL: Falling arpeggio (G5 -> E5 -> C5)
   */
  function playSignalChime(side = 'BUY') {
    if (!isAudioEnabled()) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const isBuy = String(side).toUpperCase() === 'BUY';

    if (isBuy) {
      // Rising triad
      playTone(523.25, now, 0.18, 'sine', 0.20);        // C5
      playTone(659.25, now + 0.12, 0.20, 'sine', 0.22); // E5
      playTone(783.99, now + 0.24, 0.40, 'triangle', 0.25); // G5
    } else {
      // Falling triad
      playTone(783.99, now, 0.18, 'sine', 0.20);        // G5
      playTone(659.25, now + 0.12, 0.20, 'sine', 0.22); // E5
      playTone(523.25, now + 0.24, 0.40, 'triangle', 0.25); // C5
    }
  }

  /**
   * Warning chime for Risk Violations, Macro Blackouts, or Circuit Breaker alerts.
   */
  function playWarningChime() {
    if (!isAudioEnabled()) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    playTone(440.00, now, 0.15, 'triangle', 0.25);        // A4
    playTone(349.23, now + 0.16, 0.35, 'sawtooth', 0.15); // F4
  }

  /**
   * Desktop system notification helper.
   */
  function notifyDesktop(title, body, tag = 'mcx-signal') {
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      try {
        new Notification(title, { body, tag });
      } catch (_) {}
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(permission => {
        if (permission === 'granted') {
          new Notification(title, { body, tag });
        }
      });
    }
  }

  return {
    playProfitSound,
    playLossBeep,
    playSignalChime,
    playWarningChime,
    playAlertTone,
    toggleMute,
    unlockAudio,
    requestDesktopPermission,
    isAudioEnabled,
    setAudioEnabled,
    notifyDesktop
  };
}));
