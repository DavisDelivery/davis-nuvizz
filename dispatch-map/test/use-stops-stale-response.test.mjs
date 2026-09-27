// test/use-stops-stale-response.test.mjs — a stale day can never paint over a new one (Sep 27 audit, B-15).
//
// useStops lives in App.jsx with no pure twin, so this pins the SOURCE shape the way the other
// *-wiring tests do: every refresh takes a ticket, and the answer is checked against the newest
// ticket BEFORE any setState. Without it, a Tuesday pull sitting in fetchJsonWithRetry's 1.5 s
// backoff landed after the Wednesday pull and painted Tuesday's stops under Wednesday's date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const i = APP.indexOf('function useStops(');
assert.ok(i >= 0, 'useStops exists');
const s = APP.slice(i, i + 9000);

test('every refresh takes a ticket, and a superseded answer (or error) never touches the board', () => {
  assert.match(s, /const reqSeq = useRef\(0\);/, 'the ticket counter exists');
  assert.match(s, /const seq = \+\+reqSeq\.current;/, 'each refresh takes a ticket first');
  assert.match(s, /const data = await fetchJsonWithRetry\(url\);\s*\n\s*if \(seq !== reqSeq\.current\) return;/, 'the answer is checked BEFORE any setState');
  assert.match(s, /if \(!silent && seq === reqSeq\.current\) setError\(e\.message\);/, 'a superseded failure paints no banner');
  assert.match(s, /if \(!silent && seq === reqSeq\.current\) setLoading\(false\);/, 'a superseded call cannot clear the newer spinner');
});
