// test/stop-lookup-endpoint.test.mjs — the GATHERING, run against the Firestore fake.
//
// stop-lookup.test.mjs pins what the documents mean. This pins that the endpoint actually
// FINDS them — across the three spellings of a PRO, across the sealed warehouse and the live
// board, and without ever touching NuVizz. The fake throws on any fetch that is not
// Firestore or the OAuth token endpoint, so `log.other` being empty is a proof, not a claim.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const T = 'davis';
const URL_BASE = 'https://x.netlify.app/.netlify/functions/stop-lookup';

const call = async (qs) => {
  const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
  return (await handler(new Request(`${URL_BASE}?${qs}`))).json();
};

const today = async () => (await import('../netlify/functions/lib/firestore.mts')).etDayString();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const sealedStop = (over = {}) => ({
  stopNbr: '007174397', pro: '007174397', businessName: 'LED ENERGY PLUS',
  customerMatchKey: 'led_energy_plus__5965_peachtree__norcross__30071',
  addr1: '5965 PEACHTREE CORS E STE B3', city: 'NORCROSS', state: 'GA', zip: '30071',
  routeName: 'NOR 2', loadNbr: 'DAVIS000203707', driverName: 'ENOCK AKYEA', driverUserName: 'ENOCK',
  loadStopSeq: 7, isPlanned: true, normalizedStatus: 'DELIVERED', deliveredDTTM: '2026-09-15T14:19',
  cartons: 4, weight: 860, ...over,
});

/** Seed, call, restore — and hand back the fake so a test can assert on what was READ. */
async function withStore(seed, qs) {
  const fake = installFirestoreFake(seed);
  try { return { body: await call(qs), fake }; } finally { fake.restore(); }
}

// ── the common path ───────────────────────────────────────────────────────────

test('a sealed delivery is found through the PRO index, and NOTHING calls NuVizz', async () => {
  const day = '2026-09-15';
  const { body, fake } = await withStore({
    [`history_pros/${T}__n_7174397`]: { key: 'n_7174397', pro: '007174397', days: [{ date: day, pro: '007174397', matchKey: 'led_energy_plus__5965_peachtree__norcross__30071', name: 'LED ENERGY PLUS' }] },
    [`history_days/${T}__${day}/stops/007174397`]: sealedStop({ date: day }),
  }, 'stop=007174397');

  assert.equal(body.ok, true);
  assert.equal(body.nuvizzCalls, 0);
  assert.equal(fake.log.other.length, 0, 'no non-Firestore call may be made');
  assert.equal(body.dossier.found, true);
  assert.equal(body.dossier.days.length, 1);
  assert.equal(body.dossier.days[0].date, day);
  assert.equal(body.dossier.days[0].outcome, 'delivered');
  assert.equal(body.dossier.days[0].driver, 'ENOCK AKYEA');
  assert.equal(body.dossier.identity.name, 'LED ENERGY PLUS');
});

test('THE BARE PRO A DISPATCHER TYPES REACHES THE ZERO-PADDED DOCUMENT NUVIZZ WROTE', async () => {
  // The paperwork says 7174397; the warehouse document is 007174397. If this misses, the
  // screen offers to spend a NuVizz call on an order sitting in our own Firestore — which is
  // the precise complaint that produced the PRO index in the first place.
  const day = '2026-09-15';
  const { body } = await withStore({
    [`history_pros/${T}__n_7174397`]: { days: [{ date: day, pro: '007174397' }] },
    [`history_days/${T}__${day}/stops/007174397`]: sealedStop({ date: day }),
  }, 'stop=7174397');
  assert.equal(body.dossier.found, true);
  assert.equal(body.dossier.days[0].refs.pro, '007174397');
});

test('a carrier-prefixed PRO resolves, and its digits are not read as somebody else’s order', async () => {
  const day = '2026-09-15';
  const { body } = await withStore({
    [`history_pros/${T}__r_AVRT-0170416694`]: { days: [{ date: day, pro: 'AVRT-0170416694' }] },
    [`history_days/${T}__${day}/stops/AVRT-0170416694`]: sealedStop({ stopNbr: 'AVRT-0170416694', pro: 'AVRT-0170416694', date: day, businessName: 'TITAN ELECTRIC' }),
  }, 'stop=avrt-0170416694');
  assert.equal(body.dossier.found, true);
  assert.equal(body.dossier.identity.name, 'TITAN ELECTRIC');
});

test("AN ORDER ON TODAY'S BOARD IS FOUND WITH NO POINTER AT ALL — today is never sealed", async () => {
  // The index is written by the nightly post-seal hook, so an order delivered this morning
  // has no pointer until tonight. An index-only lookup would answer "we have no record" about
  // the stop the dispatcher is looking at on their own screen.
  const d = await today();
  const { body } = await withStore({
    [`nuvizz_stop_index/${T}__${d}`]: { last_scanned_at: '2026-09-18T13:02:00Z' },
    [`nuvizz_stop_index/${T}__${d}/stops/007174397`]: sealedStop({ normalizedStatus: 'OUT_FOR_DEL', deliveredDTTM: null }),
  }, 'stop=007174397');
  assert.equal(body.dossier.found, true);
  assert.deepEqual(body.dossier.days[0].sources, ['board']);
  assert.equal(body.dossier.days[0].outcome, 'open');
  assert.equal(body.dossier.days[0].scannedAt, '2026-09-18T13:02:00Z', 'and it says when that copy was last scanned');
});

test('the sealed record WINS where both exist, and the day still reports both sources', async () => {
  const d = await today();
  const { body } = await withStore({
    [`history_pros/${T}__n_7174397`]: { days: [{ date: d, pro: '007174397' }] },
    [`history_days/${T}__${d}/stops/007174397`]: sealedStop({ date: d }),
    [`nuvizz_stop_index/${T}__${d}/stops/007174397`]: sealedStop({ normalizedStatus: 'SCHEDULED', driverName: 'SOMEBODY ELSE', deliveredDTTM: null }),
  }, 'stop=007174397');
  assert.equal(body.dossier.days[0].status, 'DELIVERED');
  assert.equal(body.dossier.days[0].driver, 'ENOCK AKYEA');
  assert.deepEqual(body.dossier.days[0].sources, ['sealed', 'board']);
});

test('an ATTEMPT day names the MORNING driver and the evening one separately', async () => {
  const d = await today();
  const { body } = await withStore({
    [`nuvizz_stop_index/${T}__${d}/stops/007174397`]: sealedStop({ normalizedStatus: 'SCHEDULED', deliveredDTTM: null, driverName: 'JOE NKRUMAH' }),
    [`att_plan/${T}__${d}/stops/007174397`]: { stopNbr: '007174397', driverName: 'ROBERT MENSAH', routeName: 'NOR 2', customerMatchKey: 'k' },
    [`attempts/${T}__${d}/items/007174397`]: { stopNbr: '007174397', originalDriverName: 'ROBERT MENSAH', currentDriverName: 'JOE NKRUMAH', shipmentNbr: 'ATT007174397' },
  }, 'stop=007174397');
  const row = body.dossier.days[0];
  assert.deepEqual(row.sources, ['board', 'plan', 'attempt']);
  assert.equal(row.outcome, 'attempted');
  assert.equal(row.driver, 'ROBERT MENSAH');
  assert.equal(row.currentDriver, 'JOE NKRUMAH');
});

// ── the other documents that hang off one stop ────────────────────────────────

test('the customer note, the customer rollup and the address log all arrive on the same answer', async () => {
  const d = await today();
  const key = 'led_energy_plus__5965_peachtree__norcross__30071';
  const { body } = await withStore({
    [`nuvizz_stop_index/${T}__${d}/stops/007174397`]: sealedStop(),
    [`customer_notes/${key}`]: { notes: 'Ring the bell at the side door', no_tractor: true, contacts: [{ name: 'RAY', phone: '7705551212' }] },
    [`history_customers/${T}__${key}`]: { name: 'LED ENERGY PLUS', match_key: key, pros: [{ pro: '007100000', date: '2026-06-02' }] },
    [`nuvizz_ops/addr_changes__${T}__${d}`]: {
      rowsJson: JSON.stringify([{ at: `${d}T11:00:00Z`, date: d, stopNbr: '007174397', kind: 'moved', source: 'scan', fields: ['addr1'], before: { addr1: '5965 PEACHTREE CORS E STE B3' }, after: { addr1: '5975 PEACHTREE CORS E' } }]),
    },
  }, 'stop=007174397');

  assert.equal(body.dossier.notes.text, 'Ring the bell at the side door');
  assert.deepEqual(body.dossier.notes.flags.map((f) => f.key), ['no_tractor']);
  assert.equal(body.dossier.notes.contacts[0].name, 'RAY');
  assert.equal(body.dossier.customer.pros.length, 1);
  assert.equal(body.dossier.addressChanges.length, 1);
  assert.equal(body.dossier.addressChanges[0].kind, 'moved');
});

test('the write journal shows what WE sent NuVizz about this order — and not a route-wide sync', async () => {
  // selectWriteRows also matches board-sync rows by ROUTE, which is right for stop-explain's
  // question and wrong for this one: a route-wide sync is not something we sent about THIS
  // order, and listing it answers "did we push this stop" with somebody else's write.
  const d = await today();
  const { body } = await withStore({
    [`nuvizz_stop_index/${T}__${d}/stops/007174397`]: sealedStop(),
    'nuvizz_write_ops/a': { at: `${d}T12:00:00Z`, op: 'planStops', status: 'ok', result: { loads: [{ loadNbr: 'DAVIS000203707', ok: true }], stops: ['007174397'] } },
    'nuvizz_write_ops/b': { at: `${d}T12:30:00Z`, op: 'boardSync', status: 'ok', result: { date: d, routeName: 'NOR 2', ordered: 30, unplanned: 0, patched: 30 } },
  }, 'stop=007174397');
  assert.equal(body.dossier.writes.length, 1);
  assert.equal(body.dossier.writes[0].op, 'planStops');
});

// ── the answer when there is no answer ────────────────────────────────────────

test('AN ORDER WE HOLD NOTHING FOR COMES BACK WITH THE LEDGER OF WHERE WE LOOKED', async () => {
  // The whole reason the source ledger exists. "Nothing found" and "the read failed" render
  // as the same blank screen otherwise, and only one of them is a reason to spend a call.
  const { body } = await withStore({}, 'stop=009999999');
  assert.equal(body.ok, true);
  assert.equal(body.dossier.found, false);
  assert.equal(body.dossier.days.length, 0);
  const by = Object.fromEntries(body.dossier.sources.map((s) => [s.key, s]));
  assert.equal(by.pros.looked, true, 'the index WAS consulted');
  assert.equal(by.pros.count, 0, 'and it had nothing');
  assert.equal(by.sealed.looked, true);
  assert.equal(by.board.looked, true);
  assert.match(by.sealed.note, /the whole window was swept/, 'and the fallback sweep is named');
  // SKIPPED, not failed: there is no customer key to read the note by, which is a consequence
  // of the miss rather than a fault. See the `complete` test below for why that distinction
  // is the whole point of this ledger.
  assert.equal(by.notes.state, 'skipped');
  assert.equal(by.notes.looked, false);
  assert.equal(body.errors.notes, 'nothing to look it up by — no customer key on any record we hold');
});

test('THE FALLBACK SWEEP FINDS A SEALED DAY THE INDEX NEVER LEARNED ABOUT', async () => {
  // Days sealed before the PRO index shipped have no pointer. Trusting one negative from the
  // index would tell a dispatcher we have no record of an order sitting in the warehouse.
  const d = addDays(await today(), -9);
  const { body } = await withStore({
    [`history_days/${T}__${d}/stops/007174397`]: sealedStop({ date: d }),
  }, 'stop=007174397');
  assert.equal(body.dossier.found, true);
  assert.equal(body.dossier.days[0].date, d);
  assert.deepEqual(body.window.pointerDays, []);
});

test('A FAILED READ IS REPORTED AS UNREAD, NEVER AS EMPTY', async () => {
  // A collection that threw and a collection that was empty must not render the same. This
  // makes the write-journal list fail and asserts the screen is told so.
  const fake = installFirestoreFake({});
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    if (u.includes('/documents/nuvizz_write_ops')) return new Response('boom', { status: 500 });
    return realFetch(input, init);
  };
  try {
    const body = await call('stop=007174397');
    const writes = body.dossier.sources.find((s) => s.key === 'writes');
    assert.equal(writes.looked, false, 'the journal must be marked UNREAD');
    assert.equal(writes.found, false);
    assert.match(body.errors.writes, /500/, 'and the reason must reach the screen');
    assert.equal(body.ok, true, 'one failed source never fails the whole answer');
  } finally { globalThis.fetch = realFetch; fake.restore(); }
});

// ── the name door ─────────────────────────────────────────────────────────────

// A minimal ARRAY_CONTAINS runQuery over the fake's store, so the name door is genuinely
// exercised rather than erroring into a pass. Same shape as pro-search-covers-all-history.
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

test('THE NAME DOOR NOW OPENS THE CUSTOMER VIEW, and older deliveries still arrive with it', async () => {
  // ?name= used to return a bare list of customers and their PROs. It returns the CUSTOMER
  // VIEW now (see stop-lookup-customer.test.mjs for what that view is and why), because
  // "how many deliveries did we have for them today" was the question being asked and a list
  // of PROs from sealed history structurally cannot answer it.
  //
  // What the rollup is still for is the half OUTSIDE the window: this customer has no stop in
  // the last seven days, so their rollup deliveries — with the driver on each — are what the
  // screen shows, and the view must carry them.
  const key = 'earthly_alternative__4200_wendell_dr_sw__atlanta__30336';
  const fake = installFakeWithQuery({
    [`history_customers/${T}__${key}`]: {
      match_key: key, tenant: T, name: 'EARTHLY ALTERNATIVE', name_lower: 'earthly alternative',
      name_tokens: ['ea', 'ear', 'eart', 'earth', 'earthl', 'earthly', 'al', 'alt', 'alte', 'alter', 'altern', 'alterna', 'alternat', 'alternati', 'alternativ', 'alternative'],
      addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336',
      pros: [{ pro: '007100077', date: '2026-07-14', driver: 'FRANK OKINE' }], last_date: '2026-07-14',
    },
  });
  try {
    const body = await call('name=earthly%20alternative&days=7');
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'customer');
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(body.view.name, 'EARTHLY ALTERNATIVE');
    assert.equal(body.view.totals.stops, 0, 'nothing in the window');
    assert.equal(body.view.recent.length, 1, 'but their older deliveries are still here');
    assert.equal(body.view.recent[0].driver, 'FRANK OKINE', 'with the driver, which is what was asked for');
    assert.equal(fake.log.other.filter((o) => !o.url.includes(':runQuery')).length, 0, 'nothing but Firestore was called');
  } finally { fake.restore(); }
});

test('an empty query is refused rather than guessed at', async () => {
  const fake = installFirestoreFake({});
  try {
    const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
    const r = await handler(new Request(URL_BASE));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).ok, false);
  } finally { fake.restore(); }
});

// ── the bounds that keep this cheap ───────────────────────────────────────────

test('the read windows are BOUNDED, and a malformed ?days= widens nothing', async () => {
  const { boardWindow, daysBackParam, sealedDaysFor } = await import('../netlify/functions/stop-lookup.mts');
  assert.equal(boardWindow('2026-09-18', 14, 3).length, 18);
  assert.equal(boardWindow('2026-09-18', 14, 3)[0], '2026-09-21', 'newest first, three days ahead');
  assert.equal(daysBackParam(null), 14);
  assert.equal(daysBackParam('abc'), 14, 'a typo falls to the default, never to zero');
  assert.equal(daysBackParam('0'), 14);
  assert.equal(daysBackParam('9999'), 60, 'and the ceiling holds whatever is asked for');

  // With pointers, the sealed read is the pointer days plus the last few nights — NOT the
  // whole window. This bound is the cost argument; changing it should break a test.
  const board = boardWindow('2026-09-18', 14, 3);
  const withPtr = sealedDaysFor(['2026-05-02'], board, '2026-09-18');
  assert.ok(withPtr.includes('2026-05-02'));
  assert.ok(withPtr.includes('2026-09-18') && withPtr.includes('2026-09-14'));
  assert.ok(!withPtr.includes('2026-09-10'), 'a mid-window day with no pointer is not read');
  assert.equal(sealedDaysFor([], board, '2026-09-18').length, board.length, 'no pointer → the full sweep');
});

test('A HOSTILE STOP NUMBER GOES ON THE WIRE PERCENT-ENCODED, SO IT CANNOT TRAVERSE', async () => {
  // Typed text reaches Firestore PATHS on this screen, so this is worth pinning exactly.
  //
  // WHAT ACTUALLY PROTECTS IT, checked rather than assumed: the readers percent-encode the
  // document id (readStopDoc's encodeURIComponent, histDocId's '/'→'_'), so "../../x" leaves
  // as "..%2F..%2Fx" — ONE segment, a literal document id, not a route out of the collection.
  // assertSafePath is the second belt and refuses a bare '.' or '..' segment.
  //
  // The assertion is deliberately made against the REQUEST URL rather than the fake's own
  // log, because the fake decodeURIComponent()s the path before logging it. Asserting on the
  // log would have "found" a traversal that never goes on the wire — a guard reading its own
  // decoder rather than the request, which proves nothing about production.
  const fake = installFirestoreFake({});
  const fakeFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input, init) => { urls.push(String(input?.url ?? input)); return fakeFetch(input, init); };
  try {
    const body = await call(`stop=${encodeURIComponent('../../secrets/1234567')}`);
    assert.equal(body.ok, true, 'a hostile query is answered, not crashed on');
    assert.equal(body.dossier.found, false);
    const docUrls = urls.filter((u) => u.includes('/documents/'));
    assert.ok(docUrls.length > 0, 'reads were genuinely attempted');
    for (const u of docUrls) {
      const path = u.split('/documents/')[1].split('?')[0];
      for (const seg of path.split('/')) {
        assert.ok(seg !== '.' && seg !== '..', `no request may traverse: ${path}`);
      }
      // Beyond the documented depth nothing may add path separators of its own. The deepest
      // real path here is collection/doc/collection/doc → 4 segments.
      assert.ok(path.split('/').length <= 4, `unexpected path depth: ${path}`);
    }
  } finally { globalThis.fetch = fakeFetch; fake.restore(); }
});

// ── THE EMPTY ANSWER MUST BE TELLABLE FROM THE BROKEN ONE ────────────────────

test('a clean miss reports COMPLETE — the one state that licenses a vendor call', async () => {
  const { body } = await withStore({}, 'stop=009999999');
  assert.equal(body.dossier.found, false);
  assert.equal(body.dossier.complete, true, 'every locating source was read');
  assert.deepEqual(body.dossier.unreadSources, []);
  // The two customer-keyed sources are SKIPPED, not failed: there is no key to read them by.
  const by = Object.fromEntries(body.dossier.sources.map((s) => [s.key, s]));
  assert.equal(by.notes.state, 'skipped');
  assert.equal(by.customer.state, 'skipped');
});

test('A FAILED LOCATING READ MAKES THE ANSWER INCOMPLETE, so the screen cannot call it new', async () => {
  const fake = installFirestoreFake({});
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input);
    if (u.includes('/documents/nuvizz_write_ops')) return new Response('boom', { status: 500 });
    return realFetch(input, init);
  };
  try {
    const body = await call('stop=009999999');
    assert.equal(body.dossier.found, false);
    assert.equal(body.dossier.complete, false);
    assert.deepEqual(body.dossier.unreadSources, ['What we sent NuVizz']);
  } finally { globalThis.fetch = realFetch; fake.restore(); }
});

test('PRO_INDEX=off is skipped, not failed — the fallback sweep still covers the window', async () => {
  const prev = process.env.PRO_INDEX;
  process.env.PRO_INDEX = 'off';
  const d = addDays(await today(), -6);
  try {
    const { body } = await withStore({ [`history_days/${T}__${d}/stops/007174397`]: sealedStop({ date: d }) }, 'stop=007174397');
    assert.equal(body.proIndex, false);
    assert.equal(body.dossier.sources.find((s) => s.key === 'pros').state, 'skipped');
    assert.equal(body.dossier.complete, true);
    assert.equal(body.dossier.found, true, 'and the order is still found without the index');
  } finally { if (prev === undefined) delete process.env.PRO_INDEX; else process.env.PRO_INDEX = prev; }
});
