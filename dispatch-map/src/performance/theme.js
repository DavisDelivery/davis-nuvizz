// src/performance/theme.js — the Performance screen's colours, by the job each one does.
//
// Chad's brief for this screen: a restrained dark surface (zinc 950 / 900, zinc 800 hairlines),
// accents used sparingly and low in saturation (emerald, indigo, amber), monospace for raw
// numbers and times. The rest of the app is light; this screen is dark because he asked for it.
//
// EVERY DATA COLOUR BELOW WAS RUN THROUGH THE PALETTE VALIDATOR (dataviz validate_palette.js,
// dark mode, against SURFACE #18181b), not picked by eye:
//
//   pace lines  today #9085e9 · overlay #d95926 · overlay #199e70
//               ALL-PAIRS (lines cross, so any two can sit side by side): worst CVD ΔE 9.4,
//               normal-vision ΔE 24.6, every line ≥ 3:1 on the surface. Tailwind's own pinks
//               and greens were tried first and collapsed under deuteranopia (ΔE 1.1 – 5.0),
//               which is why the overlays are these two steps and why there are only two.
//   status      good #34d399 · warning #fbbf24 · critical #fb7185 (emerald / amber / rose 400)
//               adjacent in the outcome meter: CVD ΔE 10.6, normal-vision 21.2, all ≥ 3:1.
//               Always drawn with an icon and a label — never colour alone.
//
// Text never wears a data colour (dataviz: "text wears text tokens"): values and labels are
// INK / INK_2; a coloured dot or line key beside them carries identity.

export const C = {
  page: '#09090b',        // zinc-950
  surface: '#18181b',     // zinc-900 — the chart surface the palette was validated on
  hairline: '#27272a',    // zinc-800 — gridlines, borders
  axis: '#3f3f46',        // zinc-700 — the baseline
  ink: '#f4f4f5',         // zinc-100 — 16.1:1 on the surface
  ink2: '#a1a1aa',        // zinc-400 — 6.9:1; the smallest text on the screen uses this, never zinc-500
  today: '#9085e9',       // today's line, the trend's bars, the current weekday
  overlays: ['#d95926', '#199e70'],
  typical: '#a1a1aa',     // the typical day's median line — de-emphasis grey
  band: 'rgba(161, 161, 170, 0.13)',
  todayWash: 'rgba(144, 133, 233, 0.08)',
  average: '#d4d4d8',     // the trend's moving average
  mutedBar: '#3f3f46',
  good: '#34d399',
  warning: '#fbbf24',
  critical: '#fb7185',
};

/** The typeface stack Chad named — Inter or Geist when the machine has one, the system sans otherwise. */
export const SANS = 'Inter, "Inter var", Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
