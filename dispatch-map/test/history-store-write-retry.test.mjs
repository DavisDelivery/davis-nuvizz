// A write Firestore pushed back is retried with backoff, not dropped — the way Sep 10, Sep 11 and
// Sep 24, 2026 were lost (429 "exceeded maximum bandwidth for writes" at 02:01 ET, first throw ends the night).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  upsertAll, transientWriteError, backoffMs, WRITE_RETRIES, WRITE_BACKOFF_MS, PUSHED_BACK_WRITERS,
  historyWriteRetryEnabled, newWriteBudget, withWriteRetry, upsertDriverDayPointers, driverDayPointerPath,
  WRITE_RETRY_DEADLINE_MS, histDocId,
} from '../netlify/functions/lib/history-store.mts';
import { fetchWithDeadline } from '../netlify/functions/lib/fetch-deadline.mts';
import { recordCaptureFailure, finalizeCaptureSeal } from '../netlify/functions/lib/history-seal.mts';

// Every test here runs with the switch in its default (unset) position unless it says otherwise.
delete process.env.HISTORY_WRITE_RETRY;

const err = (code, path = 'history_days/davis__2026-09-24/stops/1') => new Error(`setDoc ${path} failed: ${code} {"error":{"code":${code}}}`);
function fakeStore(failuresFor) {
  const docs = new Map(); const attempts = []; const slept = [];
  const setDoc = async (path, data) => {
    attempts.push(path);
    const left = failuresFor.get(path) || 0;
    if (left > 0) { failuresFor.set(path, left - 1); throw err(429, path); }
    docs.set(path, data);
  };
  return { docs, attempts, slept, deps: { setDoc, sleep: async (ms) => { slept.push(ms); } } };
}
const items = (n) => Array.from({ length: n }, (_, k) => ({ stopNbr: String(k + 1) }));
const pathOf = (r) => `history_days/davis__2026-09-24/stops/${r.stopNbr}`;

test('a 429 is retried with backoff and every stop lands; the writers drop to four after the first push-back', async () => {
  const fails = new Map([[pathOf({ stopNbr: '3' }), 2], [pathOf({ stopNbr: '40' }), 1]]);
  const st = fakeStore(fails);
  const out = await upsertAll(items(60), pathOf, 12, st.deps);
  assert.equal(st.docs.size, 60, 'every stop written');
  assert.deepEqual(out, { written: 60, retries: 3, pushedBack: true });
  assert.equal(st.slept.length, 3);
  assert.ok(st.slept[0] >= 375 && st.slept[0] <= 625, `first wait ~0.5 s ±25% (${st.slept[0]})`);
  assert.equal(st.attempts.length, 63, '60 writes + 3 retries');
});

test('the same 429 six times in a row is thrown, naming the document — not swallowed, not retried forever', async () => {
  const st = fakeStore(new Map([[pathOf({ stopNbr: '2' }), 99]]));
  await assert.rejects(() => upsertAll(items(3), pathOf, 12, st.deps), (e) => {
    assert.match(e.message, /stops\/2 failed: 429/);
    // …and the error carries the retry count at its FRONT, where the failure record's
    // 500-character cap cannot cut it off.
    assert.match(e.message, /^gave up after 5 retries on this document; write retries this run: 5 \(Firestore pushed back\)/);
    return true;
  });
  assert.equal(st.slept.length, WRITE_RETRIES, `${WRITE_RETRIES} waits before giving up`);
  assert.deepEqual(WRITE_BACKOFF_MS, [500, 1000, 2000, 4000, 8000]);
});

test('a refusal is not a push-back: 400 / 403 / 404 are thrown at once with no wait', async () => {
  for (const code of [400, 403, 404]) {
    const deps = { setDoc: async (p) => { throw err(code, p); }, sleep: async () => { throw new Error('must not sleep'); } };
    await assert.rejects(() => upsertAll(items(2), pathOf, 12, deps), new RegExp(`failed: ${code}`));
  }
  assert.equal(transientWriteError(err(429)), true);
  assert.equal(transientWriteError(err(503)), true);
  assert.equal(transientWriteError(err(500)), true);
  assert.equal(transientWriteError(err(400)), false);
  assert.equal(transientWriteError(new Error('fetch failed')), true);
  assert.equal(transientWriteError(new Error('ECONNRESET')), true);
  assert.equal(transientWriteError(new Error('bad path')), false);
});

test('backoff is the ladder ±25% and never runs off its end', () => {
  assert.equal(backoffMs(0, 0), 375); assert.equal(backoffMs(0, 1), 625);
  assert.equal(backoffMs(4, 0.5), 8000); assert.equal(backoffMs(9, 0.5), 8000);
});

test('nothing to write is nothing done', async () => {
  const st = fakeStore(new Map());
  assert.deepEqual(await upsertAll([], pathOf, 12, st.deps), { written: 0, retries: 0, pushedBack: false });
  assert.equal(st.attempts.length, 0);
});

// ── retry-caps-7: the drop to four writers, measured ─────────────────────────────────────────
// A store whose every write takes one turn of the event loop, so writers genuinely overlap, and
// which counts how many writes STARTED after the first push-back are in flight at once.
function concurrentStore(failuresFor, { respond = (path) => err(429, path) } = {}) {
  const docs = new Map(); let inflight = 0, peak = 0, postInflight = 0, postPeak = 0, pushedBack = false, attempts = 0;
  const setDoc = async (path, data) => {
    attempts++;
    const post = pushedBack; inflight++; peak = Math.max(peak, inflight);
    if (post) { postInflight++; postPeak = Math.max(postPeak, postInflight); }
    await new Promise((r) => setImmediate(r));
    inflight--; if (post) postInflight--;
    const left = failuresFor.get(path) || 0;
    if (left > 0) { failuresFor.set(path, left - 1); pushedBack = true; throw respond(path); }
    docs.set(path, data);
  };
  return { docs, stats: () => ({ peak, postPeak, attempts }), deps: { setDoc, sleep: async () => {}, now: () => 0 } };
}

test('after Firestore pushes back, no more than four writes are ever in flight — the retry is not the same storm', async () => {
  const st = concurrentStore(new Map([[pathOf({ stopNbr: '5' }), 1]]));
  const out = await upsertAll(items(200), pathOf, 12, st.deps);
  const { peak, postPeak } = st.stats();
  assert.equal(st.docs.size, 200, 'every stop still lands');
  assert.equal(peak, 12, 'before the push-back it really was twelve at once (so the measurement can see a storm)');
  assert.ok(postPeak <= PUSHED_BACK_WRITERS, `after the push-back at most ${PUSHED_BACK_WRITERS} writes in flight, saw ${postPeak}`);
  assert.equal(PUSHED_BACK_WRITERS, 4);
  assert.deepEqual(out, { written: 200, retries: 1, pushedBack: true });
});

// The test above has every write take exactly one turn of the event loop, and in that lockstep a
// woken writer always finds its place still free. Real answers do not arrive in lockstep: a write
// that finishes hands its place to the oldest waiter, and before that waiter runs, another writer
// (a retry coming back from its backoff, a first attempt) can take a place too. The limiter
// therefore CHECKS AGAIN after every wake-up (history-store.mts, `while (budget.pushedBack &&
// active >= PUSHED_BACK_WRITERS)`). Seeded, so a failure names the seed that reproduces it.
test('FOUR IN FLIGHT HOLDS WHATEVER ORDER FIRESTORE ANSWERS IN: over sixty seeded interleavings with one-time 429s, no more than four writes started after the push-back are ever in flight, and every stop lands', async () => {
  const lcg = (seed) => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); };
  let worst = 0, worstSeed = null;
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = lcg(seed);
    // About one document in five is pushed back once.
    const refuse = new Set();
    for (let k = 1; k <= 200; k++) if (rnd() < 0.2) refuse.add(pathOf({ stopNbr: String(k) }));
    const docs = new Map();
    let pushedBack = false, postInflight = 0, postPeak = 0;
    const setDoc = async (path, data) => {
      const post = pushedBack; if (post) { postInflight++; postPeak = Math.max(postPeak, postInflight); }
      // Each answer arrives after either a microtask or a turn of the event loop — the seed decides.
      if (rnd() < 0.5) await Promise.resolve(); else await new Promise((r) => setImmediate(r));
      if (post) postInflight--;
      if (refuse.has(path)) { refuse.delete(path); pushedBack = true; throw err(429, path); }
      docs.set(path, data);
    };
    const out = await upsertAll(items(200), pathOf, 12,
      { setDoc, sleep: async () => { await Promise.resolve(); }, now: () => 0 },
      newWriteBudget({ deadlineAt: Number.MAX_SAFE_INTEGER, env: {} }));
    assert.equal(docs.size, 200, `seed ${seed}: every stop lands`);
    assert.equal(out.written, 200, `seed ${seed}`);
    assert.ok(postPeak <= PUSHED_BACK_WRITERS, `seed ${seed}: ${postPeak} writes in flight after the push-back — four means four`);
    if (postPeak > worst) { worst = postPeak; worstSeed = seed; }
  }
  // The measurement has to be able to see the limit, or a pass would prove nothing.
  assert.equal(worst, PUSHED_BACK_WRITERS, `the busiest seed (${worstSeed}) reached ${worst} in flight`);
});

test('a push-back on the stops carries to the routes: the next writer in the same capture starts at four, not twelve', async () => {
  const budget = newWriteBudget();
  const a = concurrentStore(new Map([[pathOf({ stopNbr: '1' }), 1]]));
  await upsertAll(items(40), pathOf, 12, a.deps, budget);
  assert.equal(budget.pushedBack, true);
  const b = concurrentStore(new Map());
  await upsertAll(items(40), pathOf, 12, b.deps, budget);
  assert.ok(b.stats().peak <= PUSHED_BACK_WRITERS, `routes after a pushed-back stops phase: peak ${b.stats().peak}`);
});

// ── retry-caps-2, merged with #1043: ONE classifier, every retried history write ─────────────
// #1043 (firestore-history-address-5, test/history-capture-stalled-write.test.mjs) taught the
// classifier that a request which hit fsFetch's 20 s deadline is a stall, and pinned that the STOP
// writer (upsertAll) retries it. This package's other retried writes — the seal and the lineage
// (withWriteRetry) and the failure record — ask that same classifier, so a stall is retried there
// too. And #1043's rule only ever acts through the retry loop that asks it, so HISTORY_WRITE_RETRY
// =off, which takes the loop away, takes the stall retry with it: a stall is thrown at once, as it
// was before #1030. These pin what #1043's own tests do not: each half of its rule on its own, the
// other writers, and the switch.
test('a stall at the 20-second deadline is retried by the seal, the lineage and the failure record too — one classifier — and HISTORY_WRITE_RETRY=off throws it at once, as before #1030', async () => {
  // The real deadline error, from a server that accepts the request and never answers.
  const srv = http.createServer(() => { /* accept, never answer */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  let caught;
  try { await fetchWithDeadline(`http://127.0.0.1:${srv.address().port}/`, { method: 'PATCH', body: '{}' }, 50); }
  catch (e) { caught = e; }
  finally { srv.closeAllConnections(); srv.close(); }
  assert.equal(caught?.name, 'TimeoutError', 'fetch-deadline rejects with its own TimeoutError');
  // Each half of #1043's rule on its own (its test sends name AND message together, so either half
  // could be lost unnoticed): the text alone (a wrapper that kept the words but lost the name)…
  assert.equal(transientWriteError(new Error('no answer within 20000ms')), true, 'by message alone');
  // …and the name alone (the platform's own timeout DOMException carries different words).
  assert.equal(transientWriteError(new DOMException('signal timed out', 'TimeoutError')), true, 'by name alone');
  // The seal and the lineage (withWriteRetry): the stall waits and tries again instead of ending the night.
  let n = 0; const slept = [];
  const out = await withWriteRetry(async () => { if (n++ === 0) throw caught; return 'sealed'; }, newWriteBudget(), { sleep: async (ms) => { slept.push(ms); }, now: () => 0 });
  assert.equal(out, 'sealed');
  assert.equal(n, 2, 'one stall, one retry');
  assert.equal(slept.length, 1);
  // The failure record: a stall on it is retried too, so it still lands.
  const landed = []; let stalls = 1;
  await recordCaptureFailure('davis', '2026-09-24', 'upsert', 'boom', null, {
    setDoc: async (path) => { if (stalls-- > 0) throw caught; landed.push(path); }, sleep: async () => {}, now: () => 0,
  });
  assert.deepEqual(landed, ['history_capture_failures/davis__2026-09-24']);
  // Switch off: the stop writer throws the stall at once — one attempt, no wait.
  const off = newWriteBudget({ env: { HISTORY_WRITE_RETRY: 'off' } });
  let tries = 0;
  await assert.rejects(
    () => upsertAll([{ stopNbr: '1' }], pathOf, 12, { setDoc: async () => { tries++; throw caught; }, sleep: async () => { throw new Error('must not sleep with the switch off'); }, now: () => 0 }, off),
    (e) => e === caught,
  );
  assert.equal(tries, 1, 'HISTORY_WRITE_RETRY=off puts back the single attempt, stalls included');
  // …and the seal / lineage path the same.
  let m = 0;
  await assert.rejects(() => withWriteRetry(async () => { m++; throw caught; }, off, { sleep: async () => {}, now: () => 0 }), (e) => e === caught);
  assert.equal(m, 1);
});

// ── retry-caps-1: a run-wide retry deadline ─────────────────────────────────────────────────
// The audit's own simulator: an event-queue virtual clock, 900 stops, 80 ms per Firestore answer,
// every stop refused three times before it lands. Before the deadline this took ~14.2 simulated
// minutes and then "succeeded" — against the 15 minutes the function's own header says Netlify
// gives it — or, one refusal more (~29 minutes), ran past that limit with no failure record.
async function throttledNight({ refusals, stops = 900, deadlineMs = WRITE_RETRY_DEADLINE_MS }) {
  let now = 0, done = false; const q = [];
  const wait = (ms) => new Promise((r) => { q.push({ t: now + ms, r }); q.sort((a, b) => a.t - b.t); });
  const pump = (async () => { for (;;) { await new Promise((r) => setImmediate(r)); if (!q.length) { if (done) return; continue; } const e = q.shift(); now = e.t; e.r(); } })();
  const left = new Map();
  const deps = {
    setDoc: async (p) => { await wait(80); const n = left.has(p) ? left.get(p) : refusals; if (n > 0) { left.set(p, n - 1); throw new Error(`setDoc ${p} failed: 429 {"error":{"code":429}}`); } },
    sleep: (ms) => wait(ms), now: () => now,
  };
  const budget = newWriteBudget({ startedAt: 0, deadlineMs });
  let result, error;
  try { result = await upsertAll(Array.from({ length: stops }, (_, i) => ({ stopNbr: String(i + 1) })), pathOf, 12, deps, budget); }
  catch (e) { error = e; }
  const endedAt = now;
  done = true; await pump;
  return { result, error, endedAt, budget };
}

test('a night Firestore will not stop refusing ends at the ten-minute retry deadline with the retry count in the error — so the failure record can land', async () => {
  const { result, error, endedAt, budget } = await throttledNight({ refusals: 3 });
  assert.equal(result, undefined, 'it does not grind on to minute fourteen');
  assert.ok(error, 'it throws');
  assert.match(error.message, /^stopped retrying at the run's 10-minute retry deadline; write retries this run: \d+ \(Firestore pushed back\) — setDoc .* failed: 429/);
  assert.equal(error.historyWriteGaveUp, true);
  assert.ok(budget.retries > 0);
  assert.ok(endedAt <= WRITE_RETRY_DEADLINE_MS + 1000, `the writer stopped by ${(endedAt / 60000).toFixed(2)} simulated minutes`);
  assert.equal(WRITE_RETRY_DEADLINE_MS, 10 * 60 * 1000);
});

test('a short push-back still lands every stop — the deadline only bites a night that would not have finished', async () => {
  const { result, error, endedAt } = await throttledNight({ refusals: 1 });
  assert.equal(error, undefined);
  assert.equal(result.written, 900);
  assert.ok(endedAt < WRITE_RETRY_DEADLINE_MS, `${(endedAt / 60000).toFixed(2)} min`);
});

// ── retry-caps-3: the driver-day pointers ────────────────────────────────────────────────────
const ptrs = (n) => Array.from({ length: n }, (_, k) => ({ driverKey: k === 0 ? 'COLIN/DJ 1' : `D${k}`, date: '2026-09-24', stopCount: 1 }));

test('driver-day pointers go through the bounded, retried writer: a 429 on one is retried and at most twelve go at once', async () => {
  const failing = driverDayPointerPath('davis', 'D7', '2026-09-24');
  const st = concurrentStore(new Map([[failing, 2]]));
  const out = await upsertDriverDayPointers('davis', '2026-09-24', ptrs(52), newWriteBudget(), st.deps);
  assert.equal(st.docs.size, 52, 'every pointer lands');
  assert.equal(out.retries, 2);
  assert.ok(st.stats().peak <= 12, `never all 52 at once (peak ${st.stats().peak})`);
  // Same path the old single-pointer writer used, slash sanitized.
  assert.ok(st.docs.has('history_driver_days/davis__COLIN_DJ 1/days/2026-09-24'));
  assert.equal(driverDayPointerPath('davis', undefined, '2026-09-24'), `history_driver_days/davis__${histDocId(undefined)}/days/2026-09-24`);
});

// ── the switch: HISTORY_WRITE_RETRY ──────────────────────────────────────────────────────────
test('HISTORY_WRITE_RETRY has the house shape: on unless off/0/false/no, and a typo leaves it ON', () => {
  for (const v of [undefined, '', 'on', 'ON', 'true', '1', 'yes', 'of', 'offf', 'disabled', 'nope']) {
    assert.equal(historyWriteRetryEnabled({ HISTORY_WRITE_RETRY: v }), true, `${JSON.stringify(v)} must leave the retry ON`);
  }
  for (const v of ['off', 'OFF', ' off ', '0', 'false', 'False', 'no', 'NO']) {
    assert.equal(historyWriteRetryEnabled({ HISTORY_WRITE_RETRY: v }), false, `${JSON.stringify(v)} turns it off`);
  }
  assert.equal(historyWriteRetryEnabled({}), true);
  assert.equal(historyWriteRetryEnabled(null), true);
});

test('HISTORY_WRITE_RETRY=off puts back the writer exactly as before #1030: one attempt, twelve writers, pointers all at once', async () => {
  const off = newWriteBudget({ env: { HISTORY_WRITE_RETRY: 'off' } });
  assert.equal(off.enabled, false);
  // A 429 is thrown at once, with no wait, and the text is Firestore's own (no retry note).
  const st = fakeStore(new Map([[pathOf({ stopNbr: '1' }), 1]]));
  st.deps.sleep = async () => { throw new Error('must not sleep with the switch off'); };
  await assert.rejects(() => upsertAll(items(3), pathOf, 12, st.deps, off), (e) => /^setDoc .*stops\/1 failed: 429/.test(e.message));
  // No drop to four: twelve writers the whole way, as the old loop did.
  const c = concurrentStore(new Map());
  const out = await upsertAll(items(60), pathOf, 12, c.deps, off);
  assert.deepEqual(out, { written: 60, retries: 0, pushedBack: false });
  assert.equal(c.stats().peak, 12);
  // …and, like the old loop, the other writers keep writing the rest after the first error
  // (Promise.all does not cancel them).
  const d = concurrentStore(new Map([[pathOf({ stopNbr: '1' }), 1]]));
  await assert.rejects(() => upsertAll(items(30), pathOf, 12, d.deps, off));
  for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
  assert.equal(d.docs.size, 29, 'every other stop was still written, as before #1030');
  // Pointers: every one fired at once, as the old Promise.all did.
  const p = concurrentStore(new Map());
  await upsertDriverDayPointers('davis', '2026-09-24', ptrs(52), off, p.deps);
  assert.equal(p.stats().peak, 52);
  // One attempt at any single write.
  let n = 0;
  await assert.rejects(() => withWriteRetry(async () => { n++; throw err(429); }, off, { sleep: async () => {}, now: () => 0 }));
  assert.equal(n, 1);
});

test('A STOP THAT FAILS FOR GOOD DOES NOT CALL THE OTHER WRITERS OFF — switch on, as #1030 did', async () => {
  // One stop refused past the run's retry deadline (and, second case, refused outright with a 403):
  // the error still reaches the capture at once, and the writers already at work go on with their
  // documents. Here the test process keeps running, so they finish; in production nothing awaits
  // them after the capture throws, so they write only while the function is still running (whether
  // the platform keeps it alive after the handler returns cannot be told from the code). Every stop
  // saved at nightly time is one a later re-capture would otherwise have to fill in. Measured before
  // this was put back: 20 of 900 on disk against #1030's 899.
  for (const respond of [(path) => err(429, path), (path) => err(403, path)]) {
    const e = concurrentStore(new Map([[pathOf({ stopNbr: '1' }), 99]]), { respond });
    await assert.rejects(() => upsertAll(items(30), pathOf, 12, { ...e.deps, now: () => Number.MAX_SAFE_INTEGER }, newWriteBudget({ deadlineAt: 0 })));
    for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
    assert.equal(e.docs.size, 29, `every other stop was still written (${e.docs.size} of 29)`);
  }
  // …and a writer already inside a push-back wait when another document fails for good carries on
  // with its own document rather than dropping it.
  const budget = newWriteBudget();
  const docs = new Map(); let releaseB; let bTries = 0;
  const deps = {
    setDoc: async (path, data) => {
      if (path.endsWith('/stops/1')) throw err(403, path);                          // A: refused for good
      if (path.endsWith('/stops/2') && ++bTries === 1) throw err(429, path);         // B: pushed back once
      docs.set(path, data);
    },
    sleep: (ms) => new Promise((r) => { releaseB = r; }),                            // B's wait, held by the test
    now: () => 0,
  };
  const run = upsertAll(items(2), pathOf, 12, deps, budget);
  await assert.rejects(run, /failed: 403/);
  for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r));
  assert.equal(typeof releaseB, 'function', 'B is inside its backoff wait when A fails');
  assert.equal(bTries, 1, 'B has not tried again yet — the test holds its wait');
  releaseB();
  for (let k = 0; k < 20; k++) await new Promise((r) => setImmediate(r));
  assert.equal(bTries, 2, 'B tried again after its wait');
  assert.ok(docs.has(pathOf({ stopNbr: '2' })), 'B landed');
});

// ── the failure record and the seal get the same retry ───────────────────────────────────────
test('the failure record is retried and lands even after the run\'s deadline has passed — bounded, never forever', async () => {
  const writes = []; let refusals = 2; const slept = [];
  const setDoc = async (path, doc) => { if (refusals-- > 0) throw err(429, path); writes.push({ path, doc }); };
  await recordCaptureFailure('davis', '2026-09-24', 'upsert', 'boom', null, { setDoc, sleep: async (ms) => { slept.push(ms); }, now: () => Number.MAX_SAFE_INTEGER });
  assert.equal(writes.length, 1, 'it landed');
  assert.equal(writes[0].path, 'history_capture_failures/davis__2026-09-24');
  assert.equal(slept.length, 2, 'after two waits, although the clock is far past any deadline');
  // Bounded: a record Firestore refuses forever is given up after five retries and does not throw.
  let tries = 0;
  await recordCaptureFailure('davis', '2026-09-24', 'upsert', 'boom', null, { setDoc: async () => { tries++; throw err(429); }, sleep: async () => {}, now: () => 0 });
  assert.equal(tries, 1 + WRITE_RETRIES);
  // Switch off: one attempt, as before.
  tries = 0;
  await recordCaptureFailure('davis', '2026-09-24', 'upsert', 'boom', null, { setDoc: async () => { tries++; throw err(429); }, sleep: async () => {}, now: () => 0, env: { HISTORY_WRITE_RETRY: 'off' } });
  assert.equal(tries, 1);
});

test('the failure text keeps the retry count when Firestore\'s own message is long — it leads, so the 500-character cap cannot cut it', async () => {
  const budget = newWriteBudget();
  budget.retries = 41; budget.pushedBack = true;
  let e;
  try { await withWriteRetry(async () => { throw new Error(`setDoc history_days/davis__2026-09-24/stops/1 failed: 429 ${'x'.repeat(480)}`); }, budget, { sleep: async () => {}, now: () => 0 }); }
  catch (x) { e = x; }
  const docs = [];
  await recordCaptureFailure('davis', '2026-09-24', 'upsert', e.message, null, { setDoc: async (_p, d) => { docs.push(d); } });
  assert.ok(docs[0].error.length <= 500);
  assert.match(docs[0].error, /write retries this run: 46 \(Firestore pushed back\)/);
});

const CAP = { capture_version: 1, captured_at: '2026-09-25T06:00:59.000Z', source_scanned_at: '2026-09-25T03:55:11.545Z', app_version: '0.12.0' };
const sealIO = (over = {}) => {
  const st = { manifest: null, failures: [], sealCalls: 0 };
  const io = {
    listStops: async () => [{ _id: '1', stopNbr: '1', isPlanned: true }],
    listRoutes: async () => [], listDrivers: async () => [],
    setManifest: async (_t, _d, m) => { st.sealCalls++; st.manifest = m; },
    recordFailure: async (_t, _d, stage, error) => { st.failures.push({ stage, error }); },
    clearFailure: async () => {}, sleep: async () => {}, now: () => 0, ...over,
  };
  return { io, st };
};
const sealInput = (extra = {}) => ({
  tenant: 'davis', date: '2026-09-24', stopsForChecksum: [{ stopNbr: '1' }], stopRecords: [{ stopNbr: '1' }],
  routeRecords: [], driverRecords: [], capture: CAP, absentKeptCount: 0, ...extra,
});

test('the manifest seal write is retried like the stops, and the manifest records the night\'s retries and the rows patched after the last scan', async () => {
  let refusals = 1;
  const { io, st } = sealIO({ setManifest: async (_t, _d, m) => { st.sealCalls++; if (refusals-- > 0) throw err(429, 'history_days/davis__2026-09-24'); st.manifest = m; } });
  const budget = newWriteBudget(); budget.retries = 3; budget.pushedBack = true;
  const out = await finalizeCaptureSeal(sealInput({ writeBudget: budget, patchedAfterLastScan: 0 }), io);
  assert.equal(out.sealed, true, 'a 429 on the seal no longer leaves the day unsealed');
  assert.equal(st.sealCalls, 2);
  assert.equal(st.manifest.write_retries, 3, 'the retries before the seal');
  assert.equal(st.manifest.write_pushed_back, true);
  assert.equal(st.manifest.patched_after_last_scan, 0);
  assert.equal(budget.retries, 4, 'the seal\'s own retry is on the budget for the lineage');
});

test('with HISTORY_WRITE_RETRY off the seal is one attempt and the manifest has no retry fields — the pre-#1030 shape', async () => {
  const { io, st } = sealIO({ setManifest: async () => { st.sealCalls++; throw err(429, 'history_days/davis__2026-09-24'); } });
  const off = newWriteBudget({ env: { HISTORY_WRITE_RETRY: 'off' } });
  const out = await finalizeCaptureSeal(sealInput({ writeBudget: off }), io);
  assert.equal(out.sealed, false);
  assert.equal(st.sealCalls, 1);
  assert.equal(st.failures[0].stage, 'seal');
  assert.match(st.failures[0].error, /^setDoc history_days\/davis__2026-09-24 failed: 429/, 'Firestore\'s text alone, as before');
  const ok = sealIO();
  await finalizeCaptureSeal(sealInput({ writeBudget: off }), ok.io);
  assert.equal('write_retries' in ok.st.manifest, false);
  assert.equal('write_pushed_back' in ok.st.manifest, false);
});

test('a verify failure after a throttled night says how many retries it took', async () => {
  const { io, st } = sealIO({ listStops: async () => [] });
  const budget = newWriteBudget(); budget.retries = 7; budget.pushedBack = true;
  await finalizeCaptureSeal(sealInput({ writeBudget: budget }), io);
  assert.equal(st.failures[0].stage, 'verify');
  assert.match(st.failures[0].error, /^write retries this run: 7 \(Firestore pushed back\) — verify-by-readback did not converge/);
});

// ── review r3: the rules that were stated but not pinned ─────────────────────────────────────
test('A RETRY WHOSE WAIT WOULD CROSS THE RUN\'S DEADLINE IS NOT TAKEN — it gives up at once, without sleeping past the line', async () => {
  // 100 ms before the deadline, and the shortest backoff is 375 ms (500 ms −25%): any wait crosses.
  const late = newWriteBudget({ deadlineAt: 1000 });
  let tries = 0;
  await assert.rejects(
    () => withWriteRetry(async () => { tries++; throw err(429); }, late, { sleep: async () => { throw new Error('slept past the retry deadline'); }, now: () => 900 }),
    (e) => /^stopped retrying at the run's 10-minute retry deadline; write retries this run: 0 — setDoc .* failed: 429/.test(e.message) && e.historyWriteGaveUp === true,
  );
  assert.equal(tries, 1, 'the first attempt is made; the retry is not');
  assert.equal(late.retries, 0, 'a retry not taken is not counted');
  // The other side of the line: 1000 ms before it, the longest first backoff (625 ms) fits — the retry IS taken.
  const early = newWriteBudget({ deadlineAt: 1000 });
  const slept = []; let n = 0;
  await withWriteRetry(async () => { if (n++ === 0) throw err(429); return 'ok'; }, early, { sleep: async (ms) => { slept.push(ms); }, now: () => 0 });
  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 375 && slept[0] <= 625, `one ladder step: ${slept[0]} ms`);
  assert.equal(early.retries, 1);
});

test('the seal on the HEAL path (no capture budget) keeps the manifest shape it always had — no retry fields, no retry prefix on its failure text', async () => {
  // history-manifest-heal-background passes no writeBudget. A seal-only budget would under-count
  // the run, so nothing from it may reach the manifest or lead a failure text.
  const ok = sealIO();
  const sealed = await finalizeCaptureSeal(sealInput({ healed: true }), ok.io);
  assert.equal(sealed.sealed, true);
  assert.equal(ok.st.manifest.healed, true);
  assert.equal('write_retries' in ok.st.manifest, false);
  assert.equal('write_pushed_back' in ok.st.manifest, false);
  assert.equal('patched_after_last_scan' in ok.st.manifest, false, 'not recorded by a caller that did not measure it');
  const bad = sealIO({ listStops: async () => [] });
  await finalizeCaptureSeal(sealInput({ healed: true }), bad.io);
  assert.equal(bad.st.failures[0].stage, 'verify');
  assert.match(bad.st.failures[0].error, /^verify-by-readback did not converge/, 'Firestore-free text, as before');
  // The seal write itself is still retried on the heal path (a 429 there is not fatal).
  let refusals = 1;
  const retried = sealIO({ setManifest: async (_t, _d, m) => { retried.st.sealCalls++; if (refusals-- > 0) throw err(429, 'history_days/davis__2026-09-24'); retried.st.manifest = m; } });
  assert.equal((await finalizeCaptureSeal(sealInput({ healed: true }), retried.io)).sealed, true);
  assert.equal(retried.st.sealCalls, 2);
  assert.equal('write_retries' in retried.st.manifest, false);
});

test('upsertAll reports ITS OWN retries: a call on a budget already pushed back that needs no retry says pushedBack false', async () => {
  const budget = newWriteBudget(); budget.retries = 5; budget.pushedBack = true;
  const st = fakeStore(new Map());
  const out = await upsertAll(items(3), pathOf, 12, st.deps, budget);
  assert.deepEqual(out, { written: 3, retries: 0, pushedBack: false });
  assert.equal(budget.pushedBack, true, 'the run\'s flag is untouched');
  assert.equal(budget.retries, 5);
});
