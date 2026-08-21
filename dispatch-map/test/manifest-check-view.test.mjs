// test/manifest-check-view.test.mjs
//
// The FLAG has to be right in both directions. A false flag trains a dispatcher
// to ignore it; a missed flag is the order that never shipped.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  manifestIssues, manifestHeadline, manifestProvenance, toStored, loadStored, saveStored, MANIFEST_CHECK_KEY,
} from '../src/lib/manifest-check-view.js';

const clean = { ok: true, manifest: { orders: 660, verified: true }, onBoard: 660, boardOnly: 12, suspects: [], duplicatePros: [] };
const sus = (n) => Array.from({ length: n }, (_, i) => ({ pro: `00715${8000 + i}`, custName: 'ACME', city: 'DALTON' }));

test('a clean run raises NO flag', () => {
  const r = manifestIssues(clean);
  assert.equal(r.badge, 0);
  assert.equal(r.level, 'ok');
  assert.deepEqual(r.issues, []);
  assert.match(manifestHeadline(clean), /All 660 manifest orders found/);
});

test('THE FLAG: an order on the manifest but not in the scan raises an alert', () => {
  const r = manifestIssues({ ...clean, onBoard: 659, suspects: sus(1) });
  assert.equal(r.level, 'alert');
  assert.equal(r.badge, 1);
  assert.equal(r.issues[0].kind, 'not_on_board');
  assert.match(r.issues[0].text, /1 order on the manifest is not in the scan/);
});

test('the badge counts ORDERS to chase, not categories of problem', () => {
  const r = manifestIssues({ ...clean, suspects: sus(3), duplicatePros: ['a', 'b'], manifest: { orders: 660, verified: false } });
  assert.equal(r.badge, 3, 'three orders, not three kinds of issue');
  assert.equal(r.issues.length, 3, 'but all three issues are still reported');
  assert.equal(r.issues[0].kind, 'not_on_board', 'the actionable one leads');
});

test("Chad's Friday: 18 orders off the board, but no board exists for Monday yet", () => {
  // The false alarm, in the shape it actually arrived. The window now reaches Monday; at
  // midday Friday that board has not been built, so there is nothing to chase and the alert
  // becomes a warning that names the day to come back to.
  const r = manifestIssues({
    ...clean,
    manifest: { orders: 18, verified: false },
    onBoard: 0,
    suspects: sus(18),
    checkedAgainst: [{ date: '2026-08-24', stops: 0 }, { date: '2026-08-25', stops: 0 }],
  });
  assert.equal(r.level, 'warn', 'not an alert — a dispatcher cannot act on this');
  assert.equal(r.badge, 0, 'nothing to chase, so nothing on the badge');
  assert.equal(r.issues[0].kind, 'not_routed_yet');
  assert.match(r.issues[0].text, /not routed yet/i);
  assert.match(r.issues[0].text, /2026-08-24/);
});

test('the SAME 18 against a real board stay an alert — the fix must not mute a genuine miss', () => {
  const r = manifestIssues({
    ...clean,
    manifest: { orders: 18, verified: true },
    onBoard: 0,
    suspects: sus(18),
    checkedAgainst: [{ date: '2026-08-21', stops: 758 }, { date: '2026-08-24', stops: 0 }],
  });
  assert.equal(r.level, 'alert');
  assert.equal(r.badge, 18);
  assert.equal(r.issues[0].kind, 'not_on_board');
  assert.match(manifestHeadline(r.ok === false ? r : {
    ...clean, manifest: { orders: 18 }, suspects: sus(18),
    checkedAgainst: [{ date: '2026-08-21', stops: 758 }],
  }), /NOT in the scan/);
});

test('board orders the manifest never mentions are NEVER flagged', () => {
  // The board carries every shipper. Flagging these would bury the real finding.
  const r = manifestIssues({ ...clean, boardOnly: 400 });
  assert.equal(r.level, 'ok');
  assert.equal(r.badge, 0);
});

test('a manifest that failed its own checksum warns, but is not an order alert', () => {
  const r = manifestIssues({ ...clean, manifest: { orders: 660, verified: false } });
  assert.equal(r.level, 'warn');
  assert.equal(r.badge, 0, 'nothing to chase yet — the numbers are just unconfirmed');
  assert.equal(r.issues[0].kind, 'unverified_manifest');
});

test('duplicate PROs on the manifest warn', () => {
  const r = manifestIssues({ ...clean, duplicatePros: ['007158397'] });
  assert.equal(r.level, 'warn');
  assert.match(r.issues[0].text, /printed more than once/);
});

test('a failed or absent run raises nothing — silence is not a finding', () => {
  assert.equal(manifestIssues(null).level, 'none');
  assert.equal(manifestIssues({ ok: false, error: 'no board rows cached' }).badge, 0);
  assert.match(manifestHeadline({ ok: false, error: 'no board rows cached' }), /no board rows cached/);
  assert.match(manifestHeadline(null), /No manifest checked yet/);
});

// ── persistence: the flag must survive a reload ─────────────────────────────

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('the last result round-trips so the flag survives a reload', () => {
  const s = memStorage();
  const stored = toStored({ ...clean, suspects: sus(2) }, 'Uline_DA_210252748.pdf');
  assert.ok(saveStored(stored, s));
  const back = loadStored(s);
  assert.equal(back.suspects.length, 2);
  assert.equal(back.fileName, 'Uline_DA_210252748.pdf');
  assert.equal(manifestIssues(back).badge, 2, 'the flag reads the same after a reload');
});

test('a pathological run is capped so it cannot blow the storage quota', () => {
  const stored = toStored({ ...clean, suspects: sus(660) }, 'x.pdf');
  assert.equal(stored.suspects.length, 200, 'list capped');
  assert.equal(stored.suspectsTotal, 660, 'but the true count is kept');
});

test('storage failures never throw at the caller', () => {
  const boom = { getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('quota'); } };
  assert.equal(loadStored(boom), null);
  assert.equal(saveStored({ a: 1 }, boom), false);
});

test('clearing removes the stored run', () => {
  const s = memStorage();
  saveStored(toStored(clean, 'x.pdf'), s);
  saveStored(null, s);
  assert.equal(loadStored(s), null);
  assert.equal(s.getItem(MANIFEST_CHECK_KEY), null);
});

test('the tab says which mailbox an automatic run came from', () => {
  const emailRun = { ...clean, source: 'email', mailbox: 'gmail', from: 'freight@uline.com', fileName: 'freight.pdf' };
  assert.equal(manifestProvenance(emailRun), 'Checked automatically from Gmail · freight@uline.com · freight.pdf');
  assert.match(manifestProvenance({ ...emailRun, mailbox: 'resend' }), /^Checked automatically from the warehouse inbox/);
  // An older stored run predates the mailbox field — still readable, no "undefined".
  assert.match(manifestProvenance({ ...emailRun, mailbox: undefined }), /^Checked automatically from email/);
});

test('a hand-dropped run says so, and a run with nothing to say says nothing', () => {
  assert.equal(manifestProvenance({ ...clean, fileName: 'DA_210878183.pdf' }), 'Dropped by hand · DA_210878183.pdf');
  assert.equal(manifestProvenance({ ...clean }), null);
  assert.equal(manifestProvenance(null), null);
  assert.equal(manifestProvenance({ ok: false, error: 'boom' }), null);
});
