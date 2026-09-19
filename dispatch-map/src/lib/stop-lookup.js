// stop-lookup.js — EVERYTHING FIRESTORE HOLDS ABOUT ONE STOP, IN ONE ANSWER.
//
// Chad, 2026-09-18: "i want to develop a stops screen under more where i can look up any
// stop and it's history we have in firestore."
//
// ── THE LOGISTICS QUESTION FIRST ─────────────────────────────────────────────
//
// WHO ACTS ON THIS, AND WHEN. A dispatcher or a customer-service rep with a customer on
// the phone, asking about ONE order: when were you here, who had it, did it deliver, why
// does it still say scheduled, did somebody change my address. That call is answered in
// under a minute or it is answered badly.
//
// WHAT THEY DO DIFFERENTLY. Today that answer is spread over four places and one of them
// is a curl command. The stop card only knows stops on TODAY's board. The customer-history
// search only knows a customer's most recent twenty PROs. The address log only knows
// addresses. And nuvizz-stop-explain — which already gathers a stop's whole board story for
// free — has no door in the app at all: it shipped in v1.4.0 as an endpoint nobody in the
// building can reach. So the rep does the one thing that always works and spends a NuVizz
// call on an order we already hold.
//
// THE FAILURE THIS PREVENTS, in freight terms. "We have no record of that order" said about
// an order sitting in our own warehouse — the exact complaint that produced the PRO index
// (Chad, 2026-09-15: "this order is a week old why is it not in the history"). And the
// expensive version of the same thing: a redelivery built because nobody could see the
// attempt from two days ago, so the freight goes out twice.
//
// WHICH WAY IT COSTS MORE TO BE WRONG. Showing too much is noise on a screen somebody chose
// to open. Showing NOTHING when we hold something is the expensive one, because a blank
// screen and "we never captured it" look identical — that is precisely how the roster bug
// went four rounds undiagnosed (CLAUDE.md). So this module never returns a bare empty: it
// returns a SOURCE LEDGER saying which collection was read, over what window, and what it
// held. An empty answer you can audit is a different object from an empty answer you cannot.
//
// ── WHAT THIS MODULE IS ──────────────────────────────────────────────────────
//
// PURE. No Firestore, no fetch, no React, no clock — the caller passes `today`. The endpoint
// (netlify/functions/stop-lookup.mts) does the gathering; this decides what the documents
// MEAN, in the words a dispatcher uses. Unit-tested directly by test/stop-lookup.test.mjs.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The four terminal buckets NuVizz's lifecycle collapses to (lib/nuvizz-scan.mts
 *  StopStatusKind), plus the two legacy spellings sealed days can still carry. */
const TERMINAL = new Set(['DELIVERED', 'EXCEPTION', 'CANCELLED']);

const s = (v) => String(v ?? '').trim();
const numOrNull = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

/**
 * PURE: is the typed text a stop/PRO number, or a customer name?
 *
 * The rule is DELIBERATELY mechanical rather than clever, because the screen says out loud
 * which way it read the box and a dispatcher can retype. A PRO on this board is a run of at
 * least six digits with no space in it — bare ("7174397"), zero-padded ("007174397"),
 * segmented ("007157687-1") or carrier-prefixed ("AVRT-0170416694", "RA5732712"). Anything
 * else is a name: "LED ENERGY PLUS", "E R SNELL", "3M" (one digit, not six).
 *
 * The six-digit floor is the same one history-pro-index.proIndexKeys uses, and for the same
 * reason — a short token must never mint a key that swallows unrelated orders.
 */
export function classifyQuery(raw) {
  const q = s(raw);
  if (!q) return { kind: 'empty', value: '' };
  const digits = q.replace(/\D/g, '');
  if (!/\s/.test(q) && digits.length >= 6) return { kind: 'stop', value: q.toUpperCase() };
  return { kind: 'name', value: q };
}

/**
 * PURE: the doc ids one typed stop number could be STORED under, most likely first.
 *
 * Three spellings of the same order exist in this database and all three are real:
 *   • as typed / upper-cased          — a carrier PRO ("avrt-0170416694" → "AVRT-0170416694")
 *   • zero-padded to 9                — NuVizz's own form for a numeric PRO
 *   • the bare digits, padding gone   — how a dispatcher types it
 * plus the board's SEGMENT suffix ("007157687-1"), which is the 9-digit PRO plus a piece
 * number and must resolve to the same order.
 *
 * Narrow on purpose: the segment rule only strips a 1–2 digit tail after a FULL 9-digit
 * group, so an Estes-style "028-8347656" (where the dash is formatting inside a 10-digit
 * PRO) is left whole. That is the same guard history-pro-index.stripSegment carries, and it
 * is what keeps two carriers' PROs from being read as one another.
 */
export function stopIdVariants(raw) {
  const q = s(raw);
  if (!q) return [];
  const out = [];
  const add = (v) => { const t = s(v); if (t && !out.includes(t)) out.push(t); };
  add(q);
  add(q.toUpperCase());
  const seg = /^(\d{9})-(\d{1,2})$/.exec(q);
  if (seg) add(seg[1]);
  const base = seg ? seg[1] : q;
  if (/^\d+$/.test(base)) {
    add(base.replace(/^0+(?=\d)/, ''));          // padding stripped
    if (base.length < 9) add(base.padStart(9, '0'));
  }
  return out;
}

/** The address as of one record, in the shape the screen's diff components already take. */
function addressOf(row) {
  if (!row) return null;
  const a = { addr1: s(row.addr1) || null, addr2: s(row.addr2) || null, city: s(row.city) || null, state: s(row.state) || null, zip: s(row.zip) || null };
  return a.addr1 || a.city || a.zip ? a : null;
}

/** Route NAME first, load number second — a dispatcher says "DULUTH", not "DAVIS000203707". */
const routeOf = (row) => s(row?.routeName) || s(row?.loadNbr) || null;
const driverOf = (row) => s(row?.driverName) || s(row?.driverUserName) || null;

/**
 * PURE: what happened to this stop on this day, in one word a dispatcher acts on.
 *
 * `laterDay` is whether we hold a LATER day for the same order, and it is what separates the
 * two readings of an old un-terminal day. Without it a stop that failed on Monday and
 * delivered on Tuesday reads "open" for ever on Monday's row — which on a screen answering
 * "what happened to my order" is a rep telling a customer their freight is still out.
 */
export function dayOutcome({ status, isAttempt, date, today, laterDay }) {
  const st = s(status).toUpperCase();
  if (st === 'DELIVERED') return 'delivered';
  if (st === 'EXCEPTION') return 'exception';
  if (st === 'CANCELLED') return 'cancelled';
  if (isAttempt) return 'attempted';
  if (DAY_RE.test(date) && DAY_RE.test(today) && date < today) return laterDay ? 'rolled' : 'unfinished';
  return 'open';
}

/**
 * PURE: merge every document we hold for one day into ONE row.
 *
 * PRECEDENCE, and why. The SEALED warehouse record wins on every fact it carries: it is the
 * end-of-night truth, immutable, and it is the only one of the four that cannot still be
 * rewritten under you. The live board copy fills what the seal lacks and is the WHOLE answer
 * for a day not yet sealed — today, and anything the scan has written forward. The morning
 * plan snapshot and the attempts item are never overwritten by either: they are facts of
 * their own ("at 8:30 this was on ROBERT", "by evening it was wearing an ATT marker"), and
 * collapsing them into a status is how the attempt disappears behind the redelivery.
 */
export function mergeDay({ date, sealed, board, attempt, plan }, { today, laterDay } = {}) {
  const primary = sealed || board || plan || null;
  const sources = [];
  if (sealed) sources.push('sealed');
  if (board) sources.push('board');
  if (plan) sources.push('plan');
  if (attempt) sources.push('attempt');

  const status = s(sealed?.normalizedStatus) || s(board?.normalizedStatus) || s(plan?.normalizedStatus) || null;
  const delivered = s(sealed?.deliveredDTTM) || s(sealed?.executed?.deliveredDTTM) || s(board?.deliveredDTTM) || null;
  const arrival = s(sealed?.arrivalDTTM) || s(sealed?.executed?.arrivalDTTM) || s(board?.arrivalDTTM) || null;

  return {
    date,
    sources,
    outcome: dayOutcome({ status, isAttempt: !!attempt, date, today: s(today), laterDay: !!laterDay }),
    status: status || null,
    // The MORNING driver is the one who owned the freight, and on an attempt day it is not
    // the one the evening board shows — attempts-core says so in as many words. Prefer the
    // plan snapshot's driver on a day that produced an attempt, and name the other one too.
    route: routeOf(attempt ? plan || sealed || board : primary) || routeOf(primary),
    driver: driverOf(attempt ? plan || sealed || board : primary) || driverOf(primary),
    currentDriver: attempt ? s(attempt.currentDriverName) || null : null,
    seq: numOrNull(primary?.loadStopSeq ?? primary?.routeSeq),
    planned: primary ? primary.isPlanned === true : null,
    deliveredAt: delivered || null,
    arrivedAt: arrival || null,
    address: addressOf(sealed) || addressOf(board) || addressOf(plan) || addressOf(attempt),
    name: s(sealed?.businessName) || s(board?.businessName) || s(plan?.businessName) || s(attempt?.businessName) || null,
    pieces: numOrNull(primary?.cartons) ?? numOrNull(primary?.volume),
    pallets: numOrNull(primary?.pallets),
    weight: numOrNull(primary?.weight),
    pod: Array.isArray(sealed?.podDocs) ? sealed.podDocs.length : (Array.isArray(board?.podDocs) ? board.podDocs.length : 0),
    lines: Array.isArray(sealed?.stopDetails) ? sealed.stopDetails.length : 0,
    // The refs a customer quotes down the phone — theirs, not ours.
    refs: {
      pro: s(primary?.pro) || s(primary?.primaryPro) || null,
      stopNbr: s(primary?.stopNbr) || s(attempt?.stopNbr) || null,
      shipmentNbr: s(primary?.shipmentNbr) || s(attempt?.shipmentNbr) || null,
      po: s(primary?.poRef) || null,
      custRef: s(primary?.custRef) || null,
      bol: s(primary?.bol) || null,
      orderNbr: s(primary?.orderNbr) || null,
    },
    matchKey: s(sealed?.customerMatchKey) || s(plan?.customerMatchKey) || s(attempt?.customerMatchKey) || null,
    scannedAt: s(board?._scannedAt) || null,
    capturedAt: s(sealed?.captured_at) || null,
  };
}

/**
 * PURE: one stop's whole Firestore footprint → the answer the screen renders.
 *
 * `facts` is exactly what the endpoint gathered, and NOTHING is inferred that is not in it.
 * The shape is documented in the endpoint beside the reads that fill it.
 */
export function buildStopDossier(facts = {}) {
  const today = s(facts.today);
  const query = s(facts.query);

  // ── one row per day, newest first ──────────────────────────────────────────
  const byDate = new Map();
  const slot = (date) => {
    const d = s(date);
    if (!DAY_RE.test(d)) return null;
    if (!byDate.has(d)) byDate.set(d, { date: d, sealed: null, board: null, attempt: null, plan: null });
    return byDate.get(d);
  };
  for (const r of facts.sealed || []) { const k = slot(r?.date); if (k && r?.stop) k.sealed = r.stop; }
  for (const r of facts.board || []) {
    const k = slot(r?.date);
    // The day document's own scan stamp rides ON the row so a stale board copy can say so.
    if (k && r?.row) k.board = { ...r.row, _scannedAt: r.scannedAt ?? null };
  }
  for (const r of facts.attempts || []) { const k = slot(r?.date); if (k && r?.item) k.attempt = r.item; }
  for (const r of facts.plans || []) { const k = slot(r?.date); if (k && r?.item) k.plan = r.item; }

  const dates = [...byDate.keys()].sort().reverse();
  const days = dates.map((date, i) => mergeDay(byDate.get(date), {
    today,
    // Newest first, so anything after this index in the array is an EARLIER day; a later day
    // exists exactly when this is not the first row.
    laterDay: i > 0,
  }));

  // ── identity: the newest thing we know, and it says which day it came from ──
  const newest = days[0] || null;
  const oldest = days.length ? days[days.length - 1] : null;
  const pick = (get) => { for (const d of days) { const v = get(d); if (v) return v; } return null; };

  const identity = {
    query,
    pro: pick((d) => d.refs.pro) || pick((d) => d.refs.stopNbr) || (classifyQuery(query).kind === 'stop' ? query : null),
    stopNbr: pick((d) => d.refs.stopNbr),
    name: pick((d) => d.name) || s(facts.customer?.name) || null,
    address: pick((d) => d.address) || (facts.customer ? addressOf(facts.customer) : null),
    matchKey: pick((d) => d.matchKey) || s(facts.customer?.match_key) || s(facts.customer?.matchKey) || null,
    refs: newest ? newest.refs : null,
    asOf: newest ? newest.date : null,
  };

  const counts = {
    days: days.length,
    delivered: days.filter((d) => d.outcome === 'delivered').length,
    attempts: days.filter((d) => d.sources.includes('attempt')).length,
    exceptions: days.filter((d) => d.outcome === 'exception' || d.outcome === 'cancelled').length,
    sealed: days.filter((d) => d.sources.includes('sealed')).length,
    onBoard: days.filter((d) => d.sources.includes('board')).length,
  };

  // ── the ledger: what was read, over what window, and what it held ──────────
  //
  // ALWAYS rendered, populated or not. A dispatcher told "nothing found" needs to know
  // whether that means "we looked in six places and they were empty" or "the index is the
  // only thing we asked and it said no" — those are different answers and only one of them
  // is a reason to spend a NuVizz call.
  const look = facts.looked || {};
  // THE SOURCES THAT COULD ACTUALLY LOCATE THE ORDER. The customer rollup and the dispatcher
  // note are keyed by the customer, which we only learn FROM one of these — so on a genuine
  // miss they are not unread, they are un-lookup-able, and painting them the same red as a
  // failed read makes every empty answer look broken. Only these seven decide whether the
  // answer is complete.
  const LOCATING = ['pros', 'sealed', 'board', 'attempts', 'plans', 'address', 'writes'];
  // Tri-state, passed through rather than coerced: absent means it was read (the caller only
  // reports the exceptions), false means the read FAILED, 'skipped' means there was nothing to
  // read it by. A `!== false` test collapses the last two into "read", which is how the first
  // cut reported a skipped source as a successful empty read.
  const state = (v) => (v === false ? false : v === 'skipped' ? 'skipped' : true);
  const sources = [
    { key: 'pros', label: 'PRO index', where: 'history_pros', note: 'which days this order was captured on',
      looked: state(look.pros), count: (facts.pointers || []).length },
    { key: 'sealed', label: 'Sealed history', where: 'history_days/…/stops', note: look.sealedWindow || 'the days the index pointed at',
      looked: state(look.sealed), count: counts.sealed },
    { key: 'board', label: "Today's board", where: 'nuvizz_stop_index/…/stops', note: look.boardWindow || null,
      looked: state(look.board), count: counts.onBoard },
    { key: 'attempts', label: 'Attempts', where: 'attempts/…/items', note: 'a redelivery marker on one of these days',
      looked: state(look.attempts), count: counts.attempts },
    { key: 'plans', label: 'Morning plan', where: 'att_plan/…/stops', note: 'who had it when the board froze at 8:30',
      looked: state(look.plans), count: days.filter((d) => d.sources.includes('plan')).length },
    { key: 'customer', label: 'Customer rollup', where: 'history_customers', note: "this customer's other deliveries",
      looked: state(look.customer), count: (facts.customer?.pros || []).length },
    { key: 'notes', label: 'Dispatcher notes', where: 'customer_notes', note: 'notes, receiving hours, contacts, overrides',
      looked: state(look.notes), count: facts.notes ? 1 : 0 },
    { key: 'address', label: 'Address changes', where: 'nuvizz_ops/addr_changes__…', note: look.addressWindow || null,
      looked: state(look.address), count: (facts.addressChanges || []).length },
    { key: 'writes', label: 'What we sent NuVizz', where: 'nuvizz_write_ops', note: 'saves and board syncs naming this order',
      looked: state(look.writes), count: (facts.writes || []).length },
  ].map((r) => {
    // `looked` arrives as true, false, or the string 'skipped' — see LOCATING above.
    const skipped = r.looked === 'skipped';
    const looked = r.looked === true;
    return {
      ...r,
      looked,
      skipped,
      found: looked && r.count > 0,
      state: looked ? (r.count > 0 ? 'found' : 'empty') : skipped ? 'skipped' : 'unread',
    };
  });

  // COMPLETE means every source that could have LOCATED this order was actually read. It is
  // what licenses the screen to say "we have genuinely never captured this" — and without it
  // the empty state said exactly that over a ledger reporting a failed read, which is the one
  // sentence this whole module exists to stop the screen from printing.
  const unreadLocating = sources.filter((r) => LOCATING.includes(r.key) && r.state === 'unread');

  return {
    query,
    kind: classifyQuery(query).kind,
    found: days.length > 0,
    complete: unreadLocating.length === 0,
    unreadSources: unreadLocating.map((r) => r.label),
    identity,
    counts,
    firstSeen: oldest ? oldest.date : null,
    lastSeen: newest ? newest.date : null,
    latest: newest,
    days,
    addressChanges: facts.addressChanges || [],
    writes: facts.writes || [],
    notes: facts.notes || null,
    customer: facts.customer || null,
    sources,
  };
}

// ── THE PROMPTED CALL — the one door on this screen that can spend a NuVizz call ────────
//
// Chad, 2026-09-19: "if it's a specific customer pro or date range that is not in the
// firestore data allow a prompted nuvizz call." — and, when the first cut called it
// "promoted": "Prompted nuvizz call." His word, so it is the word everywhere: the endpoint,
// the switch, the record fields. PROMPTED, as in: a rep looked, Firestore had nothing, and
// the rep is PROMPTED to ask NuVizz — one /stop/info call, priced on the button, and only
// ever spent by the person who pressed it. Every rule about it lives here, pure, so the
// endpoint and the screen cannot disagree about when the prompt may show or what its answer
// means.
//
// WHAT IT CANNOT DO, said here because the screen says it too: NuVizz has no endpoint that
// takes a customer NAME (every list-style endpoint demands a per-record id — lib/nuvizz-scan
// .mts has the live verification), so a customer with nothing on file cannot be asked of
// NuVizz; only a PRO can. And the only date gaps NuVizz's cheap list pull can reach (±60
// days) are already fully sealed in the warehouse, so a "date range" prompt would have
// nothing to fetch. A PRO is the one thing this can ask about, so a PRO is the one thing it
// offers.

/**
 * PURE: the house-shape switch. Default ON; the explicit off-words turn it off; anything
 * malformed leaves it ON, because a typo in an env var must never silently disable a rule.
 */
export function switchOn(value) {
  return !/^(off|0|false|no)$/i.test(s(value));
}

/**
 * PURE: may THIS deployment spend a prompted call at all — and if not, the one sentence a
 * rep reads instead of a button. The screen never shows a button that would fail for a
 * configuration reason; the endpoint refuses on the same rule before it spends anything.
 *
 * `scansSwitch` is NUVIZZ_SCANS_ENABLED, read the exact way lib/nuvizz-scan.scansEnabled()
 * reads it: only the literal word 'false' turns scans off. Re-derived here rather than
 * imported so stop-lookup.mts keeps its structural promise of importing nothing that can
 * spend a call (test/stop-lookup-wiring.test.mjs); a test pins the two readings agree.
 */
export function promptedCallAvailability({ promptedSwitch, scansSwitch, mirror } = {}) {
  if (mirror) return { available: false, reason: 'mirror', text: 'This is a mirror site — it never calls NuVizz.' };
  if (!switchOn(promptedSwitch)) return { available: false, reason: 'switch', text: 'Prompted NuVizz lookups are switched off here (STOP_LOOKUP_PROMPTED_CALL=off).' };
  if (s(scansSwitch).toLowerCase() === 'false') return { available: false, reason: 'scans', text: 'NuVizz calls are switched off on this site (NUVIZZ_SCANS_ENABLED=false).' };
  return { available: true, reason: null, text: 'Ask NuVizz for this order — 1 call.' };
}

/**
 * PURE: the delivery day a /stop/info answer belongs to, or null when NuVizz gave none.
 * Actual before planned: the day it was delivered, else arrived, else the planned ETA, else
 * the window. A record filed under the wrong day is a record the next lookup cannot find.
 */
export function promptedRecordDay(stop) {
  for (const f of ['deliveredDTTM', 'arrivalDTTM', 'plannedEtaDTTM', 'scheduledFrom', 'scheduledTo']) {
    const d = s(stop?.[f]).slice(0, 10);
    if (DAY_RE.test(d)) return d;
  }
  return null;
}

/**
 * PURE: file it, or only show it?
 *
 * PAST DAYS ONLY. The warehouse is where past deliveries live and where this screen reads
 * first, so a past order NuVizz just answered for is filed there — the next rep pays nothing.
 * Today and the future belong to the board scan: it reads NuVizz's own list two or three
 * times a day and owns those rows; a record written beside it by hand would be either
 * overwritten within hours or, worse, read by the flags and the ETA engine as a stop they
 * were never given. An order with no day at all is shown and not filed — it cannot be found
 * again under a day it does not have.
 */
export function promptedStoreDecision({ day, today } = {}) {
  const d = s(day), t = s(today);
  if (!DAY_RE.test(d)) return { store: false, reason: 'no-day', text: 'NuVizz gave no delivery day for it, so it is shown here but not filed.' };
  if (!DAY_RE.test(t) || d >= t) return { store: false, reason: 'live', text: `It is on NuVizz for ${d} — the board scan owns that day, so nothing was filed by hand.` };
  return { store: true, reason: 'past', text: `Filed under ${d}, so the next lookup costs nothing.` };
}

/**
 * PURE: the record filed in the warehouse — the normalized stop plus what the nightly seal
 * would have stamped on it (date, customer key) and an honest provenance: this row was
 * bought with a call, by a person, on a day the seal missed it. Nothing on it pretends to
 * be a capture.
 */
export function promptedRecord(stop, { day, at, by, matchKey } = {}) {
  return {
    ...(stop || {}),
    date: s(day) || null,
    customerMatchKey: s(matchKey) || s(stop?.customerMatchKey) || null,
    prompted: true,
    prompted_at: s(at) || null,
    prompted_by: s(by) || null,
    prompted_from: 'stop-lookup',
  };
}

/**
 * PURE: what NuVizz said, as a sentence a rep can repeat — and whether a call was actually
 * spent getting it. `spent` is false when the requester refused BEFORE the wire (scans off,
 * breaker open, nothing to ask), so the screen's call count stays an observation, not a
 * charge assumed.
 */
export function promptedOutcome(res) {
  if (res?.ok) return { ok: true, spent: true, reason: 'found', text: 'NuVizz has this order.' };
  const r = s(res?.reason);
  if (r === 'scans_disabled') return { ok: false, spent: false, reason: 'scans', text: 'NuVizz calls are switched off on this site — nothing was spent.' };
  if (r === 'empty') return { ok: false, spent: false, reason: 'empty', text: 'No order number to ask about.' };
  if (/breaker|circuit/i.test(r)) return { ok: false, spent: false, reason: 'breaker', text: 'The NuVizz call breaker is open — the daily ceiling has been reached. Nothing was spent; try again tomorrow, or raise the ceiling in Diagnostics.' };
  if (r === 'not_found' || r === 'http_404') return { ok: false, spent: true, reason: 'not_found', text: 'NuVizz has no order by this number either. Check the digits; if they are right, NuVizz never received it.' };
  return { ok: false, spent: true, reason: 'error', text: `NuVizz could not answer: ${r || 'unknown error'}.` };
}

/** PURE: the ledger row for the source this answer came from — one call, on request. */
export function promptedSource({ day } = {}) {
  return {
    key: 'nuvizz', label: 'NuVizz, asked just now', where: '/stop/info', looked: true, skipped: false,
    note: day ? `one call, on request — filed under ${day}` : 'one call, on request — no delivery day on it',
    count: 1, found: true, state: 'found',
  };
}

/**
 * PURE: the dispatcher notes worth putting on this screen, and nothing else.
 *
 * customer_notes is a big document owned by other features — the address override, the pin,
 * the comms opt-out, the equipment flag, receiving hours, contacts, plus pro_history, which
 * is a log of note SAVES and is NOT a delivery history (src/lib/stop-history.js has the whole
 * argument, and the card that printed both side by side contradicted itself about when we
 * delivered an order). So pro_history is deliberately NOT surfaced here: this screen has the
 * real days two inches up, from the warehouse, and printing edit dates beside them is the
 * exact failure that module exists to stop.
 */
export function notesSummary(notes) {
  if (!notes || typeof notes !== 'object') return null;
  const flags = [];
  if (notes.comms_opt_out === true) flags.push({ key: 'opt_out', label: 'No delivery emails', tone: 'slate' });
  if (notes.notify_cs === true) flags.push({ key: 'notify_cs', label: 'Notify customer service', tone: 'amber' });
  if (notes.no_tractor === true) flags.push({ key: 'no_tractor', label: 'No tractor — box truck only', tone: 'amber' });
  if (notes.address_override) flags.push({ key: 'override', label: 'Address overridden here', tone: 'blue' });
  if (notes.pin_override || notes.lat_override) flags.push({ key: 'pin', label: 'Pin moved by hand', tone: 'blue' });
  const contacts = (Array.isArray(notes.contacts) ? notes.contacts : [])
    .map((c) => ({ name: s(c?.name) || null, phone: s(c?.phone) || null, email: s(c?.email) || null }))
    .filter((c) => c.name || c.phone || c.email);
  return {
    text: s(notes.notes) || s(notes.note) || null,
    hours: notes.receiving_hours || notes.hours || null,
    customerNbr: s(notes.customer_nbr) || s(notes.customerNbr) || null,
    updatedAt: s(notes.updated_at) || s(notes.updatedAt) || null,
    updatedBy: s(notes.updated_by) || s(notes.updatedBy) || null,
    override: notes.address_override || null,
    flags,
    contacts,
  };
}

/** Exported for the endpoint's own guard and for tests — a day id it can safely path with. */
export const isDayId = (d) => DAY_RE.test(s(d));
export { TERMINAL as TERMINAL_STATUSES };

// ═══════════════════════════════════════════════════════════════════════════
// THE CUSTOMER VIEW — "how many deliveries did we have for EARTHLY ALTERNATIVE
// today, and who delivered them?"
// ═══════════════════════════════════════════════════════════════════════════
//
// Chad, 2026-09-18: "I wanted to see how many deliveries we had for earthly alternative
// today and couldn't. Wanted to see all the different ones and drivers who delivered them."
//
// WHY THE FIRST CUT COULD NOT ANSWER IT. The PRO lookup above is a per-ORDER screen, and the
// name search behind it read history_customers — a rollup built from SEALED history. Today is
// not sealed until tonight, so the one day he asked about was the one day that rollup
// structurally cannot contain. It would have answered "0 deliveries" for a customer we had
// been at three times that morning, which is worse than answering nothing at all.
//
// SO THE CUSTOMER VIEW IS BUILT ON THE LIVE BOARD, not the rollup. The board day documents
// carry every stop of every day the scan has written, delivered or not, with the driver, the
// route, the times and the freight already on them.
//
// ── THE JOIN IS BY NAME, AND IT HAS TO BE ────────────────────────────────────
//
// Board rows carry NO customerMatchKey — routing-cleanup-core.mts says so in as many words,
// and customer-key.mts exists because an alert once read a whole board with `matchKey` null
// on all 778 rows and reported a clean day. So "is this stop EARTHLY ALTERNATIVE" is answered
// from the name text, normalised by the SAME rule the match key uses (normNameOf) so a
// location cannot group one way for counting and another way for its notes.
//
// ── ONE CUSTOMER IS OFTEN SEVERAL DOCKS ──────────────────────────────────────
//
// A customer service rep thinks in NAMES ("did Earthly Alternative get their freight"); the
// database thinks in match keys, which are name + street + city + zip — so one customer with
// two warehouses is two keys. Grouping by key alone would split the answer in half and show
// neither total. This groups by NAME and lists the locations underneath, with each stop's own
// address on its row, so both questions are answerable off one screen.

import { normNameOf } from './matchKey.js';

/**
 * PURE: the grouping key for a customer NAME — for counting and grouping only, NEVER for a
 * document path. normNameOf is byte-identical to the name half of the match key (see the note
 * on it); this additionally drops the underscore a stripped suffix leaves behind, so "EARTHLY
 * ALTERNATIVE LLC" and "Earthly Alternative" are one customer on screen rather than two rows
 * with the same name and half the deliveries each.
 */
export function customerNameKey(name) {
  return normNameOf(name).replace(/^_+|_+$/g, '');
}

/**
 * PURE: does this business name match what was typed?
 *
 * Every word typed must appear as the START of a word in the name, in any order. That is the
 * same shape as the rollup's stored search tokens (history-customers.nameSearchTokens keeps
 * every prefix of every word), so the board sweep and the rollup query agree about what
 * matches — two different answers to "is this Earthly Alternative", on one screen, is how a
 * count comes out wrong.
 *
 *   "earthly"          → EARTHLY ALTERNATIVE ✓   EARTHLY ALTERNATIVE LLC ✓
 *   "earthly alt"      → EARTHLY ALTERNATIVE ✓
 *   "alternative"      → EARTHLY ALTERNATIVE ✓   (word order does not matter)
 *   "earthy"           → EARTHLY ALTERNATIVE ✗   (a prefix, not a fuzzy match)
 */
export function nameMatchesQuery(name, query) {
  const words = customerNameKey(query).split('_').filter(Boolean);
  if (!words.length) return false;
  const hay = customerNameKey(name).split('_').filter(Boolean);
  if (!hay.length) return false;
  return words.every((w) => hay.some((h) => h.startsWith(w)));
}

/** The freight on one row, in the words that are on the paperwork. */
const pieceCount = (s) => numOrNull(s?.cartons) ?? numOrNull(s?.volume);

/**
 * PURE: one board or sealed stop → one row of the customer view.
 *
 * `source` is 'board' or 'sealed' and rides on the row rather than being folded away: a past
 * day showing only a board copy is a day the nightly capture missed, and a dispatcher quoting
 * a delivery time down the phone should be able to see which kind of record they are quoting.
 */
export function buildCustomerStopRow(stop, { date, today, source = 'board' } = {}) {
  const st = stop || {};
  const status = s(st.normalizedStatus) || null;
  const isAttempt = st.isAttempt === true || /^ATT/i.test(s(st.shipmentNbr));
  return {
    key: `${date}|${s(st.stopNbr) || s(st.pro)}`,
    date: s(date),
    source,
    stopNbr: s(st.stopNbr) || null,
    pro: s(st.pro) || s(st.primaryPro) || s(st.stopNbr) || null,
    // A stop can carry several PROs (a multi-order drop); the count is what a rep needs to
    // say "that was three orders on one stop" rather than under-reporting the freight.
    proCount: Array.isArray(st.pros) && st.pros.length ? st.pros.length : (numOrNull(st.proCount) || 1),
    status,
    outcome: dayOutcome({ status, isAttempt, date: s(date), today: s(today), laterDay: false }),
    isAttempt,
    route: s(st.routeName) || s(st.loadNbr) || null,
    seq: numOrNull(st.loadStopSeq ?? st.routeSeq),
    driver: s(st.driverName) || s(st.driverUserName) || null,
    planned: st.isPlanned === true,
    deliveredAt: s(st.deliveredDTTM) || null,
    arrivedAt: s(st.arrivalDTTM) || s(st.raw?.stopExecutionInfo?.to?.arrivalDTTM) || null,
    etaAt: s(st.plannedEtaDTTM) || null,
    windowFrom: s(st.scheduledFrom) || null,
    windowTo: s(st.scheduledTo) || null,
    address: addressOf(st),
    name: s(st.businessName) || null,
    pieces: pieceCount(st),
    pallets: numOrNull(st.pallets),
    weight: numOrNull(st.weight),
    pod: Array.isArray(st.podDocs) ? st.podDocs.length : 0,
    refs: {
      po: s(st.poRef) || null, custRef: s(st.custRef) || null,
      bol: s(st.bol) || null, orderNbr: s(st.orderNbr) || null,
    },
  };
}

/** PURE: the counts a rep reads out loud, off any set of rows. */
export function summarizeStopRows(rows) {
  const r = rows || [];
  return {
    stops: r.length,
    orders: r.reduce((n, x) => n + (x.proCount || 1), 0),
    delivered: r.filter((x) => x.outcome === 'delivered').length,
    attempted: r.filter((x) => x.outcome === 'attempted').length,
    exceptions: r.filter((x) => x.outcome === 'exception' || x.outcome === 'cancelled').length,
    open: r.filter((x) => x.outcome === 'open').length,
    unfinished: r.filter((x) => x.outcome === 'unfinished' || x.outcome === 'rolled').length,
    pieces: r.reduce((n, x) => n + (x.pieces || 0), 0),
    weight: r.reduce((n, x) => n + (x.weight || 0), 0),
  };
}

/**
 * PURE: who ran this customer's freight over the window — the half of the question the first
 * build answered least well ("and drivers who delivered them").
 *
 * DELIVERED IS COUNTED SEPARATELY FROM CARRIED, because they are different claims. A driver
 * who had four of these stops and delivered two did not deliver four, and a screen that says
 * he did is the sort of thing that gets repeated to a customer.
 */
export function driverTally(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const name = s(r?.driver);
    if (!name) continue;
    const cur = by.get(name) || { driver: name, stops: 0, delivered: 0 };
    cur.stops += 1;
    if (r.outcome === 'delivered') cur.delivered += 1;
    by.set(name, cur);
  }
  return [...by.values()].sort((a, b) => b.delivered - a.delivered || b.stops - a.stops || a.driver.localeCompare(b.driver));
}

/**
 * PURE: every document gathered for one customer over one window → the screen's answer.
 *
 * `facts.stops` is [{ date, source, stop }] from the endpoint — every board and sealed stop
 * whose name matched. THE MERGE: one physical stop can appear twice on a day (the sealed
 * record and the live board copy), and counting it twice would tell a rep we were there six
 * times when we were there three. Keyed on day + stop number, sealed winning, exactly as
 * mergeDay does for the per-order view and for the same reason.
 */
export function buildCustomerView(facts = {}) {
  const today = s(facts.today);
  const rows = [];
  const seen = new Map();
  for (const r of facts.stops || []) {
    const date = s(r?.date);
    if (!DAY_RE.test(date) || !r?.stop) continue;
    const row = buildCustomerStopRow(r.stop, { date, today, source: r.source === 'sealed' ? 'sealed' : 'board' });
    const k = `${date}|${row.stopNbr || row.pro || Math.random()}`;
    const prev = seen.get(k);
    // The sealed record wins; a board copy still ADDS its sources so the row can say it
    // exists in both places rather than looking like it was only ever live.
    if (prev) {
      if (row.source === 'sealed' && prev.source !== 'sealed') Object.assign(prev, row, { alsoOnBoard: true });
      else prev.alsoSealed = prev.alsoSealed || row.source === 'sealed';
      continue;
    }
    seen.set(k, row);
    rows.push(row);
  }

  // Newest day first; within a day, the running order — which is how a rep reads a route.
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)
    || ((a.seq ?? 9999) - (b.seq ?? 9999))
    || String(a.pro).localeCompare(String(b.pro)));

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date).push(r);
  }
  const days = [...byDay.entries()].map(([date, list]) => ({
    date,
    isToday: date === today,
    rows: list,
    counts: summarizeStopRows(list),
    drivers: driverTally(list),
  }));

  // THE LOCATIONS, off the stops themselves rather than off the rollup: a dock we delivered to
  // for the first time this morning has no rollup document yet, and leaving it out of the
  // location list would hide the very stops the count is made of.
  const locs = new Map();
  for (const r of rows) {
    const key = [r.address?.addr1, r.address?.city, r.address?.zip].filter(Boolean).join('|').toLowerCase() || '(no address)';
    const cur = locs.get(key) || { key, name: r.name, address: r.address, stops: 0, delivered: 0, lastDate: null };
    cur.stops += 1;
    if (r.outcome === 'delivered') cur.delivered += 1;
    if (!cur.lastDate || r.date > cur.lastDate) cur.lastDate = r.date;
    locs.set(key, cur);
  }

  const totals = summarizeStopRows(rows);
  const todayRows = rows.filter((r) => r.date === today);

  return {
    query: s(facts.query),
    name: s(facts.name) || (rows.find((r) => r.name)?.name ?? s(facts.query)),
    nameKey: customerNameKey(s(facts.name) || rows.find((r) => r.name)?.name || s(facts.query)),
    window: facts.window || null,
    today,
    totals,
    // Broken out because it is the question that was actually asked, and a rep should not
    // have to find today among a fortnight of days to answer "did we come today".
    todayCounts: summarizeStopRows(todayRows),
    hasToday: !!facts.window && s(facts.window.from) <= today && s(facts.window.to) >= today,
    drivers: driverTally(rows),
    days,
    locations: [...locs.values()].sort((a, b) => b.stops - a.stops),
    rows,
    recent: facts.recent || [],
    notes: facts.notes || null,
    matches: facts.matches || [],
    sources: facts.sources || [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THIS YEAR — a year of a customer, without reading a year of boards
// ═══════════════════════════════════════════════════════════════════════════
//
// Chad, 2026-09-19: "I want there to be a this year button in the date ranges."
//
// WHY THIS IS NOT JUST A WIDER WINDOW. The day view above answers a range by sweeping a WHOLE
// BOARD per day, twice over, and keeping the stops that match one name — about 1,400 document
// reads per day of window. A year is ~510,000 reads: it does not finish inside the function's
// 26 seconds, and nobody holds a phone that long. Widening the existing window to a year would
// have produced a button that times out, which is worse than no button.
//
// So the year is READ, not swept. lib/history-customers.mts counts four numbers per month
// into the per-customer rollup as the nightly hook passes over each sealed day, and this turns
// that into an answer for the cost of ONE DOCUMENT per dock.
//
// WHAT THE YEAR CAN AND CANNOT SAY, stated on the screen rather than implied:
//   • It CAN say how many stops and deliveries, month by month, and which drivers ran them.
//   • It CANNOT list the stops. The per-stop detail lives in the day documents, which is the
//     thing that costs half a million reads — so the screen sends you to Today / 7 / 14 days
//     for rows, and says so.
//   • And it will NOT report a month the tally never counted. `monthsFrom` is the earliest day
//     counted; months before it are UNCOUNTED, not zero. An un-backfilled month and a month we
//     did not deliver in are the same zero otherwise, and "no deliveries this year" is a
//     sentence a rep says out loud to a customer.

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** PURE: the months of `year` up to and including `today`'s month — a year in progress has no
 *  December, and printing one as "0 stops" would read as a month we did no work in. */
export function monthsOfYear(year, today) {
  const y = String(year);
  const end = s(today).slice(0, 4) === y ? Number(s(today).slice(5, 7)) : 12;
  return Array.from({ length: Math.max(0, Math.min(12, end)) }, (_, i) => `${y}-${String(i + 1).padStart(2, '0')}`);
}

/** PURE: "Sep" from "2026-09". */
export const monthLabel = (m) => MONTH_NAMES[Number(s(m).slice(5, 7)) - 1] || s(m);

/**
 * PURE: a customer's rollup documents → the year answer.
 *
 * `facts.customers` is one shaped rollup per dock (getCustomerByMatchKey's output), each with
 * `months`, `drivers` and `monthsFrom`. They are SUMMED across docks, because a rep asking
 * about a customer means the company, not one of its warehouses — the same rule the day view
 * groups by.
 */
export function buildCustomerYear(facts = {}) {
  const year = s(facts.year) || s(facts.today).slice(0, 4);
  const today = s(facts.today);
  const docs = (facts.customers || []).filter(Boolean);

  // The earliest day ANY dock has counted. A month before it is uncounted for the customer as
  // a whole, because at least one dock has no figure to contribute.
  const froms = docs.map((c) => s(c.monthsFrom)).filter(Boolean);
  const monthsFrom = froms.length === docs.length && froms.length ? froms.reduce((a, b) => (a > b ? a : b)) : null;
  // No dock has ever been counted → the tally is ABSENT. Not zero.
  const counted = docs.some((c) => c.months && Object.keys(c.months).length > 0);

  const months = monthsOfYear(year, today).map((m) => {
    const bucket = { month: m, label: monthLabel(m), stops: 0, delivered: 0, attempted: 0, exceptions: 0 };
    let any = false;
    for (const c of docs) {
      const b = c.months?.[m];
      if (!b) continue;
      any = true;
      bucket.stops += b.stops || 0;
      bucket.delivered += b.delivered || 0;
      bucket.attempted += b.attempted || 0;
      bucket.exceptions += b.exceptions || 0;
    }
    // A month BEFORE the tally started is uncounted; a month at or after it with no bucket is
    // a real zero — we were genuinely not there. The screen draws those two differently.
    const uncounted = !any && (!monthsFrom || m < s(monthsFrom).slice(0, 7));
    return { ...bucket, uncounted };
  });

  const totals = months.filter((m) => !m.uncounted).reduce((t, m) => ({
    stops: t.stops + m.stops,
    delivered: t.delivered + m.delivered,
    attempted: t.attempted + m.attempted,
    exceptions: t.exceptions + m.exceptions,
  }), { stops: 0, delivered: 0, attempted: 0, exceptions: 0 });

  // The driver tally is whole-history on the rollup, not per-year — so it is labelled that way
  // rather than being silently presented as this year's. Summed across docks.
  const byDriver = new Map();
  for (const c of docs) {
    for (const [driver, v] of Object.entries(c.drivers || {})) {
      const cur = byDriver.get(driver) || { driver, stops: 0, delivered: 0 };
      cur.stops += v?.stops || 0;
      cur.delivered += v?.delivered || 0;
      byDriver.set(driver, cur);
    }
  }

  const busiest = months.filter((m) => !m.uncounted && m.stops > 0)
    .reduce((a, m) => (!a || m.stops > a.stops ? m : a), null);

  return {
    year,
    counted,
    monthsFrom,
    // TRUE only when the tally covers the whole year on screen. The screen says "counted since
    // <date>" rather than letting a partial year read as a full one.
    wholeYear: counted && !!monthsFrom && s(monthsFrom) <= `${year}-01-01`,
    uncountedMonths: months.filter((m) => m.uncounted).length,
    months,
    totals,
    busiest,
    drivers: [...byDriver.values()].sort((a, b) => b.delivered - a.delivered || b.stops - a.stops || a.driver.localeCompare(b.driver)),
    locations: docs.map((c) => ({
      matchKey: c.matchKey || null,
      address: addressOf(c),
      lastDate: s(c.lastDate) || null,
      stops: Object.values(c.months || {}).reduce((n, b) => n + (b?.stops || 0), 0),
    })).sort((a, b) => b.stops - a.stops),
    // THE ORDERS THEMSELVES, so the year is not a dead end.
    //
    // Chad: "You can't click on the order." The first cut of the year showed counts and
    // nothing else — a rep who got there and then needed an order number had to go back and
    // pick a different window to find one. These are the rollup's own PROs, already in the
    // documents this view reads, each carrying its day and its driver: free, and enough to
    // open any of them. Capped per dock by MAX_PROS upstream, which is why the screen says
    // plainly that it is the most recent rather than all of them.
    orders: docs
      .flatMap((c) => (c.pros || []).map((p) => ({
        pro: s(p?.pro), date: s(p?.date), driver: s(p?.driver) || null,
        location: s(c.addr1) || null,
      })))
      .filter((p) => p.pro && p.date && p.date.slice(0, 4) === year)
      .sort((a, b) => b.date.localeCompare(a.date) || a.pro.localeCompare(b.pro)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ONE ORDER, EVERYTHING ON IT — what a rep needs once they have found it
// ═══════════════════════════════════════════════════════════════════════════
//
// Chad, on the first cut of the customer view: "You can't click on the order. You can't get
// any details on each order or the customer."
//
// WHAT THE FIRST CUT GOT WRONG, precisely. The customer sweep reads a MASKED stop, because it
// touches a whole board per day and has to stay lean — so the line items, the delivery
// instructions, the comment trail and the on-order contact are deliberately NOT in it. That
// is the right call for a sweep and the wrong place to stop: a rep who has found the order
// then has nothing to tell the customer beyond a status word and a time.
//
// So the detail is a SEPARATE targeted read of the one stop, unmasked, and this turns that
// record into the answers to the questions actually asked on the phone:
//
//   "where is it"            → the timeline: window, ETA, arrived, delivered
//   "who brought it"         → driver, route, stop sequence, load
//   "what was on it"         → pieces, pallets, weight, AND the line items
//   "prove you delivered it" → the POD documents
//   "what does my PO say"    → every reference number the order carries
//   "why was it refused"     → the delivery instructions and the comment trail
//   "who do I call"          → the contact ON THE ORDER, not just the customer note

/** Best-effort read of an execution timestamp — the field is on the stop on most days and in
 *  the raw execution block on others, which is exactly why App.jsx has its own accessor for
 *  it. Missing in silence on a screen whose job is saying when we were there is the failure
 *  worth probing two places for. */
function execTime(stop, key) {
  const exec = stop?.raw?.stopExecutionInfo || {};
  return s(stop?.[key]) || s(exec?.to?.[key]) || s(exec?.[key]) || null;
}

/** PURE: one line item, in the words on the paperwork. */
function lineItem(d) {
  const id = d?.productIdentifier;
  return {
    product: s(d?.product) || null,
    sku: typeof id === 'string' ? id : (s(id?.value) || s(id?.id) || null),
    qty: numOrNull(d?.quantity ?? d?.qty ?? d?.pieces),
    weight: numOrNull(d?.weight),
    length: numOrNull(d?.length ?? d?.criticalDimension),
    // NuVizz's own oversize flag — a rep telling a customer "it needs a liftgate" is reading
    // this, so it is surfaced rather than folded into a piece count.
    oversize: s(d?.productCategory).toUpperCase() === 'L',
  };
}

/** PURE: the comment trail, newest first, with who said it and when. */
function comments(stop) {
  const raw = Array.isArray(stop?.allComments) ? stop.allComments : [];
  return raw
    .map((c) => ({
      text: s(c?.comment ?? c?.text ?? c?.note),
      by: s(c?.userName ?? c?.author ?? c?.createdBy) || null,
      at: s(c?.createdTime ?? c?.commentDTTM ?? c?.at) || null,
      kind: s(c?.commentType ?? c?.type) || null,
    }))
    .filter((c) => c.text)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/**
 * PURE: one stop record → the order detail a rep reads down the phone.
 *
 * `source` is 'sealed' or 'board' and rides on the answer rather than being flattened away:
 * the seal cannot change again, while a board copy is live and a delivery time read off it
 * may still move. A rep quoting a time should be able to see which kind they are quoting.
 */
export function buildOrderDetail(stop, { date, today, source = 'sealed' } = {}) {
  const st = stop || {};
  const status = s(st.normalizedStatus) || null;
  const isAttempt = st.isAttempt === true || /^ATT/i.test(s(st.shipmentNbr));
  const pros = Array.isArray(st.pros) && st.pros.length
    ? st.pros.map((p) => s(typeof p === 'string' ? p : (p?.pro ?? p))).filter(Boolean)
    : [s(st.pro) || s(st.primaryPro) || s(st.stopNbr)].filter(Boolean);

  const delivered = s(st.deliveredDTTM) || execTime(st, 'deliveredDTTM');
  const arrived = s(st.arrivalDTTM) || execTime(st, 'arrivalDTTM');

  return {
    date: s(date),
    source,
    stopNbr: s(st.stopNbr) || null,
    pro: s(st.pro) || s(st.primaryPro) || s(st.stopNbr) || null,
    pros,
    name: s(st.businessName) || null,
    address: addressOf(st),
    status,
    outcome: dayOutcome({ status, isAttempt, date: s(date), today: s(today), laterDay: false }),
    rawStatus: s(st.status) || null,

    // ── when ────────────────────────────────────────────────────────────────
    // Every stamp the record holds, in the order they happen, so a rep can say where it is
    // rather than only whether it is done.
    timeline: [
      { key: 'scheduled', label: 'Delivery window', at: null,
        text: [s(st.scheduledFrom), s(st.scheduledTo)].filter(Boolean).join(' – ') || null },
      { key: 'eta', label: 'Planned ETA', at: s(st.plannedEtaDTTM) || null },
      { key: 'arrived', label: 'Driver arrived', at: arrived || null },
      { key: 'delivered', label: 'Delivered', at: delivered || null },
    ].filter((r) => r.at || r.text),
    deliveredAt: delivered || null,
    arrivedAt: arrived || null,

    // ── who ─────────────────────────────────────────────────────────────────
    driver: s(st.driverName) || s(st.driverUserName) || null,
    driverUserName: s(st.driverUserName) || null,
    route: s(st.routeName) || null,
    loadNbr: s(st.loadNbr) || null,
    seq: numOrNull(st.loadStopSeq ?? st.routeSeq),
    planned: st.isPlanned === true,

    // ── what ────────────────────────────────────────────────────────────────
    pieces: numOrNull(st.cartons) ?? numOrNull(st.volume),
    pallets: numOrNull(st.pallets),
    weight: numOrNull(st.weight),
    itemsSummary: s(st.itemsSummary) || null,
    lines: (Array.isArray(st.stopDetails) ? st.stopDetails : []).map(lineItem).filter((l) => l.product || l.sku || l.qty),

    // ── the numbers a customer quotes ───────────────────────────────────────
    refs: [
      ['PO', s(st.poRef)], ['BOL', s(st.bol)], ['Customer ref', s(st.custRef)],
      ['Order', s(st.orderNbr)], ['Shipment', s(st.shipmentNbr)],
      ['Warehouse', s(st.warehouse)], ['Terms', s(st.terms)], ['Account', s(st.customerAccount)],
    ].filter(([, v]) => v).map(([k, v]) => ({ label: k, value: v })),

    // ── proof ───────────────────────────────────────────────────────────────
    // THE CUSTOMER-SERVICE ARTEFACT. "Prove you delivered it" is the call this screen exists
    // for, and the record carries the document metadata even though the bytes live elsewhere.
    pod: (Array.isArray(st.podDocs) ? st.podDocs : []).map((d) => ({
      name: s(d?.documentName) || null,
      ext: s(d?.extension) || null,
      at: s(d?.createdTime) || null,
    })),

    // ── what the driver was told, and what came back ────────────────────────
    instructions: s(st.orderInstructions) || s(st.signalSources?.orderInstructions) || null,
    comments: comments(st),

    // ── who to call about THIS order ────────────────────────────────────────
    contact: st.contact && (st.contact.name || st.contact.phone || st.contact.email)
      ? { name: s(st.contact.name) || null, phone: s(st.contact.phone) || null, email: s(st.contact.email) || null }
      : null,
    matchKey: s(st.customerMatchKey) || null,
    capturedAt: s(st.captured_at) || null,
  };
}
