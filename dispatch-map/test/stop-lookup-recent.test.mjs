// The "Recent lookups" list on the Stop lookup screen — src/lib/stop-lookup-recent.js.
//
// A convenience, so the failures that matter are the quiet ones: the same search listed twice,
// a damaged stored value taking the screen down, a week-old search floating to the top as fresh,
// "yesterday" said about this morning.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECENT_MAX, recentKey, placeLabel, recentKindLabel, recentEntry, addRecent, parseRecent, recentAgo,
} from '../src/lib/stop-lookup-recent.js';

const AT = '2026-09-24T14:00:00.000Z'; // 10:00 AM Eastern

test('the same customer typed twice in different case and spacing is ONE row, moved to the top', () => {
  let list = [];
  list = addRecent(list, recentEntry({ kind: 'customer', term: 'earthly alternative', at: AT }));
  list = addRecent(list, recentEntry({ kind: 'order', term: '007174397', at: AT }));
  list = addRecent(list, recentEntry({ kind: 'customer', term: '  Earthly   ALTERNATIVE ', label: 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST', at: AT }));
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, 'customer');
  assert.equal(list[0].label, 'EARTHLY ALTERNATIVE DISTRIBUTION SOUTHEAST', 'the newer run carries the name the answer gave');
  assert.equal(list[1].term, '007174397');
});

test('an order and a customer with the same text are different searches', () => {
  // Kind is part of the identity: "12345" run as a PRO is not the same question as a name.
  assert.notEqual(recentKey({ kind: 'order', term: '12345' }), recentKey({ kind: 'customer', term: '12345' }));
});

test('a place is one search across case, spacing and state case', () => {
  const a = recentKey({ kind: 'place', place: { addr: '1100 Northside Dr', city: 'Atlanta', state: 'ga', zip: '' } });
  const b = recentKey({ kind: 'place', place: { addr: '1100  northside dr ', city: 'ATLANTA', state: 'GA' } });
  assert.equal(a, b);
  // …but a different city is a different search — Peachtree City is not Peachtree Corners.
  assert.notEqual(a, recentKey({ kind: 'place', place: { addr: '1100 Northside Dr', city: 'Sandy Springs', state: 'GA' } }));
});

test('nothing the screen would refuse to run is kept', () => {
  assert.equal(recentEntry({ kind: 'order', term: '   ' }), null);
  assert.equal(recentEntry({ kind: 'place', place: { state: 'GA' } }), null, 'a state alone is not a search');
  assert.equal(recentEntry({ kind: 'place', place: {} }), null);
  assert.equal(recentEntry({ kind: 'mystery', term: 'x' }), null);
  assert.deepEqual(addRecent([], null), []);
});

test(`at most ${RECENT_MAX} are kept, newest first`, () => {
  let list = [];
  for (let i = 0; i < RECENT_MAX + 4; i++) list = addRecent(list, recentEntry({ kind: 'order', term: `00717${i}`, at: AT }));
  assert.equal(list.length, RECENT_MAX);
  assert.equal(list[0].term, `00717${RECENT_MAX + 3}`);
});

test('a damaged stored value costs the list, never the screen', () => {
  assert.deepEqual(parseRecent('{not json'), []);
  assert.deepEqual(parseRecent('"a string"'), []);
  assert.deepEqual(parseRecent('{"kind":"order"}'), [], 'an object is not a list');
  assert.deepEqual(parseRecent(null), []);
  const raw = JSON.stringify([
    null, 7, 'x',
    { kind: 'order', term: '007174397', at: AT },
    { kind: 'order', term: '007174397 ', at: AT },                     // duplicate of the row above
    { kind: 'order', term: '007180114' },                             // no time — dropped, never "just now"
    { kind: 'order', term: '007180115', at: 'last tuesday' },          // unreadable time — dropped
    { kind: 'place', place: { city: 'Lawrenceville', state: 'ga' }, at: AT },
  ]);
  const out = parseRecent(raw);
  assert.deepEqual(out.map((e) => e.label), ['007174397', 'Lawrenceville GA']);
  assert.equal(out[1].place.state, 'GA');
});

test('places are labelled the way a person writes an envelope', () => {
  assert.equal(placeLabel({ addr: '1100 Northside Dr', city: 'Atlanta', state: 'ga', zip: '30318' }), '1100 Northside Dr, Atlanta GA 30318');
  assert.equal(placeLabel({ addr: '1100 Northside Dr' }), '1100 Northside Dr');
  assert.equal(placeLabel({ city: 'Lawrenceville', state: 'GA' }), 'Lawrenceville GA');
  assert.equal(placeLabel({ zip: '30318' }), 'ZIP 30318');
  assert.equal(recentKindLabel({ kind: 'place', place: { addr: '1 Main St', city: 'Atlanta' } }), 'Address');
  assert.equal(recentKindLabel({ kind: 'place', place: { city: 'Atlanta' } }), 'City');
  assert.equal(recentKindLabel({ kind: 'place', place: { zip: '30318' } }), 'ZIP');
  assert.equal(recentKindLabel({ kind: 'customer', term: 'x' }), 'Customer');
});

test('"yesterday" is a calendar word on Davis\'s clock, not 24 hours', () => {
  const now = Date.parse('2026-09-24T12:00:00Z'); // 8:00 AM Eastern, Sep 24
  assert.equal(recentAgo('2026-09-24T11:59:40Z', now), 'just now');
  assert.equal(recentAgo('2026-09-24T12:05:00Z', now), 'just now', 'a clock a little ahead is now, not the future');
  assert.equal(recentAgo('2026-09-24T11:54:00Z', now), '6 min ago');
  assert.equal(recentAgo('2026-09-24T09:00:00Z', now), '3 h ago', '5:00 AM Eastern the same day');
  // 11:00 PM Eastern on the 23rd is nine hours ago — and it is YESTERDAY, not "9 h ago".
  assert.equal(recentAgo('2026-09-24T03:00:00Z', now), 'yesterday');
  // 3:30 AM UTC on the 23rd is 11:30 PM Eastern on the 22nd: two calendar days back.
  assert.equal(recentAgo('2026-09-23T03:30:00Z', now), 'Sep 22');
  assert.equal(recentAgo('garbage', now), '');
});
