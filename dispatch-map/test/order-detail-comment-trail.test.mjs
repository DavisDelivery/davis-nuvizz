// test/order-detail-comment-trail.test.mjs — THE COMMENT TRAIL SAYS WHO WROTE EACH LINE, AND WHEN,
// NEWEST FIRST.
//
// Audit 2026-09-27 (client-lookup-account-libs-4). A rep opens a refused order in Stop lookup
// to answer "why was it refused". buildOrderDetail's comment reader looked for userName /
// createdTime — names no stored comment carries. The ONE producer of allComments,
// extractAllComments (lib/nuvizz-scan.mts), writes the StopComment shape: addedBy / addedOn.
// So every author and every time came back null, and the "newest first" sort compared empty
// strings and left NuVizz's order — the top line a rep reads as the latest note could be the
// oldest. The old fixture used the made-up shape, which is how it hid.
//
// This test feeds buildOrderDetail through the REAL producer: a raw NuVizz stop run through
// normalizeStop, so the shape cannot drift from what the scan stores.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStop } from '../netlify/functions/lib/nuvizz-scan.mts';
import { buildOrderDetail } from '../src/lib/stop-lookup.js';

// Three comments as NuVizz returns them, deliberately NOT in time order.
const raw = {
  stop: {
    stopNbr: '007174397', stopType: 'DO', shipmentNbr: '007174397',
    to: { address: { addr1: '5965 PEACHTREE CORS E', city: 'NORCROSS', state: 'GA', zip: '30071' } },
    comments: [
      { commentDescription: 'Called ahead, expecting it', cmtType: 'PRE_VISIT', commentTypeDescription: 'Pre-Visit', addedByName: 'FREDDY PEREZ', addedOn: '2026-09-15T08:05:00', accessLevels: ['DISPATCHER'], source: 'DAVIS DELIVERY' },
      { commentDescription: 'Refused - dock closed', cmtType: 'ORD_IN', commentTypeDescription: 'Order Instructions', addedByName: 'ENOCK AKYEA', addedOn: '2026-09-15T17:10:00', accessLevels: ['DRIVER'], source: 'DAVIS DELIVERY' },
      { commentDescription: 'Reattempt tomorrow AM', cmtType: 'ORD_IN', commentTypeDescription: 'Order Instructions', addedByName: 'DISPATCH', addedOn: '2026-09-15T12:30:00', accessLevels: ['DISPATCHER'], source: 'DAVIS DELIVERY' },
    ],
  },
};

test('a refused order opened in Stop lookup shows who wrote each comment and when, newest first', () => {
  const stored = normalizeStop(raw);
  assert.equal(stored.allComments.length, 3, 'the producer stored all three');
  assert.ok('addedBy' in stored.allComments[0] && 'addedOn' in stored.allComments[0], 'in the StopComment shape');

  const { comments } = buildOrderDetail(stored, { date: '2026-09-15', today: '2026-09-27' });
  assert.deepEqual(comments.map((c) => c.text), ['Refused - dock closed', 'Reattempt tomorrow AM', 'Called ahead, expecting it'],
    'the 17:10 comment is the one on top');
  assert.deepEqual(comments.map((c) => c.by), ['ENOCK AKYEA', 'DISPATCH', 'FREDDY PEREZ'], 'every author is named');
  assert.deepEqual(comments.map((c) => c.at), ['2026-09-15T17:10:00', '2026-09-15T12:30:00', '2026-09-15T08:05:00'], 'every time is kept');
  assert.equal(comments[0].kind, 'ORD_IN');
});
