import test from 'node:test';
import assert from 'node:assert/strict';

// ── Board roster: who the app can identify ───────────────────────────────────

test('a name claimed by exactly one driver is identified', async () => {
  const { partitionBoardRows } = await import('../src/lib/roster.js');
  const p = partitionBoardRows([{ alias: 'ALFRED MORGAN', claimedBy: ['4471'] }]);
  assert.equal(p.identified.length, 1);
  assert.equal(p.unidentified.length, 0);
  assert.equal(p.ambiguous.length, 0);
});

test('a name claimed by NOBODY is flagged — that driver would get no loads', async () => {
  const { partitionBoardRows } = await import('../src/lib/roster.js');
  const p = partitionBoardRows([{ alias: 'ALFRED MORGAN', claimedBy: [] }]);
  assert.deepEqual(p.unidentified.map((r) => r.alias), ['ALFRED MORGAN']);
  assert.equal(p.identified.length, 0);
});

test('a name claimed by TWO drivers is NOT identified', async () => {
  // The one that is easy to get wrong: two claimants resolve to neither driver,
  // so counting this as identified would hide two broken drivers behind a tick.
  const { partitionBoardRows } = await import('../src/lib/roster.js');
  const p = partitionBoardRows([{ alias: 'ALFRED MORGAN', claimedBy: ['4471', '4472'] }]);
  assert.equal(p.identified.length, 0, 'must not count as identified');
  assert.equal(p.unidentified.length, 0, 'nor as simply unclaimed — it is a different fault');
  assert.equal(p.ambiguous.length, 1);
});

test('a name claimed ONLY by a deactivated credential is NOT identified', async () => {
  // The live fault: ALFRED MORGAN sat on credential 9001, an INACTIVE
  // acceptance-test account. Login filters to active credentials and
  // load-manifest 403s an inactive one, so he got nothing while the screen
  // counted him among the identified.
  const { partitionBoardRows } = await import('../src/lib/roster.js');
  const p = partitionBoardRows([{ alias: 'ALFRED MORGAN', claimedBy: [], inactiveClaimedBy: ['9001'] }]);
  assert.equal(p.identified.length, 0, 'a deactivated claimant is not an identification');
  assert.equal(p.inactiveOnly.length, 1, 'and it needs its own fix, not "create a driver"');
  assert.equal(p.unidentified.length, 0);
});

test('an active claimant wins even when a deactivated one also holds the name', async () => {
  const { partitionBoardRows } = await import('../src/lib/roster.js');
  const p = partitionBoardRows([{ alias: 'ALFRED MORGAN', claimedBy: ['4471'], inactiveClaimedBy: ['9001'] }]);
  assert.equal(p.identified.length, 1, 'the live credential resolves; the dead one is irrelevant');
  assert.equal(p.inactiveOnly.length, 0);
});

test('the partition agrees with the resolver it mirrors, including on active', async () => {
  const { partitionBoardRows } = await import('../src/lib/roster.js');
  const aliasesLib = await import('../netlify/functions/lib/aliases.mts');
  const creds = [
    { driverNumber: '4471', nuvizzAliases: ['ALFRED MORGAN'], active: true },
    { driverNumber: '4472', nuvizzAliases: ['SHARED NAME'], active: true },
    { driverNumber: '4473', nuvizzAliases: ['SHARED NAME'], active: true },
    { driverNumber: '9001', nuvizzAliases: ['DEAD ACCOUNT NAME'], active: false },
  ];
  // Login resolves against ACTIVE credentials only (driver-login.mts), so the
  // screen must partition against the same set or it will disagree with reality.
  const live = creds.filter((c) => c.active !== false);
  for (const alias of ['ALFRED MORGAN', 'SHARED NAME', 'DEAD ACCOUNT NAME', 'NOBODY AT ALL']) {
    const claimedBy = live.filter((c) => c.nuvizzAliases.includes(alias)).map((c) => c.driverNumber);
    const inactiveClaimedBy = creds
      .filter((c) => c.active === false && c.nuvizzAliases.includes(alias))
      .map((c) => c.driverNumber);
    const p = partitionBoardRows([{ alias, claimedBy, inactiveClaimedBy }]);
    const resolved = aliasesLib.resolveDriverForAlias(alias, live).status === 'resolved';
    assert.equal(p.identified.length === 1, resolved, `${alias}: screen and resolver must agree`);
  }
});

test('a malformed row does not crash the roster', async () => {
  const { partitionBoardRows } = await import('../src/lib/roster.js');
  const p = partitionBoardRows([{ alias: 'X' }, null, undefined]);
  assert.equal(p.unidentified.length, 3, 'missing claimedBy reads as unclaimed, not as identified');
});

// ── What a driver can actually type to sign in ───────────────────────────────

test('sign-in is an EXACT match — a first name does not work', async () => {
  // Chad tried "alfred" and "morgan" against a credential holding only
  // "ALFRED MORGAN". Both were refused, and nothing on screen said why.
  const { loginNamesFor } = await import('../src/lib/roster.js');
  const alfred = { driverNumber: '9667', displayName: 'ALFRED MORGAN', nuvizzAliases: ['ALFRED MORGAN'], active: true };
  const { works } = loginNamesFor(alfred, [alfred]);
  assert.deepEqual(works, ['ALFRED MORGAN'], 'only the full name works');
  assert.ok(!works.includes('ALFRED'), 'a first name is not a login name');
});

test('the sign-in list agrees with the resolver that actually runs', async () => {
  const { loginNamesFor } = await import('../src/lib/roster.js');
  const aliasesLib = await import('../netlify/functions/lib/aliases.mts');
  const creds = [
    { driverNumber: '9667', displayName: 'ALFRED MORGAN', nuvizzAliases: ['ALFRED MORGAN', 'ALFRED'], active: true },
    { driverNumber: '8913', displayName: 'Aaron Mitchell', nuvizzAliases: ['AARON'], active: true },
  ];
  for (const c of creds) {
    for (const name of loginNamesFor(c, creds).works) {
      const r = aliasesLib.resolveLoginIdentifier(name, creds);
      assert.equal(r.status, 'resolved', `${name} must resolve`);
      assert.equal(r.driverNumber, c.driverNumber, `${name} must land on ${c.driverNumber}`);
    }
  }
});

test('a short alias added by the dispatcher becomes a working login name', async () => {
  const { loginNamesFor } = await import('../src/lib/roster.js');
  const alfred = { driverNumber: '9667', displayName: 'ALFRED MORGAN', nuvizzAliases: ['ALFRED MORGAN', 'ALFRED'], active: true };
  const { works } = loginNamesFor(alfred, [alfred]);
  assert.deepEqual(works, ['ALFRED', 'ALFRED MORGAN'], 'shortest first — that is what a driver will type');
});

test('a name two active drivers share is reported as dead, not offered', async () => {
  const { loginNamesFor } = await import('../src/lib/roster.js');
  const a = { driverNumber: '1', displayName: 'BEN PAINTSIL', nuvizzAliases: ['BEN'], active: true };
  const b = { driverNumber: '2', displayName: 'BEN WORLEY', nuvizzAliases: ['BEN'], active: true };
  const { works, broken } = loginNamesFor(a, [a, b]);
  assert.deepEqual(works, ['BEN PAINTSIL'], 'the unique name still works');
  assert.deepEqual(broken.map((x) => x.name), ['BEN'], 'the shared one is flagged');
  assert.deepEqual(broken[0].claimedBy, ['1', '2']);
});

test('a DEACTIVATED credential does not spoil a name for a live driver', async () => {
  // ALFRED MORGAN also sits on the inactive 9001; login filters to active
  // credentials first, so that must not make the live name ambiguous.
  const { loginNamesFor } = await import('../src/lib/roster.js');
  const live = { driverNumber: '9667', displayName: 'ALFRED MORGAN', nuvizzAliases: ['ALFRED MORGAN'], active: true };
  const dead = { driverNumber: '9001', displayName: 'Acceptance Test Driver', nuvizzAliases: ['ALFRED MORGAN'], active: false };
  const { works, broken } = loginNamesFor(live, [live, dead]);
  assert.deepEqual(works, ['ALFRED MORGAN']);
  assert.equal(broken.length, 0);
});

test('a deactivated credential reports that, not a per-name verdict', async () => {
  // Caught from a screenshot: the inactive test account was showing "signs in
  // as ALFRED MORGAN" — a name that actually resolves to a DIFFERENT, live
  // driver — and listing its own names as "shared, will fail" with nobody to
  // share with.
  const { loginNamesFor } = await import('../src/lib/roster.js');
  const dead = { driverNumber: '9001', displayName: 'Acceptance Test Driver', nuvizzAliases: ['ZZ_NOBODY', 'ALFRED MORGAN'], active: false };
  const live = { driverNumber: '9667', displayName: 'ALFRED MORGAN', nuvizzAliases: ['ALFRED MORGAN'], active: true };
  const r = loginNamesFor(dead, [dead, live]);
  assert.equal(r.inactive, true);
  assert.deepEqual(r.works, [], 'a dead account signs in as nothing');
  assert.deepEqual(r.broken, []);
});

test('a name that resolves to a DIFFERENT driver is never listed as working', async () => {
  // The dangerous case: typing it signs the wrong person in.
  const { loginNamesFor } = await import('../src/lib/roster.js');
  const me = { driverNumber: '1', displayName: 'BEN', nuvizzAliases: [], active: true };
  const other = { driverNumber: '2', displayName: 'Ben Paintsil', nuvizzAliases: ['BEN'], active: true };
  const r = loginNamesFor(me, [me, other]);
  assert.deepEqual(r.works, [], 'BEN is claimed by two, so it works for neither');
  assert.equal(r.broken.length, 1);

  // And with only the other claiming it, it must say whose it is.
  const solo = loginNamesFor({ driverNumber: '3', displayName: 'BEN', nuvizzAliases: [], active: true }, [
    { driverNumber: '3', displayName: 'BEN', nuvizzAliases: [], active: true },
    other,
  ]);
  assert.deepEqual(solo.works, [], 'still not mine');
});

test('a credential with no usable name reports that rather than looking fine', async () => {
  const { loginNamesFor } = await import('../src/lib/roster.js');
  const empty = { driverNumber: '5', displayName: '', nuvizzAliases: [], active: true };
  assert.deepEqual(loginNamesFor(empty, [empty]).works, []);
});

// ── Offering the board names that are still spare ────────────────────────────

const BOARD = [
  { alias: 'BRENT BOYD', stops: 36, claimedBy: [], inactiveClaimedBy: [] },
  { alias: 'BRENT', stops: 4, claimedBy: [], inactiveClaimedBy: [] },
  { alias: 'AARON MITCHELL', stops: 12, claimedBy: ['8913'], inactiveClaimedBy: [] },
  { alias: 'ALFRED MORGAN', stops: 21, claimedBy: [], inactiveClaimedBy: ['9001'] },
];

test('only names no ACTIVE driver is using are offered', async () => {
  const { availableAliases } = await import('../src/lib/roster.js');
  const out = availableAliases(BOARD).map((a) => a.alias);
  assert.ok(!out.includes('AARON MITCHELL'), 'a name in use by a live driver is not on offer');
  assert.deepEqual(out, ['BRENT BOYD', 'ALFRED MORGAN', 'BRENT'], 'busiest spelling first');
});

test('a name stuck on a deactivated account is offered, and flagged', async () => {
  // It resolves to nothing, so it is genuinely spare — and it is exactly the
  // name a dispatcher needs to move onto a live driver.
  const { availableAliases } = await import('../src/lib/roster.js');
  const alfred = availableAliases(BOARD).find((a) => a.alias === 'ALFRED MORGAN');
  assert.ok(alfred, 'offered');
  assert.deepEqual(alfred.heldByInactive, ['9001'], 'flagged so the dispatcher knows why it is loose');
});

test('names this driver already holds are not offered again', async () => {
  const { availableAliases } = await import('../src/lib/roster.js');
  const out = availableAliases(BOARD, ['BRENT BOYD']).map((a) => a.alias);
  assert.deepEqual(out, ['ALFRED MORGAN', 'BRENT'], 'no duplicate of what is already on the chip list');
});

test('the already-held check ignores case and padding', async () => {
  const { availableAliases } = await import('../src/lib/roster.js');
  const out = availableAliases(BOARD, ['  brent boyd ']).map((a) => a.alias);
  assert.ok(!out.includes('BRENT BOYD'));
});

test('a driver with several spellings can collect them all', async () => {
  // The point of the feature: one person, several board spellings, and a
  // credential only matches the ones it holds.
  const { availableAliases } = await import('../src/lib/roster.js');
  const both = availableAliases(BOARD).filter((a) => a.alias.startsWith('BRENT')).map((a) => a.alias);
  assert.deepEqual(both, ['BRENT BOYD', 'BRENT'], 'both spellings are on offer');
});

test('an empty or malformed board offers nothing rather than crashing', async () => {
  const { availableAliases } = await import('../src/lib/roster.js');
  assert.deepEqual(availableAliases(null), []);
  assert.deepEqual(availableAliases([null, { alias: '' }]), []);
});

// ── Finding a credential among fifty ─────────────────────────────────────────

test('credential search matches number, display name, and aliases', async () => {
  const { filterCredentials } = await import('../src/lib/roster.js');
  const creds = [
    { driverNumber: '4471', displayName: 'Michael Frye', nuvizzAliases: ['MIKE F'] },
    { driverNumber: '8913', displayName: 'Aaron Mitchell', nuvizzAliases: ['AARON MITCHELL', 'AARON'] },
  ];
  assert.deepEqual(filterCredentials(creds, '4471').map((c) => c.driverNumber), ['4471'], 'by number');
  assert.deepEqual(filterCredentials(creds, 'mitchell').map((c) => c.driverNumber), ['8913'], 'by name, case-insensitive');
  // The dispatcher usually arrives holding a spelling off the board, not a name.
  assert.deepEqual(filterCredentials(creds, 'mike f').map((c) => c.driverNumber), ['4471'], 'by alias');
  assert.equal(filterCredentials(creds, '').length, 2, 'empty query shows everyone');
  assert.equal(filterCredentials(creds, 'nobody').length, 0);
});

// ── Client-side loading order ────────────────────────────────────────────────

test('loadOrder puts the nose first and the doors last', async () => {
  const { loadOrder } = await import('../src/lib/scan-logic.js');
  const stops = [
    { stopNbr: 'A', loadSeq: 3, routeSeq: 1 },
    { stopNbr: 'B', loadSeq: 1, routeSeq: 3 },
    { stopNbr: 'C', loadSeq: 2, routeSeq: 2 },
  ];
  assert.deepEqual(loadOrder(stops).map((s) => s.stopNbr), ['B', 'C', 'A']);
  assert.equal(loadOrder(stops)[0].routeSeq, 3, 'first loaded is the last delivered');
});

test('co-located stops stay adjacent and in a stable order between refreshes', async () => {
  const { loadOrder } = await import('../src/lib/scan-logic.js');
  const stops = [
    { stopNbr: 'S9', loadSeq: 2 },
    { stopNbr: 'S1', loadSeq: 1 },
    { stopNbr: 'S3', loadSeq: 2 },
    { stopNbr: 'S7', loadSeq: 3 },
  ];
  const once = loadOrder(stops).map((s) => s.stopNbr);
  const again = loadOrder(stops.slice().reverse()).map((s) => s.stopNbr);
  assert.deepEqual(once, ['S1', 'S3', 'S9', 'S7'], 'the shared position sits together');
  assert.deepEqual(once, again, 'the order does not shuffle when the input order changes');
});

test('a stop with no loadSeq sorts last instead of jumping to the nose', async () => {
  const { loadOrder } = await import('../src/lib/scan-logic.js');
  const out = loadOrder([{ stopNbr: 'X', loadSeq: null }, { stopNbr: 'Y', loadSeq: 5 }]);
  assert.deepEqual(out.map((s) => s.stopNbr), ['Y', 'X']);
});

test('the client fingerprint matches the server fingerprint exactly', async () => {
  const client = await import('../src/lib/scan-logic.js');
  const server = await import('../netlify/functions/lib/manifest.mts');
  const stops = [
    { stopNbr: 'A', routeSeq: 2, loadStopSeq: null },
    { stopNbr: 'B', routeSeq: 1, loadStopSeq: null },
  ];
  assert.equal(
    client.sequenceFingerprint(stops),
    server.sequenceFingerprint(stops),
    'a mismatch here would make the resequence guard fire constantly or never',
  );
});

// ── Hand-confirmed completeness ──────────────────────────────────────────────
// A stop the scanner cannot read still has to close the load, without ever
// being mistaken for a scanned piece.

const averittStop = { stopNbr: '9185096', pros: ['9185096'], expectedPieces: 2, scannable: false };
const ulineStop = { stopNbr: '7152411', pros: ['7152411'], expectedPieces: 3, scannable: true };

test('a hand-confirmed stop completes without a single scan', async () => {
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const p = stopProgress(averittStop, [], [{ stopNbr: '9185096', pieces: 2 }]);
  assert.equal(p.complete, true);
  assert.equal(p.scanned, 2);
  assert.equal(p.scannedPieces, 0, 'nothing was scanned');
  assert.equal(p.confirmedPieces, 2, 'a person vouched for both');
  assert.equal(p.handConfirmed, true);
  assert.equal(p.short, 0);
});

test('a hand-confirm covers only the REMAINDER, so a partly scanned stop cannot double count', async () => {
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const scans = [{ og: 'OG6028479182', pro: '9185096' }];
  const p = stopProgress(averittStop, scans, [{ stopNbr: '9185096', pieces: 2 }]);
  assert.equal(p.scannedPieces, 1);
  assert.equal(p.confirmedPieces, 1, 'one scanned + one confirmed, not one + two');
  assert.equal(p.scanned, 2);
  assert.equal(p.over, 0, 'the count never inflates past expected');
});

test('a hand-confirm on one stop does not touch another', async () => {
  const { loadProgress } = await import('../src/lib/scan-logic.js');
  const p = loadProgress([averittStop, ulineStop], [], [{ stopNbr: '9185096', pieces: 2 }]);
  assert.equal(p.expected, 5);
  assert.equal(p.scanned, 2, 'only the confirmed stop counts');
  assert.equal(p.clean, false, 'the Uline stop still has to be scanned');
  assert.deepEqual(p.stopsWithGap.map((s) => s.stopNbr), ['7152411']);
});

test('the load separates scanned pieces from hand-confirmed ones', async () => {
  const { loadProgress } = await import('../src/lib/scan-logic.js');
  const scans = [
    { og: 'OG6028479182', pro: '7152411' },
    { og: 'OG6028479183', pro: '7152411' },
    { og: 'OG6028479184', pro: '7152411' },
  ];
  const p = loadProgress([averittStop, ulineStop], scans, [{ stopNbr: '9185096', pieces: 2 }]);
  assert.equal(p.clean, true, 'both stops reconcile, so the load may close');
  assert.equal(p.scannedPieces, 3);
  assert.equal(p.confirmedPieces, 2);
  assert.equal(p.scanned, 5);
  assert.deepEqual(p.handConfirmedStops, ['9185096'], 'the session record names which stops were vouched for');
});

test('with no hand-confirms the progress shape is unchanged', async () => {
  const { loadProgress } = await import('../src/lib/scan-logic.js');
  const p = loadProgress([ulineStop], [{ og: 'OG6028479182', pro: '7152411' }]);
  assert.equal(p.scanned, 1);
  assert.equal(p.confirmedPieces, 0);
  assert.deepEqual(p.handConfirmedStops, []);
  assert.equal(p.short, 2);
});

import {
  normalizePro, isProBarcode, isOgBarcode, classifyBarcode,
  pairFrame, createPairBuffer, evaluateScan, OUTCOME,
  stopProgress, loadProgress, ogGapHint,
} from '../src/lib/scan-logic.js';

// ── Barcode classification ───────────────────────────────────────────────────

test('a PRO barcode is exactly 7 digits', () => {
  assert.equal(isProBarcode('7152411'), true);
  assert.equal(isProBarcode('715241'), false, '6 digits is not a PRO');
  assert.equal(isProBarcode('71524110'), false, '8 digits is not a PRO');
  assert.equal(isProBarcode('OG6028479182'), false);
  assert.equal(isProBarcode(''), false);
});

test('an OG piece ID is OG plus exactly 10 digits', () => {
  assert.equal(isOgBarcode('OG6028479182'), true);
  assert.equal(isOgBarcode('og6028479182'), true, 'case tolerated on input');
  assert.equal(isOgBarcode('OG602847918'), false, '9 digits');
  assert.equal(isOgBarcode('OG60284791821'), false, '11 digits');
  assert.equal(isOgBarcode('XY6028479182'), false);
});

test('normalizePro takes the last 7 digits and ignores punctuation', () => {
  assert.equal(normalizePro('7152411'), '7152411');
  assert.equal(normalizePro('007152411'), '7152411', '9-digit form normalizes to the 7-digit key');
  assert.equal(normalizePro('PRO 715-2411'), '7152411');
  assert.equal(normalizePro(''), '');
  assert.equal(normalizePro(null), '');
});

test('classifyBarcode separates the two symbologies', () => {
  assert.equal(classifyBarcode('7152411').kind, 'pro');
  assert.equal(classifyBarcode('OG6028479182').kind, 'og');
  assert.equal(classifyBarcode('12345678901234').kind, 'unknown');
});

// ── Frame pairing ────────────────────────────────────────────────────────────

test('a frame holding both barcodes is one complete piece scan', () => {
  const r = pairFrame(['7152411', 'OG6028479182']);
  assert.deepEqual({ pro: r.pro, og: r.og, complete: r.complete }, { pro: '7152411', og: 'OG6028479182', complete: true });
});

test('a frame with only one barcode is not complete', () => {
  assert.equal(pairFrame(['7152411']).complete, false);
  assert.equal(pairFrame(['OG6028479182']).complete, false);
});

test('pair buffer joins a PRO and an OG seen in separate frames', () => {
  const buf = createPairBuffer({ windowMs: 2500 });
  assert.equal(buf.push(['7152411'], 1000), null, 'PRO alone waits');
  const pair = buf.push(['OG6028479182'], 1200);
  assert.deepEqual(pair, { pro: '7152411', og: 'OG6028479182' });
});

test('pair buffer will NOT marry a PRO to the next label OG after the window', () => {
  const buf = createPairBuffer({ windowMs: 2500 });
  buf.push(['7152411'], 1000);
  // Driver moved on; this OG belongs to a different label.
  const pair = buf.push(['OG6028474461'], 1000 + 2501);
  assert.equal(pair, null, 'stale half-scan must expire rather than mis-pair');
});

test('pair buffer resets after emitting, so one label cannot emit twice', () => {
  const buf = createPairBuffer();
  assert.ok(buf.push(['7152411', 'OG6028479182'], 1000));
  assert.equal(buf.push(['7152411'], 1100), null);
  assert.deepEqual(buf.state(1100), { pro: '7152411', og: null });
});

// ── Match outcomes ───────────────────────────────────────────────────────────

const stopA = { stopNbr: '7152411', pros: ['7152411'], expectedPieces: 3, businessName: 'ACME', appointmentRequired: false };
const stopAppt = { stopNbr: '7152149', pros: ['7152149'], expectedPieces: 2, businessName: 'BUCK JONES', appointmentRequired: true, instructions: 'APPT REQUIRED call ahead' };

test('a PRO on this load with a new OG is GREEN', () => {
  const r = evaluateScan({ pro: '7152411', og: 'OG6028479182' }, [stopA], new Set());
  assert.equal(r.outcome, OUTCOME.GREEN);
  assert.equal(r.stop.stopNbr, '7152411');
});

test('an appointment stop is AMBER and never green', () => {
  const r = evaluateScan({ pro: '7152149', og: 'OG6028474461' }, [stopAppt], new Set());
  assert.equal(r.outcome, OUTCOME.AMBER);
  assert.match(r.instructions, /APPT/);
});

test('a PRO not on this load is RED and names the owning load', () => {
  const others = [{ loadNbr: 'DAVIS000197999', driverName: 'BRAD', stops: [{ pros: ['9998887'], businessName: 'OTHER CO' }] }];
  const r = evaluateScan({ pro: '9998887', og: 'OG6028400000' }, [stopA], new Set(), others);
  assert.equal(r.outcome, OUTCOME.RED);
  assert.equal(r.owner.loadNbr, 'DAVIS000197999');
  assert.equal(r.owner.driverName, 'BRAD');
});

test('a RED with no resolvable owner still reports red', () => {
  const r = evaluateScan({ pro: '5554443', og: 'OG6028400001' }, [stopA], new Set(), []);
  assert.equal(r.outcome, OUTCOME.RED);
  assert.equal(r.owner, null);
});

test('rescanning the same physical piece is SILENT', () => {
  const seen = new Set(['OG6028479182']);
  const r = evaluateScan({ pro: '7152411', og: 'OG6028479182' }, [stopA], seen);
  assert.equal(r.outcome, OUTCOME.SILENT);
});

test('a different piece of an already-started PRO is still GREEN', () => {
  const seen = new Set(['OG6028479182']);
  const r = evaluateScan({ pro: '7152411', og: 'OG6028479183' }, [stopA], seen);
  assert.equal(r.outcome, OUTCOME.GREEN, 'per-piece, not per-PRO');
});

// ── Completeness ─────────────────────────────────────────────────────────────

test('stop progress counts DISTINCT OGs against expectedPieces', () => {
  const scans = [
    { pro: '7152411', og: 'OG6028479182' },
    { pro: '7152411', og: 'OG6028479183' },
    { pro: '7152411', og: 'OG6028479183' }, // replay
  ];
  const p = stopProgress(stopA, scans);
  assert.equal(p.scanned, 2, 'the replay must not inflate the count');
  assert.equal(p.short, 1);
  assert.equal(p.complete, false);
});

test('a stop reconciles only when distinct OGs equal expectedPieces', () => {
  const scans = ['OG6028479182', 'OG6028479183', 'OG6028479184'].map((og) => ({ pro: '7152411', og }));
  assert.equal(stopProgress(stopA, scans).complete, true);
});

test('scans for another PRO do not count toward this stop', () => {
  const scans = [{ pro: '9998887', og: 'OG6028400000' }];
  assert.equal(stopProgress(stopA, scans).scanned, 0);
});

test('load is not clean while any stop has a gap', () => {
  const scans = [{ pro: '7152411', og: 'OG6028479182' }];
  const lp = loadProgress([stopA, stopAppt], scans);
  assert.equal(lp.clean, false);
  assert.equal(lp.expected, 5);
  assert.equal(lp.scanned, 1);
  assert.equal(lp.stopsWithGap.length, 2);
});

test('an over-count is reported, not silently swallowed', () => {
  const scans = ['OG6028479182', 'OG6028479183', 'OG6028479184', 'OG6028479185'].map((og) => ({ pro: '7152411', og }));
  const p = stopProgress(stopA, scans);
  assert.equal(p.over, 1);
  assert.equal(p.complete, false, 'over is a mismatch and must be resolved too');
});

// ── Contiguity is a hint only ────────────────────────────────────────────────

test('a numeric gap is surfaced as a hint', () => {
  const hint = ogGapHint(['OG6028479182', 'OG6028479184']);
  assert.deepEqual(hint, ['OG6028479183']);
});

test('a contiguous run has no hint', () => {
  assert.equal(ogGapHint(['OG6028479182', 'OG6028479183']), null);
});

test('a gap NEVER changes completeness', () => {
  // Split shipment: two pieces with non-adjacent OGs, expected count of 2.
  const stop = { stopNbr: '1', pros: ['7152411'], expectedPieces: 2, appointmentRequired: false };
  const scans = [
    { pro: '7152411', og: 'OG6028479182' },
    { pro: '7152411', og: 'OG6028479188' },
  ];
  const p = stopProgress(stop, scans);
  assert.equal(p.complete, true, 'counting distinct OGs decides completeness');
  assert.ok(ogGapHint(p.ogs), 'and the gap is still surfaced for the human');
});
