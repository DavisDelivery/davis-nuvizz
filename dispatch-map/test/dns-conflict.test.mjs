// A DRIVER SENT WHERE A DISPATCHER SAID NOT TO SEND HIM.
//
// Chad: "if we send a driver to a stop that they are marked do not send and we have sent a
// driver to it."
//
// DNS is about PEOPLE, not freight — the note carries `do_not_send` plus `dns_drivers`, a
// list a dispatcher builds by tapping names under "Drivers not allowed". A blank list is a
// general do-not-send; a filled one bars exactly those drivers.
//
// The failure this prevents is not a late delivery. A customer asked for a specific person
// not to come back, usually after something went wrong, and sending them again is the kind of
// mistake that ends an account. It is knowable the moment the load is built.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags, dnsConflict, stopDriver } from '../src/lib/board-flags.js';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DATE = '2026-09-01';

const stop = (over = {}) => ({
  stopNbr: '1001', businessName: 'ACME', addr1: '1 Main', city: 'Buford',
  lat: 34.10, lng: -84.00, matchKey: 'acme',
  normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'BEN 1', routeName: 'BEN 1', routeSeq: 3, stopType: 'DO',
  driverName: 'Ben Paintsil',
  ...over,
});

const run = (stops, notesObj = {}) => computeBoardFlags({
  stops, notes: new Map(Object.entries(notesObj)), rosterRows: [],
  servedDate: DATE, dayKey: 'tue',
  opts: { depot: DEPOT, departMin: 8 * 60 },
});
const dnsRows = (out) => (out.rows || []).filter((r) => r.rule === 'dns_conflict');

// ── the matcher ─────────────────────────────────────────────────────────────

test('a general do-not-send bars whoever is on the load', () => {
  const c = dnsConflict({ do_not_send: true }, stop());
  assert.equal(c.barred, true);
  assert.equal(c.general, true);
});

test('a NAMED list bars only the drivers on it', () => {
  const note = { do_not_send: true, dns_drivers: ['Ben Paintsil'] };
  assert.equal(dnsConflict(note, stop({ driverName: 'Ben Paintsil' })).barred, true);
  assert.equal(dnsConflict(note, stop({ driverName: 'Allen Council' })).barred, false,
    'a driver nobody barred must not flag — that is the wall of noise this panel exists to avoid');
});

test('NuVizz double-spacing and casing do not defeat the match', () => {
  // "Brent  Bryd" vs "Brent Bryd" has already cost this repo a whole rule (v0.93.x).
  const note = { do_not_send: true, dns_drivers: ['brent bryd'] };
  assert.equal(dnsConflict(note, stop({ driverName: 'Brent  BRYD' })).barred, true);
});

test('it does NOT fuzzy-match beyond whitespace and case', () => {
  const note = { do_not_send: true, dns_drivers: ['Brent'] };
  assert.equal(dnsConflict(note, stop({ driverName: 'Brenda Hall' })).barred, false,
    'barring "Brent" must never fire on "Brenda"');
});

test('driverUserName stands in when NuVizz carries no display name', () => {
  assert.equal(stopDriver({ driverUserName: 'bpaintsil' }), 'BPAINTSIL');
  assert.equal(stopDriver({}), '', 'nobody assigned is an empty string, never "undefined"');
});

test('a note with the switch OFF bars nobody, whatever the list says', () => {
  const c = dnsConflict({ do_not_send: false, dns_drivers: ['Ben Paintsil'] }, stop());
  assert.equal(c.barred, false);
});

test('junk cannot crash it or invent a bar', () => {
  assert.equal(dnsConflict(null, stop()).barred, false);
  assert.equal(dnsConflict({ do_not_send: true, dns_drivers: 'not an array' }, stop()).barred, true,
    'a malformed list falls back to the GENERAL bar — the cautious side on a do-not-send');
  assert.equal(dnsConflict({ do_not_send: true, dns_drivers: [null, ''] }, stop()).barred, true,
    'an all-empty list is no list at all');
});

// ── the rule on a board ─────────────────────────────────────────────────────

test('a barred driver on the load is RED, and the row names him and the route', () => {
  const out = run([stop()], { acme: { do_not_send: true, dns_drivers: ['Ben Paintsil'] } });
  const rows = dnsRows(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'red');
  assert.match(rows[0].detail, /Ben Paintsil is on this customer's do-not-send list/);
  assert.match(rows[0].detail, /BEN 1 is taking it at stop 3/);
  assert.equal(rows[0].driverName, 'Ben Paintsil');
  assert.equal(rows[0].dnsGeneral, false);
});

test('a general DNS with a driver on it is RED and says nobody at all', () => {
  const out = run([stop()], { acme: { do_not_send: true } });
  const rows = dnsRows(out);
  assert.equal(rows[0].tier, 'red');
  assert.match(rows[0].detail, /no driver at all/);
  assert.equal(rows[0].dnsGeneral, true);
});

test('a general DNS planned with NOBODY on it yet is AMBER — still free to fix', () => {
  const out = run([stop({ driverName: null, driverUserName: null })], { acme: { do_not_send: true } });
  const rows = dnsRows(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'amber');
  assert.match(rows[0].detail, /no driver assigned yet/);
  assert.match(rows[0].detail, /goes red the moment somebody is put on it/);
});

test('a NAMED-driver DNS with no driver yet says NOTHING', () => {
  // Most drivers are fine there. A row on every driverless load at that customer is exactly
  // the wallpaper that makes the real flags invisible.
  const out = run([stop({ driverName: null })], { acme: { do_not_send: true, dns_drivers: ['Allen Council'] } });
  assert.equal(dnsRows(out).length, 0);
});

test('a customer with no DNS at all is silent', () => {
  assert.equal(dnsRows(run([stop()], { acme: { priority_flag: 'question' } })).length, 0);
  assert.equal(dnsRows(run([stop()], {})).length, 0, 'no note is not a do-not-send');
});

test('a DELIVERED stop is not flagged — the driver already resolved it', () => {
  const out = run([stop({ normalizedStatus: 'DELIVERED', status: '90' })], { acme: { do_not_send: true } });
  assert.equal(dnsRows(out).length, 0);
});

test('a PICKUP counts, unlike the hours rules', () => {
  // "Do not send this person to this customer" is about who turns up, not which direction
  // the pallets go.
  const out = run([stop({ stopType: 'PU' })], { acme: { do_not_send: true, dns_drivers: ['Ben Paintsil'] } });
  assert.equal(dnsRows(out).length, 1);
});

test('the rule needs no roster, no truck class and no travel model', () => {
  // Unlike the trailer conflict, this one can never be silently "not checked".
  const out = computeBoardFlags({
    stops: [stop()], notes: new Map([['acme', { do_not_send: true }]]),
    servedDate: DATE, dayKey: 'tue', opts: { depot: DEPOT },
  });
  assert.equal(dnsRows(out).length, 1);
});

test('two barred stops produce two rows, each dismissable on its own', () => {
  const out = run(
    [stop(), stop({ stopNbr: '1002', matchKey: 'beta', businessName: 'BETA' })],
    { acme: { do_not_send: true }, beta: { do_not_send: true } },
  );
  const rows = dnsRows(out);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].dismissKey, rows[1].dismissKey);
});

test('the row expires with the board day rather than standing', () => {
  // Who is on which load is a fact about TODAY; the DNS itself is standing, the pairing is not.
  const r = dnsRows(run([stop()], { acme: { do_not_send: true } }))[0];
  assert.equal(r.scope, 'occurrence');
  assert.match(r.fingerprint, new RegExp(`^dns\\\\|${DATE}\\\\|1001\\\\|`));
});
