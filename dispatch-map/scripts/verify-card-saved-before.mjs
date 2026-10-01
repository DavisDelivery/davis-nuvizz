#!/usr/bin/env node
// scripts/verify-card-saved-before.mjs — DOES A ROUTE THAT WAS SAVED, CLOSED AND BROUGHT BACK
// STILL CARRY ITS GREEN ✓?
//
// Chad: "I want saved route to always carry a green check mark if it has saved previously say if
// a route was closed out and re brought up but keep the message as is for a route that just saved."
//
// test/card-saved-before.test.mjs proves the rule. This drives his sentence through the real
// bundle, end to end: open a load in Compare, change it, press Send to NuVizz (the write is
// stubbed — NO NuVizz call is possible from here), see the card say "✓ SENT h:mm" as it always
// has, close the card, bring it back, and read the green ✓. Then edit it (the ✓ must go), reload
// the page (it must come back), let a LATER scan show the route in a different order — changed in
// NuVizz since the save — and reopen it (no ✓: the card no longer shows what was sent), and open a
// load nobody saved (it must say nothing).
//
// THE CARDS OPEN THE WAY REAL ONES DO: the stops carry the route NAME in loadNbr and no load id, and
// the card learns its load number and id from the day's roster (stubbed here, as on the board).
//
//   node scripts/verify-card-saved-before.mjs [distDir]
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8840)
//     MOBILE=1       the phone layout instead of the desktop one
//     EXPECT_OFF=1   for a build made with VITE_CARD_SAVED_BEFORE=off: the reopened card must then
//                    say nothing, while "✓ SENT" on the card that just saved is unchanged
//     SHOT=path.png  also write a screenshot of the reopened card
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8840;
const MOBILE = process.env.MOBILE === '1';
const EXPECT_OFF = process.env.EXPECT_OFF === '1';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
// A hung guard blocks the merge and says nothing (the verify-loads-tab lesson).
const GUARD_MS = Number(process.env.CARD_SAVED_BEFORE_TIMEOUT_MS) || 3 * 60 * 1000;
const watchdog = setTimeout(() => {
  console.error(`\n✗ verify-card-saved-before exceeded ${Math.round(GUARD_MS / 1000)}s — failing rather than hanging the build`);
  process.exit(1);
}, GUARD_MS);
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

// TWO LOADS. SAVED 1 is the one that gets sent; OTHER 1 is never sent and must never wear a mark.
const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DEG = 1 / 69.055;
const load = (route, base) => ['A', 'B', 'C', 'D'].map((L, i) => ({
  stopNbr: `00${base}${i}0`, pro: `${base}${i}0`, businessName: `${route} CO ${L}`,
  addr1: `${300 + i} ${route.split(' ')[0]} Rd`, city: 'BUFORD', state: 'GA', zip: '30518',
  lat: DEPOT.lat + (6 + i * 5) * DEG, lng: DEPOT.lng + (base % 2 ? 0.05 : -0.05) + (i % 2 ? 0.01 : -0.01),
  cartons: 1, volume: 0, weight: 250,
  status: '10', normalizedStatus: 'PLANNED', stopType: 'DL',
  loadNbr: route, routeName: route, routeSeq: i + 1,
  driverName: 'TEST DRIVER', driverUserName: 'tdriver', matchKey: `${route}_${i}`,
}));
const SAVED = load('SAVED 1', 71911);
const OTHER = load('OTHER 1', 71912);
const ROSTER = [
  { loadId: 'ld-saved-1', name: 'SAVED 1', loadNbr: 'DAVIS000199101', status: 'Planned', driver: 'TEST DRIVER', trips: 4 },
  { loadId: 'ld-other-1', name: 'OTHER 1', loadNbr: 'DAVIS000199102', status: 'Planned', driver: 'TEST DRIVER', trips: 4 },
];
// What the board serves. `laterScan` = a scan that ran AFTER the save and found SAVED 1 in a
// different order in NuVizz (someone changed it in the portal) — the plan overlay yields to it.
let laterScan = false;
const boardStops = () => (laterScan
  ? [...SAVED.map((s, i) => ({ ...s, routeSeq: [2, 1, 3, 4][i] })), ...OTHER]
  : [...SAVED, ...OTHER]);

try { if (!(await stat(DIST)).isDirectory()) throw new Error('nd'); }
catch { console.error(`no build at ${DIST} — run \`npm run build\` first`); process.exit(1); }

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404).end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const context = await browser.newContext(MOBILE
  ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  : { viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Every function answers and none of them is NuVizz. The ONE write this run makes is answered
// here with the shape a confirmed commitBoard returns (per-load ok + a fired step).
const writes = [];
await context.route('**/.netlify/functions/**', async (route) => {
  const req = route.request();
  const u = req.url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (u.includes('nuvizz-pull-today-stops')) {
    const stops = boardStops();
    return json({ ok: true, stops, count: stops.length, source: 'fixture', ...(laterScan ? { lastScannedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() } : {}) });
  }
  if (u.includes('nuvizz-loads-roster')) {
    const date = new URL(u).searchParams.get('date');
    return json({ ok: true, date, source: 'cache', at: `${date}T12:00:00Z`, count: ROSTER.length, loads: ROSTER, shells: null });
  }
  if (u.includes('route-departures')) return json({ ok: true, published: false, usedByBoard: false, table: null });
  if (u.includes('travel-model')) return json({ ok: true, legs: {}, legCount: 0, googleEnabled: false });
  if (u.includes('/nuvizz-write') && req.method() === 'POST') {
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch { /* keep {} */ }
    if (body.op === 'commitBoard') {
      writes.push(body);
      const loads = (body.payload?.loads || []).map((L) => ({ ok: true, loadNbr: L.loadNbr ?? null, loadId: L.loadId ?? null, steps: [{ op: 'rwbSave', ok: true }] }));
      return json({ ok: true, op: 'commitBoard', tenant: 'TEST', live: true, dryRun: false, result: { ok: true, loads, orphaned: [] }, callsUsed: 2 });
    }
    return json({ ok: true, op: body.op, result: { ok: true, drivers: [] } });
  }
  return json({ ok: true, stops: [], rows: [], results: [], items: [], entries: [], count: 0 });
});
for (const host of ['googleapis.com', 'gstatic.com', 'google.com']) await context.route(`**://*.${host}/**`, (r) => r.abort());

const toRouting = async () => {
  if (MOBILE) {
    await page.locator('[data-phone-menu-trigger], header button').first().click().catch(() => {});
    await page.waitForTimeout(900);
  }
  await page.getByText('Routing (beta)', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1600);
  if (MOBILE) { await page.getByRole('button', { name: /stops$/i }).first().click().catch(() => {}); await page.waitForTimeout(500); }
};
const openLoad = async (name) => {
  const loadsTab = page.getByRole('button', { name: /^Loads/ }).first();
  if (await loadsTab.isVisible().catch(() => false)) { await loadsTab.click().catch(() => {}); await page.waitForTimeout(900); }
  await page.getByText(new RegExp(`^${name}$`)).first().click().catch(() => {});
  await page.waitForTimeout(1500);
};
// The mark on ONE card, found from that card's own name — never another card's.
const markOn = (name) => page.evaluate((nm) => {
  const title = [...document.querySelectorAll('span[title]')].find((s) => s.getAttribute('title') === nm && (s.textContent || '').trim() === nm);
  let card = title;
  while (card && !(card.className && typeof card.className === 'string' && card.className.includes('rounded-lg') && card.className.includes('shrink-0'))) card = card.parentElement;
  if (!card) return { open: false };
  const chip = card.querySelector('[data-card-saved]');
  return { open: true, kind: chip ? chip.getAttribute('data-card-saved') : null, text: chip ? (chip.textContent || '').trim() : null };
}, name);
const reverse = (name) => page.evaluate((nm) => {
  const title = [...document.querySelectorAll('span[title]')].find((s) => s.getAttribute('title') === nm && (s.textContent || '').trim() === nm);
  let card = title;
  while (card && !card.querySelector('select')) card = card.parentElement;
  const sel = card?.querySelector('select');
  if (!sel) return false;
  document.querySelectorAll('[data-verify-reseq]').forEach((e) => e.removeAttribute('data-verify-reseq'));
  sel.setAttribute('data-verify-reseq', '1');
  return true;
}, name).then(async (found) => { if (found) await page.selectOption('select[data-verify-reseq="1"]', 'reverse').catch(() => {}); await page.waitForTimeout(800); return found; });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1600);
await toRouting();

// 1. OPEN, UNSENT: nothing to say.
await openLoad('SAVED 1');
let m = await markOn('SAVED 1');
if (m.open && m.kind == null) ok('SAVED 1 opens in Compare and, never sent, carries no mark');
else bad(`SAVED 1 on open: ${JSON.stringify(m)}`);

// 2. CHANGE IT AND SEND. The message on the card that just saved is the v1.37.0 one, unchanged.
await reverse('SAVED 1');
await page.getByRole('button', { name: /Send to NuVizz/i }).first().click().catch(() => {});
await page.waitForTimeout(1800);
m = await markOn('SAVED 1');
if (writes.length === 1) ok('Send made exactly one (stubbed) commitBoard write');
else bad(`expected one commitBoard write, saw ${writes.length}`);
const sent = writes[0]?.payload?.loads?.[0] || {};
if (sent.loadNbr === 'DAVIS000199101' || sent.loadId === 'ld-saved-1') ok(`the card took its load from the roster (${sent.loadNbr || '—'} / ${sent.loadId || '—'}), as real cards do`);
else bad(`the save carried no roster identity: ${JSON.stringify({ loadNbr: sent.loadNbr, loadId: sent.loadId })}`);
if (m.kind === 'sent' && /^✓ SENT \d{1,2}:\d{2} (AM|PM)$/.test(m.text || '')) ok(`the card that just saved keeps its message: "${m.text}"`);
else bad(`after the save the card reads ${JSON.stringify(m)} — expected "✓ SENT h:mm"`);

// 3. CLOSE IT AND BRING IT BACK.
await page.getByRole('button', { name: 'Close route SAVED 1' }).first().click().catch(() => {});
await page.waitForTimeout(900);
if (!(await markOn('SAVED 1')).open) ok('the card closes');
else bad('the SAVED 1 card did not close');
await openLoad('SAVED 1');
m = await markOn('SAVED 1');
if (EXPECT_OFF) {
  if (m.open && m.kind == null) ok('switch off: the reopened card says nothing, exactly as before');
  else bad(`switch off: the reopened card reads ${JSON.stringify(m)}`);
} else if (m.kind === 'saved-before' && (MOBILE ? /^✓ \d{1,2}:\d{2} (AM|PM)$/.test(m.text || '') : m.text === '✓')) {
  // Desktop: the bare check (when is on hover). Phone: no hover, so the chip carries the time.
  ok(`closed and brought back, the route carries the green ✓ ("${m.text}")`);
}
else bad(`reopened, the card reads ${JSON.stringify(m)} — expected the green ✓${MOBILE ? ' with its time' : ''}`);
if (process.env.SHOT) { await page.screenshot({ path: process.env.SHOT }); ok(`screenshot ${process.env.SHOT}`); }

if (!EXPECT_OFF) {
  // 4. EDIT IT: the ✓ goes, because the card no longer matches the board it was rebuilt from.
  await reverse('SAVED 1');
  m = await markOn('SAVED 1');
  if (m.open && m.kind == null) ok('an edit takes the ✓ away until the next send');
  else bad(`after an edit the card still reads ${JSON.stringify(m)}`);

  // 5. RELOAD THE PAGE: the record outlives the tab.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await toRouting();
  await openLoad('SAVED 1');
  m = await markOn('SAVED 1');
  if (m.kind === 'saved-before') ok('after a page reload the reopened route still carries the ✓');
  else bad(`after a reload the card reads ${JSON.stringify(m)}`);

  // 6. CHANGED IN NUVIZZ SINCE: a later scan shows the route in another order. The card is rebuilt
  //    from that board, no longer shows what was sent, and must not vouch for it.
  await page.getByRole('button', { name: 'Close route SAVED 1' }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  laterScan = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1600);
  await toRouting();
  await openLoad('SAVED 1');
  m = await markOn('SAVED 1');
  if (m.open && m.kind == null) ok('changed in NuVizz since the save (a later scan), the reopened card carries no ✓');
  else bad(`after a later scan changed the route, the card reads ${JSON.stringify(m)}`);
}

// 7. A LOAD NOBODY SAVED SAYS NOTHING — the record is per load, and this is another load.
await openLoad('OTHER 1');
m = await markOn('OTHER 1');
if (m.open && m.kind == null) ok('a load nobody saved carries no mark');
else bad(`OTHER 1 (never sent) reads ${JSON.stringify(m)}`);

if (errors.length) bad(`page errors: ${errors.slice(0, 3).join(' | ')}`);
else ok('no page errors');

clearTimeout(watchdog);
await browser.close();
server.close();
server.closeAllConnections?.();
console.log(fails.length ? `\n✗ ${fails.length} check(s) failed` : `\n✓ saved-before ✓ verified in a real browser (${MOBILE ? 'phone' : 'desktop'}${EXPECT_OFF ? ', switch off' : ''})`);
process.exit(fails.length ? 1 : 0);
