// test/stop-lookup-failed-read-not-a-miss.test.mjs — A FIRESTORE 503 IS NOT "WE NEVER CAPTURED IT".
//
// Audit 2026-09-27 (shiplify-lookup-uat-1). stop-lookup's per-day readers went through a
// firstHit() that caught every error into a miss, so a 503 / 429 on the stop documents came
// back as read:true with nothing in it. The dossier then said complete:true, found:false —
// the screen printed "an order we have genuinely never captured" and offered to spend a
// NuVizz call on an order sitting in our own Firestore. The file header promised the
// opposite: "A read that throws is reported UNREAD with its reason, never as empty."
//
// Every test here runs the real handler against the Firestore fake, with a fetch wrapper that
// answers 503 for exactly the documents named — so the failure is Firestore's, not a stub's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';

const T = 'davis';
const URL_BASE = 'https://x.netlify.app/.netlify/functions/stop-lookup';
const call = async (qs) => {
  const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
  return (await handler(new Request(`${URL_BASE}?${qs}`))).json();
};
const today = async () => (await import('../netlify/functions/lib/firestore.mts')).etDayString();
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const order = (over = {}) => ({
  stopNbr: '007174397', pro: '007174397', businessName: 'LED ENERGY PLUS',
  addr1: '5965 PEACHTREE CORS E STE B3', city: 'NORCROSS', state: 'GA', zip: '30071',
  routeName: 'NOR 2', driverName: 'ENOCK AKYEA', normalizedStatus: 'DELIVERED', ...over,
});

/** Install the fake, then make Firestore answer 503 to every GET whose document path matches. */
function withFailingReads(seed, failPath) {
  const fake = installFirestoreFake(seed);
  const inner = globalThis.fetch;
  let failed = 0;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input?.url ?? input);
    const path = u.includes('/documents/') ? decodeURIComponent(u.split('/documents/')[1].split('?')[0]) : '';
    if (u.includes('firestore.googleapis.com') && (init.method || 'GET') === 'GET' && path && failPath(path)) {
      failed++;
      return new Response('{"error":{"code":503,"status":"UNAVAILABLE"}}', { status: 503 });
    }
    return inner(input, init);
  };
  return { fake, failed: () => failed, restore: () => { globalThis.fetch = inner; fake.restore(); } };
}

test("a Firestore 503 on the stop documents is reported UNREAD — not as an order we have never captured", async () => {
  // The order is on TODAY's board, so the PRO index has no pointer for it yet and the stop
  // documents are the only thing that can find it. Firestore pushes back on every one.
  const d = await today();
  const env = withFailingReads(
    { [`nuvizz_stop_index/${T}__${d}/stops/007174397`]: order() },
    (p) => /^(history_days|nuvizz_stop_index)\/[^/]+\/stops\/[^/]+$/.test(p),
  );
  try {
    const body = await call('stop=007174397');
    assert.ok(env.failed() > 0, 'the stop reads genuinely failed');
    assert.equal(body.ok, true, 'a failed source never fails the whole answer');
    assert.equal(body.dossier.found, false);
    assert.equal(body.dossier.complete, false, 'a lookup with failed reads must not call itself complete');
    assert.ok(body.dossier.unreadSources.includes('Sealed history'), 'the sealed warehouse is named as unread');
    assert.ok(body.dossier.unreadSources.includes("Today's board"), "today's board is named as unread");
    const by = Object.fromEntries(body.dossier.sources.map((s) => [s.key, s]));
    assert.equal(by.sealed.state, 'unread');
    assert.equal(by.board.state, 'unread');
    assert.match(body.errors.sealed, /503/, 'and the reason reaches the screen');
    assert.match(body.errors.board, /503/);
  } finally { env.restore(); }
});

test('one failed day does not hide the day that WAS read — the order still shows, and the ledger says a day is missing', async () => {
  // A single 503 among the ~18 days read is the common shape of a bad moment. The day that
  // answered is still a fact; the day that did not is named, so nobody calls the list whole.
  const d = await today();
  const held = addDays(d, -9);
  const broken = addDays(d, -1);
  const env = withFailingReads({
    [`history_pros/${T}__n_7174397`]: { days: [{ date: held, pro: '007174397' }] },
    [`history_days/${T}__${held}/stops/007174397`]: order({ date: held }),
  }, (p) => p.startsWith(`history_days/${T}__${broken}/stops/`));
  try {
    const body = await call('stop=007174397');
    assert.ok(env.failed() > 0, 'the one day genuinely failed');
    assert.equal(body.dossier.found, true, 'the day that was read is still shown');
    assert.deepEqual(body.dossier.days.map((x) => x.date), [held]);
    assert.equal(body.dossier.complete, false);
    assert.ok(body.dossier.unreadSources.includes('Sealed history'));
    assert.match(body.errors.sealed, new RegExp(broken), 'the failed day is named');
  } finally { env.restore(); }
});

test('a failed PRO-index read is UNREAD too, so an old order is not declared never-captured', async () => {
  // The index is the only thing that finds an order older than the board window. It used to
  // swallow a 503 into "no days", and the answer went on to call itself complete.
  const env = withFailingReads({}, (p) => p.startsWith('history_pros/'));
  try {
    const body = await call('stop=007174397');
    assert.ok(env.failed() > 0, 'the index read genuinely failed');
    const pros = body.dossier.sources.find((s) => s.key === 'pros');
    assert.equal(pros.state, 'unread');
    assert.equal(body.dossier.complete, false);
    assert.match(body.errors.pros, /503/);
  } finally { env.restore(); }
});

test('a clean miss — every read answered 404 — is still COMPLETE, so the prompted call is still offered', async () => {
  const fake = installFirestoreFake({});
  try {
    const body = await call('stop=009999999');
    assert.equal(body.dossier.found, false);
    assert.equal(body.dossier.complete, true);
    assert.deepEqual(body.dossier.unreadSources, []);
    assert.equal(body.errors.sealed, undefined);
    assert.equal(body.errors.board, undefined);
    assert.equal(body.errors.pros, undefined);
  } finally { fake.restore(); }
});
