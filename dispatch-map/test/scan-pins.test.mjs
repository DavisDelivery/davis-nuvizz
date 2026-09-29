// Chad, 2026-09-29: a normal scan at 5:25p before the 5:30p customer-service email, and one at
// 6:20p before the 6:30p report — "no forced scans here just the normal scans".
import test from 'node:test';
import assert from 'node:assert/strict';
import { pinnedDueKinds, scanPinsEnabled, PINNED_SCANS, dueKinds, defaultScanRules, overrideCadenceSkip, scanPath } from '../netlify/functions/lib/scan-plan.mts';
import { scanDecision } from '../netlify/functions/lib/scan-schedule.mts';

// Tue 2026-09-29 is EDT (UTC-4): 17:25 ET = 21:25Z.
const at = (hhmm) => new Date(`2026-09-29T${hhmm}:00-04:00`);
const TUE = 2;
const pin = (hhmm, stamps) => {
  const d = at(hhmm);
  const [h, m] = hhmm.split(':').map(Number);
  return pinnedDueKinds(TUE, h, m, stamps, d.getTime());
};
const iso = (hhmm) => at(hhmm).toISOString();

test('5:25p on a weekday: both lists are due when the last scan was the 5:00 one', () => {
  const r = pin('17:25', { planned: iso('17:00'), completed: iso('17:15') });
  assert.equal(r.planned, true);
  assert.equal(r.completed, true);
  assert.equal(r.pin, 'pre-open-orders');
});

test('6:20p before the 6:30p report', () => {
  const r = pin('18:20', { planned: iso('18:00'), completed: iso('18:05') });
  assert.deepEqual([r.planned, r.completed, r.pin], [true, true, 'pre-day-report']);
});

test('once the pinned scan has stamped, the pin stands down for the rest of its window', () => {
  const r = pin('17:30', { planned: iso('17:25'), completed: iso('17:25') });
  assert.deepEqual([r.planned, r.completed, r.pin], [false, false, null]);
});

test('a scan in the five minutes before the pin already counts — no call spent to learn nothing', () => {
  const r = pin('17:25', { planned: iso('17:21'), completed: iso('17:21') });
  assert.equal(r.planned, false);
  assert.equal(r.completed, false);
});

test('a fire held back by the floor still catches the pin a few minutes late', () => {
  // A routine scan at 5:18 blocks 5:25 by the 10-minute floor; the 5:30 fire must still be due.
  const r = pin('17:30', { planned: iso('17:18'), completed: iso('17:18') });
  assert.equal(r.planned, true);
});

test('before the pin, and after its window, nothing extra is due', () => {
  assert.equal(pin('17:20', { planned: iso('16:30') }).pin, null);
  assert.equal(pin('17:45', { planned: iso('16:30') }).pin, null);
});

test('weekends are not pinned', () => {
  for (const wd of [0, 6]) {
    const r = pinnedDueKinds(wd, 18, 20, {}, at('18:20').getTime());
    assert.equal(r.pin, null);
  }
});

test('the roster is never pinned — only the two cheap list pulls', () => {
  for (const p of PINNED_SCANS) assert.deepEqual(p.kinds.sort(), ['completed', 'planned']);
  assert.equal(pin('17:25', {}).roster, false);
});

test('SCAN_PINS: on by default, off-words turn it off, a typo leaves it on', () => {
  assert.equal(scanPinsEnabled({}), true);
  for (const v of ['off', 'OFF', '0', 'false', 'no']) assert.equal(scanPinsEnabled({ SCAN_PINS: v }), false);
  assert.equal(scanPinsEnabled({ SCAN_PINS: 'of' }), true);
});

test('end to end at 5:25p: the legacy 30-min cadence gate is overridden and the fire takes the normal full list scan', () => {
  const now = at('17:25');
  // Last full scan 5:10 — the plan's 30-min planned band would not be due until ~5:38.
  const decision0 = scanDecision(now, false, iso('17:10'), {});
  assert.equal(decision0.act, false);
  assert.equal(decision0.skip, 'cadence');
  const stamps = { planned: iso('17:10'), completed: iso('17:15') };
  const due = dueKinds(decision0.weekday, decision0.etHour, defaultScanRules(), stamps, now.getTime());
  assert.equal(due.planned.due, false, 'without the pin, planned is not due at 5:25');
  const p = pinnedDueKinds(decision0.weekday, decision0.etHour, decision0.etMin, stamps, now.getTime());
  const decision = overrideCadenceSkip(decision0, p.planned, p.completed, false);
  assert.equal(decision.act, true);
  assert.equal(scanPath(decision.act, { plannedDue: p.planned, completedDue: p.completed, rosterDue: false }), 'full');
});

test('the floor still holds: a scan 3 minutes ago is not overridden by a pin', () => {
  const now = at('17:25');
  const decision0 = scanDecision(now, false, iso('17:22'), {});
  assert.equal(decision0.skip, 'floor');
  const decision = overrideCadenceSkip(decision0, true, true, false);
  assert.equal(decision.act, false);
});
