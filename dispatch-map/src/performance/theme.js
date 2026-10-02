// src/performance/theme.js — the Performance screen's colours, by the job each one does.
//
// LIGHT, LIKE THE REST OF THE APP (v1.104.1). Chad, on the dark version: "I don't love the dark
// theme of the page." It first shipped dark because his brief asked for a restrained dark surface;
// it now wears the app's own slate-on-white, with the same hues one step darker so they hold up on
// white. Monospace for raw numbers and times, and accents used sparingly, are kept.
//
// EVERY DATA COLOUR BELOW WAS RUN THROUGH THE PALETTE VALIDATOR (dataviz validate_palette.js,
// light mode, against SURFACE #ffffff), not picked by eye:
//
//   pace lines  today #6457d9 · overlay #d95926 · overlay #199e70
//               ALL-PAIRS (lines cross, so any two can sit side by side): worst CVD ΔE 9.4,
//               normal-vision ΔE 26.5, every line ≥ 3:1 on the surface. Today is the dark
//               version's violet one step darker; the overlays are unchanged — they pass on both.
//   status      good #059669 · warning #d97706 · critical #e11d48 (emerald 600 / amber 600 / rose 600)
//               adjacent in the outcome meter: CVD ΔE 7.9 — inside the 6–8 floor, which is legal
//               ONLY with secondary encoding, and the meter has it: 2px gaps between segments and a
//               label, count and share beside every swatch. Normal-vision 16.6, all ≥ 3:1.
//               Always drawn with an icon and a label — never colour alone.
//
// Text never wears a data colour (dataviz: "text wears text tokens"): values and labels are
// INK / INK_2; a coloured dot or line key beside them carries identity.

export const C = {
  page: '#f8fafc',        // slate-50 — the app's page grey
  surface: '#ffffff',     // white — the chart surface the palette was validated on
  hairline: '#e2e8f0',    // slate-200 — gridlines, borders
  axis: '#cbd5e1',        // slate-300 — the baseline
  ink: '#0f172a',         // slate-900 — 17.9:1 on the surface
  ink2: '#475569',        // slate-600 — 7.6:1; the smallest text on the screen uses this, never slate-400
  today: '#6457d9',       // today's line, the trend's bars, the current weekday
  overlays: ['#d95926', '#199e70'],
  typical: '#64748b',     // slate-500 — the typical day's median line, de-emphasis grey
  band: 'rgba(100, 116, 139, 0.14)',
  bandKey: 'rgba(100, 116, 139, 0.32)', // the band's legend swatch — a 10px chip needs more than the band
  todayWash: 'rgba(100, 87, 217, 0.08)',
  average: '#1e293b',     // slate-800 — the trend's moving average, drawn over the bars
  mutedBar: '#cbd5e1',
  good: '#059669',
  warning: '#d97706',
  critical: '#e11d48',
};

/** The typeface stack Chad named — Inter or Geist when the machine has one, the system sans otherwise. */
export const SANS = 'Inter, "Inter var", Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
