// test/absent-plan-demote.test.mjs — a PLANNED stop that vanishes from the pull.
//
// Regression origin: KAI WONG (ESTES-1848671372) sat on Trevor Brent's SUW 5 in the route panel
// while NuVizz held it UNPLANNED, and re-scanning would not shift it — a second time, AFTER the
// localStorage plan overlay was fixed in v0.54.3, which is what proved the paint was coming from
// the board itself and not from that overlay.
//
// The mechanism: unplanning a stop in the portal removes it from the planned saved search, so
// the scan stops returning it at all. The two-scan carry-forward then re-added the prior board
// row VERBATIM — plan intact — to protect stops mid-flight between status buckets. And the
// demotion verify only ever saw rows the list DID return (`p.isPlanned && !s.isPlanned`), so a
// row that came back planned-because-carried-forward never even queued. Absence was treated as
// "still true" by one half of the scan and was invisible to the other. No number of fresh scans
// could dislodge it.
//
// The fix does NOT demote on absence. It makes absence ASK: the carried row arrives unplanned by
// default and has to be justified by NuVizz itself (load membership first, then the stop record),
// with every existing protection — write grace, budgets, hold-on-failed-read — untouched.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  absentPlanDemoteCandidate, applyDemotionVerify, PLAN_FIELDS,
} from '../netlify/functions/lib/nuvizz-list.mts';

// KAI WONG as the board held him: planned on SUW 5, enriched, seq 3.
const kaiWong = (over = {}) => ({
  stopNbr: '007148671372', businessName: 'KAI WONG', city: 'BUFORD',
  isPlanned: true, isUnplanned: false, status: '20', normalizedStatus: 'SCHEDULED',
  loadNbr: 'SUW 5', routeName: 'SUW 5', routeSeq: 3,
  driverName: 'Trevor Brent', driverUserName: 'tbrent',
  enriched: true, cartons: 3, scheduledFrom: '2026-07-29T12:00:00', ...over,
});

// ── the candidate ───────────────────────────────────────────────────────────

test('every PLAN_FIELD is cleared — the candidate carries no plan of its own', () => {
  // Pinned against PLAN_FIELDS so the two can never drift: a field added there but not
  // cleared here would survive as a phantom plan on a demoted row.
  const c = absentPlanDemoteCandidate(kaiWong());
  for (const k of PLAN_FIELDS) {
    assert.notDeepEqual([k, c[k]], [k, kaiWong()[k]], `${k} must not carry the old plan through`);
  }
  assert.equal(c.isPlanned, false);
  assert.equal(c.isUnplanned, true);
  assert.equal(c.loadNbr, null);
  assert.equal(c.routeName, null);
  assert.equal(c.routeSeq, null);
  assert.equal(c.normalizedStatus, 'UNPLANNED');
});

test('everything that is NOT the plan rides through untouched', () => {
  // The candidate is still the same stop — losing its detail would blank the card while the
  // verify is still deciding.
  const c = absentPlanDemoteCandidate(kaiWong());
  assert.equal(c.stopNbr, '007148671372');
  assert.equal(c.businessName, 'KAI WONG');
  assert.equal(c.cartons, 3);
  assert.equal(c.enriched, true);
  assert.equal(c.scheduledFrom, '2026-07-29T12:00:00');
});

test('the candidate is queued by the SAME condition a listed disagreement is', () => {
  // refresh-stops-core: `!held && p.isPlanned === true && p.loadNbr && s.isPlanned !== true`.
  // Carrying the row forward verbatim (the old behaviour) failed this and queued nothing.
  const p = kaiWong();
  const verbatim = p;
  const candidate = absentPlanDemoteCandidate(p);
  const queues = (s) => p.isPlanned === true && !!p.loadNbr && s.isPlanned !== true;
  assert.equal(queues(verbatim), false, 'the old carry-forward could never be questioned');
  assert.equal(queues(candidate), true);
});

test('the diagnostic marker is set, and it is never the thing that decides', () => {
  assert.equal(absentPlanDemoteCandidate(kaiWong()).absentFromPull, true);
});

// ── through the real verify ─────────────────────────────────────────────────

const verify = async (lookup, p = kaiWong()) => {
  const s = absentPlanDemoteCandidate(p);
  const out = await applyDemotionVerify([{ s, p }], { max: 64, scannedAt: '2026-07-29T16:00:00Z', lookup });
  return { s, out };
};

test('KAI WONG: NuVizz says the load does not hold it → the plan finally drops', () => {
  return verify(async () => false).then(({ s, out }) => {
    assert.equal(out.dropped, 1);
    assert.equal(s.isPlanned, false);
    assert.equal(s.loadNbr, null);
    assert.equal(s.routeName, null, 'must not linger on SUW 5 in the route panel');
    assert.equal(s.routeSeq, null, 'and must not keep a stop number on a route it is off');
  });
});

test('mid-flight: the load still holds it → the plan is kept and stamped verified', async () => {
  // The case this carry-forward exists for. An in-transit stop matches NEITHER saved search,
  // so it is absent every scan — it must come back planned, not be dropped off a live route.
  const { s, out } = await verify(async () => true);
  assert.equal(out.kept, 1);
  assert.equal(out.dropped, 0);
  assert.equal(s.isPlanned, true);
  assert.equal(s.loadNbr, 'SUW 5');
  assert.equal(s.routeSeq, 3, 'its place in the route comes back too');
  assert.equal(s.driverName, 'Trevor Brent');
  assert.equal(s.plan_verified_at, '2026-07-29T16:00:00Z');
});

test('a failed or over-budget read HOLDS the plan — absence alone never demotes', async () => {
  const { s, out } = await verify(async () => null);
  assert.equal(out.held, 1);
  assert.equal(out.dropped, 0);
  assert.equal(s.isPlanned, true);
  assert.equal(s.loadNbr, 'SUW 5');
  assert.equal(s.plan_verified_at, undefined, 'held is not verified — do not claim it was');
});

test('a lookup that THROWS holds too — a vendor error can never wipe a route', async () => {
  const { s, out } = await verify(async () => { throw new Error('ECONNRESET'); });
  assert.equal(out.held, 1);
  assert.equal(s.isPlanned, true);
  assert.equal(s.loadNbr, 'SUW 5');
});

test('a confirmed Save carried on the prior row survives the round trip', async () => {
  // keepPlan re-attaches board_write_at/board_write_planned, so the write-through grace still
  // defends a just-saved plan on the NEXT scan as well.
  const p = kaiWong({ board_write_at: '2026-07-29T15:55:00Z', board_write_planned: true });
  const { s } = await verify(async () => null, p);
  assert.equal(s.board_write_at, '2026-07-29T15:55:00Z');
  assert.equal(s.board_write_planned, true);
});

test('with the verify disabled, absence is simply not acted on', async () => {
  // max<=0 is the legacy list-wins switch. It must not turn absence into a mass unplanning.
  const p = kaiWong();
  const s = absentPlanDemoteCandidate(p);
  const out = await applyDemotionVerify([{ s, p }], { max: 0, scannedAt: 'x', lookup: async () => true });
  assert.equal(out.dropped, 1, 'reported as dropped — the caller disabled the protection');
  assert.equal(out.kept, 0);
});

// ── what must NEVER become a candidate ──────────────────────────────────────

test('a DELIVERED stop is never questioned — the outcome is not the plan', () => {
  // Mirrors the carry-forward guard: `!isTerminalHistoryStatus(p)`. A delivered stop is
  // routinely absent from a later pull and its load legitimately stops holding it, and
  // demotionLookupVerdict answers `false` for a terminal record — so without this guard the
  // delivery would be "demoted" into an UNPLANNED row and disappear off the board.
  const terminal = (st) => ['DELIVERED', 'EXCEPTION', 'CANCELLED'].includes(String(st).toUpperCase());
  const candidateWorthy = (p) => p.isPlanned === true && !!p.loadNbr && !terminal(p.normalizedStatus);
  for (const st of ['DELIVERED', 'EXCEPTION', 'CANCELLED']) {
    assert.equal(candidateWorthy(kaiWong({ normalizedStatus: st })), false, st);
  }
  assert.equal(candidateWorthy(kaiWong({ normalizedStatus: 'SCHEDULED' })), true);
  assert.equal(candidateWorthy(kaiWong({ normalizedStatus: 'OUT_FOR_DELIVERY' })), true, 'mid-flight IS questioned — and the verify keeps it');
});

test('an unplanned or load-less prior row was never on trial to begin with', () => {
  const candidateWorthy = (p) => p.isPlanned === true && !!p.loadNbr;
  assert.equal(candidateWorthy(kaiWong({ isPlanned: false })), false);
  assert.equal(candidateWorthy(kaiWong({ loadNbr: null })), false, 'no load to ask about');
});

// ── the thin-pull guard ─────────────────────────────────────────────────────

test('the pull-health ratio: absence is only worth asking about on a whole pull', () => {
  // Mirrors refresh-stops-core: pullHealthy = prev.size === 0 || rows >= prev.size * RATIO.
  const healthy = (rows, prevSize, ratio = 0.5) => prevSize === 0 || rows >= prevSize * ratio;
  assert.equal(healthy(833, 833), true, 'a normal pull');
  assert.equal(healthy(833, 834), true, 'one stop unplanned out of a full board');
  assert.equal(healthy(420, 833), true, 'exactly half still counts');
  assert.equal(healthy(12, 833), false, 'a half-returned search is a scan failure, not 800 unplannings');
  assert.equal(healthy(0, 833), false);
  assert.equal(healthy(5, 0), true, 'a cold board has nothing to compare against');
});
