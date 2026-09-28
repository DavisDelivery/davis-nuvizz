// test/address-history-stale-answer.test.mjs — A LATE ANSWER TO AN OLDER SEARCH MAY NOT PAINT
// OVER THE ANSWER TO THE CURRENT ONE.
//
// THE DEFECT (audit 2026-09-27, app-A3-5). The Address history screen's `load` called
// setData(j) whenever a response arrived: no request id, and the effect's cleanup only cleared
// the debounce timer. A dispatcher types "007174", pauses to read the rest off the paperwork
// (request A: 60 day documents, and a partial PRO matches nothing), finishes "007174397"
// (request B). If B answers first and A second, A's empty answer overwrites B's real change
// and the screen reads "No address changed for 007174397" — a confident wrong answer to the
// exact question the screen exists for. LabelsScreen already guards this with a request id;
// this screen now does the same. One component serves the desktop table and the phone list,
// so the guard covers both views.
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

test('a slow answer to a half-typed PRO cannot overwrite the answer for the full PRO', () => {
  const screen = fnSource('AddressHistoryScreen');
  const at = screen.indexOf('const load = React.useCallback(');
  assert.ok(at > 0, 'the load callback is where it was');
  const load = screen.slice(at, screen.indexOf('}, [qs]);', at));
  // Every load takes a ticket, and only the newest ticket may paint.
  assert.match(load, /const id = \+\+loadReqRef\.current;/, 'each request is numbered');
  const guard = load.indexOf('if (id !== loadReqRef.current) return;');
  assert.ok(guard > 0, 'a response that is no longer the newest is dropped');
  assert.ok(guard < load.indexOf('setData(j)'), 'before it can reach the screen');
  // Nor may a stale failure or a stale "done" override the current request's state.
  assert.match(load, /catch \(e\) \{ if \(id === loadReqRef\.current\) setErr\(/);
  assert.match(load, /finally \{ if \(id === loadReqRef\.current\) setLoading\(false\); \}/);
  assert.match(screen, /const loadReqRef = React\.useRef\(0\);/);
});
