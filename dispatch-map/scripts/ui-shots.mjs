#!/usr/bin/env node
// scripts/ui-shots.mjs — render every screen of the REAL bundle and photograph it.
//
// Why this exists: `npm test` is 1500 pure-function tests and `smoke-app.mjs` proves the app
// STARTS. Neither can see a layout. Chad's v0.54.69 phone screenshot — the list squeezed into
// three rows with a dead grey slab under the tab bar — was invisible to all of it. A formatting
// bug is only findable by looking, so this drives the built app to each screen at real device
// sizes, with the board stubbed full of orders, and writes a PNG per screen.
//
//   node scripts/ui-shots.mjs [distDir] --device=phone --screens=stops,map --out=artifacts/ui
//     --device    phone | phone-small | tablet | desktop | all      (default phone)
//     --screens   comma list, or 'all' (default all)
//     --out       output dir (default artifacts/ui)
//     --list      print the screen names and exit
//     CHROMIUM_PATH  browser binary      SHOTS_PORT  port (default 8811)
//
// Every shot is FULL-PAGE-clipped to the device viewport on purpose: the bug class we're
// hunting is "the app doesn't fill / overflows the screen", so the frame must be the device,
// not the content.

import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import fixture from '../test/fixtures/nuvizz-today-stops.json' with { type: 'json' };
import { normalizeStop } from '../netlify/functions/lib/nuvizz-scan.mts';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const DIST = resolve(args.find((a) => !a.startsWith('--')) || 'dist');
const PORT = Number(process.env.SHOTS_PORT) || 8811;
const OUT = resolve(flag('out', 'artifacts/ui'));

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json', '.jpg': 'image/jpeg',
};

// ── devices ──────────────────────────────────────────────────────────────────
// phone = iPhone 14/15 logical size (Chad's screenshot). phone-small = the smallest
// screen still in the field (SE / older Android), where cramped layouts break first.
const DEVICES = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  'phone-small': { viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  tablet: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1440, height: 900 } },
};

// ── the board the app renders against ────────────────────────────────────────
// The bundled fixture is 12 orders in raw NuVizz shape; normalizeStop is the SAME
// function the real feed runs them through, so the client sees production shape.
// 12 rows is too few to expose list/scroll layout, so the set is repeated with
// distinct numbers up to BOARD_SIZE — long names and long addresses included,
// because truncation and wrapping are exactly what we're looking at.
const BOARD_SIZE = Number(process.env.BOARD_SIZE || 60);
const base = (fixture.stops || []).map(normalizeStop);
const STOPS = Array.from({ length: BOARD_SIZE }, (_, i) => {
  const s = { ...base[i % base.length] };
  const n = String(7161700 + i);
  return {
    ...s,
    stopNbr: `00${n}`,
    pro: n,
    proNumber: n,
    // Every few rows, a name/address long enough to test truncation — real boards are
    // full of these ("NORTH GWINNETT COOPERATIVE", "991 PEACHTREE INDUSTRIAL BLVD").
    businessName: i % 5 === 0 ? `${s.businessName || 'CUSTOMER'} DISTRIBUTION & LOGISTICS CENTER` : s.businessName,
    addr1: i % 7 === 0 ? '4395 PEACHTREE INDUSTRIAL BOULEVARD NORTHWEST SUITE 200' : s.addr1,
  };
});

const FN_STUBS = (url) => {
  if (url.includes('nuvizz-pull-today-stops')) {
    return { ok: true, stops: STOPS, count: STOPS.length, source: 'fixture', lastScannedAt: new Date('2026-08-13T12:00:00Z').toISOString() };
  }
  if (url.includes('nuvizz-driver-roster') || url.includes('motive-drivers')) {
    return { ok: true, drivers: [{ driverId: '1', driverName: 'JIM PALLETTE', phone: '7705550101' }, { driverId: '2', driverName: 'ANA TORRES', phone: '7705550102' }] };
  }
  if (url.includes('nuvizz-loads-roster')) {
    return { ok: true, loads: [{ loadNbr: 'DAVIS192901', routeName: 'BEN 2', driverName: 'JIM PALLETTE', stops: 12 }, { loadNbr: 'DAVIS192902', routeName: 'LVILLE 1', driverName: null, stops: 8 }] };
  }
  if (url.includes('manifest-check')) {
    return { ok: true, mode: 'board-diff', summary: '660 on the manifest · 658 on the board', suspects: [], manifest: { orders: 660, totals: { count: 660, lbs: 359769, skids: 1019, pieces: 310 } }, onBoard: 658, boardOnly: 12, duplicatePros: [], checkedAgainst: [] };
  }
  if (url.includes('motive-driver-positions')) return { ok: true, positions: [] };
  return { ok: true };
};

// ── the screens ──────────────────────────────────────────────────────────────
// `go` receives the page + device name and must leave the app on that screen.
// Phone and desktop reach the same screens by different chrome, which is itself
// a thing worth photographing side by side.
const MOBILE_TAB = (label) => async (page) => {
  await page.locator('nav button', { hasText: new RegExp(`^${label}$`, 'i') }).first().click();
};
const openChipMenu = async (page) => {
  await page.locator('button[title="Version menu"]').first().click();
  await page.waitForTimeout(350);
};
const chipMenuItem = (label) => async (page, device) => {
  if (device.startsWith('phone') || device === 'tablet') {
    await openChipMenu(page);
    await page.getByRole('button', { name: new RegExp(label, 'i') }).first().click();
  } else {
    const direct = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
    if (await direct.isVisible().catch(() => false)) await direct.click();
    else {
      await page.getByRole('button', { name: /more/i }).first().click();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: new RegExp(label, 'i') }).first().click();
    }
  }
};

const SCREENS = {
  map: { go: async (page, d) => { if (d !== 'desktop') await MOBILE_TAB('Map')(page); } },
  stops: { go: async (page, d) => { if (d !== 'desktop') await MOBILE_TAB('Stops')(page); } },
  filters: { go: async (page, d) => { if (d !== 'desktop') await MOBILE_TAB('Filters')(page); } },
  loads: { go: async (page, d) => { if (d !== 'desktop') await MOBILE_TAB('Loads')(page); } },
  'stop-detail': {
    go: async (page, d) => {
      if (d !== 'desktop') await MOBILE_TAB('Stops')(page);
      await page.waitForTimeout(400);
      // The first row in the board list — opens the detail sheet / sidebar.
      await page.locator('button, [role="button"]').filter({ hasText: /00716/ }).first().click().catch(() => {});
    },
  },
  'chip-menu': { go: async (page, d) => { if (d !== 'desktop') await openChipMenu(page); } },
  routing: { go: chipMenuItem('Routing') },
  neworder: { go: chipMenuItem('New order') },
  quote: { go: chipMenuItem('Quote') },
  manifest: { go: chipMenuItem('Manifest') },
  messages: { go: chipMenuItem('Messages') },
  diagnostics: { go: chipMenuItem('Diagnostics') },
};

if (args.includes('--list')) {
  console.log(Object.keys(SCREENS).join('\n'));
  process.exit(0);
}

const wantDevices = flag('device', 'phone') === 'all' ? Object.keys(DEVICES) : flag('device', 'phone').split(',');
const wantScreens = flag('screens', 'all') === 'all' ? Object.keys(SCREENS) : flag('screens', 'all').split(',');

try { if (!(await stat(DIST)).isDirectory()) throw new Error('nd'); }
catch { console.error(`✗ no build at ${DIST} — run \`npm run build\` first`); process.exit(1); }
await mkdir(OUT, { recursive: true });

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try {
      const b = await readFile(c);
      res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' });
      return res.end(b);
    } catch { /* fall through to index.html */ }
  }
  res.writeHead(404).end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});

const report = [];
for (const device of wantDevices) {
  const cfg = DEVICES[device];
  if (!cfg) { console.error(`unknown device '${device}'`); continue; }
  for (const screen of wantScreens) {
    const spec = SCREENS[screen];
    if (!spec) { console.error(`unknown screen '${screen}'`); continue; }
    const ctx = await browser.newContext(cfg);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });
    await page.route('**/.netlify/functions/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FN_STUBS(route.request().url())) }));
    // Google Maps / fonts / tiles are third-party and unreachable here; abort rather than
    // let each one burn a 30s timeout. The app already degrades to "Google Maps failed".
    await page.route('**://*.googleapis.com/**', (r) => r.abort());
    await page.route('**://*.gstatic.com/**', (r) => r.abort());
    await page.route('**://*.google.com/**', (r) => r.abort());

    let note = '';
    try {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await spec.go(page, device);
      await page.waitForTimeout(900);
    } catch (e) { note = `navigation: ${e.message.split('\n')[0]}`; }

    const file = join(OUT, `${device}--${screen}.png`);
    await page.screenshot({ path: file });

    // Layout facts worth having next to the picture: does the app fill the viewport, and
    // does anything stick out sideways? These are measurements, not opinions.
    const metrics = await page.evaluate(() => {
      const root = document.getElementById('root');
      const shell = root?.firstElementChild;
      const r = shell?.getBoundingClientRect();
      const de = document.documentElement;
      const overflowing = [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ').filter(Boolean).slice(0, 3).join('.')} → ${Math.round(el.getBoundingClientRect().right)}px`);
      return {
        viewport: `${window.innerWidth}×${window.innerHeight}`,
        shell: r ? `${Math.round(r.width)}×${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}` : 'none',
        shellFillsHeight: r ? Math.abs(r.height - window.innerHeight) <= 1 : false,
        shellFillsWidth: r ? Math.abs(r.width - window.innerWidth) <= 1 : false,
        docScrollsX: de.scrollWidth > de.clientWidth + 1,
        rootTextLength: (root?.innerText || '').length,
        overflowing,
      };
    }).catch((e) => ({ error: e.message }));

    report.push({ device, screen, file: file.replace(`${process.cwd()}/`, ''), metrics, errors: errors.slice(0, 5), note });
    const flagBits = [
      metrics.shellFillsHeight === false ? 'SHELL-SHORT' : '',
      metrics.docScrollsX ? 'H-SCROLL' : '',
      metrics.overflowing?.length ? 'OVERFLOW' : '',
      errors.length ? 'JS-ERROR' : '',
      note ? 'NAV-FAIL' : '',
    ].filter(Boolean).join(' ');
    console.log(`  ${flagBits ? '⚠' : '✓'} ${device}--${screen}  ${metrics.shell} in ${metrics.viewport} ${flagBits}`);
    await ctx.close();
  }
}

await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.length} shot(s) → ${OUT}\n  report: ${join(OUT, 'report.json')}`);
await browser.close();
server.close();
