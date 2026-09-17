#!/usr/bin/env node
// scripts/verify-tv-map.mjs — IS THE WALL DISPLAY'S MAP THE SAME MAP, IN THE WHOLE FRAME?
//
// Chad, on a photograph of the office television: "map doesn't look like it should i want
// the thing to be identical with all the same icons", and "i don't liek the black space on
// either end of the map we aren't using the full frame there are black bars on either side
// of the map on tv with just blank space before the needs a call table starts."
//
// Both of those are GEOMETRY CLAIMS about a screen nobody in CI can look at, and this repo's
// record on geometry it reasoned about rather than measured is bad enough to have a rule of
// its own: the phone map's overlays were collision-patched four separate times and still
// shipped controls on top of each other. The unit tests in test/tv-static-map.test.mjs pin
// the arithmetic; they cannot prove the app FEEDS it the pane it actually has, that the
// picture is not being letterboxed by a stylesheet, or that a pin's anchor offset survives
// the trip from a Maps-API object into a CSS margin.
//
// So this drives the real built bundle at /tv in a real browser and measures:
//   1. the picture fills the pane — zero black bar, which is the whole complaint;
//   2. the image was REQUESTED in the pane's ratio, not a guessed one;
//   3. every positioned stop has a pin (the old URL-marker path capped at ~400);
//   4. every pin is where an INDEPENDENT projection says it belongs, re-derived here from
//      the picture's own centre/zoom/size in a different form of the Mercator maths, so a
//      bug inside lib/tv-static-map.js shows up as a disagreement instead of as agreement
//      with itself;
//   5. the URL carries no markers= and is bought ONCE, not per render.
//
// Usage: node scripts/verify-tv-map.mjs [distDir]
//   CHROMIUM_PATH   browser binary   SMOKE_PORT   port (default 8796)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { deflateSync } from 'node:zlib';
// The keep-out margin only — a THRESHOLD, not the logic under test. The projection below is
// re-derived independently on purpose; a hardcoded 30 here would just drift from the module.
import { TV_PIN_PAD_PX } from '../src/lib/tv-static-map.js';

const DIST = resolve(process.argv[2] || 'dist');
const PORT = Number(process.env.SMOKE_PORT) || 8796;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

const TODAY = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
const fails = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { fails.push(m); console.error(`  ✗ ${m}`); };
const note = (m) => console.log(`  · ${m}`);

// A board with SPREAD, so the fit has real work to do and a mirrored axis cannot hide.
const stop = (n, lat, lng, extra = {}) => ({
  _id: `davis__0071${String(n).padStart(4, '0')}`, stopNbr: `0071${String(n).padStart(4, '0')}`,
  pro: `0071${String(n).padStart(4, '0')}`, primaryPro: `0071${String(n).padStart(4, '0')}`,
  pros: [`0071${String(n).padStart(4, '0')}`],
  businessName: `CUSTOMER ${n}`, addr1: `${n} Main St`, city: 'Buford', state: 'GA', zip: `305${(n % 90) + 10}`,
  lat, lng, status: '10', normalizedStatus: 'SCHEDULED', isPlanned: true, isUnplanned: false,
  loadNbr: 'VINCENT', routeName: 'VINCENT', driverName: 'Vincent Bonzo', routeSeq: n, stopType: 'DO',
  boardDate: TODAY, scheduledDate: TODAY, pallets: 1, cartons: 0, volume: 1, weight: 500, enriched: true, ...extra,
});
// 240 stops across metro Atlanta — more than a Static Maps URL could ever have carried, which
// is half the point of check 3, and enough that a systematic placement error cannot average out.
// Mixed on purpose: delivered stops and PICKUPS, because those take DIFFERENT size tiers and
// different anchors out of stopMarkerIcon (16px dot vs 22px disc). A fixture where every pin
// is the same size cannot catch an anchor applied in the wrong units.
const BOARD = Array.from({ length: 240 }, (_, i) => stop(
  i + 1,
  // SPREAD ON PURPOSE. The step sizes put the board's ideal zoom near the MIDDLE of a step,
  // so flooring it costs about a third of the frame and the fill check above has real room
  // either side. A board that happens to sit just above a whole step makes that check almost
  // unfalsifiable — which is what the first version of this fixture did.
  33.62 + (i % 16) * 0.0777,
  -84.62 + Math.floor(i / 16) * 0.106,
  i % 7 === 0 ? { normalizedStatus: 'DELIVERED', status: '60' }
    : i % 5 === 0 ? { stopType: 'PU' } : {},
));
// Two trucks, one of them on a stale fix, so the truck layer and the name plate are measured
// rather than reported as "0 drawn".
const NOW = new Date();
const DRIVERS = [
  { vehicleNumber: '7792', driverName: 'Brent Dawson', driverId: 'd1', lat: 33.98, lng: -84.12, locatedAt: NOW.toISOString(), routeAssigned: true, routeProgress: { completed: 3, total: 12 } },
  { vehicleNumber: '7801', driverName: 'Marcus Hale', driverId: 'd2', lat: 34.21, lng: -83.98, locatedAt: new Date(NOW.getTime() - 90 * 60000).toISOString() },
];

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

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
// 1920x1080 is the television. The pane is what is left of it beside the 400px flag rail and
// under the status bar, which is exactly the shape the old fixed 640x416 was guessing at.
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();

// A PNG AT THE SIZE THAT WAS ACTUALLY ASKED FOR, and that detail is the difference between a
// guard and a decoration. The first version of this served a 1x1 pixel, so the <img> had an
// intrinsic ratio of 1:1 and object-fit had nothing meaningful to letterbox — the black-bar
// check then PASSED with the bug deliberately reinstated, because getBoundingClientRect()
// reports the ELEMENT box and never the painted one. Google returns an image in the shape the
// URL requested; so does this.
const crc32 = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = -1; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const pngOf = (w, h) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit greyscale
  // One filter byte + w samples per row; all zeros, which deflates to nothing.
  const raw = Buffer.alloc((w + 1) * h);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
};
const staticReqs = [];
// Flipped for the second phase: Google's REAL refusal, byte for byte — 403, text/plain, and
// the sentence it actually sends, confirmed against the live API while this was written.
let refuse = false;
const GOOGLE_403 = 'The Google Maps Platform server rejected your request. This API project is not authorized to use this API. Please ensure that this API is activated in the Google Cloud Console.';
await page.route(/maps\.googleapis\.com/, async (route) => {
  const url = route.request().url();
  if (url.includes('/maps/api/staticmap')) {
    staticReqs.push(url);
    if (refuse) {
      return route.fulfill({ status: 403, contentType: 'text/plain; charset=UTF-8', headers: { 'access-control-allow-origin': '*' }, body: GOOGLE_403 });
    }
    const q = new URL(url).searchParams;
    const [w, h] = String(q.get('size') || '640x416').split('x').map(Number);
    const scale = Number(q.get('scale')) || 1;
    return route.fulfill({ status: 200, contentType: 'image/png', body: pngOf(w * scale, h * scale) });
  }
  // TV mode must never ask for the Maps JS at all; if it does, say so loudly rather than
  // quietly serving it and letting the run look clean.
  staticReqs.push(url);
  return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* not expected on /tv */' });
});
await page.route('**/.netlify/functions/**', async (route) => {
  const url = route.request().url();
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (url.includes('nuvizz-pull-today-stops')) return json({ ok: true, stops: BOARD, count: BOARD.length, date: TODAY });
  if (url.includes('motive-driver-positions')) return json({ ok: true, drivers: DRIVERS });
  return json({ ok: true });
});
page.on('pageerror', (e) => bad(`uncaught page error: ${e.message}`));

console.log('\nTHE WALL DISPLAY — /tv at 1920x1080');
await page.goto(`http://127.0.0.1:${PORT}/tv`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('img[data-tv-pin]', { timeout: 20000 }).catch(() => {});
// The board arrives, the pane is measured, the picture is requested, the pins are placed —
// four ticks on four different timelines. Settle before measuring anything.
await page.waitForTimeout(2500);

const shot = await page.evaluate(() => {
  const pinEls = [...document.querySelectorAll('img[data-tv-pin]')];
  const base = [...document.querySelectorAll('img')].find((im) => (im.src || '').includes('staticmap'));
  const pane = base ? base.parentElement : null;
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  // WHAT IS ACTUALLY PAINTED, not what box the element occupies. object-fit:contain leaves the
  // element full-size and draws a smaller picture inside it — which is precisely the black bar
  // Chad is looking at, and precisely what a getBoundingClientRect check cannot see.
  const painted = (im) => {
    const b = im.getBoundingClientRect();
    const nw = im.naturalWidth || b.width; const nh = im.naturalHeight || b.height;
    const fit = getComputedStyle(im).objectFit;
    if (fit === 'contain' || fit === 'scale-down') {
      const k = Math.min(b.width / nw, b.height / nh);
      return { w: nw * k, h: nh * k };
    }
    if (fit === 'none') return { w: Math.min(nw, b.width), h: Math.min(nh, b.height) };
    return { w: b.width, h: b.height };   // fill, cover — no bar either way
  };
  return {
    url: base ? base.src : null,
    pane: pane ? r(pane) : null,
    img: base ? r(base) : null,
    paint: base ? painted(base) : null,
    natural: base ? { w: base.naturalWidth, h: base.naturalHeight } : null,
    objectFit: base ? getComputedStyle(base).objectFit : null,
    pins: pinEls.map((el) => {
      const cs = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return {
        stop: el.getAttribute('data-tv-pin'),
        // THE ANCHOR IS READ OFF THE DRAWN ICON, NOT OFF THE RULE THAT PLACED IT.
        //
        // The first version of this took b.x MINUS the negative margin, which recovers "where
        // the percentage put the corner" — the same number whether the anchor was applied or
        // not. It passed cleanly with the anchor deliberately deleted. Every pin on this
        // fixture is a square disc, and a disc's anchor is its CENTRE (stopMarkerIcon:
        // anchor = size/2 on every circle branch), so the centre of the box is the point the
        // pin is claiming to mark — and dropping the offset moves it by half an icon.
        ax: b.x + b.width / 2,
        ay: b.y + b.height / 2,
        w: b.width, h: b.height,
        marginL: parseFloat(cs.marginLeft || '0'),
        src: (el.getAttribute('src') || '').slice(0, 24),
      };
    }),
    trucks: [...document.querySelectorAll('[data-tv-truck]')].map((el) => {
      const b = el.getBoundingClientRect();
      return { key: el.getAttribute('data-tv-truck'), x: b.x, y: b.y, opacity: getComputedStyle(el).opacity, plate: (el.textContent || '').trim() };
    }),
    // The failure banner, if the picture was refused.
    banner: [...document.querySelectorAll('div')].some((d) => /map image was refused/i.test(d.textContent || '')),
  };
});

if (!shot.url) {
  bad('no static basemap on /tv — the wall display never asked for a picture');
} else {
  const q = new URL(shot.url).searchParams;
  const [iw, ih] = String(q.get('size') || '0x0').split('x').map(Number);
  const [clat, clng] = String(q.get('center') || '0,0').split(',').map(Number);
  const zoom = Number(q.get('zoom'));

  // ── 1. THE BLACK BARS ────────────────────────────────────────────────────
  // Chad's actual complaint, measured: the picture's box against the pane's box.
  if (!shot.natural || !shot.natural.w) {
    bad('the basemap never decoded — this run cannot measure a black bar it cannot see');
  }
  const gapX = Math.round(Math.abs(shot.paint.w - shot.pane.w));
  const gapY = Math.round(Math.abs(shot.paint.h - shot.pane.h));
  if (gapX <= 1 && gapY <= 1) ok(`the picture fills the pane — ${Math.round(shot.pane.w)}x${Math.round(shot.pane.h)}, no bar on any side`);
  else bad(`BLACK BARS: the pane is ${Math.round(shot.pane.w)}x${Math.round(shot.pane.h)} and the picture PAINTS ${Math.round(shot.paint.w)}x${Math.round(shot.paint.h)} — ${gapX}px across, ${gapY}px down`);

  // ── 2. ASKED FOR IN THE PANE'S OWN SHAPE ─────────────────────────────────
  // Filling the frame with object-fill would hide a wrong ratio as a stretch, and a stretched
  // map is a map that lies about distance. The REQUEST has to be right too.
  const want = shot.pane.w / shot.pane.h;
  const got = iw / ih;
  const off = Math.abs(got - want) / want;
  // 0.2%: rounding ONE side to an integer against a 640 ceiling can never cost more than
  // about 0.12%. Anything looser lets a guessed ratio back through — the old fixed 640x416
  // was 0.71% out at this viewport and sailed past a 1% threshold.
  if (off < 0.002) ok(`the image was requested at ${iw}x${ih}, the pane's own ratio (${off === 0 ? '0' : (off * 100).toFixed(2)}% off)`);
  else bad(`the image was requested at ${iw}x${ih} (${got.toFixed(3)}) for a ${want.toFixed(3)} pane — ${(off * 100).toFixed(1)}% out of shape`);
  if (shot.objectFit === 'contain') bad('object-fit:contain is back — that is what letterboxed it in the first place');

  // ── 3. NOTHING DROPPED ───────────────────────────────────────────────────
  if (shot.pins.length === BOARD.length) ok(`all ${BOARD.length} stops drew a pin — no cap, no "showing 401 of 640"`);
  else bad(`${shot.pins.length} pins for ${BOARD.length} positioned stops — freight is missing off the wall`);

  // ── 4. THE SAME ICONS ────────────────────────────────────────────────────
  // Google's static markers are PNG teardrops on its own domain. These have to be this app's
  // own SVG artwork, which is what "identical with all the same icons" means.
  const svg = shot.pins.filter((p) => p.src.startsWith('data:image/svg+xml')).length;
  if (svg === shot.pins.length && svg > 0) ok(`every pin is this app's own SVG artwork, not a Google teardrop`);
  else bad(`${shot.pins.length - svg} of ${shot.pins.length} pins are not stopMarkerIcon SVGs`);
  const sizes = new Set(shot.pins.map((p) => `${Math.round(p.w)}x${Math.round(p.h)}`));
  if (sizes.size > 1) ok(`the pins carry the board's real size tiers (${[...sizes].sort().join(', ')})`);
  else bad(`every pin came out ${[...sizes][0]} — the size tiers are not reaching the wall`);

  // ── 5. WHERE EVERY PIN LANDS, DERIVED INDEPENDENTLY ──────────────────────
  // Deliberately NOT the module's own maths. Mercator written the other way round —
  // log(tan(π/4 + φ/2)) rather than atanh(sin φ) — so the two have to agree on the answer
  // without sharing a line of code. A projection wrong by a few pixels still looks exactly
  // like a working map, which is why this is measured and not eyeballed.
  const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
  const world = 256 * Math.pow(2, zoom);
  const kx = shot.pane.w / iw;
  const ky = shot.pane.h / ih;
  const byStop = new Map(BOARD.map((s) => [s.stopNbr, s]));
  let worst = 0; let worstStop = null; let unmatched = 0; let notDiscs = 0;
  for (const p of shot.pins) {
    const s = byStop.get(p.stop);
    if (!s) { unmatched += 1; continue; }
    // PRECONDITION for reading the anchor off the box: this fixture serves no customer notes,
    // so no restriction cluster (the one non-square, non-centre-anchored icon) can appear. If
    // one ever does, say so rather than measuring it against the wrong anchor.
    if (Math.abs(p.w - p.h) > 0.5) { notDiscs += 1; continue; }
    const ix = iw / 2 + world * ((s.lng - clng) / 360);
    const iy = ih / 2 - world * ((merc(s.lat) - merc(clat)) / (2 * Math.PI));
    const ex = shot.pane.x + ix * kx;
    const ey = shot.pane.y + iy * ky;
    const d = Math.hypot(p.ax - ex, p.ay - ey);
    if (d > worst) { worst = d; worstStop = p.stop; }
  }
  if (unmatched) bad(`${unmatched} pins carry a stop number that is not on the board`);
  if (notDiscs) bad(`${notDiscs} pins are not square discs — this guard cannot read their anchor, so it did not check them`);
  // 1.5px covers sub-pixel rounding in two independently-rounded percentage layouts.
  if (worst <= 1.5) ok(`every pin lands where the picture's own centre/zoom put it (worst ${worst.toFixed(2)}px)`);
  else bad(`PINS ARE IN THE WRONG PLACE: stop ${worstStop} is ${worst.toFixed(1)}px from where this picture puts it`);

  // ── 5b. DOES THE BOARD FILL THE FRAME? ───────────────────────────────────
  // Chad, on the wall: "there is a bunch of wasted space above where my stops end and below
  // them." Measured on the live board before the fix: the pins used 79% of the height and 55%
  // of the width, because the fit wanted zoom 8.25 and a whole-number zoom gave it 8 — and a
  // zoom step is a factor of TWO, so flooring one can throw away half the screen.
  //
  // Check 5 above cannot see this: a map zoomed far too far out passes "every pin is where the
  // picture puts it" perfectly. This is the assertion that was missing.
  let pn = Infinity; let ps = -Infinity; let pw = Infinity; let pe = -Infinity;
  for (const p of shot.pins) { pn = Math.min(pn, p.ay); ps = Math.max(ps, p.ay); pw = Math.min(pw, p.ax); pe = Math.max(pe, p.ax); }
  const availW = shot.pane.w - 2 * TV_PIN_PAD_PX;
  const availH = shot.pane.h - 2 * TV_PIN_PAD_PX;
  const fillW = (pe - pw) / availW;
  const fillH = (ps - pn) / availH;
  // RELATIVE TO THE PANE'S OWN ORIGIN. These rects are viewport-absolute and the pane starts
  // below the status bar, so measuring "dead above" from zero counts the status bar as wasted
  // map and "dead below" against a HEIGHT rather than a bottom edge comes out negative. The
  // fill fractions are differences and were right either way; the numbers printed beside them
  // were not, and a guard that prints a wrong number is how a wrong number becomes a fact.
  const deadTop = Math.round(pn - shot.pane.y);
  const deadBottom = Math.round((shot.pane.y + shot.pane.h) - ps);
  // 0.90, and the fixture is spread so a floored zoom costs it about a THIRD of the frame —
  // the first cut used a board whose ideal zoom sat a hair above a whole step, so the bug was
  // worth only 5 points and the threshold had one point of headroom. The snap (see
  // TV_BOUNDS_SNAP_DEG) deliberately pads the box outward by up to 0.02 degrees a side, so
  // 100% is not reachable and must not be demanded.
  // ONE of the two, whichever the board's own shape makes limiting — demanding both would be
  // demanding a day's freight shaped like a television.
  if (Math.max(fillW, fillH) > 0.90) {
    ok(`the board fills the frame — ${(fillH * 100).toFixed(0)}% of the height, ${(fillW * 100).toFixed(0)}% of the width (${deadTop}px above the pins, ${deadBottom}px below)`);
  } else {
    bad(`WASTED FRAME: the pins fill only ${(fillH * 100).toFixed(0)}% of the height and ${(fillW * 100).toFixed(0)}% of the width — ${deadTop}px dead above them, ${deadBottom}px below`);
  }
  if (!Number.isInteger(zoom)) bad(`zoom=${zoom} is not an integer — Google reads a fractional zoom as ZOOM 0 and returns the whole planet`);
  else ok(`zoom ${zoom} is a whole step and the frame shrank to ${iw}x${ih} to absorb the remainder`);

  // ── 6. THE BILL ──────────────────────────────────────────────────────────
  const staticOnly = staticReqs.filter((u) => u.includes('/maps/api/staticmap'));
  const distinct = new Set(staticOnly);
  if (!shot.url.includes('markers')) ok('the URL carries no markers= — Google draws the roads, this app draws the freight');
  else bad('markers= is back in the URL — the pin cap and the per-pin billing come back with it');
  if (distinct.size <= 1) ok(`one picture bought for the whole load (${staticOnly.length} request${staticOnly.length === 1 ? '' : 's'}, ${distinct.size} distinct URL)`);
  else bad(`${distinct.size} DISTINCT pictures bought on one page load — every one is a billed request`);
  const jsReqs = staticReqs.filter((u) => !u.includes('/maps/api/staticmap'));
  if (!jsReqs.length) ok('the Maps JavaScript API was never loaded on this screen');
  else bad(`/tv asked for the Maps JS API ${jsReqs.length}× — that is the script that could not draw on the television`);

  if (shot.banner) bad('the "map image was refused" banner is showing over a picture that loaded');

  // ── 7. THE TRUCKS ────────────────────────────────────────────────────────
  // What a room looks up at first. They ride the same projection, carry the same 20px truck
  // and the same name plate the live board draws — and a stale fix still dims.
  if (shot.trucks.length === DRIVERS.length) {
    ok(`both trucks drew, with their name plates (${shot.trucks.map((t) => t.plate.slice(0, 18)).join(' | ')})`);
  } else {
    bad(`${shot.trucks.length} trucks for ${DRIVERS.length} driver positions`);
  }
  const dim = shot.trucks.filter((t) => Number(t.opacity) < 0.9).length;
  if (dim === 1) ok('the 90-minute-old fix is dimmed, the fresh one is not — staleness still reads across a room');
  else bad(`${dim} trucks are dimmed; exactly 1 of these 2 fixes is stale`);
  for (const t of shot.trucks) {
    const d = DRIVERS.find((x) => (x.vehicleNumber || x.driverId) === t.key);
    if (!d) { bad(`a truck marked ${t.key} is not in the fixture`); continue; }
    const ix = iw / 2 + world * ((d.lng - clng) / 360);
    const iy = ih / 2 - world * ((merc(d.lat) - merc(clat)) / (2 * Math.PI));
    const off2 = Math.hypot(t.x - (shot.pane.x + ix * kx), t.y - (shot.pane.y + iy * ky));
    if (off2 > 1.5) bad(`truck ${t.key} is ${off2.toFixed(1)}px from where this picture puts it`);
  }
}

// ── 8. AND WHEN GOOGLE SAYS NO ────────────────────────────────────────────
// Chad, twice: "the static api key thing is back." The screen used to answer EVERY failure
// with one guess about the Maps Static API, because an <img> onError carries no reason. It
// asks now — Google refuses with a readable body and a CORS header — so this drives a real
// refusal and reads what the wall ends up saying.
console.log('\nWHEN GOOGLE REFUSES THE PICTURE');
refuse = true;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const failed = await page.evaluate(() => {
  // The OUTERMOST match — the banner itself. Taking the last match takes the innermost div,
  // which is the headline alone, and then Google's own sentence (a sibling) never counts.
  const el = [...document.querySelectorAll('div')].filter((d) => /Maps Static API|could not reach Google|map image was refused|rejected the key/i.test(d.textContent || ''));
  return el.length ? (el[0].textContent || '').replace(/\s+/g, ' ').trim() : null;
});
if (!failed) {
  bad('the picture was refused and the wall said NOTHING — an empty frame is the failure this screen exists not to have');
} else {
  if (/Maps Static API is not enabled/.test(failed)) ok('a 403 names the Maps Static API and the console setting that fixes it');
  else bad(`a 403 produced the wrong diagnosis: "${failed.slice(0, 120)}"`);
  if (/not authorized to use this API/.test(failed)) ok('and it quotes Google\'s own sentence, which is what somebody will paste into a search box');
  else bad('Google\'s own words did not reach the screen — the gloss is ours, the truth is theirs');
  if (!/Most likely/.test(failed)) ok('nothing on the wall says "most likely" any more');
  else bad('the guess is back: the banner still hedges instead of reporting what Google said');
}

await browser.close();
server.close();

if (fails.length) {
  console.error(`\n✗ ${fails.length} problem${fails.length === 1 ? '' : 's'} on the wall display\n`);
  process.exit(1);
}
console.log('\n✓ the wall display draws the same board, in the whole frame\n');
