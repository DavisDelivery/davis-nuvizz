// test/board-date-switch-stale-answer.test.mjs — A LATE ANSWER FOR THE DAY YOU LEFT MAY NOT
// REPLACE THE BOARD FOR THE DAY YOU PICKED.
//
// THE DEFECT (review 2026-09-03, A1-S1-1). useStops — the board behind the Map and Routing,
// desktop and phone — called setStops() and every freshness setter whenever a response
// arrived, whatever day it was for. A dispatcher on Tuesday's board picks Wednesday. If
// Tuesday's read (a big board, or a retried one) lands AFTER Wednesday's, Tuesday's stops
// replace Wednesday's under a date picker that still says Wednesday — and the dispatcher plans
// the wrong day's freight. The same happens when a silent 5-minute poll for the old day is in
// flight at the moment of the switch.
//
// The guard is tied to WHAT the answer is for (the date and carry-over window it asked about),
// not merely to which request is newest: a newer silent poll that FAILS must not cause the
// good answer for the current day to be thrown away, which is what a bare request counter
// would do here.
//
// A React state race cannot be run without a browser, so this pins the guard at the source,
// the way the other screen tests in this directory do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}
function refreshSource() {
  const hook = fnSource('useStops');
  const at = hook.indexOf('const refresh = useCallback(');
  assert.ok(at > 0, 'the refresh callback is where it was');
  return { hook, refresh: hook.slice(at, hook.indexOf('}, [date, carryDays]);', at)) };
}

test('a slow board read for the previous date cannot overwrite the newly selected date\'s board', () => {
  const { hook, refresh } = refreshSource();
  // The hook always knows which selection is on screen right now…
  assert.match(hook, /const selectionRef = useRef\(''\);\s*selectionRef\.current = `\$\{date\}\|\$\{carryDays\}`;/);
  // …and every read remembers which selection it was asked for.
  assert.match(refresh, /const asked = `\$\{date\}\|\$\{carryDays\}`;/);
  const wait = refresh.indexOf('await fetchJsonWithRetry(url)');
  assert.ok(wait > 0, 'the board read is awaited inside refresh');
  // Checked twice: before the read starts (an old closure called after the switch) and
  // AFTER the wait, where the race is.
  const early = refresh.indexOf('if (asked !== selectionRef.current) return;');
  assert.ok(early > 0 && early < refresh.indexOf('setLoading(true)'), 'a read already stale when called raises no spinner');
  const guard = refresh.indexOf('if (asked !== selectionRef.current) return;', wait);
  assert.ok(guard > wait, 'an answer for a selection no longer on screen is dropped');
  const firstSet = refresh.indexOf('setStops(');
  assert.ok(firstSet > 0 && guard < firstSet, 'before it can reach the board');
});

test('a stale failure cannot put an error banner over the current board, nor clear its spinner', () => {
  const { refresh } = refreshSource();
  assert.match(refresh, /catch \(e\) \{\s*if \(!silent && asked === selectionRef\.current\) setError\(e\.message\);/);
  assert.match(refresh, /finally \{\s*if \(!silent && asked === selectionRef\.current\) setLoading\(false\);\s*\}/);
});

// ── THE RACE, RUN ─────────────────────────────────────────────────────────────
// The source pins above say the guard is there; these drive the REAL useStops source through
// a minimal hook runtime (state cells by call order, effects not run) and a board fetch whose
// answers are released by hand, so the order of arrival is the test's to choose.
function mountUseStops() {
  const cells = [];
  let at = 0;
  const useState = (init) => {
    const k = at++;
    if (!(k in cells)) cells[k] = { v: typeof init === 'function' ? init() : init };
    const cell = cells[k];
    return [cell.v, (nv) => { cell.v = typeof nv === 'function' ? nv(cell.v) : nv; }];
  };
  const useRef = (init) => { const k = at++; if (!(k in cells)) cells[k] = { current: init }; return cells[k]; };
  const useCallback = (fn) => { at++; return fn; };
  const useEffect = () => { at++; };
  const asks = [];
  const fetchJsonWithRetry = (url) => new Promise((resolve, reject) => { asks.push({ url, resolve, reject }); });
  const useStops = new Function(
    'useState', 'useRef', 'useCallback', 'useEffect', 'MOCK_MODE', 'fetchJsonWithRetry',
    'normalizeMatchKey', 'applyPlanOverlay', 'STOPS_REFRESH_MS', 'document',
    `${fnSource('useStops')}\nreturn useStops;`,
  )(useState, useRef, useCallback, useEffect, false, fetchJsonWithRetry, () => 'k', (s) => s, 120000, undefined);
  const render = (date, carry = 0) => { at = 0; return useStops(date, carry); };
  const answer = (i, stops) => asks[i].resolve({ ok: true, stops, lastScannedAt: null });
  return { render, asks, answer };
}
const tick = () => new Promise((r) => setImmediate(r));

test('RUN: Tuesday\'s read landing after Wednesday\'s leaves Wednesday\'s board on screen', async () => {
  const h = mountUseStops();
  const tue = h.render('2026-09-22').refresh();
  const wed = h.render('2026-09-23').refresh();
  h.answer(1, [{ stopNbr: 'WED-1' }]); await wed;
  h.answer(0, [{ stopNbr: 'TUE-1' }, { stopNbr: 'TUE-2' }]); await tue;
  const board = h.render('2026-09-23');
  assert.deepEqual(board.stops.map((s) => s.stopNbr), ['WED-1'], 'the late Tuesday answer did not paint over Wednesday');
  assert.equal(board.loading, false);
});

test('RUN: an old refresh called AFTER the day changed (a save\'s re-read) does not leave the new day stuck on "Loading stops…"', async () => {
  const h = mountUseStops();
  const staleRefresh = h.render('2026-09-22').refresh; // held by an awaited save callback
  const wed = h.render('2026-09-23').refresh();
  h.answer(0, [{ stopNbr: 'WED-1' }]); await wed;
  assert.equal(h.render('2026-09-23').loading, false, 'Wednesday finished loading');
  const late = staleRefresh(); // the save's POST came back; its closure still says Tuesday
  if (h.asks.length > 1) h.answer(1, [{ stopNbr: 'TUE-1' }]);
  await late; await tick();
  const board = h.render('2026-09-23');
  assert.equal(h.asks.length, 1, 'no read is spent on a day nobody is looking at');
  assert.equal(board.loading, false, 'the spinner is not raised by a read whose answer would be dropped');
  assert.deepEqual(board.stops.map((s) => s.stopNbr), ['WED-1']);
});

test('RUN: a read for the day on screen still lands', async () => {
  const h = mountUseStops();
  const p = h.render('2026-09-23', 7).refresh();
  assert.match(h.asks[0].url, /date=2026-09-23&carryDays=7/);
  h.answer(0, [{ stopNbr: 'WED-1' }]); await p;
  const board = h.render('2026-09-23', 7);
  assert.deepEqual(board.stops.map((s) => s.stopNbr), ['WED-1']);
  assert.equal(board.loading, false);
});
