// src/lib/territory-sheet-html.js — THE PRINTED DRIVER-AREA SHEET, AS ONE FUNCTION.
//
// Chad: "I want something I can print out and give to someone", then "I like the circles", then,
// handed the first real print: "just produce a sheet and let me look at it."
//
// ── WHAT THE FIRST REAL PRINT GOT WRONG, BECAUSE IT IS THE WHOLE DESIGN ─────────────────────
//
// The layout was built and tuned against an invented sample of a dozen drivers. Davis runs 58.
// Every active driver's circles went onto ONE map, and at fifty-eight the page is mush: circles
// overlap four deep, the de-collision walks the names into a column down the middle, and the
// colour legend eats a page to distinguish 58 people with 8 colours. It was thirty pages and
// unreadable, and no test caught it because every test was written against the sample.
//
// A trainee does not have a question that one map answers. He has two:
//
//   "An order came in for Dacula — whose is it?"   → the town table. One page, alphabetical.
//   "Where does Vincent run?"                       → Vincent's own card.
//
// So the everyone-at-once map is gone. What replaces it is ONE CARD PER DRIVER, each with its
// own small map, and — the part that makes them worth printing — EVERY CARD SHARES ONE FRAME.
// Fit each map to its own driver and all 58 look identical: one blob filling one square. Shared,
// the card is read by WHERE the ink sits, which is the only thing a set of small maps is for.
//
// Each card draws the driver's actual stops as dots UNDER his circle. The circle is a summary
// and a summary can be wrong where the reader cannot see it; the dots are the evidence, and for
// the drivers who get no circle at all they are the entire answer — "no fixed area" over a blank
// square teaches nothing, over a square full of scattered dots it teaches exactly the right thing.
//
// WRITTEN ONCE, CALLED TWICE. scripts/territory-sheet.mjs renders it from a JSON file for a PDF;
// netlify/functions/driver-territory.mts serves the identical bytes live.
//
// PURE: no Firestore, no network, no filesystem, no clock of its own. `input.generatedAt` is
// passed in rather than read, so the same data renders the same page every time.
import {
  zipOwnership, driverCore, territoryCoverage, activeDrivers, driverCircles, driverRewrites,
  driverPoints, driverKeyOf, mapFrame, rosterOf,
} from './driver-territory.js';
import COUNTIES from './ga-north-counties.js';

// Orientation labels. A printed map of anonymous county outlines is a puzzle; familiar names
// turn it into a map of somewhere. These are the towns' own coordinates, not derived data.
// `major` is the short list a 100mm card map can carry without the labels eating the geography.
const TOWNS = [
  ['Atlanta', 33.749, -84.388, 1], ['Buford', 34.121, -84.000, 1], ['Athens', 33.958, -83.378, 1],
  ['Lawrenceville', 33.956, -83.988, 0], ['Gainesville', 34.298, -83.824, 1], ['Marietta', 33.953, -84.550, 1],
  ['Duluth', 34.003, -84.145, 0], ['Cumming', 34.207, -84.140, 0], ['Winder', 33.993, -83.720, 0],
  ['Conyers', 33.668, -84.018, 1], ['Douglasville', 33.752, -84.748, 0], ['Canton', 34.237, -84.491, 0],
];

const INK = '#1f4e79';   // ONE accent, not a palette — see the note above `depot` below.

export function territorySheetHtml(input = {}) {
const stops = input.stops || [];
const roster = input.roster ? rosterOf(input.roster) : null;

// ONLY DRIVERS WHO HAVE ACTUALLY RUN IN THE WINDOW. Chad: "terry hasn't ran for me in a long
// time ... just guys that have ran in last 4 weeks."
const { active: activeSet, excluded } = activeDrivers(stops, { roster, minStops: input.minStops ?? 5 });
// THE KEY COMES FROM ONE PLACE. This filter used to re-derive it inline — uppercase, spaces to
// underscores — which is what the key looks like for most names and is NOT what canonicalDriver
// does. For "COLIN/DJ 1" the inline version produced COLIN/DJ_1, which is in no active set, so
// Colin's second load vanished from the town table and the cards while driverCircles (which
// asks properly) still drew it. Half the sheet disagreeing with the other half, silently.
const inWindow = stops.filter((s) => activeSet.has(driverKeyOf(s)));
const zips = input.zips || zipOwnership(inWindow, { roster });
const drivers = input.drivers || driverCore(inWindow, { roster });
const cov = input.coverage || territoryCoverage(inWindow, { roster });
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (n) => `${Math.round((n || 0) * 100)}%`;

// COLOUR TELLS RINGS APART. IT DOES NOT NAME ANYBODY.
//
// Ten swatches across 59 drivers means six men share every colour, so a colour cannot identify a
// person — and the first sheet printed a legend that implied it could, which cost a whole page
// and told the reader something false. There is no legend now. On the big map the colours exist
// so that two rings crossing each other read as two rings; the NAME in the middle is the answer.
// Varied lightness as well as hue, because this sheet gets photocopied.
const PALETTE = ['#1f4e79', '#a4462d', '#3f7d3f', '#6b4a8a', '#8a6d1f',
                 '#256b6b', '#8a3060', '#4a5a6b', '#2f6f9e', '#7a3b1e'];
const depot = input.depot || { lat: 34.14838, lng: -83.95948, name: 'Buford Terminal' };
const circleSets = input.circles || driverCircles(stops, { roster, active: activeSet });
const pointsBy = driverPoints(inWindow, { roster, active: activeSet });
const allPoints = [...pointsBy.values()].flat();
const frame = mapFrame(allPoints, { include: [depot] });
const colourOf = new Map(drivers.map((d, i) => [d.key, PALETTE[i % PALETTE.length]]));

// ── the shared projection ───────────────────────────────────────────────────
function projector(W) {
  const { x0, x1, y0, y1 } = frame;
  const aspect = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);   // no east-west stretch
  const H = Math.round((W * (y1 - y0)) / ((x1 - x0) * aspect));
  return {
    W, H,
    sx: (lng) => ((lng - x0) / (x1 - x0)) * W,
    sy: (lat) => H - ((lat - y0) / (y1 - y0)) * H,
    rpx: (km) => (km / 111 / (y1 - y0)) * H,       // radius in latitude degrees → px
    inside: (lat, lng) => lat > y0 && lat < y1 && lng > x0 && lng < x1,
  };
}

// County outlines (US Census, public domain) and town labels — the same bytes under every map,
// so a card is compared against its neighbours rather than read on its own.
function basemap(P, small) {
  const counties = COUNTIES.map((c) => c.rings.map((r) => {
    const d = r.map(([lng, lat], i) => `${i ? 'L' : 'M'}${P.sx(lng).toFixed(1)},${P.sy(lat).toFixed(1)}`).join('');
    return `<path d="${d}Z" fill="#f4f3f0" stroke="#cbc9c3" stroke-width="${small ? 0.5 : 0.7}"/>`;
  }).join('')).join('');
  const fs = small ? 8 : 9;
  // A LABEL PAST THE RIGHT EDGE IS A LABEL NOBODY READS. "Athens" sits within a few pixels of
  // the frame and printed half off the paper; near the edge the name reads back toward the map.
  const towns = TOWNS.filter(([, lat, lng, major]) => (!small || major) && P.inside(lat, lng))
    .map(([n, lat, lng]) => {
      const x = P.sx(lng), y = P.sy(lat), right = x > P.W * 0.82;
      return `<g><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${small ? 1.4 : 1.8}" fill="#666"/>
      <text x="${(x + (right ? -3.5 : 3.5)).toFixed(1)}" y="${(y + fs / 3).toFixed(1)}" font-size="${fs}" fill="#555"
        text-anchor="${right ? 'end' : 'start'}" stroke="#fff" stroke-width="2" paint-order="stroke">${esc(n)}</text></g>`;
    }).join('');
  const d = P.inside(depot.lat, depot.lng)
    ? `<g><rect x="${(P.sx(depot.lng) - 3.5).toFixed(1)}" y="${(P.sy(depot.lat) - 3.5).toFixed(1)}" width="7" height="7" fill="#111"/>
       ${small ? '' : `<text x="${(P.sx(depot.lng) + 6).toFixed(1)}" y="${(P.sy(depot.lat) + 3).toFixed(1)}" font-size="9.5" font-weight="700"
         stroke="#fff" stroke-width="2.6" paint-order="stroke">${esc(depot.name)}</text>`}</g>` : '';
  return counties + towns + d;
}

// SIZED IN MILLIMETRES, BOTH WAYS, because `break-inside: avoid` does not shrink anything — it
// MOVES it. The first real print sized the overview by width alone, it came out 195mm tall, it
// would not fit under the header, and page one printed as a title and 200mm of white paper with
// the map alone on page two. A map that is told its height budget stays where it was put.
function svgBox(P, body, widthMm, maxHeightMm) {
  const w = maxHeightMm ? Math.min(widthMm, maxHeightMm * P.W / P.H) : widthMm;
  return `<svg viewBox="0 0 ${P.W} ${P.H}" width="${w.toFixed(1)}mm" height="${(w * P.H / P.W).toFixed(1)}mm"
    preserveAspectRatio="xMidYMid meet" style="display:block;margin:0 auto">${body}</svg>`;
}

// ── PAGE ONE: ONE BIG MAP, EVERY DRIVER'S CIRCLE, OVERLAPPING ───────────────
//
// Chad: "Dont put all the dots i want one big map with overlapping circles for the drivers."
//
// This is the wall chart. It is the shape he asked for at the start ("circles or ovals of where
// their general work area is") and confirmed after seeing the sample ("I like the circles"), and
// the version that failed was not wrong about the SHAPE — it was wrong about everything else on
// the page. What makes fifty-odd overlapping circles readable this time:
//
//   • THE RINGS ARE HOLLOW. Filled and stacked four deep the metro went solid and no ring could
//     be followed round. Outlines cross each other and stay separate lines.
//   • THERE ARE FEWER OF THEM. The 30km rule (measured, see driverCircles) leaves most drivers
//     one ring instead of the shattered handful the 15km cap produced.
//   • NAMES SIT IN THE MIDDLE OF THEIR OWN RING, not stacked at one point. Smallest circles get
//     their label placed first — a small ring is a precise claim and a displaced name over it is
//     a lie about a specific patch, while a big ring can carry its name off-centre and still be
//     read. Anything that still collides is nudged and given a leader line back to its circle.
//   • IT GETS THE WHOLE PAGE. 186mm across, no header competing with it.
//
// The colours are not a key and there is no legend — with 59 drivers a legend was the thing
// eating a page. They exist so two rings crossing each other stay two rings. The NAME identifies.
const overview = (() => {
  if (!frame) return '<p class="muted">No coordinates in this window, so no map can be drawn. The tables below use ZIP, which every stop carries.</p>';
  const P = projector(660);
  const drawn = circleSets.filter((d) => d.circles.length);
  const all = drawn.flatMap((d) => d.circles.map((c) => ({ d, c, r: Math.max(6, P.rpx(c.radiusKm)) })));

  // Biggest first so a small ring is never buried under a big one's outline.
  const rings = [...all].sort((a, b) => b.r - a.r).map(({ d, c, r }) => {
    const col = colourOf.get(d.key) || '#555';
    return `<circle cx="${P.sx(c.lng).toFixed(1)}" cy="${P.sy(c.lat).toFixed(1)}" r="${r.toFixed(1)}"
      fill="${col}" fill-opacity="0.05" stroke="${col}" stroke-width="1.6" stroke-opacity="0.95"/>`;
  }).join('');

  // LABELS. Smallest ring first (its claim is the most specific), then out along a ring of
  // candidate offsets, and only then straight down with a leader line. Deterministic — the same
  // data lays out the same way every time it is printed, which a hand-tuned map cannot promise.
  // THE PLACES ARE SEEDED FIRST, so a driver's name can never be printed through "Buford" or
  // "Lawrenceville". The town labels are what make this a map of somewhere rather than a pile of
  // rings; losing one to a name costs more than moving that name a few millimetres.
  const placed = TOWNS.filter(([, lat, lng]) => P.inside(lat, lng))
    .map(([n, lat, lng]) => ({ x: P.sx(lng) + 3.5 + n.length * 2.3, y: P.sy(lat) + 3, w: n.length * 4.6 + 6 }));
  if (P.inside(depot.lat, depot.lng)) {
    placed.push({ x: P.sx(depot.lng) + 6 + depot.name.length * 2.6, y: P.sy(depot.lat) + 3, w: depot.name.length * 5.2 + 8 });
  }
  const clear = (x, y, w) => !placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - y) < 10);
  const labels = [...all].sort((a, b) => a.r - b.r).map(({ d, c, r }) => {
    const cx = P.sx(c.lng), cy = P.sy(c.lat);
    const w = d.label.length * 4.6 + 4;
    let x = cx, y = cy + 3, leader = '';
    if (!clear(x, y, w)) {
      // Out along its own ring first, then further out. In the metro the small rings sit inside
      // each other, so the near offsets are all still in the crowd — a name has to be allowed to
      // travel, and the leader line is what keeps it attached to the right circle.
      const tries = [];
      for (const f of [0.6, 0.95, 1.3, 1.8, 2.5, 3.4]) {
        for (const a of [-90, 90, 0, 180, -45, 45, -135, 135, -70, 70, -110, 110]) {
          tries.push([cx + Math.cos((a * Math.PI) / 180) * r * f, cy + Math.sin((a * Math.PI) / 180) * r * f + 3]);
        }
      }
      const hit = tries.find(([tx, ty]) => clear(tx, ty, w) && tx > w / 2 && tx < P.W - w / 2 && ty > 8 && ty < P.H - 4);
      if (hit) { [x, y] = hit; } else { while (!clear(x, y, w)) y += 10; }
      leader = `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(y - 3).toFixed(1)}"
        stroke="${colourOf.get(d.key) || '#555'}" stroke-width="0.5" stroke-opacity="0.55"/>`;
    }
    placed.push({ x, y, w });
    return `${leader}<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700"
      fill="${colourOf.get(d.key) || '#333'}" stroke="#fff" stroke-width="2.4" paint-order="stroke">${esc(d.label)}</text>`;
  }).join('');

  const two = drawn.filter((d) => d.circles.length > 1);
  return `<div class="mapbox">${svgBox(P, basemap(P, false) + rings + labels, 186)}</div>
    <p class="muted">Each ring covers where most of that driver's work sits. Somebody who works two
    areas gets two rings rather than one stretched between them${two.length ? ` — ${esc(two.map((d) => d.label).join(', '))}` : ''}.
    A ring is a habit, not a boundary: rings overlap because areas are shared, and the town table
    on the next page says who usually has a place when two of them cross it.</p>`;
})();

// ── the lookup table — the page a trainee actually uses ─────────────────────
// Sorted by CITY, because the question arrives as a place name ("this one's in Dacula"), not as
// a number. The busiest-first ordering the aggregation returns is right for a screen and wrong
// for a printed index.
const byCity = [...zips].sort((a, b) =>
  String(a.city || 'zzz').localeCompare(String(b.city || 'zzz')) || a.zip.localeCompare(b.zip));
const lookupRows = byCity.map((z) => `<tr>
  <td class="city">${esc(z.city || '—')}</td>
  <td class="mono">${esc(z.zip)}</td>
  <td><b>${esc(z.ownerLabel)}</b></td>
  <td class="num ${z.share < 0.6 ? 'warn' : ''}">${pct(z.share)}</td>
  <td class="also">${z.others.length ? esc(z.others.slice(0, 3).map((o) => o.label).join(', ')) : '<span class="muted">—</span>'}</td>
  <td class="num">${z.total}</td></tr>`).join('');

// ── one card per driver ─────────────────────────────────────────────────────
// ALPHABETICAL, because this is a reference somebody flips through looking for a name. Busiest-
// first is right for a dashboard and wrong for a booklet: nobody knows a man's rank to find him.
const circleBy = new Map(circleSets.map((c) => [c.key, c]));
const cards = [...drivers].sort((a, b) => a.label.localeCompare(b.label)).map((d) => {
  const cs = circleBy.get(d.key);
  const pts = pointsBy.get(d.key) || [];
  let map = '<div class="nomap">No coordinates for this driver — read the ZIP list.</div>';
  if (frame && pts.length) {
    const P = projector(300);
    // NO DOTS. Chad, on the version that had them: "Dont put all the dots." A driver with no ring
    // still needs SOMETHING on his card or the square is blank and teaches nothing, so his stops
    // show as a light scatter there and only there — which is exactly the fact about him.
    const scatter = (cs?.circles || []).length ? '' : pts.filter((p) => P.inside(p.lat, p.lng))
      .map((p) => `<circle cx="${P.sx(p.lng).toFixed(1)}" cy="${P.sy(p.lat).toFixed(1)}" r="2"
      fill="${INK}" fill-opacity="0.5"/>`).join('');
    const dots = scatter;
    // The circle goes OVER the dots so the summary is visibly a claim about them, and stays
    // hollow so it can never hide the evidence it is drawn from.
    // A TIGHT MAN'S RING MUST STILL BE VISIBLE. Anthony Bennett's patch is six miles across —
    // at the fleet's scale that is three millimetres, and drawn thin it vanishes under his own
    // dots, so his card and a no-ring card look alike. A white halo under the stroke lifts it
    // off the dots without inflating the ring, which would be a lie about the size.
    const rings = (cs?.circles || []).map((c) => {
      const r = Math.max(7, P.rpx(c.radiusKm)).toFixed(1);
      const at = `cx="${P.sx(c.lng).toFixed(1)}" cy="${P.sy(c.lat).toFixed(1)}" r="${r}"`;
      return `<circle ${at} fill="none" stroke="#fff" stroke-width="4.2" stroke-opacity="0.85"/>
        <circle ${at} fill="${INK}" fill-opacity="0.09" stroke="${INK}" stroke-width="2.2"/>`;
    }).join('');
    map = `<div class="m">${svgBox(P, basemap(P, true) + dots + rings, 82)}</div>`;
  }
  const coreCities = [...new Set(d.core.map((c) => c.city).filter(Boolean))];
  // A RING IS ONLY HONEST IF ITS SIZE IS SAID OUT LOUD. Davis territories run from 5 to 37
  // miles across and on a 96mm map of the whole metro they look much alike; a trainee reading
  // "usual area: Buford" off a ring nineteen miles wide has been told something false by the
  // picture. So the width is printed in miles, and the share falling outside it as well.
  const across = cs && cs.circles.length
    ? Math.round(2 * Math.max(...cs.circles.map((c) => c.radiusKm)) * 0.621371) : 0;
  const banner = cs && cs.circles.length
    ? `<p class="area"><b>Usual area:</b> ${esc(coreCities.slice(0, 5).join(', ') || d.core.map((c) => c.zip).join(', '))}
       <span class="muted">· about ${across} miles across</span>
       ${cs.circles.length > 1 ? `<span class="muted">· works ${cs.circles.length} separate areas</span>` : ''}
       ${cs.outsideShare > 0.1 ? `<span class="muted">· ${pct(cs.outsideShare)} of his stops fall outside the ring${cs.circles.length > 1 ? 's' : ''}</span>` : ''}</p>`
    : `<p class="area nofix"><b>No fixed area.</b> His work is too spread out for a circle to describe —
       any ring would cover ground he never touches. The dots are where he actually goes; use the ZIP list.</p>`;
  const core = d.core.slice(0, 9);
  // THE TAIL READS AS TOWNS, NOT ZIPS. Atlanta alone is a dozen ZIP codes, so a per-ZIP tail
  // printed "ATLANTA (7) · ATLANTA (4) · ATLANTA (1) · ATLANTA (1)" and buried the towns he
  // genuinely visits once in a row of the town he is already known for. Rolled up by place.
  const tail = [...d.tail.reduce((m, t) => {
    const place = t.city || t.zip;
    m.set(place, (m.get(place) || 0) + t.stops);
    return m;
  }, new Map())].map(([place, stops]) => ({ place, stops }))
    .sort((a, b) => b.stops - a.stops || a.place.localeCompare(b.place));
  return `<section class="card">
    <h3>${esc(d.label)} <span class="muted">· ${d.total} stops · ${d.zipCount} ZIP codes</span></h3>
    <div class="body">${map}<div class="info">
      ${banner}
      <table class="mini"><thead><tr><th>City</th><th>ZIP</th><th class="num">Stops</th></tr></thead><tbody>
        ${core.map((c) => `<tr><td>${esc(c.city || '—')}</td><td class="mono">${esc(c.zip)}</td><td class="num">${c.stops}</td></tr>`).join('')}
        ${d.core.length > core.length ? `<tr><td colspan="3" class="muted">…and ${d.core.length - core.length} more ZIP codes in his core</td></tr>` : ''}
      </tbody></table>
    </div></div>
    ${tail.length ? `<p class="tail"><b>Also runs:</b> ${esc(tail.slice(0, 12).map((t) => `${t.place} (${t.stops})`).join(' · '))}${tail.length > 12 ? ` … and ${tail.length - 12} more` : ''}</p>` : ''}
  </section>`;
}).join('');

const noArea = circleSets.filter((d) => d.noFixedArea).map((d) => d.label).sort();
const win = input.window || {};
return `<!doctype html><html><head><meta charset="utf-8"><title>Driver areas</title><style>
  @page { size: letter; margin: 14mm 13mm; }
  * { box-sizing: border-box; }
  body { font: 11px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color: #1a1a1a; margin: 0; }
  h1 { font-size: 23px; margin: 0 0 2px; letter-spacing: -.01em; }
  h2 { font-size: 14px; margin: 18px 0 7px; padding-bottom: 4px; border-bottom: 2px solid #1a1a1a; }
  h3 { font-size: 12.5px; margin: 0 0 5px; }
  .muted { color: #6b6b6b; font-weight: 400; }
  .sub { color: #555; margin: 0 0 10px; }
  .cov { background: #f4f4f2; border-left: 3px solid #1a1a1a; padding: 8px 11px; margin: 10px 0 12px; font-size: 10.5px; }
  .warnbox { background: #fff6e5; border-left: 3px solid #b8860b; padding: 8px 11px; margin: 10px 0; font-size: 10.5px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; color: #555;
       border-bottom: 1px solid #bbb; padding: 3px 5px; }
  td { padding: 2.5px 5px; border-bottom: 1px solid #eee; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace,SFMono-Regular,Menlo,monospace; font-size: 10px; }
  .city { font-weight: 600; }
  .also { color: #555; font-size: 10px; }
  .warn { color: #a4462d; font-weight: 700; }
  .mapbox { border: 1px solid #ccc; background: #fdfdfc; width: fit-content; margin: 0 auto;
            break-inside: avoid; page-break-inside: avoid; }
  .card { break-inside: avoid; page-break-inside: avoid; margin: 0 0 9px; padding: 8px 10px 9px; border: 1px solid #ddd; }
  .card .body { display: flex; gap: 11px; align-items: flex-start; }
  .card .m { width: 82mm; flex: none; border: 1px solid #ddd; background: #fdfdfc; }
  .card .info { flex: 1; min-width: 0; }
  .nomap { width: 82mm; flex: none; font-size: 10px; color: #6b6b6b; padding: 8px; border: 1px dashed #ccc; }
  .area { margin: 0 0 6px; font-size: 10.5px; }
  .area.nofix { background: #fff6e5; padding: 6px 8px; border-left: 3px solid #b8860b; }
  .tail { margin: 7px 0 0; font-size: 10px; color: #444; }
  .mini td, .mini th { padding: 1.5px 5px; }
  .page { page-break-before: always; }
  .samp { background: #b8860b; color: #fff; padding: 7px 11px; margin: 0 0 12px; font-size: 11px; }
  footer { margin-top: 14px; padding-top: 6px; border-top: 1px solid #ddd; font-size: 9.5px; color: #777; }
</style></head><body>

${input.sample ? `<div class="samp"><b>SAMPLE — INVENTED DATA.</b> Made-up names and volumes, to show the
  layout only. These are NOT real routes and must not be given to anybody as a reference.</div>` : ''}
<h1>Driver areas — who usually runs where</h1>
<p class="sub">Davis Delivery Service${win.from ? ` · deliveries from ${esc(win.from)} to ${esc(win.to)}` : ''}${input.generatedAt ? ` · prepared ${esc(String(input.generatedAt).slice(0, 10))}` : ''}
  · ${drivers.length} drivers${noArea.length ? `, ${noArea.length} of them without a settled patch (listed overleaf)` : ''}</p>

${overview}

<div class="page"></div>
<div class="cov">
  <b>What this is built from.</b> ${cov.usable.toLocaleString()} deliveries across
  <b>${cov.days}</b> working day${cov.days === 1 ? '' : 's'}, ${drivers.length} drivers, ${zips.length} ZIP codes.
  ${cov.noZip ? `${cov.noZip} stop${cov.noZip === 1 ? '' : 's'} had no usable ZIP and ${cov.noDriver} had no driver — both left out.` : ''}
  ${!cov.rosterApplied ? '<br><b>Note:</b> no driver roster was applied, so line-haul carriers may appear in this list alongside people.' : ''}
  <br><b>How to use it.</b> An order comes in for a town — <b>look it up by town</b> (page 2). You want to know
  where somebody runs — find his card; they are in alphabetical order.
</div>

${cov.days < 20 ? `<div class="warnbox"><b>Read this as a starting point, not a rule.</b>
  ${cov.days} day${cov.days === 1 ? '' : 's'} of history is a thin sample — enough to show the broad
  pattern, not enough to settle an unusual day. When the sheet and a dispatcher disagree, the
  dispatcher is right.</div>` : ''}

${(() => { const rw = driverRewrites(stops); return rw.length ? `<div class="cov"><b>Names merged:</b>
  ${rw.map((r) => `${esc(r.from)} → ${esc(r.to)}`).join(' · ')}. A load named with a slash is one
  driver's second load, not two people, so both spellings count as the same person. Check these.</div>` : ''; })()}

${(input.maybeSame || []).length ? `<div class="warnbox"><b>Same person?</b>
  ${input.maybeSame.map((p) => `${esc(p.a.label)} (${p.a.stops} stops${p.a.last ? `, last ${esc(p.a.last)}` : ''})
    and ${esc(p.b.label)} (${p.b.stops}${p.b.last ? `, last ${esc(p.b.last)}` : ''})`).join(' · ')}.
  These names are one or two letters apart and share a first name — NuVizz has renamed a driver
  mid-history before. They are shown SEPARATELY here, because merging two people who are not the
  same is worse than showing one twice. Say the word and they will be counted as one.</div>` : ''}

${(input.readFailures || []).length ? `<div class="warnbox"><b>Incomplete:</b> ${input.readFailures.length}
  day${input.readFailures.length === 1 ? '' : 's'} of history could not be read
  (${input.readFailures.slice(0, 4).map((f) => esc(f.date)).join(', ')}${input.readFailures.length > 4 ? '…' : ''}),
  so this sheet is built from less than the window it names.</div>` : ''}

${excluded.length ? `<div class="warnbox"><b>Not on this sheet:</b> ${excluded.map((e) => `${esc(e.label)} — ${e.why === 'stopped running'
    ? `last ran ${esc(e.lastSeen || '?')}, ${e.daysSince} days before the end of this window`
    : `only ${e.stops} delivery${e.stops === 1 ? '' : 'ies'} in the window`}`).join(' · ')}.
  Only drivers still running are shown; somebody who has stopped has no current area to learn.</div>` : ''}

${noArea.length ? `<div class="warnbox"><b>No settled patch:</b> ${esc(noArea.join(', '))}.
  Their work is spread too wide for a circle, so their cards show the stops themselves and no ring.
  ${pct(cov.coordShare)} of all stops carry coordinates and could be mapped; the tables use ZIP, which all of them carry.</div>` : ''}

<h2>Look it up by town</h2>
<p class="sub">An order comes in for a town — this says whose it usually is. A share under 60%
is marked: that area is shared, so ask before assuming.</p>
<table><thead><tr><th>Town</th><th>ZIP</th><th>Usually</th><th class="num">Share</th><th>Also runs it</th><th class="num">Stops</th></tr></thead>
<tbody>${lookupRows}</tbody></table>

<div class="page"></div>
<h2>By driver</h2>
<p class="sub">Alphabetical. Every map is the same map at the same scale, so the cards can be
compared: the dots are that driver's actual delivery addresses, and the ring covers where most of
his work sits. Somebody who works two areas gets two rings rather than one stretched between them.</p>
${cards}

<footer>Built from delivery history. It describes what HAS happened, not what must —
a driver can be sent anywhere. Reprint it as the work changes.${input.sample ? ' <b>SAMPLE DATA — not real routes.</b>' : ''}</footer>
</body></html>`;
}
