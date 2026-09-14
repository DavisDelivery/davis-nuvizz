// test/address-history-screen.test.mjs — the screen exists in BOTH navigations, has TWO
// views, and every override call site actually logs.
//
// CLAUDE.md: "a screen added to one navigation and not the other is a screen that does not
// exist on a phone. It has shipped that way twice." Dispatch runs on a phone, so this is the
// first thing pinned rather than an afterthought.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** One top-level component's source. Index-anchored slices silently re-point at different code
 *  when a shared line (like `shownAddress(stop, note)`) gains an earlier occurrence — and then
 *  pass for the wrong reason. */
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}
const LOG = fs.readFileSync(new URL('../src/lib/address-log.js', import.meta.url), 'utf8');

test('IT EXISTS ON A PHONE TOO — both navigations carry Address history', () => {
  // The desktop overflow menu…
  assert.match(APP, /\{ id: 'addrhistory', label: 'Address history'/, 'the desktop More menu carries it');
  // …and the separate phone chip menu, which is a second list built separately.
  assert.match(APP, /onSelectMenu\('addrhistory'\)/, 'the phone chip menu carries it');
  // …and the router renders it.
  assert.match(APP, /tab === 'addrhistory' \? <AddressHistoryScreen \/>/, 'the router renders it');
  // …and a restored tab id survives a reload.
  const known = APP.match(/const KNOWN = \[([^\]]*)\]/);
  assert.ok(known && known[1].includes("'addrhistory'"), 'the tab id is known to the restore list');
});

test('THE SCREEN HAS TWO VIEWS, not one layout with patches', () => {
  assert.match(APP, /function AddressHistoryTable\(/, 'a desktop table');
  assert.match(APP, /function AddressHistoryListMobile\(/, 'and a separate phone list');
  // And it picks between them on the measured viewport, like every other screen here.
  assert.match(APP, /isMobile\s*\n?\s*\? <AddressHistoryListMobile rows=\{rows\} \/> : <AddressHistoryTable rows=\{rows\} \/>/);
});

test('EVERY SECTION HAS TWO VIEWS — a chooser that is one responsive control is the easy way out', () => {
  // Chad, repeatedly: mobile and desktop are TWO VIEWS, not one layout with patches. Three
  // sections now live on this screen, and each needs its own pair — including the chooser
  // itself, which is a scrollable chip row under a thumb and a segmented bar on a board.
  for (const [mobile, desktop] of [
    ['AddrSectionChipsMobile', 'AddrSectionBarDesktop'],
    ['ProblemQueueMobile', 'ProblemQueueDesktop'],
    ['AddressHistoryListMobile', 'AddressHistoryTable'],
  ]) {
    assert.match(APP, new RegExp(`function ${mobile}\\(`), `${mobile} must exist`);
    assert.match(APP, new RegExp(`function ${desktop}\\(`), `${desktop} must exist`);
  }
  // …and none of them may take isMobile as a prop and branch inside — that is one component
  // wearing two hats, which is the shape the rule forbids.
  for (const name of ['ProblemQueueMobile', 'ProblemQueueDesktop', 'AddrSectionChipsMobile', 'AddrSectionBarDesktop']) {
    const fn = fnSource(name);
    assert.ok(!/\bisMobile\b/.test(fn), `${name} must not branch on isMobile — it IS the branch`);
  }
});

test('the wide table is the only thing allowed to scroll sideways', () => {
  // A page that scrolls sideways on a phone fails verify-mobile-layout; a table inside its
  // own overflow container is the documented exception.
  assert.match(APP, /function AddressHistoryTable\([\s\S]{0,400}?overflow-x-auto/);
});

test('EVERY ADDRESS WRITE IS LOGGED — derived from the source, not counted', () => {
  // THIS USED TO BE TWO HARD-CODED COUNTS (3 saves, 5 logs) and it broke the moment the
  // problem-address queue added a fourth save site — which is the failure mode of a count:
  // it has to be bumped on every change, so eventually it gets bumped without being read.
  // The RULE is what matters: a site that writes an address override without logging it is a
  // silent hole in an audit trail, and that is worse than no audit trail because it reads as
  // proof nothing happened.
  //
  // Split the file on top-level function boundaries and check each unit that writes an
  // override also records one.
  const units = APP.split(/\n(?=(?:async )?function [A-Za-z])/);
  const writers = units.filter((u) => /setDoc\(\s*doc\(db, 'customer_notes'/.test(u) && /address_override:/.test(u));
  assert.ok(writers.length >= 4, `expected every address-override writer to be found, got ${writers.length}`);
  for (const u of writers) {
    const name = (u.match(/^(?:async )?function ([A-Za-z0-9_]+)/) || [])[1] || u.slice(0, 60);
    assert.match(u, /logAddressOverride\(/, `${name} writes an address override without logging it`);
  }
  assert.match(APP, /source: 'override-reset'/, 'clearing an override is recorded too');
});

test('the modal logs exactly ONCE per Save, whichever branch it takes', () => {
  // The modal's Save has two arms since it learned to push to NuVizz: board-only logs and
  // closes, pushed waits for the vendor read-back and logs the OUTCOME. Without the `return`
  // between them a board-only save would log twice and the history would show one correction
  // as two.
  const modal = fnSource('AddressEditModal');
  const guard = modal.indexOf('if (!(canPush && toNuvizz))');
  const boardOnlyLog = modal.indexOf("source: 'override' }", guard);
  const ret = modal.indexOf('return;', boardOnlyLog);
  const pushedLog = modal.indexOf('nuvizz: landed', guard);
  assert.ok(guard > 0 && boardOnlyLog > guard, 'the board-only branch logs');
  assert.ok(ret > boardOnlyLog && ret < pushedLog, 'and returns before the pushed branch can log too');
});

test('the BEFORE is captured before the write, never after', () => {
  // After the setDoc lands, the old address is gone from every surface — reading it then
  // would log a change from the value we had just written, i.e. no change at all.
  const save = APP.slice(APP.indexOf('const wasShowing = shownAddress(stop, note);'));
  assert.ok(save.indexOf('const wasShowing') < save.indexOf('setDoc'), 'captured ahead of the write');
});

test('a logging failure can never fail the save', () => {
  assert.match(LOG, /catch \{[\s\S]{0,200}?return false;/, 'the POST swallows its own errors');
  // And the call sites must not await it into the happy path.
  assert.doesNotMatch(APP, /await logAddressOverride/, 'never awaited into a save');
});

test('the shown address is what the CARD shows — override first, then NuVizz', () => {
  // Same precedence the stop card renders with. Reading the raw stop instead would log a
  // change from an address nobody was looking at.
  assert.match(LOG, /const ov = note\?\.address_override \|\| \{\};/);
  assert.match(LOG, /addr1: clean\(ov\.addr1 \|\| stop\?\.addr1\)/);
});

test('THE COST CLAIM IS TWO-SIDED — the log costs nothing, the queue says what a push costs', () => {
  // The lazy fix when the queue arrived was to delete or loosen this assertion. Both directions
  // ship a lie: leaving "never spends a vendor call" on a screen whose push button spends 3 per
  // order, or deleting the claim from the log, which is the one place it is true and the reason
  // a dispatcher opens it freely.
  const screen = fnSource('AddressHistoryScreen');
  assert.match(screen, /Zero NuVizz calls — this screen never spends a vendor call/, 'the log still promises it');
  assert.match(screen, /\{logSection && \(<>/, 'and the promise is inside the log branch, not on the page');
  // The queue states its price on the button itself, before anyone presses it.
  assert.match(APP, /Save & correct NuVizz \(3 calls\)/, 'the per-row button prices itself');
  assert.match(APP, /NuVizz call\$\{calls === 1 \? '' : 's'\}/, 'and the group button prices the selection');
  const footer = fnSource('QueueFooterNote');
  assert.ok(!/never spends a vendor call/.test(footer), 'the queue must not carry the log\'s claim');
});

test('the queue shows the budget it is spending against, not a hardcoded ceiling', () => {
  // The enforced number is a stored Diagnostics setting, not the 2,000 constant. A button
  // quoting the constant would be confidently wrong the moment somebody lowers it.
  const runner = fnSource('useQueuePush');
  assert.match(runner, /dryRun: true/, 'read free, before the write-enable gate');
  assert.match(runner, /ceiling: Number\(j\.ops\.ceiling\)/);
  assert.ok(!/2000|2_000/.test(runner), 'never the constant');
});

test('formatting rows are hidden by default, and a PRO search shows every one of them', () => {
  // Hiding them is right on a 700-stop window and wrong the moment somebody asks about ONE
  // order: "did we change 007174397" coming back "no address changed" because the only row
  // was a suite moving between lines is the confident-and-wrong answer this replaces.
  assert.match(APP, /Show formatting-only changes/);
  assert.match(APP, /if \(showNoise \|\| searching\) p\.set\('all', '1'\);/);
});

test('the empty state never claims rows are hidden when none are', () => {
  // The inverted version of this said "formatting differences are hidden" on a screen with
  // the toggle already ON and nothing to show — turning "nothing happened" into "something is
  // being kept from me", which is the one thing a log must never do.
  assert.match(APP, /const formattingHidden = !showNoise && !searching && Number\(sum\.formatting \|\| 0\) > 0;/);
  assert.match(APP, /Nothing was recorded at all/);
});

test('a PRO search is not limited to the chosen window', () => {
  // "Did we change 007174397" must not return nothing merely because the date picker is on
  // the last 14 days and the change was in July.
  assert.match(APP, /if \(searching\) \{ p\.set\('stop', stopQ\.trim\(\)\); p\.set\('days', String\(MAX_RANGE_DAYS\)\); \}/);
});
