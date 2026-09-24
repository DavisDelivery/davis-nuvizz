// verify-engine-map.mjs — THE ENGINE SCREEN'S ROUTE MAP IS DRAWN INTO THE DIV ON SCREEN.
//
// Chad, 2026-09-24, on Engine → Sequencing with BEN 2 selected: "Map is missing on bottom
// right hand corner." The panel was its own light-grey background with nothing in it.
//
// The Sequencing view is conditionally mounted. Switching to Assignment unmounts the map's
// <div>; switching back mounts a NEW one. The map was created once per EngineScreen mount
// (effect deps [google], and it bails while mapRef already holds a map), so the old map stayed
// bound to a <div> no longer on the page and the new one was never filled. Every later
// polyline and pin was drawn into the detached map.
//
// Google's real script cannot load in CI or the sandbox, and it is not what is under test. The
// question is WHICH ELEMENT the map is created in, so Maps is answered with a stand-in that
// records exactly that: every `new google.maps.Map(el)` tags `el`. The guard then asks the
// on-screen panel whether a map lives in it, on first entry and after a tab round-trip.
//
//   node scripts/verify-engine-map.mjs [distDir]    (a build made WITH a Maps key, any value)
//     CHROMIUM_PATH  browser binary   SMOKE_PORT  port (default 8806)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8806;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

try { if (!(await stat(DIST)).isDirectory()) throw new Error('nd'); }
catch { console.error(`no build at ${DIST}`); process.exit(1); }

// A board day with one route: enough for the table, the selection and the map to have work.
const DATE = '2026-09-23';
const stop = (i, lat, lng, proposed) => ({ pro: `00718000${i}`, businessName: `CUST ${i}`, lat, lng, actual_pos: i, proposed_pos: proposed });
const ROUTE = {
  load_key: 'BEN 2', driver_name: 'Ben Paintsil', truck_class: 'box_truck', stop_count: 4, zones_count: 3,
  score: 0.452, travel_min_actual_est: 100, travel_min_proposed_est: 132.6, unguided: false, reference_date: '2026-09-22',
  stops: [stop(1, 34.05, -84.10, 2), stop(2, 34.00, -84.20, 1), stop(3, 33.95, -84.25, 4), stop(4, 33.90, -84.30, 3)],
};
const DAILY = { ok: true, engine_version: 'v2.13.0', days: [{ date: DATE, mean_score: 0.116, mean_score_guided: 0.114, routes_scored: 1 }] };
const DAY = { ok: true, date: DATE, rollup: { routes_scored: 1, mean_score: 0.116, mean_score_guided: 0.114, mean_score_unguided: null, median_score: 0.091, unguided_count: 0 }, routes: [ROUTE] };

// The stand-in for Google's script. Answers the loader's bootstrap callback, and makes every
// constructor it has not been told about a permissive no-op, so the rest of the app can run.
const FAKE_MAPS = `(() => {
  const g = window.google = window.google || {}; const m = g.maps = g.maps || {};
  const inst = () => new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => 0 : inst()), apply: () => inst(), construct: () => inst() });
  let n = 0;
  class Map { constructor(el) { n += 1; this.el = el; el.setAttribute('data-guard-map', String(n)); const d = document.createElement('div'); d.className = 'gm-style'; el.appendChild(d); }
    fitBounds() {} setCenter() {} setZoom() {} panTo() {} setOptions() {} getZoom() { return 10; } getDiv() { return this.el; }
    getCenter() { return { lat: () => 34, lng: () => -84 }; } getBounds() { return null; } addListener() { return { remove() {} }; } }
  class LatLngBounds { constructor() { this.n = 0; } extend() { this.n += 1; return this; } isEmpty() { return this.n === 0; } }
  // Pins and lines remember which map they are ON, so the guard can ask whether the route was
  // drawn into the map Chad can see — a map in the panel with the route drawn elsewhere is the
  // same blank screen.
  const live = new Set();
  class Shape { constructor(o) { this.o = o || {}; this.map = null; if (this.o.map) this.setMap(this.o.map); }
    setMap(mp) { this.map = mp || null; if (this.map) live.add(this); else live.delete(this); }
    setOptions() {} addListener() { return { remove() {} }; } getPath() { return inst(); } }
  window.__guardShapesIn = (el) => [...live].filter((x) => x.map && x.map.el === el).length;
  const known = { Map, LatLngBounds, Marker: Shape, Polyline: Shape, Polygon: Shape, Circle: Shape,
    Size: class { constructor(w, h) { this.width = w; this.height = h; } }, Point: class { constructor(x, y) { this.x = x; this.y = y; } },
    LatLng: class { constructor(a, b) { this.a = a; this.b = b; } lat() { return this.a; } lng() { return this.b; } },
    event: { trigger() {}, addListener() { return { remove() {} }; }, addListenerOnce() { return { remove() {} }; }, removeListener() {}, clearInstanceListeners() {} } };
  const ib = m.__ib__;
  // 'then' MUST read undefined: the loader resolves a promise WITH this namespace, and a
  // namespace that answers .then is taken for a thenable that never settles.
  const ns = new Proxy(Object.assign(m, known), { get: (t, p) => (p === 'then' ? undefined : p in t ? t[p] : (typeof p === 'string' && /^[A-Z]/.test(p) ? class { constructor() { return inst(); } } : inst())) });
  g.maps = ns; ns.importLibrary = async () => ns;
  window.__guardMapCount = () => n;
  if (typeof ib === 'function') ib();
})();`;

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
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e).slice(0, 200)));

// Google's script is HELD until the browser is on the Engine screen. The default Map screen and
// the Build screen also ask for it on the way in, and a stand-in thin enough to write here is
// not a whole Maps SDK — those screens are not under test, and both unmount when you leave
// them (the App's screen switch is a ternary), so releasing the script late means only the
// screen under test ever receives `google`.
let release;
const onEngine = new Promise((r) => { release = r; });

await page.route('**/*', async (route) => {
  const url = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes('maps.googleapis.com/maps/api/js')) { await onEngine; return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_MAPS }); }
  if (url.includes('/.netlify/functions/routing-engine-data')) return json(/view=day/.test(url) ? DAY : DAILY);
  if (url.includes('/.netlify/functions/')) return json({ ok: true, stops: [], entries: [], items: [], rows: [], results: [], days: [], count: 0 });
  if (url.startsWith(`http://127.0.0.1:${PORT}`)) return route.continue();
  return route.abort();   // nothing leaves the machine
});

const fail = (msg) => { console.error(`✗ ${msg}`); if (pageErrors.length) console.error('  page errors:', pageErrors.slice(0, 5)); process.exitCode = 1; };

// The panel under test: the one that says whose route it is. Asked from the page, not guessed.
const panel = () => page.evaluate(() => {
  const el = document.querySelector('div.h-\\[320px\\]');
  if (!el || !el.isConnected) return { onScreen: false };
  const r = el.getBoundingClientRect();
  return { onScreen: r.width > 0 && r.height > 0, map: el.getAttribute('data-guard-map'), gm: !!el.querySelector('.gm-style'), maps: window.__guardMapCount?.() ?? null, drawn: window.__guardShapesIn?.(el) ?? 0 };
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /^Routing( \(beta\))?$/ }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^Engine$/ }).first().click();
  await page.getByText('Daily similarity').first().waitFor({ timeout: 20000 });
  await page.getByText('BEN 2 — Ben Paintsil').first().waitFor({ timeout: 20000 });
  release();
  await page.waitForFunction(() => (window.__guardMapCount?.() ?? 0) > 0, null, { timeout: 15000 })
    .catch(() => fail('Google never answered on the Engine screen — the stand-in did not load, so nothing below would mean anything'));
  await page.waitForTimeout(500);

  const first = await panel();
  console.log('first entry           ', JSON.stringify(first));
  if (!first.onScreen) fail('the route map panel is not on screen at all — the guard is not looking at what Chad looked at');
  else if (!first.gm) fail('first entry: no map in the route map panel');
  else if (!(first.drawn > 0)) fail('first entry: a map is in the panel but BEN 2 was not drawn on it');

  await page.getByRole('button', { name: /^Assignment$/ }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /^Sequencing$/ }).first().click();
  await page.getByText('BEN 2 — Ben Paintsil').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(700);

  const back = await panel();
  console.log('after Assignment ⇄   ', JSON.stringify(back));
  if (!back.onScreen) fail('after the round-trip the panel is not on screen');
  else if (!back.gm) fail('after Sequencing → Assignment → Sequencing the route map panel is EMPTY — the map is still bound to the unmounted <div> (Chad, 2026-09-24: "Map is missing on bottom right hand corner")');
  else if (!(back.drawn > 0)) fail('after the round-trip the panel has a map but BEN 2 is drawn somewhere else');

  if (!process.exitCode) console.log('✓ the Engine route map is drawn into the panel on screen, on entry and after a tab round-trip');
} finally {
  await browser.close();
  server.close();
}
