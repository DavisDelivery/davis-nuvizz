#!/usr/bin/env node
// Render every Shiplify-trial pin and place mark AT TRUE SIZE on the three grounds the board is
// read against — a dark treeline, a bright parking lot and a grey roof — through the REAL
// stopMarkerIcon (lifted out of App.jsx by test/helpers/app-markers.mjs, the same way the marker
// tests build them). A 3x panel sits beside each so the artwork can be checked, but the 1x panel
// is the one that answers "can a dispatcher read this on the map".
//
//   node scripts/render-shiplify-pins.mjs <outDir>
//
// Writes <outDir>/shiplify-pins-1x.png and <outDir>/shiplify-pins-3x.png. Synthetic stops only.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { loadStopMarkerIcon } from '../test/helpers/app-markers.mjs';

const outDir = resolve(process.argv[2] || 'shiplify-renders');
mkdirSync(outDir, { recursive: true });
const icon = await loadStopMarkerIcon();

let n = 0;
const stop = (o = {}) => ({ stopNbr: String(9100000 + (++n)), stopType: 'DO', lat: 34, lng: -84, addr1: '1 Sample St', zip: '30000', matchKey: `r${n}`, isPlanned: false, status: '', ...o });
const sch = (o = {}) => stop({ isPlanned: true, ...o });
const on = (rec, o = {}) => ({ shiplifyOn: true, shiplifyRec: rec, tractorSeen: false, tractorKnown: true, ...o });
const DOCK = { dock_access: 'yes', location_types: [], tariff_items: [] };
const FORK = { dock_access: 'no', forklift: 'yes', location_types: [], tariff_items: [] };
const RES = (r) => ({ ...r, tariff_items: ['RES'] });

const PINS = [
  ['Dock — unplanned (resting dot)', stop(), null, on(DOCK)],
  ['Dock — scheduled', sch(), null, on(DOCK)],
  ['Dock + house', sch(), null, on(RES(DOCK))],
  ['Forklift — unplanned', stop(), null, on(FORK)],
  ['Forklift — scheduled', sch(), null, on(FORK)],
  ['Forklift + PU', stop({ stopType: 'PU' }), null, on(FORK)],
  ['Forklift + AM', sch(), { delivery_window: 'AM' }, on(FORK)],
  ['Forklift + house', stop(), null, on(RES(FORK))],
  ['After a tractor delivers (lime)', stop(), null, on(DOCK, { tractorDelivered: true, tractorSeen: true })],
  ...['residential', 'school', 'church', 'government'].flatMap((k) => [
    [`${k} — scheduled`, sch(), { building_type: k }, {}],
    [`${k} — unplanned`, stop(), { building_type: k }, {}],
    [`${k} — route pin`, sch(), { building_type: k }, { inRoute: true, seq: 7, routeColor: '#0e7490' }],
    [`${k} — planned-muted`, sch(), { building_type: k }, { plannedMuted: true }],
    [`${k} — restriction cluster`, stop(), { building_type: k, liftgate_required: true }, {}],
  ]),
  ['School — do not send', stop(), { building_type: 'school', do_not_send: true }, {}],
  ['Church — Estes', stop({ stopNbr: 'ESTES-0000000009' }), { building_type: 'church' }, {}],
  ['School — PU keeps the middle', sch({ stopType: 'PU' }), { building_type: 'school' }, {}],
];

const cells = PINS.map(([label, s, note, opts]) => {
  const ic = icon(s, note, opts);
  return { label, url: ic.url, w: ic.scaledSize.width, h: ic.scaledSize.height };
});

// Three grounds, drawn to look like what the satellite base shows behind a pin.
const GROUNDS = [
  ['Dark treeline', 'radial-gradient(circle at 20% 30%, #2f4a2a 0 18%, transparent 19%), radial-gradient(circle at 70% 60%, #1c2e1a 0 22%, transparent 23%), repeating-linear-gradient(35deg, #23361f 0 6px, #1a2917 6px 11px)'],
  ['Bright parking lot', 'repeating-linear-gradient(90deg, #e9eaec 0 38px, #ffffff 38px 40px), linear-gradient(#dfe1e4, #f4f5f6)'],
  ['Grey roof', 'repeating-linear-gradient(0deg, #8d9297 0 7px, #7f8489 7px 8px), linear-gradient(#8a8f94, #979ca1)'],
];

function page(scale) {
  const rows = cells.map((c) => `
    <tr><td class="lab">${c.label}</td>${GROUNDS.map(([, bg]) => `
      <td class="g" style="background:${bg}"><img src="${c.url}" width="${c.w * scale}" height="${c.h * scale}" style="image-rendering:${scale === 1 ? 'auto' : 'auto'}"></td>`).join('')}
    </tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:12px;font:12px system-ui,sans-serif;background:#fff;color:#0f172a}
    h1{font-size:14px;margin:0 0 8px}
    table{border-collapse:collapse}
    td{border:1px solid #cbd5e1}
    td.lab{padding:4px 8px;white-space:nowrap}
    td.g{width:${70 * scale}px;height:${40 * scale}px;text-align:center;vertical-align:middle}
    th{padding:4px 8px;text-align:left}
  </style></head><body>
    <h1>Shiplify trial pins and place marks — ${scale === 1 ? 'TRUE SIZE (1x, as drawn on the map)' : `${scale}x, for checking the artwork`}</h1>
    <table><tr><th></th>${GROUNDS.map(([name]) => `<th>${name}</th>`).join('')}</tr>${rows}</table>
  </body></html>`;
}

const browser = await chromium.launch();
for (const scale of [1, 3]) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  await p.setContent(page(scale), { waitUntil: 'load' });
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${outDir}/shiplify-pins-${scale}x.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log(`✓ rendered ${cells.length} pins on ${GROUNDS.length} grounds → ${outDir}`);
