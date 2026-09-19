// test/stop-lookup-prompted.test.mjs — THE PROMPTED CALL: one NuVizz call, on request, and
// every rule around when it may be spent and what happens with the answer.
//
// Chad, 2026-09-19: "if it's a specific customer pro or date range that is not in the
// firestore data allow a prompted nuvizz call." The rules are pure (src/lib/stop-lookup.js)
// and the endpoint is the one door that spends (netlify/functions/stop-lookup-prompted.mts).
// The Firestore fake's `onOther` is the vendor here; `fake.log.other` is the exact count of
// calls that went out, so "nuvizzCalls" in every answer is checked against what HAPPENED.

import crypto from 'node:crypto';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';
delete process.env.FIRESTORE_DATABASE;
delete process.env.AUTH_REQUIRED;
process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.NUVIZZ_SCANS_ENABLED;
delete process.env.STOP_LOOKUP_PROMPTED_CALL;
delete process.env.PRO_INDEX;

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import {
  switchOn, promptedCallAvailability, promptedRecordDay, promptedStoreDecision, promptedRecord, promptedOutcome, promptedSource,
} from '../src/lib/stop-lookup.js';
import { scansEnabled } from '../netlify/functions/lib/nuvizz-scan.mts';

const T = 'davis';
const FN = 'https://x.netlify.app/.netlify/functions/stop-lookup-prompted';
const today = async () => (await import('../netlify/functions/lib/firestore.mts')).etDayString();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** A /stop/info answer in the wrapper shape lookupStopByPro unwraps ({ Stop: { stop, stopExecutionInfo, load } }). */
const vendorStop = (stopNbr, over = {}) => ({ Stop: {
  stop: {
    stopNbr, shipmentNbr: stopNbr, stopType: 'DO', status: '90',
    to: {
      address: { name: 'EARTHLY ALTERNATIVE THE', addr1: '239 GRANT ST SE STE 104', city: 'ATLANTA', state: 'GA', zip: '30312' },
      schedule: { timeFrom: over.scheduledFrom ?? null, timeTo: null },
    },
    totalCartons: 2, totalPallets: 9, weight: 1200,
    reference1: 'PO-1', reference2: 'CR-1',
  },
  // execDeliveredDTTM reads to.confirmedDTTM; execArrivalDTTM reads to.arrivalDTTM.
  stopExecutionInfo: { stopStatus: '90', to: { arrivalDTTM: over.arrivalDTTM ?? null, confirmedDTTM: over.deliveredDTTM ?? null } },
  load: { loadNbr: 'DAVIS000203801', driverName: 'Theo Afunyah', driverUserName: 'THEO', routeName: 'ATL 5' },
} });

/** Seed, stub the vendor, call, restore. `vendor` answers every non-Firestore fetch. */
async function call(seed, qs, vendor) {
  const fake = installFirestoreFake(seed, vendor || (() => { throw new Error('vendor must not be called'); }));
  try {
    const handler = (await import('../netlify/functions/stop-lookup-prompted.mts')).default;
    const resp = await handler(new Request(`${FN}?${qs}`));
    return { fake, status: resp.status, body: await resp.json() };
  } finally { fake.restore(); }
}
const answers = (payload, status = 200) => async (url) => {
  assert.match(url, /\/stop\/info\//, 'the only vendor call allowed is /stop/info');
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
};

// ── the pure rules ────────────────────────────────────────────────────────────

test('switchOn is the house shape: default on, the off-words off, a typo leaves it ON', () => {
  for (const v of [undefined, '', 'on', '1', 'true', 'yes', 'of', 'fasle', 'disabled']) assert.equal(switchOn(v), true, `${v} → on`);
  for (const v of ['off', '0', 'false', 'no', 'OFF', ' No ']) assert.equal(switchOn(v), false, `${v} → off`);
});

test('availability: mirror wins, then the prompted call switch, then the scans switch — each with its own sentence', () => {
  assert.equal(promptedCallAvailability({ mirror: true, promptedSwitch: 'on' }).reason, 'mirror');
  assert.equal(promptedCallAvailability({ promptedSwitch: 'off' }).reason, 'switch');
  assert.equal(promptedCallAvailability({ scansSwitch: 'false' }).reason, 'scans');
  const ok = promptedCallAvailability({});
  assert.equal(ok.available, true);
  assert.match(ok.text, /1 call/);
});

test('THE SCANS SWITCH IS READ THE SAME WAY scansEnabled() READS IT — only the literal false turns it off', () => {
  // Re-derived in the pure module so stop-lookup.mts can stay vendor-import-free; this pins
  // that the two readings cannot drift.
  const saved = process.env.NUVIZZ_SCANS_ENABLED;
  try {
    for (const v of ['false', 'true', '0', 'off', '', 'FALSE', 'no']) {
      process.env.NUVIZZ_SCANS_ENABLED = v;
      const theirs = scansEnabled();
      const ours = promptedCallAvailability({ scansSwitch: v }).available;
      assert.equal(ours, theirs, `NUVIZZ_SCANS_ENABLED=${JSON.stringify(v)}: prompted call ${ours} vs scansEnabled ${theirs}`);
    }
  } finally { if (saved === undefined) delete process.env.NUVIZZ_SCANS_ENABLED; else process.env.NUVIZZ_SCANS_ENABLED = saved; }
});

test('the record day: delivered, else arrived, else planned ETA, else the window — else null', () => {
  assert.equal(promptedRecordDay({ deliveredDTTM: '2026-09-10T13:44', arrivalDTTM: '2026-09-11T09:00' }), '2026-09-10');
  assert.equal(promptedRecordDay({ arrivalDTTM: '2026-09-11T09:00' }), '2026-09-11');
  assert.equal(promptedRecordDay({ plannedEtaDTTM: '2026-09-12T09:00' }), '2026-09-12');
  assert.equal(promptedRecordDay({ scheduledFrom: '2026-09-13T08:00:00' }), '2026-09-13');
  assert.equal(promptedRecordDay({ scheduledFrom: 'garbage' }), null);
  assert.equal(promptedRecordDay(null), null);
});

test('FILE PAST DAYS ONLY: today and the future are shown, not filed; no day is shown, not filed', () => {
  assert.equal(promptedStoreDecision({ day: '2026-09-10', today: '2026-09-19' }).store, true);
  assert.equal(promptedStoreDecision({ day: '2026-09-19', today: '2026-09-19' }).store, false);
  assert.equal(promptedStoreDecision({ day: '2026-09-25', today: '2026-09-19' }).reason, 'live');
  assert.equal(promptedStoreDecision({ day: null, today: '2026-09-19' }).reason, 'no-day');
  assert.equal(promptedStoreDecision({ day: '2026-09-10', today: null }).store, false, 'no clock → never file');
});

test('the filed record carries the day, the customer key and honest provenance', () => {
  const r = promptedRecord({ stopNbr: '007180002', customerMatchKey: 'stale' }, { day: '2026-09-10', at: '2026-09-19T03:00:00Z', by: 'tina', matchKey: 'fresh' });
  assert.equal(r.date, '2026-09-10');
  assert.equal(r.customerMatchKey, 'fresh');
  assert.equal(r.prompted, true);
  assert.equal(r.prompted_by, 'tina');
  assert.equal(r.prompted_from, 'stop-lookup');
  assert.equal(promptedRecord({ stopNbr: '1', customerMatchKey: 'kept' }, { day: 'x' }).customerMatchKey, 'kept');
});

test('the outcome says whether a call was SPENT: a breaker/kill-switch refusal is not a charge', () => {
  assert.deepEqual([promptedOutcome({ ok: true, stop: {} }).ok, promptedOutcome({ ok: true, stop: {} }).spent], [true, true]);
  assert.equal(promptedOutcome({ ok: false, reason: 'scans_disabled' }).spent, false);
  assert.equal(promptedOutcome({ ok: false, reason: 'NuVizz circuit breaker open — refusing /stop/info (DAVIS)' }).reason, 'breaker');
  assert.equal(promptedOutcome({ ok: false, reason: 'NuVizz circuit breaker open — refusing /stop/info (DAVIS)' }).spent, false);
  assert.equal(promptedOutcome({ ok: false, reason: 'http_404' }).reason, 'not_found');
  assert.equal(promptedOutcome({ ok: false, reason: 'http_404' }).spent, true);
  assert.equal(promptedOutcome({ ok: false, reason: 'not_found' }).reason, 'not_found');
  assert.equal(promptedOutcome({ ok: false, reason: 'http_500' }).reason, 'error');
  assert.equal(promptedOutcome(null).reason, 'error');
});

test('the ledger row for a prompted answer is a FOUND row that names its price', () => {
  const r = promptedSource({ day: '2026-09-10' });
  assert.equal(r.key, 'nuvizz');
  assert.equal(r.state, 'found');
  assert.match(r.note, /one call/);
  assert.match(promptedSource({}).note, /no delivery day/);
});

// ── the endpoint ──────────────────────────────────────────────────────────────

test('A PAST ORDER NUVIZZ HAS: exactly one call, FILED in the warehouse with a pointer, answered as found', async () => {
  const t = await today();
  const day = addDays(t, -9);
  const { fake, body } = await call({}, 'stop=7180002', answers(vendorStop('007180002', { deliveredDTTM: `${day}T13:44:00`, arrivalDTTM: `${day}T13:29:00` })));
  assert.equal(body.ok, true);
  assert.equal(body.nuvizzCalls, 1);
  assert.equal(fake.log.other.length, 1, 'EXACTLY one vendor call went out');
  assert.equal(body.prompted.attempted, true);
  assert.equal(body.prompted.ok, true);
  assert.equal(body.prompted.day, day);
  assert.equal(body.prompted.decision, 'past');
  assert.equal(body.prompted.stored.ok, true);
  assert.equal(body.prompted.stored.created, true);
  assert.equal(body.prompted.stored.pointer, true);
  // the warehouse record, under NuVizz's zero-padded id, with provenance
  const rec = fake.store.get(`history_days/${T}__${day}/stops/007180002`);
  assert.ok(rec, 'filed under its delivery day');
  assert.equal(rec.prompted, true);
  assert.equal(rec.prompted_from, 'stop-lookup');
  assert.equal(rec.date, day);
  assert.ok(rec.customerMatchKey, 'the customer key the nightly would have stamped');
  // the pointer, so ?stop= finds it outside the board window
  const ptr = [...fake.store.keys()].find((k) => k.startsWith('history_pros/'));
  assert.ok(ptr, 'a PRO-index pointer was written');
  assert.equal(fake.store.get(ptr).days[0].date, day);
  // and the answer renders like any other found order
  assert.equal(body.dossier.found, true);
  assert.equal(body.dossier.days[0].date, day);
  assert.equal(body.dossier.days[0].driver, 'Theo Afunyah');
  assert.equal(body.dossier.sources[0].key, 'nuvizz');
  assert.equal(body.detail.source, 'nuvizz');
  assert.equal(body.detail.stop.driver, 'Theo Afunyah');
});

test('TODAY\'S ORDER: one call, shown, NOT filed — the board scan owns today', async () => {
  const t = await today();
  const { fake, body } = await call({}, 'stop=7180003', answers(vendorStop('007180003', { scheduledFrom: `${t}T08:00:00` })));
  assert.equal(body.nuvizzCalls, 1);
  assert.equal(body.prompted.ok, true);
  assert.equal(body.prompted.decision, 'live');
  assert.equal(body.prompted.stored, null);
  assert.equal([...fake.store.keys()].some((k) => k.startsWith('history_days/')), false, 'nothing filed');
  assert.equal([...fake.store.keys()].some((k) => k.startsWith('history_pros/')), false, 'no pointer');
  assert.equal(body.dossier.found, true, 'still rendered as found');
});

test('NEVER SPEND ON AN ORDER WE HOLD: a PRO-index hit answers "on file" with ZERO calls', async () => {
  const { fake, body } = await call({
    [`history_pros/${T}__n_7174397`]: { key: 'n_7174397', pro: '007174397', days: [{ date: '2026-09-15', pro: '007174397', matchKey: 'k', name: 'X' }] },
  }, 'stop=007174397');
  assert.equal(body.nuvizzCalls, 0);
  assert.equal(fake.log.other.length, 0);
  assert.equal(body.prompted.attempted, false);
  assert.equal(body.prompted.reason, 'on-file');
  assert.deepEqual(body.prompted.days, ['2026-09-15']);
});

test('NUVIZZ HAS NOTHING EITHER: one call, an honest sentence, nothing filed', async () => {
  const { fake, body } = await call({}, 'stop=999999999', answers({ error: 'no such stop' }, 404));
  assert.equal(body.nuvizzCalls, 1);
  assert.equal(fake.log.other.length, 1);
  assert.equal(body.prompted.attempted, true);
  assert.equal(body.prompted.ok, false);
  assert.equal(body.prompted.reason, 'not_found');
  assert.match(body.prompted.text, /no order by this number/);
  assert.equal([...fake.store.keys()].some((k) => k.startsWith('history_days/')), false);
});

test('STOP_LOOKUP_PROMPTED_CALL=off: refused before the wire, zero calls, the switch named', async () => {
  process.env.STOP_LOOKUP_PROMPTED_CALL = 'off';
  try {
    const { fake, body } = await call({}, 'stop=7180002');
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(fake.log.other.length, 0);
    assert.equal(body.prompted.attempted, false);
    assert.equal(body.prompted.reason, 'switch');
    assert.equal(body.promptedCall.available, false);
  } finally { delete process.env.STOP_LOOKUP_PROMPTED_CALL; }
});

test('NUVIZZ_SCANS_ENABLED=false: the site-wide kill switch is honoured, zero calls', async () => {
  process.env.NUVIZZ_SCANS_ENABLED = 'false';
  try {
    const { fake, body } = await call({}, 'stop=7180002');
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(fake.log.other.length, 0);
    assert.equal(body.prompted.reason, 'scans');
  } finally { delete process.env.NUVIZZ_SCANS_ENABLED; }
});

test('A SEALED RECORD ALREADY THERE IS NEVER OVERWRITTEN — the create is atomic and loses', async () => {
  // The PRO index does not know this day (a pre-index seal), so the endpoint spends the call;
  // the warehouse already holds the sealed record, so createDocIfAbsent must lose to it.
  const t = await today();
  const day = addDays(t, -9);
  const sealedPath = `history_days/${T}__${day}/stops/007180002`;
  const { fake, body } = await call({ [sealedPath]: { stopNbr: '007180002', date: day, sealed_marker: 'keep me' } },
    'stop=7180002', answers(vendorStop('007180002', { deliveredDTTM: `${day}T13:44:00` })));
  assert.equal(body.nuvizzCalls, 1);
  assert.equal(body.prompted.stored.created, false, 'the create lost to the sealed record');
  assert.equal(fake.store.get(sealedPath).sealed_marker, 'keep me', 'the sealed record is byte-for-byte untouched');
});

test('no ?stop= is a 400, and it spends nothing', async () => {
  const { fake, status } = await call({}, 'stop=');
  assert.equal(status, 400);
  assert.equal(fake.log.other.length, 0);
});
