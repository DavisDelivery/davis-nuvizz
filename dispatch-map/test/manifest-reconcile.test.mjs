// test/manifest-reconcile.test.mjs
//
// Chad: "an order is on the nightly manifest that is not in nuvizz need to build
// a way to detect this."
//
// The whole risk in this feature is ONE confusion: "not on our board" is not the
// same claim as "not in NuVizz". Every probe failure mode — scans disabled, auth
// rejected, throttled, the daily-ceiling breaker open — fails for EVERY pro at
// once, so a two-state model would report the entire manifest as missing on a bad
// night. These tests exist mostly to pin that apart.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proKeys, boardProIndex, onBoard, reconcileAgainstBoard, classifyProbes,
  reasonMeansAbsent, summarize,
} from '../netlify/functions/lib/manifest-reconcile.mts';

const row = (pro, over = {}) => ({ pro, custName: 'ACME', city: 'DALTON', zip: '30721', lbs: 100, skids: 1, pieces: 0, shipDate: '8/06/26', ...over });

// ── PRO matching ─────────────────────────────────────────────────────────────

test('a PRO matches across padded, unpadded and last-7 forms', () => {
  const idx = boardProIndex(['007158397']);
  assert.ok(onBoard(idx, '007158397'), 'exact');
  assert.ok(onBoard(idx, '7158397'), 'unpadded — a leading zero must not invent a missing order');
  assert.ok(!onBoard(idx, '007158398'), 'a genuinely different PRO does not match');
});

test('THE SEGMENT SUFFIX: a board stopNbr of 007157687-1 matches manifest PRO 007157687', () => {
  // The board really does carry this form (the CURANT HEALTH order is
  // "007157687-1") while Uline prints the bare 9 digits. Without stripping the
  // segment the two never match and every such order reads as missing — the
  // report would be nothing but false alarms.
  const boardIdx = boardProIndex(['007157687-1']);
  assert.ok(onBoard(boardIdx, '007157687'), 'manifest PRO finds its suffixed board stop');
  const manifestIdx = boardProIndex(['007157687']);
  assert.ok(onBoard(manifestIdx, '007157687-1'), 'and the match works in both directions');
  assert.ok(!onBoard(boardIdx, '007157688'), 'a different PRO still does not match');
});

test('an Estes-style dashed PRO is NOT treated as a segment suffix', () => {
  // "028-8347656" is one 10-digit PRO with formatting, not a 9-digit PRO plus a
  // segment. Stripping there would collapse distinct orders together.
  assert.ok(proKeys('028-8347656').includes('0288347656'));
  assert.ok(!proKeys('028-8347656').includes('028'), 'the dash is formatting, not a suffix');
});

test('proKeys is empty for junk, so junk can never match anything', () => {
  assert.deepEqual(proKeys(''), []);
  assert.deepEqual(proKeys(null), []);
  assert.deepEqual(proKeys('ABC'), []);
  assert.ok(!onBoard(boardProIndex(['007158397']), ''), 'blank never matches');
});

// ── step 1: free diff against the board ──────────────────────────────────────

test('the manifest order missing from the board is isolated as a SUSPECT, not a verdict', () => {
  const rows = [row('007158397'), row('007158415'), row('007158999', { custName: 'GHOST CO' })];
  const r = reconcileAgainstBoard(rows, ['007158397', '007158415']);
  assert.equal(r.onBoardCount, 2);
  assert.equal(r.offBoard.length, 1);
  assert.equal(r.offBoard[0].pro, '007158999');
  assert.equal(r.offBoard[0].state, 'off_board', 'NOT "missing from nuvizz" — nothing has been asked yet');
  assert.equal(r.offBoard[0].custName, 'GHOST CO', 'the row keeps its detail so a human can act on it');
});

test('board orders the manifest never mentions are counted, not flagged', () => {
  // The board carries every shipper, not just Uline. Listing these as problems
  // would bury the one order that matters under hundreds that are fine.
  const r = reconcileAgainstBoard([row('007158397')], ['007158397', '999000111', '999000222']);
  assert.equal(r.boardOnlyCount, 2);
  assert.equal(r.offBoard.length, 0);
});

test('a PRO printed twice on one manifest is reported once and flagged', () => {
  const r = reconcileAgainstBoard([row('007158397'), row('007158397')], []);
  assert.equal(r.manifestCount, 1, 'counted once');
  assert.equal(r.offBoard.length, 1, 'and only suspected once');
  assert.deepEqual(r.duplicatePros, ['007158397']);
});

test('an empty board makes every manifest order a suspect — and none a verdict', () => {
  const r = reconcileAgainstBoard([row('007158397'), row('007158415')], []);
  assert.equal(r.offBoard.length, 2);
  assert.ok(r.offBoard.every((x) => x.state === 'off_board'));
});

// ── step 2: verdicts, and the failure modes that must NOT read as absence ────

test('reasonMeansAbsent: only an explicit not-found counts as proof', () => {
  for (const r of ['not_found', 'http_404', 'NOT_FOUND']) assert.ok(reasonMeansAbsent(r), r);
  for (const r of ['scans_disabled', 'http_401', 'http_403', 'http_429', 'http_500', 'http_503',
    'circuit_open', 'fetch failed', '', null, undefined]) {
    assert.ok(!reasonMeansAbsent(r), `${r} must never read as absence`);
  }
});

test('THE FINDING: a probe that says not_found is the actionable "not in NuVizz"', () => {
  const suspects = [row('007158999', { custName: 'GHOST CO' })];
  const v = classifyProbes(suspects, [{ pro: '007158999', ok: false, reason: 'not_found' }]);
  assert.equal(v.missing.length, 1);
  assert.equal(v.missing[0].custName, 'GHOST CO');
  assert.equal(v.missing[0].state, 'missing_from_nuvizz');
  assert.equal(v.unknown.length, 0);
  assert.equal(v.conclusive, true);
});

test('a suspect NuVizz DOES know about is off-board, not missing', () => {
  // Dated to another day, cancelled, or on a date we did not scan. Real, and a
  // completely different problem from an order that never arrived.
  const v = classifyProbes([row('007158999')], [{ pro: '007158999', ok: true }]);
  assert.equal(v.missing.length, 0);
  assert.equal(v.inNuvizzOffBoard.length, 1);
  assert.equal(v.inNuvizzOffBoard[0].state, 'in_nuvizz_off_board');
});

test('A BAD NIGHT NEVER REPORTS THE WHOLE MANIFEST AS MISSING', () => {
  // scans_disabled / auth / throttle / breaker all fail for EVERY pro at once.
  const suspects = Array.from({ length: 660 }, (_, i) => row(String(7158000 + i).padStart(9, '0')));
  for (const reason of ['scans_disabled', 'http_401', 'http_429', 'http_503', 'circuit_open']) {
    const v = classifyProbes(suspects, suspects.map((s) => ({ pro: s.pro, ok: false, reason })));
    assert.equal(v.missing.length, 0, `${reason} must produce ZERO "missing" verdicts`);
    assert.equal(v.unknown.length, 660, `${reason} must land every row in unknown`);
    assert.equal(v.conclusive, false, 'and must not claim the run was conclusive');
  }
});

test('a suspect that was never probed is unknown, not missing', () => {
  // What a per-run call cap produces: we stopped early on purpose. Silence about
  // an order must never be reported as evidence against it.
  const suspects = [row('007158999'), row('007158998')];
  const v = classifyProbes(suspects, [{ pro: '007158999', ok: false, reason: 'not_found' }]);
  assert.equal(v.missing.length, 1);
  assert.equal(v.unknown.length, 1);
  assert.equal(v.unknown[0].reason, 'not probed');
  assert.equal(v.probed, 1, 'only the one we actually asked about counts as probed');
  assert.equal(v.conclusive, false);
});

test('a mixed night sorts each order into exactly one bucket', () => {
  const suspects = [row('007158001'), row('007158002'), row('007158003')];
  const v = classifyProbes(suspects, [
    { pro: '007158001', ok: false, reason: 'not_found' },
    { pro: '007158002', ok: true },
    { pro: '007158003', ok: false, reason: 'http_429' },
  ]);
  assert.equal(v.missing.length, 1);
  assert.equal(v.inNuvizzOffBoard.length, 1);
  assert.equal(v.unknown.length, 1);
  assert.equal(v.missing.length + v.inNuvizzOffBoard.length + v.unknown.length, suspects.length);
});

test('probe outcomes match a suspect whatever PRO form they come back in', () => {
  const v = classifyProbes([row('007158999')], [{ pro: '7158999', ok: false, reason: 'not_found' }]);
  assert.equal(v.missing.length, 1, 'an unpadded answer still resolves its suspect');
});

// ── the human-readable line ──────────────────────────────────────────────────

test('summarize leads with the actionable count and never hides unverified rows', () => {
  const board = reconcileAgainstBoard([row('007158397'), row('007158999')], ['007158397']);
  const v = classifyProbes(board.offBoard, [{ pro: '007158999', ok: false, reason: 'not_found' }]);
  const s = summarize(board, v);
  assert.match(s, /2 on the manifest/);
  assert.match(s, /1 on the board/);
  assert.match(s, /1 NOT IN NUVIZZ/);

  const shaky = classifyProbes(board.offBoard, [{ pro: '007158999', ok: false, reason: 'http_429' }]);
  const s2 = summarize(board, shaky);
  assert.ok(!/NOT IN NUVIZZ/.test(s2), 'a throttled night claims nothing');
  assert.match(s2, /1 unverified/);
});

test('a clean night says so without inventing problems', () => {
  const board = reconcileAgainstBoard([row('007158397')], ['007158397']);
  assert.equal(board.offBoard.length, 0);
  assert.equal(summarize(board, null), '1 on the manifest · 1 on the board');
});
