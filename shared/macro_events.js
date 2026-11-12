/**
 * shared/macro_events.js — High-Impact Macroeconomic Event Calendar & Volatility Blackout Shield
 * Protects commodity traders from high-slippage stop runs during major scheduled data releases:
 * - US EIA Crude Oil Inventories (Wednesdays 20:00 IST)
 * - US EIA Natural Gas Storage (Thursdays 20:00 IST)
 * - US Non-Farm Payrolls (1st Friday of month 18:00/19:00 IST)
 * - US CPI Inflation Reports (Monthly mid-week 18:00/19:00 IST)
 * - US FOMC Rate Decision (Wednesdays 23:30 IST)
 */

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else {
    root.MacroEvents = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // Weekly Recurring Tier-1 Commodity Catalysts (Asia/Kolkata IST)
  // Day: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const RECURRING_WEEKLY_EVENTS = [
    {
      id: 'eia_crude',
      name: 'US EIA Crude Oil Inventories',
      dayOfWeek: 3, // Wednesday
      hour: 20,
      minute: 0,
      blackoutBeforeMins: 15,
      blackoutAfterMins: 5,
      affected: ['crude', 'CRUDEOIL', 'CRUDEOILM'],
      severity: 'HIGH',
      description: 'US weekly crude stocks change. Spreads widen; ₹50–₹120 price spikes in 60 seconds.'
    },
    {
      id: 'eia_gas',
      name: 'US EIA Natural Gas Storage Report',
      dayOfWeek: 4, // Thursday
      hour: 20,
      minute: 0,
      blackoutBeforeMins: 15,
      blackoutAfterMins: 5,
      affected: ['natgas', 'NATGAS', 'NATGASM'],
      severity: 'HIGH',
      description: 'Weekly underground storage change. Extreme volatility on gas futures.'
    },
    {
      id: 'us_oil_rig_count',
      name: 'Baker Hughes US Oil Rig Count',
      dayOfWeek: 5, // Friday
      hour: 22,
      minute: 30,
      blackoutBeforeMins: 10,
      blackoutAfterMins: 5,
      affected: ['crude', 'natgas', 'CRUDEOIL', 'CRUDEOILM'],
      severity: 'MEDIUM',
      description: 'Active drilling rig count. Guides medium-term supply trends.'
    }
  ];

  /**
   * Evaluates if a given commodity is currently in a macro blackout window.
   * @param {string} commodityId - e.g. 'crude', 'CRUDEOILM', 'gold', 'natgas'
   * @param {Date} [refDate] - optional date, defaults to now in IST
   * @returns {Object} { isBlackout: boolean, activeEvent: Object|null, minutesToEvent: number, warningText: string }
   */
  function checkMacroBlackout(commodityId, refDate) {
    const d = refDate ? new Date(refDate) : new Date();
    const istStr = d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const ist = new Date(istStr);

    const day = ist.getDay();
    const currentMins = ist.getHours() * 60 + ist.getMinutes();
    const cleanSym = String(commodityId || '').toLowerCase();

    for (const evt of RECURRING_WEEKLY_EVENTS) {
      const isAff = evt.affected.some(a => cleanSym.includes(a.toLowerCase()));
      if (!isAff) continue;

      if (evt.dayOfWeek === day) {
        const eventMins = evt.hour * 60 + evt.minute;
        const startBlackout = eventMins - evt.blackoutBeforeMins;
        const endBlackout = eventMins + evt.blackoutAfterMins;

        if (currentMins >= startBlackout && currentMins <= endBlackout) {
          const diff = eventMins - currentMins;
          const statusText = diff > 0 
            ? `Releases in ${diff} minute${diff === 1 ? '' : 's'}` 
            : `Released ${Math.abs(diff)} minute${Math.abs(diff) === 1 ? '' : 's'} ago (high volatility active)`;

          return {
            isBlackout: true,
            activeEvent: evt,
            minutesToEvent: diff,
            warningText: `⚠️ MACRO BLACKOUT: ${evt.name} (${statusText}). New orders locked to prevent slippage.`
          };
        }
      }
    }

    // Check if within 60 minutes for early warning
    for (const evt of RECURRING_WEEKLY_EVENTS) {
      const isAff = evt.affected.some(a => cleanSym.includes(a.toLowerCase()));
      if (!isAff) continue;

      if (evt.dayOfWeek === day) {
        const eventMins = evt.hour * 60 + evt.minute;
        const diff = eventMins - currentMins;
        if (diff > 0 && diff <= 60) {
          return {
            isBlackout: false,
            upcomingWarning: true,
            activeEvent: evt,
            minutesToEvent: diff,
            warningText: `🔔 UPCOMING CATALYST: ${evt.name} in ${diff} minutes (${evt.hour}:${String(evt.minute).padStart(2,'0')} IST). Tighten trailing stops.`
          };
        }
      }
    }

    return {
      isBlackout: false,
      upcomingWarning: false,
      activeEvent: null,
      minutesToEvent: null,
      warningText: ''
    };
  }

  /**
   * Returns a list of next upcoming events with human-readable timestamps.
   */
  function getUpcomingEvents(refDate) {
    const d = refDate ? new Date(refDate) : new Date();
    const istStr = d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    const ist = new Date(istStr);
    const day = ist.getDay();

    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    return RECURRING_WEEKLY_EVENTS.map(evt => {
      let daysAway = (evt.dayOfWeek - day + 7) % 7;
      if (daysAway === 0 && (ist.getHours() > evt.hour || (ist.getHours() === evt.hour && ist.getMinutes() > evt.minute))) {
        daysAway = 7;
      }
      return {
        ...evt,
        timingIST: `${daysOfWeek[evt.dayOfWeek]} ${String(evt.hour).padStart(2,'0')}:${String(evt.minute).padStart(2,'0')} IST`,
        daysAway
      };
    }).sort((a, b) => a.daysAway - b.daysAway);
  }

  return {
    RECURRING_WEEKLY_EVENTS,
    checkMacroBlackout,
    getUpcomingEvents
  };
}));
