// pro-segment-suffix.test.mjs — A5-S30-1.
//
// The board's stop number is often the 9-digit Uline PRO plus a segment number:
// "007157687-1". The label on the freight carries the bare PRO, 7157687. The
// match key was "last 7 digits of everything", so the segment digit was dragged
// in and the stop's key came out 1576871 — a PRO that is not this freight. The
// loader scanned the right skid for the right stop and got RED, "not on this
// load". dispatch-map already strips that suffix (manifest-reconcile proKeys);
// this is the same narrow rule on the dock side, server and phone together.

import test from 'node:test';
import assert from 'node:assert/strict';

const server = await import('../netlify/functions/lib/manifest.mts');
const phone = await import('../src/lib/scan-logic.js');

test('a segment-suffixed stop number keys to the PRO printed on its label', () => {
  assert.equal(server.normalizePro('007157687-1'), '7157687');
  assert.equal(server.normalizePro('007157687-12'), '7157687', 'a two-digit segment too');
  assert.deepEqual(
    server.prosFor({ stopNbr: '007157687-1', pros: ['007157687-1'], primaryPro: '007157687-1' }),
    ['7157687'],
    'the index writes the stop number into pros and primaryPro as well',
  );
});

test('the loader scanning the right skid for a segment-suffixed stop gets GREEN, not RED', () => {
  const stop = server.toManifestStop({ stopNbr: '007157687-1', loadNbr: 'STEVEN', pros: ['007157687-1'], primaryPro: '007157687-1', pallets: 2, cartons: 2, volume: 0, businessName: 'ACME' });
  const r = phone.evaluateScan({ pro: '7157687', og: 'OG0000000001' }, [stop], new Set());
  assert.equal(r.outcome, phone.OUTCOME.GREEN);
  assert.equal(r.stop?.stopNbr, '007157687-1');
  // And the phone counts the piece on that stop.
  const p = phone.stopProgress(stop, [{ og: 'OG0000000001', pro: '7157687', stopNbr: '007157687-1' }]);
  assert.equal(p.scanned, 1);
});

test('typing the stop number exactly as the screen shows it still finds the stop', () => {
  const stop = server.toManifestStop({ stopNbr: '007157687-1', pros: ['007157687-1'] });
  const typed = phone.normalizePro('007157687-1');
  assert.ok((stop.pros || []).some((p) => phone.normalizePro(p) === typed));
});

test('the phone and the server key every shape the same way', () => {
  for (const v of ['007157687-1', '007157687-12', '007157687', '7157687', '028-8347656', 'AVRT-0170416694', 'ESTES-0538243875', 'SHP29379', '', null]) {
    assert.equal(phone.normalizePro(v), server.normalizePro(v), JSON.stringify(v));
  }
});

test('shapes that are not a 9-digit PRO plus a short segment are keyed exactly as before', () => {
  // Estes formats a 10-digit PRO with a dash; that dash is not a segment.
  assert.equal(server.normalizePro('028-8347656'), '8347656');
  assert.equal(server.normalizePro('007157687'), '7157687');
  assert.equal(server.normalizePro('7157687'), '7157687');
  assert.equal(server.normalizePro('AVRT-0170416694'), '0416694');
  assert.equal(server.normalizePro('007157687-123'), '7687123', 'a 3-digit tail is not the segment rule');
  assert.equal(server.normalizePro(''), '');
});
