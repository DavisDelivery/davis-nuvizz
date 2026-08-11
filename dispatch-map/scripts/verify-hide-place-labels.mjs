#!/usr/bin/env node
// scripts/verify-hide-place-labels.mjs — does "Hide place labels" ACTUALLY do something?
//
// Chad: "hiding place labels is not working." It wasn't: the app builds its maps with a
// cloud mapId, Google ignores the JS `styles` array on any map that has one, and on the
// roadmap base there is no label-free map type to fall back on. The switch moved and
// nothing behind it changed.
//
// A unit test can prove the OPTIONS are right (test/map-base-options.test.mjs). It cannot
// prove the app builds the map with them, that the rebuild the fix requires actually
// happens, or — the real risk — that the pins come back afterwards instead of leaving the
// dispatcher staring at an empty board. So this drives the real built bundle in a real
// browser with a FAKE google.maps that records every Map ever constructed, flips the
// toggle, and inspects what the app asked Google for.
//
// The bundle MUST be built with a mapId or this tests nothing:
//   VITE_GOOGLE_MAPS_API_KEY=test-key VITE_GOOGLE_MAP_ID=<any> npm run build
//
// Usage: node scripts/verify-hide-place-labels.mjs [distDir]
//   CHROMIUM_PATH   browser binary   SMOKE_PORT   port (default 8795)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8795;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

const TODAY = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };
// Neither pass nor fail: something this run could not exercise, said out loud.
const note = (m) => console.log(`  · ${m}`);

const stop = (n, lat, lng, extra = {}) => ({
  _id: `davis__00715${n}`, stopNbr: `00715${n}`, pro: `00715${n}`, primaryPro: `00715${n}`, pros: [`00715${n}`],
  businessName: `CUSTOMER ${n}`, addr1: `${n} Main St`, city: 'Buford', state: 'GA', zip: '30518',
  lat, lng, status: '10', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false,
  loadNbr: 'VINCENT', routeName: 'VINCENT', driverName: 'Vincent Bonzo', routeSeq: n, stopType: 'DO',
  boardDate: TODAY, scheduledDate: TODAY, pallets: 1, cartons: 0, volume: 1, weight: 500, enriched: true, ...extra,
});
const BOARD = [stop(1, 34.12, -84.00), stop(2, 34.05, -84.07), stop(3, 33.98, -84.15)];

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

// A fake google.maps that is only as real as this test needs — but records EVERY Map
// constructed, with the exact options the app passed, which is the whole point.
const FAKE_MAPS = `
(function () {
  window.__maps = [];
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
    // The real API has these; leaving them off made the app throw mid-check and the
    // rest of the run reported "could not reach…" for a page that had already died.
    contains() { return true; }
    union(b) { return this; }
    toJSON() { return { north: 34.2, south: 33.9, east: -83.9, west: -84.2 }; }
  }
  class FakeMap {
    constructor(div, opts) {
      this.div = div; this.opts = Object.assign({}, opts);
      this.mapId = opts && opts.mapId; this.type = opts && opts.mapTypeId;
      this.styles = opts && opts.styles;
      this.center = (opts && opts.center) || { lat: 0, lng: 0 };
      this.zoom = (opts && opts.zoom) != null ? opts.zoom : 0;
      this.markers = new Set(); this.overlays = new Set(); this.lines = new Set();
      this.controls = new Proxy({}, { get: () => ({ push() {}, clear() {}, length: 0 }) });
      window.__maps.push(this);
    }
    setMapTypeId(t) { this.type = t; }
    setOptions(o) { Object.assign(this.opts, o); if (o && 'styles' in o) this.styles = o.styles; }
    getCenter() { const c = this.center; return { lat: () => c.lat, lng: () => c.lng, toJSON: () => ({ lat: c.lat, lng: c.lng }) }; }
    getZoom() { return this.zoom; }
    setCenter(c) { this.center = c && c.lat !== undefined ? c : this.center; }
    setZoom(z) { this.zoom = z; }
    panTo(c) { this.setCenter(c); }
    fitBounds() {} getBounds() { return new LatLngBounds(); } getDiv() { return this.div; }
    addListener() { return { remove() {} }; }
    getProjection() { return null; } setTilt() {} setHeading() {}
  }
  class Marker {
    constructor(o) { o = o || {}; this.opts = o; this.map = null; this.setMap(o.map || null); }
    setMap(m) { if (this.map && this.map.markers) this.map.markers.delete(this); this.map = m; if (m && m.markers) m.markers.add(this); }
    getMap() { return this.map; }
    setIcon() {} setLabel() {} setZIndex() {} setPosition() {} setTitle() {} setOptions() {}
    getPosition() { const p = this.opts.position || {}; return new LatLng(p.lat, p.lng); }
    addListener() { return { remove() {} }; }
  }
  class Polyline {
    constructor(o) { o = o || {}; this.opts = o; this.map = null; this.setMap(o.map || null); }
    setMap(m) { if (this.map && this.map.lines) this.map.lines.delete(this); this.map = m; if (m && m.lines) m.lines.add(this); }
    setOptions() {} addListener() { return { remove() {} }; }
  }
  class OverlayView {
    setMap(m) { if (this.map && this.map.overlays) this.map.overlays.delete(this); this.map = m; if (m && m.overlays) m.overlays.add(this); if (m && this.onAdd) { try { this.onAdd(); } catch (e) {} } }
    getMap() { return this.map; }
    getPanes() { return { overlayMouseTarget: document.createElement('div'), floatPane: document.createElement('div') }; }
    getProjection() { return { fromLatLngToDivPixel: () => ({ x: 0, y: 0 }), fromDivPixelToLatLng: () => new LatLng(34, -84),
                               fromLatLngToContainerPixel: () => ({ x: 0, y: 0 }), fromContainerPixelToLatLng: () => new LatLng(34, -84) }; }
  }
  class Geocoder { geocode(_r, cb) { if (cb) cb([], 'ZERO_RESULTS'); return Promise.resolve({ results: [] }); } }
  const maps = {
    Map: FakeMap, Marker, Polyline, OverlayView, Geocoder, LatLng, LatLngBounds,
    Size: function (w, h) { this.width = w; this.height = h; },
    Point: function (x, y) { this.x = x; this.y = y; },
    ControlPosition: { RIGHT_BOTTOM: 9, TOP_LEFT: 1, TOP_RIGHT: 3, LEFT_TOP: 5, RIGHT_TOP: 7, BOTTOM_CENTER: 11 },
    SymbolPath: { CIRCLE: 0 }, Animation: { DROP: 2, BOUNCE: 1 },
    event: evt,
    importLibrary: (n) => Promise.resolve(window.google.maps),
  };
  // MERGE, never replace: @googlemaps/js-api-loader parks its resolve callback at
  // window.google.maps.__ib__ BEFORE injecting this script, so overwriting the namespace
  // throws the callback away and the loader promise never settles (the map is then never
  // built and this test silently proves nothing).
  window.google = window.google || {};
  window.google.maps = Object.assign(window.google.maps || {}, maps);
})();
`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();

// Serve our fake in place of the real Maps JS, and fire whatever callback the
// @googlemaps/js-api-loader asked for so its promise resolves.
await page.route(/maps\.googleapis\.com/, async (route) => {
  const url = new URL(route.request().url());
  // The callback is a DOTTED path (v1.16 uses "google.maps.__ib__"), so walk it rather
  // than looking for a bare global — that mistake is why the first run built no map.
  const cb = url.searchParams.get('callback') || '';
  const invoke = cb
    ? `try{ var f = "${cb}".split(".").reduce(function(o,k){ return o && o[k]; }, window); if (typeof f === "function") f(); }catch(e){ console.error("stub callback failed", e); }`
    : '';
  await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${FAKE_MAPS}\n${invoke}` });
});
await page.route('**/.netlify/functions/**', async (route) => {
  const url = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: BOARD, count: BOARD.length, date: TODAY });
  return json({ ok: true });
});
page.on('pageerror', (e) => bad(`uncaught page error: ${e.message}`));

const snapshot = () => page.evaluate(() => (window.__maps || []).map((m) => ({
  mapId: m.mapId || null,
  type: m.type,
  poiLabelsOff: Array.isArray(m.styles) && m.styles.some((s) => s.featureType === 'poi' && s.elementType === 'labels' && s.stylers?.[0]?.visibility === 'off'),
  styleCount: Array.isArray(m.styles) ? m.styles.length : null,
  center: m.center, zoom: m.zoom,
  markers: m.markers ? m.markers.size : 0,
  // The "Correct pin location" drag pin is the one marker a dispatcher is HOLDING when
  // they toggle. It is the only handle on the map in that mode, so if a rebuild orphans
  // it there is no way back short of reselecting the stop.
  draggable: m.markers ? [...m.markers].filter((k) => k.opts && k.opts.draggable).length : 0,
})));

const latest = async () => (await snapshot()).at(-1);

// One screen, end to end: it must start in the production shape (mapId, roadmap, pins),
// hide labels for real, keep the dispatcher's view and pins, and come back.
async function checkScreen(label) {
  console.log(`\n── ${label} ──`);
  await page.waitForTimeout(1200);

  // THE REPORTED CONFIGURATION: satellite OFF. That is the whole bug — with satellite on,
  // "hide labels" had a real lever (hybrid → satellite imagery, which carries no labels)
  // and appeared to work. On the roadmap base there is no label-free type, so the switch
  // moved and nothing happened. Routing defaults to satellite, so turn it off first.
  const filtersBtn = page.getByRole('button', { name: /^filters$/i }).first();
  if (!(await filtersBtn.isVisible().catch(() => false))) { bad(`${label}: could not find the Filters button`); return; }
  await filtersBtn.click(); await page.waitForTimeout(400);
  // Whichever "Satellite view" switch is actually on screen (desktop panel and mobile
  // drawer both render one). The panel stays OPEN for the rest of this check.
  const visibleSwitch = async (name) => {
    const all = page.getByRole('switch', { name });
    for (let i = 0; i < await all.count(); i++) {
      const s = all.nth(i);
      if (await s.isVisible().catch(() => false)) return s;
    }
    return null;
  };
  const sat = await visibleSwitch(/satellite view/i);
  if (sat) {
    if ((await sat.getAttribute('aria-checked')) === 'true') { await sat.click(); await page.waitForTimeout(1000); }
    (await sat.getAttribute('aria-checked')) === 'false'
      ? ok('satellite is off — the roadmap base from the report')
      : bad(`could not turn satellite off (aria-checked=${await sat.getAttribute('aria-checked')})`);
  } else { bad('no Satellite view switch on this screen'); }

  const first = await latest();
  if (!first) { bad(`${label}: the app never constructed a map — the google stub did not take`); return; }

  first.mapId
    ? ok(`starts on the cloud mapId (${first.mapId.slice(0, 8)}…) — the production shape this bug lives in`)
    : bad('this build has NO mapId, so it cannot reproduce the report — rebuild with VITE_GOOGLE_MAP_ID set');
  first.type === 'roadmap' ? ok('and on the roadmap base, as in the report') : bad(`expected roadmap, got ${first.type}`);
  const pins0 = first.markers;
  pins0 > 0 ? ok(`${pins0} pins are drawn on it`) : bad('no pins on the initial map — the fixture never reached this screen');

  // Move the view first: a rebuild that snaps back to the depot would be its own bug.
  await page.evaluate(() => { const m = window.__maps.at(-1); m.setCenter({ lat: 33.7490, lng: -84.3880 }); m.setZoom(13); });

  // The SWITCH, not the label beside it. Clicking the label text is a no-op — the first
  // run of this harness did exactly that and reported a fix that had never been exercised.
  const toggle = await visibleSwitch(/hide place labels/i);
  if (!toggle) { bad(`${label}: "Hide place labels" is not in the Filters panel`); return; }
  const wasOn = await toggle.getAttribute('aria-checked');
  wasOn === 'false' ? ok('the toggle starts off') : bad(`the toggle started at aria-checked=${wasOn} — expected false`);

  const countBefore = (await snapshot()).length;
  await toggle.click();
  await page.waitForTimeout(1800);
  (await toggle.getAttribute('aria-checked')) === 'true'
    ? ok('the switch flips on')
    : bad('the switch did not turn on — nothing below this line is being exercised');
  let maps = await snapshot();
  const after = maps.at(-1);

  maps.length > countBefore
    ? ok('turning it on rebuilt the map — the only way to shed a mapId, which is immutable once set')
    : bad('no new map was built, so the mapId is still in place and Google is still ignoring the style');

  !after.mapId
    ? ok('the new map carries NO mapId, so Google will honour a style at last')
    : bad('the new map STILL has the mapId — styles are ignored and the toggle still does nothing');
  after.poiLabelsOff
    ? ok('…and it is built with poi/transit labels OFF — this is the actual fix')
    : bad('the new map has no poi-labels-off style — the labels will still be there');
  after.type === 'roadmap'
    ? ok('still the roadmap base (the toggle declutters; it must not move you to satellite)')
    : bad(`the base changed to ${after.type} — the toggle must not switch the dispatcher's view`);
  after.markers >= pins0
    ? ok(`${after.markers} pins re-drawn on the rebuilt map`)
    : bad(`THE PINS ARE GONE (${after.markers} of ${pins0}) — a clean map with no stops is worse than the labels`);
  const kept = after.center && Math.abs(after.center.lat - 33.7490) < 0.01 && Math.abs(after.center.lng + 84.3880) < 0.01;
  kept ? ok('and it kept the view the dispatcher was on (no snap back to the depot)')
       : bad(`the rebuild moved the view to ${JSON.stringify(after.center)} — expected Atlanta`);
  after.zoom === 13 ? ok('zoom preserved too') : bad(`zoom became ${after.zoom}, expected 13`);

  // ...and back. A toggle you cannot undo is not a toggle.
  await toggle.click();
  await page.waitForTimeout(1800);
  const back = await latest();
  back?.mapId ? ok('turning it back off restores the cloud mapId (vector map, tilt/rotate, cloud style)')
              : bad('turning it off did NOT restore the mapId — the map is stuck on the plain base');
  back && !back.poiLabelsOff ? ok('and the label style is cleared, not left stuck on') : bad('the poi style survived turning the toggle off');
  back?.markers >= pins0 ? ok(`${back.markers} pins survived the second rebuild`) : bad('the pins vanished on the way back');
}

console.log('\n"Hide place labels" — live render check (roadmap base, mapId build)');
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

await checkScreen('Map tab');

// ── the drag pin, which is what makes the rebuild dangerous ──────────────────
// Correcting a pin puts you in a mode where ONE draggable marker is the whole
// interaction. Rebuild the map under it without re-binding and it silently disappears.
console.log('\n── "Correct pin location" survives the toggle ──');
{
  const row = await page.$('tbody tr');
  if (!row) bad('no stop row in the grid — could not enter pin-correction mode');
  else {
    await row.click(); await page.waitForTimeout(1200);
    const more = page.getByText(/Correct pin\b/i).first();       // the "More:" disclosure
    if (await more.isVisible().catch(() => false)) { await more.click(); await page.waitForTimeout(500); }
    const correct = page.getByRole('button', { name: /correct pin location/i }).first();
    if (!(await correct.isVisible().catch(() => false))) {
      bad('could not find "Correct pin location" — this path went unverified');
    } else {
      await correct.click(); await page.waitForTimeout(1200);
      const held = await latest();
      held?.draggable > 0 ? ok('the draggable pin is on the map') : bad('no draggable pin appeared — nothing to test');

      // Can a dispatcher actually toggle labels WHILE holding the pin? Find out by doing
      // it, rather than assuming either way. If the switch is reachable this is a live
      // path and gets a real assertion; if it is not, the rebind on that effect is
      // defensive only — and that is said out loud instead of quietly passing.
      const fb = page.getByRole('button', { name: /^filters$/i }).first();
      if (await fb.isVisible().catch(() => false)) { await fb.click(); await page.waitForTimeout(600); }
      const sw = page.getByRole('switch', { name: /hide place labels/i }).first();
      if (!(await sw.isVisible().catch(() => false))) {
        note('the Filters toggle is NOT reachable while a stop card is open, so labels cannot be flipped mid-correction — the rebind on that effect is defensive, not a live fix');
      } else {
        const n0 = (await snapshot()).length;
        await sw.click(); await page.waitForTimeout(1800);
        const after = await latest();
        if ((await snapshot()).length <= n0) {
          note('no rebuild happened here, so the drag pin was never at risk in this path');
        } else {
          after?.draggable > 0
            ? ok('THE DRAG PIN CAME BACK on the rebuilt map — not orphaned on the discarded one')
            : bad('the drag pin was left on the discarded map — correcting a pin breaks the moment you declutter');
        }
        await sw.click(); await page.waitForTimeout(1200);   // leave it as we found it
      }
    }
  }
}

// And the screen from the report — Chad's screenshot is Routing's Filters panel.
const routingTab = page.getByRole('button', { name: /routing/i }).first();
if (await routingTab.isVisible().catch(() => false)) {
  await routingTab.click();
  await page.waitForTimeout(2500);
  await checkScreen('Routing (beta) — the screen in the report');
} else {
  bad('could not reach the Routing tab — the reported screen went unverified');
}

await page.screenshot({ path: 'hide-place-labels-check.png', fullPage: false }).catch(() => {});
await browser.close();
server.close();

if (fails.length) { console.error(`\n✗ ${fails.length} check(s) failed\n`); process.exit(1); }
console.log('\n✓ "Hide place labels" verified in a real browser, on the roadmap base, with a mapId build\n');
