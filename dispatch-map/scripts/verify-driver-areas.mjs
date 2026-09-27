#!/usr/bin/env node
// scripts/verify-driver-areas.mjs — DOES THE "DRIVER AREAS" SWITCH DO WHAT IT SAYS, IN THE REAL BUNDLE?
//
// Chad, 2026-09-27: "find the circles we were working on for the new trainee learning to route to
// try and guide him to where drivers go and we were going to build an overlay for the map that we
// could toggle on and off."
//
// The unit tests pin the pieces (the rings, the name placement, the status words). They cannot
// prove the app wires them: that the switch is where a dispatcher looks on both views, that
// turning it on reads the rings once and draws every one of them without taking a click, that
// turning it off leaves NOTHING behind, that a map rebuild carries the rings across, that a
// failed read says so in red, and that the office wall never shows or reads any of it. This
// drives the real built bundle in a real browser with a stand-in google.maps that records every
// Circle and Polygon (a ring whose work runs along a road is drawn as an oval) and gives the name
// overlay real panes and a real projection, so the names are actually measured and placed.
//
// The bundle must be built with a Maps key or the app never asks for Maps at all:
//   VITE_GOOGLE_MAPS_API_KEY=test-key VITE_GOOGLE_MAP_ID=<any> npm run build
//
// Usage: node scripts/verify-driver-areas.mjs [distDir]
//   CHROMIUM_PATH   browser binary   SMOKE_PORT   port (default 8797)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8797;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};
const TODAY = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };

const stop = (n, lat, lng) => ({
  _id: `davis__00716${n}`, stopNbr: `00716${n}`, pro: `00716${n}`, primaryPro: `00716${n}`, pros: [`00716${n}`],
  businessName: `CUSTOMER ${n}`, addr1: `${n} Main St`, city: 'Buford', state: 'GA', zip: '30518',
  lat, lng, status: '10', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false,
  loadNbr: 'VINCENT', routeName: 'VINCENT', driverName: 'Vincent Bonzo', routeSeq: n, stopType: 'DO',
  boardDate: TODAY, scheduledDate: TODAY, pallets: 1, cartons: 0, volume: 1, weight: 500, enriched: true,
});
const BOARD = [stop(1, 34.12, -84.00), stop(2, 34.05, -84.07), stop(3, 33.98, -84.15)];

// A layer shaped exactly like ?format=layer: a dozen drivers over north Georgia, one of them
// working two areas, plus the drivers with no ring and the ones left out.
const PALETTE = ['#1f4e79', '#a4462d', '#3f7d3f', '#6b4a8a', '#8a6d1f', '#256b6b', '#8a3060', '#4a5a6b', '#2f6f9e', '#7a3b1e'];
const NAMES = ['Vincent Bonzo', 'Colin Calhoun', 'Denis Salkic', 'Anthony Bennett', 'Marcus Young', 'Che Roberts',
  'Darvin Cepeda', 'Scott Hart', 'Brent Bryd', 'Joe Gibbs', 'Tony Smith', 'Jeff Hudson'];
const LAYER = {
  ok: true, format: 'layer', generatedAt: `${TODAY}T11:00:00.000Z`,
  window: { from: '2026-08-31', to: TODAY, weeks: 4, businessDays: 20 },
  dataWindow: { from: '2026-08-31', to: '2026-09-25' },
  daysWithData: 19, readFailures: [],
  rings: NAMES.map((label, i) => ({
    key: label.toUpperCase().replace(/ /g, '_'), label, colour: PALETTE[i % PALETTE.length], stops: 300 - i * 10,
    circles: i === 2
      ? [{ lat: 33.45, lng: -84.15, radiusKm: 9 }, { lat: 34.25, lng: -83.6, radiusKm: 7 }]
      // Two drivers whose work runs along a road: their rings are OVALS (fitOval), drawn as Polygons.
      : i === 4 || i === 9
        ? [{ lat: 33.8 + (i % 4) * 0.12, lng: -84.35 + Math.floor(i / 4) * 0.18, radiusKm: 12, oval: { majorKm: 15, minorKm: 5, angleDeg: 35 + i * 10 } }]
        : [{ lat: 33.8 + (i % 4) * 0.12, lng: -84.35 + Math.floor(i / 4) * 0.18, radiusKm: 6 + (i % 5) * 3 }],
  })),
  noRing: [{ key: 'RASKO_SULJIC', label: 'Rasko Suljic', stops: 240, mapped: 240, why: 'spread out' }],
  excluded: [{ label: 'Terry Gambrell', why: 'stopped running', stops: 70, lastSeen: '2026-09-02', daysSince: 23 }],
  coverage: { deliveries: 11000, days: 19, drivers: 14, coordShare: 0.99 },
  rosterApplied: false, readMs: 1200, totalMs: 1400, nuvizzCalls: 0,
};
const RING_COUNT = LAYER.rings.reduce((t, r) => t + r.circles.length, 0);
const OVAL_COUNT = LAYER.rings.reduce((t, r) => t + r.circles.filter((c) => c.oval).length, 0);

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

// The stand-in google.maps — verify-hide-place-labels.mjs's, plus a recorded Circle and Polygon
// and an OverlayView with REAL panes inside the map's div and a real (flat) projection, so the
// name overlay really measures and places its names instead of drawing into nothing.
const FAKE_MAPS = `
(function () {
  window.__maps = []; window.__shapes = [];
  const evt = { addListenerOnce: () => ({ remove() {} }), addListener: () => ({ remove() {} }),
                trigger: () => {}, clearInstanceListeners: () => {}, removeListener: () => {} };
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
      this.mapId = opts && opts.mapId; this.type = opts && opts.mapTypeId; this.styles = opts && opts.styles;
      this.center = (opts && opts.center) || { lat: 34.0, lng: -84.1 };
      this.zoom = (opts && opts.zoom) != null ? opts.zoom : 10;
      if (this.div && this.div.querySelectorAll) for (const n of this.div.querySelectorAll('[data-fake-map-controls],[data-fake-panes]')) n.remove();
      this.markers = new Set(); this.overlays = new Set(); this.lines = new Set();
      this.controls = new Proxy({}, {
        get: (bag, pos) => {
          if (!bag[pos]) {
            const host = document.createElement('div');
            host.setAttribute('data-fake-map-controls', String(pos));
            host.style.cssText = 'position:absolute;right:0;bottom:0;z-index:5;display:flex;';
            (this.div || document.body).appendChild(host);
            const arr = [];
            bag[pos] = { push(el) { if (el) host.appendChild(el); return arr.push(el); }, clear() { host.textContent = ''; arr.length = 0; }, get length() { return arr.length; } };
          }
          return bag[pos];
        },
      });
      window.__maps.push(this);
    }
    panes() {
      if (!this._panes) {
        const root = document.createElement('div');
        root.setAttribute('data-fake-panes', '');
        root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
        const make = (n) => { const d = document.createElement('div'); d.setAttribute('data-pane', n); d.style.cssText = 'position:absolute;left:0;top:0;'; root.appendChild(d); return d; };
        this._panes = { mapPane: make('mapPane'), overlayLayer: make('overlayLayer'), markerLayer: make('markerLayer'), overlayMouseTarget: make('overlayMouseTarget'), floatPane: make('floatPane') };
        (this.div || document.body).appendChild(root);
      }
      return this._panes;
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
  // Every ring shape, in the order it was made — Circles and the ovals' Polygons in one list, so
  // "every halo before every ring" is checked across both kinds.
  class Shape {
    constructor(kind, o) { this.kind = kind; this.opts = Object.assign({}, o || {}); this.map = null; this.listeners = 0; this.setMap(this.opts.map || null); window.__shapes.push(this); }
    setMap(m) { this.map = m || null; }
    getMap() { return this.map; }
    setOptions(o) { Object.assign(this.opts, o); }
    addListener() { this.listeners++; return { remove() {} }; }
  }
  class Circle extends Shape { constructor(o) { super('Circle', o); } }
  class Polygon extends Shape { constructor(o) { super('Polygon', o); } }
  // A flat projection centred on the map: good enough to lay names out, which is the point.
  const proj = (map) => {
    const W = (map.div && map.div.offsetWidth) || 800, H = (map.div && map.div.offsetHeight) || 600;
    const c = map.center, k = 256 * Math.pow(2, map.zoom) / 360;
    const f = (ll) => { const lat = typeof ll.lat === 'function' ? ll.lat() : ll.lat; const lng = typeof ll.lng === 'function' ? ll.lng() : ll.lng;
      return { x: W / 2 + (lng - c.lng) * k, y: H / 2 - (lat - c.lat) * k * 1.2 }; };
    return { fromLatLngToDivPixel: f, fromLatLngToContainerPixel: f,
             fromDivPixelToLatLng: () => new LatLng(34, -84), fromContainerPixelToLatLng: () => new LatLng(34, -84) };
  };
  class OverlayView {
    setMap(m) {
      const was = this.map;
      if (was && was.overlays) was.overlays.delete(this);
      if (was && was !== m && this.onRemove) { try { this.onRemove(); } catch (e) { console.error('onRemove', e); } }
      this.map = m || null;
      if (m && m.overlays) m.overlays.add(this);
      if (m && this.onAdd) { try { this.onAdd(); if (this.draw) this.draw(); } catch (e) { console.error('onAdd/draw', e); } }
    }
    getMap() { return this.map; }
    getPanes() { return this.map && this.map.panes ? this.map.panes() : { overlayMouseTarget: document.createElement('div'), floatPane: document.createElement('div') }; }
    getProjection() { return this.map && this.map.panes ? proj(this.map) : { fromLatLngToDivPixel: () => ({ x: 0, y: 0 }), fromDivPixelToLatLng: () => new LatLng(34, -84), fromLatLngToContainerPixel: () => ({ x: 0, y: 0 }), fromContainerPixelToLatLng: () => new LatLng(34, -84) }; }
  }
  class Geocoder { geocode(_r, cb) { if (cb) cb([], 'ZERO_RESULTS'); return Promise.resolve({ results: [] }); } }
  const maps = {
    Map: FakeMap, Marker, Polyline, Circle, Polygon, OverlayView, Geocoder, LatLng, LatLngBounds,
    Size: function (w, h) { this.width = w; this.height = h; },
    Point: function (x, y) { this.x = x; this.y = y; },
    ControlPosition: { RIGHT_BOTTOM: 9, TOP_LEFT: 1, TOP_RIGHT: 3, LEFT_TOP: 5, RIGHT_TOP: 7, BOTTOM_CENTER: 11 },
    SymbolPath: { CIRCLE: 0 }, Animation: { DROP: 2, BOUNCE: 1 },
    event: evt,
    importLibrary: () => Promise.resolve(window.google.maps),
  };
  window.google = window.google || {};
  window.google.maps = Object.assign(window.google.maps || {}, maps);
})();
`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});

/** A page on the built app with the stand-in Maps and a stubbed backend; counts ring reads. */
async function openApp({ viewport, path = '/', layer = 'ok', preset = null }) {
  const ctx = await browser.newContext({ viewport, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const reads = { layer: 0 };
  if (preset) await page.addInitScript((kv) => { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, preset);
  await page.route(/maps\.googleapis\.com/, async (route) => {
    const url = new URL(route.request().url());
    if (!/\/maps\/api\/js/.test(url.pathname)) return route.fulfill({ status: 200, contentType: 'image/png', body: '' });
    const cb = url.searchParams.get('callback') || '';
    const invoke = cb ? `try{ var f = "${cb}".split(".").reduce(function(o,k){ return o && o[k]; }, window); if (typeof f === "function") f(); }catch(e){ console.error("stub callback failed", e); }` : '';
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: `${FAKE_MAPS}\n${invoke}` });
  });
  await page.route('**/.netlify/functions/**', async (route) => {
    const url = route.request().url();
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (url.includes('driver-territory')) {
      reads.layer += 1;
      if (layer === 'fail') return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' });
      return json(LAYER);
    }
    if (url.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: BOARD, count: BOARD.length, date: TODAY });
    return json({ ok: true });
  });
  page.on('pageerror', (e) => bad(`uncaught page error: ${e.message}`));
  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  return { ctx, page, reads };
}

const visibleSwitch = async (page, name) => {
  const all = page.getByRole('switch', { name });
  for (let i = 0; i < await all.count(); i++) {
    const s = all.nth(i);
    if (await s.isVisible().catch(() => false)) return s;
  }
  return null;
};
const openFilters = async (page) => {
  const btn = page.getByRole('button', { name: /^filters$/i }).first();
  if (!(await btn.isVisible().catch(() => false))) return false;
  await btn.click(); await page.waitForTimeout(600);
  return true;
};
const circles = (page) => page.evaluate(() => {
  // The wall's static picture never loads the Maps script at all, so there may be no stand-in.
  const latest = (window.__maps || []).at(-1);
  return (window.__shapes || []).map((c) => ({
    kind: c.kind, points: Array.isArray(c.opts.paths) ? c.opts.paths.length : 0,
    onMap: !!c.map, onLatest: c.map === latest, clickable: c.opts.clickable, zIndex: c.opts.zIndex,
    stroke: c.opts.strokeColor, weight: c.opts.strokeWeight, fill: c.opts.fillOpacity, listeners: c.listeners,
  }));
});
const names = (page) => page.evaluate(() => {
  const box = document.querySelector('[data-driver-area-names]');
  if (!box) return null;
  const els = [...box.querySelectorAll('[data-driver-area-name]')];
  const shown = els.filter((e) => getComputedStyle(e).display !== 'none').map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, text: e.textContent }; });
  let overlaps = 0;
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    const a = shown[i], b = shown[j];
    if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) overlaps++;
  }
  const pane = box.parentElement;
  return {
    count: els.length, shown: shown.length, overlaps,
    pointerEvents: getComputedStyle(box).pointerEvents,
    inFloatPane: pane && pane.getAttribute('data-pane') === 'floatPane',
    firstInPane: pane && pane.firstElementChild === box,
    zIndex: box.style.zIndex || '',
  };
});
const statusOf = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('[data-driver-areas-status]')].find((e) => e.offsetParent !== null);
  return el ? { state: el.getAttribute('data-driver-areas-status'), text: el.textContent, cls: el.className } : null;
});

// ── DESKTOP: the Filters card on the Map ─────────────────────────────────────
console.log('\nDriver areas — the Map tab, desktop (1440x950)');
{
  const { ctx, page, reads } = await openApp({ viewport: { width: 1440, height: 950 } });
  (await page.evaluate(() => (window.__maps || []).length)) > 0
    ? ok('the app built its map on the stand-in google.maps')
    : bad('no map was ever built — the stand-in did not take, so nothing below is exercised');
  reads.layer === 0 ? ok('nothing is read while the switch is off (default)') : bad(`the rings were read ${reads.layer}x with the switch off`);
  (await circles(page)).length === 0 ? ok('and nothing is drawn') : bad('rings were drawn with the switch off');

  await openFilters(page) ? ok('the Filters card opens') : bad('could not open the Filters card');
  const sw = await visibleSwitch(page, /^driver areas$/i);
  if (!sw) bad('there is no "Driver areas" switch in the desktop Filters card');
  else {
    (await sw.getAttribute('aria-checked')) === 'false' ? ok('"Driver areas" is in the Filters card, OFF') : bad('the switch did not start off');
    const s0 = await statusOf(page);
    s0 && /Rings round where drivers usually deliver/.test(s0.text) ? ok('off, it says what it would show') : bad(`off-state line: ${JSON.stringify(s0)}`);

    await sw.click(); await page.waitForTimeout(1200);
    (await sw.getAttribute('aria-checked')) === 'true' ? ok('it turns on') : bad('the switch did not turn on');
    reads.layer === 1 ? ok('turning it on reads the rings once') : bad(`turning it on read the rings ${reads.layer}x`);

    let cs = await circles(page);
    cs.length === 2 * RING_COUNT
      ? ok(`${RING_COUNT} rings drawn, each over a white halo (${cs.length} shapes)`)
      : bad(`expected ${2 * RING_COUNT} shapes (ring + halo for each of ${RING_COUNT}), drew ${cs.length}`);
    cs.every((c) => c.clickable === false && c.listeners === 0)
      ? ok('no ring takes a click — clickable:false, and nothing listens on one')
      : bad('a ring can take a click');
    cs.every((c) => c.onLatest) ? ok('every ring is on the live map') : bad('some rings are not on the live map');
    // THE OVALS ARE OVALS: a Polygon along the oval's path for each ring the layer gives an oval,
    // a Circle for every other — and the paint-only rules below hold for both.
    const polys = cs.filter((c) => c.kind === 'Polygon');
    polys.length === 2 * OVAL_COUNT && polys.every((c) => c.points >= 36)
      ? ok(`the ${OVAL_COUNT} rings whose work runs along a road are drawn as ovals (${polys.length} Polygons, ${polys[0]?.points} points each)`)
      : bad(`expected ${2 * OVAL_COUNT} oval Polygons with a full path, got ${polys.length} (${polys.map((c) => c.points).join(',')})`);
    cs.filter((c) => c.kind === 'Circle').length === 2 * (RING_COUNT - OVAL_COUNT)
      ? ok('and every other ring is a circle')
      : bad(`expected ${2 * (RING_COUNT - OVAL_COUNT)} circles, got ${cs.filter((c) => c.kind === 'Circle').length}`);
    const half = cs.length / 2;
    cs.slice(0, half).every((c) => c.stroke === '#ffffff') && cs.slice(half).every((c) => c.stroke !== '#ffffff')
      ? ok('every halo is drawn before every ring, so no halo cuts another driver\'s line')
      : bad('halos and rings are interleaved — a later halo will cut an earlier ring');
    cs.every((c) => c.zIndex === 0) ? ok('all at zIndex 0, under the route lines') : bad('a ring is not at zIndex 0');
    // Twenty-odd rings stack over the metro; any fill at all washes the streets out (seen on the
    // first real render), so the rings are lines only.
    cs.every((c) => c.fill === 0) ? ok('every ring is hollow — no fill to stack into a wash over the metro') : bad(`a ring has a fill (${cs.map((c) => c.fill).join(',')})`);

    const n = await names(page);
    if (!n) bad('no names were drawn');
    else {
      n.count === RING_COUNT ? ok(`a name for every ring (${n.count})`) : bad(`${n.count} names for ${RING_COUNT} rings`);
      n.shown > 0 ? ok(`${n.shown} of them placed at this zoom`) : bad('no name was placed at all');
      n.overlaps === 0 ? ok('no two placed names overlap') : bad(`${n.overlaps} pairs of names overlap`);
      n.pointerEvents === 'none' ? ok('the names let clicks through (pointer-events:none)') : bad(`names take clicks (pointer-events:${n.pointerEvents})`);
      n.inFloatPane && n.firstInPane && !n.zIndex
        ? ok('they sit first in the float pane, under the truck plates and hover cards, with no z-index to sink them')
        : bad(`names box placement: ${JSON.stringify(n)}`);
    }
    const s1 = await statusOf(page);
    s1 && s1.state === 'ready' && s1.text.includes(`${LAYER.rings.length} drivers · Aug 31 – Sep 25, 2026`)
      ? ok(`the switch says what is drawn: "${s1.text.slice(0, 70)}…"`)
      : bad(`ready line: ${JSON.stringify(s1)}`);
    s1 && s1.text.includes('Rasko Suljic') && s1.text.includes('Terry Gambrell')
      ? ok('and names who has no ring, and who was left out')
      : bad('the no-ring / left-out drivers are not named');

    // OFF leaves nothing behind.
    await sw.click(); await page.waitForTimeout(800);
    cs = await circles(page);
    cs.every((c) => !c.onMap) ? ok('turning it off takes every ring off the map') : bad(`${cs.filter((c) => c.onMap).length} rings stayed on the map after OFF`);
    (await names(page)) === null ? ok('…and every name') : bad('names stayed on the map after OFF');

    // ON again: drawn again, not read again.
    await sw.click(); await page.waitForTimeout(800);
    reads.layer === 1 ? ok('on again redraws without reading the rings a second time') : bad(`on again read the rings again (${reads.layer} reads)`);
    (await circles(page)).filter((c) => c.onMap).length === 2 * RING_COUNT ? ok('and every ring is back') : bad('not every ring came back');

    // A MAP REBUILD ("Hide place labels" rebuilds it) must carry the rings across.
    const hide = await visibleSwitch(page, /hide place labels/i);
    if (!hide) bad('could not find "Hide place labels" to force a map rebuild');
    else {
      const before = await page.evaluate(() => window.__maps.length);
      await hide.click(); await page.waitForTimeout(1800);
      const after = await page.evaluate(() => window.__maps.length);
      if (after <= before) bad('the map did not rebuild, so the rebuild path went unexercised');
      else {
        cs = await circles(page);
        cs.filter((c) => c.onLatest).length === 2 * RING_COUNT
          ? ok('after a map rebuild, every ring is on the NEW map')
          : bad(`after a rebuild only ${cs.filter((c) => c.onLatest).length} of ${2 * RING_COUNT} are on the new map`);
        cs.filter((c) => c.onMap && !c.onLatest).length === 0
          ? ok('and none is left on the discarded one')
          : bad('rings were left on the discarded map');
        const n2 = await names(page);
        n2 && n2.count === RING_COUNT ? ok('the names came across too') : bad('the names did not come across the rebuild');
      }
      await hide.click(); await page.waitForTimeout(1200);
    }
  }
  await ctx.close();
}

// ── A FAILED READ IS RED, AND DRAWS NOTHING ───────────────────────────────────
console.log('\nDriver areas — the read fails');
{
  const { ctx, page, reads } = await openApp({ viewport: { width: 1440, height: 950 }, layer: 'fail' });
  await openFilters(page);
  const sw = await visibleSwitch(page, /^driver areas$/i);
  if (!sw) bad('no switch to exercise the failure with');
  else {
    await sw.click(); await page.waitForTimeout(1200);
    const s = await statusOf(page);
    s && s.state === 'error' && /Couldn't load driver areas \(HTTP 502\)/.test(s.text) && /text-red-600/.test(s.cls)
      ? ok('a 502 says so, in red, with how to try again')
      : bad(`failure line: ${JSON.stringify(s)}`);
    (await circles(page)).length === 0 ? ok('and nothing is drawn from a failed read') : bad('rings were drawn from a failed read');
    await sw.click(); await page.waitForTimeout(400); await sw.click(); await page.waitForTimeout(1200);
    reads.layer === 2 ? ok('off and on again asks again') : bad(`off-and-on made ${reads.layer} reads, expected 2`);
  }
  await ctx.close();
}

// ── PHONE: Filters → Map display ──────────────────────────────────────────────
console.log('\nDriver areas — the Map tab, phone (390x844)');
{
  const { ctx, page, reads } = await openApp({ viewport: { width: 390, height: 844 } });
  await openFilters(page) ? ok('the phone\'s Filters sheet opens') : bad('could not open the phone\'s Filters sheet');
  const sw = await visibleSwitch(page, /^driver areas$/i);
  if (!sw) bad('there is no "Driver areas" switch on the phone');
  else {
    ok('"Driver areas" is in the phone\'s Filters → Map display');
    await sw.click(); await page.waitForTimeout(1200);
    reads.layer === 1 ? ok('turning it on reads the rings once') : bad(`read ${reads.layer}x`);
    (await circles(page)).filter((c) => c.onMap).length === 2 * RING_COUNT ? ok('and draws every ring on the phone\'s map') : bad('the phone did not draw every ring');
    const s = await statusOf(page);
    s && s.state === 'ready' ? ok('the phone says what is drawn') : bad(`phone status: ${JSON.stringify(s)}`);
  }
  await ctx.close();
}

// ── THE WALL: never offered, never read, never drawn ──────────────────────────
console.log('\nDriver areas — the office wall (/tv)');
// Both of the wall's maps: the static picture (its default) and the live map it can be switched
// to. The live one is the case that matters — it IS a Google map the rings could be drawn on.
for (const [label, preset] of [
  ['static picture', { 'dispatchMap.driverAreas': 'on' }],
  ['live map', { 'dispatchMap.driverAreas': 'on', 'dispatchMap.tvLiveMap': 'true' }],
]) {
  const { ctx, page, reads } = await openApp({ viewport: { width: 1920, height: 1080 }, path: '/tv', preset });
  const live = await page.evaluate(() => (window.__maps || []).length > 0);
  if (label === 'live map' && !live) bad('the wall\'s live map was never built — this case went unexercised');
  await openFilters(page);
  (await visibleSwitch(page, /^driver areas$/i)) === null ? ok(`${label}: the wall's Filters card offers no "Driver areas" switch`) : bad(`${label}: the wall offers the switch`);
  reads.layer === 0 ? ok(`${label}: a device switched ON elsewhere reads nothing in wall mode`) : bad(`${label}: the wall read the rings ${reads.layer}x`);
  (await circles(page)).length === 0 ? ok(`${label}: and draws nothing`) : bad(`${label}: the wall drew rings`);
  await ctx.close();
}

await browser.close();
server.close();
if (fails.length) { console.error(`\n✗ ${fails.length} check(s) failed\n`); process.exit(1); }
console.log('\n✓ "Driver areas" verified in a real browser — both views, on, off, rebuilt, failed, and never on the wall\n');
