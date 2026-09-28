// test/status-card-halted-scanner-desktop.test.mjs
//
// THE DEFECT (review 2026-09-03, A1-S5-1; the scan-error half was fixed in v1.10.0). When the
// scanner halts — the daily NuVizz call ceiling tripped, or the kill switch is on — the phone
// Map prints "Daily scan limit reached — updates resume after midnight UTC" / "Scanning paused
// (kill switch) — board may be stale" right under the Scan button. The DESKTOP Map's status
// pill never did: its only trace was a ", halted" suffix on the call-meter line, inside the
// details a collapsed pill hides. So a desktop dispatcher could plan the whole morning off a
// board that stopped updating at 6 AM with nothing on screen saying so. The pill now carries
// the same banner, outside the collapse, exactly as the phone does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { boardStatusPanel, scanHaltedMessage } from '../src/lib/board-status-card.js';

test('a halted scanner is announced on the desktop pill even while it is collapsed', () => {
  const halted = scanHaltedMessage({ halted: true, reason: 'ceiling', since: '2026-09-22T10:00:00Z' });
  const p = boardStatusPanel({ collapsed: true, scanErr: null, halted });
  assert.equal(p.showDetails, false);
  assert.equal(p.showHalted, true, 'the stale-board warning does not hide behind the collapse');
  assert.equal(p.open, true, 'bar mode opens its one panel for it too');
});

test('the banner says the same words the phone Map says, per reason', () => {
  assert.equal(scanHaltedMessage({ halted: true, reason: 'ceiling' }), 'Daily scan limit reached — updates resume after midnight UTC');
  assert.equal(scanHaltedMessage({ halted: true, reason: 'killswitch' }), 'Scanning paused (kill switch) — board may be stale');
});

test('a running scanner, or no scan state at all, says nothing', () => {
  assert.equal(scanHaltedMessage({ halted: false, reason: 'ceiling' }), null);
  assert.equal(scanHaltedMessage(null), null);
  assert.equal(scanHaltedMessage(undefined), null);
  const p = boardStatusPanel({ collapsed: true, scanErr: null, halted: null });
  assert.equal(p.showHalted, false);
  assert.equal(p.open, false, 'no empty dropdown');
});

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}

test('the status card renders the halted banner in both placements, outside the collapse', () => {
  const card = fnSource('StopsStatusCard');
  assert.match(card, /function StopsStatusCard\(\{[^}]*\bscanState = null\b/, 'the card takes the scan state');
  assert.match(card, /const halted = scanHaltedMessage\(scanState\);/);
  assert.match(card, /boardStatusPanel\(\{ collapsed, scanErr, halted \}\)/);
  const shows = card.match(/\{panel\.showHalted && /g) || [];
  assert.equal(shows.length, 2, 'bar mode AND the map pill');
});

test('the desktop Map hands its scan state to the pill', () => {
  const map = fnSource('MapScreen');
  const at = map.indexOf('<StopsStatusCard');
  assert.ok(at > 0);
  const props = map.slice(at, map.indexOf('/>', map.indexOf('flagsChip=', at)));
  assert.match(props, /scanState=\{scanState\}/);
});
