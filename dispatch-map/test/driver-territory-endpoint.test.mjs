// test/driver-territory-endpoint.test.mjs — THE SHEET ENDPOINT MAY NOT SPEND A NUVIZZ CALL.
//
// The sheet reads months of delivery history. If it could reach the vendor it would be the most
// expensive endpoint in the app, and the cost rule in CLAUDE.md is the hardest rule here.
//
// A comment saying "this never calls NuVizz" is worth nothing — the roster endpoint carried one
// of those while falling through to a live pull on every empty cache. So this walks the actual
// import GRAPH and fails if any nuvizz-* module is reachable, which makes the guarantee
// structural: an import somebody adds later turns this red rather than turning up on the bill.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { windowDates } from '../netlify/functions/driver-territory.mts';

const ROOT = new URL('..', import.meta.url).pathname;
const ENTRY = path.join(ROOT, 'netlify/functions/driver-territory.mts');

function importsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    .filter((sp) => sp.startsWith('.'));
}
function graph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    if (/\.json$/.test(f)) continue;
    for (const spec of importsOf(f)) stack.push(path.resolve(path.dirname(f), spec));
  }
  return [...seen];
}

test('NO nuvizz-* MODULE IS REACHABLE from the sheet endpoint — enforced, not promised', () => {
  const files = graph(ENTRY);
  assert.ok(files.length > 3, `only walked ${files.length} files — the walker is broken, not the graph`);
  const vendor = files.filter((f) => /\/nuvizz-[a-z-]+\.mts$/.test(f)).map((f) => path.basename(f));
  assert.deepEqual(vendor, [], `the sheet can reach the vendor through: ${vendor.join(', ')}`);
});

test('…and the walker really would catch one, so the green above means something', () => {
  // Checked both ways: point the same walker at a module that DOES reach the vendor and it must
  // find it. Without this, a broken walker reports "no vendor imports" for every input.
  const files = graph(path.join(ROOT, 'netlify/functions/lib/refresh-stops-core.mts'));
  const vendor = files.filter((f) => /\/nuvizz-[a-z-]+\.mts$/.test(f));
  assert.ok(vendor.length > 0, 'the walker found no vendor module in the scanner itself — it is broken');
});

// ── the window ──────────────────────────────────────────────────────────────

test('the window is BUSINESS days back from the end date', () => {
  // Weekends carry no deliveries, so listing them is a Firestore round trip per day that can
  // only come back empty — 8 wasted reads on a 4-week sheet.
  const d = windowDates('2026-09-04', 1);          // Fri 2026-09-04
  assert.equal(d.length, 5);
  assert.deepEqual(d, ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  for (const day of d) {
    const wd = new Date(day + 'T00:00:00Z').getUTCDay();
    assert.ok(wd !== 0 && wd !== 6, `${day} is a weekend`);
  }
});

test('four weeks is twenty business days, ending on the day asked for', () => {
  const d = windowDates('2026-09-04', 4);
  assert.equal(d.length, 20);
  assert.equal(d[d.length - 1], '2026-09-04');
  assert.ok(d[0] < d[d.length - 1], 'and it runs forwards');
});

test('the window is clamped — a huge ?weeks= cannot walk years of Firestore', () => {
  assert.equal(windowDates('2026-09-04', 999).length, 12 * 5, 'capped at MAX_WEEKS');
  assert.equal(windowDates('2026-09-04', 0).length, 5, 'and never empty');
  assert.equal(windowDates('2026-09-04', -3).length, 5);
});

test('an end date that lands on a weekend still yields only business days', () => {
  const d = windowDates('2026-09-06', 1);          // Sunday
  assert.equal(d.length, 5);
  assert.equal(d[d.length - 1], '2026-09-04', 'it walks back to the Friday');
});
