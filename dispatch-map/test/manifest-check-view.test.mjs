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
    // EVERY day in the window scanned — the nightly run, after routing. Nothing to excuse it.
    checkedAgainst: [{ date: '2026-08-21', stops: 758 }, { date: '2026-08-24', stops: 640 }],
  });
  assert.equal(r.level, 'alert');
  assert.equal(r.badge, 18);
  assert.equal(r.issues[0].kind, 'not_on_board');
  assert.match(manifestHeadline(r.ok === false ? r : {
    ...clean, manifest: { orders: 18 }, suspects: sus(18),
    checkedAgainst: [{ date: '2026-08-21', stops: 758 }, { date: '2026-08-24', stops: 640 }],
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

// ── CHAD'S SATURDAY CARD, 2026-09-12 10:42 (v1.20.1) ─────────────────────────
//
// "If we ran a scan this morning to complete the board from last week which looks like we
// did. It should have fixed the manifest incompleteness."
//
// The card read "136 orders not routed yet — no board has been built for 2026-09-16". Two
// things were wrong with that sentence and one of them was dangerous.
//
// 2026-09-16 is the +2 SLACK day. manifest-window says of the slack days, in as many words:
// "extra places to LOOK, and deliberately not extra days that must be scanned: requiring them
// would make every check inconclusive, since the day after tomorrow is never routed yet." The
// day that DECIDES was 2026-09-14, and it was covered — 424 stops.
//
// The cause was not in the grading rules. toStoredEmailRun wrote the run WITHOUT the coverage
// and grade the server had computed, so the browser fell back to re-deriving them from
// checkedAgainst alone — no `required`, no `asOf` — which is the conservative reading that
// demands every day in the window.
import { manifestFreshness, STALE_MINUTES } from '../src/lib/manifest-check-view.js';
import { manifestWindow, boardCoverage, gradeSuspects } from '../src/lib/manifest-window.js';

// Build the carried fields exactly the way manifest-run.mts does, so these tests cannot pass
// against a hand-written coverage the real pipeline would never produce.
const runFor = ({ shipDate, boardDays, asOf, suspects, orders }) => {
  const win = manifestWindow(shipDate, 2);
  const coverage = boardCoverage(boardDays, win.required, asOf);
  return {
    ok: true, source: 'email', mailbox: 'gmail', at: `${asOf}T05:10:00.000Z`,
    manifest: { orders, verified: true },
    onBoard: orders - suspects.length, boardOnly: 6, duplicatePros: [],
    checkedAgainst: boardDays, suspects, suspectsTotal: suspects.length,
    shipDate, expectedDelivery: win.expected,
    coverage, grade: gradeSuspects(suspects, coverage),
  };
};

const SATURDAY = {
  shipDate: '2026-09-11',                                   // Uline shipped Friday
  asOf: '2026-09-12',                                       // read at the 1:10a Saturday pass
  orders: 556,
  suspects: sus(136),
  boardDays: [
    { date: '2026-09-14', stops: 424 },                     // the day that DECIDES — covered
    { date: '2026-09-15', stops: 2 },
    { date: '2026-09-16', stops: 0 },                       // the +2 slack day — never scanned this early
  ],
};

test("Chad's Saturday: the card names the day that DECIDES, not the slack day behind it", () => {
  const r = manifestIssues(runFor(SATURDAY));
  assert.equal(r.level, 'warn', 'Monday has not come round — there is no route to chase into yet');
  assert.match(r.issues[0].text, /2026-09-14/, 'the expected delivery day is the one to name');
  assert.doesNotMatch(r.issues[0].text, /2026-09-16/, 'the slack day is a place to LOOK, never a reason');
  assert.match(r.issues[0].text, /has not come round yet/);
});

test('the run as it was ACTUALLY STORED named the wrong day — the defect, pinned', () => {
  // Strip exactly what toStoredEmailRun used to drop and nothing else.
  const { coverage, grade, shipDate, expectedDelivery, ...stripped } = runFor(SATURDAY);
  assert.match(manifestHeadline(stripped), /no board has been built for 2026-09-16/,
    'this is the sentence that was on the screen, reproduced from the stored shape');
});

test('THE ALERT CAN FIRE AGAIN: a finished board with orders off it goes RED', () => {
  // Shipped Thursday, expected Friday, read on Friday morning against a finished 649-stop
  // board. This is the genuine missing-freight case — the whole reason the check exists.
  const real = {
    shipDate: '2026-09-10', asOf: '2026-09-11', orders: 600, suspects: sus(4),
    boardDays: [
      { date: '2026-09-11', stops: 649 },                   // expected delivery day, finished
      { date: '2026-09-14', stops: 0 },                     // slack days, not yet routed
      { date: '2026-09-15', stops: 0 },
    ],
  };
  const withVerdict = manifestIssues(runFor(real));
  assert.equal(withVerdict.level, 'alert', 'four orders are off a finished board — chase them');
  assert.equal(withVerdict.badge, 4);
  assert.equal(withVerdict.issues[0].kind, 'not_on_board');

  // AND WHAT THE STRIPPED SHAPE DID TO IT. This is the dangerous half: with `required`
  // dropped, an unscanned slack day makes every run inconclusive, so 'missing' is downgraded
  // to 'unrouted' and the red alert and the nav badge are structurally DEAD. A missed flag is
  // the order that never shipped.
  const { coverage, grade, shipDate, expectedDelivery, ...stripped } = runFor(real);
  const without = manifestIssues(stripped);
  assert.equal(without.level, 'warn', 'the defect: a real finding demoted to a shrug');
  assert.equal(without.badge, 0, 'and nothing on the nav badge to go looking for');
});

// ── HOW OLD IS THIS VERDICT? (the question the card could not answer) ────────

test('freshness states the age of the reading, because the board moves under it', () => {
  const at = '2026-09-12T00:42:00.000Z';
  const now = Date.parse('2026-09-12T10:42:00.000Z');   // Chad's card, ten hours later
  const f = manifestFreshness({ at, suspectsTotal: 136 }, now);
  assert.equal(f.minutes, 600);
  assert.equal(f.stale, true);
  assert.equal(f.suggestRecheck, true, 'orders outstanding and the board has had time to move');
});

test('a CLEAN run never nudges you to re-check — a green card with an alarm on it is noise', () => {
  const f = manifestFreshness({ at: '2026-09-12T00:42:00.000Z', suspectsTotal: 0 }, Date.parse('2026-09-12T10:42:00.000Z'));
  assert.equal(f.stale, true, 'it is still old, and says so');
  assert.equal(f.suggestRecheck, false, 're-checking a clean run cannot change the answer');
});

test('a verdict read minutes ago is not stale, and a run with no stamp is not judged at all', () => {
  const now = Date.parse('2026-09-12T10:42:00.000Z');
  assert.equal(manifestFreshness({ at: '2026-09-12T10:30:00.000Z', suspectsTotal: 136 }, now).stale, false);
  assert.equal(manifestFreshness({ at: '2026-09-12T10:42:00.000Z' }, now).minutes, 0);
  assert.equal(manifestFreshness({}, now), null, 'no stamp is not the epoch — new Date(null) is');
  assert.equal(manifestFreshness({ at: 'not a date' }, now), null);
  assert.ok(STALE_MINUTES > 5, 'the scan runs every 5 minutes; one scan is not staleness');
});

test('a re-read of filed paper says so, so it is not mistaken for a fresh report', () => {
  const base = { ok: true, source: 'email', mailbox: 'gmail', from: 'outbound.logistics@uline.com', fileName: 'r.pdf' };
  assert.doesNotMatch(manifestProvenance(base), /re-checked/);
  assert.match(manifestProvenance({ ...base, recheckedAt: '2026-09-12T10:52:00.000Z' }), /re-checked against the board/);
});
