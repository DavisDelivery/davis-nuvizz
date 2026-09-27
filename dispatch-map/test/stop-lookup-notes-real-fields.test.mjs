// test/stop-lookup-notes-real-fields.test.mjs — THE STOP LOOKUP CARD READS THE FIELDS THE
// EDITOR ACTUALLY WRITES.
//
// Audit 2026-09-27 (client-lookup-account-libs-2): notesSummary read `notes` / `note` for the
// dock instruction, `no_tractor` for the box-truck mark and `pin_override` / `lat_override`
// for the hand-moved pin. Nothing in the repo writes any of those — they existed only in test
// fixtures, which is why every test passed. The shared editor (App.jsx StopNotesEditor over
// emptyNote) writes `dock_notes`, `vehicle_eligibility: 'box_only'` and
// `equipment_restrictions`, and every pin writer writes `location_override`. So a customer
// whose note was "Use the BACK dock" plus Box truck only showed no instruction and no chip.
//
// The fixture here is the REAL shape: emptyNote is lifted out of App.jsx itself, so if the
// editor's document ever changes shape this test is reading the new one, not a copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { liftFromApp } from './helpers/app-lift.mjs';
import { notesSummary } from '../src/lib/stop-lookup.js';

const { emptyNote } = liftFromApp({ targets: ['emptyNote'], exercise: (l) => l.emptyNote({}) });

/** A customer_notes document exactly as the Map's / Stop lookup's editor saves it. */
const saved = (over = {}) => ({
  ...emptyNote({ businessName: 'EARTHLY ALTERNATIVE', addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336', matchKey: 'k' }),
  ...over,
});

test('a dock instruction typed in the editor is the note text on the Stop lookup card', () => {
  const n = notesSummary(saved({ dock_notes: 'Use the BACK dock - front office refuses freight' }));
  assert.match(n.text, /Use the BACK dock - front office refuses freight/);
});

test('a location the dispatcher marked Box truck only carries the no-tractor chip', () => {
  const n = notesSummary(saved({ vehicle_eligibility: 'box_only' }));
  assert.ok(n.flags.some((f) => f.key === 'no_tractor'), JSON.stringify(n.flags));
});

test('a ticked "No tractor trailer" restriction is shown to the rep in the dropdown’s own words', () => {
  const n = notesSummary(saved({ equipment_restrictions: ['no_tractor_trailer'] }));
  assert.ok(n.flags.some((f) => /No tractor trailer/.test(f.label)), JSON.stringify(n.flags));
});

test('a hand-set "Tractor-trailer OK" overrules a restriction, the same as the map draws it', () => {
  // drawnRestrictionKeys (map-legend.js) and dispatcherTrailerBlock (trailer-block.js) both drop
  // every trailer blocker behind vehicle_eligibility 'tractor'. The card must not say the
  // opposite of the map about the same dock.
  const n = notesSummary(saved({ vehicle_eligibility: 'tractor', equipment_restrictions: ['no_tractor_trailer'] }));
  assert.equal(n.flags.some((f) => f.key === 'no_tractor' || /tractor trailer/i.test(f.label)), false, JSON.stringify(n.flags));
});

test('box-only plus the matching restriction is one statement, not two chips saying it twice', () => {
  const n = notesSummary(saved({ vehicle_eligibility: 'box_only', equipment_restrictions: ['no_tractor_trailer', '26ft_max'] }));
  const labels = n.flags.map((f) => f.label);
  assert.equal(labels.filter((l) => /tractor/i.test(l)).length, 1, labels.join(' | '));
  assert.ok(labels.includes('26ft max'), 'a restriction that says MORE than box-only still shows');
});

test('a pin a dispatcher dragged to the right door (location_override) shows as moved by hand', () => {
  const n = notesSummary(saved({ location_override: { lat: 33.71, lng: -84.51 } }));
  assert.ok(n.flags.some((f) => f.key === 'pin'), JSON.stringify(n.flags));
});

test('a cleared pin (location_override null) is not "moved by hand"', () => {
  const n = notesSummary(saved({ location_override: null }));
  assert.equal(n.flags.some((f) => f.key === 'pin'), false);
});

test('an untouched editor document carries no invented flags or text', () => {
  const n = notesSummary(saved());
  assert.equal(n.text, null);
  assert.deepEqual(n.flags, []);
});
