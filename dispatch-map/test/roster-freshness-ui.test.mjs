// test/roster-freshness-ui.test.mjs — is the load roster old, and can anyone TELL?
//
// Sibling to roster-freshness.test.mjs, which covers the other half: futureRosterCaptured, the
// SERVER rule that decides when the scanner re-pulls a future day's roster. That rule is why
// this file exists — it deliberately captures a future date once per ET scan day, so what the
// screen is showing can be hours old and correct at the same time. This file is about whether
// the screen admits it.
//
// Chad, 2026-09-05, on a Saturday looking at Tue Sep 8: "Where are all my empty loads." Then,
// after the rail's Loads tab was rebuilt to show exactly those: "even on the bottom panel the
// empty loads are missing."
//
// The grid was not dropping them — measured on the shipped bundle, 100 of 100 empty Drafts
// render. The roster it was handed had three loads in it, and no surface on the screen could
// say whether that was NuVizz's answer or a snapshot taken hours earlier. For a FUTURE date
// the scanner captures the roster ONCE per ET day (futureRosterCaptured), and the endpoint's
// documented ?live=1 override had no caller anywhere in the client — so a day two or three
// out was frozen at whatever the morning saw, with nothing on screen admitting it.
import test from 'node:test';
import assert from 'node:assert/strict';

import { rosterFreshness, ageLabel, etDay } from '../src/lib/roster-freshness.js';

const NOW = new Date('2026-09-05T18:00:00Z'); // 2:00p ET, Saturday

test("source:'none' is ABSENT — the endpoint held nothing and did not spend a call to check", () => {
  // Automatic reads no longer fall through to NuVizz (three fetch sites x every page load was
  // how a missing roster became fourteen calls a refresh). The honest answer is "not pulled",
  // with the Refresh button beside it — never "this day has no loads".
  const r = rosterFreshness({ ok: true, source: 'none', at: null, count: 0 }, NOW);
  assert.equal(r.known, false);
  assert.equal(r.tone, 'absent');
  assert.match(r.label, /not pulled/i);
});

test('a roster that never came back is ABSENT — never "there are no loads"', () => {
  // The distinction the old `loadRosterList.length > 0` test could not make: an empty answer
  // and no answer are the same empty array, and they send a dispatcher opposite ways.
  for (const meta of [null, undefined, {}, { ok: false }, { ok: 'yes' }, { loads: [] }]) {
    const r = rosterFreshness(meta, NOW);
    assert.equal(r.known, false, `${JSON.stringify(meta)} must read as absent`);
    assert.equal(r.tone, 'absent');
    assert.match(r.label, /not pulled/i);
  }
});

test('a cache says how old it is — the fact Sep 8 needed and did not have', () => {
  const r = rosterFreshness({ ok: true, source: 'cache', at: '2026-09-05T12:14:00Z', count: 3 }, NOW);
  assert.equal(r.known, true);
  assert.equal(r.live, false);
  assert.equal(r.stale, false, 'captured today — normal for a future day, not an alarm');
  assert.equal(r.count, 3);
  assert.equal(r.label, '3 loads · cached 6h ago');
});

test('a capture from an EARLIER ET day is stale — and that is a fact, not a threshold', () => {
  // The only staleness signal here. It is the scanner's own rule (one capture per scan day),
  // not an invented "over N minutes is old" bar — this repo has been bitten by a private
  // invisible threshold before.
  const r = rosterFreshness({ ok: true, source: 'cache', at: '2026-09-04T12:14:00Z', count: 3 }, NOW);
  assert.equal(r.stale, true);
  assert.equal(r.tone, 'stale');
  assert.match(r.label, /before today/);
});

test('a live pull is never stale and says where it came from', () => {
  const r = rosterFreshness({ ok: true, source: 'live', at: '2026-09-05T18:00:00Z', count: 106 }, NOW);
  assert.equal(r.live, true);
  assert.equal(r.stale, false);
  assert.equal(r.tone, 'live');
  assert.equal(r.label, '106 loads · straight from NuVizz');
});

test('an unreadable timestamp is reported as unknown, never asserted stale', () => {
  // Guessing "it must be old" from a stamp we could not parse is the kind of inference that
  // produces a confident wrong diagnosis.
  for (const at of [undefined, null, '', 'not-a-date']) {
    const r = rosterFreshness({ ok: true, source: 'cache', at, count: 1 }, NOW);
    assert.equal(r.age, null);
    assert.equal(r.stale, false, `at=${JSON.stringify(at)} must not claim staleness`);
    assert.equal(r.label, '1 load · cached, time unknown');
  }
});

test('the count comes from the envelope, and falls back to the rows when it has to', () => {
  assert.equal(rosterFreshness({ ok: true, source: 'cache', at: NOW.toISOString(), count: 0 }, NOW).count, 0);
  assert.equal(rosterFreshness({ ok: true, source: 'cache', at: NOW.toISOString() }, NOW).count, 0);
  assert.equal(rosterFreshness({ ok: true, source: 'cache', at: NOW.toISOString(), loads: [1, 2] }, NOW).count, 2);
  assert.equal(rosterFreshness({ ok: true, source: 'cache', at: NOW.toISOString(), count: 'x', loads: [1] }, NOW).count, 1);
  // …and one load is "1 load", not "1 loads". A dispatcher reads this line every morning.
  assert.match(rosterFreshness({ ok: true, source: 'live', at: NOW.toISOString(), count: 1 }, NOW).label, /^1 load ·/);
});

test('a zero-load roster is KNOWN — "NuVizz says this day has none" is an answer', () => {
  const r = rosterFreshness({ ok: true, source: 'live', at: NOW.toISOString(), count: 0 }, NOW);
  assert.equal(r.known, true, 'the vendor answered; the answer was zero');
  assert.equal(r.label, '0 loads · straight from NuVizz');
});

test('ageLabel is the app’s one age vocabulary, and fmtRosterAge’s rules are unchanged', () => {
  const t = (mins) => new Date(NOW.getTime() - mins * 60000).toISOString();
  assert.equal(ageLabel(t(0), NOW), 'just now');
  assert.equal(ageLabel(t(0.4), NOW), 'just now');
  assert.equal(ageLabel(t(12), NOW), '12m ago');
  assert.equal(ageLabel(t(59), NOW), '59m ago');
  assert.equal(ageLabel(t(60), NOW), '1h ago');
  assert.equal(ageLabel(t(60 * 23), NOW), '23h ago');
  assert.equal(ageLabel(t(60 * 48), NOW), '2d ago');
  assert.equal(ageLabel(null, NOW), null);
  assert.equal(ageLabel('rubbish', NOW), null);
  assert.equal(ageLabel(t(10), 'rubbish'), null, 'an unusable clock yields no label, not NaN');
});

test('etDay reads the EASTERN day, which is the day the scanner keys its capture by', () => {
  // 00:30 UTC on the 6th is still the 5th in Buford. Getting this wrong would call a capture
  // taken twenty minutes ago "before today" every evening.
  assert.equal(etDay(new Date('2026-09-06T00:30:00Z')), '2026-09-05');
  assert.equal(etDay(new Date('2026-09-05T18:00:00Z')), '2026-09-05');
  assert.equal(etDay('2026-09-05T18:00:00Z'), '2026-09-05');
  assert.equal(etDay('rubbish'), null);
  assert.equal(etDay(null), null);
});

test('an evening capture is not stale just because UTC has rolled over', () => {
  // The bug the ET comparison exists to prevent: at 8:30p ET the UTC date is already tomorrow.
  const at = '2026-09-06T00:20:00Z';        // 8:20p ET on the 5th
  const now = new Date('2026-09-06T00:40:00Z'); // 8:40p ET on the 5th
  const r = rosterFreshness({ ok: true, source: 'cache', at, count: 99 }, now);
  assert.equal(r.stale, false, 'twenty minutes old, same ET day — not "before today"');
});
