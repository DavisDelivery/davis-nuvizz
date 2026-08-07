// test/stop-card-sections.test.mjs
//
// Two stop-card defects Chad hit on one screenshot of a delivered VINCENT order:
// the route name printed twice, and no way to reach the delivery photos.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  routeLoadLine, podPhotoFetchOffer, podSectionVisible, isPodImageExt,
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

test('THE BUG: a delivered stop carrying only a BOL still offers the photo fetch', () => {
  // This is the exact screenshot — PROOF OF DELIVERY showing "BOL · PDF · 3:50 PM"
  // and nothing else. The old rule hid the fetch button as soon as ANY document
  // existed, so the driver's capture photos became unreachable on precisely the
  // orders most likely to have them.
  const stop = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }] };
  const r = podPhotoFetchOffer(stop, { delivered: true });
  assert.equal(r.offer, true, 'the button must be reachable');
  assert.equal(r.photos.length, 0);
  assert.equal(r.others.length, 1, 'the BOL still renders alongside it');
});

test('once photos are on file the fetch button goes away', () => {
  const stop = { podDocs: [
    { documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' },
    { documentName: 'capture', extension: 'JPG', documentGuid: 'g2' },
  ] };
  const r = podPhotoFetchOffer(stop, { delivered: true });
  assert.equal(r.offer, false);
  assert.equal(r.photos.length, 1);
  assert.equal(r.others.length, 1, 'the BOL is not swallowed by the photo grid');
});

test('a stop with no documents at all still offers the fetch once delivered', () => {
  assert.equal(podPhotoFetchOffer({ podDocs: [] }, { delivered: true }).offer, true);
  assert.equal(podPhotoFetchOffer({}, { delivered: true }).offer, true, 'missing podDocs is not a crash');
});

test('an undelivered stop never offers a fetch — there is nothing captured yet', () => {
  assert.equal(podPhotoFetchOffer({ podDocs: [] }, { delivered: false }).offer, false);
  const withBol = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }] };
  assert.equal(podPhotoFetchOffer(withBol, { delivered: false }).offer, false);
});

test('"none on file" is only said AFTER a pull came back empty', () => {
  const stop = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }] };
  assert.equal(podPhotoFetchOffer(stop, { delivered: true }).exhausted, false, 'not asked yet ≠ none exist');
  assert.equal(podPhotoFetchOffer(stop, { delivered: true, tried: true }).exhausted, true);
});

test('section visibility: hidden only when undelivered AND documentless', () => {
  assert.equal(podSectionVisible({ podDocs: [] }, { delivered: false }), false);
  assert.equal(podSectionVisible({ podDocs: [] }, { delivered: true }), true);
  const withBol = { podDocs: [{ documentName: 'BOL', extension: 'PDF', documentGuid: 'g1' }] };
  assert.equal(podSectionVisible(withBol, { delivered: false }), true, 'a BOL is worth showing either way');
});
