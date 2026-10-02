#!/usr/bin/env node
// scripts/verify-tv-live-pins.mjs — does the wall's live map leave its pins alone when nothing changed?
//
// Chad, 2026-10-02, with a photo of the office television: "Why are my icons not right. They keep
// disappearing and reappearing." The board refreshes every two minutes and every refresh hands the
// Map a NEW stops array, changed or not; the pin effect took every pin off and built every pin
// again. Counted on the real bundle over Google's real map, an unchanged 813-stop board: 813 pins
// removed and 813 created, every two minutes. Google redraws a rebuilt board from nothing, and a
// 2020 television does that slowly enough to watch — the photograph is a wall caught mid-redraw.
//
// A unit test can pin the rule that decides "the same pin" (test/tv-pin-reuse.test.mjs). It cannot
// see whether the app APPLIES it: whether a refresh really leaves the glass alone, whether a changed
// stop really gets its new pin, whether a stop that left really comes off — or whether the kept
// board drifts from what a fresh build would draw. So this drives /tv on the real built bundle in a
// real browser, with Google answered by a stand-in that counts every pin built and taken off.
//
// Fails on the code before the fix: the unchanged refresh rebuilds every pin.
//
// Usage: node scripts/verify-tv-live-pins.mjs [distDir]   (build with a Maps key, as CI does)
//   CHROMIUM_PATH   browser binary   SMOKE_PORT   port (default 8820)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8820;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

const TODAY = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

const id = (n) => `0072${String(n).padStart(4, '0')}`;
const stop = (n, lat, lng, extra = {}) => ({
  _id: `davis__${id(n)}`, stopNbr: id(n), pro: id(n), primaryPro: id(n), pros: [id(n)],
  businessName: `CUSTOMER ${n}`, addr1: `${n} Main St`, city: 'Buford', state: 'GA', zip: '30518',
  lat, lng, status: '10', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false,
  loadNbr: `L${n % 20}`, routeName: `R${n % 20}`, driverName: `Driver ${n % 20}`, routeSeq: n, stopType: 'DO',
  boardDate: TODAY, scheduledDate: TODAY, pallets: 1, cartons: 0, volume: 1, weight: 500, enriched: true, ...extra,
});
// 300 stops over north Georgia, mixed on purpose — delivered, pickups and unplanned draw different
// icons, and a pin that "stays" must stay with its OWN icon. Two orders share a stop number, the
// shape a board really carries, so a key that cannot tell them apart would trade their pins.
const BOARD_A = Array.from({ length: 300 }, (_, i) => stop(
  i + 1, 33.62 + (i % 20) * 0.031, -84.62 + Math.floor(i / 20) * 0.047,
  i % 9 === 0 ? { normalizedStatus: 'DELIVERED', status: '60' }
    : i % 7 === 0 ? { stopType: 'PU' }
      : i % 5 === 0 ? { isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null, driverName: null } : {},
));
BOARD_A[11] = { ...BOARD_A[11], stopNbr: BOARD_A[10].stopNbr };
// The next refresh: three stops delivered (new icons), one stop gone, one stop new.
const CHANGED = [3, 4, 5];
const BOARD_B = BOARD_A
  .filter((s) => s.stopNbr !== id(40))
  .map((s) => (CHANGED.map(id).includes(s.stopNbr) ? { ...s, normalizedStatus: 'DELIVERED', status: '60' } : s))
  .concat([stop(301, 34.3, -84.0)]);
let board = BOARD_A;
let boardCalls = 0;

try { if (!(await stat(DIST)).isDirectory()) throw new Error('not a dir'); }
catch { console.error(`no build at ${DIST} — run \`npm run build\` first`); process.exit(1); }

const server = createServer(async (req, res) => {
  const path = decodeURIComponent((req.url || '/').split('?')[0]);
  for (const candidate of [join(DIST, path), join(DIST, 'index.html')]) {
    try {
      const body = await readFile(candidate);
      res.writeHead(200, { 'content-type': TYPES[extname(candidate)] || 'application/octet-stream' });
      return res.end(body);
    } catch { /* fall through */ }
  }
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// A stand-in google.maps, only as real as this check needs — but every Marker it builds is counted,
// every one taken off the map is counted, and each remembers exactly what it was built with.
const FAKE_MAPS = `
(function () {
  window.__pins = { made: 0, off: 0, all: [] };
  const evt = { addListenerOnce: () => ({ remove() {} }), addListener: () => ({ remove() {} }),
                trigger: () => {}, clearInstanceListeners: () => {} };
  class LatLng {
    constructor(lat, lng) { this._lat = typeof lat === 'object' ? lat.lat : lat; this._lng = typeof lat === 'object' ? lat.lng : lng; }
    lat() { return this._lat; } lng() { return this._lng; }
    toJSON() { return { lat: this._lat, lng: this._lng }; }
  }
  class LatLngBounds {
    constructor() { this.pts = []; }
    extend(p) { this.pts.push(p); return this; }
    isEmpty() { return !this.pts.length; }
    getCenter() { return new LatLng(34.05, -84.07); }
    getNorthEast() { return new LatLng(34.2, -83.9); }
    getSouthWest() { return new LatLng(33.9, -84.2); }
    contains() { return true; }
    union() { return this; }
    toJSON() { return { north: 34.2, south: 33.9, east: -83.9, west: -84.2 }; }
  }
  class FakeMap {
    constructor(div, opts) {
      this.div = div; this.opts = Object.assign({}, opts);
      this.center = (opts && opts.center) || { lat: 0, lng: 0 };
      this.zoom = (opts && opts.zoom) != null ? opts.zoom : 0;
      this.markers = new Set();
      this.controls = new Proxy({}, { get: (bag, pos) => bag[pos] || (bag[pos] = { push() {}, clear() {}, length: 0 }) });
    }
    setMapTypeId() {} setOptions(o) { Object.assign(this.opts, o); }
    getCenter() { const c = this.center; return { lat: () => c.lat, lng: () => c.lng, toJSON: () => ({ lat: c.lat, lng: c.lng }) }; }
    getZoom() { return this.zoom; } setCenter(c) { if (c) this.center = c; } setZoom(z) { this.zoom = z; } panTo(c) { this.setCenter(c); }
    fitBounds() {} getBounds() { return new LatLngBounds(); } getDiv() { return this.div; }
    addListener() { return { remove() {} }; } getProjection() { return null; } setTilt() {} setHeading() {}
  }
  class Marker {
    constructor(o) { this.opts = Object.assign({}, o || {}); this.map = null; window.__pins.made++; window.__pins.all.push(this); this.setMap(this.opts.map || null); }
    setMap(m) {
      if (m === null && this.map) window.__pins.off++;
      if (this.map && this.map.markers) this.map.markers.delete(this);
      this.map = m; if (m && m.markers) m.markers.add(this);
    }
    getMap() { return this.map; }
    setIcon(v) { this.opts.icon = v; } setZIndex(v) { this.opts.zIndex = v; } setOpacity(v) { this.opts.opacity = v; }
    setPosition(v) { this.opts.position = v; } setTitle(v) { this.opts.title = v; } setOptions(o) { Object.assign(this.opts, o); } setLabel() {}
    getTitle() { return this.opts.title; } getPosition() { const p = this.opts.position || {}; return new LatLng(p.lat, p.lng); }
    addListener() { return { remove() {} }; }
  }
  Marker.MAX_ZINDEX = 1000000;
  class Polyline { constructor(o) { this.opts = o || {}; } setMap() {} setOptions() {} addListener() { return { remove() {} }; } }
  class OverlayView {
    setMap(m) { this.map = m; if (m && this.onAdd) { try { this.onAdd(); } catch (e) {} } }
    getMap() { return this.map; }
    getPanes() { return { overlayMouseTarget: document.createElement('div'), floatPane: document.createElement('div'), overlayLayer: document.createElement('div') }; }
    getProjection() { return { fromLatLngToDivPixel: () => ({ x: 0, y: 0 }), fromDivPixelToLatLng: () => new LatLng(34, -84),
                               fromLatLngToContainerPixel: () => ({ x: 0, y: 0 }), fromContainerPixelToLatLng: () => new LatLng(34, -84) }; }
  }
  class Geocoder { geocode(_r, cb) { if (cb) cb([], 'ZERO_RESULTS'); return Promise.resolve({ results: [] }); } }
  const maps = {
    Map: FakeMap, Marker, Polyline, OverlayView, Geocoder, LatLng, LatLngBounds,
    Size: function (w, h) { this.width = w; this.height = h; },
    Point: function (x, y) { this.x = x; this.y = y; },
    ControlPosition: { RIGHT_BOTTOM: 9, TOP_LEFT: 1, TOP_RIGHT: 3, LEFT_TOP: 5, RIGHT_TOP: 7, BOTTOM_CENTER: 11, LEFT_BOTTOM: 6, RIGHT_CENTER: 8 },
    MapTypeId: { ROADMAP: 'roadmap', HYBRID: 'hybrid', SATELLITE: 'satellite', TERRAIN: 'terrain' },
    SymbolPath: { CIRCLE: 0 }, Animation: { DROP: 2, BOUNCE: 1 },
    event: evt,
    importLibrary: () => Promise.resolve(window.google.maps),
  };
  // MERGE, never replace: the loader parks its resolve callback on window.google.maps first.
  window.google = window.google || {};
  window.google.maps = Object.assign(window.google.maps || {}, maps);
})();
`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
// The wall's LIVE map — the mode this is about. (The picture mode draws its pins as HTML and is
// guarded by verify-tv-map.mjs.)
await ctx.addInitScript(() => { try { localStorage.setItem('dispatchMap.tvLiveMap', 'true'); } catch { /* private mode */ } });
const page = await ctx.newPage();
await page.route(/maps\.googleapis\.com/, async (route) => {
  const url = new URL(route.request().url());
  const cb = url.searchParams.get('callback') || '';
  const invoke = cb
    ? `try{ var f = "${cb}".split(".").reduce(function(o,k){ return o && o[k]; }, window); if (typeof f === "function") f(); }catch(e){ console.error("stub callback failed", e); }`
    : '';
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${FAKE_MAPS}\n${invoke}` });
});
await page.route('**/.netlify/functions/**', async (route) => {
  const url = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  // A FRESH serialisation every time, exactly as production answers: equal data, new objects.
  if (url.includes('nuvizz-pull-today-stops')) { boardCalls += 1; return json({ ok: true, stops: board, count: board.length, date: TODAY }); }
  if (url.includes('motive-driver-positions')) return json({ ok: true, drivers: [] });
  return json({ ok: true });
});
page.on('pageerror', (e) => bad(`uncaught page error: ${e.message}`));

const glass = () => page.evaluate(() => {
  const on = window.__pins.all.filter((m) => m.map);
  return {
    made: window.__pins.made, off: window.__pins.off, on: on.length,
    // What a viewer sees, pin by pin — name, place, picture, fade, stacking.
    drawn: on.map((m) => [m.opts.title, m.opts.position?.lat, m.opts.position?.lng, m.opts.icon?.url, m.opts.opacity, m.opts.zIndex ?? null].join('|')).sort(),
  };
});
// Tag every pin on the glass, so "kept" can be proved to be the SAME pin and not a lookalike.
const tagGlass = () => page.evaluate(() => { let n = 0; for (const m of window.__pins.all) if (m.map) m.__tag = ++n; return n; });
const taggedOnGlass = () => page.evaluate(() => window.__pins.all.filter((m) => m.map && m.__tag).length);
// The same refresh the 2-minute timer fires, asked for now.
const refresh = async () => {
  const before = boardCalls;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const t0 = Date.now();
  while (boardCalls === before && Date.now() - t0 < 10000) await page.waitForTimeout(100);
  if (boardCalls === before) { bad('the refresh never asked for the board — nothing below means anything'); return false; }
  await page.waitForTimeout(1500);
  return true;
};

console.log('\nTHE WALL KEEPS ITS PINS — /tv live map at 1920x1080');
await page.goto(`http://127.0.0.1:${PORT}/tv`, { waitUntil: 'domcontentloaded' });
const t0 = Date.now();
while (Date.now() - t0 < 20000) {
  const g = await page.evaluate(() => (window.__pins ? window.__pins.all.filter((m) => m.map).length : 0)).catch(() => 0);
  if (g >= BOARD_A.length) break;
  await page.waitForTimeout(250);
}
await page.waitForTimeout(1500);
const live = await page.evaluate(() => document.body.innerText.includes('LIVE MAP'));
const g0 = await glass();
if (!live) bad('the wall is not on its live map — the readout never said LIVE MAP, so this checked the wrong mode');
if (g0.on !== BOARD_A.length) bad(`expected ${BOARD_A.length} pins on the glass after load, found ${g0.on} — the check cannot start`);
else ok(`${g0.on} pins on the glass, one per stop, two orders on one stop number included`);

if (!fails.length) {
  // 1 — THE PHOTOGRAPH'S REFRESH: the same board again.
  const tagged = await tagGlass();
  if (await refresh()) {
    const g1 = await glass();
    const built = g1.made - g0.made; const removed = g1.off - g0.off;
    if (built === 0 && removed === 0) ok('an unchanged board refresh built 0 pins and took 0 off — the glass was left alone');
    else bad(`an unchanged board refresh rebuilt the wall: ${built} pins built, ${removed} taken off (want 0 and 0) — the flicker Chad photographed`);
    const still = await taggedOnGlass();
    if (still === tagged && g1.on === BOARD_A.length) ok(`all ${tagged} pins on the glass are the SAME pins as before the refresh`);
    else bad(`${still} of ${tagged} original pins survived the refresh; ${g1.on} on the glass`);
    if (g1.drawn.join('\n') === g0.drawn.join('\n')) ok('and the wall draws exactly what it drew before');
    else bad('the wall draws something different after a refresh that changed nothing');

    // 2 — A BOARD THAT MOVED: three delivered, one gone, one new.
    board = BOARD_B;
    if (await refresh()) {
      const g2 = await glass();
      const built2 = g2.made - g1.made; const removed2 = g2.off - g1.off;
      const want = CHANGED.length + 1;
      if (built2 === want && removed2 === want) ok(`a board with ${CHANGED.length} stops delivered, 1 gone and 1 new replaced exactly ${want} pins (built ${built2}, took off ${removed2})`);
      else bad(`a board with ${CHANGED.length} stops delivered, 1 gone and 1 new: built ${built2} and took off ${removed2} — want exactly ${want} and ${want}`);
      if (g2.on === BOARD_B.length) ok(`${g2.on} pins on the glass, one per stop on the new board`);
      else bad(`${g2.on} pins on the glass for a ${BOARD_B.length}-stop board`);
      const gone = g2.drawn.some((r) => r.startsWith('CUSTOMER 40|'));
      const added = g2.drawn.some((r) => r.startsWith('CUSTOMER 301|'));
      if (!gone && added) ok('the stop that left is off the glass, and the new stop is on it');
      else bad(`stop that left still drawn: ${gone}; new stop drawn: ${added}`);

      // 3 — KEPT IS NOT ALLOWED TO DRIFT: a fresh page building this board from nothing must draw
      // exactly what the kept wall draws, pin for pin.
      await page.reload({ waitUntil: 'domcontentloaded' });
      const t1 = Date.now();
      while (Date.now() - t1 < 20000) {
        const n = await page.evaluate(() => (window.__pins ? window.__pins.all.filter((m) => m.map).length : 0)).catch(() => 0);
        if (n >= BOARD_B.length) break;
        await page.waitForTimeout(250);
      }
      await page.waitForTimeout(1500);
      const g3 = await glass();
      if (g3.drawn.join('\n') === g2.drawn.join('\n')) ok(`a fresh build of the same board draws the same ${g3.on} pins, picture for picture, as the kept wall`);
      else {
        const a = new Set(g2.drawn); const b = new Set(g3.drawn);
        const onlyKept = [...a].filter((x) => !b.has(x)).slice(0, 3); const onlyFresh = [...b].filter((x) => !a.has(x)).slice(0, 3);
        bad(`the kept wall and a fresh build disagree — kept-only: ${onlyKept.join(' ; ') || 'none'} · fresh-only: ${onlyFresh.join(' ; ') || 'none'}`);
      }
    }
  }
}

await browser.close();
server.close();
if (fails.length) {
  console.error(`\n✗ ${fails.length} problem(s) with the wall's live pins`);
  process.exit(1);
}
console.log('\n✓ the wall keeps its pins: a refresh that changes nothing touches nothing, and a change touches only itself');
