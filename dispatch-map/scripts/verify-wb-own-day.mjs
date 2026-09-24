// verify-wb-own-day.mjs — A ROUTE IN THE ROUTES PANEL OPENS IN COMPARE, EVEN WHEN NUVIZZ DATED IT YESTERDAY.
//
// Chad, 2026-09-24: "if its panel for routes it should load." ESTES APPT sat in the Routes panel
// and the Compare card refused it: its load (DAVIS000204757) is on the PREVIOUS day's roster,
// because NuVizz still dates its stops the day before. This drives the real bundle: a board with
// ESTES APPT (stops dated yesterday, no load id) and ALPHA (an ordinary route on today's roster),
// both clicked in the Routes panel, and every roster request recorded — so the guard proves the
// card opened AND that the earlier day was read from the stored copy only (cacheOnly=1).
//
//   node scripts/verify-wb-own-day.mjs [distDir]    CHROMIUM_PATH, SMOKE_PORT (default 8814)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8814;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
try { if (!(await stat(DIST)).isDirectory()) throw new Error('nd'); } catch { console.error(`no build at ${DIST}`); process.exit(1); }

const etDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = etDay(new Date());
const YDAY = new Date(Date.parse(TODAY + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);

const stop = (nbr, route, seq, lat, lng, extra = {}) => ({
  stopNbr: nbr, pro: nbr, pros: [nbr], primaryPro: nbr, businessName: `CUST ${nbr}`, addr1: `${seq} Main St`, city: 'BUFORD', state: 'GA', zip: '30518',
  routeName: route, loadNbr: route, routeSeq: seq, lat, lng, isPlanned: true, isUnplanned: false, status: '20', normalizedStatus: 'SCHEDULED',
  stopType: 'DL', pallets: 1, weight: 500, boardDate: TODAY, scheduledDate: TODAY, source: 'nuvizz-list', ...extra,
});
const STOPS = [
  // ESTES APPT exactly as on 2026-09-24: NuVizz dates the stops YESTERDAY, no load id on any stop.
  stop('ESTES-0408714489', 'ESTES APPT', 1, 34.00, -84.10, { boardDate: YDAY }),
  stop('ESTES-0498235193', 'ESTES APPT', 2, 34.02, -84.12, { boardDate: YDAY }),
  // An ordinary route — on today's roster — which must keep opening exactly as it always has.
  stop('007190001', 'ALPHA', 1, 34.10, -84.00, { loadId: 'id-alpha' }),
  stop('007190002', 'ALPHA', 2, 34.12, -84.02, { loadId: 'id-alpha' }),
];
const ROSTER_TODAY = [{ loadId: 'id-alpha', name: 'ALPHA', loadNbr: 'DAVIS000300001', status: 'Draft', driver: '', trips: 2 }];
const ROSTER_YDAY = [
  { loadId: 'id-appt', name: 'ESTES APPT', loadNbr: 'DAVIS000204757', status: 'Draft', driver: '', trips: 5 },
  { loadId: 'id-estes', name: 'ESTES', loadNbr: 'DAVIS000204659', status: 'Completed', driver: '', trips: 4 },
];

const server = createServer(async (req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch { /* next */ }
  }
  res.writeHead(404).end('nf');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
// The Routes panel is a saved gear setting ('routesLoads', the layout in Chad's screenshot).
await page.addInitScript(() => { try { localStorage.setItem('routing.rightPanel', 'routesLoads'); } catch { /* ignore */ } });
const rosterAsks = [];
await page.route('**/*', async (route) => {
  const url = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes('maps.googleapis.com')) return;                 // held: nothing here needs Google
  if (url.includes('/.netlify/functions/nuvizz-loads-roster')) {
    const u = new URL(url); const date = u.searchParams.get('date');
    rosterAsks.push({ date, cacheOnly: u.searchParams.get('cacheOnly') === '1', live: u.searchParams.get('live') === '1' });
    const loads = date === TODAY ? ROSTER_TODAY : date === YDAY ? ROSTER_YDAY : [];
    return json({ ok: true, date, source: 'cache', at: `${date}T12:00:00Z`, count: loads.length, loads, shells: null });
  }
  if (url.includes('/.netlify/functions/nuvizz-pull-today-stops')) return json({ ok: true, date: TODAY, source: 'index', stops: STOPS, lastScannedAt: new Date().toISOString() });
  if (url.includes('/.netlify/functions/')) return json({ ok: true, stops: [], entries: [], items: [], rows: [], results: [], loads: [], count: 0 });
  if (url.startsWith(`http://127.0.0.1:${PORT}`)) return route.continue();
  return route.abort();
});

const fail = (m) => { console.error(`✗ ${m}`); process.exitCode = 1; };
const cards = () => page.getByRole('button', { name: /Cancel route/ }).count();
const bodyText = () => page.evaluate(() => document.body.innerText);
// The route's title in the Routes panel — exact text, so ESTES never matches ESTES APPT.
const routeRow = (name) => page.getByText(name, { exact: true }).first();

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /^Routing( \(beta\))?$/ }).first().click();
  await routeRow('ESTES APPT').waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  const before = await cards();

  // THE CASE: ESTES APPT, clicked in the Routes panel.
  await routeRow('ESTES APPT').click();
  await page.waitForTimeout(1500);
  const afterAppt = await cards();
  const t1 = await bodyText();
  console.log('ESTES APPT', JSON.stringify({ cardsBefore: before, cardsAfter: afterAppt, opened: /on NuVizz load DAVIS000204757/.test(t1), refused: /has no NuVizz load/.test(t1) }));
  if (afterAppt !== before + 1) fail('ESTES APPT did not open a Compare card');
  if (!/Opened "ESTES APPT" on NuVizz load DAVIS000204757/.test(t1)) fail('the card did not say which load it opened on, and that NuVizz dates it the day before');
  if (/has no NuVizz load/.test(t1)) fail('the old refusal is still showing');

  // THE CONTROL: an ordinary route still opens, with no look-back at all.
  const asksBefore = rosterAsks.length;
  await routeRow('ALPHA').click();
  await page.waitForTimeout(1200);
  if ((await cards()) !== afterAppt + 1) fail('ALPHA (an ordinary route) did not open');
  if (rosterAsks.slice(asksBefore).some((a) => a.date === YDAY)) fail('opening an ordinary route read another day\'s roster');

  // THE COST: the earlier day was read, and only from the stored copy.
  const ydayAsks = rosterAsks.filter((a) => a.date === YDAY);
  console.log('roster asks for yesterday', JSON.stringify(ydayAsks));
  if (!ydayAsks.length) fail('the earlier day\'s roster was never asked for');
  if (ydayAsks.some((a) => !a.cacheOnly || a.live)) fail('the earlier day was read WITHOUT cacheOnly=1 — that read could spend a NuVizz call');

  if (!process.exitCode) console.log('✓ a Routes-panel route NuVizz dates the day before opens in Compare on its own load; an ordinary route is unchanged; nothing was read live');
} finally {
  await browser.close();
  server.close();
}
