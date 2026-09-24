// label-html.js — draws the Davis delivery label as a printable HTML document: one US Letter
// page per physical piece. PURE (no DOM, no network): it returns a string that App.jsx hands to
// PrintDocModal — the same viewer and Print button the Delivery Ticket uses, so a label prints
// the way a ticket prints (and never opens a new window, which strands the iPad home-screen app).
//
// The rules (which pages, what the barcode says) live in order-labels.js; this file only lays
// them out. The barcode and the QR are SVG — vectors, sharp on any printer. Layout is the v4
// mockup Chad approved: logo + service date; SHIP TO in big type; THIS PIECE ("SKID 1 of 2")
// beside the order's skid / loose / total / weight; one barcode across the page; the NuVizz
// stop # and reference; items and delivery notes; the website QR beside "WE CAN DELIVER FOR YOU
// TOO!"; ship-from and print stamp in the footer.
//
// Every block has a FIXED height and clips inside itself, so a long name, a long street, a long
// item description or long notes can shrink, wrap or be cut with an ellipsis — but never print
// over the next field and never push a page onto a second sheet.
import { code128Modules } from './code128.js';
import { LABEL_PROMO, LABEL_QR_ROWS, labelPayload, labelPieces, labelDay, labelStamp } from './order-labels.js';

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
// A line break or tab pasted into a name, address or note is a space on paper (it printed as
// "?" in the PDF draft).
const flat = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const n = (v) => { const k = Number(String(v ?? '').trim()); return Number.isFinite(k) && k > 0 ? Math.floor(k) : 0; };

// Font size by length: the longest text that still fits the line at that size (Helvetica bold
// capitals run ~0.72em per character; the page's text column is 7.5in = 540pt).
const pick = (len, steps) => { for (const [max, size] of steps) if (len <= max) return size; return steps[steps.length - 1][1]; };

/** The barcode as SVG: 7.5in wide at most, bars never wider than 2.4pt (33 mil). */
export function barcodeSvg(text, { maxWidthIn = 7.5, heightIn = 1.7 } = {}) {
  const mods = code128Modules(text);                         // throws on a character Code 128 cannot carry
  const total = mods.reduce((a, b) => a + b, 0);
  const xIn = Math.min(maxWidthIn / total, 2.4 / 72);
  let x = 0;
  let d = '';
  mods.forEach((m, k) => { if (k % 2 === 0) d += `M${x} 0h${m}v100h-${m}z`; x += m; });
  const w = (xIn * total).toFixed(4);
  return `<svg class="bc" xmlns="http://www.w3.org/2000/svg" width="${w}in" height="${heightIn}in" viewBox="0 0 ${total} 100" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="${esc(text)}"><path d="${d}" fill="#000"/></svg>`;
}

/** The website QR as SVG, with the 4-module quiet zone the QR spec asks for. */
export function qrSvg(sizeIn = 1.35) {
  const size = LABEL_QR_ROWS.length, q = 4;
  let d = '';
  LABEL_QR_ROWS.forEach((row, r) => {
    let c = 0;
    while (c < size) {
      if (row[c] !== '1') { c++; continue; }
      let e = c;
      while (e < size && row[e] === '1') e++;
      d += `M${c + q} ${r + q}h${e - c}v1h-${e - c}z`;
      c = e;
    }
  });
  const box = size + 2 * q;
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" width="${sizeIn}in" height="${sizeIn}in" viewBox="0 0 ${box} ${box}" shape-rendering="crispEdges"><rect width="${box}" height="${box}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const STYLE = `
  @page { size: letter portrait; margin: 0.3in; }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; }
  body { font-family: Arial, Helvetica, sans-serif; color:#000; background:#fff; }
  .pg { width: 7.9in; height: 10.35in; padding: 0.1in 0.2in; display:flex; flex-direction:column; overflow:hidden; break-after: page; page-break-after: always; }
  .pg:last-child { break-after: auto; page-break-after: auto; }
  .gray { color:#5f5f5f; }
  .brand { color:#1a549e; }
  .cap { font-size:9pt; font-weight:bold; letter-spacing:.02em; }
  .hdr { height:1.05in; flex:none; display:flex; justify-content:space-between; align-items:center; border-bottom:3.5pt solid #000; }
  .hdr img { height:0.8in; width:auto; }
  .hdr .name { font-size:20pt; font-weight:bold; }
  .hdr .date { text-align:right; }
  .hdr .date .v { font-size:22pt; font-weight:bold; }
  .ship { height:2.62in; flex:none; padding-top:0.12in; overflow:hidden; }
  .clamp { display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
  .ship .nm { font-weight:bold; line-height:1.05; -webkit-line-clamp:2; margin-top:2pt; }
  .ship .st { line-height:1.15; -webkit-line-clamp:2; margin-top:6pt; }
  .ship .ct { font-weight:bold; line-height:1.05; -webkit-line-clamp:2; margin-top:6pt; }
  .ship .ph { font-size:15pt; margin-top:6pt; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .piece { height:1.62in; flex:none; margin-top:0.08in; display:flex; border:2.5pt solid #000; }
  .piece .me { flex:0 0 4.55in; border-right:1.5pt solid #000; padding:0.12in 0.18in; display:flex; flex-direction:column; justify-content:space-between; }
  .piece .big { font-size:52pt; font-weight:bold; line-height:1; white-space:nowrap; }
  .piece .sub { font-size:13pt; }
  .piece .sub.warn { color:#c41a1a; font-weight:bold; }
  .grid { flex:1; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; }
  .grid > div { padding:0.06in 0.1in; border-left:1pt solid #000; border-top:1pt solid #000; display:flex; flex-direction:column; }
  .grid > div:nth-child(odd) { border-left:0; }
  .grid > div:nth-child(-n+2) { border-top:0; }
  .grid .v { flex:1; display:flex; align-items:center; justify-content:center; font-size:26pt; font-weight:bold; white-space:nowrap; }
  .bar { height:1.9in; flex:none; display:flex; align-items:center; justify-content:center; }
  .refs { height:1.7in; flex:none; display:flex; gap:0.2in; border-top:1.5pt solid #000; padding-top:0.1in; }
  .refs .cols { flex:1; min-width:0; display:grid; grid-template-columns:1fr 1fr; grid-template-rows:auto auto; column-gap:0.15in; row-gap:0.08in; align-content:start; }
  .refs .kv { min-width:0; overflow:hidden; }
  .refs .kv .v { font-weight:bold; font-size:14pt; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .refs .kv .v.mono { font-family: "Courier New", Courier, monospace; }
  .refs .kv .t { font-size:10.5pt; line-height:1.25; -webkit-line-clamp:4; }
  .refs .qrbox { flex:0 0 1.55in; display:flex; flex-direction:column; align-items:center; }
  .refs .qrbox .cap { margin-top:2pt; font-size:8pt; text-align:center; }
  .tag { flex:1; display:flex; flex-direction:column; justify-content:center; border-top:0.75pt solid #999; }
  .tag .h { font-size:22pt; font-weight:bold; }
  .tag .c { font-size:13pt; }
  .foot { height:0.32in; flex:none; display:flex; justify-content:space-between; gap:0.2in; align-items:center; border-top:0.75pt solid #999; font-size:8pt; }
  .foot .from { min-width:0; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .foot .stamp { flex:none; white-space:nowrap; }
`;

function pageHtml(o, pc, pageCount, { logoUrl, printedAt, barcode }) {
  const name = flat(o.name).toUpperCase() || '—';
  const street = [flat(o.addr1), flat(o.addr2)].filter(Boolean).join(', ');
  const city = `${flat(o.city).toUpperCase()}, ${flat(o.state).toUpperCase()} ${flat(o.zip)}`;
  const nameSize = pick(name.length, [[17, 42], [20, 36], [25, 30], [48, 28], [9999, 24]]);
  const streetSize = pick(street.length, [[34, 26], [44, 22], [60, 18], [9999, 16]]);
  const citySize = pick(city.length, [[22, 38], [28, 32], [36, 26], [9999, 22]]);
  const wt = n(o.weight);
  const big = `${pc.kind} ${pc.kindIdx} of ${pc.kindTotal}`;
  const bigSize = pick(big.length, [[12, 52], [14, 46], [9999, 40]]);
  const from = o.origin && o.origin.name
    ? `FROM  ${flat(o.origin.name)} · ${flat(o.origin.addr1)}, ${flat(o.origin.city)}, ${flat(o.origin.state)} ${flat(o.origin.zip)}`
    : '';
  const notes = flat(o.dispatchNotes);
  const items = flat(o.itemDesc);
  return `<div class="pg">
  <div class="hdr">
    ${logoUrl ? `<img src="${esc(logoUrl)}" alt="Davis Delivery Service"/>` : '<div class="name brand">DAVIS DELIVERY SERVICE</div>'}
    <div class="date"><div class="cap gray">SERVICE DATE</div><div class="v">${esc(labelDay(o.serviceDate) || '—')}</div></div>
  </div>
  <div class="ship">
    <div class="cap gray">SHIP TO</div>
    <div class="nm clamp" style="font-size:${nameSize}pt">${esc(name)}</div>
    ${street ? `<div class="st clamp" style="font-size:${streetSize}pt">${esc(street)}</div>` : ''}
    <div class="ct clamp" style="font-size:${citySize}pt">${esc(city)}</div>
    ${flat(o.phone) ? `<div class="ph">Phone&nbsp; ${esc(flat(o.phone))}</div>` : ''}
  </div>
  <div class="piece">
    <div class="me">
      <div class="cap gray">THIS PIECE</div>
      <div class="big" style="font-size:${bigSize}pt">${esc(big)}</div>
      ${pc.countMissing
        ? '<div class="sub warn">No skid / loose count was entered on this order</div>'
        : `<div class="sub">Piece ${pc.seq} of ${pc.total} on this order</div>`}
    </div>
    <div class="grid">
      <div><span class="cap gray">SKIDS</span><span class="v">${n(o.pallets)}</span></div>
      <div><span class="cap gray">LOOSE</span><span class="v">${n(o.loose)}</span></div>
      <div><span class="cap gray">TOTAL PIECES</span><span class="v">${pc.total}</span></div>
      <div><span class="cap gray">WEIGHT (LB)</span><span class="v">${wt ? wt.toLocaleString('en-US') : '—'}</span></div>
    </div>
  </div>
  <div class="bar">${barcode}</div>
  <div class="refs">
    <div class="cols">
      <div class="kv"><div class="cap gray">NUVIZZ STOP #</div><div class="v mono">${esc(o.stopNbr)}</div></div>
      <div class="kv"><div class="cap gray">REFERENCE</div><div class="v">${esc(flat(o.ref) || '—')}</div></div>
      <div class="kv"><div class="cap gray">ITEMS</div><div class="t clamp">${esc(items || '—')}</div></div>
      <div class="kv"><div class="cap gray">DELIVERY NOTES</div><div class="t clamp">${esc(notes || '—')}</div></div>
    </div>
    <div class="qrbox">${qrSvg(1.35)}<div class="cap brand">${esc(LABEL_PROMO.qrCaption)}</div></div>
  </div>
  <div class="tag">
    <div class="h brand">${esc(LABEL_PROMO.headline)}</div>
    <div class="c">Call ${esc(LABEL_PROMO.phone)} or visit ${esc(LABEL_PROMO.site)}</div>
  </div>
  <div class="foot gray">
    <div class="from">${esc(from)}</div>
    <div class="stamp">Printed ${esc(labelStamp(printedAt))} &nbsp;·&nbsp; Page ${pc.seq} of ${pageCount} for this order</div>
  </div>
</div>`;
}

/**
 * Build the labels for a batch of orders.
 *
 * One bad order never blanks the batch: an order whose number cannot be put in a barcode (a
 * pasted character Code 128 cannot carry, or no number at all) is left out and NAMED in
 * `skipped`, and every other order still prints.
 *
 * @returns {{ html: string, pages: number, printed: object[], skipped: {stopNbr:string, name:string, reason:string}[] }}
 */
export function buildLabelsHtml(orders, { logoUrl = '', printedAt = new Date(), maxPages = Infinity } = {}) {
  const parts = [];
  const printed = [];
  const skipped = [];
  let pages = 0;
  for (const o of (orders || []).filter(Boolean)) {
    const pieces = labelPieces(o);
    if (pieces.length > maxPages) {
      skipped.push({ stopNbr: String(o.stopNbr || ''), name: flat(o.name), reason: `${pieces.length} pieces — over the ${maxPages}-page limit; check the count` });
      continue;
    }
    let pagesForOrder;
    try {
      pagesForOrder = pieces.map((pc) => pageHtml(o, pc, pieces.length, { logoUrl, printedAt, barcode: barcodeSvg(labelPayload(o.stopNbr, pc.seq)) }));
    } catch (e) {
      skipped.push({ stopNbr: String(o.stopNbr || ''), name: flat(o.name), reason: e?.message || 'could not build the barcode' });
      continue;
    }
    parts.push(...pagesForOrder);
    printed.push(o);
    pages += pagesForOrder.length;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Davis delivery labels</title>
<style>${STYLE}</style></head>
<body>${parts.join('\n')}</body></html>`;
  return { html, pages, printed, skipped };
}
