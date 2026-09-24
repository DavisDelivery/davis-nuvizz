// test/customer-notes-edit.test.mjs — EDITING A CUSTOMER FROM THE STOP LOOKUP SCREEN.
//
// Chad, 2026-09-21: "make it where i can edit the details abbout this customer."
//
// Two halves, because the failure modes are in two places.
//
// THE ENDPOINT half runs for real against the Firestore fake. What it pins is that the
// screen is handed the EXACT document id each dock's note lives at, derived server-side. A
// live board row carries no customerMatchKey at all (lib/customer-key.mts was written after
// an alert read 778 rows with matchKey null on every one and called it a clean day), so a
// browser re-deriving the key would be deriving it from fields it may not have — and a note
// written to the wrong id is not a bug anyone notices, it is a note nothing ever reads again.
//
// THE CLIENT half is source-text, the same trade stop-lookup-wiring.test.mjs makes and for
// the same reason: the layout guards drive the real bundle in a browser and would catch a
// missing button, but they need a build, a Chromium and ~6 minutes in a different CI job.
// These run in milliseconds and name the exact line that has to be there. What they pin is
// the handful of properties that are invisible when they break — a merge write that became a
// blind one, a "Saved" printed off an intent rather than an outcome, an editor seeded from a
// copy read minutes ago.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { notesSummary, whenIso } from '../src/lib/stop-lookup.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
// THE CODE, WITHOUT THE 800 LINES OF CHANGELOG ABOVE IT. Every COUNT below runs against this
// rather than APP: a row that quotes a line of code is not a copy of it, and a count that a
// changelog entry can break is a count that gets edited instead of investigated.
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
const FN = readFileSync(new URL('../netlify/functions/stop-lookup.mts', import.meta.url), 'utf8');

const T = 'davis';
const URL_BASE = 'https://x.netlify.app/.netlify/functions/stop-lookup';
const call = async (qs) => {
  const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
  return (await handler(new Request(`${URL_BASE}?${qs}`))).json();
};

// The two real docks this customer has, and the two customer_notes ids they key to. Written
// out as literals on purpose: asserting against normalizeMatchKey() would pass even if the
// derivation changed under us, which is the one thing that would break every stored note.
const WENDELL = 'earthly_alternative__4200_wendell_dr_sw__atlanta__30336';
const NORTHSIDE = 'earthly_alternative__1175_northside_dr_nw_ste_100__atlanta__30318';

const dockRow = (over = {}) => ({
  businessName: 'EARTHLY ALTERNATIVE', addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336',
  normalizedStatus: 'DELIVERED', isPlanned: true, ...over,
});
const northsideRow = (over = {}) => dockRow({ addr1: '1175 NORTHSIDE DR NW STE 100', zip: '30318', ...over });

// A minimal ARRAY_CONTAINS runQuery over the fake's store, so the name door is genuinely
// exercised rather than erroring into a pass. Same shape as stop-lookup-endpoint.test.mjs.
const enc = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  return { stringValue: String(v) };
};
function installFakeWithQuery(seed) {
  const holder = {};
  const fake = installFirestoreFake(seed, (url, init) => {
    if (!url.includes(':runQuery')) throw new Error(`unexpected non-Firestore fetch: ${url}`);
    const q = JSON.parse(String(init.body)).structuredQuery;
    const coll = q.from?.[0]?.collectionId;
    const f = q.where?.fieldFilter;
    const rows = [...holder.store.entries()]
      .filter(([k]) => k.startsWith(`${coll}/`) && k.slice(coll.length + 1).split('/').length === 1)
      .filter(([, v]) => {
        if (!f) return true;
        const field = v?.[f.field.fieldPath];
        return f.op === 'ARRAY_CONTAINS' && Array.isArray(field) && field.includes(f.value.stringValue);
      })
      .map(([k, v]) => ({ document: { name: `projects/testproj/databases/(default)/documents/${k}`, fields: Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, enc(vv)])) } }));
    return new Response(JSON.stringify(rows), { status: 200 });
  });
  holder.store = fake.store;
  return fake;
}

// ── THE ENDPOINT: which docks, and which document each one edits ──────────────

test('TWO DOCKS COME BACK AS TWO, each with the exact customer_notes id it edits', async () => {
  // This is the logistics half of the feature, pinned. Receiving hours belong to an ADDRESS,
  // not to a company: Earthly Alternative closes at different times on Wendell Drive and on
  // Northside. One "Edit this customer" button would let a rep put one dock's closing time on
  // the other, which is a truck at a door that shut two hours earlier.
  const day = '2026-09-18';
  const fake = installFakeWithQuery({
    [`history_days/${T}__${day}/stops/AAA`]: dockRow({ stopNbr: 'AAA', pro: 'AAA', date: day }),
    [`history_days/${T}__${day}/stops/BBB`]: northsideRow({ stopNbr: 'BBB', pro: 'BBB', date: day }),
  });
  try {
    const body = await call(`name=earthly%20alternative&from=${day}&to=${day}`);
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'customer');
    assert.equal(body.nuvizzCalls, 0);
    const keys = body.docks.map((d) => d.key).sort();
    assert.deepEqual(keys, [NORTHSIDE, WENDELL].sort(), 'both docks, by their real document ids');
    const wendell = body.docks.find((d) => d.key === WENDELL);
    // The address rides along so the panel can NAME the dock above the fields. A rep who
    // thinks they are editing "the customer" sets the wrong door's hours.
    assert.equal(wendell.name, 'EARTHLY ALTERNATIVE');
    assert.equal(wendell.addr1, '4200 WENDELL DR SW');
    assert.equal(wendell.city, 'ATLANTA');
    assert.equal(wendell.zip, '30336');
  } finally { fake.restore(); }
});

test('noteKey NAMES THE DOCK THE NOTE ON SCREEN CAME FROM — not just "there is a note"', async () => {
  // The card shows ONE note beside a customer-wide answer. With two docks, a rep looking at
  // "closes 3pm" has to be able to tell which door that is about before repeating it.
  const day = '2026-09-18';
  const fake = installFakeWithQuery({
    [`history_days/${T}__${day}/stops/AAA`]: dockRow({ stopNbr: 'AAA', pro: 'AAA', date: day }),
    [`history_days/${T}__${day}/stops/BBB`]: northsideRow({ stopNbr: 'BBB', pro: 'BBB', date: day }),
    // Only the NORTHSIDE dock has anything written about it.
    [`customer_notes/${NORTHSIDE}`]: { match_key: NORTHSIDE, notes: 'Ring the bell at the back door.' },
  });
  try {
    const body = await call(`name=earthly%20alternative&from=${day}&to=${day}`);
    assert.equal(body.noteKey, NORTHSIDE);
    assert.equal(body.view.notes.text, 'Ring the bell at the back door.');
    assert.ok(body.docks.some((d) => d.key === WENDELL), 'the dock with no note is still offered');
  } finally { fake.restore(); }
});

test('NO NOTE ANYWHERE still returns the docks — the customer with nothing on file is the point', async () => {
  // The card used to render only when a note existed, so the customer a rep most needed to
  // write receiving hours for was the exact customer with no way to. `docks` is what lets the
  // card offer "Add details" on an empty one.
  const day = '2026-09-18';
  const fake = installFakeWithQuery({
    [`history_days/${T}__${day}/stops/AAA`]: dockRow({ stopNbr: 'AAA', pro: 'AAA', date: day }),
  });
  try {
    const body = await call(`name=earthly%20alternative&from=${day}&to=${day}`);
    assert.equal(body.noteKey, null, 'no note is null, not a guess at one');
    assert.deepEqual(body.docks.map((d) => d.key), [WENDELL], 'and the dock is still editable');
  } finally { fake.restore(); }
});

test('A CUSTOMER WITH NO STOP IN THE WINDOW OFFERS NO DOCK, rather than a made-up one', async () => {
  // Found through the rollup alone: there is no board or sealed row to derive an address from,
  // so there is no dock whose hours we could honestly claim to be editing. Empty, not guessed.
  const day = '2026-09-18';
  const fake = installFakeWithQuery({
    [`history_customers/${T}__${WENDELL}`]: {
      match_key: WENDELL, tenant: T, name: 'EARTHLY ALTERNATIVE', name_lower: 'earthly alternative',
      name_tokens: ['earthly', 'alternative'], addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336',
      pros: [{ pro: '007100077', date: '2026-07-14', driver: 'FRANK OKINE' }], last_date: '2026-07-14',
    },
  });
  try {
    const body = await call(`name=earthly%20alternative&from=${day}&to=${day}`);
    assert.equal(body.ok, true);
    assert.deepEqual(body.docks, []);
    assert.equal(body.noteKey, null);
  } finally { fake.restore(); }
});

test("AN ORDER'S OWN PAGE CARRIES THE SERVER'S matchKey, so it can edit that dock too", async () => {
  const day = '2026-09-18';
  const fake = installFirestoreFake({
    [`history_pros/${T}__n_7100077`]: { key: 'n_7100077', pro: '007100077', days: [{ date: day, pro: '007100077', matchKey: WENDELL, name: 'EARTHLY ALTERNATIVE' }] },
    [`history_days/${T}__${day}/stops/007100077`]: dockRow({ stopNbr: '007100077', pro: '007100077', date: day, deliveredDTTM: `${day}T14:19` }),
  });
  try {
    const body = await call('stop=007100077');
    assert.equal(body.ok, true);
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(body.matchKey, WENDELL, 'the derived key, resolved off the record that carried one');
  } finally { fake.restore(); }
});

test('matchKey is null on a genuine miss, never an empty string the screen would treat as a key', () => {
  // `matchKey: matchKey || null` — '' is falsy and would otherwise ride out as a document id,
  // and `customer_notes/` is a collection, not a document.
  assert.match(FN, /matchKey: matchKey \|\| null,/);
});

test('the docks are derived, never read off a stored field', () => {
  // lib/customer-key.mts derives name+addr1+city+zip and accepts a stored key only as a
  // fallback. The endpoint must go through it rather than reading `stop.matchKey`, which the
  // live board does not carry.
  const block = FN.slice(FN.indexOf('const dockByKey'), FN.indexOf('const [rollupsR, notesR]'));
  assert.match(block, /stopCustomerKey\(r\.stop\)/);
  assert.doesNotMatch(block, /r\.stop\?\.(matchKey|customerMatchKey)/);
});

// ── THE CLIENT: the properties that are invisible when they break ─────────────

const SAVE = APP.slice(APP.indexOf('const saveEdit = useCallback'), APP.indexOf('/** The rep picked one of several matching businesses. */'));
const OPEN = APP.slice(APP.indexOf('const openEdit = useCallback'), APP.indexOf('const cancelEdit = useCallback'));
const PANEL = APP.slice(APP.indexOf('function CustomerNotesEditPanel'), APP.indexOf('/** The rest of this customer'));
const CARD = APP.slice(APP.indexOf('function StopNotesCard'), APP.indexOf('/** EDITING THE CUSTOMER, FROM THE SCREEN THE CALL IS ON.'));

test('THE SAVE IS FIELD-MASKED — a blind write here takes the receiving hours with it', () => {
  // customer_notes also carries the pin override, the comms opt-out, the address override and
  // pro_history, none of which this form shows. CLAUDE.md, in as many words: never blind-write
  // a document you do not own. setDoc REPLACES without this.
  assert.match(SAVE, /setDoc\(ref, \{[\s\S]*?\}, \{ merge: true \}\)/);
});

test('IT READS THE DOCUMENT BACK BEFORE IT SAYS SAVED', () => {
  // A write that resolved is not the same as a document that changed. This repo has already
  // shipped an intent reported as an outcome twice — a hardcoded "✅ routed to Google" and a
  // "I flipped the switch" said about a call that returned 502.
  assert.match(SAVE, /const fresh = await getDoc\(ref\);/);
  assert.match(SAVE, /if \(!fresh\.exists\(\)\) throw new Error\(/);
  // …and the card is repainted from what Firestore returned, through the SAME summariser the
  // endpoint uses, rather than from the draft we hoped we wrote.
  assert.match(SAVE, /notesSummary\(fresh\.data\(\)\)/);
  // BOTH CARDS. The note hangs off `view` in customer mode and off `dossier` in stop mode,
  // and this save is reachable from both — patching only the first leaves an order's page
  // showing the pre-save note after a save it just called successful.
  assert.match(SAVE, /if \(cur\.view\) return \{ \.\.\.cur, noteKey: key, view: \{ \.\.\.cur\.view, notes: summary \} \};/);
  assert.match(SAVE, /if \(cur\.dossier\) return \{ \.\.\.cur, dossier: \{ \.\.\.cur\.dossier, notes: summary \} \};/);
});

test('THE EDITOR OPENS ON A FRESH READ, not the copy the lookup fetched minutes ago', () => {
  // Seeding the form from the response and saving that hands back whatever was on screen at
  // read time — so a colleague's edit in between is silently undone.
  assert.match(OPEN, /await getDoc\(doc\(db, 'customer_notes', dock\.key\)\)/);
  assert.match(OPEN, /snap\.exists\(\) \? \{ \.\.\.base, \.\.\.snap\.data\(\) \} : base/);
});

test('the form is seeded from emptyNote FIRST, so every time input stays controlled', () => {
  // emptyNote's shape is seven days of { open, close } strings. A form seeded from a partial
  // document loses that on the first keystroke and React starts warning about a controlled
  // input becoming uncontrolled — on the exact customer who has never had an hour written.
  assert.match(OPEN, /const base = emptyNote\(\{/);
});

test('THE WRITE IS DOCK-SCOPED — it goes to the key that was clicked, nowhere else', () => {
  assert.match(SAVE, /const key = editDock\.key;/);
  assert.match(SAVE, /const ref = doc\(db, 'customer_notes', key\);/);
  assert.match(SAVE, /match_key: key,/);
});

test('A NEW SEARCH CLOSES THE EDITOR — carrying it across is one dock typed onto another', () => {
  const run = APP.slice(APP.indexOf('const run = useCallback(async (raw, opts = {})'), APP.indexOf('const openEdit = useCallback'));
  assert.match(run, /setEditDock\(null\); setEditDraft\(null\); setEditWas\(null\); setEditErr\(null\);/);
});

test('it is gated at dispatcher, the same as the Map’s copy of this save', () => {
  // These fields drive the flag engine and the alert texts. A wrong receiving hour is louder
  // than a missing one.
  assert.match(APP, /const notesGate = useRoleGate\('dispatcher'\);/);
  assert.match(OPEN, /if \(notesGate\.reason\) \{ setEditErr\(notesGate\.reason\); return; \}/);
  assert.match(SAVE, /if \(notesGate\.reason\) \{ setEditErr\(notesGate\.reason\); return; \}/);
  // …and a reader who may not write is told so beside the card, not handed a button that fails.
  assert.match(APP, /onEdit=\{notesGate\.reason \? null : openEdit\} editReason=\{notesGate\.reason\}/);
});

test('A BUILD WITH NO DATABASE REFUSES SAVE IN WORDS, rather than failing silently', () => {
  // firebase.js makes `db` null on purpose when the env is absent (preview builds, the layout
  // guards). The comment there is "a visible dead control is the safe direction".
  assert.match(OPEN, /if \(!db\) \{ setEditDraft\(base\); setEditWas\(null\); return; \}/);
  assert.match(SAVE, /if \(!db\) throw new Error\('Firestore is not configured in this build\.'\);/);
  assert.match(PANEL, /const notice = !canSave && \(/);
  assert.match(PANEL, /disabled=\{saving \|\| !canSave\}/);
  // …and the notice travels with the actions: the foot of the form below xl, the rail at xl.
  assert.equal((PANEL.match(/\{notice\}/g) || []).length, 2);
  assert.match(APP, /canSave=\{!!db\}/);
});

test('a refused WRITE says write — a dispatcher told "read denied" looks in the wrong place', () => {
  assert.match(SAVE, /reportDenied\('customer_notes', e, 'write'\)/);
  assert.match(OPEN, /reportDenied\('customer_notes', e\)/);
});

test('IT IS THE MAP’S OWN EDITOR, NOT A SECOND ONE OVER THE SAME DOCUMENT', () => {
  // Two editors over customer_notes are two things that drift, and one of them then writes
  // the hours the flag engine reads.
  assert.match(PANEL, /<StopNotesEditor draft=\{draft\}/);
  // One definition of it in the file, so this really is the Map's.
  assert.equal((CODE.match(/function StopNotesEditor\b/g) || []).length, 1);
});

test('the panel is INLINE and capped — not a drawer, and not a 700-pixel box holding "08:00"', () => {
  // v1.52.0's rule, and SCREEN_FORM's, arriving from the same direction: a form wants a column.
  assert.match(PANEL, /role="region" aria-label="Edit customer details"/);
  assert.doesNotMatch(PANEL, /createPortal|fixed inset-0/);
  assert.match(PANEL, /className="w-full max-w-2xl"/);
  // The dock is named IN FULL above the fields.
  assert.match(PANEL, /Editing this dock/);
});

test('THE CARD NO LONGER HIDES ITSELF WHEN THERE IS NOTHING ON FILE', () => {
  // It returned null the moment there was no note. The customer we have never written
  // receiving hours for was the one customer with no way to add them.
  assert.match(CARD, /if \(!has && !\(onEdit && dockList\.length\)\) return null;/);
  assert.match(CARD, /\{hasNote \? 'Edit' : 'Add details'\}/);
});

test('THE EMPTY STATE KEYS OFF THE NOTE, NOT THE ADDRESS LIST — v1.53.0 got this wrong and nothing caught it', () => {
  // The address list is drawn from the STOPS, and in customer mode there are always stops.
  // Folding it into the has-anything test meant "Nothing on file yet" and "Add details" were
  // dead code from the day they shipped: two docks and no note rendered a bare card and an
  // "Edit" that implied something was there. Found by rendering it and looking, not by a test
  // — so here is the test.
  assert.match(CARD, /const hasNote = !!\(notes\?\.text \|\| notes\?\.flags\?\.length \|\| notes\?\.contacts\?\.length \|\| hours \|\| notes\?\.customerNbr\);/);
  assert.match(CARD, /const has = hasNote \|\| \(locations \|\| \[\]\)\.length;/);
  assert.match(CARD, /\{!hasNote && <div className="text-xs text-slate-500">Nothing on file/);
  // The grey "2 docks — edit one below" sat 1,400px from the title on a monitor; the dock
  // list's own heading says it, so the header says nothing for the multi-dock case.
  assert.doesNotMatch(CARD, /edit one below/);
});

test('"NOTE SAVED …" RENDERS ON A REAL DOCUMENT — last_updated, in every shape it arrives in', () => {
  // Every writer of customer_notes writes `last_updated`; notesSummary read `updated_at`, so
  // the footer had never rendered on production data, and the fixture's `updatedAt` hid it in
  // every screenshot. The read-back after a save hands back a client-SDK Timestamp, the
  // endpoint's REST decoder hands back an ISO string; both have to become one ISO string.
  const iso = '2026-09-16T15:20:00.000Z';
  assert.equal(notesSummary({ last_updated: '2026-09-16T15:20:00Z' }).updatedAt, '2026-09-16T15:20:00Z', 'REST: an ISO string passes through');
  assert.equal(notesSummary({ last_updated: { toDate: () => new Date(iso) } }).updatedAt, iso, 'client SDK: a Timestamp');
  assert.equal(notesSummary({ last_updated: { seconds: Date.parse(iso) / 1000 } }).updatedAt, iso, 'a bare { seconds } map');
  assert.equal(notesSummary({ last_updated: { _seconds: Date.parse(iso) / 1000 } }).updatedAt, iso, 'the underscored spelling');
  assert.equal(notesSummary({ last_updated: new Date(iso) }).updatedAt, iso, 'a Date');
  // last_updated WINS — it is the field the writers write; the others are legacy spellings.
  assert.equal(notesSummary({ last_updated: '2026-09-16T15:20:00Z', updatedAt: '2020-01-01T00:00:00Z' }).updatedAt, '2026-09-16T15:20:00Z');
  assert.equal(notesSummary({ updatedAt: '2020-01-01T00:00:00Z' }).updatedAt, '2020-01-01T00:00:00Z', 'the fixture spelling still works');
  // MALFORMED IS NULL, NEVER "Invalid Date" ON A CARD.
  for (const bad of [undefined, null, '', 'yesterday-ish', {}, { seconds: 'x' }, { seconds: 0 }, new Date(NaN), 42, { toDate: () => 'nope' }]) {
    assert.equal(whenIso(bad), null, `whenIso(${JSON.stringify(bad)}) must be null`);
  }
  assert.equal(notesSummary({ last_updated: 'yesterday-ish' }).updatedAt, null);
  assert.equal(notesSummary({}).updatedAt, null);
});

test('THE ACTIONS RENDER ONCE PER BREAKPOINT — the foot of the form below xl, a sticky rail at xl', () => {
  // v1.53.0 on a 1600px monitor: a 672px form in the left corner of a 1,552px box, 880px of
  // white, Cancel 880px from the fields, Save 1,300px down a 1,000px screen. The width is a
  // rail now, and Save/Cancel exist exactly once at any given width.
  assert.match(PANEL, /const actions = \(/);
  assert.equal((PANEL.match(/\{actions\}/g) || []).length, 2, 'foot of the form + the rail');
  assert.match(PANEL, /<div className="xl:hidden space-y-3 border-t pt-3 max-w-2xl">/, 'the foot hides at xl');
  assert.match(PANEL, /<aside className="hidden xl:block xl:sticky xl:top-4/, 'the rail shows only at xl, and sticks');
  assert.match(PANEL, /className="xl:hidden shrink-0 rounded-lg border px-3 min-h-\[44px\]/, 'the title-line Cancel hides at xl too');
  assert.match(PANEL, /xl:grid xl:grid-cols-\[minmax\(0,42rem\)_minmax\(16rem,22rem\)\]/, 'the form column stays capped at 42rem');
  // A rep's sentence, not an engineer's.
  assert.match(PANEL, /Applies to this address only\./);
  assert.doesNotMatch(PANEL, /read back before it says saved/);
});

test('ON A MONITOR THE EDIT BUTTON SITS BESIDE THE ADDRESS IT EDITS, and an email is not split at its first letter', () => {
  assert.match(CARD, /text-\[11px\] text-slate-600 break-words min-w-0 flex-1 xl:flex-none xl:max-w-2xl/);
  // break-all rendered "r / eceiving@…" on a phone; break-words moves the whole address down.
  assert.match(CARD, /mailto:\$\{c\.email\}`\} className="text-blue-800 hover:underline break-words"/);
  assert.doesNotMatch(CARD, /break-all/);
});

test('MORE THAN ONE DOCK IS EDITED ONE AT A TIME, and the note says which dock it is about', () => {
  assert.match(CARD, /onEdit && dockList\.length > 1 \?/);
  assert.match(CARD, /dk\.key === noteKey && <span[^>]*>· the note above<\/span>/);
  // Each row's Edit carries THAT dock, not the first one.
  assert.match(CARD, /onClick=\{\(\) => onEdit\(dk\)\}/);
});

test("AN ORDER'S PAGE EDITS WITH THE SERVER'S KEY, never one the browser re-derives", () => {
  // The board carries no customerMatchKey, so a re-derivation would have nothing to derive
  // from on exactly the orders that are still live — and would write a note nothing reads.
  const order = APP.slice(APP.indexOf('<StopNotesCard notes={d.notes}'), APP.indexOf('<StopCustomerCard customer={d.customer}'));
  assert.match(order, /data\.matchKey \|\| d\.identity\?\.matchKey/);
  assert.doesNotMatch(order, /normalizeMatchKey|stopCustomerKey/);
});

test('both views mount the editor, phone and desktop alike', () => {
  // Mobile and desktop are two views. A control added to one and not the other is a control
  // that does not exist on a phone — this file has shipped that way twice.
  assert.equal((CODE.match(/<CustomerNotesEditPanel dock=\{editDock\}/g) || []).length, 2,
    'the customer view and the order view each mount it');
});

test('BOTH LAYOUT GUARDS DRIVE THE OPEN EDITOR, and the fixture gives them two docks to do it with', () => {
  // A form is the surface most likely to collide on a phone — seven rows of two time inputs,
  // and this one drops into a list rather than a dedicated screen. A guard that measured this
  // screen at rest would prove nothing about it. The multi-dock branch is the one measured on
  // purpose: it puts a button and a wrapping address on the same line at 360px.
  for (const f of ['verify-mobile-layout.mjs', 'verify-tablet-layout.mjs']) {
    const src = readFileSync(new URL(`../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /editing a customer dock/, `${f} must probe the open editor`);
    assert.match(src, /editing this dock/i, `${f} must PROVE the editor opened, not just that it clicked`);
  }
  const fx = readFileSync(new URL('../scripts/lib/customer-view-fixture.mjs', import.meta.url), 'utf8');
  assert.match(fx, /docks: \[/);
  assert.match(fx, /noteKey: '/);
  const head = fx.slice(fx.indexOf('export const CUSTOMER_VIEW'), fx.indexOf("window: { from: '2026-09-12'"));
  assert.equal((head.match(/\bkey: '/g) || []).length, 2, 'two docks, or the per-dock branch never renders');
});

test('THE VEHICLE MARK CANNOT BE MOVED FROM HERE WITHOUT LEAVING A TRACE', () => {
  // The shared editor carries the three-state vehicle picker, so a save from Stop lookup can
  // set or clear a HARD capacity block: routing-build forces the stop onto a box truck and
  // dispatcherTrailerBlock raises the trailer conflict, for every future stop at that address.
  // This save shipped in draft WITHOUT the stamp — the guard count in
  // vehicle-eligibility-editor.test.mjs is what caught it, and only because all three copies
  // now spell it the same way.
  assert.match(SAVE, /\.\.\.\(eligibilityChanged\(draft, existing\)\n\s*\? \{ vehicle_eligibility_at: serverTimestamp\(\), vehicle_eligibility_by: 'dispatcher' \}\n\s*: \{\}\),/);
  // `existing` is the document as it stood WHEN THE FORM OPENED — read fresh at that moment,
  // not the lookup's copy — so "did this edit move it" is answered against the real prior state.
  assert.match(SAVE, /const existing = editWas;/);
  assert.match(OPEN, /setEditWas\(snap\.exists\(\) \? snap\.data\(\) : null\);/);
  // …and it is cleared everywhere the draft is, or the next dock is compared against the last
  // one's mark and a save stamps provenance on a decision nobody made.
  // Only StopLookupScreen holds this state, so counting across the file is counting its
  // five exits — and a sixth exit added without clearing it must move this number.
  // SIX since v1.62.0: an ADDRESS search is a new search too, and carries the editor away for the
  // same reason an order search does — a dock's hours typed onto whatever the next answer shows.
  assert.equal((CODE.match(/setEditWas\(null\)/g) || []).length, 6,
    'a new order search, a new address search, cancel, a failed read, the no-database path and a successful save');
});

test('MORE ADDRESSES THAN DOCKS IS SAID OUT LOUD, not silently shortened', () => {
  // `keys` stops at six to bound the Firestore reads, so `docks` is capped and `locations` is
  // not. The multi-dock branch REPLACES the address list — without this line, a customer with
  // eight docks in the window would show five of them and no sign the rest exist, and a rep
  // would repeat that count to the person on the phone.
  assert.match(CARD, /\(locations \|\| \[\]\)\.length > dockList\.length/);
  assert.match(CARD, /more address\{locations\.length - dockList\.length === 1 \? '' : 'es'\}/);
});
