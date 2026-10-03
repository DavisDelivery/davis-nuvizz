// test/ticket-print-new.test.mjs — THE NEW LAYOUT OF THE PRINTED MANIFEST AND DELIVERY TICKET.
//
// Chad, 2026-10-02, setting the job: "Only changing design and formatting here not how it prints
// not putting more than one delivery on one page. all that stays the same. All the information is
// kept the same. Imagine that the paper is stapled in right hand corner."
//
// So the rules here are the ones he set, each checked against the REAL builders lifted out of
// App.jsx: nothing the old layout prints is missing from the new one; the page rules (one ticket
// to a page, page 1 = the summary and the first ticket) are the old layout's own; the rows above
// the city row stop short of the staple corner; and the old layout is still there, untouched,
// for Diagnostics → Manifest layout to go back to. What prints in WHICH ORDER, and WHICH notes,
// are pinned on both layouts in card-manifest.test.mjs and manifest-notes.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';
import {
  NEW_TICKET_STYLE, NEW_MANIFEST_STYLE, NAME_SIZES, PRO_SIZES,
  printedNoteText, newLayoutLogoUrl, newTicketBody, newTicketHtml, newManifestHtml,
} from '../src/lib/ticket-print-new.js';
import { rememberPrintLayout, _resetPrintLayoutForTests } from '../src/lib/print-layout.js';
import { PRINT_LAYOUT_SAMPLE_STOPS } from '../src/lib/print-layout-sample.js';
import { scanNoteEntries } from '../src/lib/stop-notes-freshness.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const LOGO = 'https://example.test/davis-logo.jpg';

// ── a route as the board holds it, with the awkward stops on it ───────────────
const NOTE = (text, addedBy = 'INTG ULINE') => ({ text, type: 'ORD_IN', addedBy, addedOn: '2026-10-02T20:50:22' });
const FROM = { name: 'ULINE', addr1: '2950 JONES MILL RD', city: 'BRASELTON', state: 'GA', zip: '30517' };
const base = (n, over = {}) => ({
  stopNbr: `00719${String(n).padStart(4, '0')}`, bol: `14822${String(n).padStart(4, '0')}`, stopType: 'DL', routeSeq: n,
  routeName: 'MARCUS', driverName: 'TEST DRIVER', businessName: `CUSTOMER ${n}`, addr1: `${100 + n} MAIN ST`,
  city: 'BUFORD', state: 'GA', zip: '30518', contact: { phone: `77055501${String(40 + n)}` },
  scheduledFrom: '2026-10-05T08:00:00', scheduledTo: '2026-10-05T17:00:00', plannedEtaDTTM: `2026-10-05T${String(7 + n).padStart(2, '0')}:10:00`,
  weight: 1240 + n, volume: n, cartons: 2, pallets: 2 + n,
  stopDetails: [{ product: `S-${4000 + n}`, productIdentifier: `IDENT-${n}-1`, quantity: n, weight: 640 }],
  allComments: [NOTE('SPL-INSTR-TEXT: NO APPT REQUIRED'), NOTE('TOTAL-AMOUNT : 59.29')],
  raw: { stop: { from: { address: FROM } } },
  ...over,
});
const ROUTE = [
  base(1),
  // a long name, a second address line, six notes, a dispatcher's note among Uline's
  base(2, { businessName: 'NORTH GEORGIA MECHANICAL CONTRACTORS & SUPPLY', addr2: 'WAREHOUSE B - DOCK 4 AT REAR',
    allComments: ['RESIDENTIAL DELIVERY', 'STRAIGHT TRUCK ONLY', 'LIFT GATE NEEDED', 'CALL 30 MIN AHEAD'].map((t) => NOTE(`SPL-INSTR-TEXT: ${t}`)).concat([NOTE('TOTAL-AMOUNT : 91.48'), NOTE('CUSTOMER NOT HOME BEFORE 10 - CALL CELL', 'BRANDI')]) }),
  // a pick-up, a carrier's long number, no BOL, no notes, an extension on the phone
  base(3, { stopNbr: 'AVRT-0170416957', bol: '', stopType: 'PU', allComments: [], contact: { phone: '770-555-0163 x 2231' } }),
  // nothing optional at all: no phone, no window, no ETA, no items, no second line
  base(4, { contact: {}, scheduledFrom: '', scheduledTo: '', plannedEtaDTTM: '', stopDetails: [] }),
  // the scan's own note (no stored notes), characters that must be escaped, twelve freight lines
  base(5, { businessName: 'A&B <FREIGHT> CO', allComments: [], orderInstructions: 'CANCELLED ORDER. STOP & RETURN PER ULINE.',
    stopDetails: Array.from({ length: 12 }, (_, k) => ({ product: `H-${1000 + k}`, productIdentifier: `IDENT-5-${k + 1}`, quantity: 1 + k, weight: 100 + k })) }),
];

// ── the REAL builders, lifted out of App.jsx, each told which layout to print ──
const libs = await libExports(['route-identity.js', 'card-manifest.js', 'stop-notes-freshness.js', 'print-layout.js', 'ticket-print-new.js']);
const L = liftFromApp({
  targets: ['buildManifestHtml', 'buildTicketHtml', 'ticketBody', 'ticketView', 'ticketData', 'TICKET_STYLE'],
  inject: { ...libs },
  exercise: (l) => {
    for (const layout of ['new', 'classic']) {
      l.buildManifestHtml(ROUTE, LOGO, 'MARCUS', { layout });
      l.buildManifestHtml(ROUTE, LOGO, null, { asGiven: true, labels: ROUTE.map((_, i) => i + 1), layout });
      l.buildTicketHtml(ROUTE[1], LOGO, { layout });
      l.ticketBody(ROUTE[1], LOGO, 'Delivery Ticket', { layout });
    }
  },
});
const manifest = (layout, stops = ROUTE) => L.buildManifestHtml(stops, LOGO, null, { layout });
const pagesOf = (html) => html.split('<section class="tkt">').slice(1);
const coverOf = (html) => html.slice(html.indexOf('<body>'), html.indexOf('<section class="tkt">'));
const styleOf = (html) => /<style>([\s\S]*?)<\/style>/.exec(html)[1];

/** The words a page prints, as a bag: tags and CSS gone, case and edge punctuation folded. */
function words(html) {
  const text = html.replace(/<style>[\s\S]*?<\/style>/g, ' ').replace(/<title>[\s\S]*?<\/title>/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const raw = text.split(/\s+/).map((w) => w.replace(/^[(~]+|[:,)]+$/g, '').toLowerCase())
    .filter((w) => w && !/^_+$/.test(w) && !['·', '–', '-'].includes(w));
  // A phone number is the same number in either display form: (770) 555-0142 and 7705550142.
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (/^\d{3}$/.test(raw[i]) && /^\d{3}-\d{4}$/.test(raw[i + 1] || '')) { out.push(raw[i] + raw[i + 1].replace('-', '')); i++; } else out.push(raw[i]);
  }
  const bag = new Map();
  for (const w of out) bag.set(w, (bag.get(w) || 0) + 1);
  return bag;
}
/** Every word of `was` that `now` prints fewer times, as "word×missing". */
function missingFrom(now, was, { dropped = [] } = {}) {
  const out = [];
  for (const [w, n] of was) {
    if (dropped.includes(w)) continue;
    if ((now.get(w) || 0) < n) out.push(`${w}×${n - (now.get(w) || 0)}`);
  }
  return out;
}

// ── "ALL THE INFORMATION IS KEPT THE SAME" ───────────────────────────────────

test('NOTHING THE OLD LAYOUT PRINTS IS MISSING FROM THE NEW ONE — the cover and every ticket, word for word', () => {
  const was = manifest('classic'); const now = manifest('new');
  assert.deepEqual(missingFrom(words(coverOf(now)), words(coverOf(was))), [], 'the cover');
  const a = pagesOf(was); const b = pagesOf(now);
  assert.equal(b.length, a.length);
  // The one thing taken off on purpose is Uline's label in front of each instruction.
  a.forEach((page, i) => assert.deepEqual(missingFrom(words(b[i]), words(page), { dropped: ['spl-instr-text'] }), [], `ticket ${i + 1}`));
});

test('THE NEW LAYOUT ADDS NO FACTS — only the caption "PRO" over the number the old one printed bare', () => {
  const was = pagesOf(manifest('classic')); const now = pagesOf(manifest('new'));
  now.forEach((page, i) => assert.deepEqual(missingFrom(words(was[i]), words(page)), ['pro×1'], `ticket ${i + 1}`));
  assert.deepEqual(missingFrom(words(coverOf(manifest('classic'))), words(coverOf(manifest('new')))), []);
});

test('a single Delivery Ticket carries the same words in both layouts too', () => {
  for (const s of ROUTE) {
    const was = words(L.buildTicketHtml(s, LOGO, { layout: 'classic' })); const now = words(L.buildTicketHtml(s, LOGO, { layout: 'new' }));
    assert.deepEqual(missingFrom(now, was, { dropped: ['spl-instr-text'] }), [], s.stopNbr);
  }
});

test('the phone prints as the stop card shows it — (770) 555-0142 — and anything that is not a plain US number as stored', () => {
  assert.match(L.ticketBody(ROUTE[0], LOGO, 'Delivery Ticket', { layout: 'new' }), /<span class="lbl">Call<\/span>\(770\) 555-0141</);
  assert.match(L.ticketBody(ROUTE[2], LOGO, 'Delivery Ticket', { layout: 'new' }), /<span class="lbl">Call<\/span>770-555-0163 x 2231</);
  assert.match(L.ticketBody(ROUTE[3], LOGO, 'Delivery Ticket', { layout: 'new' }), /<span class="lbl">Call<\/span><\/span>/, 'no phone: the caption stays, as "Call:" does on the old layout');
});

// ── "NOT HOW IT PRINTS" ──────────────────────────────────────────────────────

test('HOW IT PRINTS IS UNCHANGED: the same sheet, the same margins, one ticket to a page, page 1 = the summary and the first ticket', () => {
  const was = styleOf(manifest('classic')); const now = styleOf(manifest('new'));
  const rule = (css, re) => (re.exec(css) || [''])[0].replace(/\s+/g, ' ');
  for (const re of [/@page \{[^}]*\}/, /\.tkt \{[^}]*break-inside[^}]*\}/, /\.tkt \+ \.tkt \{[^}]*break-before[^}]*\}/]) {
    assert.ok(rule(was, re), `the old layout has ${re}`);
  }
  assert.equal(rule(now, /@page \{[^}]*\}/), rule(was, /@page \{[^}]*\}/));
  // The two page-break rules are the old layout's own words.
  assert.match(now, /\.tkt \{ padding:8px; break-inside: avoid; page-break-inside: avoid; \}/);
  assert.match(now, /\.tkt \+ \.tkt \{ break-before: page; page-break-before: always; \}/);
  assert.match(was, /\.tkt \{ padding:8px; break-inside: avoid; page-break-inside: avoid; \}/);
  assert.match(was, /\.tkt \+ \.tkt \{ break-before: page; page-break-before: always; \}/);
  // One <section class="tkt"> per stop, and the first one follows the cover in the same document.
  for (const layout of ['new', 'classic']) assert.equal(pagesOf(manifest(layout)).length, ROUTE.length, layout);
  // The single ticket's document has the sheet rule and no page-break rule to trip over.
  assert.match(newTicketHtml(L.ticketView(ROUTE[0]), LOGO), /@page \{ size: letter portrait; margin: 0\.4in; \}/);
});

test('the print bridge can re-scope the new layout exactly as it does the old one', () => {
  // PrintDocModal prints from a <div> in the app's own page and rewrites the document's html/body
  // rules onto it with these two patterns. A style it cannot rewrite would restyle the whole app.
  const scoped = (NEW_TICKET_STYLE + NEW_MANIFEST_STYLE)
    .replace(/html\s*,\s*body\s*\{/g, '.printdoc-bridge {')
    .replace(/(^|\})(\s*)body\s*\{/g, '$1$2.printdoc-bridge {');
  assert.doesNotMatch(scoped, /(^|[\s,}])(html|body)\s*[{,]/, 'no bare html/body selector left');
  assert.equal((scoped.match(/\.printdoc-bridge \{/g) || []).length, 2);
  // And nothing in it depends on a background: a default print drops them.
  assert.doesNotMatch(NEW_TICKET_STYLE + NEW_MANIFEST_STYLE, /background/);
});

// ── "STAPLED IN RIGHT HAND CORNER" ───────────────────────────────────────────

test('THE STAPLE CORNER: every row above the city row stops short of the right edge, and the city row cannot rise', () => {
  // What keeps the top-right corner empty, as rules: the two caption rows and the address stop
  // 1.05in short; the cover's rows 1.2in short; and the rows above the one row that DOES reach
  // the right edge (city · BOL · phone) are never shorter than on an ordinary stop.
  // The measured proof — no text inside the 2in corner on a real page — is scripts/verify-print-layout.mjs.
  assert.match(NEW_TICKET_STYLE, /\.ship \.h, \.ship \.addr \{ display:block; margin-right:1\.05in; \}/);
  assert.match(NEW_TICKET_STYLE, /\.ship \.ship-name \{[^}]*margin-right:1\.05in;/);
  // The name row keeps its height at every type size (a long name is set smaller, and a shorter
  // line would let the row under it up).
  assert.match(NEW_TICKET_STYLE, /\.ship \.ship-name \{[^}]*min-height:29px;/);
  assert.match(NEW_TICKET_STYLE, /\.brand \{[^}]*min-height:30px;/);
  assert.match(NEW_MANIFEST_STYLE, /\.mf-top \{[^}]*margin-right:1\.2in; \}/);
  assert.match(NEW_MANIFEST_STYLE, /\.mf-grid \{[^}]*margin-right:1\.2in; \}/);
});

test('A STOP WITH NO STREET ADDRESS keeps the city row where an address line would have put it', () => {
  // Measured before the rule: with no address line the row sat right under the name, and on a
  // stop whose phone wrapped to a second line that was 0.17in closer to the staple corner
  // (1.85in, inside the 2in the layout keeps clear). The rule gives the row the height of the
  // line that is missing; it applies exactly when the row follows the name with nothing between.
  assert.match(NEW_TICKET_STYLE, /\.ship \.ship-name \+ \.city \{ margin-top:18px; \}/);
  assert.match(NEW_TICKET_STYLE, /\.ship \{[^}]*line-height:18px;/, 'the space is one address line: the stop block’s own line height');
  const body = (over) => L.ticketBody({ ...ROUTE[0], ...over }, LOGO, 'Delivery Ticket', { layout: 'new' });
  const bare = body({ addr1: '', addr2: '' });
  assert.doesNotMatch(bare, /class="addr"/, 'no address, no address line printed empty');
  assert.match(bare, /<span class="ship-name"[^>]*>CUSTOMER 1<\/span>\s*<div class="city">/, 'the city row follows the name directly, which is what the rule keys on');
  const withAddr = body({});
  assert.match(withAddr, /<\/span>\s*<div class="addr">.*<\/div>\s*<div class="city">/, 'with an address the row follows the address, and the rule does not apply');
  // Nothing else may hold the row up: no rule pins it to the bottom of a taller block.
  assert.doesNotMatch(NEW_TICKET_STYLE, /\.ship \.city \{[^}]*margin-top:/);
});

test('a long consignee name or a carrier’s long number steps DOWN in size instead of running toward the corner', () => {
  const size = (html, cls) => Number(new RegExp(`class="${cls}" style="font-size:(\\d+)px"`).exec(html)[1]);
  const body = (over) => L.ticketBody({ ...ROUTE[0], ...over }, LOGO, 'Delivery Ticket', { layout: 'new' });
  assert.equal(size(body({ stopNbr: '007190027' }), 'pro-w'), 28, 'a Uline PRO, nine digits');
  assert.equal(size(body({ stopNbr: 'AVRT-0170416957' }), 'pro-w'), 22);
  assert.equal(size(body({ stopNbr: 'ESTES-0538243875-12' }), 'pro-w'), 18);
  assert.equal(size(body({ businessName: 'D HOLLOWAY' }), 'ship-name'), 24);
  assert.equal(size(body({ businessName: 'NORTH GEORGIA MECHANICAL CONTRACTORS & SUPPLY' }), 'ship-name'), 16);
  assert.equal(size(body({ businessName: 'W'.repeat(70) }), 'ship-name'), 14);
  // Longer never means bigger.
  for (const steps of [NAME_SIZES, PRO_SIZES]) {
    for (let i = 1; i < steps.length; i++) { assert.ok(steps[i][0] > steps[i - 1][0]); assert.ok(steps[i][1] < steps[i - 1][1]); }
    assert.equal(steps[steps.length - 1][0], Infinity, 'no length falls off the end of the table');
  }
});

// ── WHAT THE ROUNDS ON PAPER SETTLED ─────────────────────────────────────────

test('"SPL-INSTR-TEXT: remove this repetitive text" — the label comes off, the instruction stays, and the stop card’s rule is the same rule', () => {
  assert.equal(printedNoteText('SPL-INSTR-TEXT: LIFT GATE NEEDED'), 'LIFT GATE NEEDED');
  assert.equal(printedNoteText('  spl-instr-text :  CALL 30 MIN AHEAD '), 'CALL 30 MIN AHEAD');
  assert.equal(printedNoteText('TOTAL-AMOUNT : 91.48'), 'TOTAL-AMOUNT : 91.48', 'only that one label');
  assert.equal(printedNoteText('READ THE SPL-INSTR-TEXT: FIRST'), 'READ THE SPL-INSTR-TEXT: FIRST', 'only at the front');
  // A note that is nothing BUT the label is printed as it is — a box with no words in it would
  // read as a note that failed to print.
  assert.equal(printedNoteText('SPL-INSTR-TEXT:'), 'SPL-INSTR-TEXT:');
  for (const v of [null, undefined, '']) assert.equal(printedNoteText(v), '');
  // The card strips the same label the same way (lib/stop-notes-freshness.js), spelling for spelling.
  for (const t of ['SPL-INSTR-TEXT: EMAIL FOR APPT', 'SPL-INSTR-TEXT EMAIL FOR APPT', 'spl-instr-text:EMAIL FOR APPT', ' SPL-INSTR-TEXT : EMAIL FOR APPT']) {
    assert.deepEqual([printedNoteText(t)], scanNoteEntries(t), t);
  }
  const page = pagesOf(manifest('new'))[1];
  assert.doesNotMatch(page, /SPL-INSTR-TEXT/);
  assert.match(pagesOf(manifest('classic'))[1], /SPL-INSTR-TEXT: LIFT GATE NEEDED/, 'the old layout still prints it, as it always did');
});

test('"bol number … same row as phone number with phone number on the right side … bol number in the middle"', () => {
  const body = L.ticketBody(ROUTE[1], LOGO, 'Delivery Ticket', { layout: 'new' });
  assert.match(body, /<div class="city"><span>BUFORD, GA 30518<\/span><span class="bol"><span class="lbl">BOL<\/span>148220002<\/span><span class="call"><span class="lbl">Call<\/span>\(770\) 555-0142<\/span><\/div>/);
  // Three columns: left, middle, right. The two outer ones are EQUAL (1fr each), which is what
  // puts the BOL in the middle of the row — and each keeps a floor, so a BOL of any length wraps
  // in the middle instead of squeezing the city and the phone to a letter a line (a 70-character
  // BOL left the city 4px wide before the floor; scripts/verify-print-layout.mjs prints one).
  const cols = /\.ship \.city \{[^}]*grid-template-columns:minmax\((\d+)%,1fr\) auto minmax\((\d+)%,1fr\);/.exec(NEW_TICKET_STYLE);
  assert.ok(cols, 'three columns: left, middle, right');
  assert.equal(cols[1], cols[2], 'the city and the phone get the same floor, so the BOL stays centred');
  assert.ok(Number(cols[1]) >= 20 && Number(cols[1]) <= 30, `a real share of the row, and room left for the BOL (${cols[1]}%)`);
  assert.match(NEW_TICKET_STYLE, /\.ship \.call \{[^}]*justify-self:end;/);
  // A PHONE FIELD THAT HOLDS "770-555-0142 x 2231 ask for receiving" MUST WRAP, NOT PRINT OVER THE
  // BOL. With nowrap on these cells it did exactly that (found printing the awkward load in
  // scripts/verify-print-layout.mjs, which measures it). None of the three may be nowrap.
  for (const cell of ['city', 'bol', 'call']) {
    const rule = new RegExp(`\\.ship \\.${cell} \\{([^}]*)\\}`).exec(NEW_TICKET_STYLE);
    assert.ok(rule, `.ship .${cell} has a rule`);
    assert.doesNotMatch(rule[1], /nowrap/, `.ship .${cell}`);
  }
});

test('A LONG ORIGIN WRAPS IN ITS OWN BOX — the word "Origin" beside it is never the thing that gives way', () => {
  // A shipper's name and a two-line address make an origin three lines long. Letting BOTH halves
  // of that row shrink printed the caption as "OR / IG / I / N" down four lines (measured: 14px
  // wide). So the caption does not shrink, and only the VALUE may break a long word.
  const k = /\.mf-origin \.k \{([^}]*)\}/.exec(NEW_MANIFEST_STYLE);
  assert.ok(k && /flex:none;/.test(k[1]), 'the caption keeps its width');
  assert.match(NEW_MANIFEST_STYLE, /\.mf-origin \.k \+ div \{ min-width:0; overflow-wrap:anywhere; \}/, 'the value wraps');
  assert.doesNotMatch(NEW_MANIFEST_STYLE, /\.mf-origin > div \{/, 'no rule that reaches the caption and the value alike');
  // The cover's own row (driver · stops · requested) wraps a cell to the next line before it
  // squeezes one, and a name with nowhere to break is cut inside its own cell.
  assert.match(NEW_MANIFEST_STYLE, /\.mf-grid \{[^}]*flex-wrap:wrap;/);
  assert.match(NEW_MANIFEST_STYLE, /\.mf-grid > div \{ min-width:0; overflow-wrap:anywhere; \}/);
});

test('the PRO is in the header, the count row is one heavy row with space above it, and the requested window is small at the foot', () => {
  const body = L.ticketBody(ROUTE[0], LOGO, 'Delivery Ticket', { layout: 'new' });
  const at = (s) => { const i = body.indexOf(s); assert.ok(i >= 0, s); return i; };
  // Top to bottom: header (with the PRO) → the stop → the counts → comments → freight → signature → foot.
  const order = ['class="brand"', 'class="pro"', 'class="head"', 'class="summary"', 'class="cmts"', 'class="items"', 'class="sign"', 'class="foot"'].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(body, /<div><b>2<\/b><span>Pallets<\/span><\/div>\s*<div><b>1<\/b><span>Loose<\/span><\/div>\s*<div><b>3<\/b><span>Total Pieces<\/span><\/div>\s*<div><b>1,241<\/b><span>Lbs<\/span><\/div>/);
  assert.match(NEW_TICKET_STYLE, /\.summary \{ display:flex; margin-top:13px; border:3px solid #000; \}/);
  assert.match(body, /<div class="foot"><div class="req"><span class="lbl">Requested Date &amp; Time<\/span>5 Oct 2026 08:00 AM - 05:00 PM \+0D<\/div><div class="next">Next Stop: 10\/05\/2026 08:10:00 AM<\/div><\/div>/);
});

test('the stop box is the quiet one: lighter than the count row, and a stop with no number prints no empty box', () => {
  const border = (css, sel) => Number(new RegExp(`\\.${sel} \\{[^}]*border:(\\d+)px solid #000`).exec(css)[1]);
  assert.ok(border(NEW_TICKET_STYLE, 'badge') < border(NEW_TICKET_STYLE, 'summary'));
  assert.match(NEW_TICKET_STYLE, /\.seq:empty \{ display:none; \}/);
  const body = L.ticketBody({ ...ROUTE[0], routeSeq: null }, LOGO, 'Delivery Ticket', { layout: 'new' });
  assert.match(body, /<div class="badge"><span class="seq"><\/span><span class="type">Drop Off<\/span><\/div>/);
  assert.match(L.ticketBody(ROUTE[2], LOGO, 'Delivery Ticket', { layout: 'new' }), /<span class="type">Pick Up<\/span>/);
});

test('"drop that box … a tiny bit to give the logo a little space" — and the drop never costs a ticket any height', () => {
  // The box hangs from the top of the stop block, right under the logo. It is dropped a few
  // pixels, and it must still END above the bottom of the shortest stop block there is — the
  // caption, a one-line name, one address line (or the space of one) and the city row — or
  // every ticket would grow by the difference and a sheet would hold fewer freight lines.
  const px = (re, css = NEW_TICKET_STYLE) => Number(re.exec(css)[1]);
  const drop = px(/\.badge \{[^}]*margin-top:(\d+)px;/);
  assert.ok(drop >= 4 && drop <= 10, `a little space, not a rearrangement (${drop}px)`);
  assert.match(NEW_TICKET_STYLE, /\.badge \{[^}]*align-self:flex-start;/, 'it hangs from the top: a taller stop block does not carry it further down');
  const box = px(/\.seq \{[^}]*height:(\d+)px;/) + px(/\.type \{[^}]*height:(\d+)px;/) + 2 * px(/\.badge \{[^}]*border:(\d+)px solid/);
  const line = px(/\.ship \{[^}]*line-height:(\d+)px;/);
  const block = px(/\.cap \{[^}]*line-height:(\d+)px;/) + px(/\.ship \.ship-name \{[^}]*min-height:(\d+)px;/) + line + line;
  assert.ok(drop + box <= block, `the dropped box (${drop} + ${box}px) ends inside the shortest stop block (${block}px)`);
});

// ── THE PAGE ITSELF ──────────────────────────────────────────────────────────

test('everything printed is escaped — a customer named A&B <FREIGHT> CO cannot break the page', () => {
  const page = pagesOf(manifest('new'))[4];
  assert.match(page, />A&amp;B &lt;FREIGHT&gt; CO</);
  assert.doesNotMatch(page, /<FREIGHT>/);
  assert.match(page, /CANCELLED ORDER\. STOP &amp; RETURN PER ULINE\./);
  assert.match(page, /From NuVizz’s latest scan/, 'and the scan’s note says where it came from, as on the old layout');
});

test('the freight table never prints shorter than six rows, and never drops a line past six', () => {
  const rows = (page) => (/<tbody>([\s\S]*?)<\/tbody>/.exec(page)[1].match(/<tr>/g) || []).length;
  const now = pagesOf(manifest('new')); const was = pagesOf(manifest('classic'));
  assert.deepEqual(now.map(rows), [6, 6, 6, 6, 12]);
  assert.deepEqual(now.map(rows), was.map(rows), 'the same count as the old layout, stop for stop');
});

test('the hooks the guards and the other tests read are on the new layout', () => {
  const html = manifest('new');
  for (const page of pagesOf(html)) {
    for (const re of [/<span class="seq">[^<]*<\/span>/, /<span class="pro">[^<]+<\/span>/, /<span class="ship-name"[^>]*>[^<]+<\/span>/]) assert.match(page, re);
  }
  assert.match(pagesOf(html)[0], /<div class="cmt-t">[^<]*<\/div>\s*<div class="cmt-m">/);
  assert.match(pagesOf(html)[0], /<div class="next">Next Stop: [^<]+<\/div>/);
  assert.match(coverOf(html), /<div class="mf-route">MARCUS<\/div>/);
  assert.match(coverOf(html), /<div class="k">Driver<\/div><div>TEST DRIVER<\/div>/);
  assert.match(coverOf(html), /<div class="k">Stops<\/div><div>5 Stops<\/div>/);
  assert.match(coverOf(html), /<div class="k">Origin<\/div><div>ULINE, 2950 JONES MILL RD, BRASELTON, GA 30517<\/div>/);
});

test('the new layout prints the label’s wide logo, found beside the old layout’s; any other address is used as given', () => {
  assert.equal(newLayoutLogoUrl('https://dispatch.example/davis-logo.jpg'), 'https://dispatch.example/davis-logo-label.png');
  assert.equal(newLayoutLogoUrl('/davis-logo.jpg'), '/davis-logo-label.png');
  assert.equal(newLayoutLogoUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(newLayoutLogoUrl(undefined), '');
  for (const f of ['davis-logo.jpg', 'davis-logo-label.png']) assert.ok(existsSync(new URL(`../public/${f}`, import.meta.url)), f);
  assert.match(manifest('new'), /<img src="https:\/\/example\.test\/davis-logo-label\.png"/);
  assert.match(manifest('classic'), /<img src="https:\/\/example\.test\/davis-logo\.jpg"/);
  assert.doesNotMatch(manifest('classic'), /davis-logo-label/);
});

// ── THE OLD LAYOUT IS STILL THERE ────────────────────────────────────────────

test('THE OLD LAYOUT IS UNTOUCHED: its own markup, its own CSS, none of the new layout’s', () => {
  const html = manifest('classic');
  assert.equal(styleOf(html).startsWith(L.TICKET_STYLE), true);
  assert.doesNotMatch(html, /class="badge"|class="pro-w"|class="foot"|mf-top|mf-origin/);
  const page = pagesOf(html)[1];
  // The stop block, exactly as it has always printed.
  assert.ok(page.includes(`
  <div class="head">
    <div class="l">
      <div class="row1">
        <span class="seq">2</span>
        <span class="type">Drop Off</span>
        <span class="pro">007190002</span>
      </div>
      <div class="meta"><span class="lbl">BOL:</span> 148220002</div>
      <div class="meta"><span class="lbl">Requested Date &amp; Time:</span><br/>5 Oct 2026 08:00 AM - 05:00 PM +0D</div>
    </div>
    <div class="ship">
      <div class="h">Ship To:</div>
      <span class="ship-name">NORTH GEORGIA MECHANICAL CONTRACTORS &amp; SUPPLY</span><br/>
      102 MAIN ST,<br/>WAREHOUSE B - DOCK 4 AT REAR,<br/>BUFORD, GA 30518<br/>
      <span class="lbl">Call:</span> 7705550142
    </div>
  </div>`), 'the old stop block changed');
  assert.match(page, /<div class="sigbox"><\/div>/);
});

test('THE OLD LAYOUT IS FROZEN: its CSS and a whole two-stop manifest still print what they printed before there were two layouts', () => {
  // The old layout is what "Go back to the old layout" promises: the paper as it was. These two
  // fingerprints were taken from the commit BEFORE the new layout shipped (v1.109.0) and matched
  // this one byte for byte, as did 25,543 other documents compared that day. A change to the old
  // layout's look fails here — which is the point: mend the new layout instead, or change this on
  // purpose and say why. (A narrow no-break space some runtimes put before AM/PM is read as a space.)
  const print = (s) => createHash('sha256').update(String(s).replace(/\u202f/g, ' ')).digest('hex').slice(0, 16);
  const frozen = [base(1), base(2, { businessName: 'NORTH GEORGIA MECHANICAL CONTRACTORS & SUPPLY', addr2: 'WAREHOUSE B - DOCK 4 AT REAR' })];
  const html = L.buildManifestHtml(frozen, LOGO, null, { layout: 'classic' });
  assert.equal(print(styleOf(html)), 'e66e8b1c377f3633', 'the old layout’s CSS changed');
  assert.equal(print(html), '41f2d7f7f58cfd16', 'the old layout’s manifest changed');
});

test('in App.jsx the old layout’s code sits under ONE line that hands the new layout its ticket, and is otherwise as it was', () => {
  const body = APP.slice(APP.indexOf('\nfunction ticketBody('), APP.indexOf('\nfunction buildTicketHtml('));
  const first = body.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).slice(1, 3);
  assert.match(first[0], /^\s*if \(\(layout \|\| printLayoutNow\(\)\) !== 'classic'\) return newTicketBody\(ticketView\(stop, \{ seqLabel, hideEta \}\), newLayoutLogoUrl\(logoUrl\), brandTitle\);$/);
  assert.match(first[1], /^\s*const d = ticketData\(stop\);$/);
  // The manifest works everything out once and only then asks which layout draws it.
  const mf = APP.slice(APP.indexOf('\nfunction buildManifestHtml('), APP.indexOf('\n// "2026-06-23T15:35:26"'));
  assert.ok(mf.indexOf('const seqAt =') < mf.indexOf('if (!classic) {'), 'the page order and numbers are settled before the layouts part');
  assert.match(mf, /return newManifestHtml\(\{ routeName, driver, origin, windowStr, stopCount: ordered\.length, tot \}, bodies, newLayoutLogoUrl\(logoUrl\)\);/);
});

// ── WHICH ONE PRINTS ─────────────────────────────────────────────────────────

test('WITH NO LAYOUT NAMED, the builders print what the device last heard from the server — new by default, old once switched back', () => {
  _resetPrintLayoutForTests();
  try {
    assert.match(L.buildManifestHtml(ROUTE, LOGO), /class="badge"/, 'nobody has chosen: the new layout');
    assert.match(L.buildTicketHtml(ROUTE[0], LOGO), /class="badge"/);
    rememberPrintLayout('classic', null);   // the server answered "old"
    assert.equal(L.buildManifestHtml(ROUTE, LOGO), manifest('classic'), 'every device goes back to the old layout, byte for byte');
    assert.equal(L.buildTicketHtml(ROUTE[0], LOGO), L.buildTicketHtml(ROUTE[0], LOGO, { layout: 'classic' }));
    assert.equal(L.ticketBody(ROUTE[0], LOGO), L.ticketBody(ROUTE[0], LOGO, 'Delivery Ticket', { layout: 'classic' }));
    rememberPrintLayout('new', null);        // and forward again
    assert.equal(L.buildManifestHtml(ROUTE, LOGO), manifest('new'));
  } finally { _resetPrintLayoutForTests(); }
});

test('a manifest is ONE layout from its cover to its last page', () => {
  for (const [layout, mark, other] of [['new', /class="badge"/, /class="row1"/], ['classic', /class="row1"/, /class="badge"/]]) {
    const html = manifest(layout);
    for (const page of pagesOf(html)) { assert.match(page, mark); assert.doesNotMatch(page, other); }
  }
});

test('every print button still calls the same builder with the same arguments — the setting decides, not the call', () => {
  // Five doors to the paper. None names a layout, so all five follow Diagnostics → Manifest layout.
  const logo = String.raw`\(typeof window !== 'undefined' \? window\.location\.origin : ''\) \+ '\/davis-logo\.jpg'`;
  assert.match(APP, new RegExp(String.raw`buildTicketHtml\(live, ${logo}\)`), 'the stop card’s Ticket');
  assert.match(APP, new RegExp(String.raw`buildTicketHtml\(stop, ${logo}\)`), 'the Routing stop detail’s Ticket');
  assert.match(APP, new RegExp(String.raw`buildTicketHtml\(ticketStopFromLabel\(labelRec\), ${logo}\)`), 'New Order’s ticket');
  assert.match(APP, new RegExp(String.raw`buildManifestHtml\(sorted, ${logo}\)`), 'a route’s Print Manifest');
  assert.match(APP, /\? buildManifestHtml\(stops, logo, displayName, \{ asGiven: true, labels \}\)\s*\n?\s*: buildManifestHtml\(stops, logo, displayName\)/, 'a Compare card’s Print manifest');
  // The only call that names one is the Preview, which exists to show a layout that is not in use.
  assert.equal((APP.match(/\{ layout: c\.layout \}/g) || []).length, 1);
});

// ── THE PREVIEW'S ROUTE ──────────────────────────────────────────────────────

test('THE PREVIEW IS NOBODY’S FREIGHT: every name says SAMPLE, every phone is 555-01xx, every number is zeros', () => {
  assert.ok(PRINT_LAYOUT_SAMPLE_STOPS.length >= 3);
  for (const s of PRINT_LAYOUT_SAMPLE_STOPS) {
    assert.match(s.businessName, /^SAMPLE /);
    assert.match(s.routeName, /^SAMPLE /);
    assert.match(s.driverName, /^SAMPLE /);
    assert.match(String(s.contact.phone), /^\d{3}55501\d\d$/);
    assert.match(s.stopNbr, /^(SAMPLE-)?0+\d$/);
    for (const c of s.allComments) assert.match(c.addedBy, /^(SAMPLE|DISPATCH)$/);
  }
  for (const layout of ['new', 'classic']) {
    const html = L.buildManifestHtml(PRINT_LAYOUT_SAMPLE_STOPS, LOGO, null, { layout });
    assert.equal(pagesOf(html).length, PRINT_LAYOUT_SAMPLE_STOPS.length, layout);
    assert.match(coverOf(html), /SAMPLE ROUTE/);
    assert.match(coverOf(html), /SAMPLE DRIVER/);
    assert.match(coverOf(html), /SAMPLE SHIPPER, 100 SAMPLE PKWY, BUFORD, GA 30518/, 'the origin is the delivery’s, never the pick-up’s');
  }
  // It shows the things the two layouts place differently: the label, a shared dock, a pick-up.
  assert.ok(PRINT_LAYOUT_SAMPLE_STOPS.some((s) => s.allComments.some((c) => /^SPL-INSTR-TEXT:/.test(c.text))));
  assert.ok(PRINT_LAYOUT_SAMPLE_STOPS.some((s) => s.stopType === 'PU'));
  assert.equal(new Set(PRINT_LAYOUT_SAMPLE_STOPS.map((s) => s.routeSeq)).size, PRINT_LAYOUT_SAMPLE_STOPS.length - 1);
});

// ── the renderer on its own: the empty and the absent ────────────────────────

test('the renderer never throws on a ticket with nothing on it, and prints no "undefined" or "NaN"', () => {
  const empty = { seq: '', type: 'Drop Off', pro: '', bol: '', shipName: '', addrLines: [], cityLine: '', phone: '', reqLine: '', nextStop: '', pallets: 0, loose: 0, totalPieces: 0, weight: 0, items: [], comments: [] };
  for (const t of [empty, { ...empty, items: undefined, comments: undefined, addrLines: undefined }]) {
    const body = newTicketBody(t, LOGO);
    assert.doesNotMatch(body, /undefined|NaN|null/);
    assert.doesNotMatch(body, /class="addr"/, 'no address line: no empty row');
    assert.doesNotMatch(body, /class="next"/);
  }
  const html = newManifestHtml({ routeName: 'Route', driver: '—', origin: '', windowStr: '', stopCount: 0, tot: { pallets: 0, loose: 0, pieces: 0, weight: 0 } }, [], LOGO);
  assert.doesNotMatch(html, /undefined|NaN|null/);
  assert.match(html, /<div>0 Stops<\/div>/);
  assert.doesNotMatch(html, /mf-origin"|>Requested</, 'no origin and no window: neither row is printed empty');
  assert.match(newManifestHtml({ routeName: 'R', driver: 'D', origin: '', windowStr: '', stopCount: 1, tot: { pallets: 1, loose: 0, pieces: 1, weight: 10 } }, ['x'], LOGO), /<div>1 Stop<\/div>/);
});
