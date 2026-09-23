#!/usr/bin/env node
// scripts/verify-shiplify.mjs — THE SHIPLIFY TRIAL'S CONTROLS, IN THE REAL BUNDLE.
//
// The unit tests prove the rules and render the components one at a time. This proves the
// WIRING, on desktop and on a phone: each tab carries its own "Shiplify data" switch where the
// brief puts it (Map: the Legend on desktop, Filters → Map display on the phone; Routing: the
// Routing map's Filters menu on both), each switch writes only its own per-device key, the
// "Lime as of board date" notice shows on Routing exactly while that trial switch is on, and
// the gear's "Import Shiplify results" screen reads a legacy .xls — the Shiplify file's own
// format, with a Summary sheet beside the results — and shows its counts before anything is
// written. The file is SYNTHETIC, built here with the app's own xlsx library.
//
// SAID PLAINLY: Firestore is not reachable here, so no Shiplify data loads and no pin is drawn;
// what the pins look like is test/shiplify-markers.test.mjs and scripts/render-shiplify-pins.mjs.
// Nothing here writes anywhere — the import screen is driven to its summary and stopped.
//
//   node scripts/verify-shiplify.mjs [distDir]      SMOKE_PORT (default 8812)  CHROMIUM_PATH
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import * as XLSXmod from 'xlsx';

const XLSX = XLSXmod.read ? XLSXmod : XLSXmod.default;
const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8812;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const fails = [];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { fails.push(m); console.error(`  \x1b[31m✗\x1b[0m ${m}`); };
const watchdog = setTimeout(() => { console.error('\n\x1b[31m✗ verify-shiplify exceeded 6 minutes\x1b[0m'); process.exit(1); }, 6 * 60 * 1000);

// ── a synthetic Shiplify file: two PROs (Shipper + Consignee each), and the Summary pivot ──────
const COLS = ['shipment_location_id', 'pro_number', 'pickup_date', 'entity', 'name', 'street_address', 'city', 'state', 'postal_code',
  'provider_exemption_count', 'visible_location_types', 'all_location_types', 'tariff_items', 'dock_access', 'forklift', 'lumper',
  'gated_access', 'security_hut', 'call_box', 'appointment_required'];
const row = (o) => COLS.map((c) => (o[c] ?? ''));
const base = { provider_exemption_count: 0, lumper: 'no', gated_access: 'no', security_hut: 'no', call_box: 'no' };
const shipper = (pro) => row({ ...base, pro_number: pro, pickup_date: 46251, entity: 'Shipper', name: 'Invented Origin', street_address: '1 Depot Rd', city: 'Origintown', state: 'GA', postal_code: '39999', all_location_types: 'Warehouse', dock_access: 'yes' });
const consignee = (pro, o) => row({ ...base, pro_number: pro, pickup_date: 46251, entity: 'Consignee', city: 'Testville', state: 'GA', postal_code: '30000', ...o });
const aoa = [COLS,
  shipper('1000001'), consignee('1000001', { name: 'Example School', street_address: '5 Sample Rd', all_location_types: 'Place of Worship|School', tariff_items: 'LIM', dock_access: 'no', forklift: 'yes' }),
  shipper(`SHP${String.fromCharCode(160)}00000.00`), consignee(`SHP${String.fromCharCode(160)}00000.00`, { name: 'Example Home', street_address: '9 Sample Ln', all_location_types: 'Residential', tariff_items: 'RES', dock_access: '' }),
  shipper('ESTES-0000000001'), consignee('ESTES-0000000001', { name: 'Example Depot', street_address: '2 Sample Pkwy', all_location_types: 'Distribution Center', tariff_items: '', dock_access: 'yes' }),
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Summary'], ['entity', 'count'], ['Consignee', 3]]), 'Summary');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'DavisfileResults');
const XLS = XLSX.write(wb, { type: 'buffer', bookType: 'biff8' });

const STOPS = Array.from({ length: 12 }, (_, i) => ({
  stopNbr: `SH${1000 + i}`, pro: `SH${1000 + i}`, businessName: `SHIPLIFY FIXTURE ${i + 1}`,
  addr1: `${100 + i} Fixture Rd`, city: 'BUFORD', state: 'GA', zip: '30518', lat: 34.14 + i * 0.01, lng: -83.96,
  cartons: 3, volume: 0, weight: 500, status: '10', normalizedStatus: 'UNPLANNED', isUnplanned: true, isPlanned: false,
  stopType: 'DL', matchKey: `shiplify_fixture_${i}`,
}));
const at = new Date('2026-09-10T11:00:00Z').toISOString();
const PULL = { ok: true, stops: STOPS, count: STOPS.length, source: 'fixture', lastScannedAt: at, lastLoadScanAt: at, lastUnplannedScanAt: at, lastCompletedScanAt: at };

const srv = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try {
      const b = await readFile(c);
      res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' });
      return res.end(b);
    } catch { /* SPA shell */ }
  }
  res.writeHead(404).end();
});
await new Promise((r) => srv.listen(PORT, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });

async function open(viewport, { mobile = false, init = {} } = {}) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message || e)));
  await page.addInitScript((kv) => { try { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); } catch { /* ignore */ } }, init);
  await page.route('**/.netlify/functions/**', (route) => {
    const u = route.request().url();
    const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (u.includes('nuvizz-pull-today-stops') || u.includes('nuvizz-board')) return json(PULL);
    if (u.includes('shiplify-import')) return json({ ok: true, none: true });
    return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], loads: [], count: 0 });
  });
  for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await page.route(`**://*.${host}/**`, (r) => r.abort());
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  return { ctx, page, errors };
}
const storage = (page) => page.evaluate(() => ({
  map: localStorage.getItem('dispatchMap.shiplifyOn'),
  routing: localStorage.getItem('routing.shiplify'),
}));
async function toRouting(page, mobile) {
  if (mobile) {
    await page.locator('button[title="Version menu"]').first().click().catch(() => {});
    await page.waitForTimeout(300);
    await page.getByRole('menuitem', { name: /routing/i }).first().click().catch(() => {});
  } else {
    await page.getByText('Routing (beta)', { exact: true }).first().click().catch(() => {});
  }
  await page.waitForTimeout(1800);
}
async function routingSwitch(page, label) {
  await page.locator('button[title="Map filters"]').first().click();
  await page.waitForTimeout(250);
  const sw = page.getByRole('switch', { name: /shiplify data/i }).first();
  if (!(await sw.isVisible().catch(() => false))) { bad(`${label}: Routing Filters has no "Shiplify data" switch`); return; }
  ok(`${label}: Routing Filters carries "Shiplify data" (${await sw.getAttribute('aria-checked') === 'true' ? 'on' : 'off'} by default)`);
  const before = await storage(page);
  await sw.click();
  await page.waitForTimeout(150);
  const after = await storage(page);
  if (after.routing === 'off' && after.map === before.map) ok(`${label}: switching Routing off writes routing.shiplify=off and leaves the Map's key alone`);
  else bad(`${label}: Routing switch wrote ${JSON.stringify(after)} (before ${JSON.stringify(before)})`);
  await sw.click();
  await page.keyboard.press('Escape');
}

// ── DESKTOP ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mdesktop (1440x900)\x1b[0m');
{
  const { ctx, page, errors } = await open({ width: 1440, height: 900 });
  // The Map's Legend: the Map's own switch and the trial filter.
  const legendBtn = page.getByRole('button', { name: /^legend/i }).first();
  await legendBtn.click().catch(() => {});
  await page.waitForTimeout(300);
  const mapSw = page.locator('[data-shiplify-switch="map"]').getByRole('switch', { name: /shiplify data/i }).first();
  if (await mapSw.isVisible().catch(() => false)) {
    ok('Map Legend carries the Map tab\'s "Shiplify data" switch');
    const before = await storage(page);
    await mapSw.click();
    await page.waitForTimeout(150);
    const after = await storage(page);
    if (after.map === 'off' && after.routing === before.routing) ok('switching the Map off writes dispatchMap.shiplifyOn=off and leaves Routing\'s key alone');
    else bad(`Map switch wrote ${JSON.stringify(after)} (before ${JSON.stringify(before)})`);
    await mapSw.click();
  } else bad('the Map Legend has no "Shiplify data" switch');
  if (await page.locator('[data-lime-as-of]').first().isVisible().catch(() => false)) ok('Map Legend carries "Lime as of board date"');
  else bad('the Map Legend has no "Lime as of board date" switch');

  await toRouting(page, false);
  await routingSwitch(page, 'desktop');
  if (await page.locator('[data-lime-as-of-notice]').count()) bad('the "Lime as of board date" notice shows while the trial switch is OFF');
  else ok('no "Lime as of board date" notice while the trial switch is off');

  // The gear → the import screen → a synthetic .xls → its counts, and stop there.
  await page.locator('button[aria-label="Panel settings"]').first().click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: /import shiplify results/i }).first().click();
  const dlg = page.getByRole('dialog', { name: /import shiplify results/i });
  if (!(await dlg.isVisible().catch(() => false))) bad('the gear\'s "Import Shiplify results" did not open the import screen');
  else {
    ok('the gear opens "Import Shiplify results"');
    await dlg.locator('input[type="file"]').setInputFiles({ name: 'DavisfileResults.xls', mimeType: 'application/vnd.ms-excel', buffer: XLS });
    const summary = dlg.locator('[data-shiplify-summary]');
    await summary.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const text = (await summary.textContent().catch(() => '')) || '';
    // textContent runs label and value together ("…sheet6Consignee…"), so a number is ended by
    // "not another digit" rather than by a word boundary.
    const want = [/Rows in the sheet\s*6(?!\d)/, /Consignee rows\s*3(?!\d)/, /Shipper rows[^0-9]*3(?!\d)/, /Tariff RES\s*1(?!\d)/, /Dock yes \/ no \/ blank\s*1 \/ 1 \/ 1(?!\d)/, /No dock, with a forklift\s*1(?!\d)/, /Pickup dates\s*Aug 17, 2026/];
    const missing = want.filter((re) => !re.test(text));
    if (!text) bad('the import screen showed no summary for a valid .xls');
    else if (missing.length) bad(`the .xls summary is wrong — missing ${missing.map(String).join(', ')} in: ${text.slice(0, 300)}`);
    else ok('a legacy .xls with a Summary sheet beside it is read from the DavisfileResults sheet: 6 rows, 3 consignees, Excel dates as Aug 17, 2026');
    if (await dlg.getByRole('button', { name: /^import 6 rows$/i }).isVisible().catch(() => false)) ok('…and it waits for "Import 6 rows" — nothing written until Chad presses it');
    else bad('the import screen does not offer "Import 6 rows" after reading the file');
  }
  if (errors.length) bad(`desktop page errors: ${errors.join(' | ')}`);
  await ctx.close();
}
{
  const { ctx, page, errors } = await open({ width: 1440, height: 900 }, { init: { 'dispatchMap.limeAsOfBoardDate': 'on' } });
  await toRouting(page, false);
  if (await page.locator('[data-lime-as-of-notice]').first().isVisible().catch(() => false)) ok('Routing shows "Lime as of board date" while the trial switch is on');
  else bad('Routing does not show the "Lime as of board date" notice while the trial switch is on');
  if (errors.length) bad(`page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

// ── PHONE ───────────────────────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1mphone (390x844)\x1b[0m');
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 }, { mobile: true, init: { 'dispatchMap.limeAsOfBoardDate': 'on' } });
  await page.getByRole('button', { name: /^filters$/i }).first().click().catch(() => {});
  await page.waitForTimeout(500);
  const sw = page.locator('[data-shiplify-switch="map"]').getByRole('switch', { name: /shiplify data/i }).first();
  if (await sw.isVisible().catch(() => false)) ok('phone Map: Filters → Map display carries "Shiplify data"');
  else bad('phone Map: no "Shiplify data" switch under Filters → Map display');
  await page.keyboard.press('Escape').catch(() => {});
  await toRouting(page, true);
  if (await page.locator('[data-lime-as-of-notice]').first().isVisible().catch(() => false)) ok('phone Routing shows "Lime as of board date" while the trial switch is on');
  else bad('phone Routing does not show the "Lime as of board date" notice');
  await routingSwitch(page, 'phone');
  if (errors.length) bad(`phone page errors: ${errors.join(' | ')}`);
  await ctx.close();
}

await browser.close();
srv.close();
clearTimeout(watchdog);
if (fails.length) { console.error(`\n\x1b[31m✗ ${fails.length} Shiplify control check(s) failed\x1b[0m`); process.exit(1); }
console.log('\n\x1b[32m✓ the Shiplify trial\'s controls are where the brief puts them, each writes only its own key, and the import screen reads the real file format\x1b[0m');
