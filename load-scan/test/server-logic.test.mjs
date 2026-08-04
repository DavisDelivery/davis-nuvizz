import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOADSCAN_JWT_SECRET = 'test-secret-that-is-long-enough-to-pass-32';

const auth = await import('../netlify/functions/lib/auth.mts');
const aliases = await import('../netlify/functions/lib/aliases.mts');
const manifest = await import('../netlify/functions/lib/manifest.mts');
const session = await import('../netlify/functions/scan-session.mts');

// ── PIN hashing ──────────────────────────────────────────────────────────────

test('a PIN round-trips through scrypt and never stores plaintext', async () => {
  const stored = await auth.hashPin('4821');
  assert.ok(stored.startsWith('scrypt$'), 'self-describing format');
  assert.equal(stored.includes('4821'), false, 'the PIN must not appear in the stored value');
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
