// test/manifest-history-pdf-exception.test.mjs — the headerless PDF exception covers the PDF
// and nothing else (A5-S27-1).
//
// ?pdf=1 is left ungated on purpose: App.jsx hands `manifest-history?date=…&pdf=1` to an
// <a href> and to navigator.share, neither of which can carry a bearer token. But the
// exception was decided from the bare `pdf` parameter, while the PDF branch itself also needs
// a real date — so `?pdf=1` with no date (or with ?selftest=1 beside it) skipped the gate and
// fell through to the JSON branches: the full 30-night manifest history, the orders missing
// off each night, and the heal pass's writes. Now only a request the PDF branch will actually
// answer skips the gate.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AUTH_SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';
delete process.env.AUTH_REQUIRED;

import { installFirestoreFake } from './_firestore-fake.mjs';
import { _resetUserCacheForTests } from '../netlify/functions/lib/require-user.mts';
import history from '../netlify/functions/manifest-history.mts';

const req = (qs) => new Request(`https://x.netlify.app/.netlify/functions/manifest-history${qs}`);

async function enforcing(fn) {
  process.env.AUTH_REQUIRED = 'true';
  _resetUserCacheForTests();
  const fake = installFirestoreFake({});   // no onOther: any non-Firestore call throws
  try { return await fn(fake); } finally { fake.restore(); delete process.env.AUTH_REQUIRED; }
}

test('a signed-out caller adding ?pdf=1 without a date does not get thirty nights of manifest history', async () => {
  await enforcing(async (fake) => {
    for (const qs of ['?pdf=1', '?pdf=1&days=180', '?pdf=1&date=', '?pdf=1&date=not-a-date', '?pdf=1&date=2026-09-01%2F..']) {
      const r = await history(req(qs));
      assert.equal(r.status, 401, `${qs} must be refused like any other JSON read`);
      const body = await r.json();
      assert.equal(body.ok, false);
      assert.equal('days' in body, false, `${qs} leaked the history list`);
    }
    assert.equal(fake.log.sets.length + fake.log.commits.length, 0, 'a refused caller triggers no heal write');
  });
});

test('a signed-out caller cannot reach the rows or the blob self-test by tacking ?pdf=1 onto them', async () => {
  await enforcing(async () => {
    assert.equal((await history(req('?pdf=1&selftest=1'))).status, 401);
    assert.equal((await history(req('?pdf=1&rows=1'))).status, 401);
  });
});

test('the share-sheet / "open in browser" PDF link for a real night still opens without a header', async () => {
  // The exact URL App.jsx builds (pdfHref). With nothing on file it is a 404 from the PDF
  // branch — the point is that it is answered BY the PDF branch, not refused by the gate.
  await enforcing(async () => {
    const r = await history(req('?date=2026-09-01&pdf=1'));
    assert.notEqual(r.status, 401);
    assert.notEqual(r.status, 403);
    assert.match((await r.json()).error, /no manifest on file for 2026-09-01/);
  });
});
