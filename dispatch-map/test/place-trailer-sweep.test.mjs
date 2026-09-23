// THE EVENING SWEEP, RUN FOR REAL, ON A BOARD WITH A SCHOOL AND A CHURCH ON A TRACTOR.
//
// board-flags R7b (a school, church or government stop on a tractor-trailer) is in-app only:
// it must never text, never email, never reach flag history — and the sweep must still COUNT
// it, in its own field, with the tractor lift it used named beside the number. The pure halves
// are pinned in trailer-conflict.test.mjs; this runs the real handler over an in-memory
// Firestore so the wiring between them is observed, not assumed: which tractor docs it read,
// what the status doc says, and that nothing was claimed or sent.
//
// Synthetic places only. No network: the fake throws on any non-Firestore fetch, so a vendor
// or NuVizz call would fail the run rather than slip past it.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { normalizeMatchKey } from '../src/lib/matchKey.js';
import { tractorLocPath } from '../netlify/functions/lib/tractor-flags.mts';
import { flagHistoryPath } from '../netlify/functions/lib/flag-history.mts';

const DATE = '2026-09-01';                    // a Tuesday — the board being built tonight
const NOW = '2026-09-01T01:30:00Z';           // 9:30pm EDT on Aug 31: the evening window
const boardPath = `nuvizz_stop_index/davis__${DATE}`;

const place = (stopNbr, businessName, addr1, zip, over = {}) => ({
  stopNbr, businessName, addr1, city: 'LAWRENCEVILLE', zip,
  lat: 33.95, lng: -84.0, normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'TRACTOR 2', routeName: 'TRACTOR 2', stopType: 'DO', ...over,
});
const school = place('S1', 'LINCOLN ELEMENTARY', '905 MAIN ST', '30046', { routeSeq: 2 });
const church = place('C1', 'GRACE CHURCH', '12 FAR RD', '30044', { routeSeq: 5 });
const plain = place('O1', 'ACME SUPPLY', '1 MILL ST', '30045', { routeSeq: 7 });
const keyOf = (s) => normalizeMatchKey(s.businessName, s.addr1, s.city, s.zip);

test('the evening sweep COUNTS a school on a tractor, reads only the tractor docs it needs, and texts nobody', async () => {
  const seed = {
    [boardPath]: { last_scanned_at: '2026-09-01T01:25:00Z' },
    [`${boardPath}/stops/S1`]: school,
    [`${boardPath}/stops/C1`]: church,
    [`${boardPath}/stops/O1`]: plain,
    [`customer_notes/${keyOf(school)}`]: { building_type: 'school' },
    [`customer_notes/${keyOf(church)}`]: { building_type: 'church' },
    // The load header says a 53' trailer is pulling TRACTOR 2.
    [`nuvizzFleet/davis__${DATE}/loads/T2`]: { loadNbr: 'TRACTOR 2', routeName: 'TRACTOR 2', vehicleType: '53ft Trailer' },
    // A tractor has delivered to the church before: the rule stands down there.
    [tractorLocPath('davis', keyOf(church))]: { match_key: keyOf(church), first_tractor_date: '2026-02-10' },
  };
  mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const fake = installFirestoreFake(seed);
  try {
    const { default: handler } = await import('../netlify/functions/eta-flag-evening-background.mts');
    const res = await handler(new Request('https://example.test/.netlify/functions/eta-flag-evening-background'));
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.date, DATE);

    // THE COUNT, in its own field, with its method named.
    assert.equal(body.placeConflicts, 1, 'the school; the church is lifted by its tractor history');
    assert.equal(body.placeLift, 'match_key');
    assert.equal(body.placeLiftWanted, 2);
    assert.equal(body.placeLiftRead, 2);
    assert.equal(body.placeLiftSeen, 1);
    assert.equal(body.placeLiftCapped, false);
    assert.equal(body.placeLiftErrors, 0);
    assert.equal(body.trailerConflicts, 0, 'never folded into the dispatcher-mark count');
    assert.equal(body.tractorRoutes, 1);

    // THE RECORD IS WHAT WAS WRITTEN, not what the response claims.
    const status = fake.store.get(`nuvizz_ops/flag_evening_status__${DATE}`);
    assert.ok(status, 'status doc written');
    assert.equal(status.placeConflicts, 1);
    assert.equal(status.placeLift, 'match_key');

    // ONLY the two tractor docs the engine named — none for the ordinary stop, no collection scan.
    const tractorGets = fake.log.gets.filter((p) => p.startsWith('tractor_locations/')).sort();
    assert.deepEqual(tractorGets, [tractorLocPath('davis', keyOf(church)), tractorLocPath('davis', keyOf(school))].sort());
    assert.ok(!fake.log.lists.some((p) => p === 'tractor_locations'), 'never lists the collection');

    // NEVER TEXTED, NEVER IN FLAG HISTORY.
    assert.equal(body.candidates, 0, 'no text candidate');
    assert.deepEqual(body.texted, []);
    assert.ok(![...fake.store.keys()].some((k) => k.startsWith('eta_flag_sms/')), 'no text claim written');
    const hist = fake.store.get(flagHistoryPath('davis', DATE));
    assert.ok(hist, 'the sweep did write the night\'s history — so its absence below is a real absence');
    const histRows = Object.values(hist.rows || {});
    assert.ok(!histRows.some((r) => r?.rule === 'place_trailer_conflict' || r?.stopNbr === 'S1'),
      'the school row is not in flag history');
  } finally {
    fake.restore();
    mock.timers.reset();
  }
});

// ── THE DRY TWIN AND THE DAY SWEEP, RUN FOR REAL ON THE SAME BOARD ──────────
//
// eta-flag-check exists to answer "what would the sweeps do" in one request, so its R7b list
// has to be judged with the same tractor lift the evening status doc is — or the two surfaces
// disagree about the church a tractor has already served. The day alert sweep is the other
// half: nothing it keeps reads an R7b row, so it must not spend reads on the lift at all.

const baseSeed = () => ({
  [boardPath]: { last_scanned_at: '2026-09-01T13:55:00Z' },
  [`${boardPath}/stops/S1`]: school,
  [`${boardPath}/stops/C1`]: church,
  [`${boardPath}/stops/O1`]: plain,
  [`customer_notes/${keyOf(school)}`]: { building_type: 'school' },
  [`customer_notes/${keyOf(church)}`]: { building_type: 'church' },
  [`nuvizzFleet/davis__${DATE}/loads/T2`]: { loadNbr: 'TRACTOR 2', routeName: 'TRACTOR 2', vehicleType: '53ft Trailer' },
  [tractorLocPath('davis', keyOf(church))]: { match_key: keyOf(church), first_tractor_date: '2026-02-10' },
});

test('eta-flag-check lists ONLY the school — the church is lifted by the same tractor read the evening sweep makes', async () => {
  const seed = {
    ...baseSeed(),
    // The class map the sweeps publish for the day; the dry twin reads it rather than deriving one.
    [`travel_calibration/davis__route_classes__${DATE}`]: { tenant: 'davis', date: DATE, classes: { 'TRACTOR 2': 'tractor' } },
  };
  const fake = installFirestoreFake(seed);
  try {
    const { default: handler } = await import('../netlify/functions/eta-flag-check.mts');
    const res = await handler(new Request(`https://example.test/.netlify/functions/eta-flag-check?date=${DATE}&now=600`));
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.diag.tractorRoutes, 1, 'the route really was judged as a tractor');
    assert.deepEqual(body.placeConflicts.map((r) => r.stopNbr), ['S1'], 'Grace Church is lifted; Lincoln is not');
    assert.equal(body.placeConflicts[0].placeMark, 'school');
    assert.equal(body.placeConflicts[0].placeSource, 'dispatcher');
    assert.deepEqual(body.place, {
      placeConflicts: 1, placeInTrailerCard: 0, placeSources: 'dispatcher_only',
      placeLift: 'match_key', placeLiftWanted: 2, placeLiftRead: 2, placeLiftSeen: 1,
      placeLiftCapped: false, placeLiftErrors: 0,
    });
    const tractorGets = fake.log.gets.filter((p) => p.startsWith('tractor_locations/')).sort();
    assert.deepEqual(tractorGets, [tractorLocPath('davis', keyOf(church)), tractorLocPath('davis', keyOf(school))].sort(),
      'only the two docs the first pass named');
    assert.ok(!fake.log.lists.some((p) => p === 'tractor_locations'), 'never lists the collection');
    assert.deepEqual(fake.log.sets, [], 'a dry twin writes nothing');
    assert.deepEqual(fake.log.other, [], 'and calls nothing that is not Firestore');
  } finally {
    fake.restore();
  }
});

test('the day alert sweep judges the same board and reads NO tractor docs — nothing it keeps reads an R7b row', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-01T14:00:00Z') });   // 10:00a EDT, Tuesday
  const fake = installFirestoreFake(baseSeed());
  try {
    const { default: handler } = await import('../netlify/functions/eta-flag-alert-background.mts');
    const res = await handler(new Request('https://example.test/.netlify/functions/eta-flag-alert-background'));
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.date, DATE);
    assert.equal(body.tractorRoutes, 1, 'it judged TRACTOR 2 as a tractor — the silence below is not a skipped board');
    assert.ok(fake.store.get(flagHistoryPath('davis', DATE)), 'and ran to the end: the day\'s flag history was written');
    assert.deepEqual(fake.log.gets.filter((p) => p.startsWith('tractor_locations/')), [],
      'no tractor_locations read on a */5 cron for a verdict nobody keeps');
    assert.equal(body.alertable, 0, 'a building type never reaches the inbox');
  } finally {
    fake.restore();
    mock.timers.reset();
  }
});
