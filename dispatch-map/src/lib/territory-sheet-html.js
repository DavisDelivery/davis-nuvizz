// src/lib/territory-sheet-html.js — THE PRINTED DRIVER-AREA SHEET, AS ONE FUNCTION.
//
// Chad: "I want something I can print out and give to someone", and then, having seen it:
// "I like the circles."
//
// WRITTEN ONCE, CALLED TWICE. This is the whole sheet — markup, print CSS, the map — as a pure
// string builder over plain data. scripts/territory-sheet.mjs renders it from a JSON file for a
// PDF; netlify/functions/driver-territory.mts serves the identical bytes live. Building the
// page in two places is exactly how the two drift until the printout and the screen disagree,
// which this repo has already paid for on the roster freshness line.
//
// PURE: no Firestore, no network, no filesystem, no clock of its own. `input.generatedAt` is
// passed in rather than read, so the same data renders the same page every time.
import { zipOwnership, driverCore, territoryCoverage, activeDrivers, driverCircles, driverRewrites, rosterOf } from './driver-territory.js';
import COUNTIES from './ga-north-counties.json' with { type: 'json' };

// Orientation labels. A printed map of anonymous county outlines is a puzzle; a dozen familiar
// names turn it into a map of somewhere. These are the towns' own coordinates, not derived data.
const TOWNS = [
  ['Atlanta', 33.749, -84.388], ['Buford', 34.121, -84.000], ['Athens', 33.958, -83.378],
  ['Lawrenceville', 33.956, -83.988], ['Gainesville', 34.298, -83.824], ['Marietta', 33.953, -84.550],
  ['Duluth', 34.003, -84.145], ['Cumming', 34.207, -84.140], ['Winder', 33.993, -83.720],
  ['Conyers', 33.668, -84.018], ['Douglasville', 33.752, -84.748], ['Canton', 34.237, -84.491],
];

export function territorySheetHtml(input = {}) {
const stops = input.stops || [];
const roster = input.roster ? rosterOf(input.roster) : null;

// ONLY DRIVERS WHO HAVE ACTUALLY RUN IN THE WINDOW. Chad: "terry hasn't ran for me in a long
// time ... just guys that have ran in last 4 weeks."
const { active: activeSet, excluded } = activeDrivers(stops, { roster, minStops: input.minStops ?? 5 });
const inWindow = stops.filter((s) => activeSet.has((s?.driverUserName || s?.driverName || '').toUpperCase().replace(/\s+/g, '_')));
const zips = input.zips || zipOwnership(inWindow, { roster });
const drivers = input.drivers || driverCore(inWindow, { roster });
const cov = input.coverage || territoryCoverage(inWindow, { roster });
const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (n) => `${Math.round((n || 0) * 100)}%`;

// A stable colour per driver. Printed sheets get photocopied, so these are chosen to stay
// distinguishable in greyscale as well — varied lightness, not just varied hue.
const PALETTE = ['#1f4e79', '#a4462d', '#3f7d3f', '#6b4a8a', '#8a6d1f', '#256b6b', '#8a3060', '#4a5a6b'];
const colourOf = new Map(drivers.map((d, i) => [d.key, PALETTE[i % PALETTE.length]]));

// ── the dot map ─────────────────────────────────────────────────────────────
// EVERY STOP IS ONE DOT, and no shape is fitted over them. That is the whole argument against
// circles rendered as a picture: a driver who works two clusters shows as two clusters, and a
// driver who scatters looks scattered, instead of both being flattened into an ellipse whose
// centre may be somewhere neither of them goes.
function territoryMap() {
  // WHAT CHANGED AND WHY, because the first draft got both halves wrong.
  //
  // Chad: "the dots didn't lay over an actual map of north Georgia and I think big circles will
  // work better than dots."
  //
  // (1) THE BASEMAP. A dot cloud on white has no geography in it — you cannot tell Buford from
  //     Bogart, and a trainee cannot place anything. Real county outlines (US Census, public
  //     domain) and a dozen town labels turn the same data into a map of somewhere.
  // (2) CIRCLES. I argued for dots and Chad has overruled it, having seen both. So: circles —
  //     but ONE PER CLUSTER (driverCircles), because a single circle over a two-cluster driver
  //     is centred on ground he never touches. That was the real objection to circles, and it
  //     is answered by the clustering rather than by refusing him the shape he asked for.
  const circleSets = input.circles || driverCircles(stops, { roster, active: activeSet });
  const drawn = circleSets.filter((d) => d.circles.length);
  if (!drawn.length) {
    return `<p class="muted">No circles: none of the active drivers has enough stops carrying
      coordinates. Coordinates are geocoded and fill in over time; the tables below use ZIP,
      which every stop carries.</p>`;
  }

  // Frame on the WORK, then pad, so the map is of where they actually run rather than of the
  // whole state. Counties are clipped to that frame by the viewBox.
  const all = drawn.flatMap((d) => d.circles);
  const latPad = 0.30, lngPad = 0.34;
  const y0 = Math.min(...all.map((c) => c.lat - c.radiusKm / 110)) - latPad;
  const y1 = Math.max(...all.map((c) => c.lat + c.radiusKm / 110)) + latPad;
  const x0 = Math.min(...all.map((c) => c.lng - c.radiusKm / 92)) - lngPad;
  const x1 = Math.max(...all.map((c) => c.lng + c.radiusKm / 92)) + lngPad;

  const W = 660;
  const midLat = (y0 + y1) / 2;
  const aspect = Math.cos((midLat * Math.PI) / 180);          // no east-west stretch
  const H = Math.round((W * (y1 - y0)) / ((x1 - x0) * aspect));
  const sx = (lng) => ((lng - x0) / (x1 - x0)) * W;
  const sy = (lat) => H - ((lat - y0) / (y1 - y0)) * H;
  const rpx = (km) => (km / 111 / (y1 - y0)) * H;             // radius in latitude degrees → px

  const counties = COUNTIES.map((c) => c.rings.map((r) => {
    const d = r.map(([lng, lat], i) => `${i ? 'L' : 'M'}${sx(lng).toFixed(1)},${sy(lat).toFixed(1)}`).join('');
    return `<path d="${d}Z" fill="#f2f1ee" stroke="#c9c7c1" stroke-width="0.7"/>`;
  }).join('')).join('');

  const towns = TOWNS.filter(([, lat, lng]) => lat > y0 && lat < y1 && lng > x0 && lng < x1)
    .map(([n, lat, lng]) => `<g><circle cx="${sx(lng).toFixed(1)}" cy="${sy(lat).toFixed(1)}" r="1.8" fill="#555"/>
      <text x="${(sx(lng) + 4).toFixed(1)}" y="${(sy(lat) + 3).toFixed(1)}" font-size="9" fill="#444">${esc(n)}</text></g>`).join('');

  // Big circles last so they sit over the geography, translucent so overlaps stay readable and
  // so a county line underneath is still visible — which is what makes it a map and not a blob.
  const blobs = drawn.flatMap((d) => d.circles.map((c) => {
    const col = colourOf.get(d.key) || '#777';
    return `<circle cx="${sx(c.lng).toFixed(1)}" cy="${sy(c.lat).toFixed(1)}" r="${Math.max(6, rpx(c.radiusKm)).toFixed(1)}"
      fill="${col}" fill-opacity="0.17" stroke="${col}" stroke-width="1.8" stroke-opacity="0.85"/>`;
  })).join('');
  // LABELS MUST NOT SIT ON TOP OF EACH OTHER. Two drivers who share an area have circles at
  // nearly the same point, and centring both names there printed "Colin" straight through
  // "Marcus" — unreadable, and on a printed sheet there is no hover to recover it. So each label
  // is nudged down until it clears the ones already placed. Deterministic (biggest circle first),
  // so the same data lays out the same way every time it is printed.
  const placed = [];
  const tags = drawn.flatMap((d) => d.circles.map((c) => ({ d, c })))
    .sort((a, b) => b.c.stops - a.c.stops)
    .map(({ d, c }) => {
      const x = sx(c.lng);
      let y = sy(c.lat);
      while (placed.some((p) => Math.abs(p.x - x) < 46 && Math.abs(p.y - y) < 12)) y += 12;
      placed.push({ x, y });
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}"
      text-anchor="middle" font-size="10" font-weight="700" fill="${colourOf.get(d.key) || '#333'}"
      stroke="#fff" stroke-width="2.6" paint-order="stroke">${esc(d.label)}</text>`;
    }).join('');

  const depot = input.depot || { lat: 34.14838, lng: -83.95948, name: 'Buford Terminal' };
  const dep = (depot.lat > y0 && depot.lat < y1 && depot.lng > x0 && depot.lng < x1)
    ? `<g><rect x="${(sx(depot.lng) - 4).toFixed(1)}" y="${(sy(depot.lat) - 4).toFixed(1)}" width="8" height="8" fill="#111"/>
       <text x="${(sx(depot.lng) + 7).toFixed(1)}" y="${(sy(depot.lat) + 3).toFixed(1)}" font-size="9.5" font-weight="700"
         stroke="#fff" stroke-width="2.6" paint-order="stroke">${esc(depot.name)}</text></g>` : '';

  const scattered = drawn.filter((d) => d.circles.length > 1);
  const noArea = circleSets.filter((d) => d.noFixedArea);
  return `<div class="mapbox"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
    width="100%" height="100%" style="display:block">
    ${counties}${towns}${blobs}${dep}${tags}</svg></div>
    <p class="muted">Each circle covers where most of that driver's work sits — 80% of the stops in
    that cluster. Somebody who works two areas gets two circles rather than one big one stretched
    between them${scattered.length ? ` (${esc(scattered.map((d) => d.label).join(', '))})` : ''}.
    ${pct(cov.coordShare)} of stops carry coordinates and could be placed; the tables use ZIP, which all of them carry.</p>
    ${noArea.length ? `<p class="nocircle"><b>Not drawn:</b> ${esc(noArea.map((d) => d.label).join(', '))}.
      Their work is spread too thin to sit inside a circle — any circle would cover ground they
      never touch. Use the town list for them.</p>` : ''}`;
}

const legend = drivers.map((d) =>
  `<span class="lg"><i style="background:${colourOf.get(d.key)}"></i>${esc(d.label)}</span>`).join('');

// ── the lookup table — the page a trainee actually uses ─────────────────────
// Sorted by CITY, because the question arrives as a place name ("this one's in Dacula"), not as
// a number. The busiest-first ordering the aggregation returns is right for a screen and wrong
// for a printed index.
const byCity = [...zips].sort((a, b) =>
  String(a.city || 'zzz').localeCompare(String(b.city || 'zzz')) || a.zip.localeCompare(b.zip));
const lookupRows = byCity.map((z) => `<tr>
  <td class="city">${esc(z.city || '—')}</td>
  <td class="mono">${esc(z.zip)}</td>
  <td><b style="color:${colourOf.get(z.owner) || '#333'}">${esc(z.ownerLabel)}</b></td>
  <td class="num ${z.share < 0.6 ? 'warn' : ''}">${pct(z.share)}</td>
  <td class="also">${z.others.length ? esc(z.others.slice(0, 3).map((o) => o.label).join(', ')) : '<span class="muted">—</span>'}</td>
  <td class="num">${z.total}</td></tr>`).join('');

// ── one block per driver ────────────────────────────────────────────────────
const driverBlocks = drivers.map((d) => {
  const coreCities = [...new Set(d.core.map((c) => c.city).filter(Boolean))];
  const banner = d.concentrated
    ? `<p class="area">Usual area: <b>${esc(coreCities.join(', ') || d.core.map((c) => c.zip).join(', '))}</b></p>`
    : `<p class="area nofix"><b>No fixed area.</b> ${d.core.length} ZIP codes are needed to cover
       ${pct(d.coreShare)} of this driver's work, across ${d.zipCount} in total — read the list, not a shape.</p>`;
  return `<section class="drv">
    <h3><i style="background:${colourOf.get(d.key)}"></i>${esc(d.label)}
      <span class="muted">· ${d.total} stops · ${d.zipCount} ZIP codes</span></h3>
    ${banner}
    <table class="mini"><thead><tr><th>City</th><th>ZIP</th><th class="num">Stops</th></tr></thead><tbody>
      ${d.core.map((c) => `<tr><td>${esc(c.city || '—')}</td><td class="mono">${esc(c.zip)}</td><td class="num">${c.stops}</td></tr>`).join('')}
    </tbody></table>
    ${d.tail.length ? `<p class="tail"><b>Also runs:</b> ${esc(d.tail.slice(0, 14).map((t) => `${t.city || t.zip} (${t.stops})`).join(' · '))}${d.tail.length > 14 ? ` … and ${d.tail.length - 14} more` : ''}</p>` : ''}
  </section>`;
}).join('');

const win = input.window || {};
return `<!doctype html><html><head><meta charset="utf-8"><title>Driver areas</title><style>
  @page { size: letter; margin: 14mm 13mm; }
  * { box-sizing: border-box; }
  body { font: 11px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; color: #1a1a1a; margin: 0; }
  h1 { font-size: 23px; margin: 0 0 2px; letter-spacing: -.01em; }
  h2 { font-size: 14px; margin: 20px 0 7px; padding-bottom: 4px; border-bottom: 2px solid #1a1a1a; }
  h3 { font-size: 12.5px; margin: 0 0 4px; display: flex; align-items: center; gap: 6px; }
  h3 i, .lg i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; flex: none; }
  .muted { color: #6b6b6b; font-weight: 400; }
  .sub { color: #555; margin: 0 0 10px; }
  .cov { background: #f4f4f2; border-left: 3px solid #1a1a1a; padding: 8px 11px; margin: 10px 0 14px; font-size: 10.5px; }
  .cov b { font-variant-numeric: tabular-nums; }
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
  .lg { display: inline-flex; align-items: center; gap: 4px; margin: 0 10px 4px 0; font-size: 10px; }
  .legend { margin: 6px 0 2px; }
  .drv { break-inside: avoid; page-break-inside: avoid; margin: 0 0 13px; padding: 9px 10px; border: 1px solid #ddd; }
  .area { margin: 3px 0 6px; font-size: 11px; }
  .mapbox { height: 128mm; border: 1px solid #ccc; background: #fdfdfc; break-inside: avoid; page-break-inside: avoid; }
  .nocircle { background: #fff6e5; border-left: 3px solid #b8860b; padding: 6px 9px; margin: 6px 0 0; font-size: 10.5px; }
  .area.nofix { background: #fff6e5; padding: 5px 7px; border-left: 3px solid #b8860b; }
  .tail { margin: 6px 0 0; font-size: 10px; color: #444; }
  .mini td, .mini th { padding: 1.5px 5px; }
  .page { page-break-before: always; }
  .samp { background: #b8860b; color: #fff; padding: 7px 11px; margin: 0 0 12px; font-size: 11px;
          letter-spacing: .01em; }
  footer { margin-top: 14px; padding-top: 6px; border-top: 1px solid #ddd; font-size: 9.5px; color: #777; }
</style></head><body>

${input.sample ? `<div class="samp"><b>SAMPLE — INVENTED DATA.</b> Made-up names and volumes, to show the
  layout only. These are NOT real routes and must not be given to anybody as a reference.</div>` : ''}
<h1>Driver areas — who usually runs where</h1>
<p class="sub">Davis Delivery Service${win.from ? ` · deliveries from ${esc(win.from)} to ${esc(win.to)}` : ''}${input.generatedAt ? ` · prepared ${esc(String(input.generatedAt).slice(0, 10))}` : ''}</p>

<div class="cov">
  <b>What this is built from.</b> ${cov.usable.toLocaleString()} deliveries across
  <b>${cov.days}</b> working day${cov.days === 1 ? '' : 's'}, ${drivers.length} drivers, ${zips.length} ZIP codes.
  ${cov.noZip ? `${cov.noZip} stop${cov.noZip === 1 ? '' : 's'} had no usable ZIP and ${cov.noDriver} had no driver — both left out.` : ''}
  ${!cov.rosterApplied ? '<br><b>Note:</b> no driver roster was applied, so line-haul carriers may appear in this list alongside people.' : ''}
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

<h2>The picture</h2>
${territoryMap()}
<div class="legend">${legend}</div>

<div class="page"></div>
<h2>Look it up by town</h2>
<p class="sub">An order comes in for a town — this says whose it usually is. A share under 60%
is marked: that area is shared, so ask before assuming.</p>
<table><thead><tr><th>Town</th><th>ZIP</th><th>Usually</th><th class="num">Share</th><th>Also runs it</th><th class="num">Stops</th></tr></thead>
<tbody>${lookupRows}</tbody></table>

<div class="page"></div>
<h2>By driver</h2>
<p class="sub">The ZIP codes covering most of each driver's work, busiest first. Where somebody has
no settled patch it says so rather than drawing one.</p>
${driverBlocks}

<footer>Built from delivery history. It describes what HAS happened, not what must —
a driver can be sent anywhere. Reprint it as the work changes.${input.sample ? ' <b>SAMPLE DATA — not real routes.</b>' : ''}</footer>
</body></html>`;
}
