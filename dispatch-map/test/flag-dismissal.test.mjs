// test/flag-dismissal.test.mjs
//
// WHAT A DISMISSAL IS ALLOWED TO SILENCE.
//
// Chad, watching the board flags panel: "How are these coming and going?" Most of the answer
// is that flags are recomputed from a moving arrival estimate — but one part of it was a bug.
// Dismissing a row wrote ONE key built from the facts, and the hours_risk fingerprint
// (`hours|date|route|stop|close`) carries no tier. So waving off a stop while it read amber
// kept it hidden after it escalated to red and then critical: the loudest thing the board can
// say was silenceable by a shrug at the quietest version of it, with no way to tell from the
// screen that it had happened.
//
// The rule these pin is asymmetric on purpose:
//
//   getting WORSE  → comes back      (a dismissal only covers the rank it was made at, and below)
//   getting BETTER → stays dismissed (an improvement is not a reason to interrupt someone again)
//
// Putting the tier in the fingerprint alone would have produced BOTH — which is what
// closed_today does today, and why it re-raises rows that merely calmed down.
//
// PURE — no React, no storage, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags, dismissKeysFor, TIER_RANK, RED_CAP } from '../src/lib/board-flags.js';

// The dismissal predicate exactly as the app applies it (App.jsx: `!dismissed[r.dismissKey]`).
const hidden = (store, row) => !!store[row.dismissKey];
// A dismissal exactly as the app records it (writeDismissedFlag over the row's ladder).
const dismiss = (store, row) => { for (const k of row.dismissKeys) store[k] = Date.now(); return store; };

const rowAt = (tier) => ({
  tier, rule: 'hours_risk', scope: 'occurrence', servedDate: '2026-08-19',
  fingerprint: 'hours|2026-08-19|BEN 2|1283081681|720',
  dismissKey: `hours_risk|2026-08-19|hours|2026-08-19|BEN 2|1283081681|720|t${TIER_RANK[tier]}`,
  dismissKeys: null,
});
const mk = (tier) => { const r = rowAt(tier); r.dismissKeys = dismissKeysFor(r); return r; };

// ── THE BUG ──────────────────────────────────────────────────────────────────

test('THE BUG: waving off an amber must not silence the critical it becomes', () => {
  const store = dismiss({}, mk('amber'));
  assert.equal(hidden(store, mk('amber')), true, 'the row we dismissed stays dismissed');
  assert.equal(hidden(store, mk('red')), false, 'escalation to red comes back');
  assert.equal(hidden(store, mk('critical')), false, 'escalation to critical comes back');
});

test('a dismissal at red still covers red, and still yields to critical', () => {
  const store = dismiss({}, mk('red'));
  assert.equal(hidden(store, mk('amber')), true, 'de-escalation to amber stays quiet');
  assert.equal(hidden(store, mk('red')), true);
  assert.equal(hidden(store, mk('critical')), false, 'the worst tier is never pre-silenced');
});

test('THE OTHER DIRECTION: dismissing the worst covers the milder versions', () => {
  // Someone who has seen the critical and waved it off does not need the same stop back an
  // hour later reading amber. That is the case tier-in-the-fingerprint gets wrong.
  const store = dismiss({}, mk('critical'));
  for (const t of ['amber', 'red', 'critical']) {
    assert.equal(hidden(store, mk(t)), true, `${t} should stay dismissed`);
  }
});

test('the ladder is exactly the rank and everything below it', () => {
  assert.deepEqual(dismissKeysFor(mk('amber')).length, 1);
  assert.deepEqual(dismissKeysFor(mk('red')).length, 2);
  assert.deepEqual(dismissKeysFor(mk('critical')).length, 3);
  assert.ok(dismissKeysFor(mk('critical')).includes(mk('amber').dismissKey),
    'the critical dismissal must contain the amber key, or de-escalation would re-raise');
  assert.ok(!dismissKeysFor(mk('amber')).includes(mk('critical').dismissKey));
});

test('an unknown tier degrades to the mildest rank rather than throwing', () => {
  const r = { rule: 'x', scope: 'standing', fingerprint: 'f', tier: 'chartreuse' };
  assert.deepEqual(dismissKeysFor(r), ['x|f|t1']);
  assert.deepEqual(dismissKeysFor(null), []);
});

// ── STANDING VS OCCURRENCE IS UNCHANGED ──────────────────────────────────────

test('occurrence keys still carry the board day, standing keys still do not', () => {
  const occ = dismissKeysFor({ rule: 'hours_risk', scope: 'occurrence', servedDate: '2026-08-19', fingerprint: 'f', tier: 'amber' });
  const std = dismissKeysFor({ rule: 'no_location', scope: 'standing', servedDate: '2026-08-19', fingerprint: 'f', tier: 'amber' });
  assert.equal(occ[0], 'hours_risk|2026-08-19|f|t1', 'occurrences expire with their day');
  assert.equal(std[0], 'no_location|f|t1', 'standing rows persist until the facts change');
});

// ── THE COLLAPSED SUMMARY ROW OWNS ITS OWN KEY ───────────────────────────────

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const stops = (n) => Array.from({ length: n }, (_, i) => ({
  stopNbr: String(2000 + i), businessName: `CO ${i}`, addr1: `${i} Main`, city: 'Buford',
  lat: null, lng: null, matchKey: `co${i}|${i} main|buford|30518`,
  normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'SUW', routeName: 'SUW', routeSeq: i + 1, stopType: 'DO',
}));

test('a collapsed batch is dismissed as a batch, not as its first stop', () => {
  // The summary row used to be spread from rs[0], inheriting that stop's dismissKey. Waving
  // off "37 stops: ..." therefore wrote a key belonging to ONE stop: the batch came straight
  // back, and a single unrelated row went silent instead.
  const out = computeBoardFlags({
    stops: stops(RED_CAP + 25), notes: new Map(), servedDate: '2026-08-10', dayKey: 'mon',
    rosterRows: [], opts: { depot: DEPOT, departMin: 8 * 60 },
  });
  const collapsed = out.rows.find((r) => r.collapsed);
  assert.ok(collapsed, 'this many no-location stops must collapse');
  assert.match(collapsed.dismissKey, /\|collapsed\|/, 'the key is built from the collapsed fingerprint');
  assert.ok(!collapsed.dismissKey.includes('2000'), 'and carries no constituent stop number');
  assert.ok(Array.isArray(collapsed.dismissKeys) && collapsed.dismissKeys.length >= 1);
  assert.equal(collapsed.dismissKeys.at(-1), collapsed.dismissKey, 'its own rank tops the ladder');
});

// ── EVERY ROW THE ENGINE EMITS CARRIES A LADDER ──────────────────────────────

test('no rule can ship a row the panel cannot dismiss correctly', () => {
  const out = computeBoardFlags({
    stops: stops(3), notes: new Map(), servedDate: '2026-08-10', dayKey: 'mon',
    rosterRows: [], opts: { depot: DEPOT, departMin: 8 * 60 },
  });
  assert.ok(out.rows.length > 0, 'this board should raise something');
  for (const r of out.rows) {
    assert.ok(Array.isArray(r.dismissKeys) && r.dismissKeys.length >= 1, `${r.rule} has no ladder`);
    assert.equal(r.dismissKeys.at(-1), r.dismissKey, `${r.rule}: the row's own key must top its ladder`);
    assert.match(r.dismissKey, /\|t[123]$/, `${r.rule}: every key is rank-suffixed`);
  }
});
