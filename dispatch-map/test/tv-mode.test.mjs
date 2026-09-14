// test/tv-mode.test.mjs — the office wall display.
//
// Chad wanted the board on a 55" TV in the office. Every rule under test here exists because
// a screen nobody can touch fails differently from a dispatch board: there is no person in
// front of it to notice that a number stopped moving, so "quietly wrong" and "obviously
// broken" have to be kept apart by the code rather than by whoever is looking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTvPath, tvRailRows, tvVerdict, tvFeedState, tvFeedStale, TV_RAIL_LIMIT } from '../src/lib/tv-mode.js';

// ── the URL ────────────────────────────────────────────────────────────────
test('/tv is the wall display, and a kiosk launcher may send a trailing slash', () => {
  assert.equal(isTvPath('/tv'), true);
  assert.equal(isTvPath('/tv/'), true);
  assert.equal(isTvPath('/TV'), true, 'a TV browser may upper-case the bookmark');
  assert.equal(isTvPath('/tv?kiosk=1'), true, 'a kiosk shell appends its own query string');
  assert.equal(isTvPath('/tv#top'), true);
});

test('a path that merely STARTS with /tv is not the wall display', () => {
  // The SPA catch-all serves index.html for every path, so a prefix test would put a typo'd
  // or future URL into TV mode on a screen nobody is watching — with no keyboard to leave it.
  assert.equal(isTvPath('/tvxyz'), false);
  assert.equal(isTvPath('/tv-board'), false);
  assert.equal(isTvPath('/tv/extra'), false);
  assert.equal(isTvPath('/'), false);
  assert.equal(isTvPath(''), false);
  assert.equal(isTvPath(null), false);
  assert.equal(isTvPath(undefined), false);
});

// ── the flag rail ──────────────────────────────────────────────────────────
const row = (tier, key, extra = {}) => ({ tier, dismissKey: key, title: `stop ${key}`, ...extra });

test('the rail carries what needs a phone call — amber is a count, not a row', () => {
  // The morning this is written for: three reds somebody can still save, behind
  // twenty-five ambers. Listing all of them pushes the three off a screen that cannot scroll.
  const rows = [
    ...Array.from({ length: 25 }, (_, i) => row('amber', `a${i}`)),
    row('red', 'r1'), row('critical', 'c1'), row('red', 'r2'),
  ];
  const out = tvRailRows(rows, {});
  assert.equal(out.urgent, 3);
  assert.equal(out.amber, 25);
  assert.equal(out.rows.length, 3);
  assert.ok(out.rows.every((r) => r.tier !== 'amber'), 'no advisory row reaches the rail');
});

test('critical sits above red — the worst stop is the one at eye level', () => {
  const out = tvRailRows([row('red', 'r1'), row('critical', 'c1'), row('red', 'r2')], {});
  assert.equal(out.rows[0].dismissKey, 'c1');
});

test('a dismissed flag is gone from the rail, exactly as it is from the board', () => {
  const out = tvRailRows([row('red', 'r1'), row('critical', 'c1')], { r1: true });
  assert.equal(out.urgent, 1);
  assert.equal(out.rows[0].dismissKey, 'c1');
});

test('THE TRUNCATION IS REPORTED — twelve rows on a thirty-flag morning is not "twelve problems"', () => {
  const rows = Array.from({ length: 30 }, (_, i) => row('red', `r${i}`));
  const out = tvRailRows(rows, {});
  assert.equal(out.rows.length, TV_RAIL_LIMIT);
  assert.equal(out.overflow, 30 - TV_RAIL_LIMIT);
  assert.equal(out.urgent, 30, 'the true total survives the cap');
});

test('a malformed limit leaves the rail full, never empty', () => {
  // A blank rail reads as a clean board. A typo'd constant must never be able to produce one.
  const rows = Array.from({ length: 20 }, (_, i) => row('red', `r${i}`));
  for (const bad of [0, -1, NaN, null, undefined, 'twelve']) {
    assert.equal(tvRailRows(rows, {}, bad).rows.length, TV_RAIL_LIMIT, `limit ${String(bad)}`);
  }
});

test('nothing at all still answers in the right shape', () => {
  for (const empty of [null, undefined, [], 'nope']) {
    const out = tvRailRows(empty, null);
    assert.deepEqual(out, { rows: [], overflow: 0, urgent: 0, amber: 0 });
  }
});

// ── the verdict across the top ─────────────────────────────────────────────
test('"nothing needs a call" is SAID, because an empty rail and a broken one look the same', () => {
  assert.deepEqual(tvVerdict({ urgent: 0, amber: 0, feed: 'live' }), { tone: 'clear', text: 'Nothing needs a call' });
});

test('one stop reads as one stop — the sentence agrees with the number', () => {
  assert.equal(tvVerdict({ urgent: 1 }).text, '1 stop needs a call');
  assert.equal(tvVerdict({ urgent: 4 }).text, '4 stops need a call');
});

test('advisories are reported without being promoted to an emergency', () => {
  const v = tvVerdict({ urgent: 0, amber: 6 });
  assert.equal(v.tone, 'watch');
  assert.equal(v.text, '6 to watch · nothing needs a call');
});

test('A DEAD FEED BEATS A CLEAN BOARD — the wall must never print "all clear" over stale counts', () => {
  // The failure this exists for: the scan stops at 6am and the television shows a perfect
  // morning until somebody happens to check the board on a laptop that afternoon.
  assert.equal(tvVerdict({ urgent: 0, amber: 0, feed: 'stale' }).tone, 'stale');
  assert.equal(tvVerdict({ urgent: 9, amber: 3, feed: 'stale' }).tone, 'stale',
    'even with flags on the board, "these counts are old" is the thing to say first');
});

test('AND A BOARD THAT NEVER LOADED BEATS BOTH — the bug that reached Chad\'s wall', () => {
  // THE REAL ONE, photographed on the office TV its first morning: "0 stops", "loading…",
  // and beside them a green "Nothing needs a call" over a board the screen had never once
  // read. 'down' is its own tone precisely so that sentence cannot be produced again.
  const v = tvVerdict({ urgent: 0, amber: 0, feed: 'down' });
  assert.equal(v.tone, 'down');
  assert.match(v.text, /NO BOARD/);
  assert.notEqual(v.tone, 'clear', 'nothing read is never an all-clear');
});

test('mid-boot says so instead of reporting the zero it has not filled yet', () => {
  assert.equal(tvVerdict({ urgent: 0, amber: 0, feed: 'loading' }).tone, 'loading');
});

test('junk counts fall to the safe reading rather than inventing freight', () => {
  assert.equal(tvVerdict({ urgent: NaN, amber: null }).tone, 'clear');
  assert.equal(tvVerdict({}).tone, 'clear');
  assert.equal(tvVerdict().tone, 'clear');
  assert.equal(tvVerdict({ urgent: -3 }).tone, 'clear', 'a negative count is not a call to make');
});

// ── feed freshness ─────────────────────────────────────────────────────────
test('a board refreshed inside its budget is not stale', () => {
  const now = 1_800_000_000_000;
  assert.equal(tvFeedStale(new Date(now - 60_000), now, 600_000), false);
  assert.equal(tvFeedStale(now - 599_000, now, 600_000), false);
});

test('a board that stopped updating IS stale, and says so', () => {
  const now = 1_800_000_000_000;
  assert.equal(tvFeedStale(new Date(now - 900_000), now, 600_000), true);
});

test('NOT YET LOADED IS NOT STALE — the first ten seconds of every morning', () => {
  // Painting the boot as a failure is how a room learns to ignore the one warning that matters.
  const now = 1_800_000_000_000;
  assert.equal(tvFeedStale(null, now, 600_000), false);
  assert.equal(tvFeedStale(undefined, now, 600_000), false);
  assert.equal(tvFeedStale(0, now, 600_000), false);
  assert.equal(tvFeedStale('nonsense', now, 600_000), false);
});

// ── the feed state: "not yet" and "never" are different claims ──────────────
const T = 1_700_000_000_000;

test("THE WALL'S FIRST MORNING: a board that never loaded is DOWN, not clear", () => {
  // Reproduces the photograph exactly — mounted, polling, nothing ever came back.
  const f = tvFeedState({ lastRefreshed: null, error: null, bootedAt: T, nowMs: T + 5 * 60_000 });
  assert.equal(f.state, 'down');
  assert.equal(f.text, 'Board has not loaded');
  assert.equal(tvVerdict({ urgent: 0, amber: 0, feed: f.state }).tone, 'down');
});

test('inside the grace window it is honestly still loading', () => {
  // Nobody should read a boot as a breakage; the first seconds of every morning look like this.
  const f = tvFeedState({ lastRefreshed: null, error: null, bootedAt: T, nowMs: T + 10_000 });
  assert.equal(f.state, 'loading');
  assert.equal(tvVerdict({ urgent: 0, amber: 0, feed: f.state }).tone, 'loading');
});

test('AN ERROR SHORT-CIRCUITS THE GRACE — waiting out a timer to admit it is a slower lie', () => {
  const f = tvFeedState({ lastRefreshed: null, error: 'HTTP 502', bootedAt: T, nowMs: T + 3_000 });
  assert.equal(f.state, 'down');
  assert.match(f.text, /HTTP 502/, 'and it says WHAT went wrong, on the wall');
});

test('a board that loaded and then went quiet is stale, not down — the freight on screen is real', () => {
  const f = tvFeedState({ lastRefreshed: T, error: null, bootedAt: T, nowMs: T + 40 * 60_000, budgetMs: 10 * 60_000 });
  assert.equal(f.state, 'stale');
  assert.match(f.text, /not updating/);
});

test('a live board reads its own age and nothing louder', () => {
  const f = tvFeedState({ lastRefreshed: T, error: null, bootedAt: T, nowMs: T + 3 * 60_000, budgetMs: 10 * 60_000 });
  assert.equal(f.state, 'live');
  assert.equal(f.text, 'updated 3 min ago');
  assert.equal(tvVerdict({ urgent: 0, amber: 0, feed: f.state }).tone, 'clear');
});

test('a LATER failure never demotes a board that has real freight on it', () => {
  // The stops on screen came from a successful read. A failed poll after that is worth saying
  // (it goes stale on the budget) but "NO BOARD" would be false — and false in the direction
  // that makes people stop believing the screen.
  const f = tvFeedState({ lastRefreshed: T, error: 'HTTP 502', bootedAt: T, nowMs: T + 60_000, budgetMs: 10 * 60_000 });
  assert.equal(f.state, 'live');
});

test('tvFeedStale still answers only its own question, and null is still not stale', () => {
  // Kept deliberately: the bug was asking ONLY this question, not this answer.
  assert.equal(tvFeedStale(null, T, 600_000), false);
  assert.equal(tvFeedStale(T - 900_000, T, 600_000), true);
});
