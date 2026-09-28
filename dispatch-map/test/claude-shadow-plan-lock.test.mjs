// test/claude-shadow-plan-lock.test.mjs — ONE PAID PLAN OF A BOARD DAY AT A TIME, EVEN AFTER THE FIRST ONE.
//
// A Plan press takes a create-only lock on its board day, so two quick presses cannot both queue a paid
// run. But the lock was create-only only the FIRST time: once it named a finished plan, a press read it
// and overwrote it, and two presses that read it at once both took it and both queued — and a press that
// arrived while the first was still freezing its board (up to ~950 KB) found no job yet and took it too.
// Each run can spend up to its $ cap of the same 24-hour ceiling on the same plan (audit 2026-09-27,
// shadow-backend-1). Now taking over a finished holder is create-only as well, and a lock whose job is
// not on file yet is held while it is young.
import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueuePlan, PLAN_LOCKS, PLAN_LOCK_BIRTH_MS } from '../netlify/functions/lib/claude-shadow/plan-jobs.mts';
import { jobPath } from '../netlify/functions/lib/claude-shadow/backtest.mts';

const D = '2026-09-28';
const NOW = Date.parse('2026-09-27T05:00:00Z');
const LOCK = `${PLAN_LOCKS}/davis__${D}`;
const ENV = { ANTHROPIC_API_KEY: 'k', FIREBASE_SA: 'x' };
const stop = (nbr, lat, lng) => ({ stopNbr: nbr, stopType: 'DO', status: '10', normalizedStatus: 'UNPLANNED', isPlanned: false, isUnplanned: true, cartons: 2, volume: 0, weight: 500, businessName: `CUST ${nbr}`, addr1: `${nbr} MAIN ST`, city: 'GAINESVILLE', zip: '30501', lat, lng });
const board = {
  readStops: async (_t, d) => (d === D ? { meta: { last_scanned_at: '2026-09-26T19:38:56Z' }, stops: [stop('U1', 34.30, -83.80), stop('U2', 34.31, -83.81), stop('U3', 33.90, -84.20)] } : { meta: null, stops: [] }),
  readActivePool: async () => null, readActiveUnplannedSet: async () => null, readCarryoverRetired: async () => ({}),
};
const PARAMS = { date: D, lookbackDays: 0, scope: 'unplanned', picks: [{ kind: 'truck', route: 'SPARE BOX', driver: null, cls: 'box_truck', loadNbr: null }] };

// `boardWriteMs`: the frozen board is the big write (up to ~950 KB) — it takes real time.
function store(seed = {}, { boardWriteMs = 0 } = {}) {
  const docs = new Map(Object.entries(seed));
  const children = (coll) => [...docs.entries()]
    .filter(([p]) => p.startsWith(coll + '/') && p.slice(coll.length + 1).split('/').length === 1)
    .map(([p, d]) => ({ ...d, _id: p.slice(coll.length + 1) }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    docs,
    getDoc: async (p) => (docs.has(p) ? structuredClone(docs.get(p)) : null),
    listDocs: async (coll, opts) => children(coll).map((d) => {
      const c = structuredClone(d);
      if (!opts?.mask) return c;
      return Object.fromEntries(Object.entries(c).filter(([k]) => k === '_id' || opts.mask.includes(k)));
    }),
    shadowSet: async (p, d) => { assert.ok(p.startsWith('claude_shadow_'), p); if (p.endsWith('/data/problem') && boardWriteMs) await sleep(boardWriteMs); docs.set(p, structuredClone(d)); return true; },
    shadowPatch: async (p, d) => { assert.ok(p.startsWith('claude_shadow_'), p); docs.set(p, { ...(docs.get(p) || {}), ...structuredClone(d) }); return true; },
    shadowCreate: async (p, d) => { assert.ok(p.startsWith('claude_shadow_'), p); if (docs.has(p)) return false; docs.set(p, structuredClone(d)); return true; },
  };
}
const deps = (st, nowMs = NOW) => ({ ...st, board, now: () => new Date(nowMs), env: ENV, firestoreOn: () => true });
const planJobs = (st) => [...st.docs.entries()].filter(([k]) => /^claude_shadow_jobs\/pl__[^/]+$/.test(k)).map(([k, v]) => ({ id: k.split('/')[1], ...v }));
const queued = (st) => planJobs(st).filter((j) => j.status === 'queued');
const planned = (by, status, extra = {}) => ({
  [LOCK]: { jobId: `pl__${D}__${by}`, at: '2026-09-27T01:00:00.000Z', by },
  [jobPath(`pl__${D}__${by}`)]: { kind: 'plan', date: D, status, params: { date: D }, createdAt: '2026-09-27T01:00:00.000Z', updatedAt: '2026-09-27T01:30:00.000Z', ...extra },
});

test('two dispatchers pressing Plan at once for a day already planned this morning queue ONE paid run, not two', async () => {
  const st = store(planned('morning', 'done'));
  const [a, b] = await Promise.all([enqueuePlan(PARAMS, 'disp-A', deps(st)), enqueuePlan(PARAMS, 'disp-B', deps(st))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], JSON.stringify([a.body, b.body]));
  assert.equal(queued(st).length, 1, 'one run queued');
  const winner = a.status === 200 ? a : b;
  assert.equal(st.docs.get(LOCK).jobId, winner.body.jobId, 'the lock names the run that was queued');
});

test('a second Plan press while the first is still freezing its board is refused, not queued beside it', async () => {
  const st = store({}, { boardWriteMs: 60 });
  const a = enqueuePlan(PARAMS, 'disp-A', deps(st));
  await new Promise((r) => setTimeout(r, 20));
  const b = enqueuePlan(PARAMS, 'disp-B', deps(st));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200, JSON.stringify(ra.body));
  assert.equal(rb.status, 409, JSON.stringify(rb.body));
  assert.match(rb.body.error, /being queued/);
  assert.equal(queued(st).length, 1);
});

test('the same, on a day planned before: a press arriving mid-freeze after the takeover is refused', async () => {
  const st = store(planned('morning', 'done'), { boardWriteMs: 60 });
  const a = enqueuePlan(PARAMS, 'disp-A', deps(st));
  await new Promise((r) => setTimeout(r, 20));
  const b = enqueuePlan(PARAMS, 'disp-B', deps(st));
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.status, rb.status], [200, 409], JSON.stringify([ra.body, rb.body]));
  assert.equal(queued(st).length, 1);
});

test('when the plan finishes (or is Stopped), the next press takes the day again — and only one of two', async () => {
  const st = store(planned('morning', 'done'));
  const first = await enqueuePlan(PARAMS, 'disp-A', deps(st));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal((await enqueuePlan(PARAMS, 'disp-B', deps(st))).status, 409, 'held while it runs');
  st.docs.set(jobPath(first.body.jobId), { ...st.docs.get(jobPath(first.body.jobId)), status: 'cancelled', cancelRequested: true });
  const [a, b] = await Promise.all([enqueuePlan(PARAMS, 'disp-A', deps(st)), enqueuePlan(PARAMS, 'disp-B', deps(st))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(queued(st).length, 1);
});

test('a press that died after taking the lock (its job never appeared) holds the day for a minute, then the next press takes it', async () => {
  const dead = (agoMs) => ({ [LOCK]: { jobId: `pl__${D}__dead`, at: new Date(NOW - agoMs).toISOString(), by: 'x' } });
  const young = store(dead(20_000));
  const r = await enqueuePlan(PARAMS, 'disp', deps(young));
  assert.equal(r.status, 409, JSON.stringify(r.body));
  // The refusal cannot know whether that press will land or has died, so it does not promise either.
  assert.match(r.body.error, /if nothing shows within a minute, press Plan again/);
  assert.equal(planJobs(young).length, 0);
  const old = store(dead(PLAN_LOCK_BIRTH_MS + 1000));
  const ok = await enqueuePlan(PARAMS, 'disp', deps(old));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(old.docs.get(LOCK).jobId, ok.body.jobId);
});

test('a running plan still holds the day, as before', async () => {
  const st = store(planned('morning', 'running'));
  const r = await enqueuePlan(PARAMS, 'disp', deps(st));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already running/);
});
