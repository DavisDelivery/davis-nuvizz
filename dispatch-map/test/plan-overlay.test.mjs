// test/plan-overlay.test.mjs — the confirmed-save plan overlay's per-entry decision.
// Imports the SAME function App.jsx ships (no copy), so these prove the real behaviour.
//
// Regression origin: KAI WONG (ESTES-1848671372) showed on Trevor Brent's SUW 5 in the Compare
// panel while NuVizz held the stop UNPLANNED, and re-scanning would not shift it — a planned
// overlay entry only "agrees" with a row planned on the same load, so an unplanned row read as
// scan lag and got repainted for the full 12-hour TTL.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planOverlayAction, PLAN_OVERLAY_TTL_MS, PLAN_OVERLAY_SCAN_MARGIN_MS,
} from '../src/lib/plan-overlay.js';

const NOW = Date.parse('2026-07-29T16:00:00Z');
const agoMs = (min) => NOW - min * 60_000;
const agoIso = (min) => new Date(NOW - min * 60_000).toISOString();

const savedPlanned = (min, load = 'SUW 5') => ({ at: agoMs(min), isPlanned: true, loadNbr: load, routeSeq: 4 });
const savedUnplanned = (min) => ({ at: agoMs(min), isPlanned: false });

const rowPlannedOn = (load) => ({ stopNbr: '007148671372', isPlanned: true, isUnplanned: false, loadNbr: load, routeName: load });
const rowUnplanned = () => ({ stopNbr: '007148671372', isPlanned: false, isUnplanned: true, loadNbr: null, routeName: null });

test('paints a confirmed plan over a board that has not caught up yet', () => {
  // Save 2 min ago; the only scan we have ran 30 min ago — it never saw the save.
  const action = planOverlayAction(savedPlanned(2), rowUnplanned(), { now: NOW, scannedAt: agoIso(30) });
  assert.equal(action, 'paint');
});

test('releases the moment the board agrees', () => {
  assert.equal(planOverlayAction(savedPlanned(2), rowPlannedOn('SUW 5'), { now: NOW, scannedAt: agoIso(30) }), 'agree');
  assert.equal(planOverlayAction(savedUnplanned(2), rowUnplanned(), { now: NOW, scannedAt: agoIso(30) }), 'agree');
});

test('a planned entry does NOT agree with the wrong load — a cross-load move keeps painting', () => {
  // Planned onto SUW 5, board still shows the source load: paint, don't release.
  assert.equal(planOverlayAction(savedPlanned(2), rowPlannedOn('SUW 2'), { now: NOW, scannedAt: agoIso(30) }), 'paint');
});

test('KAI WONG: a scan that ran AFTER the save releases a plan undone in the portal', () => {
  // Planned an hour ago, unplanned in NuVizz since, then a fresh scan 1 min ago.
  const entry = savedPlanned(60);
  const row = rowUnplanned();
  // Before the fix this returned 'paint' — repainting SUW 5 for the rest of the 12h TTL.
  assert.equal(planOverlayAction(entry, row, { now: NOW, scannedAt: agoIso(1) }), 'overtaken');
  // …and no number of further scans changed it, which is what "I just did a fresh scan" meant.
  assert.equal(planOverlayAction(entry, row, { now: NOW, scannedAt: agoIso(0) }), 'overtaken');
});

test('a scan that merely OVERLAPPED the save is lag, not a verdict — still paints', () => {
  // Scan stamped 1 min after the save: inside the margin, so it may have READ NuVizz pre-save.
  const scannedAt = new Date(agoMs(10) + 60_000).toISOString();
  assert.equal(planOverlayAction(savedPlanned(10), rowUnplanned(), { now: NOW, scannedAt }), 'paint');
  // One tick past the margin it becomes a verdict.
  const past = new Date(agoMs(10) + PLAN_OVERLAY_SCAN_MARGIN_MS + 1_000).toISOString();
  assert.equal(planOverlayAction(savedPlanned(10), rowUnplanned(), { now: NOW, scannedAt: past }), 'overtaken');
});

test('no scan timestamp → agreement-or-TTL only (unchanged legacy behaviour)', () => {
  assert.equal(planOverlayAction(savedPlanned(2), rowUnplanned(), { now: NOW, scannedAt: null }), 'paint');
  assert.equal(planOverlayAction(savedPlanned(2), rowUnplanned(), { now: NOW }), 'paint');
  // A malformed timestamp must not be read as "epoch, therefore ancient" and release anything.
  assert.equal(planOverlayAction(savedPlanned(2), rowUnplanned(), { now: NOW, scannedAt: 'not-a-date' }), 'paint');
});

test('WIEDMANN overnight: scanner paused, so nothing overtakes the save inside the TTL', () => {
  // Confirmed carry-over save at 22:00; the server patch missed it; the scanner is paused until
  // 10 AM, so the newest scan still predates the save. The plan must stay painted all night.
  const entry = savedPlanned(9 * 60);                     // saved 9h ago
  const scannedAt = agoIso(9 * 60 + 45);                  // last scan was 45 min BEFORE that
  assert.equal(planOverlayAction(entry, rowUnplanned(), { now: NOW, scannedAt }), 'paint');
});

test('TTL is the runaway cap — past it the entry is gone regardless of scans', () => {
  const stale = { at: NOW - PLAN_OVERLAY_TTL_MS - 1, isPlanned: true, loadNbr: 'SUW 5' };
  assert.equal(planOverlayAction(stale, rowUnplanned(), { now: NOW, scannedAt: agoIso(9 * 60 + 45) }), 'expired');
  // Just inside the cap it still paints.
  const fresh = { at: NOW - PLAN_OVERLAY_TTL_MS + 60_000, isPlanned: true, loadNbr: 'SUW 5' };
  assert.equal(planOverlayAction(fresh, rowUnplanned(), { now: NOW, scannedAt: agoIso(13 * 60) }), 'paint');
});

test('a junk entry is expired rather than trusted', () => {
  assert.equal(planOverlayAction(null, rowUnplanned(), { now: NOW }), 'expired');
  assert.equal(planOverlayAction({ isPlanned: true, loadNbr: 'SUW 5' }, rowUnplanned(), { now: NOW }), 'expired');
  assert.equal(planOverlayAction({ at: 'nope', isPlanned: true }, rowUnplanned(), { now: NOW }), 'expired');
});
