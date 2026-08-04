// test/demotion-lookup.test.mjs — makeDemotionLookup (refresh-stops-core.mts).
//
// The scan's "list says a previously-planned stop is now unplanned" policy, extracted from
// runRefreshStops with every read injected (audit follow-up T2). Verdicts: true = keep the
// plan, false = demote (list wins), null = hold one tick. Pinned rules, each from a real
// incident:
//   • fresh TERMINAL rows never resurrect (F5)
//   • load membership corroborates FIRST, one memoized read per load (OWUSU 1)
//   • ambiguous roster names never resolve (F3); "not a member" falls to the record (F3b)
//   • roster read FAILURE holds; roster merely absent falls through (F9)
//   • zero-padding differences can't fake a "not on load"
//   • budgets: over-budget verdicts null (hold), never a guess
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeDemotionLookup } from '../netlify/functions/lib/refresh-stops-core.mts';
import { demotionLookupVerdict } from '../netlify/functions/lib/nuvizz-list.mts';

// A demote-check entry: `s` is the fresh list row (unplanned-looking), `p` the previous
// planned board row whose plan is on trial. routeName rides p.loadNbr (board rows carry the
// route NAME there).
function chk(nbr, { status = 'UNPLANNED', routeName = null } = {}) {
  return [String(nbr), {
    s: { stopNbr: String(nbr), normalizedStatus: status, isPlanned: false },
    p: { stopNbr: String(nbr), isPlanned: true, loadNbr: routeName },
  }];
}

function makeDeps(over = {}) {
  const calls = { roster: 0, loads: [], stops: [] };
  const deps = {
    demoteByNbr: new Map(),
    readRoster: async () => { calls.roster++; return { loads: [] }; },
    readLoadStopNbrs: async (nbr) => { calls.loads.push(String(nbr)); return new Set(); },
    readStopRecord: async (nbr) => { calls.stops.push(String(nbr)); return { ok: false, reason: 'http_404' }; },
    verdictFromRecord: demotionLookupVerdict,
    loadReadBudget: 4,
    stopReadBudget: 8,
    ...over,
  };
  return { deps, calls };
}

test('demotion: a fresh TERMINAL row demotes immediately — zero reads (F5)', async () => {
  const { deps, calls } = makeDeps();
  deps.demoteByNbr = new Map([chk('100', { status: 'DELIVERED', routeName: 'MONE 1' })]);
  const d = makeDemotionLookup(deps);
  assert.equal(await d.lookup('100'), false, 'delivered work is finished — the plan must not resurrect');
  assert.equal(calls.roster, 0, 'no roster read spent');
  assert.deepEqual(calls.loads, []);
  assert.deepEqual(calls.stops, []);
  // CANCELLED and EXCEPTION behave the same.
  for (const status of ['CANCELLED', 'EXCEPTION']) {
    const { deps: d2 } = makeDeps();
    d2.demoteByNbr = new Map([chk('101', { status, routeName: 'MONE 1' })]);
    assert.equal(await makeDemotionLookup(d2).lookup('101'), false, status);
  }
});

test('demotion: positive load membership keeps the plan — ONE memoized load read covers the route', async () => {
  const { deps, calls } = makeDeps({
    readRoster: async () => ({ loads: [{ name: 'MONE 1', loadNbr: 'DAVIS000198111' }] }),
    readLoadStopNbrs: async (nbr) => { calls.loads.push(String(nbr)); return new Set(['007144864', '007144912']); },
  });
  deps.demoteByNbr = new Map([
    chk('007144864', { routeName: 'MONE 1' }),
    chk('007144912', { routeName: 'MONE 1' }),
  ]);
  const d = makeDemotionLookup(deps);
  assert.equal(await d.lookup('007144864'), true, 'the load holds it — plan kept');
  assert.equal(await d.lookup('007144912'), true);
  assert.deepEqual(calls.loads, ['DAVIS000198111'], 'second check rides the memo — one load read for the whole route');
  assert.deepEqual(calls.stops, [], 'record never consulted on a positive membership');
  assert.deepEqual(d.reads(), { loadReads: 1, stopReads: 0 });
});

test('demotion: zero-padding differences cannot fake a "not on load"', async () => {
  const { deps } = makeDeps({
    readRoster: async () => ({ loads: [{ name: 'SCOTT', loadNbr: 'DAVIS000198222' }] }),
    readLoadStopNbrs: async () => new Set(['7143917']),   // NuVizz echoed the number unpadded
  });
  deps.demoteByNbr = new Map([chk('007143917', { routeName: 'SCOTT' })]);
  assert.equal(await makeDemotionLookup(deps).lookup('007143917'), true, 'normalized forms match — member');
});

test('demotion: "not a member" falls through to the stop record (F3b) — record decides', async () => {
  // Membership check comes back negative, but the record is the truth: first a record that
  // confirms UNPLANNED (demote), then one that shows the stop assigned (keep).
  const base = {
    readRoster: async () => ({ loads: [{ name: 'JEAN', loadNbr: 'DAVIS000198333' }] }),
    readLoadStopNbrs: async () => new Set(['other-stop']),
  };
  const { deps: dDrop, calls: cDrop } = makeDeps({
    ...base,
    readStopRecord: async (nbr) => { cDrop.stops.push(String(nbr)); return { ok: true, stop: { normalizedStatus: 'UNPLANNED', isPlanned: false, loadNbr: null } }; },
  });
  dDrop.demoteByNbr = new Map([chk('200', { routeName: 'JEAN' })]);
  assert.equal(await makeDemotionLookup(dDrop).lookup('200'), false, 'record confirms unplanned — demote');
  assert.deepEqual(cDrop.stops, ['200']);

  const { deps: dKeep } = makeDeps({
    ...base,
    readStopRecord: async () => ({ ok: true, stop: { normalizedStatus: 'SCHEDULED', isPlanned: true, loadNbr: 'DAVIS000198999' } }),
  });
  dKeep.demoteByNbr = new Map([chk('201', { routeName: 'JEAN' })]);
  assert.equal(await makeDemotionLookup(dKeep).lookup('201'), true, 'record shows it assigned — plan kept');
});

test('demotion: ambiguous roster names never resolve — record decides, no load read spent (F3)', async () => {
  const { deps, calls } = makeDeps({
    readRoster: async () => ({ loads: [
      { name: 'TRAILER 1', loadNbr: 'DAVIS000198444' },
      { name: 'TRAILER 1', loadNbr: 'DAVIS000198445' },   // tomorrow's recurring twin
    ] }),
    readStopRecord: async (nbr) => { calls.stops.push(String(nbr)); return { ok: true, stop: { isPlanned: true, loadNbr: 'DAVIS000198444', normalizedStatus: 'SCHEDULED' } }; },
  });
  deps.demoteByNbr = new Map([chk('300', { routeName: 'TRAILER 1' })]);
  assert.equal(await makeDemotionLookup(deps).lookup('300'), true);
  assert.deepEqual(calls.loads, [], 'no membership read against an arbitrarily-picked twin');
  assert.deepEqual(calls.stops, ['300'], 'the stop record decided');
});

test('demotion: roster read FAILURE holds every name-resolved check; roster ABSENT falls through (F9)', async () => {
  // Failure: readRoster throws → named checks hold (null), and no budget is spent on them.
  const { deps: dFail, calls: cFail } = makeDeps({
    readRoster: async () => { cFail.roster++; throw new Error('firestore 503'); },
  });
  dFail.demoteByNbr = new Map([chk('400', { routeName: 'KAZEEM' }), chk('401', { routeName: 'ENOCK' })]);
  const lf = makeDemotionLookup(dFail);
  assert.equal(await lf.lookup('400'), null, 'roster unreadable — hold, never guess');
  assert.equal(await lf.lookup('401'), null, 'stays failed for the whole scan');
  assert.equal(cFail.roster, 1, 'roster attempted once, not per stop');
  assert.deepEqual(lf.reads(), { loadReads: 0, stopReads: 0 });

  // Absent (null, no throw): NOT a failure — named check falls through to the record.
  const { deps: dNull, calls: cNull } = makeDeps({
    readRoster: async () => null,
    readStopRecord: async (nbr) => { cNull.stops.push(String(nbr)); return { ok: true, stop: { isPlanned: false, normalizedStatus: 'UNPLANNED' } }; },
  });
  dNull.demoteByNbr = new Map([chk('402', { routeName: 'KAZEEM' })]);
  assert.equal(await makeDemotionLookup(dNull).lookup('402'), false, 'no roster ≠ roster failure — record decides');
  assert.deepEqual(cNull.stops, ['402']);
});

test('demotion: a stop with NO route name skips membership entirely — straight to the record', async () => {
  const { deps, calls } = makeDeps({
    readStopRecord: async (nbr) => { calls.stops.push(String(nbr)); return { ok: true, stop: { isPlanned: false, normalizedStatus: 'UNPLANNED' } }; },
  });
  deps.demoteByNbr = new Map([chk('500', { routeName: null })]);
  assert.equal(await makeDemotionLookup(deps).lookup('500'), false);
  assert.equal(calls.roster, 0, 'no roster read without a name to resolve');
  assert.deepEqual(calls.stops, ['500']);
});

test('demotion: LOAD-read budget exhausted → hold (null), record NOT consulted for that stop', async () => {
  const { deps, calls } = makeDeps({
    loadReadBudget: 1,
    readRoster: async () => ({ loads: [
      { name: 'MONE 1', loadNbr: 'DAVIS000198111' },
      { name: 'SCOTT', loadNbr: 'DAVIS000198222' },
    ] }),
    readLoadStopNbrs: async (nbr) => { calls.loads.push(String(nbr)); return new Set(['600']); },
  });
  deps.demoteByNbr = new Map([chk('600', { routeName: 'MONE 1' }), chk('601', { routeName: 'SCOTT' })]);
  const d = makeDemotionLookup(deps);
  assert.equal(await d.lookup('600'), true, 'first load read fits the budget');
  assert.equal(await d.lookup('601'), null, 'second load would exceed the budget — held one tick');
  assert.deepEqual(calls.loads, ['DAVIS000198111'], 'the over-budget load was never read');
  assert.deepEqual(calls.stops, [], 'over-budget membership does NOT fall through to a record read');
  assert.deepEqual(d.reads(), { loadReads: 1, stopReads: 0 });
});

test('demotion: STOP-record budget exhausted → hold (null)', async () => {
  const { deps, calls } = makeDeps({
    stopReadBudget: 1,
    readStopRecord: async (nbr) => { calls.stops.push(String(nbr)); return { ok: true, stop: { isPlanned: false, normalizedStatus: 'UNPLANNED' } }; },
  });
  deps.demoteByNbr = new Map([chk('700', {}), chk('701', {})]);
  const d = makeDemotionLookup(deps);
  assert.equal(await d.lookup('700'), false, 'first record read fits');
  assert.equal(await d.lookup('701'), null, 'second is over budget — held');
  assert.deepEqual(calls.stops, ['700']);
  assert.deepEqual(d.reads(), { loadReads: 0, stopReads: 1 });
});

test('demotion: a 404/failed record read holds (demotionLookupVerdict integration)', async () => {
  const { deps } = makeDeps();   // default readStopRecord answers { ok:false, reason:'http_404' }
  deps.demoteByNbr = new Map([chk('800', {})]);
  assert.equal(await makeDemotionLookup(deps).lookup('800'), null,
    'a stop NuVizz cannot even find is never demoted on that absence — hold for the next scan');
});

// ── two records, one number (the Estes-0828068215 lesson, Aug 4) ─────────────
//
// The record read is BY NUMBER, and NuVizz can hold two orders under one number. The
// OTHER record's status must not decide this board row's fate in either direction: a
// finished twin would vote a live routed stop OFF its truck; a live twin would keep a
// truly-removed one ON. Identity disagreement → hold, re-check next scan.

test('demotion: a record with a DIFFERENT stopId than the board row holds — never votes', async () => {
  const p = { stopNbr: '300', isPlanned: true, loadNbr: 'CHAD 1', stopId: '6a63c5844524f7f7b8ab5410' };
  const { deps, calls } = makeDeps({
    // The twin: DELIVERED — its verdict alone would demote the live routed stop.
    readStopRecord: async (nbr) => { calls.stops.push(String(nbr)); return { ok: true, stop: { stopId: 'ffffffffffffffffffffffff', normalizedStatus: 'DELIVERED' } }; },
  });
  deps.demoteByNbr = new Map([['300', { s: { stopNbr: '300', normalizedStatus: 'UNPLANNED', isPlanned: false }, p }]]);
  const d = makeDemotionLookup(deps);
  assert.equal(await d.lookup('300'), null, 'the twin cannot speak for this row — hold one tick');
  assert.deepEqual(calls.stops, ['300'], 'the read was spent (and is what exposed the twin)');
});

test('demotion: matching stopId (or no id on either side) keeps the record\'s verdict', async () => {
  const mk = (pStopId, recStopId, status = 'DELIVERED') => {
    const p = { stopNbr: '301', isPlanned: true, loadNbr: 'CHAD 1', ...(pStopId ? { stopId: pStopId } : {}) };
    const { deps } = makeDeps({
      readStopRecord: async () => ({ ok: true, stop: { ...(recStopId ? { stopId: recStopId } : {}), normalizedStatus: status } }),
    });
    deps.demoteByNbr = new Map([['301', { s: { stopNbr: '301', normalizedStatus: 'UNPLANNED', isPlanned: false }, p }]]);
    return makeDemotionLookup(deps);
  };
  assert.equal(await mk('6a63c5844524f7f7b8ab5410', '6a63c5844524f7f7b8ab5410').lookup('301'), false, 'same record, terminal → demote');
  assert.equal(await mk(null, 'ffffffffffffffffffffffff').lookup('301'), false, 'board row has no id → cannot judge, old behavior');
  assert.equal(await mk('6a63c5844524f7f7b8ab5410', null).lookup('301'), false, 'record has no id → same');
});
