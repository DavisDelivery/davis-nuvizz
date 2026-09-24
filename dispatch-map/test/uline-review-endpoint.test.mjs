// test/uline-review-endpoint.test.mjs — the Uline review endpoint, RUN, not read.
//
// The handler is executed against the in-memory Firestore fake, which THROWS on any network
// call that is not Firestore. So "zero NuVizz calls" is proven by the request never leaving,
// not by grepping an import list — a vendor call anywhere in the path would fail this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { withCustomerKeys } from '../netlify/functions/lib/customer-key.mts';
import { scanDatesFrom } from '../netlify/functions/lib/refresh-stops-core.mts';
import { etDayString } from '../netlify/functions/lib/firestore.mts';
import { tractorLocPath } from '../netlify/functions/lib/tractor-flags.mts';
import handler from '../netlify/functions/uline-advisory.mts';

const FN = fs.readFileSync(new URL('../netlify/functions/uline-advisory.mts', import.meta.url), 'utf8');
const U = 'uline_straight_truck';
// The endpoint walks today + the next two business days; the test seeds the SAME days, computed
// by the same functions, so it never goes stale on a weekend.
const [D0, D1, D2] = scanDatesFrom(etDayString(), 3);
const stopPath = (d, n) => `nuvizz_stop_index/davis__${d}/stops/${n}`;
const mk = (s) => withCustomerKeys([s])[0].matchKey;

const S = {
  titan: { stopNbr: '007176403', pro: '007176403', businessName: 'TITAN ELECTRIC', addr1: '3190 REPS MILLER RD', city: 'NORCROSS', state: 'GA', zip: '30092', lat: 33.97, lng: -84.22, routeName: 'NOR 2', isPlanned: true },
  kickr: { stopNbr: '007176396', pro: '007176396', businessName: 'KICKR DESIGN', addr1: '440 INTERSTATE NORTH PKWY SE', city: 'ATLANTA', state: 'GA', zip: '30339', lat: 33.89, lng: -84.45 },
  conley: { stopNbr: '007176063', pro: '007176063', businessName: 'CONLEY ARCH', addr1: '4080 BONSAL RD', city: 'CONLEY', state: 'GA', zip: '30288', lat: 33.66, lng: -84.32 },
  fec: { stopNbr: '007176117', pro: '007176117', businessName: 'FEC BC2', addr1: '200 COBB PKWY N', city: 'MARIETTA', state: 'GA', zip: '30062', lat: 33.95, lng: -84.52 },
  plain: { stopNbr: '007170000', pro: '007170000', businessName: 'NO FLAG INC', addr1: '1 PLAIN ST', city: 'BUFORD', state: 'GA', zip: '30518', lat: 34.1, lng: -84.0 },
};
const K = Object.fromEntries(Object.entries(S).map(([k, s]) => [k, mk(s)]));
const ulineNote = (key, over = {}) => ({
  match_key: key, raw_name: key, equipment_restrictions: [U],
  auto_sources: { [U]: ['orderInstructions'] },
  auto_matches: { [U]: [{ source: 'orderInstructions', text: 'STRAIGHT TRUCK ONLY', pattern: 'p' }] },
  ...over,
});

function seed() {
  return {
    // TITAN is on the board twice — one location, one question.
    [stopPath(D0, S.titan.stopNbr)]: S.titan,
    [stopPath(D1, '007176415')]: { ...S.titan, stopNbr: '007176415', pro: '007176415', routeName: null, isPlanned: false },
    [stopPath(D0, S.kickr.stopNbr)]: S.kickr,
    [stopPath(D1, S.conley.stopNbr)]: S.conley,
    [stopPath(D2, S.fec.stopNbr)]: S.fec,
    [stopPath(D0, S.plain.stopNbr)]: S.plain,
    [`customer_notes/${K.titan}`]: ulineNote(K.titan, { building_type: 'school' }),
    // KICKR's pin was corrected by hand — the override must win over the feed's coordinates.
    [`customer_notes/${K.kickr}`]: ulineNote(K.kickr, { location_override: { lat: 33.8901, lng: -84.4502 } }),
    // CONLEY: Uline AND a Davis-typed Address 2 mark — a person has already said no.
    [`customer_notes/${K.conley}`]: ulineNote(K.conley, {
      equipment_restrictions: [U, 'no_tractor_trailer'],
      auto_sources: { [U]: ['orderInstructions'], no_tractor_trailer: ['addressLine2'] },
    }),
    [`customer_notes/${K.fec}`]: ulineNote(K.fec, { vehicle_eligibility: 'box_only', vehicle_eligibility_by: 'dispatcher' }),
    [`customer_notes/${K.plain}`]: { match_key: K.plain, equipment_restrictions: ['liftgate_required'] },
    [tractorLocPath('davis', K.titan)]: { match_key: K.titan, last_tractor_date: '2026-08-17', delivery_count: 3 },
  };
}

async function call() {
  const res = await handler(new Request('http://localhost/.netlify/functions/uline-advisory'));
  return { status: res.status, body: await res.json() };
}

test('ZERO NUVIZZ CALLS — the request never leaves Firestore, and the envelope says so', async () => {
  // No onOther handler: any non-Firestore fetch THROWS inside the fake, and the handler would
  // answer 500. A 200 here is the proof.
  installFirestoreFake(seed());
  const { status, body } = await call();
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.nuvizzCalls, 0);
});

test('every Uline-flagged location on the board, ONE ROW EACH, and nothing else', async () => {
  installFirestoreFake(seed());
  const { body } = await call();
  const keys = body.rows.map((r) => r.key).sort();
  assert.deepEqual(keys, [K.conley, K.fec, K.kickr, K.titan].sort(), 'the unflagged customer is not listed');
  const titan = body.rows.find((r) => r.key === K.titan);
  assert.equal(titan.stops.length, 2, 'two stops, one question');
  assert.equal(body.summary.locations, 4);
  assert.equal(body.summary.stops, 5);
});

test('each location is classified end to end — and the person who said no is not asked again', async () => {
  installFirestoreFake(seed());
  const { body } = await call();
  const by = Object.fromEntries(body.rows.map((r) => [r.key, r.decision]));
  assert.equal(by[K.titan], 'undecided');
  assert.equal(by[K.kickr], 'undecided');
  assert.equal(by[K.conley], 'confirmed', 'Address 2 NO TRACTOR TRL beside Uline is a human answer');
  assert.equal(by[K.fec], 'box_only');
  assert.deepEqual(body.summary, { undecided: 2, confirmed: 1, box_only: 1, tractor: 0, locations: 4, stops: 5 });
  // Undecided sort first.
  assert.deepEqual(body.rows.slice(0, 2).map((r) => r.decision), ['undecided', 'undecided']);
});

test('the evidence arrives: Uline\'s words, tractor history, the place type, the pin that wins', async () => {
  installFirestoreFake(seed());
  const { body } = await call();
  const titan = body.rows.find((r) => r.key === K.titan);
  assert.deepEqual(titan.uline, ['STRAIGHT TRUCK ONLY']);
  assert.deepEqual(titan.tractor, { count: 3, last: '2026-08-17' });
  assert.equal(titan.buildingType, 'school');
  assert.deepEqual(titan.pin, { lat: 33.97, lng: -84.22, source: 'feed' });
  const kickr = body.rows.find((r) => r.key === K.kickr);
  assert.deepEqual(kickr.pin, { lat: 33.8901, lng: -84.4502, source: 'override' }, 'a hand-moved pin is the building');
  assert.equal(kickr.tractor, null);
});

test('TRACTOR HISTORY IS READ FOR THE FLAGGED LOCATIONS ONLY — never the whole collection', async () => {
  // tractor_locations holds one document per place a tractor has EVER delivered. The review
  // needs it for a handful of rows; listing the collection on every open would read thousands.
  const { log } = installFirestoreFake(seed());
  await call();
  assert.ok(!log.lists.some((p) => String(p).includes('tractor_locations')), `listed: ${log.lists.join(', ')}`);
  const tractorGets = log.gets.filter((p) => String(p).includes('tractor_locations'));
  assert.equal(tractorGets.length, 4, 'one get per flagged location');
});

test('THE NOTES READ IS MASKED, AND THE MASK CARRIES PROVENANCE', async () => {
  // Drop manual_overrides from the mask and a location whose restriction list a dispatcher
  // LOCKED (keeping Uline's flag in it) reads as undecided — one tap of Tractor OK would overrule
  // them. Drop auto_sources and every scanner-found blocker reads as a person's. The fake returns
  // whole documents whatever the mask says (its own comment), so the end-to-end tests above
  // CANNOT catch either — this assertion is the only guard, and it was proven to fail when
  // auto_sources was taken out of ULINE_NOTE_FIELDS.
  const { log } = installFirestoreFake(seed());
  await call();
  // The fake records { path, mask: [fieldPaths] } per list call.
  const notesRead = log.listMasks.find((m) => String(m.path).includes('customer_notes'));
  assert.ok(notesRead, `customer_notes was not listed: ${JSON.stringify(log.listMasks.map((m) => m.path))}`);
  assert.ok(notesRead.mask.length > 0, 'the notes read must be MASKED — unmasked it ships every dock note on the board');
  const notesMask = notesRead.mask.join(',');
  for (const f of ['auto_sources', 'manual_overrides', 'equipment_restrictions', 'auto_matches', 'location_override', 'building_type']) {
    assert.ok(notesMask.includes(f), `mask is missing ${f}`);
  }
});

test('zero notes loaded is reported as zero — the diagnostic, not an empty clean board', async () => {
  const s = seed();
  for (const k of Object.keys(s)) if (k.startsWith('customer_notes/')) delete s[k];
  installFirestoreFake(s);
  const { body } = await call();
  assert.equal(body.notesLoaded, 0);
  assert.equal(body.rows.length, 0);
});

test('GET only — there is no write path here to be reached by accident', async () => {
  installFirestoreFake(seed());
  const res = await handler(new Request('http://localhost/.netlify/functions/uline-advisory', { method: 'POST', body: '{}' }));
  assert.equal(res.status, 405);
  assert.doesNotMatch(FN, /setDoc|updateDocFields|deleteDoc|commit/, 'the decision is written by the browser, as the brush writes it');
});

test('THE BACKLOG IS COUNTED FROM THE NOTES IN HAND — flagged customers with no freight included', async () => {
  // A board showing nothing while customers carry an undecided flag is a broken join or a quiet
  // board, and without this count the two are the same empty screen.
  const s = seed();
  s['customer_notes/offboard|1|x'] = ulineNote('offboard|1|x');                                  // flagged, not on the board
  s['customer_notes/offboard|2|y'] = ulineNote('offboard|2|y', { vehicle_eligibility: 'tractor' }); // flagged, decided
  const { log } = installFirestoreFake(s);
  const { body } = await call();
  // On the board: titan, kickr (undecided), conley (confirmed), fec (box_only). Off it: two more.
  assert.deepEqual(body.backlog, { flagged: 6, undecided: 3 });
  assert.equal(body.rows.length, 4, 'off-board customers are counted, not listed — there is no building to show');
  const tractorGets = log.gets.filter((p) => String(p).includes('tractor_locations'));
  assert.equal(tractorGets.length, 4, 'and counting them costs no extra reads');
});
