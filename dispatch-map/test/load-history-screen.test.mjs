// test/load-history-screen.test.mjs — the Send history screen exists in BOTH navigations, has
// TWO views, asks the endpoint the same window its own header prints, and — the pin that
// matters most — DOES NOT TOUCH THE ROUTING WORKBENCH.
//
// CLAUDE.md: "a screen added to one navigation and not the other is a screen that does not
// exist on a phone. It has shipped that way twice." Dispatch runs on a phone, so that is the
// first thing pinned rather than an afterthought.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** App.jsx with the changelog array cut out. VERSION_LOG is release PROSE — it quotes Chad,
 *  names reverted identifiers and describes code that no longer exists — so a guard that reads
 *  it is asserting against a story rather than against the app. */
const CODE = (() => {
  const start = APP.indexOf('const VERSION_LOG = [');
  assert.ok(start > 0, 'VERSION_LOG not found');
  const end = APP.indexOf('\n];', start);
  assert.ok(end > start, 'VERSION_LOG has no closing bracket at column 0');
  return APP.slice(0, start) + APP.slice(end + 3);
})();

/** One top-level component's source. Index-anchored slices silently re-point at different code
 *  when a shared line gains an earlier occurrence — and then pass for the wrong reason. */
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}

test('IT EXISTS ON A PHONE TOO — both navigations carry Send history', () => {
  assert.match(APP, /\{ id: 'sendhistory', label: 'Send history'/, 'the desktop More menu carries it');
  assert.match(APP, /onSelectMenu\('sendhistory'\)/, 'the phone chip menu carries it');
  assert.match(APP, /tab === 'sendhistory' \? <LoadHistoryScreen \/>/, 'the router renders it');
  const known = APP.match(/const KNOWN = \[([^\]]*)\]/);
  assert.ok(known && known[1].includes("'sendhistory'"), 'the tab id survives a reload');
});

test('THE SCREEN HAS TWO VIEWS, not one layout with patches', () => {
  assert.match(APP, /function LoadHistoryTable\(/, 'a desktop table');
  assert.match(APP, /function LoadHistoryListMobile\(/, 'and a separate phone list');
  const src = fnSource('LoadHistoryScreen');
  assert.match(src, /isMobile \? <LoadHistoryListMobile rows=\{rows\} \/> : <LoadHistoryTable rows=\{rows\} \/>/,
    'and it picks between them on the measured viewport');
  assert.match(src, /viewportWidth < MOBILE_BREAKPOINT/);
});

test('THE ROUTING WORKBENCH IS NOT TOUCHED. The freeze (CLAUDE.md, v1.36.1) names markSaved, '
  + 'the card chips, paint and selection — and this screen was built alongside a request that '
  + 'could easily have been read as licence to change them', () => {
  const src = fnSource('LoadHistoryScreen');
  for (const frozen of ['markSaved', 'wbRoutes', 'effectiveRouteInfo', 'cardSendState', 'savedAtByKey', 'setSelectedIds', 'planStaged']) {
    assert.doesNotMatch(src, new RegExp(frozen), `the screen must not reach into ${frozen}`);
  }
  // And nothing in this release re-introduced the reverted chip under another name. Measured
  // over the CODE only: VERSION_LOG is prose and this release's own row names what was
  // reverted, which would otherwise make this assertion fail on the sentence describing it.
  assert.doesNotMatch(CODE, /savedAtByKey|cardSendState/, 'the v1.33.0 chip stays reverted');
});

test('THE HEADER AND THE ROWS DESCRIBE THE SAME WINDOW — resolved by the one module the '
  + 'endpoint resolves with, reaching FORWARD because an 11pm Save files against tomorrow', () => {
  const src = fnSource('LoadHistoryScreen');
  assert.match(src, /resolveRange\(sel, today, QUEUE_DAYS_AHEAD\)/);
  assert.match(src, /p\.set\('from', range\.from \|\| today\); p\.set\('to', range\.to \|\| today\);/);
});

test('a typed search WIDENS the read rather than filtering what is already on screen — a load '
  + 'sent three weeks ago must still be findable', () => {
  const src = fnSource('LoadHistoryScreen');
  assert.match(src, /if \(searching\) \{ p\.set\(findKind, findQ\.trim\(\)\); p\.set\('days', String\(MAX_RANGE_DAYS\)\); \}/);
});

test('IT NEVER SPENDS A VENDOR CALL, and says so where a dispatcher can read it', () => {
  const src = fnSource('LoadHistoryScreen');
  assert.match(src, /load-history\?/, 'it reads the Firestore-only endpoint');
  assert.doesNotMatch(src, /nuvizz-manual-scan|live=1|nuvizz-write/, 'and nothing that could reach NuVizz');
  assert.match(src, /Zero NuVizz calls/);
});

test('AN UNREAD AFTER-STATE IS NEVER RENDERED AS "no change". That substitution IS the v1.29.0 '
  + 'banner failure — a screen telling a dispatcher the opposite of what the server observed', () => {
  const src = fnSource('SendChange');
  assert.match(src, /row\.after == null/, 'the null case is handled explicitly');
  assert.match(src, /not read back, so what it holds now is unknown/);
  // The reassuring wording must be reachable ONLY when both sides were actually captured.
  const noChange = src.indexOf('No change to the load');
  const guard = src.indexOf('row.before == null');
  assert.ok(noChange > guard && guard > 0, '"no change" sits after both absence guards, not before them');
});

test('the three verdicts are all spelled out, PART LANDED included — the SCOTT/SHP29379 shape '
  + 'is the one a dispatcher must never read as a clean refusal', () => {
  assert.match(APP, /confirmed: \{ label: 'Confirmed'/);
  assert.match(APP, /partial: \{ label: 'Part landed'/);
  assert.match(APP, /refused: \{ label: 'Refused'/);
  assert.match(APP, /double-plan/, 'and the partial badge says what it costs to get wrong');
});

test('the verdict pills carry the WHOLE window\'s counts — a breakdown that zeroes itself the '
  + 'moment somebody presses one is a breakdown that vanishes when it starts being used', () => {
  const src = fnSource('LoadHistoryScreen');
  assert.match(src, /\{ id: 'confirmed', label: 'Confirmed', n: sum\.confirmed \}/);
  assert.match(src, /\{ id: 'refused', label: 'Refused', n: sum\.refused \}/);
  // sum comes from data.summary, which the endpoint builds WITHOUT the verdict filter.
  assert.match(src, /const sum = data\?\.summary/);
});
