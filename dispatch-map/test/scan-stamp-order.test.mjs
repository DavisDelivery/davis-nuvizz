// test/scan-stamp-order.test.mjs
//
// A SCAN STAMP IS A CLAIM ABOUT WHAT THE VENDOR ANSWERED.
//
// markScanKinds writes the per-kind clock that dueKinds schedules from. The list-discovery
// path stamped `planned` and `completed` at the TOP of the block, before a single NuVizz
// call — so a 5xx, a throttle or a rejected auth recorded a scan that never happened, and
// the next attempt was then held off for a full interval while the board sat stale. The
// outer catch preserves the last-good board and the run reports itself as handled, so the
// only symptom is a board that quietly stops moving.
//
// This is an ORDERING guard, not a behaviour test, because the bug is ordering inside one
// long handler: what matters is that no stamp is issued upstream of the pull that justifies
// it. It reads the shipped source, which is the thing that can regress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dueKinds, defaultScanRules } from '../netlify/functions/lib/scan-plan.mts';

const SRC = readFileSync(new URL('../netlify/functions/lib/refresh-stops-core.mts', import.meta.url), 'utf8');

test('the list-discovery scan is not stamped before the pull that justifies it', () => {
  const block = SRC.slice(SRC.indexOf('if (LIST_DISCOVERY) {'));
  assert.ok(block.length > 1000, 'found the list-discovery block');

  // The helper's own BODY is a definition, not a call — cut it out before looking at
  // call sites, or the guard fires on the very code that fixes the bug.
  const defAt = block.indexOf('const stampScanKinds = async () => {');
  assert.ok(defAt > 0, 'found the stamp helper');
  const defEnd = block.indexOf('};', defAt) + 2;
  const scanned = block.slice(0, defAt) + ' '.repeat(defEnd - defAt) + block.slice(defEnd);

  const pull = Math.min(
    ...['await twoScanBuckets(', 'await listScanForDate(']
      .map((needle) => scanned.indexOf(needle))
      .filter((i) => i >= 0),
  );
  assert.ok(Number.isFinite(pull) && pull > 0, 'found the vendor pull');

  // Every stamp of this run's clocks must sit downstream of the pull.
  for (const m of scanned.matchAll(/await (?:markScanKinds|stampScanKinds)\(/g)) {
    assert.ok(m.index > pull,
      `a scan clock is stamped at offset ${m.index}, ahead of the pull at ${pull} — that records a scan NuVizz may never have answered`);
  }
});

test('the ops stamp cannot claim a COMPLETED pull the run did not make', () => {
  // With NUVIZZ_TWO_SCAN off there is no completed saved-search pull in this path at all.
  // The day-index write 450 lines below already refuses to claim one (includeCompleted:
  // TWO_SCAN); the ops doc claimed it unconditionally, so the two stamps disagreed about
  // the same run and the completed clock never came due.
  assert.match(SRC, /stampedKinds = TWO_SCAN \? \['planned', 'completed'\] : \['planned'\]/);
  assert.match(SRC, /await markScanKinds\(stampedKinds, scannedAt\)/);
});

test('AND IT CANNOT CLAIM A SCAN THE BOARD NEVER RECEIVED', () => {
  // The second half of the same rule, and the one Chad's Tuesday was made of. Moving the
  // stamp behind the pull stopped a 5xx from claiming a scan; it did nothing for a run that
  // answers the pull and then dies before the ~700-stop board write. Those two look identical
  // to dueKinds, so the per-kind clocks read healthy while the DAY INDEX — the thing the
  // board serves and the thing the status card's three feed rows read — never moves. Three
  // rows frozen at "3 hr ago" and a schedule reporting itself fine.
  //
  // The guard: the helper must refuse to stamp until `results` holds a successful list
  // outcome, and every call site must sit downstream of a results.push.
  const defAt = SRC.indexOf('const stampScanKinds = async () => {');
  assert.ok(defAt > 0, 'found the stamp helper');
  const body = SRC.slice(defAt, SRC.indexOf('};', defAt));
  assert.match(body, /results\.some\(/,
    'the stamp helper must consult what actually landed before claiming a scan');

  const firstPush = SRC.indexOf("results.push({ date, ok: true");
  assert.ok(firstPush > 0, 'found the first successful-write record');
  for (const m of SRC.slice(SRC.indexOf('if (LIST_DISCOVERY) {')).matchAll(/await stampScanKinds\(\)/g)) {
    const abs = m.index + SRC.indexOf('if (LIST_DISCOVERY) {');
    assert.ok(abs > firstPush,
      `stampScanKinds() is called at ${abs}, ahead of any recorded outcome at ${firstPush}`);
  }
});

test('WHY IT MATTERS: a stamp with no scan behind it holds the next attempt off', () => {
  // The consequence, as a number. A phantom stamp one minute ago against the default
  // planned interval reads "not due" — the board waits out the whole interval on a scan
  // that never happened.
  const rules = defaultScanRules();
  const now = Date.parse('2026-08-19T15:00:00Z');
  const stampedButNeverScanned = dueKinds(3, 11, rules, { planned: '2026-08-19T14:59:00Z' }, now);
  const neverStamped = dueKinds(3, 11, rules, { planned: null }, now);
  assert.equal(stampedButNeverScanned.planned.due, false, 'the phantom stamp silences the retry');
  assert.equal(neverStamped.planned.due, true, 'an honest clock retries immediately');
});
