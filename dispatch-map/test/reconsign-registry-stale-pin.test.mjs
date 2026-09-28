// test/reconsign-registry-stale-pin.test.mjs — A MOVED ORDER'S PIN FOLLOWS IT EVEN WHEN ITS FIRST RE-READ MISSED.
//
// A reconsignment (the list address changes) is meant to re-enrich the order: fresh detail and a
// pin on the NEW building. The scan that notices it skips the per-PRO registry, whose record
// still describes the OLD address. But that skip lived only for that one scan. If the live
// /stop/info that scan was supposed to make was capped or failed, the row was written
// un-enriched with the new address and the new list signature — and on the NEXT scan nothing
// flagged it any more (the reconsign checks both need a previously-enriched row), so the
// registry record for the OLD address was merged in: the card read the new address, the pin sat
// on the old building, the row was marked enriched, and every later scan agreed with itself.
// The driver is sent to the wrong place for good.
//
// The registry record carries the list signature of the address it was enriched for, so a
// record whose signature disagrees with the row's current one is not merged.
//
// Runs the REAL scan against the in-memory Firestore; NuVizz is stubbed, and the stubbed
// /stop/info answers "not found" — the failed re-read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake, installServiceAccountEnv } from './_firestore-fake.mjs';

installServiceAccountEnv();
process.env.NUVIZZ_DAVIS_USER = 'u'; process.env.NUVIZZ_DAVIS_PASS = 'p';
process.env.NUVIZZ_SCANS_ENABLED = '1'; process.env.NUVIZZ_TWO_SCAN = 'on'; process.env.NUVIZZ_ENRICH = 'on';
delete process.env.AUTH_REQUIRED;

const { etDayString, readStops } = await import('../netlify/functions/lib/firestore.mts');
const { runRefreshStops, registryRecordForOtherAddress } = await import('../netlify/functions/lib/refresh-stops-core.mts');

const today = etDayString();
const usFmt = (d, t) => { const [y, m, dd] = d.split('-'); return `${+m}/${+dd}/${y} ${t}`; };
const COLS = ['vizzonInfo.shipmentInfo.stopNbr', 'vizzonInfo.shipmentInfo.shipmentNbr',
  'default_vizzonInfo.shipmentInfo.status', 'vizzonInfo.shipmentInfo.status',
  'vizzonInfo.destination.address.name', 'vizzonInfo.destination.address.line1',
  'vizzonInfo.destination.address.city', 'vizzonInfo.destination.address.zipCode',
  'route.name', 'vizzonInfo.shipmentInfo.proNbr', 'vizzonInfo.shipmentInfo.weight',
  'vizzonInfo.destination.earliestSchTime', 'vizzonInfo.createdTime', 'vizzonInfo.stopUpdatedDttm'];
const search = (rows) => ({ filterData: [Object.fromEntries(COLS.map((c) => [c, {}]))], values: rows });
const loads = { filterData: [Object.fromEntries(['loadId', 'name', 'loadNbr', 'status', 'trips'].map((c) => [c, {}]))], values: [['L1', 'BEN 1', 'DAVIS000202683', 'Dispatched', 0]] };
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });

const OLD = { addr1: '100 Peachtree St', city: 'ATLANTA', zip: '30303', lat: 33.7550, lng: -84.3900 };
const NEW = { addr1: '2535 Royal Place', city: 'TUCKER', zip: '30084', lat: 33.8540, lng: -84.2170 };
const at = usFmt(today, '08:00 AM');
const listRow = ['S1', 'S1', '10', 'Un-Planned', 'ACME', NEW.addr1, NEW.city, NEW.zip, '', 'PRO-S1', '100', at, at, at];

async function scanAfterMissedReread(registrySig) {
  const seed = {
    [`nuvizz_stop_index/davis__${today}`]: { tenant: 'davis', date: today, last_scanned_at: today + 'T12:00:00.000Z', count: 1, lastUnplannedScanAt: today + 'T12:00:00.000Z' },
    // What the scan that noticed the move left behind: the NEW address and signature, the new
    // address's geocode, and NOT enriched — its /stop/info was capped.
    [`nuvizz_stop_index/davis__${today}/stops/S1`]: {
      stopNbr: 'S1', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, boardDate: today, scheduledDate: today,
      businessName: 'ACME', addr1: NEW.addr1, city: NEW.city, zip: NEW.zip, addrListSig: '30084|2535', lat: NEW.lat, lng: NEW.lng,
    },
    // The registry still holds the record enriched for the OLD address.
    'nuvizz_enriched/davis/pros/S1': {
      stopNbr: 'S1', enriched: true, enriched_at: '2026-09-20T12:00:00.000Z', businessName: 'ACME',
      addr1: OLD.addr1, city: OLD.city, zip: OLD.zip, lat: OLD.lat, lng: OLD.lng, addrListSig: registrySig,
    },
  };
  const stopInfo = [];
  const fake = installFirestoreFake(seed, async (url, init) => {
    if (/PkgRoute/.test(url)) return json(loads);
    if (/VizzonStop/.test(url)) { const id = JSON.parse(init?.body || '{}').customListDefId; return json(search(id === 77128 ? [listRow] : [])); }
    if (/\/stop\/info\//.test(url)) { stopInfo.push(url); return json({}); }   // the re-read misses again
    if (url.includes(':runQuery')) return json([]);                               // customer rollup reads: none
    throw new Error('unexpected vendor call: ' + url);
  });
  try {
    const res = await runRefreshStops(new Request('https://x.netlify.app/.netlify/functions/nuvizz-refresh-stops-background?manual=1', { method: 'POST' }));
    const j = await res.json();
    const board = await readStops('davis', today);
    return { ok: j.ok, s1: board.stops.find((s) => s.stopNbr === 'S1'), stopInfo: stopInfo.length };
  } finally { fake.restore(); }
}

test('a reconsigned order whose re-read was capped keeps its pin on the NEW building on the next scan', async () => {
  const r = await scanAfterMissedReread('30303|100');
  assert.equal(r.ok, true);
  assert.equal(r.s1.addr1, NEW.addr1);
  assert.deepEqual([r.s1.lat, r.s1.lng], [NEW.lat, NEW.lng], 'the pin is on the new address, not the registry\'s old building');
  assert.notEqual(r.s1.enriched, true, 'still owed its re-read, so a later scan tries again');
  assert.equal(r.stopInfo, 1, 'the re-read the reconsignment asked for is attempted');
});

test('the registry is still merged for an order whose address has not moved', async () => {
  const r = await scanAfterMissedReread('30084|2535');
  assert.equal(r.ok, true);
  assert.equal(r.s1.enriched, true);
  assert.equal(r.stopInfo, 0, 'no /stop/info for a PRO the registry already answers');
});

test('a registry record from before the signature existed is merged exactly as before', async () => {
  const r = await scanAfterMissedReread(undefined);
  assert.equal(r.s1.enriched, true);
  assert.equal(r.stopInfo, 0);
});

test('registryRecordForOtherAddress names only a record whose own list signature disagrees with the row', () => {
  assert.equal(registryRecordForOtherAddress({ addrListSig: '30084|2535' }, { addrListSig: '30303|100' }), true);
  assert.equal(registryRecordForOtherAddress({ addrListSig: '30084|2535' }, { addrListSig: '30084|2535' }), false);
  assert.equal(registryRecordForOtherAddress({ addrListSig: '30084|2535' }, {}), false, 'no signature on the record → no evidence');
  assert.equal(registryRecordForOtherAddress({ addrListSig: null }, { addrListSig: '30303|100' }), false, 'no address on the row → no evidence');
  assert.equal(registryRecordForOtherAddress({}, null), false);
});

test('NUVIZZ_REGISTRY_ADDRESS_GUARD=off puts the old merge back; anything malformed leaves the guard on', () => {
  const row = { addrListSig: '30084|2535' }, rec = { addrListSig: '30303|100' };
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' no ']) assert.equal(registryRecordForOtherAddress(row, rec, { NUVIZZ_REGISTRY_ADDRESS_GUARD: off }), false, `"${off}" turns it off`);
  for (const on of [undefined, '', 'on', 'true', '1', 'yes', 'offf', 'disable']) assert.equal(registryRecordForOtherAddress(row, rec, { NUVIZZ_REGISTRY_ADDRESS_GUARD: on }), true, `"${on}" leaves it on`);
});

test('with the guard switched off, the scan merges the registry record as it did before', async () => {
  process.env.NUVIZZ_REGISTRY_ADDRESS_GUARD = 'off';
  try {
    const r = await scanAfterMissedReread('30303|100');
    assert.equal(r.s1.enriched, true);
    assert.equal(r.stopInfo, 0);
  } finally { delete process.env.NUVIZZ_REGISTRY_ADDRESS_GUARD; }
});
