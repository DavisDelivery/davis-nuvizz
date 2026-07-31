// test/stop-timeline.test.mjs — the stop card's status timeline (Enhancement 6).
//
// The model's honesty rules are the tests: no invented times, a schedule window never shown
// as an ETA (the v0.54.4 "six stops all reading 8:00 AM" bug), and unknown states falling
// back to the badge instead of being forced into a delivery story.
import test from 'node:test';
import assert from 'node:assert/strict';

import { stopTimelineModel } from '../src/lib/stop-timeline.js';

const states = (m) => m.steps.map((s) => `${s.key}:${s.state}`).join(' ');

test('the four live kinds walk the three steps in order', () => {
  assert.equal(states(stopTimelineModel({ kind: 'SCHEDULED' })), 'sched:done out:pending end:pending');
  assert.equal(states(stopTimelineModel({ kind: 'OUT_FOR_DEL' })), 'sched:done out:active end:pending');
  assert.equal(states(stopTimelineModel({ kind: 'ARRIVED', arrivedAt: '10:32 AM' })), 'sched:done out:done end:active');
  assert.equal(states(stopTimelineModel({ kind: 'DELIVERED', deliveredAt: '6:04 PM' })), 'sched:done out:done end:done');
});

test('ARRIVED relabels the third step and carries the arrival time', () => {
  const m = stopTimelineModel({ kind: 'ARRIVED', arrivedAt: '10:32 AM' });
  assert.equal(m.steps[2].label, 'Arrived');
  assert.equal(m.steps[2].time, '10:32 AM');
});

test('DELIVERED carries the delivered time on the third step', () => {
  const m = stopTimelineModel({ kind: 'DELIVERED', deliveredAt: '6:04 PM' });
  assert.equal(m.steps[2].label, 'Delivered');
  assert.equal(m.steps[2].time, '6:04 PM');
});

test('the out-for-delivery step NEVER carries a time — the app has no real timestamp for it', () => {
  for (const kind of ['SCHEDULED', 'OUT_FOR_DEL', 'ARRIVED', 'DELIVERED']) {
    assert.equal(stopTimelineModel({ kind, arrivedAt: '9:14 AM', deliveredAt: '6:04 PM' }).steps[1].time, null, kind);
  }
});

test("an ETA shows only when it is NuVizz's REAL per-stop ETA — a schedule window never rides (v0.54.4)", () => {
  const real = stopTimelineModel({ kind: 'OUT_FOR_DEL', etaClock: '11:05 AM', etaIsReal: true });
  assert.equal(real.steps[2].time, 'ETA 11:05 AM');
  // The trap: scheduledFrom exists on nearly every stop; shown as an ETA it is a lie.
  const appt = stopTimelineModel({ kind: 'OUT_FOR_DEL', etaClock: '8:00 AM', etaIsReal: false });
  assert.equal(appt.steps[2].time, null, 'an appt window is not an arrival prediction');
  // And a delivered stop shows its DELIVERED time, never a stale ETA.
  const done = stopTimelineModel({ kind: 'DELIVERED', deliveredAt: '6:04 PM', etaClock: '11:05 AM', etaIsReal: true });
  assert.equal(done.steps[2].time, '6:04 PM');
});

test('EXCEPTION is terminal, not a journey', () => {
  assert.deepEqual(stopTimelineModel({ kind: 'EXCEPTION' }), { variant: 'terminal', label: 'Exception', tone: 'red' });
});

test('everything else falls back to the badge — unknown states are never forced into a delivery story', () => {
  for (const kind of ['UNPLANNED', 'CANCELLED', 'UNABLE_TO_DELIVER', '', null, undefined, 'SOMETHING_NEW']) {
    assert.deepEqual(stopTimelineModel({ kind }), { variant: 'badge' }, String(kind));
  }
});
