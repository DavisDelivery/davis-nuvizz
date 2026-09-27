// test/stop-lookup-latest-answer-wins.test.mjs — A SLOWER, OLDER ANSWER NEVER PAINTS OVER A NEWER ONE.
//
// Audit 2026-09-27 (app-A4-4). A rep taps order A on a customer's day, then quickly taps
// order B (a mis-tap on a phone). If A's answer lands after B was opened, the panel under B
// showed A's PRO, delivery time, POD and line items — permanently, if A answered last. The rep
// reads the wrong delivery time to the customer. The driver-week search already dropped a stale
// answer (drvReqRef); the order panel, the order/customer search, the address search and the
// prompted NuVizz answer did not, so two quick date or range taps could also leave the lit pill
// describing a different window from the rows under it.
//
// Source-text assertions, the pattern stop-lookup-wiring.test.mjs uses for this screen: the
// logic lives in one component's closures and cannot be lifted out alone. Each assertion names
// the guard that has to sit between the await and the state it would otherwise overwrite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
/** The body of one useCallback in StopLookupScreen, from its declaration to its deps array. */
const fnBody = (decl) => {
  const i = APP.indexOf(decl);
  assert.ok(i > 0, `${decl} is where it was`);
  const end = APP.indexOf('\n  }, [', i);
  return APP.slice(i, end);
};
const before = (hay, a, b) => {
  const ia = hay.indexOf(a), ib = hay.indexOf(b);
  assert.ok(ia >= 0, `missing: ${a}`);
  assert.ok(ib >= 0, `missing: ${b}`);
  return ia < ib;
};

test("tapping order B while order A is still loading never shows A's detail under B", () => {
  const open = fnBody('const openOrder = useCallback(async (stopNbr, date) => {');
  assert.ok(before(open, 'const req = ++detailReqRef.current;', 'apiFetch('), 'each open takes a ticket before it asks');
  assert.ok(before(open, 'if (req !== detailReqRef.current) return;', 'setDetailData(j)'), 'an answer for an order no longer open is dropped');
  assert.match(open, /catch \(e\) \{ if \(req === detailReqRef\.current\) setDetailErr/, 'and so is its error');
  assert.match(open, /finally \{ if \(req === detailReqRef\.current\) setDetailLoading\(false\); \}/, "and it cannot clear the newer order's spinner");
});

test('closing an order, or NuVizz opening one, retires any order read still in flight', () => {
  const close = APP.slice(APP.indexOf('const closeOrder = useCallback('), APP.indexOf('const closeOrder = useCallback(') + 300);
  assert.match(close, /detailReqRef\.current \+= 1;/);
  const ask = fnBody('const askNuvizz = useCallback(async () => {');
  assert.ok(before(ask, 'detailReqRef.current += 1;', 'setDetail({ stopNbr: j.detail.stopNbr'), "NuVizz's answer cannot be overwritten by an older order read");
});

test('two quick searches (a date pill, a range pill, the chooser) — the LAST one pressed is the one on screen', () => {
  for (const decl of ['const run = useCallback(async (raw, opts = {}) => {', 'const runPlace = useCallback(async (fields, selNow) => {']) {
    const body = fnBody(decl);
    assert.ok(before(body, 'const req = ++drvReqRef.current;', 'apiFetch('), `${decl}: takes a ticket from the shared search counter`);
    assert.ok(before(body, 'if (req !== drvReqRef.current) return;', 'setData(j)'), `${decl}: an older answer is dropped`);
    assert.match(body, /catch \(e\) \{ if \(req === drvReqRef\.current\) \{ setErr\(String\(e\.message \|\| e\)\); setData\(null\); \} \}/, `${decl}: an older error is dropped`);
    assert.match(body, /finally \{ if \(req === drvReqRef\.current\) \{ setLoading\(false\); setBusy\(null\); \} \}/, `${decl}: and cannot end the newer search's spinner`);
  }
  // The driver week already did this; it must keep sharing the SAME counter, or a customer answer
  // could still land on top of a driver week and the other way round.
  assert.match(fnBody('const runDriver = useCallback(async ({ name, key, sel } = {}) => {'), /const req = \+\+drvReqRef\.current;/);
});

test('a NuVizz answer to a search the rep has already replaced is not painted over the new one', () => {
  const ask = fnBody('const askNuvizz = useCallback(async () => {');
  assert.ok(before(ask, 'const seen = drvReqRef.current;', 'apiFetch('), 'the ask remembers which answer it was asked about');
  assert.ok(before(ask, 'if (seen !== drvReqRef.current) return;', 'setData('), 'and drops its reply if a new search has started');
  assert.match(ask, /catch \(e\) \{ if \(seen === drvReqRef\.current\) setPromptMsg/, 'an error for the old answer is dropped too');
  assert.match(ask, /finally \{ setAsking\(false\); \}/, 'the button is always released');
});
