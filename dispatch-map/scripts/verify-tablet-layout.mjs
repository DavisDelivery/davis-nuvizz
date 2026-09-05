// TABLET LAYOUT GUARD — the view nobody was looking at.
//
// Chad, on an iPad: "FORMATTING ISSUES ON IPAD".
//
// He was right, and the reason nothing caught it is structural rather than careless. This app
// deliberately has two views: below MOBILE_BREAKPOINT (768px) it renders the phone layout,
// above it the desktop one. An iPad is 1024-1194px wide, so it gets the DESKTOP layout — a
// layout designed for a mouse — and it is a TOUCH device.
//
// Every guard the build had looks at one end or the other:
//   verify-mobile-layout   390 / 360     collisions, clipping, touch floor
//   verify-desktop-layout  1440 / 1920   occupancy only — no collision check at all
//
// So a tablet is measured by neither, and the first sweep at iPad width found it: 43 controls
// under the 44px touch floor (nav tabs at 32px, Build/Engine at 26px, one at 18x26), a Status
// dropdown anchored `right-0` that hung off the LEFT edge of the screen once its toolbar
// wrapped, and a collision between that menu and the Stops pill in portrait.
//
// ── THE ONE LINE THAT MAKES THIS GUARD REAL ─────────────────────────────────
// hasTouch: true. index.css gates the whole fingertip floor on `pointer: coarse`, so a run
// without it exercises the MOUSE layout at iPad width and passes while the actual device
// fails. That is not a hypothetical — it is what the desktop guard has always done.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { MEASURE } from './lib/layout-measure.mjs';

const DIST = process.argv[2] || 'dist';
const PORT = Number(process.env.PORT || 4183);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

// The sizes Davis actually holds. Landscape is how a routing board gets used; portrait is
// where a wrapping toolbar puts a dropdown somewhere nobody designed for.
const TABLETS = [
  { name: 'iPad Pro 11 landscape', width: 1194, height: 834 },
  { name: 'iPad Air landscape', width: 1180, height: 820 },
  { name: 'iPad 10.2 landscape', width: 1080, height: 810 },
  { name: 'iPad portrait', width: 820, height: 1180 },
];

const SCREENS = [
  { key: 'map', label: 'Map', nav: /^map$/i },
  { key: 'routing', label: 'Routing (beta)', nav: /routing/i },
  { key: 'neworder', label: 'New Order', nav: /new order/i },
  { key: 'quote', label: 'Quote', nav: /quote/i },
  { key: 'manifest', label: 'Manifest check', nav: /manifest check/i, inMore: true },
  { key: 'comms', label: 'Customer emails', nav: /customer emails/i, inMore: true },
  { key: 'flaghistory', label: 'Flag history', nav: /flag history/i, inMore: true },
  { key: 'diagnostics', label: 'Diagnostics', nav: /diagnostics/i, inMore: true },
];

// AT REST IS NOT ENOUGH, and the phone guard learned this the expensive way. Every defect
// Chad photographed needed a tap first: the Status menu is not in the DOM until it is opened.
const PROBES = {
  routing: [{ name: 'Status menu', open: async (page) => openByName(page, /^status/i) }],
  map: [{ name: 'Status menu', open: async (page) => openByName(page, /^status/i) }],
};

async function openByName(page, re) {
  const btn = page.getByRole('button', { name: re }).first();
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click().catch(() => {});
  await page.waitForTimeout(400);
  return true;
}

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try {
      const b = await readFile(c);
      res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' });
      return res.end(b);
    } catch { /* fall through to the SPA shell */ }
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(PORT, r));

async function gotoScreen(page, screen) {
  // The tablet uses the DESKTOP nav — a top bar, with the tail of it behind "More".
  // The "More" group is opened the way the desktop guard opens it — by innerText rather than
  // an accessible name. The chevron and the count in that button make getByRole('button',
  // {name:/^more$/}) miss it, which silently skipped four screens on the first run of this
  // guard and reported them as "not reachable" instead of failing.
  if (screen.inMore) {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^more/i.test((x.innerText || '').trim()));
      if (b) b.click();
    });
    await page.waitForTimeout(400);
  }
  const target = page.getByRole('menuitem', { name: screen.nav }).first();
  const btn = page.getByRole('button', { name: screen.nav }).first();
  const use = (await target.isVisible().catch(() => false)) ? target : btn;
  if (!(await use.isVisible().catch(() => false))) return false;
  await use.click();
  await page.waitForTimeout(900);
  return true;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
let failures = 0;
let checked = 0;

console.log('\nTablet layout guard — the desktop layout, on a device with fingers\n');
for (const dev of TABLETS) {
  console.log(`\x1b[1m${dev.name} (${dev.width}×${dev.height})\x1b[0m`);
  const ctx = await browser.newContext({
    viewport: { width: dev.width, height: dev.height },
    // THE LOAD-BEARING FLAG. Without it `pointer: coarse` never matches and this guard
    // measures a layout no iPad ever renders. See the header.
    hasTouch: true,
    isMobile: false,
    deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1',
  });
  const page = await ctx.newPage();
  // STUBS WITH ROWS IN THEM, because an empty screen is not the screen that ships.
  //
  // The first version returned empty arrays for everything, and the guard duly reported a
  // 526px empty white panel on Customer emails as dead space at all three landscape sizes.
  // It was right about the pixels and wrong about the defect: with no log rows, an empty
  // list IS the correct render. Measuring a state production never reaches produces
  // findings nobody can act on, and teaches whoever reads the output to discount it.
  await page.route('**/.netlify/functions/**', (route) => {
    const u = route.request().url();
    const J = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('customer-comms-log')) return J({
      ok: true, today: '2026-09-05',
      range: { mode: 'days', from: '2026-09-04', to: '2026-09-05', days: 2, requestedDays: 2, clipped: false, maxDays: 92 },
      dates: ['2026-09-05', '2026-09-04'], unreadable: [], months: ['2026-09'],
      totals: { total: 2, sent: 2, failed: 0, inflight: 0 },
      byDay: [{ date: '2026-09-05', total: 2, sent: 2, failed: 0, inflight: 0 },
              { date: '2026-09-04', total: 0, sent: 0, failed: 0, inflight: 0 }],
      byMonth: [{ month: '2026-09', days: 2, total: 2, sent: 2, failed: 0, inflight: 0 }],
      status: {},
      entries: [
        { date: '2026-09-05', key: 'k1', at: '2026-09-05T13:50:00Z', customer: 'ACME SUPPLY COMPANY OF NORTH GEORGIA', to: 'receiving@example.com', subject: 'Delivered — PRO 007171743', pro: '007171743', ok: true, claimed: true },
        { date: '2026-09-05', key: 'k2', at: '2026-09-05T14:02:00Z', customer: 'BUFORD TILE & STONE', to: 'ap@example.com', subject: 'Delivered — PRO 007171744', pro: '007171744', ok: true, claimed: true },
      ],
      entriesShown: 2, entriesTotal: 2, entriesTruncated: false,
    });
    if (u.includes('coverage=1')) return J({ ok: true, pct: 100, withEmail: 599, sampled: 600, delivered: 710, bySource: { order: 599, notes: 0 }, optedOut: 0, withoutEmail: 1 });
    return J({ ok: true, stops: [], entries: [], items: [], days: [], count: 0, drivers: [], roster: [], reviews: [] });
  });
  page.on('dialog', (d) => d.accept());
  // SAY IT OUT LOUD. The useLayoutEffect crash was completely silent from the outside: the
  // app rendered nothing and every screen simply "was not there".
  page.on('pageerror', (e) => { console.log(`  \x1b[31m! page error:\x1b[0m ${String(e).slice(0, 200)}`); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

  for (const screen of SCREENS) {
    // AN UNREACHABLE SCREEN IS A FAILURE, NOT A SKIP.
    //
    // The first version printed "- not reachable" and moved on, which is how this guard
    // reported "✓ every screen works on a tablet (0 states checked)" while the app was
    // throwing on load — a missing useLayoutEffect import that `vite build` compiles
    // happily. A green tick over an empty measurement is worse than no guard: it is a guard
    // that lies in the flattering direction, which is the exact pattern this repo keeps
    // getting bitten by.
    if (!(await gotoScreen(page, screen))) {
      failures += 1;
      console.log(`  \x1b[31m✗\x1b[0m ${screen.label} — NOT REACHABLE (nav missing, or the app failed to render)`);
      continue;
    }
    const states = [{ name: '', open: null }, ...(PROBES[screen.key] || [])];
    for (const st of states) {
      if (st.open && !(await st.open(page))) continue;
      const r = await page.evaluate(MEASURE);
      const problems = [];
      for (const [k, label] of [['offscreen', 'off-screen'], ['clipped', 'clipped'], ['overlap', 'overlapping'], ['small', 'under the 44px touch floor'], ['dead', 'unreachable']]) {
        const rows = r[k] || [];
        if (rows.length) problems.push({ label, rows });
      }
      checked += 1;
      const where = `${screen.label}${st.name ? ` → ${st.name}` : ''}`;
      if (!problems.length) { console.log(`  \x1b[32m✓\x1b[0m ${where}`); continue; }
      failures += 1;
      console.log(`  \x1b[31m✗\x1b[0m ${where}`);
      for (const p of problems) {
        console.log(`      \x1b[31m${p.rows.length} ${p.label}\x1b[0m`);
        for (const row of p.rows.slice(0, 6)) console.log(`        ${JSON.stringify(row)}`);
      }
    }
    // Back to a clean slate — a menu left open on one screen is not this screen's problem.
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
  }
  await ctx.close();
}
await browser.close();
srv.close();

// AND A RUN THAT MEASURED NOTHING IS A FAILED RUN. Belt and braces on the same lesson: if
// every screen were skipped for some future reason, `failures` could still be 0.
const EXPECTED_MIN = TABLETS.length * SCREENS.length;
if (checked < EXPECTED_MIN) {
  console.log(`\n\x1b[31m✗ only ${checked} states measured; expected at least ${EXPECTED_MIN}.\x1b[0m`);
  console.log('  A guard that checks nothing and passes is not a guard.\n');
  process.exit(1);
}

if (failures) {
  console.log(`\n\x1b[31m✗ ${failures} of ${checked} tablet states have layout defects.\x1b[0m`);
  console.log('  Do not widen the thresholds to get green — an iPad really is that size and really does have fingers.\n');
  process.exit(1);
}
console.log(`\n\x1b[32m✓ every screen works on a tablet (${checked} states checked)\x1b[0m\n`);
