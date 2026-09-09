#!/usr/bin/env node
// scripts/perf-routing.mjs — HOW DOES THE ROUTING SCREEN FEEL ON A BUSY BOARD? Measured, not guessed.
//
// Chad, 2026-09-09: "Performance of the dispatch map especially the routing page is very slow
// and laggy right now." Every guard this app has looks at pixels, and the pixels were right;
// nothing measured TIME. This does. It serves the real built bundle with a synthetic N-stop
// board behind the Netlify function paths and a Google Maps stand-in (scripts/lib/maps-stub.js:
// Map/Marker/Polyline/OverlayView backed by real DOM nodes, deliberately cheaper than Google's
// renderer, so every number here is a LOWER bound on what our own code costs), drives it with
// TRUSTED mouse input through Playwright, and reads what the dispatcher feels:
//   • input→paint latency for hover and click, from the browser's own Event Timing API;
//   • main-thread long tasks per interaction;
//   • how many markers are torn down and rebuilt per interaction (a click that rebuilds 775
//     markers is a different fact from one that touches two);
//   • a CPU profile of the hover loop, attributed to named functions (build with minify off).
//
// What it found the day it was written: with the bottom grid OPEN on an 800-stop board, a hover
// cost ~390ms of blocked main thread and a click ~750ms, all of it in one useEffect declared
// with no dependency array (see useBottomGridHeightVar in src/App.jsx). After the fix: ~0ms and
// ~70ms. Numbers are machine-dependent, so this is a tool, not a CI gate — run it before and
// after a change to the Routing or Map screen and compare on the same machine.
//
// Usage: node scripts/perf-routing.mjs [distDir]     (default: dist — build with
//        `npx vite build --minify false` for readable profile names)
//   N=800 PLANNED_SHARE=0.45 GRID=open|closed HOVERS=25 PROFILE=0|1 PORT=8799
//   CHROMIUM_PATH  override the browser binary (default: Playwright's chromium)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.PORT) || 8799;
const N = Number(process.env.N) || 800;
const PLANNED_SHARE = Number(process.env.PLANNED_SHARE ?? 0.45);
const HOVERS = Number(process.env.HOVERS) || 25;
const GRID = process.env.GRID === 'open';
const PROFILE = process.env.PROFILE !== '0';
const STUB = await readFile(join(HERE, 'lib', 'maps-stub.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

// ── synthetic board ──────────────────────────────────────────────────────────
let seed = 42; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const CITIES = [['BUFORD', '30518'], ['LAWRENCEVILLE', '30043'], ['DULUTH', '30096'], ['NORCROSS', '30071'], ['GAINESVILLE', '30501'], ['CUMMING', '30040'], ['ATLANTA', '30318'], ['MARIETTA', '30060'], ['DACULA', '30019'], ['SUWANEE', '30024'], ['ALPHARETTA', '30004'], ['CARTERSVILLE', '30120']];
const ROUTES = ['ALPHA', 'ALPHA 2', 'ATL', 'SUW', 'SUW 2', 'GARY PITTS', 'MITCHELL', 'TAYLOR', 'LVILLE', 'NOR', 'STEVEN', 'OWUSU 1', 'JEAN', 'VICTOR', 'SCOTT', 'CHE', 'RASKO', 'CHRIS', 'BEN 2', 'PARAGON', 'METRO', 'DALTON', 'ROME', 'ATHENS', 'MACON'];
function makeStops(n, date) {
  const out = []; const planned = Math.round(n * PLANNED_SHARE); const seqByRoute = new Map();
  for (let i = 0; i < n; i++) {
    const isPlanned = i < planned; const r = i % ROUTES.length; const [city, zip] = CITIES[i % CITIES.length];
    const estes = i % 20 === 7; const noCoords = i % 33 === 5; const delivered = isPlanned && i % 9 === 0;
    const seq = (seqByRoute.get(r) || 0) + 1; seqByRoute.set(r, seq);
    const hh = 8 + Math.floor(seq / 3), mm = (seq * 17) % 60;
    out.push({
      stopNbr: estes ? `ESTES-05382${String(40000 + i)}` : `00${7100000 + i}`, stopId: `st${i}`, orderNbr: `ORD${i}`, pro: `PRO${100000 + i}`, primaryPro: `PRO${100000 + i}`, proCount: 1,
      businessName: `CUSTOMER ${i} ${['LLC', 'INC', 'CO', 'SUPPLY', 'FOODS'][i % 5]}`, addr1: `${100 + (i * 7) % 900} ${['INDUSTRIAL', 'COMMERCE', 'PEACHTREE', 'MAIN', 'BUFORD HWY'][i % 5]} ${['BLVD', 'DR', 'RD', 'ST', 'PKWY'][i % 5]}`, addr2: i % 11 === 0 ? 'STE 100' : '',
      city, state: 'GA', zip, contact: null, custRef: '', poRef: '', bol: '', shipmentNbr: `SH${i}`,
      lat: noCoords ? null : 34.12 + (rnd() - 0.5) * 0.9, lng: noCoords ? null : -84.0 + (rnd() - 0.5) * 1.1,
      cartons: 1 + (i % 6), pallets: 1 + (i % 10), weight: 200 + (i * 37) % 4800, volume: i % 4,
      status: delivered ? '90' : isPlanned ? '20' : '10', normalizedStatus: delivered ? 'DELIVERED' : isPlanned ? 'SCHEDULED' : 'UNPLANNED',
      isPlanned, isUnplanned: !isPlanned, deliveredDTTM: delivered ? `${date}T10:${String(mm).padStart(2, '0')}:00` : null,
      routeName: isPlanned ? ROUTES[r] : null, loadNbr: isPlanned ? `DAVIS000${198000 + r}` : null, loadId: isPlanned ? `ld${r}` : null, driverName: isPlanned ? `DRIVER ${r}` : null, driverUserName: isPlanned ? `driver${r}` : null,
      routeSeq: isPlanned ? seq : null, loadStopSeq: isPlanned ? seq : null, plannedEtaDTTM: isPlanned ? `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00` : null,
      scheduledDate: date, boardDate: date, requestedDate: date, stopType: 'DL', source: 'cache', signalSources: {}, orderInstructions: '', itemsSummary: '', stopDistance: 3.2, timeConstraint: null, terms: '', warehouse: 'BUFORD',
      raw: { load: isPlanned ? { loadId: `ld${r}`, loadNbr: `DAVIS000${198000 + r}` } : null, stopExecutionInfo: {}, stop: { from: null } },
    });
  }
  return out;
}
const rosterFor = () => ROUTES.map((name, r) => ({ name, loadNbr: `DAVIS000${198000 + r}`, loadId: `ld${r}`, status: r % 5 === 4 ? 'Draft' : 'Un-Planned', trips: 1 }));

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x'); const p = decodeURIComponent(url.pathname);
  const fn = p.match(/^\/(?:\.netlify\/functions|api)\/([^/]+)/)?.[1];
  if (fn) {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    if (fn === 'nuvizz-pull-today-stops') { const stops = makeStops(N, date); const at = new Date(Date.now() - 20 * 60000).toISOString(); return json({ ok: true, source: 'cache', stops, lastScannedAt: at, lastLoadScanAt: at, lastUnplannedScanAt: at, lastCompletedScanAt: at, scanState: null, ops: null, unplannedCount: stops.filter((s) => s.isUnplanned).length }); }
    if (fn === 'nuvizz-loads-roster') return json({ ok: true, source: 'cache', at: new Date().toISOString(), count: ROUTES.length, loads: rosterFor(), shells: null, date });
    if (fn === 'travel-model') return json({ ok: true, legs: {}, googleEnabled: false, legCount: 0 });
    if (fn === 'eta-flag-history') return json({ ok: true, rows: [] });
    if (fn === 'motive-drivers') return json({ ok: true, drivers: [] });
    return json({ ok: false, error: 'stubbed' });
  }
  for (const c of [join(DIST, p), join(DIST, 'index.html')]) {
    try { const b = await readFile(c); res.writeHead(200, { 'content-type': TYPES[extname(c)] || 'application/octet-stream' }); return res.end(b); } catch {}
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const exe = process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.route('**/maps.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB }));
await page.addInitScript(() => {
  window.__lt = []; window.__ev = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push({ s: e.startTime, d: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__ev.push({ n: e.name, s: e.startTime, d: e.duration, p: e.processingEnd - e.processingStart }); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); } catch {}
});
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/apiFetch|Failed to load resource|version.json/.test(m.text())) errors.push('console: ' + m.text().slice(0, 160)); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(800);
// Open Routing (beta)
const tClick = await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /routing/i.test((x.innerText || '').trim())); if (!b) return null; const t = performance.now(); b.click(); return t; });
if (tClick == null) { console.error('no Routing tab'); process.exit(1); }
const settle = async (label) => {
  // Wait for the marker count to hold still for 600ms.
  let last = -1, still = 0, t0 = Date.now();
  while (Date.now() - t0 < 20000) { const n = await page.evaluate(() => document.querySelectorAll('.pm-marker').length); if (n === last && n > 0) { still += 1; if (still >= 3) break; } else still = 0; last = n; await page.waitForTimeout(200); }
  return last;
};
const markers = await settle('initial');
const tReady = await page.evaluate(() => performance.now());
const ltInit = await page.evaluate((t) => window.__lt.filter((x) => x.s >= t), tClick);
const sum = (a) => a.reduce((x, y) => x + y.d, 0);
const fmt = (n) => (Math.round(n * 10) / 10).toString();
const stats = (arr) => { if (!arr.length) return 'n/a'; const s = [...arr].sort((a, b) => a - b); const mean = arr.reduce((a, b) => a + b, 0) / arr.length; return `mean ${fmt(mean)}ms · p50 ${fmt(s[Math.floor(s.length / 2)])}ms · max ${fmt(s[s.length - 1])}ms (n=${arr.length})`; };
console.log(`\n=== Routing screen · ${N} stops (${Math.round(PLANNED_SHARE * 100)}% planned) · grid ${GRID ? 'OPEN' : 'closed'} ===`);
console.log(`open→markers drawn: ${fmt(tReady - tClick)}ms · markers on map: ${markers} · long tasks during open: ${ltInit.length} totalling ${fmt(sum(ltInit))}ms (largest ${fmt(Math.max(0, ...ltInit.map((x) => x.d)))}ms)`);

if (GRID) {
  const ok = await page.evaluate(() => { const root = document.querySelector('[data-overlay-layer]'); const b = root && [...root.querySelectorAll('button')].find((x) => /^stops\b/i.test((x.innerText || '').trim())); if (!b) return false; b.click(); return true; });
  await page.waitForTimeout(1200);
  const rows = await page.evaluate(() => document.querySelectorAll('[data-overlay-layer] tbody tr').length);
  console.log(`bottom grid opened: ${ok} · rows rendered: ${rows}`);
}

// Candidate markers whose centre is actually hit-testable (not under a panel).
const targets = await page.evaluate((k) => {
  const out = [];
  for (const el of document.querySelectorAll('.pm-marker')) {
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
    const hit = document.elementFromPoint(x, y); if (hit && (hit === el || el.contains(hit))) out.push({ x, y });
    if (out.length >= k) break;
  }
  return out;
}, HOVERS + 12);
console.log(`hit-testable markers found: ${targets.length}`);

const cdp = await ctx.newCDPSession(page);
if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); }

// HOVER: move the real mouse onto a marker, then off it, and read the browser's own input→paint
// timing for the mouseover/mouseout plus the long tasks they triggered.
await page.mouse.move(5, 450);
await page.waitForTimeout(300);
const hoverLT = [], hoverWall = [];
const t0h = await page.evaluate(() => { window.__lt.length = 0; window.__ev.length = 0; return performance.now(); });
for (let i = 0; i < Math.min(HOVERS, targets.length); i++) {
  const t = targets[i];
  const a = await page.evaluate(() => performance.now());
  await page.mouse.move(t.x, t.y);
  await page.evaluate(() => new Promise((r) => { const t0 = performance.now(); const tick = () => { if (performance.now() - t0 > 350) return r(); setTimeout(tick, 16); }; tick(); }));
  const b = await page.evaluate(() => performance.now());
  const lt = await page.evaluate((a) => window.__lt.filter((x) => x.s >= a), a);
  hoverLT.push(sum(lt)); hoverWall.push(b - a);
  await page.mouse.move(5, 450);
  await page.waitForTimeout(120);
}
const evHover = await page.evaluate((t) => window.__ev.filter((e) => e.s >= t && /mouseover|mouseout|pointerover|pointerout|mousemove|pointermove/.test(e.n)), t0h);
let prof = null;
if (PROFILE) { prof = (await cdp.send('Profiler.stop')).profile; }
console.log(`\nHOVER (${HOVERS} markers):`);
console.log(`  long-task time per hover: ${stats(hoverLT)}`);
console.log(`  input→paint (Event Timing, ≥16ms only): ${stats(evHover.map((e) => e.d))}  [${evHover.length} slow input events]`);

// CLICK: selecting a stop.
const clickLT = [], clickReb = [];
for (let i = 0; i < 6 && HOVERS + i < targets.length; i++) {
  const t = targets[HOVERS + i];
  const a = await page.evaluate(() => { const r = { t: performance.now(), att: window.__pmAttached || 0, det: window.__pmDetached || 0 }; return r; });
  await page.mouse.click(t.x, t.y);
  await page.waitForTimeout(700);
  const b = await page.evaluate((a) => ({ lt: window.__lt.filter((x) => x.s >= a.t), att: (window.__pmAttached || 0) - a.att, det: (window.__pmDetached || 0) - a.det }), a);
  clickLT.push(sum(b.lt)); clickReb.push(`${b.det}↓/${b.att}↑`);
  await page.mouse.move(5, 450);
}
const evClick = await page.evaluate((t) => window.__ev.filter((e) => e.s >= t && /click|mousedown|mouseup|pointerdown|pointerup/.test(e.n)), t0h);
console.log(`\nCLICK (select a stop, 6 clicks):`);
console.log(`  long-task time per click: ${stats(clickLT)}`);
console.log(`  markers torn down/rebuilt per click: ${clickReb.join(', ')}`);
console.log(`  input→paint (Event Timing, ≥16ms only): ${stats(evClick.map((e) => e.d))}`);

// SILENT POLL: the 2-minute board re-read returns identical data as new objects.
const a = await page.evaluate(() => ({ t: performance.now(), att: window.__pmAttached || 0, det: window.__pmDetached || 0 }));
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await page.waitForTimeout(2500);
const b = await page.evaluate((a) => ({ lt: window.__lt.filter((x) => x.s >= a.t), att: (window.__pmAttached || 0) - a.att, det: (window.__pmDetached || 0) - a.det }), a);
console.log(`\nSILENT POLL (same board, re-read):`);
console.log(`  long tasks: ${b.lt.length} totalling ${fmt(sum(b.lt))}ms (largest ${fmt(Math.max(0, ...b.lt.map((x) => x.d)))}ms) · markers torn down/rebuilt: ${b.det}↓/${b.att}↑`);

if (prof) {
  // Aggregate self + inclusive time by function.
  const byId = new Map(prof.nodes.map((n) => [n.id, n])); const parent = new Map();
  for (const n of prof.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
  const self = new Map(); let total = 0;
  for (let i = 0; i < prof.samples.length; i++) { const d = (prof.timeDeltas[i] || 0) / 1000; total += d; self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + d); }
  const incl = new Map();
  for (const [id, t] of self) { let cur = id; const seen = new Set(); while (cur != null) { const n = byId.get(cur); const k = `${n.callFrame.functionName || '(anon)'} @ ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}`; if (!seen.has(k)) { incl.set(k, (incl.get(k) || 0) + t); seen.add(k); } cur = parent.get(cur); } }
  const selfByName = new Map();
  for (const [id, t] of self) { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} @ ${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}`; selfByName.set(k, (selfByName.get(k) || 0) + t); }
  const top = (m, k) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, k);
  console.log(`\nCPU PROFILE during the hover loop (${fmt(total)}ms sampled) — top self time:`);
  for (const [k, t] of top(selfByName, 14)) console.log(`  ${fmt(t).padStart(7)}ms  ${k}`);
  const comps = [...incl.entries()].filter(([k]) => /^[A-Z][A-Za-z0-9]+ @ /.test(k) && !/^\(/.test(k)).sort((x, y) => y[1] - x[1]).slice(0, 14);
  console.log(`\n  inclusive time by React component / capitalised function:`);
  for (const [k, t] of comps) console.log(`  ${fmt(t).padStart(7)}ms  ${k}`);
}
if (errors.length) console.log(`\npage errors (${errors.length}): ${errors.slice(0, 5).join(' | ')}`);
await browser.close(); server.close();
