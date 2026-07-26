// test/nuvizz-write-handler.test.mjs — the op-envelope handler's GUARDS only.
// Every path here is network-free: it returns before any NuVizz call fires (bad
// method/JSON/op, dry-run, and the write-disabled 403). The actual firing path is
// covered by the executor tests (runOp over a stub requester).
import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../netlify/functions/nuvizz-write.mts';
import { hoistResultError } from '../netlify/functions/lib/nuvizz-write-ops.mts';

const URL = 'http://localhost/.netlify/functions/nuvizz-write';
const post = (obj, raw) => handler(new Request(URL, { method: 'POST', body: raw ?? JSON.stringify(obj) }));

// Keep the write kill-switch OFF for the whole file unless a test opts in.
const SAVED = process.env.NUVIZZ_WRITE_ENABLED;
test.before(() => { delete process.env.NUVIZZ_WRITE_ENABLED; });
test.after(() => { if (SAVED === undefined) delete process.env.NUVIZZ_WRITE_ENABLED; else process.env.NUVIZZ_WRITE_ENABLED = SAVED; });

test('non-POST → 405', async () => {
  const res = await handler(new Request(URL, { method: 'GET' }));
  assert.equal(res.status, 405);
});

test('OPTIONS → 200 (CORS preflight)', async () => {
  const res = await handler(new Request(URL, { method: 'OPTIONS' }));
  assert.equal(res.status, 200);
});

test('invalid JSON → 400', async () => {
  const res = await post(null, 'not json {');
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /invalid JSON/);
});

test('unknown op → 400 with the allowlist', async () => {
  const res = await post({ op: 'frobnicate', payload: {} });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.match(j.error, /unknown op/);
  assert.ok(Array.isArray(j.allowed));
});

test('dryRun commitLoad → ok with a human plan, ZERO NuVizz calls, never gated', async () => {
  const res = await post({ op: 'commitLoad', dryRun: true, payload: { loadNbr: 'BEN 2', insertStopIds: ['s1', 's2'], driverId: 7, driverName: 'DENIS', dispatch: true } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.ok(Array.isArray(j.plan));
  assert.ok(j.plan.some((s) => /assign driver DENIS/.test(s)));
  assert.ok(j.plan.some((s) => /dispatch load BEN 2/.test(s)));
  assert.equal(j.tenant, 'DAVIS');
});

test('dryRun commitBoard → plan labels the load by its friendly routeName, not the raw loadNbr', async () => {
  // Regression for "commitBoard: load not found": the panel sends the REAL numeric loadNbr
  // (load/info is keyed by it) but carries routeName for a readable confirm preview.
  const res = await post({ op: 'commitBoard', dryRun: true, payload: { loads: [
    { loadNbr: 'DAVIS000000123', routeName: 'LVILLE', orderedStopIds: ['s1', 's2', 's3'] },
  ] } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
  assert.ok(j.plan.some((s) => /Load LVILLE:/.test(s)), 'plan shows the routeName');
  assert.ok(!j.plan.some((s) => /DAVIS000000123/.test(s)), 'plan does not surface the raw loadNbr');
});

test('dryRun commitBoard with inline newStops → plan says the import CREATES them (no pre-creates)', async () => {
  const res = await post({ op: 'commitBoard', dryRun: true, payload: { useImport: true, settings: { origin: { name: 'U', addr1: 'a', city: 'c', state: 'GA', zip: 'z' }, serviceDate: '2026-07-02' }, loads: [{ loadNbr: 'SQTLOADI', createNew: true, orderedStopNbrs: ['1', '2'], newStops: [{ stopNbr: '1' }, { stopNbr: '2' }] }] } });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.plan.some((s) => /create 2 NEW order\(s\) INLINE/.test(s)), 'plan surfaces the inline creation');
  assert.ok(!j.plan.some((s) => /pre-create/i.test(s) && /stop\/sync/.test(s)), 'no pre-create step in the plan');
});

test('dryRun works for a non-mutating op too (getStop)', async () => {
  const res = await post({ op: 'getStop', dryRun: true, payload: { stopNbr: '7' } });
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.dryRun, true);
});

test('mutating op with NUVIZZ_WRITE_ENABLED unset → 403, no fire', async () => {
  delete process.env.NUVIZZ_WRITE_ENABLED;
  const res = await post({ op: 'assignDriver', payload: { loadId: 'L1', driverId: 7 } });
  assert.equal(res.status, 403);
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.equal(j.live, false);
  assert.match(j.error, /NUVIZZ_WRITE_ENABLED/);
});

test('commitLoad (live attempt) is also gated when writes are disabled', async () => {
  delete process.env.NUVIZZ_WRITE_ENABLED;
  const res = await post({ op: 'commitLoad', payload: { loadNbr: 'BEN 2', dispatch: true } });
  assert.equal(res.status, 403);
});

test('the response always reports tenant + live so the UI banner can show PROD state', async () => {
  const res = await post({ op: 'getStop', dryRun: true, payload: { stopNbr: '7' } });
  const j = await res.json();
  assert.equal(typeof j.tenant, 'string');
  assert.equal(typeof j.live, 'boolean');
  assert.ok(j.ops && typeof j.ops.ceiling === 'number');
});

// ─────────────────────────────────────────────────────────────────────────────
// The failure envelope must carry a REASON (Jul 24: a mobile "Add note in NuVizz"
// failed and could only say "Could not add the note." — the executor HAD built a
// precise reason, and the envelope dropped it on the floor at the last hop).
// hoistResultError is the pure part; testing it directly keeps these network-free.
// ─────────────────────────────────────────────────────────────────────────────

test('hoistResultError: a successful result contributes no top-level error', () => {
  assert.equal(hoistResultError({ ok: true, note: {} }), null);
  assert.equal(hoistResultError({ ok: true, duplicate: true }), null);
});

test('hoistResultError: a single-op failure surfaces the executor\'s own words', () => {
  const reason = 'addStopNote: could not read stop 007151468 (404 not found) — nothing was written.';
  assert.equal(hoistResultError({ ok: false, error: reason, calls: { reads: 1, writes: 0 } }), reason);
});

test('hoistResultError: every addStopNote failure shape reaches the caller intact', () => {
  // The six ok:false returns runAddStopNote can make — none may degrade to a generic message.
  for (const reason of [
    'addStopNote: could not read stop 7 (read failed) — nothing was written.',
    'addStopNote: stop 7 has no stopId in its record — cannot target the update safely.',
    'addStopNote: NuVizz rejected the note (403 forbidden).',
    'addStopNote: the note was accepted but the read-back failed (timeout) — check the order in the portal before re-trying, so you don\'t double-post.',
    'addStopNote: the note landed BUT partialUpdate changed 2 other field(s) on the order (address1, weight). Check 7 in the portal — do not use notes again until this is investigated.',
    'addStopNote: NuVizz accepted the write but the note is not on the order when read back — nothing else changed. Try again, or add it in the portal.',
  ]) {
    assert.equal(hoistResultError({ ok: false, error: reason }), reason);
  }
});

test('hoistResultError: batch ops summarise their per-load reasons', () => {
  const out = hoistResultError({ ok: false, loads: [
    { loadNbr: 'A', ok: true },
    { loadNbr: 'B', ok: false, error: 'load B not found' },
    { loadNbr: 'C', ok: false, result: { error: 'stop 9 already dispatched' } },
  ] });
  assert.match(out, /load B not found/);
  assert.match(out, /stop 9 already dispatched/);
});

test('hoistResultError: more than three per-load reasons are counted, not dropped silently', () => {
  const loads = ['a', 'b', 'c', 'd', 'e'].map((n) => ({ ok: false, error: `load ${n} failed` }));
  const out = hoistResultError({ ok: false, loads });
  assert.match(out, /load a failed/);
  assert.match(out, /\(\+2 more\)/);
});

test('hoistResultError: a reasonless failure still says SOMETHING (never null on ok:false)', () => {
  // The bug being fixed: ok:false + no error meant the caller invented its own wording and
  // the user learned nothing. A failure must never yield a null reason.
  for (const r of [{ ok: false }, { ok: false, error: '' }, { ok: false, error: '   ' }, { ok: false, loads: [] }]) {
    const out = hoistResultError(r);
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  }
});
