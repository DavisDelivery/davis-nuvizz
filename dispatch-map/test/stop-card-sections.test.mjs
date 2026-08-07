// test/stop-card-sections.test.mjs
//
// Two stop-card defects Chad hit on one screenshot of a delivered VINCENT order:
// the route name printed twice, and no way to reach the delivery photos.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  routeLoadLine, podPhotoFetchOffer, podSectionVisible, isPodImageExt, foldFreshStop,
} from '../src/lib/stop-card-sections.js';

// ── ROUTE section ────────────────────────────────────────────────────────────

test('a route named after its own load prints the identifier ONCE', () => {
  assert.equal(routeLoadLine({ routeName: 'VINCENT', loadNbr: 'VINCENT' }), null);
  assert.equal(routeLoadLine({ routeName: 'VINCENT', loadNbr: ' vincent ' }), null,
    'case and padding do not make it a different identifier');
});

test('a load number that differs from the route name is still shown', () => {
  assert.equal(routeLoadLine({ routeName: 'SUW 4', loadNbr: '047-54019' }), '047-54019');
  assert.equal(routeLoadLine({ routeName: 'VINCENT', loadNbr: 'VINCENT 2' }), 'VINCENT 2');
});

test('no route name ⇒ no second line (the bold line already IS the load number)', () => {
  assert.equal(routeLoadLine({ routeName: null, loadNbr: '047-54019' }), null);
  assert.equal(routeLoadLine({ routeName: '', loadNbr: '047-54019' }), null);
});

test('a missing load number never renders an empty line', () => {
  assert.equal(routeLoadLine({ routeName: 'SUW 4', loadNbr: null }), null);
  assert.equal(routeLoadLine({ routeName: 'SUW 4', loadNbr: '   ' }), null);
  assert.equal(routeLoadLine(null), null);
});

// ── PROOF OF DELIVERY ────────────────────────────────────────────────────────

test('isPodImageExt: capture photos are images, a signed BOL is not', () => {
  for (const ext of ['jpg', 'JPEG', 'png', 'gif', 'webp']) assert.ok(isPodImageExt(ext), ext);
  for (const ext of ['pdf', 'PDF', 'doc', '', null, undefined]) assert.ok(!isPodImageExt(ext), String(ext));
});

test('GATE 1: a stop carrying only a BOL still offers the photo fetch', () => {
  // PROOF OF DELIVERY showing "BOL · PDF · 3:50 PM" and nothing else. The first
  // rule hid the button as soon as ANY document existed, so the driver's capture
  // photos became unreachable on precisely the orders most likely to have them.
  const stop = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }] };
  const r = podPhotoFetchOffer(stop);
  assert.equal(r.offer, true, 'the button must be reachable');
  assert.equal(r.photos.length, 0);
  assert.equal(r.others.length, 1, 'the BOL still renders alongside it');
});

test('GATE 2: a stop our board still reads SCHEDULED must STILL offer the fetch', () => {
  // The second failure, and the reason there is no status gate at all now. The
  // status the card trusts (normalizedStatus) is refreshed from the cheap
  // saved-search list, and deliveredDTTM is NOT a live list field — so an order
  // delivered in NuVizz, with a signed BOL stamped 6:01 PM, can sit on our board
  // classified SCHEDULED. Gating on "delivered" hid the button exactly when the
  // board was stale, which is when a dispatcher most wants to ask.
  const stop = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }] };
  assert.equal(podPhotoFetchOffer(stop).offer, true,
    'asking NuVizz must never depend on our own status being current');
  assert.equal(podPhotoFetchOffer({ podDocs: [] }).offer, true, 'no documents at all: still ask');
  assert.equal(podPhotoFetchOffer({}).offer, true, 'missing podDocs is not a crash');
});

test('once photos are on file the fetch button goes away', () => {
  const stop = { podDocs: [
    { documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' },
    { documentName: 'capture', extension: 'JPG', documentGuid: 'g2' },
  ] };
  const r = podPhotoFetchOffer(stop);
  assert.equal(r.offer, false, 'nothing left to ask for');
  assert.equal(r.photos.length, 1);
  assert.equal(r.others.length, 1, 'the BOL is not swallowed by the photo grid');
});

test('"none on file" is only said AFTER a pull came back empty', () => {
  const stop = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }] };
  assert.equal(podPhotoFetchOffer(stop).exhausted, false, 'not asked yet \u2260 none exist');
  assert.equal(podPhotoFetchOffer(stop, { tried: true }).exhausted, true);
});

test('section visibility: hidden only for an UNPLANNED order with no documents', () => {
  assert.equal(podSectionVisible({ podDocs: [] }, { unplanned: true }), false);
  assert.equal(podSectionVisible({ podDocs: [] }, { unplanned: false }), true);
  const withBol = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }] };
  assert.equal(podSectionVisible(withBol, { unplanned: true }), true, 'a BOL is worth showing either way');
});

// ── folding a refresh over the open card ─────────────────────────────────────

test('a pull that returns NO documents must not erase the BOL on screen', () => {
  // "You ask for more and get less." The client folded a refresh with a raw
  // spread, and normalizeStop always emits a podDocs key — so a stop whose pull
  // came back documentless wiped the BOL the dispatcher was looking at.
  const card = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }], custName: 'CURANT' };
  const folded = foldFreshStop(card, { podDocs: [], normalizedStatus: 'DELIVERED' });
  assert.equal(folded.podDocs.length, 1, 'the BOL survives');
  assert.equal(folded.normalizedStatus, 'DELIVERED', 'real values still fold in');
});

test('a pull that DOES return documents replaces the list', () => {
  const card = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }] };
  const fresh = [
    { documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' },
    { documentName: 'delivery', extension: 'JPG', documentGuid: 'g2' },
  ];
  assert.equal(foldFreshStop(card, { podDocs: fresh }).podDocs.length, 2);
});

test('foldFreshStop skips empty scalars but keeps falsy values that mean something', () => {
  const prev = { a: 'keep', n: 5, flag: true };
  const out = foldFreshStop(prev, { a: '', n: null, flag: false, b: undefined, c: 0 });
  assert.equal(out.a, 'keep', 'empty string never clobbers');
  assert.equal(out.n, 5, 'null never clobbers');
  assert.equal(out.b, undefined, 'undefined is not copied in');
  assert.equal(out.flag, false, 'false is a real value and DOES fold');
  assert.equal(out.c, 0, 'zero is a real value and DOES fold');
});

test('foldFreshStop tolerates missing sides', () => {
  assert.deepEqual(foldFreshStop(null, { a: 1 }), { a: 1 });
  assert.deepEqual(foldFreshStop({ a: 1 }, null), { a: 1 });
});
