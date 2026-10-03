// lib/ticket-print-new.js — THE NEW LAYOUT of the printed Delivery Ticket and Driver Manifest (PURE).
//
// Chad, 2026-10-02 and 10-03, over six rounds on paper. What he asked for, in his words:
//   "Imagine that the paper is stapled in right hand corner of pages so if flipped open that
//    corner is cut off."
//   "you have taken up a little too much real estate and a lot of product info will bleed to 2nd
//    page. Pro number needs to be more pronounced."
//   "Requested date and time do not need to be pronounced very little used. I want the skid weight
//    loose row to be more pronounced."
//   "SPL-INSTR-TEXT: remove this repetitive text. Take the bol number put it on same row as phone
//    number with phone number on the right side of the row with bol number in the middle. Then
//    move the pro number on the header to the right a bit."
//   "a tiny row of space above the skid row"
//   "Make the drop off square a little smaller so not as pronouced."
//
// ONLY THE LAYOUT MOVED. How it prints is the same — the same @page, one ticket to a page, page 1
// the route summary and the first ticket — and so is what it prints: App.jsx hands this file the
// display strings it builds from the same ticketData() the old layout reads, and nothing in here
// reads a stop. The old layout is still in App.jsx; lib/print-layout.js says which one prints.
//
// WHAT THE CSS KEEPS, and a change here has to keep too:
//   THE STAPLE CORNER. Nothing prints inside the triangle 2in along the top edge and 2in down the
//     right edge. The rows above the city row stop 1.05in short of the right edge (1.2in on the
//     cover), and the stop block has a fixed minimum height, so the city · BOL · phone row — the
//     one row that does reach the right edge — can never sit higher than it does.
//   NEVER TALLER THAN THE OLD LAYOUT, so a ticket that fitted its page still does.
//   NO FILLS. A browser's default print drops backgrounds, so nothing here depends on one.
//   EVERY LINE HEIGHT IS SPELLED OUT. The print bridge sits inside the app's page and inherits its
//     CSS; with explicit line heights the preview frame and the printed page lay out the same.
//   THE HOOKS THE GUARDS READ: section.tkt, .seq, .pro, .ship-name, .cmt-t + .cmt-m, .next
//     ("Next Stop: …"), .mf-route, and the cover's <div class="k">…</div><div>…</div> pairs.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The first size whose limit holds the text: [[maxChars, px], …], smallest size last. */
const sizeFor = (len, steps) => {
  for (const [max, size] of steps) if (len <= max) return size;
  return steps[steps.length - 1][1];
};
// A consignee name is the line a driver reads from across the cab: as large as its length allows.
export const NAME_SIZES = [[24, 24], [30, 21], [44, 18], [52, 16], [Infinity, 14]];
// The PRO: 9 digits at 28px; a carrier's longer number steps down rather than running into the
// title on its left. NuVizz caps a stop number at 20 characters (STOP_NBR_MAX, nuvizz-write-ops.mts),
// and 20 at the smallest size still clears the title — scripts/verify-print-layout.mjs measures it.
export const PRO_SIZES = [[12, 28], [16, 22], [Infinity, 18]];

// "SPL-INSTR-TEXT:" is Uline's label on every instruction, not part of the instruction — the same
// label the stop card already leaves off (StopNotesList, lib/stop-notes-freshness.js).
const ULINE_LABEL = /^\s*SPL-INSTR-TEXT\s*:?\s*/i;
/** PURE: a note as the new layout prints it. A note that is ONLY the label prints as it is. */
export function printedNoteText(text) {
  const raw = String(text ?? '');
  return raw.replace(ULINE_LABEL, '').trim() || raw;
}

/**
 * The new layout prints the wide wordmark the delivery label uses (public/davis-logo-label.png),
 * which sits beside the old layout's logo. Every caller passes the old one, so the swap is here
 * and no call site had to change; any other URL is used as given.
 */
export function newLayoutLogoUrl(logoUrl) {
  return String(logoUrl ?? '').replace(/davis-logo\.jpg$/, 'davis-logo-label.png');
}

/** The ticket's CSS: the single Delivery Ticket uses it alone, the manifest adds NEW_MANIFEST_STYLE. */
export const NEW_TICKET_STYLE = `
  @page { size: letter portrait; margin: 0.4in; }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; }
  body { font-family: Arial, Helvetica, sans-serif; color:#000; font-size:12px; line-height:1.2; padding:8px; }
  .cap { font-size:10px; line-height:12px; font-weight:bold; color:#5f5f5f; text-transform:uppercase; letter-spacing:0.07em; }
  .brand { display:grid; grid-template-columns:84px minmax(0,1fr); align-items:center; min-height:30px; margin-bottom:3px; }
  .brand .id { grid-column:1 / -1; grid-row:1; display:flex; align-items:center; gap:10px; min-width:0; }
  .brand img { display:block; height:28px; width:auto; max-width:none; }
  .brand .t { font-size:12.5px; line-height:14px; font-weight:bold; color:#1a549e; text-transform:uppercase; letter-spacing:0.14em; }
  .brand .pro-w { grid-column:2; grid-row:1; justify-self:center; display:flex; align-items:baseline; gap:6px; white-space:nowrap; line-height:30px; font-weight:bold; }
  .brand .pro { letter-spacing:0.03em; }
  .head { display:flex; gap:12px; }
  /* stop number + Drop Off / Pick Up: a quiet box — the count row is the loud one. It sits a
     little below the header ("drop that box … a tiny bit to give the logo a little space"), and
     that drop is small enough that the box still ends above the bottom of the stop block. */
  .badge { flex:none; align-self:flex-start; width:60px; margin-top:6px; border:2px solid #000; text-align:center; }
  .seq { display:block; height:42px; line-height:42px; font-size:30px; font-weight:bold; letter-spacing:-0.02em; }
  .seq:empty { display:none; }
  .type { display:block; border-top:1px solid #000; height:16px; line-height:15px; font-size:9px; font-weight:bold; text-transform:uppercase; letter-spacing:0.04em; white-space:nowrap; }
  .seq:empty + .type { border-top:0; }
  .ship { flex:1; min-width:0; display:flex; flex-direction:column; font-size:15px; line-height:18px; overflow-wrap:anywhere; }
  /* THE STAPLE CORNER. The lines above the city row stop 1.05in short of the right edge, and
     together they are never shorter than 59px — the caption, a name row that keeps its height at
     every type size, and one address line or the space of one — so the row under them, the only
     one that reaches the right edge, never sits higher than that. */
  .ship .h, .ship .addr { display:block; margin-right:1.05in; }
  .ship .ship-name { display:flex; align-items:center; min-height:29px; margin-right:1.05in; font-weight:bold; line-height:1.08; padding:1px 0 2px; }
  .ship .addr span { display:inline-block; max-width:100%; }
  /* city (left) · BOL (middle) · phone (right): one row, the last of the stop block.
     None of the three is nowrap: a phone field that holds an extension and a name, or a long BOL,
     WRAPS inside its own column and the row grows downward. Nowrap printed one over the other.
     The city and the phone each keep at least 22% of the row, so a BOL of any length wraps in the
     middle instead of squeezing them to a letter a line. (An ordinary BOL never reaches that
     floor, and the row is laid out exactly as it is without it.) */
  .ship .city { display:grid; grid-template-columns:minmax(22%,1fr) auto minmax(22%,1fr); align-items:baseline; column-gap:14px; font-weight:bold; }
  /* A STOP WITH NO STREET ADDRESS: the row keeps the place an address line would have given it.
     Without this it sat right under the name — 0.17in closer to the staple corner, measured on a
     stop whose phone wrapped to a second line. */
  .ship .ship-name + .city { margin-top:18px; }
  .ship .bol { text-align:center; }
  .ship .call { justify-self:end; text-align:right; }
  .ship .lbl { font-size:10px; color:#5f5f5f; text-transform:uppercase; letter-spacing:0.07em; margin-right:5px; }
  /* pallets / loose / total pieces / weight: the row a driver counts freight against */
  .summary { display:flex; margin-top:13px; border:3px solid #000; }
  .summary > div { flex:1 1 0; min-width:0; display:flex; align-items:baseline; justify-content:center; gap:6px; padding:4px 6px; border-left:2px solid #000; white-space:nowrap; }
  .summary > div:first-child { border-left:0; }
  .summary b { font-size:28px; line-height:30px; }
  .summary span { font-size:11px; line-height:14px; font-weight:bold; text-transform:uppercase; letter-spacing:0.07em; }
  .cmts-h { display:block; margin-top:5px; }
  .cmts { display:grid; grid-template-columns:1fr 1fr; column-gap:18px; row-gap:4px; margin-top:2px; }
  .cmt { border-left:3px solid #000; padding:0 0 0 7px; min-width:0; overflow-wrap:anywhere; }
  .cmt-t { font-size:13px; line-height:15px; font-weight:bold; }
  .cmt-m { font-size:9.5px; line-height:11px; color:#5f5f5f; }
  .cmt-m span + span:not(:empty)::before { content:"\\00a0\\00b7\\00a0"; }
  table { border-collapse:collapse; width:100%; table-layout:fixed; }
  .items { margin-top:6px; }
  .items th { height:18px; padding:0 6px; text-align:left; vertical-align:middle; border-top:2px solid #000; border-bottom:1px solid #000; font-size:10px; line-height:12px; font-weight:bold; color:#5f5f5f; text-transform:uppercase; letter-spacing:0.07em; }
  .items td { height:22px; padding:2px 6px; vertical-align:middle; border-bottom:1px solid #a8a8a8; font-size:13px; line-height:15px; word-break:break-word; }
  .items td:first-child { font-weight:bold; }
  .items td.c, .items th.c { text-align:center; }
  .items td.r, .items th.r { text-align:right; }
  .sign { display:flex; margin-top:6px; border:2px solid #000; height:66px; }
  .sign .col { display:flex; flex-direction:column; padding:3px 9px 0; border-left:1px solid #000; min-width:0; }
  .sign .col:first-child { border-left:0; flex:0 0 33%; padding:0; }
  .sign .col.wide { flex:1 1 0; }
  .sign .f { display:block; flex:1 1 0; padding:3px 9px 0; }
  .sign .f + .f { border-top:1px solid #000; }
  .foot { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:baseline; column-gap:14px; margin-top:4px; font-size:11px; line-height:14px; }
  .foot .req .lbl { font-size:9.5px; font-weight:bold; color:#5f5f5f; text-transform:uppercase; letter-spacing:0.07em; margin-right:5px; }
  .next { margin-left:auto; text-align:right; font-weight:bold; text-transform:uppercase; letter-spacing:0.05em; }`;

/** What the manifest adds: the page-1 cover, and one ticket to a page. */
export const NEW_MANIFEST_STYLE = `
  /* Page 1 = summary header + the first ticket; every ticket after starts a new page,
     and no single ticket is ever split across a page boundary. */
  .tkt { padding:8px; break-inside: avoid; page-break-inside: avoid; }
  .tkt + .tkt { break-before: page; page-break-before: always; }
  /* Page 1 already carries the logo in the cover, so its ticket keeps only the title. */
  .tkt .brand img { display:none; }
  .tkt + .tkt .brand img { display:block; }
  .mf-top { display:flex; align-items:center; gap:16px; margin:0 8px; margin-right:1.2in; }
  .mf-top img { display:block; height:54px; width:auto; max-width:none; }
  .mf-title { font-size:12.5px; font-weight:bold; color:#1a549e; text-transform:uppercase; letter-spacing:0.14em; line-height:14px; }
  .mf-route { font-size:38px; font-weight:bold; color:#1a549e; line-height:38px; letter-spacing:-0.01em; overflow-wrap:anywhere; }
  .mf-grid { display:flex; flex-wrap:wrap; align-items:flex-start; column-gap:28px; row-gap:3px; margin:7px 8px 0; margin-right:1.2in; }
  /* a name with nowhere to break is cut inside its own box, never pushed out toward the corner */
  .mf-grid > div { min-width:0; overflow-wrap:anywhere; }
  .mf-grid .k { font-size:10px; line-height:12px; font-weight:bold; color:#5f5f5f; text-transform:uppercase; letter-spacing:0.07em; }
  .mf-grid .k + div { font-size:16px; line-height:20px; font-weight:bold; }
  .mf-grid .minor .k + div { font-size:12px; line-height:20px; }
  .mf-grid .nw { white-space:nowrap; }
  .mf-head { margin:13px 8px 12px; }
  .mf-head .summary { margin-top:0; }
  .mf-origin { display:flex; align-items:baseline; gap:8px; margin-top:3px; font-size:12px; line-height:15px; }
  /* a long origin wraps in its own box; the caption beside it is never the thing that gives way */
  .mf-origin .k { flex:none; font-size:10px; line-height:12px; font-weight:bold; color:#5f5f5f; text-transform:uppercase; letter-spacing:0.07em; }
  .mf-origin .k + div { min-width:0; overflow-wrap:anywhere; }`;

const MIN_ROWS = 6;   // the freight table never prints shorter than this: room to write a line in

/**
 * PURE: the inner markup of one Delivery Ticket.
 *
 * `t` is the ticket as display strings (ticketView, App.jsx):
 *   seq, type, pro, bol, shipName, addrLines[], cityLine, phone, reqLine, nextStop,
 *   pallets, loose, totalPieces, weight, items[{ po, ident, qty, wt }],
 *   comments[{ text, fromScan, by, at }]
 * `nextStop` is '' when the foot line is left off (no ETA, or a re-ordered card's page).
 */
export function newTicketBody(t, logoUrl, brandTitle = 'Delivery Ticket') {
  const nameSize = sizeFor(String(t.shipName ?? '').length, NAME_SIZES);
  const proSize = sizeFor(String(t.pro ?? '').length, PRO_SIZES);
  const addr = (t.addrLines || []).filter(Boolean);
  const items = t.items || [];
  const itemRows = items.map((it) => `
      <tr>
        <td>${esc(it.po)}</td>
        <td>${esc(it.ident)}</td>
        <td class="c">${esc(it.qty)}</td>
        <td class="c">-/-</td>
        <td class="r">${it.wt == null || it.wt === '' ? '' : Number(it.wt).toLocaleString() + ' Lbs'}</td>
        <td></td>
      </tr>`).join('');
  const itemFiller = Array.from({ length: Math.max(0, MIN_ROWS - items.length) }, () =>
    '<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('');
  const commentCells = (t.comments || []).map((c) => `
      <div class="cmt">
        <div class="cmt-t">${esc(printedNoteText(c.text))}</div>
        <div class="cmt-m">${c.fromScan ? '<span>From NuVizz’s latest scan</span><span></span>' : `<span>~By ${esc(c.by || '')}</span><span>${esc(c.at)}</span>`}</div>
      </div>`).join('');
  const next = t.nextStop ? `<div class="next">Next Stop: ${esc(t.nextStop)}</div>` : '';
  return `
  <div class="brand"><div class="id"><img src="${esc(logoUrl)}" alt="Davis Delivery Service"/><div class="t">${esc(brandTitle)}</div></div><div class="pro-w" style="font-size:${proSize}px"><span class="cap">PRO</span><span class="pro">${esc(t.pro)}</span></div></div>
  <div class="head">
    <div class="badge"><span class="seq">${esc(t.seq)}</span><span class="type">${esc(t.type)}</span></div>
    <div class="ship">
      <span class="cap h">Ship To</span>
      <span class="ship-name" style="font-size:${nameSize}px">${esc(t.shipName)}</span>
      ${addr.length ? `<div class="addr">${addr.map((a, i) => `<span>${esc(a)}${i < addr.length - 1 ? ',' : ''}</span>`).join(' ')}</div>` : ''}
      <div class="city"><span>${esc(t.cityLine)}</span><span class="bol"><span class="lbl">BOL</span>${esc(t.bol)}</span><span class="call"><span class="lbl">Call</span>${esc(t.phone)}</span></div>
    </div>
  </div>
  <div class="summary">
    <div><b>${esc(t.pallets)}</b><span>Pallets</span></div>
    <div><b>${esc(t.loose)}</b><span>Loose</span></div>
    <div><b>${esc(t.totalPieces)}</b><span>Total Pieces</span></div>
    <div><b>${Number(t.weight).toLocaleString()}</b><span>Lbs</span></div>
  </div>
  <div class="cmts-h cap">Comments</div>
  <div class="cmts">${commentCells}</div>
  <table class="items"><thead>
    <tr><th style="width:19%">PO</th><th style="width:23%">PO Identifier</th><th class="c" style="width:11%">Quantity</th><th class="c" style="width:25%">Exceptions/Comments</th><th class="r" style="width:13%">Weight</th><th style="width:9%">Volume</th></tr>
  </thead><tbody>${itemRows}${itemFiller}</tbody></table>
  <div class="sign">
    <div class="col"><span class="f"><span class="cap">Signed By</span></span><span class="f"><span class="cap">Actual Time</span></span></div>
    <div class="col wide"><span class="cap">Signature</span></div>
    <div class="col wide"><span class="cap">Driver Comment</span></div>
  </div>
  <div class="foot"><div class="req"><span class="lbl">Requested Date &amp; Time</span>${esc(t.reqLine)}</div>${next}</div>`;
}

/** PURE: a single Delivery Ticket as a whole document. */
export function newTicketHtml(t, logoUrl) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Delivery Ticket ${esc(t.pro)}</title>
<style>${NEW_TICKET_STYLE}</style></head>
<body>${newTicketBody(t, logoUrl)}</body></html>`;
}

/**
 * PURE: the Driver Manifest as a whole document.
 *
 * `cover` is what buildManifestHtml (App.jsx) worked out for BOTH layouts — one rule, two layouts:
 *   routeName, driver, origin, windowStr, stopCount, tot { pallets, loose, pieces, weight }
 * `tickets` are the pages' ticket bodies (newTicketBody), already in page order.
 */
export function newManifestHtml(cover, tickets, logoUrl) {
  // Each end of the requested window stays whole when the row has to wrap.
  const windowHtml = String(cover.windowStr || '').split(' – ')
    .map((p, i, a) => `<span class="nw">${esc(p)}${i < a.length - 1 ? ' –' : ''}</span>`).join(' ');
  const pages = (tickets || []).map((body) => `<section class="tkt">${body}</section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Driver Manifest ${esc(cover.routeName)}</title>
<style>${NEW_TICKET_STYLE}${NEW_MANIFEST_STYLE}
</style></head>
<body>
  <div class="mf-top"><img src="${esc(logoUrl)}" alt="Davis Delivery Service"/><div><div class="mf-title">Driver Manifest</div><div class="mf-route">${esc(cover.routeName)}</div></div></div>
  <div class="mf-grid">
    <div><div class="k">Driver</div><div>${esc(cover.driver)}</div></div>
    <div><div class="k">Stops</div><div>${cover.stopCount} Stop${cover.stopCount === 1 ? '' : 's'}</div></div>
    ${cover.windowStr ? `<div class="minor"><div class="k">Requested</div><div>${windowHtml}</div></div>` : ''}
  </div>
  <div class="mf-head">
    <div class="summary">
      <div><b>${esc(cover.tot.pallets)}</b><span>Pallets</span></div>
      <div><b>${esc(cover.tot.loose)}</b><span>Loose</span></div>
      <div><b>${esc(cover.tot.pieces)}</b><span>Total Pieces</span></div>
      <div><b>${Math.round(cover.tot.weight).toLocaleString()}</b><span>Lbs</span></div>
    </div>
    ${cover.origin ? `<div class="mf-origin"><div class="k">Origin</div><div>${esc(cover.origin)}</div></div>` : ''}
  </div>
  ${pages}
</body></html>`;
}
