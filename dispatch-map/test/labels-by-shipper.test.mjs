// test/labels-by-shipper.test.mjs — the Labels screen's endpoint, END TO END against the Firestore fake.
//
// label-shippers.test.mjs pins what a shipper IS and what a label row carries. This pins what the
// endpoint READS: the day's own board (masked, cancelled orders off, pickups never), the saved
// labels and the customer notes for the chosen shipper only — and that a read which FAILED is said
// rather than printed around. The fake throws on any fetch that is not Firestore, so `log.other`
// being empty is the proof that no NuVizz call was made.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { stopMatchKey } from '../src/lib/label-shippers.js';
import { labelDocId } from '../netlify/functions/order-labels.mts';
import { LABEL_STOP_FIELDS } from '../netlify/functions/lib/board-fields.mts';

const T = 'davis';
const D = '2026-09-24';
const call = async (qs) => {
  const handler = (await import('../netlify/functions/labels-by-shipper.mts')).default;
  const r = await handler(new Request(`https://x.netlify.app/.netlify/functions/labels-by-shipper?${qs}`));
  return { status: r.status, body: await r.json() };
};
const st = (stopNbr, extra = {}) => ({
  stopNbr, pro: stopNbr, stopType: 'DO', businessName: `CONSIGNEE ${stopNbr}`,
  addr1: '100 MAIN ST', city: 'ATLANTA', state: 'GA', zip: '30318',
  cartons: 1, volume: 1, weight: 500, scheduledFrom: `${D}T12:00:00`,
  normalizedStatus: 'SCHEDULED', routeName: 'NOR 2', driverName: 'ENOCK AKYEA', ...extra,
});
const board = (date, stops) => Object.fromEntries([
  [`nuvizz_stop_index/${T}__${date}`, { tenant: T, date, last_scanned_at: '2026-09-24T13:05:00Z', count: stops.length }],
  ...stops.map((s, i) => [`nuvizz_stop_index/${T}__${date}/stops/s${i}`, s]),
]);
const CANCELLED = { raw: { stopExecutionInfo: { cancellation: { cancelDTTM: '2026-09-23T20:00:00Z', reasonCode: 'CANCELLED' } } } };

const DAY = [
  st('ESTES-0538243875', { businessName: 'JOHN SMITH', cartons: 2, volume: 1, contact: { name: 'JOHN', phone: '4045550000' } }),
  st('ESTES-0538240000'),
  st('ESTES-0538249999', CANCELLED),                       // cancelled — the board's own rule takes it off
  st('AVRT-0170416694', { cartons: null, volume: null }), // no count on the Averitt feed
  st('SHP29379'),
  st('007163747'), st('007163748'),
  st('RA5732712', { stopType: 'PU' }),                    // a pickup — never labelled
];

test('THE DAY: who shipped what — barcode-less shippers first, cancelled and pickups off, nothing but Firestore', async () => {
  const fake = installFirestoreFake(board(D, DAY));
  try {
    const { status, body } = await call(`date=${D}`);
    assert.equal(status, 200);
    assert.equal(body.nuvizzCalls, 0);
    assert.equal(fake.log.other.length, 0, 'no non-Firestore call may be made');
    assert.deepEqual(body.shippers.map((s) => `${s.key}:${s.orders}`), ['ESTES:2', 'AVRT:1', 'SHP:1', 'ULINE:2']);
    assert.equal(body.shippers[1].name, 'Averitt');
    assert.equal(body.shippers[2].name, 'Puremaxx', 'Chad: "Shp is puremaxx"');
    assert.equal(body.cancelledOff, 1);
    assert.equal(body.pickups, 1);
    assert.equal(body.boardAt, '2026-09-24T13:05:00Z', 'the board\'s own scan time, so the screen can say how fresh it is');
    assert.equal(body.rows, undefined, 'no shipper asked, no rows read');
    // THE BOARD IS READ MASKED — a label screen must not pull ~70 lean fields for 800 orders.
    const m = fake.log.listMasks.find((x) => x.path === `nuvizz_stop_index/${T}__${D}/stops`);
    assert.deepEqual(m.mask.slice().sort(), LABEL_STOP_FIELDS.slice().sort());
    assert.ok(!fake.log.gets.some((p) => p.startsWith('customer_notes/') || p.startsWith('order_labels')), 'the summary reads no notes and no saved labels');
  } finally { fake.restore(); }
});

test('ONE SHIPPER: each order with its label — the dispatcher\'s address fix, the saved reference, the board\'s counts', async () => {
  const smith = DAY[0];
  const id = labelDocId(smith.stopNbr);
  const fake = installFirestoreFake({
    ...board(D, DAY),
    [`customer_notes/${stopMatchKey(smith)}`]: {
      address_override: { addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336' },
      contacts: [{ name: 'RAY', phone: '7705551212' }],
      receiving_hours: 'never read by a label',
    },
    [`order_labels_by_stop/${T}__${id}`]: { stopNbr: smith.stopNbr, date: '2026-09-23' },
    [`order_labels/${T}__2026-09-23/labels/${id}`]: { stopNbr: smith.stopNbr, ref: 'EST-PO-77', dispatchNotes: 'Call ahead', origin: { name: 'DAVIS' }, pallets: '9', source: 'manifest' },
  });
  try {
    const { body } = await call(`date=${D}&shipper=estes`);
    assert.equal(fake.log.other.length, 0);
    assert.deepEqual(body.shipper, { key: 'ESTES', name: 'Estes' }, 'the key is case-insensitive');
    assert.deepEqual(body.rows.map((r) => r.stopNbr), ['ESTES-0538240000', 'ESTES-0538243875'], 'number order; the cancelled one is not there');
    const r = body.rows.find((x) => x.stopNbr === 'ESTES-0538243875');
    assert.equal(r.label.addr1, '4200 WENDELL DR SW', 'the address fix prints, not NuVizz\'s address');
    assert.equal(r.label.ref, 'EST-PO-77');
    assert.equal(r.label.phone, '7705551212', 'the saved contact wins, as on the stop card');
    assert.equal(r.label.pallets, '2', 'the board\'s skid count, not the saved 9');
    assert.equal(r.pages, 3);
    assert.equal(r.fromSaved, true);
    assert.equal(r.addressFixed, true);
    assert.equal(body.pages, 3 + 2, 'the batch total a Print all would send');
    assert.deepEqual(body.errors, {});
    // Notes are read PROJECTED to the two fields a label uses.
    assert.ok(fake.log.gets.some((p) => p.startsWith('customer_notes/')));
  } finally { fake.restore(); }
});

test('A NOTES READ THAT FAILED IS SAID — the labels still come back, and the screen is told an address fix may be missing', async () => {
  const fake = installFirestoreFake(board(D, DAY));
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => (String(input?.url ?? input).includes('/documents/customer_notes/')
    ? new Response('{"error":"boom"}', { status: 500 })
    : inner(input, init));
  try {
    const { status, body } = await call(`date=${D}&shipper=ESTES`);
    assert.equal(status, 200);
    assert.equal(body.rows.length, 2, 'the board alone still makes every label');
    assert.match(body.errors.notes, /could not be read/);
    assert.match(body.errors.notes, /address a dispatcher fixed may print as NuVizz has it/);
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('an Averitt order with no count prints one page and says so; a pickup prefix lists nothing', async () => {
  const fake = installFirestoreFake(board(D, DAY));
  try {
    const avrt = await call(`date=${D}&shipper=AVRT`);
    assert.equal(avrt.body.rows.length, 1);
    assert.equal(avrt.body.rows[0].pages, 1);
    assert.equal(avrt.body.rows[0].countMissing, true);
    const before = fake.log.gets.length;
    const ra = await call(`date=${D}&shipper=RA`);
    assert.deepEqual(ra.body.rows, [], 'RA is all pickups that day');
    const none = await call(`date=2026-09-25&shipper=ESTES`);
    assert.deepEqual(none.body.shipper, { key: 'ESTES', name: 'Estes' }, 'a shipper with nothing that day keeps its name');
    assert.deepEqual(none.body.rows, []);
    // …and a pickup costs no reads either: nothing is looked up for an order that will not print.
    assert.ok(!fake.log.gets.slice(before).some((p) => p.startsWith('customer_notes/') || p.startsWith('order_labels')),
      'no saved label or note is read for a pickup');
  } finally { fake.restore(); }
});

test('a malformed date is refused; no date is today; an empty day is an empty list, not an error', async () => {
  const fake = installFirestoreFake({});
  try {
    assert.equal((await call('date=09/24/2026')).status, 400);
    const today = (await import('../netlify/functions/lib/firestore.mts')).etDayString();
    const { status, body } = await call('');
    assert.equal(status, 200);
    assert.equal(body.date, today);
    assert.deepEqual(body.shippers, []);
  } finally { fake.restore(); }
});

test('the board projection carries every field a label, the shipper rule and the cancel rule read', () => {
  for (const f of ['stopNbr', 'pro', 'businessName', 'addr1', 'addr2', 'city', 'state', 'zip', 'stopDetails',
    'scheduledFrom', 'cartons', 'volume', 'weight', 'contact', 'stopType', 'normalizedStatus', 'raw.stopExecutionInfo']) {
    assert.ok(LABEL_STOP_FIELDS.includes(f), `LABEL_STOP_FIELDS must carry ${f}`);
  }
});

test('ZERO NUVIZZ CALLS BY CONSTRUCTION — the endpoint imports nothing that could spend one', () => {
  const src = readFileSync(new URL('../netlify/functions/labels-by-shipper.mts', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .*?from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 5);
  for (const i of imports) assert.ok(!/nuvizz-(scan|request|list|loads|write|rwb)/.test(i), `must not import a vendor-calling module: ${i}`);
  assert.match(src, /nuvizzCalls: 0/);
  assert.match(src, /requireUser\(req, \{ role: 'viewer' \}\)/, 'printing a label is a read');
});
