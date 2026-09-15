// test/name-collision.test.mjs — TWO LOADS WEARING ONE NAME (lib/name-collision.mts, v1.31.0).
//
// The real numbers from 2026-09-15, pinned as rules. The board held 16 rows named ESTES; the
// 9/15 roster gave ONE load named ESTES (DAVIS000204034, Dispatched, Trevor Seyers, trips 10);
// six of the rows — no driver, arrivals 9/9–9/14, sequence numbers 1–6 colliding with Trevor's
// 1–6 — were on a week-old Draft of the same name. BUFORD: 8 rows, roster trips 7, the extra
// being 007174083-1 (ANNANDALE VILLAGE) on the 9/14 BUFORD DAVIS000203544. Every test below
// names the freight it was written for.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nameCollisionEnabled, nameCollisionLoadMax, nameCollisionMemoTtlMs, NAME_COLLISION_MEMO_TTL_MS,
  detectNameCollisions, membershipUsable, splitByMembership, otherInstances, memoUsable,
  collisionDetail, collisionLedgerRows, ownDayOf,
} from '../netlify/functions/lib/name-collision.mts';

const TODAY = '2026-09-15';
const NOW = Date.parse('2026-09-15T11:40:15.325Z');

const row = (nbr, { route = 'ESTES', seq = null, driver = null, arrival = TODAY, status = '20', norm = 'SCHEDULED', planned = true, extra = {} } = {}) => ({
  stopNbr: nbr, routeName: route, loadNbr: route, routeSeq: seq, driverName: driver,
  boardDate: arrival, scheduledDate: TODAY, status, normalizedStatus: norm, isPlanned: planned, isUnplanned: !planned, ...extra,
});

// Trevor's ten (sequence 1–10) and the six on the other ESTES (sequence 1–6, no driver).
const TREVOR = [
  ['ESTES-0151527287', 1, '2026-09-14'], ['ESTES-0312919364', 2, '2026-09-14'], ['ESTES-0328147549', 3, '2026-09-14'],
  ['007176207', 4, TODAY], ['007175991', 5, TODAY], ['ESTES-0488365474', 6, '2026-09-11'], ['ESTES-1798167517', 7, '2026-09-11'],
  ['ESTES-0108984838-1', 8, '2026-09-14'], ['ESTES-2938084479', 9, '2026-09-14'], ['ESTES-0528028438', 10, '2026-09-14'],
].map(([n, s, a]) => row(n, { seq: s, driver: 'Trevor Seyers', arrival: a }));
const STRAYS = [
  ['ESTES-0622705250', 1, '2026-09-09'], ['ESTES-0246025732', 2, '2026-09-09'], ['ESTES-0248999934', 3, '2026-09-11'],
  ['ESTES-2938084005', 4, '2026-09-14'], ['ESTES-0243731439', 5, '2026-09-14'], ['ESTES-1220829956', 6, '2026-09-14'],
].map(([n, s, a]) => row(n, { seq: s, arrival: a }));
const ROSTER_0915 = [
  { loadId: '6aa8ee9516f94c631bd556da', name: 'ESTES', loadNbr: 'DAVIS000204034', status: 'Dispatched', driver: 'Trevor Seyers', trips: 10 },
  { loadId: '6aa8eea1673007239212a358', name: 'ESTES 1', loadNbr: 'DAVIS000204035', status: 'Draft', driver: '', trips: 12 },
  { loadId: '6aa8f91b218c1cfe838f21bc', name: 'ESTES 2', loadNbr: 'DAVIS000204037', status: 'Draft', driver: '', trips: 9 },
  { loadId: '6aa17df75b97db56e47c358c', name: 'BUFORD', loadNbr: 'DAVIS000203661', status: 'Draft', driver: '', trips: 7 },
];
// What /load/info answers for Trevor's ESTES: raw + normalised forms, as lookupLoadStopNbrs returns them.
const membersOf = (rows) => new Set(rows.flatMap((r) => [r.stopNbr, String(r.stopNbr).toUpperCase().replace(/^0+(?=\d)/, '')]));

// ── the switch ───────────────────────────────────────────────────────────────

test('the switch is default ON, an off-word turns it off, and a typo leaves it ON', () => {
  assert.equal(nameCollisionEnabled({}), true);
  for (const v of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(nameCollisionEnabled({ NUVIZZ_NAME_COLLISION: v }), false, v);
  for (const v of ['on', '1', 'true', 'offf', 'disable', 'nope']) assert.equal(nameCollisionEnabled({ NUVIZZ_NAME_COLLISION: v }), true, v);
  assert.equal(nameCollisionLoadMax({}), 4);
  assert.equal(nameCollisionLoadMax({ NUVIZZ_NAME_COLLISION_LOAD_MAX: '2' }), 2);
  assert.equal(nameCollisionLoadMax({ NUVIZZ_NAME_COLLISION_LOAD_MAX: 'lots' }), 4, 'malformed → the default, never unbounded');
  assert.equal(nameCollisionMemoTtlMs({}), NAME_COLLISION_MEMO_TTL_MS);
  assert.equal(nameCollisionMemoTtlMs({ NUVIZZ_NAME_COLLISION_TTL_MIN: '30' }), 30 * 60_000);
});

// ── detection: the roster's count is the free contradiction detector ─────────

test('ESTES, 2026-09-15: 16 rows under a name the roster gives one load of 10 → a collision, with the sequence collision noted', () => {
  const found = detectNameCollisions([...TREVOR, ...STRAYS], ROSTER_0915);
  assert.equal(found.length, 1);
  const c = found[0];
  assert.equal(c.name, 'ESTES');
  assert.equal(c.loadNbr, 'DAVIS000204034');
  assert.equal(c.trips, 10);
  assert.equal(c.rows.length, 16);
  assert.equal(c.dupSeq, true, 'two "stop 1"s on one name is proof of two loads');
  assert.match(c.signature, /^DAVIS000204034\|10\|/);
});

test('BUFORD, 2026-09-15: 8 rows vs trips 7 → a collision even with no sequence numbers at all', () => {
  const rows = [
    row('007174083-1', { route: 'BUFORD', arrival: '2026-09-10' }),
    ...['007175989', '007176033', '007176123', '007176621', '007176729', '007176367', '007176121'].map((n) => row(n, { route: 'BUFORD' })),
  ];
  const found = detectNameCollisions(rows, ROSTER_0915);
  assert.equal(found.length, 1);
  assert.equal(found[0].loadNbr, 'DAVIS000203661');
  assert.equal(found[0].dupSeq, false);
});

test('rows that MATCH the roster count with distinct sequences are no collision — a healthy board costs nothing', () => {
  assert.deepEqual(detectNameCollisions(TREVOR, ROSTER_0915), []);
});

test('fewer rows than the roster counts is list lag, not a collision', () => {
  assert.deepEqual(detectNameCollisions(TREVOR.slice(0, 8), ROSTER_0915), []);
});

test('a count match with a duplicate sequence still asks — one foreign row can hide behind one missing row', () => {
  const rows = [...TREVOR.slice(0, 9), STRAYS[0]];   // 10 rows, two of them "stop 1"
  const found = detectNameCollisions(rows, ROSTER_0915);
  assert.equal(found.length, 1);
  assert.equal(found[0].dupSeq, true);
});

test('a name TWO loads carry on the same day is never judged here (§S: neither may speak for the other)', () => {
  const roster = [...ROSTER_0915, { loadId: 'x', name: 'ESTES', loadNbr: 'DAVIS000204099', status: 'Draft', driver: '', trips: 0 }];
  assert.deepEqual(detectNameCollisions([...TREVOR, ...STRAYS], roster), []);
});

test('a name the roster does not know, a load with no count, or a load with no number is left alone', () => {
  assert.deepEqual(detectNameCollisions([...TREVOR, ...STRAYS], []), [], 'no roster');
  assert.deepEqual(detectNameCollisions([...TREVOR, ...STRAYS], [{ name: 'ESTES', loadNbr: 'DAVIS000204034', trips: null }]), [], 'no count');
  assert.deepEqual(detectNameCollisions([...TREVOR, ...STRAYS], [{ name: 'ESTES', loadNbr: '', trips: 10 }]), [], 'no number to read');
  assert.deepEqual(detectNameCollisions([...TREVOR, ...STRAYS], null), []);
});

test('only PLANNED rows are counted under a name — an un-planned row carries no route', () => {
  const rows = [...TREVOR, row('X1', { planned: false, route: null }), row('X2', { planned: false, route: null })];
  assert.deepEqual(detectNameCollisions(rows, ROSTER_0915), []);
});

test('the signature is the load, the roster count and the exact stop set — a delivery does not change it, a moved order does', () => {
  const a = detectNameCollisions([...TREVOR, ...STRAYS], ROSTER_0915)[0].signature;
  const delivered = [...TREVOR.map((r, i) => (i === 3 ? { ...r, status: '90', normalizedStatus: 'DELIVERED' } : r)), ...STRAYS];
  assert.equal(detectNameCollisions(delivered, ROSTER_0915)[0].signature, a, 'a stop delivered on the load is the same collision');
  const reordered = [...STRAYS, ...TREVOR];
  assert.equal(detectNameCollisions(reordered, ROSTER_0915)[0].signature, a, 'row order is irrelevant');
  const moved = [...TREVOR, ...STRAYS.slice(1)];
  assert.notEqual(detectNameCollisions(moved, ROSTER_0915)[0].signature, a, 'one order leaving the name is a new question');
  const recounted = detectNameCollisions([...TREVOR, ...STRAYS], ROSTER_0915.map((l) => (l.name === 'ESTES' ? { ...l, trips: 11 } : l)))[0].signature;
  assert.notEqual(recounted, a, 'the roster counting one more is a new question');
});

// ── the membership read decides WHICH rows ───────────────────────────────────

test('ESTES: the load holds Trevor\'s ten → the six strays come off (own days 9/9–9/14), the ten stay', () => {
  const c = detectNameCollisions([...TREVOR, ...STRAYS], ROSTER_0915)[0];
  const split = splitByMembership(c, membersOf(TREVOR), { date: TODAY, nowMs: NOW, graceMin: 60 });
  assert.deepEqual(split.keep.map((r) => r.stopNbr).sort(), TREVOR.map((r) => r.stopNbr).sort());
  assert.deepEqual(split.foreign.map((r) => r.stopNbr).sort(), STRAYS.map((r) => r.stopNbr).sort());
  assert.deepEqual(split.keptSameDay, []);
  assert.deepEqual(split.keptStamped, []);
});

test('BUFORD: ANNANDALE VILLAGE (007174083-1, arrival 9/10) is not on DAVIS000203661 → off today\'s board; the seven stay', () => {
  const seven = ['007175989', '007176033', '007176123', '007176621', '007176729', '007176367', '007176121'].map((n) => row(n, { route: 'BUFORD' }));
  const rows = [row('007174083-1', { route: 'BUFORD', arrival: '2026-09-10' }), ...seven];
  const c = detectNameCollisions(rows, ROSTER_0915)[0];
  const split = splitByMembership(c, membersOf(seven), { date: TODAY, nowMs: NOW });
  assert.deepEqual(split.foreign.map((r) => r.stopNbr), ['007174083-1']);
  assert.equal(split.keep.length, 7);
});

test('membership matches across leading zeros and case — a padding difference can never fake a "not on the load"', () => {
  const c = detectNameCollisions([...TREVOR, ...STRAYS], ROSTER_0915)[0];
  const members = new Set(['estes-0151527287', '7176207', ...TREVOR.map((r) => r.stopNbr).slice(1, 10).filter((n) => n !== '007176207')]);
  // Only the normalised forms for two of them; both must still read as held.
  const norm = new Set([...members].map((n) => n.toUpperCase().replace(/^0+(?=\d)/, '')));
  const split = splitByMembership(c, norm, { date: TODAY, nowMs: NOW });
  assert.ok(split.keep.some((r) => r.stopNbr === 'ESTES-0151527287'));
  assert.ok(split.keep.some((r) => r.stopNbr === '007176207'));
});

test('NEVER HIDES TODAY\'S FREIGHT: a row the load does not hold whose own day is today (or later) is kept, and said so', () => {
  const todayStray = row('007177000', { arrival: TODAY });
  const tomorrowStray = row('007177001', { arrival: '2026-09-16' });
  const dateless = { ...row('007177002'), boardDate: null, scheduledDate: null, requestedDate: null };
  const c = detectNameCollisions([...TREVOR, ...STRAYS, todayStray, tomorrowStray, dateless], ROSTER_0915)[0];
  const split = splitByMembership(c, membersOf(TREVOR), { date: TODAY, nowMs: NOW });
  assert.deepEqual(split.keptSameDay.map((r) => r.stopNbr).sort(), ['007177000', '007177001', '007177002']);
  assert.equal(split.foreign.length, 6, 'the six past-day strays still come off');
});

test('a confirmed Save inside the write grace outranks a read that may be racing it; past the grace it does not', () => {
  const fresh = row('007177003', { arrival: '2026-09-14', extra: { board_write_planned: true, board_write_at: new Date(NOW - 10 * 60_000).toISOString() } });
  const stale = row('007177004', { arrival: '2026-09-14', extra: { board_write_planned: true, board_write_at: new Date(NOW - 90 * 60_000).toISOString() } });
  const unplanStamp = row('007177005', { arrival: '2026-09-14', extra: { board_write_planned: false, board_write_at: new Date(NOW - 10 * 60_000).toISOString() } });
  const c = detectNameCollisions([...TREVOR, fresh, stale, unplanStamp], ROSTER_0915)[0];
  const split = splitByMembership(c, membersOf(TREVOR), { date: TODAY, nowMs: NOW, graceMin: 60 });
  assert.deepEqual(split.keptStamped.map((r) => r.stopNbr), ['007177003']);
  assert.deepEqual(split.foreign.map((r) => r.stopNbr).sort(), ['007177004', '007177005']);
});

test('an EMPTY read against a counted load is a contradiction, not a verdict; a failed read is nothing; empty against an empty draft is fine', () => {
  assert.equal(membershipUsable(null, 7), false);
  assert.equal(membershipUsable(undefined, 0), false);
  assert.equal(membershipUsable(new Set(), 7), false, 'roster says 7, the load answered nothing — do not drop 8 rows on that');
  assert.equal(membershipUsable(new Set(), 0), true, 'BUFORD at 5:26 AM: an empty draft, one stray row → the stray is foreign');
  assert.equal(membershipUsable(new Set(['A']), 7), true);
});

// ── the memo: one read per collision, then only when it changes ──────────────

test('memoUsable: same signature inside the TTL stands in for a read; a changed signature, a bad stamp or the TTL do not', () => {
  const entry = { sig: 'DAVIS000204034|10|A,B', at: new Date(NOW - 60_000).toISOString(), members: ['A'], rows: 2, trips: 10 };
  assert.equal(memoUsable(entry, 'DAVIS000204034|10|A,B', NOW, NAME_COLLISION_MEMO_TTL_MS), true);
  assert.equal(memoUsable(entry, 'DAVIS000204034|11|A,B', NOW, NAME_COLLISION_MEMO_TTL_MS), false, 'the roster now counts 11');
  assert.equal(memoUsable(entry, 'DAVIS000204034|10|A,B', NOW + NAME_COLLISION_MEMO_TTL_MS, NAME_COLLISION_MEMO_TTL_MS), false, 'past the TTL: ask again');
  assert.equal(memoUsable({ ...entry, at: 'garbage' }, 'DAVIS000204034|10|A,B', NOW, NAME_COLLISION_MEMO_TTL_MS), false);
  assert.equal(memoUsable({ ...entry, members: null }, 'DAVIS000204034|10|A,B', NOW, NAME_COLLISION_MEMO_TTL_MS), false);
  assert.equal(memoUsable(null, 'x', NOW, NAME_COLLISION_MEMO_TTL_MS), false);
});

// ── the ledger: a dispatcher can read where it went ──────────────────────────

test('otherInstances: the same name on other days\' rosters, newest first, the judged day skipped', () => {
  const rosters = [
    { date: '2026-09-15', loads: ROSTER_0915 },
    { date: '2026-09-14', loads: [{ name: 'BUFORD', loadNbr: 'DAVIS000203544', status: 'Draft', trips: 1 }] },
    { date: '2026-09-11', loads: [{ name: 'buford', loadNbr: 'DAVIS000203456', status: 'Draft', trips: 0 }] },
    { date: '2026-09-13', loads: null },
  ];
  assert.deepEqual(otherInstances('BUFORD', rosters, { exceptDate: '2026-09-15' }), [
    { date: '2026-09-14', loadNbr: 'DAVIS000203544', status: 'Draft', trips: 1 },
    { date: '2026-09-11', loadNbr: 'DAVIS000203456', status: 'Draft', trips: 0 },
  ]);
  assert.deepEqual(otherInstances('ESTES', rosters, { exceptDate: '2026-09-15' }), []);
});

test('the ledger rows: dropped rows say where they went and where the other load is; kept rows say why they stayed', () => {
  const seven = ['007175989', '007176033', '007176123', '007176621', '007176729', '007176367', '007176121'].map((n) => row(n, { route: 'BUFORD' }));
  const rows = [row('007174083-1', { route: 'BUFORD', arrival: '2026-09-10' }), row('007177000', { route: 'BUFORD' }), ...seven];
  const c = detectNameCollisions(rows, ROSTER_0915)[0];
  const split = splitByMembership(c, membersOf(seven), { date: TODAY, nowMs: NOW });
  const others = [{ date: '2026-09-14', loadNbr: 'DAVIS000203544', status: 'Draft', trips: 1 }];
  const detail = collisionDetail(c, { date: TODAY, readAt: '2026-09-15T11:40:15.325Z', others });
  assert.equal(detail, 'not on DAVIS000203661 (BUFORD, 7 stops on the 2026-09-15 roster) — the load\'s own membership read at 2026-09-15T11:40:15.325Z does not list it; another load named BUFORD is on the 2026-09-14 roster (DAVIS000203544, Draft, 1 stop)');
  const ledger = collisionLedgerRows(c, split, { date: TODAY, at: '2026-09-15T11:40:15.325Z', readAt: '2026-09-15T11:40:15.325Z', fromMemo: false, others });
  assert.equal(ledger.length, 2);
  const dropped = ledger.find((r) => r.stopNbr === '007174083-1');
  assert.equal(dropped.verdict, 'dropped');
  assert.equal(dropped.basis, 'name-collision');
  assert.equal(dropped.route, 'BUFORD');
  assert.match(dropped.detail, /its own day is 2026-09-10, so it stays on that day's board and comes off 2026-09-15$/);
  assert.deepEqual(dropped.path, [
    'roster 2026-09-15: BUFORD → DAVIS000203661, 7 stops; the board held 9 rows under the name',
    'membership read: DAVIS000203661 holds 7 of them',
  ]);
  assert.equal(dropped.listStatus, '20');
  assert.equal(dropped.absent, false);
  const held = ledger.find((r) => r.stopNbr === '007177000');
  assert.equal(held.verdict, 'held');
  assert.match(held.detail, /its own day is 2026-09-15, so it stays on this board rather than vanish$/);
  const noOther = collisionDetail(c, { date: TODAY, readAt: 'T', others: [] });
  assert.match(noOther, /no other load by that name is on any recent roster$/);
});

test('ownDayOf: arrival, then requested, then scheduled; anything else is unknown', () => {
  assert.equal(ownDayOf({ boardDate: '2026-09-10', requestedDate: '2026-09-11' }), '2026-09-10');
  assert.equal(ownDayOf({ requestedDate: '2026-09-11', scheduledDate: '2026-09-12' }), '2026-09-11');
  assert.equal(ownDayOf({ scheduledDate: '2026-09-12' }), '2026-09-12');
  assert.equal(ownDayOf({ boardDate: 'yesterday' }), null);
  assert.equal(ownDayOf(null), null);
});

test('a row ABSENT from the pull (a carried demote candidate) makes no route claim here — it is the demotion verify\'s question', () => {
  const carried = { ...STRAYS[0], absentFromPull: true };
  const rows = [...TREVOR, carried];
  assert.deepEqual(detectNameCollisions(rows, ROSTER_0915), [], '11 rows but one of them is not the list\'s word');
});

test('a dispatcher-set board date is the row\'s own day: an order deferred onto this day is never a past-day stray', () => {
  const deferred = row('007177010', { arrival: '2026-09-10' });     // the list still says 9/10 …
  const c = detectNameCollisions([...TREVOR, deferred], ROSTER_0915)[0];
  const without = splitByMembership(c, membersOf(TREVOR), { date: TODAY, nowMs: NOW });
  assert.deepEqual(without.foreign.map((r) => r.stopNbr), ['007177010'], 'on its list date alone it would come off');
  const withSet = splitByMembership(c, membersOf(TREVOR), { date: TODAY, nowMs: NOW, overrides: { '007177010': TODAY } });
  assert.deepEqual(withSet.foreign, [], '… but the dispatcher filed it here on purpose');
  assert.deepEqual(withSet.keptSameDay.map((r) => r.stopNbr), ['007177010']);
  const garbage = splitByMembership(c, membersOf(TREVOR), { date: TODAY, nowMs: NOW, overrides: { '007177010': 'soon' } });
  assert.deepEqual(garbage.foreign.map((r) => r.stopNbr), ['007177010'], 'an unreadable override is no override');
});
