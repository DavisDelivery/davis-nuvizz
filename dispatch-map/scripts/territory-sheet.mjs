// scripts/territory-sheet.mjs — THE PRINTED DRIVER-TERRITORY SHEET.
//
// Chad: "I want something I can print out and give to someone so want to see this in pdf before
// we roll out views in actual dispatch map."
//
// Emits ONE self-contained HTML document, print-tuned (US Letter, page breaks that never split a
// driver). Chromium turns it into the PDF. It is deliberately HTML rather than a PDF library so
// the identical renderer can later be served live by a Netlify function with no second
// implementation to drift — the same reason the roster freshness line is written once and placed
// twice rather than duplicated per view.
//
//   node scripts/territory-sheet.mjs <data.json> > sheet.html
//
// The input is whatever the aggregation produced: { generatedAt, window, coverage, zips,
// drivers, stops? }. `stops` is optional and only feeds the dot map.
import fs from 'node:fs';
import { zipOwnership, driverCore, territoryCoverage } from '../src/lib/driver-territory.js';

const src = process.argv[2];
if (!src) { console.error('usage: territory-sheet.mjs <data.json>'); process.exit(2); }
const input = JSON.parse(fs.readFileSync(src, 'utf8'));
const stops = input.stops || [];
const roster = input.roster ? new Set(input.roster.map((r) => String(r).toUpperCase())) : null;

const zips = input.zips || zipOwnership(stops, { roster });
const drivers = input.drivers || driverCore(stops, { roster });
const cov = input.coverage || territoryCoverage(stops, { roster });
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
function dotMap() {
  const pts = stops.filter((s) => Number.isFinite(Number(s?.lat)) && Number.isFinite(Number(s?.lng)))
    .map((s) => ({ lat: Number(s.lat), lng: Number(s.lng), key: (s.driverUserName || s.driverName || '').toUpperCase().replace(/\s+/g, '_') }));
  if (pts.length < 5) {
    return `<p class="muted">No map: only ${pts.length} of ${cov.stops} stops carry coordinates.
      Coordinates are geocoded and fill in over time; the tables below use ZIP, which every stop carries.</p>`;
  }
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  const pad = 0.04;
  const [y0, y1] = [Math.min(...lats) - pad, Math.max(...lats) + pad];
  const [x0, x1] = [Math.min(...lngs) - pad, Math.max(...lngs) + pad];
  const W = 660, H = 560;
  // Equirectangular, corrected for latitude so the metro is not stretched east-west.
  const kx = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
  const sx = (lng) => ((lng - x0) / ((x1 - x0) || 1)) * W;
  const sy = (lat) => H - ((lat - y0) / ((y1 - y0) || 1)) * H;
  const depot = input.depot || { lat: 34.14838, lng: -83.95948, name: 'Buford Terminal' };
  const dots = pts.map((p) =>
    `<circle cx="${sx(p.lng).toFixed(1)}" cy="${sy(p.lat).toFixed(1)}" r="2.4" fill="${colourOf.get(p.key) || '#999'}" opacity="0.72"/>`).join('');
  const dep = (depot.lat >= y0 && depot.lat <= y1 && depot.lng >= x0 && depot.lng <= x1)
    ? `<g><rect x="${(sx(depot.lng) - 5).toFixed(1)}" y="${(sy(depot.lat) - 5).toFixed(1)}" width="10" height="10" fill="#111"/>
       <text x="${(sx(depot.lng) + 9).toFixed(1)}" y="${(sy(depot.lat) + 4).toFixed(1)}" font-size="11" font-weight="700">${esc(depot.name)}</text></g>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="aspect-ratio:${W}/${H};border:1px solid #ccc;background:#fbfbfa">
    ${dots}${dep}</svg>
    <p class="muted">${pts.length} of ${cov.stops} stops plotted (${pct(cov.coordShare)} have coordinates).
    One dot per delivery. No shape is drawn around anyone — the pattern is whatever the work was.
    Scale is relative; this is a shape-and-cluster picture, not a road map.${kx ? '' : ''}</p>`;
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
process.stdout.write(`<!doctype html><html><head><meta charset="utf-8"><title>Driver areas</title><style>
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

<h2>The picture</h2>
${dotMap()}
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
</body></html>`);
