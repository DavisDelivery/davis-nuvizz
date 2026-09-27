// test/driver-territory-layer.test.mjs — THE MAP'S RINGS ARE THE SHEET'S RINGS, AND THE MASKED
// READ LOSES NOTHING.
//
// Chad, 2026-09-27: "find the circles we were working on for the new trainee learning to route to
// try and guide him to where drivers go and we were going to build an overlay for the map that we
// could toggle on and off."
//
// Two promises are pinned here:
//
//   1. The Map overlay draws the SAME rings in the SAME colours as page one of the printed sheet.
//      A trainee holding the paper beside the screen must never be shown two answers.
//   2. The endpoint now asks Firestore for TERRITORY_STOP_FIELDS only. That is safe exactly as long
//      as nothing in the territory code or the sheet reads any other field of a stop — so every
//      read is WATCHED, not assumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TERRITORY_STOP_FIELDS, RING_PALETTE, ringColours, territoryModel, territoryLayer,
  activeDrivers, territoryCoverage, possibleSameDriver, applyAliases, driverCore,
  HIDDEN_FROM_RINGS, splitHidden,
} from '../src/lib/driver-territory.js';
import { territorySheetHtml } from '../src/lib/territory-sheet-html.js';

// ── a small north-Georgia fleet with every case the rings have to get right ──
const DAYS = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-08', '2026-09-09',
  '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
  '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'];
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
function cluster(name, lat, lng, n, spread, extra = {}) {
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({
      _id: `${name}-${lat}-${k}`, stopNbr: `${Math.round(lat * 1000)}${k}`,
      driverUserName: name, driverName: name,
      zip: String(30000 + Math.round(lat * 100) % 900 + (k % 3)), city: `${name.split(' ')[0].toUpperCase()}TOWN`,
      lat: lat + (rnd() - 0.5) * spread, lng: lng + (rnd() - 0.5) * spread,
      boardDate: DAYS[k % DAYS.length], ...extra,
    });
  }
  return out;
}
function fixture() {
  return [
    ...cluster('Vincent Bonzo', 34.00, -83.90, 60, 0.06),
    ...cluster('Colin Calhoun', 33.95, -84.00, 40, 0.05),
    ...cluster('COLIN/DJ 1', 33.95, -84.00, 20, 0.05),              // Colin's second load, not a second man
    ...cluster('Denis Salkic', 33.45, -84.15, 30, 0.05),            // two separate areas…
    ...cluster('Denis Salkic', 34.25, -83.60, 30, 0.05),            // …fifty miles apart
    ...cluster('Rasko Suljic', 33.90, -84.10, 60, 0.9),             // everywhere: no honest ring
    ...cluster('Anthony Bennett', 34.05, -84.05, 45, 0.03),
    ...cluster('Terry Gambrell', 33.70, -84.10, 70, 0.05).map((s, i) => ({ ...s, boardDate: DAYS[i % 3] })), // stopped
    ...cluster('Nomap Driver', 34.10, -84.00, 12, 0.05).map((s) => ({ ...s, lat: null, lng: null })),
  ];
}

// ── 1. PAPER AND SCREEN AGREE ────────────────────────────────────────────────

/** The overview rings the sheet draws — circles and ovals — by stroke colour, in paint order. */
function sheetRings(html) {
  const big = html.slice(0, html.indexOf('<div class="page">'));
  return [...big.matchAll(/<(?:circle|ellipse) [^>]*?fill="(#[0-9a-f]{6})" fill-opacity="0\.05" stroke="(#[0-9a-f]{6})" stroke-width="1\.6"/g)]
    .map((m) => m[2]);
}

test('THE MAP DRAWS EXACTLY THE RINGS PAGE ONE PRINTS — same count, same colours', () => {
  const stops = fixture();
  const layer = territoryLayer(stops);
  const printed = sheetRings(territorySheetHtml({ stops }));
  const drawn = layer.rings.flatMap((r) => r.circles.map(() => r.colour));
  assert.ok(printed.length >= 4, `the fixture should print several rings, printed ${printed.length}`);
  assert.equal(drawn.length, printed.length, 'one map ring for every printed ring');
  assert.deepEqual([...drawn].sort(), [...printed].sort(), 'and each in the colour the paper gives it');
});

test('every ringed driver\'s name is on the printed page too', () => {
  const stops = fixture();
  const html = territorySheetHtml({ stops });
  for (const r of territoryLayer(stops).rings) assert.ok(html.includes(r.label), `${r.label} is on the sheet`);
});

test('colours are the sheet\'s palette, busiest driver first — the same rule the paper uses', () => {
  const stops = fixture();
  const m = territoryModel(stops);
  const expect = ringColours(driverCore(m.inWindow));
  for (const r of territoryLayer(stops).rings) assert.equal(r.colour, expect.get(r.key), r.label);
  assert.equal(RING_PALETTE.length, 10);
  assert.equal(ringColours([{ key: 'A' }]).get('A'), RING_PALETTE[0]);
});

test('A DRIVER WHO WORKS TWO AREAS GETS TWO RINGS, not one stretched across the ground between', () => {
  const denis = territoryLayer(fixture()).rings.find((r) => r.key === 'DENIS_SALKIC');
  assert.ok(denis, 'Denis is drawn');
  assert.equal(denis.circles.length, 2, 'two rings');
  const lats = denis.circles.map((c) => c.lat).sort();
  assert.ok(Math.abs(lats[0] - 33.45) < 0.05 && Math.abs(lats[1] - 34.25) < 0.05,
    `each ring sits on one of his areas, not on the midpoint: ${lats.join(', ')}`);
});

test('"COLIN/DJ 1" is Colin\'s second load — one ring for one man, never a ring for "DJ"', () => {
  const layer = territoryLayer(fixture());
  assert.ok(layer.rings.some((r) => r.key === 'COLIN_CALHOUN' || r.key === 'COLIN'), 'Colin is drawn');
  assert.ok(!layer.rings.some((r) => /DJ/.test(r.key)), 'nobody called DJ has a patch');
});

test('A DRIVER WITH NO SETTLED PATCH GETS NO RING — and is named, with the reason', () => {
  const layer = territoryLayer(fixture());
  assert.ok(!layer.rings.some((r) => r.key === 'RASKO_SULJIC'), 'no ring drawn round scattered work');
  const rasko = layer.noRing.find((n) => n.key === 'RASKO_SULJIC');
  assert.ok(rasko, 'he is listed rather than silently missing');
  assert.equal(rasko.why, 'spread out');
});

test('a running driver with no coordinates is SAID to have none — a different fact from "spread out"', () => {
  const n = territoryLayer(fixture()).noRing.find((x) => x.key === 'NOMAP_DRIVER');
  assert.ok(n, 'listed');
  assert.equal(n.why, 'no coordinates');
});

test('a driver who has stopped running is not drawn, and the layer says why', () => {
  const layer = territoryLayer(fixture());
  assert.ok(!layer.rings.some((r) => r.key === 'TERRY_GAMBRELL'));
  const terry = layer.excluded.find((e) => e.label === 'Terry Gambrell');
  assert.ok(terry, 'excluded, not vanished');
  assert.equal(terry.why, 'stopped running');
});

test('with a roster, a carrier is never drawn as a person a trainee could hand a stop to', () => {
  const stops = [...fixture(), ...cluster('ESTES', 33.80, -84.30, 40, 0.04)];
  assert.ok(territoryLayer(stops).rings.some((r) => r.key === 'ESTES'), 'without a roster nothing is guessed away');
  const roster = new Set(['VINCENT_BONZO', 'COLIN_CALHOUN', 'DENIS_SALKIC', 'RASKO_SULJIC', 'ANTHONY_BENNETT', 'TERRY_GAMBRELL', 'NOMAP_DRIVER']);
  assert.ok(!territoryLayer(stops, { roster }).rings.some((r) => r.key === 'ESTES'), 'with one, the carrier is gone');
});

test('NOTHING ABOUT A CUSTOMER LEAVES THE SERVER — rings, names and counts only', () => {
  const stops = fixture();
  const json = JSON.stringify(territoryLayer(stops));
  for (const s of stops.slice(0, 50)) {
    assert.ok(!json.includes(`"${s.zip}"`), `ZIP ${s.zip} is not in the payload`);
    assert.ok(!json.includes(s.stopNbr), 'no stop numbers');
  }
  assert.ok(!/city|zip|addr|business/i.test(json), 'no address fields at all');
  const ring = territoryLayer(stops).rings[0];
  assert.deepEqual(Object.keys(ring).sort(), ['circles', 'colour', 'key', 'label', 'stops']);
  assert.deepEqual(Object.keys(ring.circles[0]).sort(), ['lat', 'lng', 'radiusKm']);
  // EVERY ring, not just the first: a ring is a centre and a size, and an oval (where the work
  // runs along a road — driver-area-ovals.test.mjs) is three more numbers, never anything else.
  // A driver running the I-985 towns is added so there IS an oval to check.
  const road = [[34.121, -84.000], [34.185, -83.925], [34.227, -83.884], [34.298, -83.824]]
    .flatMap(([lat, lng]) => cluster('Ray Corridor', lat, lng, 40, 0.03));
  let ovals = 0;
  for (const r of territoryLayer([...stops, ...road]).rings) {
    for (const c of r.circles) {
      const keys = Object.keys(c).sort();
      assert.ok(['lat,lng,radiusKm', 'lat,lng,oval,radiusKm'].includes(keys.join(',')), `${r.label}: ${keys}`);
      if (c.oval) { ovals++; assert.deepEqual(Object.keys(c.oval).sort(), ['angleDeg', 'majorKm', 'minorKm']); }
    }
  }
  assert.ok(ovals > 0, 'the check above met an oval');
});

test('no history is an empty layer, not a crash — and says so in its counts', () => {
  const layer = territoryLayer([]);
  assert.deepEqual(layer.rings, []);
  assert.deepEqual(layer.noRing, []);
  assert.equal(layer.coverage.deliveries, 0);
  assert.equal(layer.coverage.days, 0);
});

// ── 2. THE MASK IS SAFE, BECAUSE EVERY READ IS WATCHED ───────────────────────

/** Wrap each stop so every property read is recorded — including reads of fields it does not have. */
function watched(stops) {
  const read = new Set();
  const wrap = (s) => new Proxy(s, {
    get(t, k, r) { if (typeof k === 'string') read.add(k); return Reflect.get(t, k, r); },
  });
  return { stops: stops.map(wrap), read };
}
/** What the endpoint hands the territory code: the masked fields, the doc id, the board day. */
function asMaskedRows(stops) {
  return stops.map((s) => {
    const row = { _id: s._id };
    for (const f of TERRITORY_STOP_FIELDS) if (s[f] !== undefined) row[f] = s[f];
    row.boardDate = s.boardDate;
    return row;
  });
}
const ALLOWED = new Set([...TERRITORY_STOP_FIELDS, 'boardDate', '_id']);

test('THE TERRITORY CODE AND THE SHEET READ NO FIELD THE MASK DROPS — every read watched', () => {
  const { stops, read } = watched(asMaskedRows(fixture()));
  const aliases = [{ from: 'BRENT_BOYD', to: 'BRENT_BRYD' }];
  // Everything the endpoint runs, on every path: the layer, the sheet, ?explain=1, the alias fold.
  territoryLayer(stops);
  territorySheetHtml({ stops, maybeSame: possibleSameDriver(stops), window: { from: DAYS[0], to: DAYS[18] } });
  territorySheetHtml({ stops, roster: ['Vincent Bonzo', 'Colin Calhoun', 'Denis Salkic'] });
  activeDrivers(stops);
  territoryCoverage(stops);
  possibleSameDriver(stops);
  applyAliases(stops, aliases);
  const outside = [...read].filter((k) => !ALLOWED.has(k));
  assert.deepEqual(outside, [], `read outside the mask: ${outside.join(', ')} — add it to TERRITORY_STOP_FIELDS or stop reading it`);
  assert.ok(read.has('lat') && read.has('driverUserName') && read.has('zip'), 'and the watcher really saw the reads');
});

test('…and the watcher really would catch a read outside the mask, so the green above means something', () => {
  const { stops, read } = watched(asMaskedRows(fixture().slice(0, 5)));
  for (const s of stops) void s.normalizedStatus;          // what a careless status filter would do
  assert.ok(read.has('normalizedStatus'), 'a read of a field the row does not carry is still recorded');
  assert.ok(!ALLOWED.has('normalizedStatus'));
});

test('stopNbr rides in the mask so no stop can come back EMPTY and drop out of the counts', () => {
  // listDocs skips a masked document with none of its masked fields present. Every history stop
  // is written keyed by its stopNbr (upsertStops), so with stopNbr in the mask no document is
  // ever empty — a stop with no driver, no ZIP and no coordinates still counts as a stop.
  assert.ok(TERRITORY_STOP_FIELDS.includes('stopNbr'));
  for (const f of ['driverUserName', 'driverName', 'zip', 'city', 'lat', 'lng']) assert.ok(TERRITORY_STOP_FIELDS.includes(f), f);
  assert.ok(Object.isFrozen(TERRITORY_STOP_FIELDS), 'nobody can widen it at runtime by accident');
});

test('the masked rows give the SAME layer and the SAME printed page as whole documents', () => {
  // Whole documents carry plenty the territory code must ignore — a status, a route, a customer.
  const whole = fixture().map((s, i) => ({
    ...s, normalizedStatus: i % 7 ? 'delivered' : 'cancelled', routeName: `R${i % 9}`, loadNbr: `L${i % 13}`,
    businessName: `Customer ${i}`, raw: { stop: { sealNbr: String(i) } }, weight: i * 10,
  }));
  const masked = asMaskedRows(whole);
  assert.deepEqual(territoryLayer(masked), territoryLayer(whole));
  assert.equal(territorySheetHtml({ stops: masked, generatedAt: 'x' }), territorySheetHtml({ stops: whole, generatedAt: 'x' }));
});

// ── 3. A POSITION THAT IS NOT THERE IS NOT 0°,0° ─────────────────────────────

test('A STOP WITH lat:null IS A STOP WITH NO POSITION — never a ring off the coast of Africa', () => {
  // The board carries lat:null until a stop is geocoded, and Number(null) is 0 — a finite number.
  // Read that way, a driver's un-geocoded stops piled up at 0°,0°, grew a ring there, and the
  // coverage line counted them as mapped.
  const stops = [
    ...cluster('Vincent Bonzo', 34.00, -83.90, 40, 0.06),
    ...cluster('Vincent Bonzo', 34.00, -83.90, 20, 0).map((s) => ({ ...s, lat: null, lng: null })),
  ];
  const v = territoryLayer(stops).rings.find((r) => r.key === 'VINCENT_BONZO');
  assert.ok(v, 'Vincent is drawn from the stops that DO have a position');
  for (const c of v.circles) assert.ok(c.lat > 30 && c.lng < -80, `no ring at ${c.lat},${c.lng}`);
  assert.equal(territoryCoverage(stops).withCoords, 40, 'the 20 un-geocoded stops are not counted as mapped');
  assert.equal(territoryCoverage([{ lat: '', lng: '' }, { lat: ' ', lng: '-84' }]).withCoords, 0, 'blank strings are absent too');
  // nuvizz-scan reads Number(addr.latitude) whenever the field is not null, so a blank the vendor
  // sends becomes exactly 0,0. No Davis delivery is in the Gulf of Guinea.
  assert.equal(territoryCoverage([{ lat: 0, lng: 0 }, { lat: '0', lng: '0' }]).withCoords, 0, '0°,0° is nobody\'s delivery');
  assert.equal(territoryCoverage([{ lat: 34.1, lng: -84 }, { lat: '34.1', lng: '-84.0' }]).withCoords, 2, 'real positions, numbers or strings, still count');
  const zeros = [...cluster('Vincent Bonzo', 34.00, -83.90, 30, 0.06), ...cluster('Vincent Bonzo', 34.00, -83.90, 20, 0).map((s) => ({ ...s, lat: 0, lng: 0 }))];
  for (const c of territoryLayer(zeros).rings[0].circles) assert.ok(c.lat > 30, 'no ring at 0,0 from the vendor\'s blank either');
});

test('TOO FEW MAP POSITIONS IS NOT "SPREAD OUT" — the reason given has to be the true one', () => {
  // Forty stops in one town, two of them geocoded: no cell is busy enough to cluster, so there is
  // no ring — but the work is as tight as it gets, and "too spread out" would teach the opposite.
  const tight = cluster('Tight Guy', 34.00, -83.90, 40, 0.01).map((s, i) => (i < 2 ? s : { ...s, lat: null, lng: null }));
  const n = territoryLayer(tight).noRing.find((x) => x.key === 'TIGHT_GUY');
  assert.ok(n, 'listed');
  assert.equal(n.why, 'few coordinates');
  assert.equal(n.mapped, 2);
  assert.equal(n.stops, 40);
  // And genuinely scattered work with every stop mapped is still called what it is.
  assert.equal(territoryLayer(fixture()).noRing.find((x) => x.key === 'RASKO_SULJIC').why, 'spread out');
});

// ── 4. THE PEOPLE CHAD TOOK OFF THE RINGS ────────────────────────────────────
//
// Chad, 2026-09-27: "I don't want Chad Brandi Freddy or Jessica on the map in rings."

const withChadsList = () => [
  ...fixture(),
  ...cluster('Chad Davis', 34.12, -84.00, 60, 0.05).map((s) => ({ ...s, city: 'OWNERSVILLE', zip: '30599' })),
  ...cluster('Brandi Bradberry', 33.95, -84.05, 25, 0.04),
  ...cluster('Jessica  Sage', 34.02, -84.10, 40, 0.04),          // the vendor's double space, as NuVizz spells names
];

test('CHAD, BRANDI AND JESSICA GET NO RING — and are not listed as having none either', () => {
  const layer = territoryLayer(withChadsList());
  for (const key of ['CHAD_DAVIS', 'BRANDI_BRADBERRY', 'JESSICA_SAGE']) {
    assert.ok(!layer.rings.some((r) => r.key === key), `${key} has no ring`);
    assert.ok(!layer.noRing.some((n) => n.key === key), `${key} is not in "no ring"`);
    assert.ok(!layer.excluded.some((e) => e.label.toUpperCase().replace(/\s+/g, '_') === key), `${key} is not in "not shown"`);
  }
  assert.ok(layer.rings.some((r) => r.key === 'VINCENT_BONZO'), 'everybody else is still drawn');
  assert.deepEqual(layer.hidden, ['Brandi Bradberry', 'Chad Davis', 'Jessica Sage'], 'and the JSON says who was left off');
});

test('…OFF THE PRINTED SHEET TOO, which is the same pipeline — no ring, no card, no town-table row', () => {
  const html = territorySheetHtml({ stops: withChadsList() });
  for (const name of ['Chad Davis', 'Brandi Bradberry', 'Jessica Sage']) assert.ok(!html.includes(name), `${name} is not on the sheet`);
  assert.ok(!html.includes('OWNERSVILLE'), 'a town only Chad ran is not handed to anybody in the table');
  assert.ok(html.includes('Vincent Bonzo'), 'the drivers are all still there');
});

test('THEY ARE NOT COUNTED — nobody\'s share of a ZIP includes their stops', () => {
  const kept = territoryModel(withChadsList());
  const plain = territoryModel(fixture());
  assert.equal(kept.inWindow.length, plain.inWindow.length, 'exactly the deliveries of everybody else');
  assert.deepEqual(kept.drivers.map((d) => d.key), plain.drivers.map((d) => d.key), 'the same drivers in the same order — and so the same colours');
});

test('MATCHED ON THE PERSON, NOT ON LETTERS — an alias of Chad is Chad, a "Chad Davison" is not', () => {
  const stops = [
    ...cluster('C DAVIS', 34.12, -84.00, 30, 0.05),
    ...cluster('Chad Davison', 33.80, -84.30, 30, 0.04),
  ];
  const folded = applyAliases(stops, [{ from: 'C_DAVIS', to: 'CHAD_DAVIS' }]);
  const layer = territoryLayer(folded);
  assert.ok(!layer.rings.some((r) => r.key === 'CHAD_DAVIS'), 'a load under another spelling of him is still his');
  assert.ok(layer.rings.some((r) => r.key === 'CHAD_DAVISON'), 'somebody else whose name starts the same is untouched');
});

test('the list is exactly the three Chad named who are in the history — "Freddy" matches nobody yet', () => {
  assert.deepEqual([...HIDDEN_FROM_RINGS], ['CHAD_DAVIS', 'BRANDI_BRADBERRY', 'JESSICA_SAGE']);
  assert.ok(Object.isFrozen(HIDDEN_FROM_RINGS), 'nobody can widen it at runtime by accident');
  // An empty list is the way to see everybody again — the override the model takes.
  assert.ok(territoryLayer(withChadsList(), { hidden: [] }).rings.some((r) => r.key === 'CHAD_DAVIS'));
  assert.deepEqual(splitHidden([], HIDDEN_FROM_RINGS), { kept: [], hidden: [] }, 'nothing present, nothing said');
});
