// test/stop-card-twin-switch-timeline.test.mjs
//
// THE DEFECT (review 2026-09-03, X-react-3). The stop card's Activity timeline loads once and
// keeps what it loaded. The card is re-keyed by STOP NUMBER, so opening a different number
// starts clean — but NuVizz can hold two different orders under one number (the Estes twin),
// and a recurring PRO comes back as a new order with the same number. Switching the open card
// from one of those to the other kept the first order's events on screen under the second
// order's name. Worse, the card's "live" overlay (useLiveStop) was keyed the same way, so the
// FIRST order's refreshed fields — its stopId included — stayed painted over the second one,
// which is also why the timeline never noticed the switch.
//
// The fix is one rule for "is this a different record?", shared by both: a different number,
// or two id-shaped stopIds that disagree. A card that had no id and LEARNS one from its own
// refresh is the same record (that is how opening the timeline adopts the stopId) — resetting
// there would fold the timeline shut the moment it opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stopRecordIdentity, trackStopRecord } from '../src/lib/stop-card-sections.js';

const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbb2';

test('switching the open card to the other order sharing this number is a different record', () => {
  const a = stopRecordIdentity({ stopNbr: '0828068215', stopId: ID_A });
  const b = stopRecordIdentity({ stopNbr: '0828068215', stopId: ID_B });
  const t = trackStopRecord(a, b);
  assert.equal(t.changed, true, 'the second Estes order must not inherit the first one\'s timeline');
  assert.deepEqual(t.record, b);
});

test('opening a different stop number is a different record', () => {
  const t = trackStopRecord(stopRecordIdentity({ stopNbr: '1', stopId: ID_A }), stopRecordIdentity({ pro: '2', stopId: ID_A }));
  assert.equal(t.changed, true);
});

test('a card that learns its stopId from its own refresh is the SAME record, so the open timeline stays open', () => {
  const before = stopRecordIdentity({ stopNbr: '0828068215', stopId: null });
  const after = stopRecordIdentity({ stopNbr: '0828068215', stopId: ID_A });
  const t = trackStopRecord(before, after);
  assert.equal(t.changed, false, 'adopting the id is not a switch');
  assert.deepEqual(t.record, after, 'but the id is remembered, so a later twin switch is caught');
  assert.equal(trackStopRecord(t.record, stopRecordIdentity({ stopNbr: '0828068215', stopId: ID_B })).changed, true);
});

test('when either side has no id-shaped stopId the card cannot tell twins apart, and keeps the old behaviour', () => {
  const withId = stopRecordIdentity({ stopNbr: '7', stopId: ID_A });
  const t = trackStopRecord(withId, stopRecordIdentity({ stopNbr: '7', stopId: '' }));
  assert.equal(t.changed, false);
  assert.equal(t.record, withId, 'the known id is kept, not forgotten');
  assert.equal(trackStopRecord(stopRecordIdentity({ stopNbr: '7', stopId: 'x' }), stopRecordIdentity({ stopNbr: '7', stopId: 'y' })).changed, false,
    'a non-id placeholder is not evidence of a different order');
  const blank = stopRecordIdentity({});
  const same = trackStopRecord(blank, stopRecordIdentity(null));
  assert.equal(same.changed, false);
  assert.equal(same.record, blank, 'nothing learned, nothing to store — no re-render loop');
});

// A React state reset cannot be run without a DOM renderer (none is installed), so the two
// holders are pinned at the source, the way the other stop-card tests in this directory do.
const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}

test('the card\'s live overlay drops the previous order\'s refresh when the record changes', () => {
  const hook = fnSource('useLiveStop');
  assert.match(hook, /trackStopRecord\(/, 'the overlay is keyed by record, not by number alone');
  assert.match(hook, /if \(rec\.changed\) setFresh\(null\);/, 'a different record starts from the board copy');
  assert.doesNotMatch(hook, /const stopKey = stop\?\.stopNbr \|\| stop\?\.pro;/, 'the number-only key is gone');
});

test('the Activity timeline folds shut and forgets its events when the record changes', () => {
  const tl = fnSource('StopActivityTimeline');
  assert.match(tl, /trackStopRecord\(/);
  const at = tl.indexOf('if (rec.changed)');
  assert.ok(at > 0, 'a record change is acted on');
  const reset = tl.slice(at, tl.indexOf('\n', at));
  assert.match(reset, /setOpen\(false\)/, 'collapsed, so re-opening asks NuVizz about THIS order');
  assert.match(reset, /setSt\(\{ loading: false, events: null, error: null \}\)/, 'the previous order\'s events are dropped');
});
