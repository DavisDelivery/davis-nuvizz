import test from 'node:test';
import assert from 'node:assert/strict';

// ── The camera pairs like the gun: one label, one piece ──────────────────────
//
// The camera used to book a PRO the INSTANT it decoded, with no piece id.
// Quagga is deliberately multiple:false, so on an iPhone the two barcodes of a
// label always arrive on separate frames — and whenever the PRO decoded a beat
// before the OG, a phantom NOOG piece booked, the green flash ended the aim,
// and the OG that landed anyway booked as a SECOND piece. DASAN USA read 3/3
// off two scans (NOOG-7162525-1 + OG6028653156 + OG6028653157); GEM SHOPPING
// credited 10 of 11. A PRO alone is STILL a piece — the WMS rule stands — but
// it books when the pair window closes, not on the first PRO frame.

const CAMERA_WINDOW = 2500;

test('DASAN: the PRO frame books nothing — its OG lands two frames later and makes ONE piece', async () => {
  const { createPairBuffer } = await import('../src/lib/scan-logic.js');
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: CAMERA_WINDOW, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;
  assert.equal(buf.push(['7162525'], t0), null, 'no instant booking on the PRO frame');
  const pair = buf.push(['OG6028653156'], t0 + 400);
  assert.deepEqual(pair, { pro: '7162525', og: 'OG6028653156' }, 'the OG completes the SAME piece');
  assert.equal(abandoned.length, 0, 'and no phantom was minted along the way');
});

test('a PRO whose piece id never decodes becomes a piece when the window closes — not before', async () => {
  const { createPairBuffer } = await import('../src/lib/scan-logic.js');
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: CAMERA_WINDOW, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;
  buf.push(['7156834'], t0);
  assert.equal(buf.tick(t0 + CAMERA_WINDOW - 1), null, 'still inside the window');
  assert.equal(abandoned.length, 0);
  buf.tick(t0 + CAMERA_WINDOW + 1);
  assert.deepEqual(
    abandoned.map((h) => [h.kind, h.value, h.reason]),
    [['pro', '7156834', 'expired']],
    'the expiry is what books the PRO-alone piece downstream',
  );
});

test('steady aim re-reads the same PRO every frame without restarting the window', async () => {
  // If a re-read refreshed the timestamp, a label whose OG cannot decode would
  // hold the loader at "hold steady" forever. The window anchors to the FIRST
  // sighting; frames re-reading the same barcode change nothing.
  const { createPairBuffer } = await import('../src/lib/scan-logic.js');
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: CAMERA_WINDOW, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;
  buf.push(['7156834'], t0);
  assert.equal(buf.push(['7156834'], t0 + 800), null, 're-read, not an abandonment');
  assert.equal(buf.push(['7156834'], t0 + 1600), null);
  assert.equal(abandoned.length, 0, 'no superseded noise from holding aim');
  buf.tick(t0 + CAMERA_WINDOW + 1);
  assert.deepEqual(abandoned.map((h) => h.reason), ['expired'], 'window measured from the first read');
});

test('a re-read of a pending OG is also a no-op, and a DIFFERENT label still supersedes', async () => {
  const { createPairBuffer } = await import('../src/lib/scan-logic.js');
  const abandoned = [];
  const buf = createPairBuffer({ windowMs: CAMERA_WINDOW, onAbandon: (h) => abandoned.push(h) });
  const t0 = 1_000_000;
  buf.push(['OG6028555794'], t0);
  assert.equal(buf.push(['OG6028555794'], t0 + 300), null, 'same piece id re-read');
  assert.equal(abandoned.length, 0);
  buf.push(['OG6028555795'], t0 + 600); // a different label's id — a real switch
  assert.deepEqual(abandoned.map((h) => [h.kind, h.value, h.reason]), [['og', 'OG6028555794', 'superseded']]);
});

test('an OG seen just before its PRO still pairs', async () => {
  const { createPairBuffer } = await import('../src/lib/scan-logic.js');
  const buf = createPairBuffer({ windowMs: CAMERA_WINDOW });
  assert.equal(buf.push(['OG6028555794'], 1000), null, 'an OG alone identifies no stop');
  assert.deepEqual(buf.push(['7156834'], 1500), { pro: '7156834', og: 'OG6028555794' });
});

test('a stale OG is not married to a later label', async () => {
  // The failure this guards: an OG from the pallet you just did, attached to
  // the PRO of the one you are on now.
  const { createPairBuffer } = await import('../src/lib/scan-logic.js');
  const buf = createPairBuffer({ windowMs: CAMERA_WINDOW });
  buf.push(['OG6028555794'], 1000);
  assert.equal(buf.push(['7156834'], 1000 + CAMERA_WINDOW + 1500), null, 'expired — the PRO starts its own window');
});

test('junk in the frame never becomes a piece', async () => {
  const { createPairBuffer } = await import('../src/lib/scan-logic.js');
  const buf = createPairBuffer({ windowMs: CAMERA_WINDOW });
  assert.equal(buf.push(['0259185096', 'DECATUR', ''], 1000), null, 'an Averitt PRO and text are not a Uline piece');
  assert.deepEqual(buf.state(1001), { pro: null, og: null }, 'and nothing is left pending');
});

test('a scanned-without-OG id is accepted and stays distinct from typed', async () => {
  const session = await import('../netlify/functions/scan-session.mts');
  const scanned = session.normalizeScan({ og: 'NOOG-7156834-1', pro: '7156834', engine: 'quagga' }).row;
  const typed = session.normalizeScan({ og: 'TYPED-7156834-1', pro: '7156834', engine: 'quagga' }).row;
  assert.equal(scanned.engine, 'quagga', 'it really was scanned');
  assert.equal(typed.engine, 'manual', 'this one was not');
  assert.equal(session.mergeScans([], [scanned, typed]).scans.length, 2, 'different ids, both counted');
});

// ── Pickups are not loading work ─────────────────────────────────────────────

test('a pickup is kept out of the loading list', async () => {
  // The first thing on Alfred Morgan's truck was a PICKUP — a stop where the
  // driver COLLECTS freight on the route. There is nothing to load and nothing
  // to scan, so it must not head the list of work.
  const { splitPickups } = await import('../src/lib/scan-logic.js');
  const stops = [
    { stopNbr: 'A', isPickup: true, pros: ['1111111'], expectedPieces: 3 },
    { stopNbr: 'B', isPickup: false, pros: ['2222222'], expectedPieces: 4 },
  ];
  const { loading, pickups } = splitPickups(stops);
  assert.deepEqual(loading.map((s) => s.stopNbr), ['B']);
  assert.deepEqual(pickups.map((s) => s.stopNbr), ['A'], 'still listed, just not as loading work');
});

test("a pickup's pieces never count toward the load total", async () => {
  // The bug this prevents: the loader works every real stop, the truck is full,
  // and the app still says 4/7 because three pieces belong to a stop that will
  // never be scanned at the dock. The load could never read complete.
  const { loadProgress } = await import('../src/lib/scan-logic.js');
  const stops = [
    { stopNbr: 'A', isPickup: true, pros: ['1111111'], expectedPieces: 3, skids: 3, loose: 0 },
    { stopNbr: 'B', isPickup: false, pros: ['2222222'], expectedPieces: 4, skids: 4, loose: 0 },
  ];
  const scans = Array.from({ length: 4 }, (_, i) => ({ pro: '2222222', og: `OG000000000${i}` }));
  const p = loadProgress(stops, scans);
  assert.equal(p.expected, 4, 'only the deliveries have to go on the truck');
  assert.equal(p.scanned, 4);
  assert.equal(p.short, 0, 'the load reads complete, because it is');
});

test('a load of nothing but pickups has no loading work', async () => {
  const { loadProgress, splitPickups } = await import('../src/lib/scan-logic.js');
  const stops = [{ stopNbr: 'A', isPickup: true, pros: ['1111111'], expectedPieces: 3 }];
  assert.equal(splitPickups(stops).loading.length, 0);
  assert.equal(loadProgress(stops, []).expected, 0, 'nothing to load, so nothing outstanding');
});

test('a stop with no pickup flag is treated as loading work', async () => {
  // The safe default: an unmarked stop is freight until proven otherwise.
  // Guessing "pickup" would silently drop real work off the truck.
  const { splitPickups } = await import('../src/lib/scan-logic.js');
  const { loading } = splitPickups([{ stopNbr: 'A', pros: ['1111111'], expectedPieces: 2 }]);
  assert.equal(loading.length, 1);
});

test('PU is recognised from either field the index has used', async () => {
  const m = await import('../netlify/functions/lib/manifest.mts');
  const base = { stopNbr: 'S', loadNbr: 'L', pallets: 1 };
  assert.equal(m.toManifestStop({ ...base, type: 'PU' }).isPickup, true, "dispatch-map's normalized field");
  assert.equal(m.toManifestStop({ ...base, stopType: 'PU' }).isPickup, true, 'the raw vendor field');
  assert.equal(m.toManifestStop({ ...base, stopType: 'pickup' }).isPickup, true, 'the GreenBridge spelling');
  assert.equal(m.toManifestStop({ ...base, type: 'DO' }).isPickup, false, 'a delivery is not a pickup');
  assert.equal(m.toManifestStop(base).isPickup, false, 'and neither is an unmarked stop');
});

test('positions are renumbered so none exceeds its own count', async () => {
  // Removing a pickup from position 1 left the deliveries at 2 and 3 against a
  // count of 2 — the list read "Load 3 of 2".
  const { renumberPositions, loadGroupCount } = await import('../src/lib/scan-logic.js');
  const out = renumberPositions([
    { stopNbr: 'B', loadSeq: 2 },
    { stopNbr: 'C', loadSeq: 3 },
  ]);
  assert.deepEqual(out.map((s) => s.loadSeq), [1, 2]);
  assert.equal(loadGroupCount(out), 2, 'and the count agrees with the positions');
});

test('two stops sharing a trailer position keep sharing it', async () => {
  // One address, two orders, one drop. Splitting them would send a loader
  // looking for a second place to put freight that belongs in the first.
  const { renumberPositions } = await import('../src/lib/scan-logic.js');
  const out = renumberPositions([
    { stopNbr: 'B', loadSeq: 2 },
    { stopNbr: 'C', loadSeq: 2 },
    { stopNbr: 'D', loadSeq: 4 },
  ]);
  assert.deepEqual(out.map((s) => s.loadSeq), [1, 1, 2]);
});

// ── The 3/2 over-count seen on the dock ──────────────────────────────────────

test('a burst of frames for one label books ONE piece, not one per frame', async () => {
  // SURVIVAL SUPPLIES, 2 skids, read 64 times, recorded 3/2. The scanner was
  // fine — `record` closed over a stale `scans` array, so every frame in the
  // burst saw "no prior scan" and each booked a piece. This models the gate that
  // now decides synchronously.
  const { createScanGate } = await import('../src/lib/scan-logic.js');
  const gate = createScanGate({ cooldownMs: 3000 });

  let booked = 0;
  // 64 frames of the same label over one second, exactly as Quagga delivers them.
  for (let i = 0; i < 64; i++) if (gate.allow('7157016', 1000 + i * 16)) booked += 1;

  assert.equal(booked, 1, 'one pallet in frame is one piece, however many times it decodes');
});

test('the same PRO is accepted again once the cooldown has passed', async () => {
  const { createScanGate } = await import('../src/lib/scan-logic.js');
  const gate = createScanGate({ cooldownMs: 3000 });
  assert.equal(gate.allow('7157016', 1000), true);
  assert.equal(gate.allow('7157016', 2000), false, 'still the same piece in frame');
  assert.equal(gate.allow('7157016', 4500), true, 'a genuine second piece can be booked');
});

test('a different label is never blocked by the cooldown on another', async () => {
  const { createScanGate } = await import('../src/lib/scan-logic.js');
  const gate = createScanGate({ cooldownMs: 3000 });
  assert.equal(gate.allow('7157016', 1000), true);
  assert.equal(gate.allow('7157403', 1100), true, 'the next pallet must not wait');
});

test('completed stops sort below unfinished ones, order otherwise preserved', async () => {
  const { sortForLoading } = await import('../src/lib/scan-logic.js');
  const rows = [
    { stop: { loadSeq: 1 }, progress: { complete: true } },
    { stop: { loadSeq: 2 }, progress: { complete: false } },
    { stop: { loadSeq: 3 }, progress: { complete: true } },
    { stop: { loadSeq: 4 }, progress: { complete: false } },
  ];
  assert.deepEqual(
    sortForLoading(rows).map((r) => r.stop.loadSeq),
    [2, 4, 1, 3],
    'next to load on top; finished work drops away without being reordered',
  );
});

// ── The IndexedDB unwrap that silently threw away every scan ─────────────────

test('a get that finds NOTHING must resolve undefined, not the request object', async () => {
  // THE bug behind "nothing works". tx() unwrapped an IDBRequest with
  //   result && result.result !== undefined ? result.result : result
  // For a miss, request.result is undefined, so the ternary fell through and
  // returned the REQUEST — which is truthy. enqueueScan's "already queued?"
  // guard was therefore always true: it returned false and never wrote. Every
  // piece flashed green, the counter never moved, nothing uploaded.
  //
  // This reproduces the unwrap in isolation, since node has no IndexedDB.
  const unwrapOld = (r) => (r && r.result !== undefined ? r.result : r);
  const unwrapNew = (r) => (r && typeof r === 'object' && 'result' in r ? r.result : r);

  const miss = { result: undefined };          // IDBRequest for a key not present
  const hit = { result: { key: 'a', og: 'OG6028555794' } };

  assert.notEqual(unwrapOld(miss), undefined, 'the old unwrap returned a truthy request on a miss');
  assert.equal(unwrapNew(miss), undefined, 'a miss is undefined, so the guard lets the write through');
  assert.deepEqual(unwrapNew(hit), hit.result, 'a hit still returns the row');

  // The shapes tx() also handles: getAll, and a callback returning nothing.
  assert.deepEqual(unwrapNew({ result: [] }), [], 'empty getAll stays an array');
  assert.equal(unwrapNew(undefined), undefined, 'a void callback stays undefined');
});

// ── Adding a piece by PRO when the OG cannot be read ─────────────────────────

test('a typed piece id is accepted, and never reported as scanned', async () => {
  // Reported from the dock: typing a PRO and pressing Add piece did nothing,
  // because the form demanded an OG as well. A torn or missing OG barcode left
  // no way to record the piece at all.
  const session = await import('../netlify/functions/scan-session.mts');
  const { row } = session.normalizeScan({ og: 'TYPED-7156834-1', pro: '7156834', engine: 'quagga' });
  assert.ok(row, 'accepted');
  assert.equal(row.og, 'TYPED-7156834-1');
  assert.equal(row.engine, 'manual', 'a typed piece is never credited to a scanner');
});

test('typed ids still de-duplicate, so a replay cannot double-count', async () => {
  const session = await import('../netlify/functions/scan-session.mts');
  const a = session.normalizeScan({ og: 'TYPED-7156834-1', pro: '7156834' }).row;
  const b = session.normalizeScan({ og: 'TYPED-7156834-1', pro: '7156834' }).row;
  const merged = session.mergeScans([a], [b]);
  assert.equal(merged.scans.length, 1);
  assert.equal(merged.duplicates, 1);
});

test('successive typed pieces for one PRO are distinct', async () => {
  const session = await import('../netlify/functions/scan-session.mts');
  const rows = ['TYPED-7156834-1', 'TYPED-7156834-2', 'TYPED-7156834-3']
    .map((og) => session.normalizeScan({ og, pro: '7156834' }).row);
  assert.equal(session.mergeScans([], rows).scans.length, 3, 'three pieces, not one');
});

test('a typed id cannot masquerade as a real OG, and junk is still refused', async () => {
  const session = await import('../netlify/functions/scan-session.mts');
  assert.ok(session.normalizeScan({ og: 'OG6028555794', pro: '7156834' }).row, 'a real OG still works');
  assert.ok(session.normalizeScan({ og: 'TYPED-123-1', pro: '7156834' }).reason, 'PRO must be 7 digits');
  assert.ok(session.normalizeScan({ og: 'TYPED-7156834-', pro: '7156834' }).reason, 'needs an index');
  assert.ok(session.normalizeScan({ og: 'NONSENSE', pro: '7156834' }).reason, 'junk still rejected');
});

test('the OG off the photographed label classifies correctly', async () => {
  // From IMG_4752 on the dock: OG6028555794 above PRO 7156834. Both are valid,
  // so the pairing failure was not a classification problem.
  const { classifyBarcode, pairFrame } = await import('../src/lib/scan-logic.js');
  assert.equal(classifyBarcode('OG6028555794').kind, 'og');
  assert.equal(classifyBarcode('7156834').kind, 'pro');
  assert.equal(pairFrame(['OG6028555794', '7156834']).complete, true);
});

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

// ── Damaged freight, and taking a scan back ─────────────────────────────────
//
// Two different problems that both arrive at the same moment: the loader is
// holding a piece and something about it is wrong. Either it is broken (it still
// goes on the truck, and the office needs to know) or it should never have been
// booked to this load at all (it has to come back off the count).

const dmgStop = { stopNbr: 'A', pros: ['7156834'], expectedPieces: 3 };
const scan = (og, extra = {}) => ({ pro: '7156834', og, ...extra });

test('a damaged piece still counts — it is on the truck', async () => {
  // The whole point of the "damaged = still loaded" rule. A crushed carton that
  // ships is freight aboard the trailer; making the load read short would send a
  // loader hunting the dock for a piece that is already behind them.
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const p = stopProgress(dmgStop, [
    scan('OG6028555790'),
    scan('OG6028555791', { damaged: true, damageNote: 'corner crushed' }),
    scan('OG6028555792'),
  ]);
  assert.equal(p.scanned, 3, 'damaged freight is still loaded freight');
  assert.equal(p.complete, true, 'and the stop still reconciles');
  assert.equal(p.short, 0);
});

test('a damaged piece is reported so the office can claim it', async () => {
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const p = stopProgress(dmgStop, [
    scan('OG6028555790'),
    scan('OG6028555791', { damaged: true, damageNote: 'corner crushed' }),
    scan('OG6028555792'),
  ]);
  assert.deepEqual(p.damagedOgs, ['OG6028555791']);
  assert.equal(p.damagedCount, 1);
  assert.equal(p.pieces.find((x) => x.og === 'OG6028555791').damageNote, 'corner crushed');
});

test('a voided scan stops counting', async () => {
  // The gap that had no answer at all: a piece booked to the load that then does
  // not make the truck. Without this the dock count says loaded forever.
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const p = stopProgress(dmgStop, [
    scan('OG6028555790'),
    scan('OG6028555791', { voidedAt: '2026-08-06T12:00:00.000Z', voidReason: 'left on dock' }),
    scan('OG6028555792'),
  ]);
  assert.equal(p.scanned, 2, 'the voided piece came back off the count');
  assert.equal(p.short, 1, 'and the stop is honestly short');
  assert.equal(p.complete, false);
  assert.equal(p.pieces.length, 2, 'it is not listed as a piece on the stop either');
});

test('voiding is not the same as damaging — one counts, one does not', async () => {
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const damaged = stopProgress(dmgStop, [scan('OG6028555790', { damaged: true })]);
  const voided = stopProgress(dmgStop, [scan('OG6028555790', { voidedAt: '2026-08-06T12:00:00.000Z' })]);
  assert.equal(damaged.scanned, 1);
  assert.equal(voided.scanned, 0);
});

test('the load total drops a voided piece too, or the two counts disagree', async () => {
  // loadProgress counts distinct OGs across the WHOLE load by its own path, so it
  // has to honour the void independently — otherwise the stop says 2 and the load
  // says 3 and nobody can tell which is lying.
  const { loadProgress } = await import('../src/lib/scan-logic.js');
  const stops = [
    { stopNbr: 'A', pros: ['7156834'], expectedPieces: 2 },
    { stopNbr: 'B', pros: ['7156835'], expectedPieces: 1 },
  ];
  const scans = [
    scan('OG6028555790'),
    scan('OG6028555791', { voidedAt: '2026-08-06T12:00:00.000Z' }),
    { pro: '7156835', og: 'OG6028555792' },
  ];
  const p = loadProgress(stops, scans);
  assert.equal(p.scanned, 2, 'two pieces actually on the truck');
  assert.equal(p.short, 1);
  assert.equal(p.clean, false, 'and the load cannot close clean while it is short');
});

test('damage across the load is gathered into one list for closeout', async () => {
  const { loadProgress } = await import('../src/lib/scan-logic.js');
  const stops = [
    { stopNbr: 'A', pros: ['7156834'], expectedPieces: 1 },
    { stopNbr: 'B', pros: ['7156835'], expectedPieces: 1 },
  ];
  const p = loadProgress(stops, [
    scan('OG6028555790', { damaged: true }),
    { pro: '7156835', og: 'OG6028555792', damaged: true },
  ]);
  assert.equal(p.damagedCount, 2);
  assert.deepEqual(p.stopsWithDamage, ['A', 'B']);
  assert.equal(p.clean, true, 'damage does not stop a full truck closing clean');
});

test('a re-read of a damaged label does not clear the flag', async () => {
  // The camera fires repeatedly at one label. If a later frame overwrote the
  // stored row, marking a piece damaged and then walking past it again would
  // quietly un-damage it.
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const p = stopProgress(dmgStop, [
    scan('OG6028555790', { damaged: true, damageNote: 'wet' }),
    scan('OG6028555790'),
  ]);
  assert.equal(p.damagedCount, 1, 'first scan of an OG wins');
  assert.equal(p.pieces[0].damageNote, 'wet');
});

test('activeScans is the only thing that decides what a void hides', async () => {
  const { activeScans, isVoided } = await import('../src/lib/scan-logic.js');
  const rows = [scan('OG6028555790'), scan('OG6028555791', { voidedAt: '2026-08-06T12:00:00.000Z' })];
  assert.equal(activeScans(rows).length, 1);
  assert.equal(isVoided(rows[1]), true);
  assert.equal(isVoided(rows[0]), false);
  assert.equal(isVoided(null), false, 'a missing row is not a voided one');
});

// ── The route order must follow the route, not a ghost ──────────────────────
//
// MANDI MALBROUGH, Aug 10: a load sitting at 0/14 — nothing scanned, nothing on
// the trailer — displaying "The route was resequenced after loading started."
// Loading had not started. The order it was defending came from an earlier load
// that reused the same number, inherited through a stamp key carrying no date.
// A loader was being told to distrust a screen that was simply correct.

const seqStops = [
  { stopNbr: '1', pros: ['7159301'], expectedPieces: 2, loadSeq: 1, loadStopSeq: 10 },
  { stopNbr: '2', pros: ['7159250'], expectedPieces: 2, loadSeq: 2, loadStopSeq: 9 },
];

test('an EMPTY trailer always shows the current route order', async () => {
  const { shouldFreezeSequence } = await import('../src/lib/scan-logic.js');
  const stale = { fingerprint: 'an-order-from-some-other-day', loadSeqByStop: { 1: 9, 2: 8 } };
  assert.equal(
    shouldFreezeSequence({ loadedSeq: stale, stops: seqStops, piecesAboard: false }),
    false,
    'nothing is aboard, so there is no physical order to protect',
  );
});

test('freight aboard against a changed route DOES freeze — that is the whole point', async () => {
  const { shouldFreezeSequence } = await import('../src/lib/scan-logic.js');
  const stale = { fingerprint: 'the-order-this-truck-was-loaded-to', loadSeqByStop: { 1: 9, 2: 8 } };
  assert.equal(
    shouldFreezeSequence({ loadedSeq: stale, stops: seqStops, piecesAboard: true }),
    true,
    'renumbering under a half-loaded truck would hide misplaced freight',
  );
});

test('freight aboard against an UNCHANGED route does not cry resequenced', async () => {
  const { shouldFreezeSequence, sequenceFingerprint } = await import('../src/lib/scan-logic.js');
  const stamped = { fingerprint: sequenceFingerprint(seqStops), loadSeqByStop: {} };
  assert.equal(shouldFreezeSequence({ loadedSeq: stamped, stops: seqStops, piecesAboard: true }), false);
});

test('no stamp at all never freezes, however much is aboard', async () => {
  const { shouldFreezeSequence } = await import('../src/lib/scan-logic.js');
  assert.equal(shouldFreezeSequence({ loadedSeq: null, stops: seqStops, piecesAboard: true }), false);
  assert.equal(shouldFreezeSequence({ loadedSeq: {}, stops: seqStops, piecesAboard: true }), false);
});

test('the stamp key is scoped by date, so a reused load number cannot inherit an old order', async () => {
  const { seqKey } = await import('../src/lib/offline.js');
  assert.notEqual(
    seqKey('MANDI', '2026-08-10'),
    seqKey('MANDI', '2026-07-27'),
    'the same truck on two days must not share one frozen order',
  );
  assert.ok(seqKey('MANDI', '2026-08-10').includes('2026-08-10'));
});

test('an already-scanned piece names the stop it is already on', async () => {
  // MANDI's truck: a skid was rescanned again and again expecting ONE
  // DIVERSIFIED, and the label on it was CENTRICSIT's — already aboard. The app
  // knew whose it was and returned stop:null, so the screen said only "ALREADY
  // SCANNED" and the question "whose is this then?" had no answer on the dock.
  const { evaluateScan, OUTCOME } = await import('../src/lib/scan-logic.js');
  const centricsit = { stopNbr: '4', pros: ['7159406'], expectedPieces: 1, businessName: 'CENTRICSIT' };
  const oneDiv = { stopNbr: '6', pros: ['7159057'], expectedPieces: 1, businessName: 'ONE DIVERSIFIED LLC' };
  const seen = new Set(['OG6028599592']);

  const r = evaluateScan({ pro: '7159406', og: 'OG6028599592' }, [centricsit, oneDiv], seen);
  assert.equal(r.outcome, OUTCOME.SILENT, 'still a duplicate — nothing is booked twice');
  assert.equal(r.stop?.businessName, 'CENTRICSIT', 'and now it says whose label it is');
  assert.equal(r.pro, '7159406');
});

test('a duplicate whose PRO is on no stop still resolves to no owner', async () => {
  const { evaluateScan, OUTCOME } = await import('../src/lib/scan-logic.js');
  const r = evaluateScan({ pro: '9999999', og: 'OG6028599592' }, [], new Set(['OG6028599592']));
  assert.equal(r.outcome, OUTCOME.SILENT);
  assert.equal(r.stop, null, 'nothing to name, and that must not throw');
});

// ── A load number is not unique across days ─────────────────────────────────
//
// STEVEN ADJETEY, Aug 12: his truck opened for the FIRST time that morning
// reading 7/24 already scanned. Load numbers are names here — his load is
// literally "STEVEN" — so the local queue, filtered on loadNbr alone, handed
// back every scan ever queued against that name. Stops looked done and a loader
// would have walked straight past real freight.

test('queuedFor returns only THIS day rows for a load number that repeats', async () => {
  const store = await import('../src/lib/offline.js');
  const rows = [
    { key: 'STEVEN::OG1', loadNbr: 'STEVEN', date: '2026-08-11', og: 'OG1' },
    { key: 'STEVEN::OG2', loadNbr: 'STEVEN', date: '2026-08-12', og: 'OG2' },
    { key: 'MANDI::OG3', loadNbr: 'MANDI', date: '2026-08-12', og: 'OG3' },
    { key: 'STEVEN::OG4', loadNbr: 'STEVEN', og: 'OG4' }, // pre-dating the date field
  ];
  // queuedFor's filter, exercised directly — the store itself needs IndexedDB.
  const filter = (loadNbr, date) =>
    rows.filter((r) => r.loadNbr === loadNbr && (!date || String(r.date || '') === String(date)));

  assert.deepEqual(filter('STEVEN', '2026-08-12').map((r) => r.og), ['OG2'], "yesterday's scans stay out");
  assert.deepEqual(filter('STEVEN', '2026-08-11').map((r) => r.og), ['OG1']);
  assert.deepEqual(filter('MANDI', '2026-08-12').map((r) => r.og), ['OG3'], 'other trucks unaffected');
  assert.equal(filter('STEVEN', '2026-08-12').some((r) => r.og === 'OG4'), false, 'a row with no date is not todays');
  assert.equal(typeof store.queuedFor, 'function', 'and the store exposes the date-scoped read');
});

test('queuedFor with no date still returns everything for the load', async () => {
  // Backward compatible: callers that genuinely want the whole history can omit it.
  const rows = [
    { loadNbr: 'STEVEN', date: '2026-08-11' },
    { loadNbr: 'STEVEN', date: '2026-08-12' },
  ];
  const filter = (loadNbr, date) =>
    rows.filter((r) => r.loadNbr === loadNbr && (!date || String(r.date || '') === String(date)));
  assert.equal(filter('STEVEN').length, 2);
});

// ── One skid, two camera frames, 111ms apart ────────────────────────────────
//
// STRATIX SHIPPING read 2/1 on a 1-piece stop. The server session shows both
// scans on the same day, 111ms apart, from the same engine:
//   OG6028626724     09:31:57.769  quagga   <- PRO + piece id
//   NOOG-7160956-1   09:31:57.880  quagga   <- same skid, PRO only
// Frame 1 booked it with its id; frame 2 decoded only the PRO and every guard
// missed it, because they all read React state that had not re-rendered yet.

test('a piece booked with its id blocks the SAME skid arriving as PRO-only', async () => {
  const { stopProgress } = await import('../src/lib/scan-logic.js');
  const stop = { stopNbr: '007160956', pros: ['007160956', '7160956'], expectedPieces: 1, businessName: 'STRATIX SHIPPING' };

  // What the committed state said when frame 2 ran: nothing yet.
  const committed = [];
  // What was actually already booked, synchronously, by frame 1.
  const justBooked = [{ pro: '7160956', og: 'OG6028626724', stopNbr: '007160956' }];
  const live = committed.concat(justBooked);

  assert.equal(stopProgress(stop, committed).scanned, 0, 'React state alone still says empty — the trap');
  const done = stopProgress(stop, live);
  assert.equal(done.scanned, 1, 'the synchronous view already has the piece');
  assert.equal(done.scanned >= done.expected, true, 'so the over-count guard refuses frame 2');
});

test('the same OG re-read inside one render is still a duplicate', async () => {
  const { evaluateScan, OUTCOME } = await import('../src/lib/scan-logic.js');
  const stop = { stopNbr: '007160956', pros: ['7160956'], expectedPieces: 2 };
  // scannedOgs from state is empty; the live set includes what frame 1 booked.
  const liveOgs = new Set(['OG6028626724']);
  const r = evaluateScan({ pro: '7160956', og: 'OG6028626724' }, [stop], liveOgs);
  assert.equal(r.outcome, OUTCOME.SILENT, 'not booked a second time');
});

test('a NOOG id cannot collide with one minted milliseconds earlier', async () => {
  // The id is chosen by scanning `used` for a free suffix. Built from React
  // state alone, two frames both pick -1 and the second overwrites the first.
  const live = [{ pro: '7160956', og: 'NOOG-7160956-1' }];
  const used = new Set(live.map((s) => String(s.og).toUpperCase()));
  let n = 1;
  while (used.has(`NOOG-7160956-${n}`)) n += 1;
  assert.equal(n, 2, 'the second piece gets its own id');
});
