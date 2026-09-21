// test/order-detail.test.mjs — CLICK AN ORDER, GET THE ORDER.
//
// Chad, on the first cut of the customer view: "Completely failed me on the ask. I said build
// something customer service could use. You can't click on the order. You can't get any
// details on each order or the customer."
//
// Four things were wrong and every one of them is pinned here:
//   1. clicking an order ran a NEW SEARCH, losing the customer;
//   2. the year listed no orders at all, so it was a dead end;
//   3. the row detail was a status and a time — no POD, no line items, no instructions,
//      no contact;
//   4. receiving hours were fetched, used to decide whether the note card appeared, and then
//      never rendered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { buildOrderDetail, buildCustomerYear } from '../src/lib/stop-lookup.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const T = 'davis';

/** A full sealed stop, unmasked — the shape the detail read actually gets back. */
const full = (over = {}) => ({
  stopNbr: '007181402', pro: '007181402', pros: ['007181402', '007181403'],
  businessName: 'EARTHLY ALTERNATIVE', customerMatchKey: 'earthly_alternative__4200_wendell_dr_sw__atlanta__30336',
  addr1: '4200 WENDELL DR SW', addr2: 'DOCK 4', city: 'ATLANTA', state: 'GA', zip: '30336',
  normalizedStatus: 'DELIVERED', status: '90', isPlanned: true,
  scheduledFrom: '08:00', scheduledTo: '14:00', plannedEtaDTTM: '2026-09-18T09:40',
  arrivalDTTM: '2026-09-18T10:02', deliveredDTTM: '2026-09-18T10:21',
  driverName: 'ANDERSON FRIMPONG', driverUserName: 'ANDERSON', routeName: 'ATL 3', loadNbr: 'DAVIS000203801', loadStopSeq: 5,
  cartons: 6, pallets: 2, weight: 1240, itemsSummary: '6 cartons LED panels',
  poRef: '44812', bol: 'BOL-3319', custRef: 'CR-7741', orderNbr: 'L-551202', warehouse: 'G6', terms: 'PREPAID',
  podDocs: [{ documentName: 'signature.jpg', extension: 'jpg', createdTime: '2026-09-18T14:21:00Z' }],
  stopDetails: [
    { product: 'LED PANEL 2X4', productIdentifier: 'LP-24', quantity: 6, weight: 1240, productCategory: 'L', criticalDimension: 96 },
  ],
  orderInstructions: 'Dock 4 at the REAR — front office will refuse.',
  allComments: [
    { comment: 'Called ahead, they are expecting it', userName: 'CS', createdTime: '2026-09-18T13:00:00Z' },
    { comment: 'Gate code 4412', userName: 'DISPATCH', createdTime: '2026-09-18T12:00:00Z' },
  ],
  contact: { name: 'RAY BOYD', phone: '7705551212', email: 'ray@earthly.example.com' },
  ...over,
});

// ── 3. THE DETAIL ITSELF ─────────────────────────────────────────────────────

test('AN ORDER CARRIES EVERYTHING A REP IS ASKED FOR ON THE PHONE', () => {
  const d = buildOrderDetail(full(), { date: '2026-09-18', today: '2026-09-18' });
  assert.equal(d.outcome, 'delivered');
  // "where is it" — every stamp, in the order they happen
  assert.deepEqual(d.timeline.map((t) => t.key), ['scheduled', 'eta', 'arrived', 'delivered']);
  assert.equal(d.timeline[0].text, '08:00 – 14:00');
  // "who brought it"
  assert.equal(d.driver, 'ANDERSON FRIMPONG');
  assert.equal(d.route, 'ATL 3');
  assert.equal(d.seq, 5);
  // "what was on it"
  assert.equal(d.pieces, 6);
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0].product, 'LED PANEL 2X4');
  assert.equal(d.lines[0].oversize, true, "NuVizz's own L flag — a rep says 'that needs a liftgate' off this");
  // "prove you delivered it"
  assert.equal(d.pod.length, 1);
  assert.equal(d.pod[0].name, 'signature.jpg');
  // "what does my PO say"
  const refs = Object.fromEntries(d.refs.map((r) => [r.label, r.value]));
  assert.equal(refs.PO, '44812');
  assert.equal(refs.BOL, 'BOL-3319');
  assert.equal(refs['Customer ref'], 'CR-7741');
  // "why was it refused" / what the driver was told
  assert.match(d.instructions, /DOCK 4 at the REAR/i);
  assert.equal(d.comments.length, 2);
  assert.equal(d.comments[0].text, 'Called ahead, they are expecting it', 'newest first');
  // "who do I call"
  assert.equal(d.contact.phone, '7705551212');
  // and a multi-order stop names every PRO on it
  assert.deepEqual(d.pros, ['007181402', '007181403']);
});

test('an arrival that lives only in the raw execution block is still found', () => {
  // App.jsx carries its own accessor for exactly this reason — the field is on the stop most
  // days and in the execution block on others. Missing in silence on the screen whose job is
  // saying when we were there is the failure worth probing two places for.
  const d = buildOrderDetail(
    full({ arrivalDTTM: null, raw: { stopExecutionInfo: { to: { arrivalDTTM: '2026-09-18T10:02' } } } }),
    { date: '2026-09-18', today: '2026-09-18' },
  );
  assert.equal(d.arrivedAt, '2026-09-18T10:02');
});

test('a thin record degrades to a well-formed answer rather than a throw', () => {
  const d = buildOrderDetail({ stopNbr: '1', normalizedStatus: 'SCHEDULED' }, { date: '2026-09-18', today: '2026-09-18' });
  assert.equal(d.pod.length, 0);
  assert.equal(d.lines.length, 0);
  assert.equal(d.refs.length, 0);
  assert.equal(d.contact, null);
  assert.deepEqual(d.comments, []);
});

test('the answer says whether it came from the SEAL or the live board', () => {
  // The seal cannot change again; a board copy is live and a delivery time read off it may
  // still move. A rep quoting a time is entitled to know which one they are quoting.
  assert.equal(buildOrderDetail(full(), { date: '2026-09-18', today: '2026-09-18', source: 'board' }).source, 'board');
  assert.equal(buildOrderDetail(full(), { date: '2026-09-18', today: '2026-09-18' }).source, 'sealed');
});

// ── the endpoint that serves it ──────────────────────────────────────────────

test('THE DETAIL READ IS TARGETED — one stop, one day, and NOT a board sweep', async () => {
  const fake = installFirestoreFake({
    [`history_days/${T}__2026-09-18/stops/007181402`]: full(),
    'customer_notes/earthly_alternative__4200_wendell_dr_sw__atlanta__30336': {
      notes: 'Ring the bell', receiving_hours: { mon: { open: '08:00', close: '14:00' } }, no_tractor: true,
    },
  });
  try {
    const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
    const body = await (await handler(new Request('https://x/.netlify/functions/stop-lookup?detail=007181402&date=2026-09-18'))).json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'detail');
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(body.source, 'sealed');
    assert.equal(body.stop.driver, 'ANDERSON FRIMPONG');
    assert.equal(body.stop.lines.length, 1);
    // The customer's own note rides along, joined by the DERIVED key.
    assert.equal(body.note.text, 'Ring the bell');
    assert.ok(body.note.hours, 'and the receiving hours, which the first cut never showed');
    // NOT A SWEEP. If this ever starts listing day collections it is back to the cost the
    // masked sweep exists to avoid.
    assert.deepEqual(fake.log.lists.filter((p) => /\/stops$/.test(p)), []);
    assert.equal(fake.log.other.length, 0, 'and nothing but Firestore');
  } finally { fake.restore(); }
});

test("today's order falls back to the live board, because today is never sealed", async () => {
  const fake = installFirestoreFake({ [`nuvizz_stop_index/${T}__2026-09-18/stops/007181402`]: full() });
  try {
    const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
    const body = await (await handler(new Request('https://x/.netlify/functions/stop-lookup?detail=007181402&date=2026-09-18'))).json();
    assert.equal(body.source, 'board');
    assert.equal(body.stop.pro, '007181402');
  } finally { fake.restore(); }
});

test('a missing order is an honest miss, not a crash or an empty card', async () => {
  const fake = installFirestoreFake({});
  try {
    const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
    const body = await (await handler(new Request('https://x/.netlify/functions/stop-lookup?detail=009999999&date=2026-09-18'))).json();
    assert.equal(body.ok, true);
    assert.equal(body.stop, null);
    assert.equal(body.complete, true);
  } finally { fake.restore(); }
});

test('a malformed date is refused rather than turned into a path', async () => {
  const fake = installFirestoreFake({});
  try {
    const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
    const r = await handler(new Request('https://x/.netlify/functions/stop-lookup?detail=1234567&date=../secrets'));
    assert.equal(r.status, 400);
  } finally { fake.restore(); }
});

// ── 1. CLICKING MUST NOT LOSE THE CUSTOMER ───────────────────────────────────

test('AN ORDER CLICK OPENS THE DRAWER AND DOES NOT RE-SEARCH', () => {
  // The first cut ran setQ + run(pro), which replaced the customer's whole answer with that
  // one order's history and left no way back but retyping the name. A rep asking about three
  // of a customer's six orders had to search the customer three times.
  assert.match(APP, /const openOrder = useCallback\(async \(stopNbr, date\)/, 'the opener exists');
  const opener = APP.slice(APP.indexOf('const openOrder = useCallback'), APP.indexOf("const pick = useCallback((pro) =>"));
  assert.ok(!/setQ\(/.test(opener), 'opening an order must not touch the search box');
  assert.ok(!/\brun\(/.test(opener), 'and must not re-run the customer search');
  assert.match(opener, /stop-lookup\?detail=/, 'it reads the one order instead');
  // THE DAY ROWS MUST HAND IT BOTH ARGUMENTS. `openOrder(stopNbr, date)` returns silently
  // without a date — so wiring `onPro={openOrder}` while the row still called `onPro(r.pro)`
  // produced a button that looked live, hovered, and did NOTHING. Caught in a screenshot, not
  // by the first version of this test, which only checked that the handler was attached.
  assert.match(APP, /onPro=\{openOrder\}/, 'the handler is attached');
  // Scoped to real CALL SITES — `onClick={() => onPro(…)}` — rather than any occurrence of
  // the text. The first version of this matched the changelog row that DESCRIBES the bug,
  // which is a test failing on its own prose.
  for (const call of APP.match(/onClick=\{\(\) => onPro\([^)]*\)\}/g) || []) {
    assert.match(call, /,/, `every onPro call site must pass a date too: ${call}`);
  }
  assert.match(APP, /onPro\(r\.refs\?\.stopNbr \|\| r\.pro, r\.date\)/, 'the day rows pass their own day');
  assert.match(APP, /onPro\(p\.pro, p\.date\)/, 'and so does the older-deliveries list');
});

// ── THE ORDER OPENS UNDER ITS OWN ROW (v1.51.0) ──────────────────────────────
//
// Chad: "if we are using this as a customer service bunching everything to the right is no
// good this screen should act like a drawer and drop below the row using the same spacing."
// The drawer covered the very table a rep was reading. These pin that it cannot come back.

test('THERE IS NO OVERLAY ANY MORE — nothing on this screen covers or dims the list', () => {
  assert.ok(!/function OrderDetailDrawer\(/.test(APP), 'the right-hand drawer is gone');
  assert.ok(!/function OrderDetailSheet\(/.test(APP), "and so is the phone's full-cover sheet");
  assert.match(APP, /function OrderDetailPanel\(/, 'one inline panel serves both views');
  // The overlap guard's opt-out marked a surface as DELIBERATELY covering the page. An inline
  // panel is in the flow and covers nothing, so claiming the exemption would switch off a real
  // check on this screen.
  assert.ok(!/data-overlay-layer="order-detail"/.test(APP), 'the panel claims no overlay layer');
  assert.ok(!/fixed inset-0[^>]*order-detail/.test(APP), 'and is not fixed-positioned');
});

test('EVERY LIST DRAWS THE PANEL ITSELF, from one shared decision about which row is open', () => {
  // One place decides; the lists only ask. A list cannot draw a panel under a row the screen
  // does not think is open, nor fail to draw one under the row it does.
  assert.match(APP, /const renderOrderPanel = useCallback\(\(stopNbr, date\) => \{/);
  const fn = APP.slice(APP.indexOf('const renderOrderPanel = useCallback'), APP.indexOf('const renderOrderPanel = useCallback') + 900);
  assert.match(fn, /if \(!detail\) return null;/);
  assert.match(fn, /detail\.stopNbr !== String\(stopNbr/, 'matched on BOTH the order and its day');
  assert.match(fn, /detail\.date !== String\(date/);
  assert.match(fn, /<OrderDetailPanel/);
  for (const list of ['CustomerDayTable', 'CustomerDayCards', 'StopDayTable', 'StopDayListMobile', 'CustomerRecent', 'CustomerYearScreen']) {
    // Bounded look-ahead rather than [^>]*: `onMoreOrders={() => …}` carries a '>' of its own,
    // and a character class that trips over an arrow function is a test that fails on syntax.
    assert.match(APP, new RegExp(`<${list}[\\s\\S]{0,400}?renderDetail=\\{renderOrderPanel\\}`), `${list} must be given the panel renderer`);
  }
});

test('IN A TABLE IT IS A ROW SPANNING EVERY COLUMN — "the same spacing", literally', () => {
  // A panel in one cell would sit under one column and shove the others sideways; the point of
  // dropping below the row is that nothing beside it moves.
  const cust = APP.slice(APP.indexOf('function CustomerDayTable'), APP.indexOf('function CustomerDayCards'));
  assert.match(cust, /<td colSpan=\{7\}/, 'the customer table has 7 columns');
  assert.match(cust, /day\.rows\.flatMap\(/, 'the detail row is a sibling of its own row, not a child');
  const stop = APP.slice(APP.indexOf('function StopDayTable'), APP.indexOf('function StopDayListMobile'));
  assert.match(stop, /<td colSpan=\{8\}/, "the order's own history table has 8");
  assert.match(stop, /days\.flatMap\(/);
});

test('TAPPING THE OPEN ORDER AGAIN CLOSES IT, and the row says whether it is open', () => {
  const opener = APP.slice(APP.indexOf('const openOrder = useCallback'), APP.indexOf("const pick = useCallback((pro) =>"));
  assert.match(opener, /if \(detail && detail\.stopNbr === id && detail\.date === day\) \{ closeOrder\(\); return; \}/,
    'the same order twice is a toggle, not a re-fetch');
  // Four row kinds carry the state, so a rep always knows which row the panel belongs to.
  assert.ok((APP.match(/aria-expanded=\{!!panel\}/g) || []).length >= 4, 'every row kind reports its state');
});

test('the panel still closes on Escape, and only scrolls when it opened off-screen', () => {
  const panel = APP.slice(APP.indexOf('function OrderDetailPanel'), APP.indexOf('function OrderDetailInner'));
  assert.match(panel, /e\.key === 'Escape'/);
  assert.match(panel, /scrollIntoView\(\{ block: 'nearest' \}\)/, 'nearest — never yank a visible panel into view');
  assert.match(panel, /aria-label="Close order detail"/);
});

test('THE WIDTH IS USED: the sections go to columns when there is room, and stack on a phone', () => {
  const body = APP.slice(APP.indexOf('function OrderDetailBody'), APP.indexOf('function OrderDetailPanel'));
  assert.match(body, /function OrderDetailBody\(\{ data, onOpenHistory, wide \}\)/);
  assert.match(body, /wide \? 'grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3 items-start' : 'space-y-3'/);
  // `wide` is the DESKTOP question, so it is driven off the same flag the rest of the screen
  // splits on — not off a media query the tests cannot see.
  assert.match(APP, /stacked=\{isMobile\}/);
  assert.match(APP, /wide=\{!stacked\}/);
});

// ── 2. THE YEAR IS NOT A DEAD END ────────────────────────────────────────────

test('THE YEAR LISTS ORDERS, each one openable', () => {
  const v = buildCustomerYear({
    year: '2026', today: '2026-09-19',
    customers: [{
      addr1: '4200 WENDELL DR SW', monthsFrom: '2026-01-02',
      months: { '2026-09': { stops: 2, delivered: 2 } },
      drivers: {},
      pros: [
        { pro: '007181402', date: '2026-09-18', driver: 'ANDERSON FRIMPONG' },
        { pro: '007177412', date: '2026-08-14', driver: 'FRANK OKINE' },
        { pro: '007100001', date: '2025-12-02', driver: 'FRANK OKINE' },
      ],
    }],
  });
  assert.equal(v.orders.length, 2, 'only this year');
  assert.equal(v.orders[0].pro, '007181402', 'newest first');
  assert.equal(v.orders[0].driver, 'ANDERSON FRIMPONG');
  assert.match(APP, /Orders in \{v\.year\}/, 'and the screen renders them');
  assert.match(APP, /onClick=\{\(\) => onOrder\(o\.pro, o\.date\)\}/, 'each one opening the drawer');
});

// ── 4. RECEIVING HOURS WERE FETCHED AND NEVER SHOWN ──────────────────────────

test('RECEIVING HOURS ARE RENDERED, not just used to decide the card exists', () => {
  // The bug: `notes.hours` was in the `has` guard and in no JSX. A customer whose only note
  // was their receiving hours got an EMPTY card, and the one fact that decides what a rep may
  // promise was fetched on every lookup and shown on none of them.
  const card = APP.slice(APP.indexOf('function StopNotesCard'), APP.indexOf('function CustomerRecent'));
  assert.match(card, /Receiving hours/, 'the hours are on screen');
  assert.match(card, /hoursSummary\(\{ receiving_hours: notes\.hours \}\)/, 'formatted by the shared rule');
  assert.match(card, /href=\{`tel:\$\{c\.phone\}`\}/, 'and phone numbers are tappable');
  // ONE formatter, shared with the chat assistant, so the two can never disagree about what a
  // customer's hours are.
  assert.match(APP, /buildTrimmedStops, hoursSummary \} from '\.\/lib\/ai-search\.js'/);
});

test('the order panel repeats the hours and flags, because that is where a promise is made', () => {
  const body = APP.slice(APP.indexOf('function OrderDetailBody'), APP.indexOf('function OrderDetailPanel'));
  assert.match(body, /Before you promise anything/);
  assert.match(body, /Receiving hours/);
  assert.match(body, /Proof of delivery/);
  assert.match(body, /Line items/);
  assert.match(body, /Who to call/);
});

test('every layout guard drives the open order, with the widest real order shape', () => {
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /ORDER_DETAIL/, `${f} must stub the detail read`);
    assert.match(src, /u\.includes\('detail='\) \? ORDER_DETAIL/, `${f} picks it the way the endpoint does`);
    assert.match(src, /an order opened/, `${f} must probe the open order`);
  }
});

test('the customer card shows every dock, so "which one did it go to" is answerable', () => {
  const card = APP.slice(APP.indexOf('function StopNotesCard'), APP.indexOf('function CustomerRecent'));
  assert.match(card, /addresses`/, 'the addresses are listed');
  assert.match(APP, /<StopNotesCard notes=\{v\.notes\} locations=\{v\.locations\} \/>/);
});
