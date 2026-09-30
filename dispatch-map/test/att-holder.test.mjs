// test/att-holder.test.mjs — v1.99.0: who had the order when it failed, from the day's */15 scans.
//
// Pins the rule in lib/att-holder.mts and the evening join that uses it (attributeAttempts), with
// the real cases that produced "Unknown" attempts: a route dispatched after the 8:30 freeze
// (CHRIS HEAD, 2026-09-25) and a "-1" copy listed beside its original (007174789, 2026-09-11).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nextHolders, holderFor, originalStopNbr, attHolderEnabled, isRoutedWithDriver,
} from '../netlify/functions/lib/att-holder.mts';
import { attributeAttempts } from '../netlify/functions/lib/attempts-core.mts';
import { recountManifest } from '../netlify/functions/lib/attempts-store.mts';

const T = (hhmm) => `2026-09-25T${hhmm}:00.000Z`;
const stop = (over = {}) => ({
  stopNbr: '007182021', shipmentNbr: '007182021', isPlanned: true,
  driverName: 'Chris Head', driverUserName: 'Chris Head', loadNbr: 'CHRIS HEAD', routeName: 'CHRIS HEAD',
  ...over,
});
const undispatched = stop({ driverName: null, driverUserName: null });
const unplannedAtt = stop({ shipmentNbr: 'ATT007182021', isPlanned: false, driverName: null, driverUserName: null, loadNbr: null, routeName: null });

test('route dispatched AFTER 8:30 (CHRIS HEAD, 09/25): the first scan that sees the driver records him', () => {
  // 8:30 — on the route, no driver yet: exactly the row the 8:30 freeze skips.
  let step = nextHolders(null, [undispatched], T('12:30'));
  assert.equal(step.changed, false, 'no driver, nothing to record');
  assert.deepEqual(step.holders, {});
  // 12:45 — dispatched to Chris Head.
  step = nextHolders(step.holders, [stop()], T('16:45'));
  assert.equal(step.changed, true);
  assert.equal(step.counts.recorded, 1);
  assert.equal(step.holders['007182021'].driverName, 'Chris Head');
  assert.equal(step.holders['007182021'].since, T('16:45'));
  // 5:58 PM — CS marks it ATT and unplans it. The record freezes on Chris Head.
  step = nextHolders(step.holders, [unplannedAtt], T('22:00'));
  assert.equal(step.counts.frozen, 1);
  assert.equal(step.holders['007182021'].driverName, 'Chris Head');
  assert.equal(step.holders['007182021'].frozenAt, T('22:00'));
});

test('an unchanged scan writes nothing — the day costs a write only when something moved', () => {
  const first = nextHolders(null, [stop()], T('16:45'));
  const again = nextHolders(first.holders, [stop()], T('17:00'));
  assert.equal(again.changed, false);
  assert.equal(again.holders['007182021'].since, T('16:45'), 'since is the first sighting, not the latest');
});

test('moved between drivers BEFORE it failed: the LAST driver is the one who had it at the door', () => {
  let step = nextHolders(null, [stop({ driverName: 'Tony Smith', driverUserName: 'Tony Smith', loadNbr: 'TONY', routeName: 'TONY' })], T('12:30'));
  step = nextHolders(step.holders, [stop()], T('14:00'));
  assert.equal(step.counts.moved, 1);
  step = nextHolders(step.holders, [unplannedAtt], T('22:00'));
  assert.equal(step.holders['007182021'].driverName, 'Chris Head');
});

test('frozen at the marker: a same-day re-plan onto another driver cannot overwrite who attempted it', () => {
  let step = nextHolders(null, [stop()], T('16:45'));
  step = nextHolders(step.holders, [unplannedAtt], T('22:00'));
  const replanned = stop({ shipmentNbr: 'ATT007182021', driverName: 'Joe Gibbs', driverUserName: 'Joe Gibbs', loadNbr: 'JOE', routeName: 'JOE' });
  const after = nextHolders(step.holders, [replanned], T('23:00'));
  assert.equal(after.changed, false);
  assert.equal(after.counts.held, 1);
  assert.equal(after.holders['007182021'].driverName, 'Chris Head');
});

test('a stop first seen ALREADY ATT-marked gets no record — whoever has it now is redelivering it', () => {
  // An earlier day's failure on today's board, routed to its redelivery driver.
  const redelivery = stop({ shipmentNbr: 'ATT007182021', driverName: 'Joe Gibbs', driverUserName: 'Joe Gibbs' });
  const step = nextHolders(null, [redelivery], T('16:45'));
  assert.equal(step.changed, false);
  assert.deepEqual(step.holders, {});
});

test('a stop missing from one scan keeps its record — absence from a pull is not evidence', () => {
  const first = nextHolders(null, [stop()], T('16:45'));
  const next = nextHolders(first.holders, [], T('17:00'));
  assert.equal(next.changed, false);
  assert.equal(next.holders['007182021'].driverName, 'Chris Head');
});

test('unplanned WITHOUT the marker keeps the last driver and does not freeze (it may yet go out)', () => {
  let step = nextHolders(null, [stop()], T('16:45'));
  step = nextHolders(step.holders, [stop({ isPlanned: false, driverName: null, driverUserName: null })], T('17:00'));
  assert.equal(step.changed, false);
  assert.equal(step.holders['007182021'].frozenAt, undefined);
});

test('the grace-held row with no load number does not churn the record between number and null', () => {
  let step = nextHolders(null, [stop({ nuvizzLoadNbr: 'DAVIS000204535' })], T('16:45'));
  step = nextHolders(step.holders, [stop({ nuvizzLoadNbr: null })], T('17:00'));
  assert.equal(step.changed, false);
  assert.equal(step.holders['007182021'].nuvizzLoadNbr, 'DAVIS000204535');
});

test('the recording test is the 8:30 freeze\'s own: routed AND a driver', () => {
  assert.equal(isRoutedWithDriver(stop()), true);
  assert.equal(isRoutedWithDriver(undispatched), false);
  assert.equal(isRoutedWithDriver(stop({ isPlanned: false })), false);
  assert.equal(isRoutedWithDriver(stop({ driverName: null, driverUserName: 'CHEAD' })), true);
});

test('holderFor: a "-1" copy with no record of its own answers from its original stop, and says so', () => {
  const holders = { '007174789': { driverName: 'Trevarr Howard', driverKey: 'TREVARR_HOWARD', since: 'x', frozenAt: 'y' } };
  assert.equal(originalStopNbr('007174789-1'), '007174789');
  const direct = holderFor(holders, '007174789');
  assert.equal(direct.via, 'stop');
  const copy = holderFor(holders, '007174789-1');
  assert.equal(copy.via, 'original');
  assert.equal(copy.rec.driverName, 'Trevarr Howard');
  assert.equal(holderFor(holders, '007999999'), null);
  assert.equal(holderFor(null, '007174789'), null);
  // A copy WITH its own record answers from itself.
  const own = holderFor({ ...holders, '007174789-1': { driverName: 'Terrance Hawk', driverKey: 'T', since: 'z' } }, '007174789-1');
  assert.equal(own.via, 'stop');
  assert.equal(own.rec.driverName, 'Terrance Hawk');
});

test('NUVIZZ_ATT_HOLDER: on by default, off-words turn it off, a typo leaves it ON', () => {
  assert.equal(attHolderEnabled({}), true);
  for (const off of ['off', 'OFF', '0', 'false', 'no', ' off ']) assert.equal(attHolderEnabled({ NUVIZZ_ATT_HOLDER: off }), false, off);
  for (const on of ['on', '1', 'true', 'ofg', '']) assert.equal(attHolderEnabled({ NUVIZZ_ATT_HOLDER: on }), true, on);
});

// ── the evening join ─────────────────────────────────────────────────────────
const cur = (stopNbr, over = {}) => ({ stopNbr, shipmentNbr: `ATT${stopNbr.replace(/-\d+$/, '')}`, businessName: 'X', ...over });

test('join: the 8:30 freeze WINS wherever it has the stop — the record never re-attributes one', () => {
  const plan = new Map([['007181840', { stopNbr: '007181840', driverName: 'Anthony Kostner', driverUserName: 'Anthony Kostner', loadNbr: 'KOSTNER', routeName: 'KOSTNER' }]]);
  const holders = { '007181840': { driverName: 'Somebody Else', driverUserName: 'Somebody Else', driverKey: 'SOMEBODY_ELSE', loadNbr: 'X', routeName: 'X', since: 's' } };
  const [item] = attributeAttempts([cur('007181840')], plan, holders, '2026-09-25', 'd');
  assert.equal(item.originalDriverName, 'Anthony Kostner');
  assert.equal(item.attributedFrom, 'plan');
  assert.equal(item.matched, true);
});

test('join: where the freeze has nothing (dispatched after 8:30), the day\'s record names the driver', () => {
  const holders = { '007182021': { driverName: 'Chris Head', driverUserName: 'Chris Head', driverKey: 'CHRIS_HEAD', loadNbr: 'CHRIS HEAD', routeName: 'CHRIS HEAD', since: 's', frozenAt: 'f' } };
  const [item] = attributeAttempts([cur('007182021')], new Map(), holders, '2026-09-25', 'd');
  assert.equal(item.originalDriverName, 'Chris Head');
  assert.equal(item.originalLoadNbr, 'CHRIS HEAD');
  assert.equal(item.matched, true);
  assert.equal(item.attributedFrom, 'holder');
  assert.equal(item.holderFrozen, true);
});

test('join: a "-1" copy is attributed from its original\'s record and labelled as such', () => {
  const holders = { '007174789': { driverName: 'Trevarr Howard', driverUserName: 'Trevarr Howard', driverKey: 'TREVARR_HOWARD', loadNbr: 'LVILLE', routeName: 'LVILLE', since: 's', frozenAt: 'f' } };
  const items = attributeAttempts([cur('007174789'), cur('007174789-1')], new Map(), holders, '2026-09-11', 'd');
  assert.deepEqual(items.map((i) => [i.stopNbr, i.originalDriverName, i.attributedFrom]), [
    ['007174789', 'Trevarr Howard', 'holder'],
    ['007174789-1', 'Trevarr Howard', 'holder-original'],
  ]);
});

test('join: no record (switch off, absent or unreadable) is exactly the pre-v1.99.0 join — Unknown stays Unknown', () => {
  const [item] = attributeAttempts([cur('007179899')], new Map(), null, '2026-09-22', 'd');
  assert.equal(item.matched, false);
  assert.equal(item.originalDriverName, null);
  assert.equal(item.attributedFrom, null);
  assert.equal('holderFrozen' in item, false);
});

test('join: a row without the ATT marker is still dropped, record or not', () => {
  const holders = { '007182021': { driverName: 'Chris Head', driverKey: 'C', since: 's' } };
  assert.deepEqual(attributeAttempts([{ stopNbr: '007182021', shipmentNbr: '007182021' }], new Map(), holders, 'd', 'd'), []);
});

test('deleting an attempt recounts matchedByHolder with the rest; an old manifest does not grow it', () => {
  const prev = { counts: { attempts: 3, matched: 2, matchedByHolder: 1, unmatched: 1, candidates: 700 } };
  const survivors = [{ matched: true, attributedFrom: 'plan' }, { matched: false, attributedFrom: null }];
  const next = recountManifest(prev, survivors);
  assert.deepEqual(next.counts, { attempts: 2, matched: 1, matchedByHolder: 0, unmatched: 1, candidates: 700 });
  const old = recountManifest({ counts: { attempts: 1, matched: 1, unmatched: 0 } }, [{ matched: true }]);
  assert.equal('matchedByHolder' in old.counts, false);
});
