import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOADSCAN_JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-32';

const auth = await import('../netlify/functions/lib/auth.mts');
const aliases = await import('../netlify/functions/lib/aliases.mts');
const manifest = await import('../netlify/functions/lib/manifest.mts');
const session = await import('../netlify/functions/scan-session.mts');
const admin = await import('../netlify/functions/driver-admin.mts');

// ── PIN hashing ──────────────────────────────────────────────────────────────

test('a PIN round-trips through scrypt and never stores plaintext', async () => {
  const stored = await auth.hashPin('4821');
  assert.ok(stored.startsWith('scrypt$'), 'self-describing format');
  // Exact-field equality, not substring containment. The stored format is
  // scrypt$<32 hex>$<64 hex> — 96 random hex characters — and every digit of a
  // 4-6 digit PIN is itself a valid hex digit, so a SUBSTRING check against that
  // random data has a real chance (~1 in 700 for a 4-digit PIN, worse for
  // shorter) of a coincidental match that has nothing to do with a leak. That is
  // exactly what happened here: a green suite failed in CI on pure bad luck,
  // unrelated to anything this PR touched. What the assertion actually needs to
  // prove — that hashPin never stores the raw PIN as itself — is deterministic
  // as an exact-field check instead.
  const parts = stored.split('$');
  assert.equal(parts.length, 3, 'scrypt$salt$hash');
  assert.ok(parts.slice(1).every((p) => p !== '4821'), 'the PIN must not be stored as a field, hashed or not');
  assert.equal(await auth.verifyPin('4821', stored), true);
  assert.equal(await auth.verifyPin('4822', stored), false);
});

test('the same PIN hashes differently every time (per-credential salt)', async () => {
  const a = await auth.hashPin('1234');
  const b = await auth.hashPin('1234');
  assert.notEqual(a, b);
  assert.equal(await auth.verifyPin('1234', a), true);
  assert.equal(await auth.verifyPin('1234', b), true);
});

test('a malformed stored hash fails closed instead of throwing', async () => {
  for (const bad of ['', 'nonsense', 'scrypt$zz$zz', 'md5$aa$bb']) {
    assert.equal(await auth.verifyPin('1234', bad), false, `rejects ${JSON.stringify(bad)}`);
  }
});

test('PIN format is 4-6 digits', () => {
  assert.equal(auth.isValidPinFormat('1234'), true);
  assert.equal(auth.isValidPinFormat('123456'), true);
  assert.equal(auth.isValidPinFormat('123'), false);
  assert.equal(auth.isValidPinFormat('1234567'), false);
  assert.equal(auth.isValidPinFormat('12a4'), false);
});

test('an issued PIN is a standing PIN unless the dispatcher forces a change', () => {
  assert.equal(admin.issuedPinMustChange({}), false, 'the default is standing — no 5am reset calls');
  assert.equal(admin.issuedPinMustChange({ forceChange: true }), true, 'one-off reset path');
  assert.equal(admin.issuedPinMustChange({ forceChange: 'yes' }), false, 'strictly boolean true, nothing truthy');
});

// ── Tokens ───────────────────────────────────────────────────────────────────

test('a token round-trips and carries the driver number', () => {
  const t = auth.issueToken('4471', 'Brad Goodroe');
  const claims = auth.verifyToken(t);
  assert.equal(claims.sub, '4471');
  assert.equal(claims.role, 'driver');
});

test('a tampered token is rejected', () => {
  const t = auth.issueToken('4471', 'Brad Goodroe');
  const [h, p] = t.split('.');
  assert.equal(auth.verifyToken(`${h}.${p}.deadbeef`), null, 'bad signature');
  // Swap the payload for one claiming dispatcher, keeping the original signature.
  const evil = Buffer.from(JSON.stringify({ sub: '4471', role: 'dispatcher', iat: 1, exp: 9999999999 }))
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(auth.verifyToken(`${h}.${evil}.${t.split('.')[2]}`), null, 'privilege escalation blocked');
});

test('an expired token is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub: '1', role: 'driver', iat: now - 10, exp: now - 1 });
  const crypto = await import('node:crypto');
  const sig = crypto.createHmac('sha256', process.env.LOADSCAN_JWT_SECRET).update(`${h}.${p}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(auth.verifyToken(`${h}.${p}.${sig}`), null);
});

test('garbage input returns null rather than throwing', () => {
  for (const junk of [null, undefined, '', 'a.b', 'a.b.c.d', 42]) {
    assert.equal(auth.verifyToken(junk), null);
  }
});

test('the token expiry window is 90 days', () => {
  const claims = auth.verifyToken(auth.issueToken('1', 'x'));
  const days = (claims.exp - claims.iat) / 86400;
  assert.equal(days, 90);
});

// ── Lockout ──────────────────────────────────────────────────────────────────

test('the fifth failure locks the credential for 15 minutes', () => {
  let doc = { failedAttempts: 0 };
  for (let i = 1; i <= 4; i++) {
    doc = { ...doc, ...auth.nextFailureState(doc) };
    assert.equal(doc.lockedUntil, null, `attempt ${i} does not lock`);
  }
  const now = Date.parse('2026-07-29T12:00:00Z');
  const fifth = auth.nextFailureState(doc, now);
  assert.equal(fifth.failedAttempts, 5);
  assert.equal(fifth.lockedUntil, new Date(now + 15 * 60_000).toISOString());
  assert.equal(auth.isLockedOut({ lockedUntil: fifth.lockedUntil }, now), true);
  assert.equal(auth.isLockedOut({ lockedUntil: fifth.lockedUntil }, now + 16 * 60_000), false, 'expires');
});

// ── Roles ────────────────────────────────────────────────────────────────────

test('roles normalize, and anything unrecognized is a driver', () => {
  assert.equal(auth.normalizeRole('dispatcher'), 'dispatcher');
  assert.equal(auth.normalizeRole('loader'), 'loader');
  assert.equal(auth.normalizeRole('driver'), 'driver');
  for (const junk of [undefined, null, '', 'admin', 'DISPATCHER', 'Loader', 42]) {
    assert.equal(auth.normalizeRole(junk), 'driver', `${JSON.stringify(junk)} is not a promotion`);
  }
});

test('a loader token round-trips with its role', () => {
  const claims = auth.verifyToken(auth.issueToken('9001', 'Warehouse Ops', 'loader'));
  assert.equal(claims.role, 'loader');
  assert.equal(claims.sub, '9001');
});

// ── Last-dispatcher guard ────────────────────────────────────────────────────

test('the only active dispatcher is the last one — demotion/deactivation must refuse', () => {
  const creds = [
    { _id: '1', role: 'dispatcher', active: true },
    { _id: '4471', role: 'driver', active: true },
  ];
  assert.equal(auth.isLastActiveDispatcher(creds, '1'), true);
});

test('with a second active dispatcher, either may be demoted', () => {
  const creds = [
    { _id: '1', role: 'dispatcher', active: true },
    { _id: '2', role: 'dispatcher', active: true },
  ];
  assert.equal(auth.isLastActiveDispatcher(creds, '1'), false);
  assert.equal(auth.isLastActiveDispatcher(creds, '2'), false);
});

test('an INACTIVE second dispatcher does not count as cover', () => {
  const creds = [
    { _id: '1', role: 'dispatcher', active: true },
    { _id: '2', role: 'dispatcher', active: false },
  ];
  assert.equal(auth.isLastActiveDispatcher(creds, '1'), true, 'deactivated cover is no cover');
});

test('the guard never fires for a driver credential', () => {
  const creds = [
    { _id: '1', role: 'dispatcher', active: true },
    { _id: '4471', role: 'driver', active: true },
  ];
  assert.equal(auth.isLastActiveDispatcher(creds, '4471'), false);
});

test('the guard reads driverNumber when _id is absent', () => {
  const creds = [{ driverNumber: '1', role: 'dispatcher', active: true }];
  assert.equal(auth.isLastActiveDispatcher(creds, '1'), true);
});

// ── Alias resolution ─────────────────────────────────────────────────────────

test('the alias normalizer matches the dispatch-map algorithm', () => {
  assert.equal(aliases.normalizeDriverAlias('  vincent   bonzo '), 'VINCENT BONZO');
  assert.equal(aliases.normalizeDriverAlias('VINCENT'), 'VINCENT');
  assert.equal(aliases.normalizeDriverAlias(null), '');
});

const creds = [
  { driverNumber: '4471', nuvizzAliases: ['BRAD', 'BRAD GOODROE'] },
  { driverNumber: '4482', nuvizzAliases: ['VINCENT', 'VINCENT BONZO'] },
];

test('exactly one claimant resolves', () => {
  const r = aliases.resolveDriverForAlias('vincent  bonzo', creds);
  assert.equal(r.status, 'resolved');
  assert.equal(r.driverNumber, '4482');
});

test('no claimant is UNRESOLVED, never a nearest-name guess', () => {
  const r = aliases.resolveDriverForAlias('BRADLEY', creds);
  assert.equal(r.status, 'unresolved');
  assert.equal(r.reason, 'no_match');
});

test('two drivers claiming one alias is UNRESOLVED, not first-match-wins', () => {
  const dupes = [
    { driverNumber: '1', nuvizzAliases: ['CHRIS'] },
    { driverNumber: '2', nuvizzAliases: ['CHRIS'] },
  ];
  const r = aliases.resolveDriverForAlias('CHRIS', dupes);
  assert.equal(r.status, 'unresolved');
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.claimedBy.sort(), ['1', '2']);
});

test('a stop matches on either driver column', () => {
  const cred = creds[0];
  assert.equal(aliases.stopBelongsToDriver({ driverUserName: 'BRAD' }, cred), true, 'short code');
  assert.equal(aliases.stopBelongsToDriver({ driverUserName: 'Brad  Goodroe' }, cred), true, 'engine-planned full name');
  assert.equal(aliases.stopBelongsToDriver({ driverName: 'BRAD GOODROE', driverUserName: '' }, cred), true);
  assert.equal(aliases.stopBelongsToDriver({ driverUserName: 'VINCENT' }, cred), false);
});

test('a driver with no seeded aliases matches nothing', () => {
  assert.equal(aliases.stopBelongsToDriver({ driverUserName: 'BRAD' }, { driverNumber: '9', nuvizzAliases: [] }), false);
});

// ── Sign-in identifier resolution ────────────────────────────────────────────

const loginCreds = [
  { driverNumber: '3698', displayName: 'Michael Frye', nuvizzAliases: ['MICHAEL FRYE'] },
  { driverNumber: '4471', displayName: 'Brad Goodroe', nuvizzAliases: ['BRAD', 'BRAD GOODROE'] },
];

test('all digits is a driver number, used as-is', () => {
  const r = aliases.resolveLoginIdentifier('3698', loginCreds);
  assert.equal(r.kind, 'number');
  assert.equal(r.driverNumber, '3698');
});

test('the name on the board resolves to exactly one credential', () => {
  for (const typed of ['MICHAEL FRYE', 'michael  frye', '  Michael Frye ']) {
    const r = aliases.resolveLoginIdentifier(typed, loginCreds);
    assert.equal(r.status, 'resolved', `resolves ${JSON.stringify(typed)}`);
    assert.equal(r.driverNumber, '3698');
  }
});

test('a name matching one credential on BOTH displayName and alias is one claimant, not two', () => {
  const r = aliases.resolveLoginIdentifier('BRAD GOODROE', loginCreds);
  assert.equal(r.status, 'resolved');
  assert.equal(r.driverNumber, '4471');
});

test('an unknown name is refused, never a nearest-name guess', () => {
  const r = aliases.resolveLoginIdentifier('MIKE FRYE', loginCreds);
  assert.equal(r.status, 'unresolved');
  assert.equal(r.reason, 'no_match');
});

test('a name two credentials claim is refused as ambiguous', () => {
  const dupes = [
    { driverNumber: '1', displayName: 'Chris Smith', nuvizzAliases: ['CHRIS'] },
    { driverNumber: '2', displayName: 'Chris Jones', nuvizzAliases: ['CHRIS'] },
  ];
  const r = aliases.resolveLoginIdentifier('CHRIS', dupes);
  assert.equal(r.status, 'unresolved');
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.claimedBy.sort(), ['1', '2']);
});

test('ambiguous seeding is detectable for the dispatcher', () => {
  const found = aliases.findAmbiguousAliases([
    { driverNumber: '1', nuvizzAliases: ['CHRIS'] },
    { driverNumber: '2', nuvizzAliases: ['CHRIS', 'CHRISTOPHER'] },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].alias, 'CHRIS');
});

// ── Field semantics ──────────────────────────────────────────────────────────

test('expectedPieces comes from pallets, skids from cartons, loose from volume', () => {
  const raw = { stopNbr: '7152411', loadNbr: 'DAVIS1', pallets: 7, cartons: 3, volume: 4, weight: 900 };
  const m = manifest.toManifestStop(raw);
  assert.equal(m.expectedPieces, 7, 'NuVizz totalPallets is TOTAL PIECES');
  assert.equal(m.skids, 3, 'NuVizz totalCartons is SKIDS');
  assert.equal(m.loose, 4, 'NuVizz volume is LOOSE PIECES');
});

test('the translated stop leaks neither "cartons" nor "pallets" as keys', () => {
  const m = manifest.toManifestStop({ stopNbr: '1', pallets: 2, cartons: 1, volume: 1 });
  const keys = Object.keys(m).filter((k) => k !== 'raw');
  assert.equal(keys.includes('cartons'), false);
  assert.equal(keys.includes('pallets'), false);
  assert.ok(m.raw, 'but the untouched row is preserved for four-layer');
});

test('a skids + loose mismatch warns and still serves expectedPieces', () => {
  const warnings = [];
  const m = manifest.toManifestStop(
    { stopNbr: '7152411', pallets: 9, cartons: 3, volume: 4 },
    (w) => warnings.push(w),
  );
  assert.equal(m.expectedPieces, 9, 'served anyway — the truck still needs loading');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /7152411/);
});

test('a stop with no piece total is NOT an empty stop — count computed from the parts', () => {
  const warnings = [];
  // The Averitt shape: Inbound Integration orders send no totalPallets at all.
  const m = manifest.toManifestStop({ stopNbr: '7159301', cartons: 1, volume: 0 }, (w) => warnings.push(w));
  assert.equal(m.expectedPieces, 1, 'one skid, zero loose = one piece, not zero');
  assert.equal(m.countIsEstimated, true, 'flag means "computed here", not "uncertain"');
  assert.equal(warnings.length, 0, 'a computed count cannot mismatch itself');
});

test('a reported piece total is never overridden and is not marked estimated', () => {
  const m = manifest.toManifestStop({ stopNbr: '1', pallets: 7, cartons: 3, volume: 4 });
  assert.equal(m.expectedPieces, 7);
  assert.equal(m.countIsEstimated, false);
});

test('an explicit zero total is honored as a value, not treated as missing', () => {
  const m = manifest.toManifestStop({ stopNbr: '1', pallets: 0, cartons: 2, volume: 0 });
  assert.equal(m.expectedPieces, 0, 'NuVizz said zero; that is a data problem to surface, not to paper over');
  assert.equal(m.countIsEstimated, false);
});

test('load totals include computed counts', () => {
  const stops = [
    manifest.toManifestStop({ stopNbr: '1', loadNbr: 'L1', pallets: 3 }),
    manifest.toManifestStop({ stopNbr: '2', loadNbr: 'L1', cartons: 1, volume: 1 }),
  ];
  const loads = manifest.groupIntoLoads(stops);
  assert.equal(loads[0].expectedPieces, 5, '3 reported + 2 computed');
});

test('a matching stop does not warn', () => {
  const warnings = [];
  manifest.toManifestStop({ stopNbr: '1', pallets: 7, cartons: 3, volume: 4 }, (w) => warnings.push(w));
  assert.equal(warnings.length, 0);
});

test('appointment language sets appointmentRequired', () => {
  assert.equal(manifest.isAppointmentRequired({ instruction: 'APPT REQUIRED' }), true);
  assert.equal(manifest.isAppointmentRequired({ notes: 'must call before delivery' }), true);
  assert.equal(manifest.isAppointmentRequired({ instruction: 'liftgate needed' }), false, 'not every note is an appointment');
  assert.equal(manifest.isAppointmentRequired({}), false);
  assert.equal(manifest.isAppointmentRequired({ appointmentRequired: true }), true, 'explicit flag honored');
});

test('PROs are normalized and de-duplicated', () => {
  const m = manifest.toManifestStop({ stopNbr: '007152411', pros: ['007152411', '7152411', '7152149'] });
  assert.deepEqual(m.pros, ['7152411', '7152149']);
});

test('loads group and sum expected pieces', () => {
  const stops = [
    manifest.toManifestStop({ stopNbr: '1', loadNbr: 'L1', pallets: 3, loadStopSeq: 2 }),
    manifest.toManifestStop({ stopNbr: '2', loadNbr: 'L1', pallets: 2, loadStopSeq: 1 }),
    manifest.toManifestStop({ stopNbr: '3', loadNbr: 'L2', pallets: 5 }),
  ];
  const loads = manifest.groupIntoLoads(stops);
  assert.equal(loads.length, 2);
  assert.equal(loads[0].loadNbr, 'L1');
  assert.equal(loads[0].expectedPieces, 5);
  assert.equal(loads[0].stops[0].stopNbr, '2', 'sorted by stop sequence');
});

// ── The dispatcher's daily picture ───────────────────────────────────────────

const ACT = await import('../netlify/functions/lib/activity.mts');

test('a truck nobody touched still appears, as not_started', async () => {
  // The whole point: this row exists only as an ABSENCE. A screen built from
  // scan sessions alone cannot show it, and that is the truck that rolls out
  // unscanned.
  const out = ACT.buildActivity({
    date: '2026-08-05',
    loads: [{ loadNbr: 'L1', expectedPieces: 10, stopCount: 3, driverName: 'ALFRED MORGAN' }],
    sessions: [],
    creds: [],
  });
  assert.equal(out.loads.length, 1);
  assert.equal(out.loads[0].status, 'not_started');
  assert.equal(out.totals.notStarted, 1);
  assert.equal(out.loads[0].workedBy.length, 0);
});

test('load status distinguishes open, clean, short and over', async () => {
  const mk = (session, expected = 10) => ACT.loadStatus(session, expected);
  assert.equal(mk(null), 'not_started');
  assert.equal(mk({ scannedCount: 4, closedAt: null }), 'in_progress');
  assert.equal(mk({ scannedCount: 10, closedAt: 'x' }), 'closed_clean');
  assert.equal(mk({ scannedCount: 9, closedAt: 'x' }), 'closed_short');
  assert.equal(mk({ scannedCount: 11, closedAt: 'x' }), 'closed_over');
});

test('everyone who worked a truck is kept, not just the last one to push', async () => {
  // The session doc carried a single driverNumber, overwritten each push — so a
  // loader who loaded the truck vanished the moment the driver scanned it.
  let w = ACT.mergeWorker(null, { driverNumber: '100', role: 'loader', pieces: 6, at: '2026-08-05T05:00:00Z' });
  w = ACT.mergeWorker(w, { driverNumber: '200', role: 'driver', pieces: 4, at: '2026-08-05T09:00:00Z' });
  assert.deepEqual(w.map((x) => x.driverNumber), ['100', '200'], 'both kept');
  assert.deepEqual(w.map((x) => x.role), ['loader', 'driver']);
});

test('the same person pushing twice accumulates rather than duplicating', async () => {
  let w = ACT.mergeWorker(null, { driverNumber: '100', role: 'loader', pieces: 6, at: '2026-08-05T05:00:00Z' });
  w = ACT.mergeWorker(w, { driverNumber: '100', role: 'loader', pieces: 3, at: '2026-08-05T06:00:00Z' });
  assert.equal(w.length, 1);
  assert.equal(w[0].pieces, 9);
  assert.equal(w[0].firstAt, '2026-08-05T05:00:00Z', 'first touch kept');
  assert.equal(w[0].lastAt, '2026-08-05T06:00:00Z', 'last touch advanced');
});

test('an out-of-order push does not rewrite the first-touch time', async () => {
  let w = ACT.mergeWorker(null, { driverNumber: '100', role: 'loader', pieces: 1, at: '2026-08-05T09:00:00Z' });
  w = ACT.mergeWorker(w, { driverNumber: '100', role: 'loader', pieces: 1, at: '2026-08-05T05:00:00Z' });
  assert.equal(w[0].firstAt, '2026-08-05T05:00:00Z');
  assert.equal(w[0].lastAt, '2026-08-05T09:00:00Z');
});

test('which trucks each person loaded is answerable, per role', async () => {
  const out = ACT.buildActivity({
    date: '2026-08-05',
    loads: [
      { loadNbr: 'L1', expectedPieces: 10, stopCount: 2 },
      { loadNbr: 'L2', expectedPieces: 5, stopCount: 1 },
    ],
    sessions: [
      { loadNbr: 'L1', date: '2026-08-05', scannedCount: 10, scannedPieces: 10, closedAt: 'x',
        workedBy: [{ driverNumber: '100', role: 'loader', pieces: 10, firstAt: 'a', lastAt: 'b' }] },
      { loadNbr: 'L2', date: '2026-08-05', scannedCount: 5, scannedPieces: 5, closedAt: 'x',
        workedBy: [{ driverNumber: '100', role: 'loader', pieces: 5, firstAt: 'a', lastAt: 'b' }] },
    ],
    creds: [{ driverNumber: '100', displayName: 'Sam Loader', role: 'loader', active: true, lastLoginAt: '2026-08-05T05:00:00Z' }],
  });
  const sam = out.people.find((p) => p.driverNumber === '100');
  assert.deepEqual(sam.loads, ['L1', 'L2'], 'both trucks attributed to him');
  assert.equal(sam.pieces, 15);
  assert.equal(sam.usedAppToday, true);
  assert.equal(out.totals.loadersUsedApp, 1);
});

test('someone who never opened the app is visible, not merely absent', async () => {
  const out = ACT.buildActivity({
    date: '2026-08-05',
    loads: [],
    sessions: [],
    creds: [
      { driverNumber: '100', displayName: 'Used It', role: 'driver', active: true, lastLoginAt: '2026-08-05T05:00:00Z' },
      { driverNumber: '200', displayName: 'Never Showed', role: 'driver', active: true, lastLoginAt: null },
    ],
  });
  const ghost = out.people.find((p) => p.driverNumber === '200');
  assert.ok(ghost, 'still listed');
  assert.equal(ghost.usedAppToday, false);
  assert.equal(ghost.lastLoginAt, null);
  assert.equal(out.totals.peopleUsedApp, 0, 'signing in is not the same as doing work');
});

test('deactivated staff are left out of the daily people list', async () => {
  const out = ACT.buildActivity({
    date: '2026-08-05',
    loads: [],
    sessions: [],
    creds: [{ driverNumber: '9001', displayName: 'Old Account', role: 'driver', active: false, lastLoginAt: null }],
  });
  assert.equal(out.people.length, 0, 'a dead account is not a person who failed to show up');
});

// ── The drill-down: which stops got scanned, which did not, what is missing ──

const dstops = [
  { stopNbr: '1', businessName: 'TIFOSI', expectedPieces: 3, isPickup: false },
  { stopNbr: '2', businessName: 'AVERITT', expectedPieces: 2, isPickup: false },
  { stopNbr: '3', businessName: 'DOCK PICKUP', expectedPieces: 4, isPickup: true },
];
const sc = (og, stopNbr, extra = {}) => ({ og, pro: '7000000', stopNbr, ...extra });

test('reconcileStops names the finished stop, the short one and the untouched one', async () => {
  const rows = ACT.reconcileStops(dstops, [
    sc('OG0000000001', '1'), sc('OG0000000002', '1'), sc('OG0000000003', '1'), // stop 1: 3/3
    sc('OG0000000004', '2'),                                                    // stop 2: 1/2
    // stop 3 is a pickup — nothing scanned, and that is correct
  ], []);
  const one = rows.find((r) => r.stopNbr === '1');
  const two = rows.find((r) => r.stopNbr === '2');
  const three = rows.find((r) => r.stopNbr === '3');
  assert.equal(one.complete, true);
  assert.equal(one.scanned, 3);
  assert.equal(two.complete, false);
  assert.equal(two.short, 1, 'one piece missing on AVERITT');
  assert.equal(two.scanned, 1);
  assert.equal(three.isPickup, true);
  assert.equal(three.short, 0, 'a pickup is never short — nothing loads there');
  assert.equal(three.complete, true);
});

test('a stop nobody scanned reads as zero, not as absent', async () => {
  const rows = ACT.reconcileStops(dstops, [sc('OG0000000001', '1')], []);
  const two = rows.find((r) => r.stopNbr === '2');
  assert.equal(two.scanned, 0);
  assert.equal(two.short, 2, 'both AVERITT pieces still missing');
});

test('a voided scan is not counted against its stop', async () => {
  const rows = ACT.reconcileStops(dstops, [
    sc('OG0000000001', '1'), sc('OG0000000002', '1'),
    sc('OG0000000003', '1', { voidedAt: '2026-08-06T12:00:00Z' }),
  ], []);
  const one = rows.find((r) => r.stopNbr === '1');
  assert.equal(one.scanned, 2, 'the voided piece dropped off');
  assert.equal(one.short, 1);
});

test('a damaged piece still counts, and is reported for the claim', async () => {
  const rows = ACT.reconcileStops(dstops, [
    sc('OG0000000001', '1'), sc('OG0000000002', '1'),
    sc('OG0000000003', '1', { damaged: true, damageNote: 'crushed' }),
  ], []);
  const one = rows.find((r) => r.stopNbr === '1');
  assert.equal(one.scanned, 3, 'damaged freight is still on the truck');
  assert.equal(one.complete, true);
  assert.equal(one.damagedCount, 1);
  assert.deepEqual(one.damagedOgs, ['OG0000000003']);
});

test('a hand-confirmed stop reconciles without a scan barcode', async () => {
  const rows = ACT.reconcileStops(dstops, [], [{ stopNbr: '2', pieces: 2 }]);
  const two = rows.find((r) => r.stopNbr === '2');
  assert.equal(two.handConfirmed, true);
  assert.equal(two.scanned, 2, 'the hand-confirm vouches for the whole stop');
  assert.equal(two.complete, true);
});

// ── A stop shows WHEN it was scanned, not just that it was ──────────────────
//
// "all here" reads differently at 6am than it does five minutes ago, and a
// dispatcher had no way to tell those apart — only the collapsed scan log,
// three taps away, carried a time at all.

test('a scanned stop reports the time of its LAST piece, not its first', async () => {
  const rows = ACT.reconcileStops(dstops, [
    sc('OG0000000001', '1', { scannedAt: '2026-08-06T10:00:00.000Z' }),
    sc('OG0000000002', '1', { scannedAt: '2026-08-06T10:05:00.000Z' }),
    sc('OG0000000003', '1', { scannedAt: '2026-08-06T10:02:00.000Z' }), // out of order arrival
  ], []);
  const one = rows.find((r) => r.stopNbr === '1');
  assert.equal(one.scannedAt, '2026-08-06T10:05:00.000Z', 'the latest timestamp wins, regardless of array order');
});

test('an untouched stop has no scan time — not a default, not the load time', async () => {
  const rows = ACT.reconcileStops(dstops, [sc('OG0000000001', '1', { scannedAt: '2026-08-06T10:00:00.000Z' })], []);
  const two = rows.find((r) => r.stopNbr === '2');
  assert.equal(two.scannedAt, null);
});

test('a hand-confirmed stop has no scan time — the confirmation carries no per-piece clock', async () => {
  const rows = ACT.reconcileStops(dstops, [], [{ stopNbr: '2', pieces: 2 }]);
  const two = rows.find((r) => r.stopNbr === '2');
  assert.equal(two.scannedAt, null);
});

test('a voided piece does not supply the stop time — only what is still on the truck counts', async () => {
  const rows = ACT.reconcileStops(dstops, [
    sc('OG0000000001', '1', { scannedAt: '2026-08-06T10:00:00.000Z' }),
    sc('OG0000000002', '1', { scannedAt: '2026-08-06T11:30:00.000Z', voidedAt: '2026-08-06T11:31:00.000Z' }),
  ], []);
  const one = rows.find((r) => r.stopNbr === '1');
  assert.equal(one.scannedAt, '2026-08-06T10:00:00.000Z', 'the voided piece\'s later time is not reported');
});

test('buildActivity attaches the per-stop reconciliation to the load', async () => {
  const out = ACT.buildActivity({
    date: '2026-08-06',
    loads: [{ loadNbr: 'L1', expectedPieces: 5, stopCount: 2, driverName: 'ALFRED MORGAN',
      stops: [
        { stopNbr: '1', businessName: 'TIFOSI', expectedPieces: 3, isPickup: false },
        { stopNbr: '2', businessName: 'AVERITT', expectedPieces: 2, isPickup: false },
      ] }],
    sessions: [{ loadNbr: 'L1', date: '2026-08-06', scannedCount: 3, scannedPieces: 3,
      scans: [sc('OG0000000001', '1'), sc('OG0000000002', '1'), sc('OG0000000003', '1')] }],
    creds: [],
  });
  const detail = out.loads[0].stops;
  assert.equal(detail.length, 2);
  assert.equal(detail.find((s) => s.stopNbr === '1').complete, true);
  assert.equal(detail.find((s) => s.stopNbr === '2').scanned, 0, 'AVERITT untouched');
});

test('a resequenced load is counted and flagged', async () => {
  const out = ACT.buildActivity({
    date: '2026-08-05',
    loads: [{ loadNbr: 'L1', expectedPieces: 3, stopCount: 1 }],
    sessions: [{ loadNbr: 'L1', date: '2026-08-05', scannedCount: 3, closedAt: 'x', sequenceChanged: true }],
    creds: [],
  });
  assert.equal(out.loads[0].sequenceChanged, true);
  assert.equal(out.totals.resequenced, 1);
});

// ── Drivers have no driver number ────────────────────────────────────────────
// They sign in with the name on the board and a PIN. The number is an internal
// document key, so it is generated and never asked for.

test('the generated number is the next one after every id in use', async () => {
  const ids = await import('../netlify/functions/lib/driver-ids.mts');
  assert.equal(ids.nextDriverNumber(['1000', '1001', '2803']), '2804');
  assert.equal(ids.nextDriverNumber([]), '1000', 'first driver starts at the floor');
});

test('non-numeric ids are skipped, not crashed on', async () => {
  // The bootstrap dispatcher and hand-seeded rows may use anything, and they
  // must not break creation for everyone else.
  const ids = await import('../netlify/functions/lib/driver-ids.mts');
  assert.equal(ids.nextDriverNumber(['admin', null, undefined, '', '1500', 'ZZ']), '1501');
});

test('the generated number never collides with an existing one', async () => {
  const ids = await import('../netlify/functions/lib/driver-ids.mts');
  const existing = ['1000', '9001', '4471'];
  const next = ids.nextDriverNumber(existing);
  assert.ok(!existing.includes(next));
  assert.equal(next, '9002', 'above the highest, not filling a gap that a stale token may still hold');
});

test('a PIN is taken from the last 4 digits of a phone number', async () => {
  const ids = await import('../netlify/functions/lib/driver-ids.mts');
  // However the dispatcher pastes it off a contact card.
  assert.equal(ids.pinFromPhone('(678) 226-2099'), '2099');
  assert.equal(ids.pinFromPhone('678-226-2099'), '2099');
  assert.equal(ids.pinFromPhone('6782262099'), '2099');
  assert.equal(ids.pinFromPhone('2099'), '2099', 'already just the PIN');
});

test('too few digits yields no PIN, so the caller refuses rather than setting a short one', async () => {
  const ids = await import('../netlify/functions/lib/driver-ids.mts');
  assert.equal(ids.pinFromPhone('209'), '');
  assert.equal(ids.pinFromPhone(''), '');
  assert.equal(ids.pinFromPhone(null), '');
  assert.equal(ids.pinFromPhone('abc'), '');
});

// ── Fixing an unmatched sign-in ──────────────────────────────────────────────

const cred = (driverNumber, nuvizzAliases = []) => ({ driverNumber, nuvizzAliases });

test('assigning a board name attaches it to the driver credential', () => {
  const target = cred('0000', ['ZZ_NOBODY']);
  const plan = aliases.planAliasAdd(target, 'Alfred Morgan', [target, cred('0001', ['SAMUEL OSEI'])]);
  assert.deepEqual(plan.aliases, ['ZZ_NOBODY', 'ALFRED MORGAN'], 'normalized and appended, existing kept');
  assert.equal(plan.added, true);
});

test('assigning an alias another driver already claims is REFUSED', () => {
  // Two claimants resolve to neither, so this would break the other driver too.
  const target = cred('0000', []);
  const other = cred('0001', ['ALFRED MORGAN']);
  const plan = aliases.planAliasAdd(target, 'ALFRED MORGAN', [target, other]);
  assert.ok(plan.error, 'must refuse');
  assert.deepEqual(plan.claimedBy, ['0001']);
  assert.match(plan.error, /already claimed/);
});

test('the refusal survives spelling differences, since matching is normalized', () => {
  const target = cred('0000', []);
  const other = cred('0001', ['ALFRED MORGAN']);
  const plan = aliases.planAliasAdd(target, '  alfred   morgan ', [target, other]);
  assert.ok(plan.error, 'whitespace and case must not sneak a duplicate past the guard');
});

test('re-assigning a name the driver already has is a no-op, not a duplicate', () => {
  const target = cred('0000', ['ALFRED MORGAN']);
  const plan = aliases.planAliasAdd(target, 'alfred morgan', [target]);
  assert.deepEqual(plan.aliases, ['ALFRED MORGAN']);
  assert.equal(plan.added, false);
});

test('a driver may be re-assigned a name they already hold without self-blocking', () => {
  // The claimed-by check must exclude the target, or fixing a driver twice fails.
  const target = cred('0000', ['ALFRED MORGAN']);
  const plan = aliases.planAliasAdd(target, 'ALFRED MORGAN', [target, cred('0001', [])]);
  assert.ok(!plan.error, 'a driver never conflicts with themselves');
});

test('a DEACTIVATED credential holding the alias does not block a live driver', () => {
  // This is what stranded ALFRED MORGAN: his name sat on inactive credential
  // 9001, and blocking on that would stop the real driver ever claiming it.
  const target = cred('4471', []);
  const dead = { ...cred('9001', ['ALFRED MORGAN']), active: false };
  const plan = aliases.planAliasAdd(target, 'ALFRED MORGAN', [target, dead]);
  assert.ok(!plan.error, 'a dead account must not hold a live driver hostage');
  assert.deepEqual(plan.aliases, ['ALFRED MORGAN']);
});

test('an ACTIVE credential holding the alias still blocks', () => {
  const target = cred('4471', []);
  const live = { ...cred('4472', ['ALFRED MORGAN']), active: true };
  assert.ok(aliases.planAliasAdd(target, 'ALFRED MORGAN', [target, live]).error);
});

test('removing one alias leaves the rest of the set alone', () => {
  // The upsert path rewrites the whole array from a text field; this is the
  // surgical alternative, so a slip cannot silently delete a spelling.
  const target = cred('4471', ['BRAD', 'BRAD GOODROE', 'B GOODROE']);
  const plan = aliases.planAliasRemove(target, 'brad goodroe');
  assert.deepEqual(plan.aliases, ['BRAD', 'B GOODROE']);
  assert.equal(plan.removed, true);
});

test('removing an alias that is not there changes nothing', () => {
  const target = cred('4471', ['BRAD']);
  const plan = aliases.planAliasRemove(target, 'SOMEONE ELSE');
  assert.deepEqual(plan.aliases, ['BRAD']);
  assert.equal(plan.removed, false);
});

test('ambiguity counts ACTIVE credentials only', () => {
  // An active/inactive pair is not actually ambiguous — login never sees the
  // inactive one — so reporting it would be a false alarm.
  const live = { driverNumber: '4471', nuvizzAliases: ['SHARED'], active: true };
  const dead = { driverNumber: '9001', nuvizzAliases: ['SHARED'], active: false };
  assert.deepEqual(aliases.findAmbiguousAliases([live, dead]), [], 'not ambiguous in practice');

  const alsoLive = { driverNumber: '4472', nuvizzAliases: ['SHARED'], active: true };
  const found = aliases.findAmbiguousAliases([live, alsoLive]);
  assert.equal(found.length, 1, 'two live claimants IS ambiguous');
  assert.deepEqual(found[0].driverNumbers, ['4471', '4472']);
});

test('an empty alias is refused rather than stored', () => {
  const plan = aliases.planAliasAdd(cred('0000'), '   ', [cred('0000')]);
  assert.ok(plan.error);
});

test('the assigned alias actually resolves the driver afterwards', () => {
  // End to end: the point of the fix is that tomorrow the stop matches.
  const target = cred('0000', ['ZZ_NOBODY']);
  const plan = aliases.planAliasAdd(target, 'ALFRED MORGAN', [target]);
  const fixed = { ...target, nuvizzAliases: plan.aliases };
  assert.equal(aliases.stopBelongsToDriver({ driverUserName: 'ALFRED MORGAN' }, fixed), true);
  assert.equal(aliases.resolveDriverForAlias('Alfred  Morgan', [fixed]).driverNumber, '0000');
});

// ── Load order = reverse delivery order ──────────────────────────────────────

const seqStops = (seqs) =>
  seqs.map((seq, i) => ({ stopNbr: `S${i + 1}`, routeSeq: seq, loadStopSeq: null }));

test('a 13-stop load lists delivery stop 13 first and delivery stop 1 last', () => {
  const stamped = manifest.assignLoadSeq(seqStops([1,2,3,4,5,6,7,8,9,10,11,12,13]));
  const byLoadSeq = stamped.slice().sort((a, b) => a.loadSeq - b.loadSeq);

  assert.equal(byLoadSeq[0].routeSeq, 13, 'first onto the trailer is the last delivered');
  assert.equal(byLoadSeq[0].loadSeq, 1);
  assert.equal(byLoadSeq.at(-1).routeSeq, 1, 'last onto the trailer is the first delivered');
  assert.equal(byLoadSeq.at(-1).loadSeq, 13);
  assert.equal(manifest.loadGroupCount(stamped), 13);
});

test('loadSeq and delivery seq are exact inverses at every position', () => {
  const stamped = manifest.assignLoadSeq(seqStops([1,2,3,4,5]));
  for (const s of stamped) {
    assert.equal(s.loadSeq + s.routeSeq, 6, `stop ${s.stopNbr}: loadSeq + routeSeq must be N+1`);
  }
});

test("Denis's 17 stops over 15 sequences make 15 groups, none split", () => {
  // 15 distinct sequence numbers, two of them carrying a co-located pair.
  const seqs = [1,2,3,4,5,6,7,7,8,9,10,11,12,13,14,15,15];
  const stamped = manifest.assignLoadSeq(seqStops(seqs));

  assert.equal(stamped.length, 17, 'every stop is still present');
  assert.equal(manifest.loadGroupCount(stamped), 15, '15 trailer positions, not 17');

  // Co-located stops share a position.
  const at7 = stamped.filter((s) => s.routeSeq === 7).map((s) => s.loadSeq);
  assert.deepEqual(at7, [9, 9], 'both stops at sequence 7 load at the same place');
  const at15 = stamped.filter((s) => s.routeSeq === 15).map((s) => s.loadSeq);
  assert.deepEqual(at15, [1, 1], 'the co-located last delivery is the nose');

  // And they stay adjacent once sorted into loading order.
  const order = stamped.slice().sort((a, b) => a.loadSeq - b.loadSeq || a.stopNbr.localeCompare(b.stopNbr));
  for (const seq of [7, 15]) {
    const idx = order.map((s, i) => (s.routeSeq === seq ? i : -1)).filter((i) => i >= 0);
    assert.equal(idx[1] - idx[0], 1, `stops sharing sequence ${seq} must be adjacent`);
  }
});

test('groupIntoLoads keeps delivery order in the array and only ADDS loadSeq', () => {
  const stops = [3, 1, 2].map((seq) =>
    manifest.toManifestStop({ stopNbr: `S${seq}`, loadNbr: 'L1', routeSeq: seq, pallets: 1 }),
  );
  const [load] = manifest.groupIntoLoads(stops);

  assert.deepEqual(load.stops.map((s) => s.routeSeq), [1, 2, 3], 'array is still delivery order');
  assert.deepEqual(load.stops.map((s) => s.loadSeq), [3, 2, 1], 'loadSeq is the reverse');
  assert.equal(load.loadGroupCount, 3);
  assert.equal(load.stopCount, 3);
});

test('a stop with no sequence at all gets a null loadSeq rather than position 1', () => {
  const stamped = manifest.assignLoadSeq([
    { stopNbr: 'A', routeSeq: 1, loadStopSeq: null },
    { stopNbr: 'B', routeSeq: null, loadStopSeq: null },
  ]);
  assert.equal(stamped.find((s) => s.stopNbr === 'B').loadSeq, null);
  assert.equal(stamped.find((s) => s.stopNbr === 'A').loadSeq, 1);
});

test('loadStopSeq wins over routeSeq so the two orders can never drift apart', () => {
  const stamped = manifest.assignLoadSeq([
    { stopNbr: 'A', routeSeq: 1, loadStopSeq: 9 },
    { stopNbr: 'B', routeSeq: 2, loadStopSeq: 5 },
  ]);
  assert.equal(stamped.find((s) => s.stopNbr === 'A').loadSeq, 1, 'seq 9 delivers last, loads first');
  assert.equal(stamped.find((s) => s.stopNbr === 'B').loadSeq, 2);
});

// ── Resequence guard ─────────────────────────────────────────────────────────

test('the sequence fingerprint changes when dispatch reorders the route', () => {
  const before = manifest.sequenceFingerprint([
    { stopNbr: 'A', routeSeq: 1 }, { stopNbr: 'B', routeSeq: 2 },
  ]);
  const reordered = manifest.sequenceFingerprint([
    { stopNbr: 'A', routeSeq: 2 }, { stopNbr: 'B', routeSeq: 1 },
  ]);
  assert.notEqual(before, reordered, 'a swap must be detectable');
});

test('the fingerprint ignores array order, so a harmless re-sort is not an alarm', () => {
  const a = manifest.sequenceFingerprint([{ stopNbr: 'A', routeSeq: 1 }, { stopNbr: 'B', routeSeq: 2 }]);
  const b = manifest.sequenceFingerprint([{ stopNbr: 'B', routeSeq: 2 }, { stopNbr: 'A', routeSeq: 1 }]);
  assert.equal(a, b, 'same stops, same sequences — no false alarm');
});

test('adding or dropping a stop changes the fingerprint', () => {
  const base = manifest.sequenceFingerprint([{ stopNbr: 'A', routeSeq: 1 }]);
  const added = manifest.sequenceFingerprint([{ stopNbr: 'A', routeSeq: 1 }, { stopNbr: 'B', routeSeq: 2 }]);
  assert.notEqual(base, added);
});

// ── Non-scannable freight ────────────────────────────────────────────────────

test('an Averitt stop (no piece total) is marked not scannable', () => {
  // No totalPallets on the Inbound Integration feed, and the pallet carries an
  // Averitt label whose barcodes the scanner cannot parse.
  const m = manifest.toManifestStop({ stopNbr: '9185096', cartons: 2, volume: 0 });
  assert.equal(m.scannable, false);
  assert.equal(m.countIsEstimated, true);
  assert.equal(m.expectedPieces, 2, 'still counts toward the load');
});

test('an ordinary Uline stop stays scannable', () => {
  const m = manifest.toManifestStop({ stopNbr: '7152411', pallets: 7, cartons: 3, volume: 4 });
  assert.equal(m.scannable, true);
});

test('an explicit scannable flag on the index row overrides the inference', () => {
  assert.equal(
    manifest.toManifestStop({ stopNbr: '1', cartons: 1 }).scannable, false, 'inferred not scannable',
  );
  assert.equal(
    manifest.toManifestStop({ stopNbr: '1', cartons: 1, scannable: true }).scannable, true,
    'index row can correct it without a deploy',
  );
  assert.equal(
    manifest.toManifestStop({ stopNbr: '1', pallets: 5, scannable: false }).scannable, false,
    'and can mark a stop unscannable even when it reported a total',
  );
});

test('stopIsScannable takes the explicit flag over the estimate in both directions', () => {
  assert.equal(manifest.stopIsScannable({ scannable: false }, false), false);
  assert.equal(manifest.stopIsScannable({ scannable: true }, true), true);
  assert.equal(manifest.stopIsScannable({}, true), false);
  assert.equal(manifest.stopIsScannable({}, false), true);
});

// ── Hand-confirm ingest ──────────────────────────────────────────────────────

test('a hand-confirm normalizes and defaults its reason', () => {
  const { row } = session.normalizeHandConfirm({ stopNbr: '9185096', pieces: 2 });
  assert.equal(row.stopNbr, '9185096');
  assert.equal(row.pieces, 2);
  assert.equal(row.reason, 'not_scannable');
  assert.ok(Date.parse(row.confirmedAt), 'timestamped');
});

test('a hand-confirm is rejected with a reason rather than dropped silently', () => {
  assert.match(session.normalizeHandConfirm({ pieces: 2 }).reason, /stopNbr/);
  assert.match(session.normalizeHandConfirm({ stopNbr: '1', pieces: -1 }).reason, /piece count/);
  assert.match(session.normalizeHandConfirm({ stopNbr: '1', pieces: 'two' }).reason, /piece count/);
});

test('replaying a queued hand-confirm never double-counts a stop', () => {
  const first = session.normalizeHandConfirm({ stopNbr: '9185096', pieces: 2, confirmedAt: '2026-08-04T10:00:00.000Z' }).row;
  const replay = session.normalizeHandConfirm({ stopNbr: '9185096', pieces: 2, confirmedAt: '2026-08-04T11:00:00.000Z' }).row;

  const one = session.mergeHandConfirms([], [first]);
  assert.equal(one.added, 1);

  const two = session.mergeHandConfirms(one.handConfirms, [replay]);
  assert.equal(two.handConfirms.length, 1, 'still one stop');
  assert.equal(two.added, 0);
  assert.equal(two.duplicates, 1);
  assert.equal(two.handConfirms[0].confirmedAt, '2026-08-04T10:00:00.000Z', 'first confirmation keeps the time');
});

test('a hand-confirm never becomes a scan — the two sets stay separate', () => {
  const scan = session.normalizeScan({ og: 'OG6028479182', pro: '7152411' }).row;
  const hand = session.normalizeHandConfirm({ stopNbr: '9185096', pieces: 2 }).row;
  assert.equal('og' in hand, false, 'a hand-confirm has no piece ID and must not fake one');
  assert.equal('pieces' in scan, false);
  assert.equal(session.mergeScans([], [scan]).scans.length, 1);
  assert.equal(session.mergeHandConfirms([], [hand]).handConfirms.length, 1);
});

// ── Loader pick list ─────────────────────────────────────────────────────────

const dayStops = () => [
  manifest.toManifestStop({ stopNbr: '1', loadNbr: 'L1', pallets: 3, loadStopSeq: 1, driverName: 'MICHAEL FRYE', routeName: 'R-1' }),
  manifest.toManifestStop({ stopNbr: '2', loadNbr: 'L1', pallets: 2, loadStopSeq: 2, driverName: 'MICHAEL FRYE', routeName: 'R-1' }),
  manifest.toManifestStop({ stopNbr: '3', loadNbr: 'L2', pallets: 5, driverName: 'BRAD GOODROE', routeName: 'R-2' }),
];

test('the pick list is one row per load, with whose truck it is', () => {
  const rows = manifest.loadSummaries(dayStops());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    loadNbr: 'L1', routeName: 'R-1', driverName: 'MICHAEL FRYE', stopCount: 2, expectedPieces: 5,
  });
  assert.equal(rows[1].driverName, 'BRAD GOODROE');
});

test('a pick-list row carries NO stops — a phone never gets the whole board', () => {
  for (const row of manifest.loadSummaries(dayStops())) {
    assert.equal('stops' in row, false, `${row.loadNbr} must not ship its stops`);
    assert.equal('raw' in row, false);
  }
});

test('the pick list falls back to driverUserName, then to null', () => {
  const rows = manifest.loadSummaries([
    manifest.toManifestStop({ stopNbr: '1', loadNbr: 'A', driverUserName: 'VINCENT BONZO' }),
    manifest.toManifestStop({ stopNbr: '2', loadNbr: 'B' }),
  ]);
  assert.equal(rows[0].driverName, 'VINCENT BONZO');
  assert.equal(rows[1].driverName, null, 'an unassigned truck says so rather than inventing a name');
});

test('pick-list piece totals match what the load screen will show', () => {
  const stops = dayStops();
  const rows = manifest.loadSummaries(stops);
  const full = manifest.groupIntoLoads(stops);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].expectedPieces, full[i].expectedPieces, `${rows[i].loadNbr} agrees`);
    assert.equal(rows[i].stopCount, full[i].stopCount);
  }
});

// ── Scan ingest idempotency ──────────────────────────────────────────────────

test('a scan is rejected with a reason rather than dropped silently', () => {
  assert.match(session.normalizeScan({ og: '', pro: '7152411' }).reason, /missing og/);
  assert.match(session.normalizeScan({ og: 'OG123', pro: '7152411' }).reason, /OG\+10/);
  assert.match(session.normalizeScan({ og: 'OG6028479182', pro: '' }).reason, /pro/);
});

test('a valid scan normalizes the PRO and defaults the engine', () => {
  const { row } = session.normalizeScan({ og: 'og6028479182', pro: '007152411' });
  assert.equal(row.og, 'OG6028479182');
  assert.equal(row.pro, '7152411');
  assert.equal(row.engine, 'manual', 'unknown engine falls back rather than being trusted');
});

test('replaying a queued scan never duplicates a piece', () => {
  const first = session.normalizeScan({ og: 'OG6028479182', pro: '7152411', engine: 'native', scannedAt: '2026-07-29T10:00:00.000Z' }).row;
  const replay = session.normalizeScan({ og: 'OG6028479182', pro: '7152411', engine: 'native', scannedAt: '2026-07-29T11:00:00.000Z' }).row;

  const one = session.mergeScans([], [first]);
  assert.equal(one.added, 1);

  const two = session.mergeScans(one.scans, [replay]);
  assert.equal(two.scans.length, 1, 'still one physical piece');
  assert.equal(two.added, 0);
  assert.equal(two.duplicates, 1);
  assert.equal(two.scans[0].scannedAt, '2026-07-29T10:00:00.000Z', 'the first sighting keeps the timestamp');
});

test('merging is order independent and sorted by time', () => {
  const mk = (og, at) => session.normalizeScan({ og, pro: '7152411', scannedAt: at }).row;
  const a = mk('OG6028479182', '2026-07-29T10:00:00.000Z');
  const b = mk('OG6028479183', '2026-07-29T09:00:00.000Z');
  const out = session.mergeScans([], [a, b]);
  assert.deepEqual(out.scans.map((s) => s.og), ['OG6028479183', 'OG6028479182']);
});

// ── Surplus must be as visible as shortfall ─────────────────────────────────
//
// Five stops on Alfred's load sat at 2/1 reporting "0 missing" while the pieces
// they had stolen were missing from FRSTEAM and COREFIVE. A stop over its count
// is the SIGNATURE of mis-attribution, and it read as contentment.

test('ACCEPTANCE: a stop with more distinct OGs than expected reports the surplus', () => {
  const rows = ACT.reconcileStops(
    [{ stopNbr: '1', businessName: 'ONE PIECE STOP', expectedPieces: 1, isPickup: false }],
    [sc('OG0000000001', '1'), sc('OG0000000002', '1')],
    [],
  );
  const one = rows[0];
  assert.equal(one.scanned, 2);
  assert.equal(one.extra, 1, 'the surplus piece is named');
  assert.equal(one.short, 0, 'and it is NOT short');
  assert.equal(one.complete, false, 'over its count is not complete either');
});

test('a stop exactly on its count has no surplus', () => {
  const rows = ACT.reconcileStops(
    [{ stopNbr: '1', businessName: 'EXACT', expectedPieces: 2, isPickup: false }],
    [sc('OG0000000001', '1'), sc('OG0000000002', '1')],
    [],
  );
  assert.equal(rows[0].extra, 0);
  assert.equal(rows[0].complete, true);
});

test('a pickup never reports surplus — nothing loads there', () => {
  const rows = ACT.reconcileStops(
    [{ stopNbr: '3', businessName: 'ROUTE PICKUP', expectedPieces: 0, isPickup: true }],
    [sc('OG0000000009', '3')],
    [],
  );
  assert.equal(rows[0].extra, 0);
  assert.equal(rows[0].short, 0);
});

test('the per-scan log is exposed in order, with the stop each piece landed on', () => {
  // Totals alone could not tell "extra freight" apart from "counted against the
  // wrong stop". The order is the evidence.
  const out = ACT.buildActivity({
    date: '2026-08-07',
    loads: [{ loadNbr: 'ATL', expectedPieces: 2, stopCount: 2, driverName: 'ALFRED MORGAN',
      stops: [
        { stopNbr: '1', businessName: 'TIFOSI', expectedPieces: 1, isPickup: false },
        { stopNbr: '2', businessName: 'FRSTEAM', expectedPieces: 1, isPickup: false },
      ] }],
    sessions: [{ loadNbr: 'ATL', date: '2026-08-07', scannedCount: 2,
      scans: [
        { og: 'OG0000000002', pro: '7000002', stopNbr: '1', scannedAt: '2026-08-07T10:00:05Z', engine: 'wedge' },
        { og: 'OG0000000001', pro: '7000001', stopNbr: '1', scannedAt: '2026-08-07T10:00:01Z', engine: 'wedge' },
      ] }],
    creds: [],
  });
  const log = out.loads[0].scanLog;
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((r) => r.og), ['OG0000000001', 'OG0000000002'], 'oldest first, regardless of stored order');
  assert.equal(log[0].pro, '7000001');
  assert.equal(log[0].stopNbr, '1', 'the stop the piece actually landed on');
  assert.equal(log[0].engine, 'wedge');
  // And the mis-attribution is legible: both pieces on stop 1, none on stop 2.
  const detail = out.loads[0].stops;
  assert.equal(detail.find((s) => s.stopNbr === '1').extra, 1, 'TIFOSI holds one it should not');
  assert.equal(detail.find((s) => s.stopNbr === '2').short, 1, 'FRSTEAM is short by exactly that piece');
});

// ── The real load identity ──────────────────────────────────────────────────
//
// A stop's `loadNbr` is the ROUTE NAME — nuvizz-list.mts:268 overwrites it — so
// Steven's every stop reads "STEVEN", the same string every day. The roster is
// where the genuine per-day numbers live:
//   08-10  STEVEN  DAVIS000201342  6a7987c21b7e7eee4b47441f
//   08-11  STEVEN  DAVIS000201345  6a7ac732cc81cf65c8e52bd6
//   08-12  STEVEN  DAVIS000201463  6a7c36733a2a78b090799a4f

const roster0812 = [
  { loadId: '6a7c36733a2a78b090799a4f', name: 'STEVEN', loadNbr: 'DAVIS000201463', status: 'Dispatched' },
  { loadId: '6a7c36733a2a78b090799b11', name: 'MANDI', loadNbr: 'DAVIS000201464', status: 'Dispatched' },
];

test('a route name resolves to the days real load number and id', async () => {
  const { resolveLoadIdentity } = await import('../netlify/functions/lib/manifest.mts');
  const r = resolveLoadIdentity(roster0812, 'STEVEN');
  assert.equal(r.loadId, '6a7c36733a2a78b090799a4f');
  assert.equal(r.loadNbr, 'DAVIS000201463', 'not "STEVEN" — the genuine number');
  assert.equal(r.ambiguous, false);
});

test('the same route on another day is a DIFFERENT load', async () => {
  const { resolveLoadIdentity } = await import('../netlify/functions/lib/manifest.mts');
  const prior = [{ loadId: '6a7ac732cc81cf65c8e52bd6', name: 'STEVEN', loadNbr: 'DAVIS000201345' }];
  assert.notEqual(
    resolveLoadIdentity(roster0812, 'STEVEN').loadId,
    resolveLoadIdentity(prior, 'STEVEN').loadId,
    'which is the whole point — the route name never distinguished these',
  );
});

test('two loads sharing a name in one day REFUSE to resolve', async () => {
  // A cancelled STEVEN load once put a red badge on the live one. Picking either
  // would silently attach scans to the wrong truck.
  const { resolveLoadIdentity } = await import('../netlify/functions/lib/manifest.mts');
  const dup = [
    { loadId: 'aaa', name: 'STEVEN', loadNbr: 'DAVIS000201463', status: 'Dispatched' },
    { loadId: 'bbb', name: 'STEVEN', loadNbr: 'DAVIS000201399', status: 'Cancelled' },
  ];
  const r = resolveLoadIdentity(dup, 'STEVEN');
  assert.equal(r.loadId, null, 'no guess');
  assert.equal(r.ambiguous, true, 'and it says why');
});

test('a name absent from the roster is unresolved, not ambiguous', async () => {
  const { resolveLoadIdentity } = await import('../netlify/functions/lib/manifest.mts');
  const r = resolveLoadIdentity(roster0812, 'NOBODY');
  assert.equal(r.loadId, null);
  assert.equal(r.ambiguous, false, 'a cold or partial roster is not a collision');
});

test('an empty roster resolves nothing and does not throw', async () => {
  const { resolveLoadIdentity } = await import('../netlify/functions/lib/manifest.mts');
  for (const bad of [[], null, undefined]) {
    assert.equal(resolveLoadIdentity(bad, 'STEVEN').loadId, null);
  }
  assert.equal(resolveLoadIdentity(roster0812, '').loadId, null);
});
