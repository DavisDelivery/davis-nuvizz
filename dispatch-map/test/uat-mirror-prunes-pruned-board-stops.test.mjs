// test/uat-mirror-prunes-pruned-board-stops.test.mjs
//
// A CANCELLED OR MOVED ORDER STAYED ON THE UAT BOARD FOR EVER (audit 2026-09-27,
// shiplify-lookup-uat-3).
//
// The nightly mirror refresh copies production's board for today through today+3 onto the UAT
// mirror, but it only ever UPSERTED production's current rows. Production's scan prunes a stop
// that leaves the day (cancelled, re-planned, moved to another day), and the mirror never did:
// night 1 copies A and B for Thursday, B is cancelled, night 2 copies A — and the UAT board still
// shows A and B, so the UAT routing engine Chad is judging plans freight production no longer has
// (or has on a different day, which then sits on both).
//
// What happens now: after a board day is copied, any row on the mirror's day that production no
// longer holds is removed — except the UAT bench's own seeded orders (UT- numbers, or rows that
// carry the bench's provenance), which production never had and must not lose.
// UAT_MIRROR_BOARD_PRUNE=off puts the old upsert-only copy back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.FIRESTORE_DATABASE;
delete process.env.UAT_MIRROR_BOARD_PRUNE;

import {
  planRefresh, runRefresh, copyBoardDay, boardPruneEnabled, boardRowsToPrune, explainRefresh, BOARD_COLLECTION,
} from '../netlify/functions/lib/uat-mirror-refresh.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = 'davis';
const D = '2026-09-23';
const dayBase = (d) => `${BOARD_COLLECTION}/${T}__${d}`;

/** Two in-memory databases; the mirror side can delete, production cannot. */
function fakes() {
  const prod = new Map();
  const mirror = new Map();
  const deletes = [];
  const listOf = (db) => async (collectionPath) => {
    const prefix = `${collectionPath}/`;
    const out = [];
    for (const [k, v] of db) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (rest.includes('/')) continue;
      out.push({ _id: rest, ...v });
    }
    return out;
  };
  const getOf = (db) => async (p) => (db.has(p) ? { ...db.get(p) } : null);
  const deps = {
    listProd: listOf(prod), getProd: getOf(prod),
    listMirror: listOf(mirror), getMirror: getOf(mirror),
    setDoc: async (p, d) => { mirror.set(p, structuredClone(d)); return true; },
    deleteMirror: async (p) => { deletes.push(p); mirror.delete(p); },
    nowIso: () => '2026-09-20T06:45:00.000Z',
    log: () => {},
  };
  return { prod, mirror, deletes, deps };
}
const mirrorStops = (mirror, d) => [...mirror.keys()]
  .filter((k) => k.startsWith(`${dayBase(d)}/stops/`)).map((k) => k.split('/').pop()).sort();
const boardOnly = (today) => planRefresh({ today, history: false, static: false });

test('an order production cancels between two nightly copies leaves the UAT board on the second', async () => {
  const { prod, mirror, deps } = fakes();
  prod.set(dayBase(D), { count: 2 });
  prod.set(`${dayBase(D)}/stops/A`, { stopNbr: 'A' });
  prod.set(`${dayBase(D)}/stops/B`, { stopNbr: 'B' });
  await runRefresh(deps, boardOnly('2026-09-20'), null);
  assert.deepEqual(mirrorStops(mirror, D), ['A', 'B'], 'night 1 copies both');

  // production's scan prunes B (cancelled), exactly as writeStops does
  prod.delete(`${dayBase(D)}/stops/B`);
  prod.set(dayBase(D), { count: 1 });
  const p = await runRefresh(deps, boardOnly('2026-09-21'), null);
  assert.deepEqual(mirrorStops(mirror, D), ['A'], 'the cancelled order is gone from the UAT board');
  assert.equal(mirror.get(dayBase(D)).count, 1, 'and the meta agrees with the rows');
  assert.equal(p.counts.board[D].pruned, 1, 'the run says how many it removed');
});

test('an order production moved to the next day sits on ONE UAT day, not both', async () => {
  const { prod, mirror, deps } = fakes();
  const D2 = '2026-09-24';
  prod.set(dayBase(D), { count: 1 });
  prod.set(`${dayBase(D)}/stops/M`, { stopNbr: 'M' });
  await runRefresh(deps, boardOnly('2026-09-20'), null);
  prod.delete(`${dayBase(D)}/stops/M`);
  prod.set(dayBase(D), { count: 0 });
  prod.set(dayBase(D2), { count: 1 });
  prod.set(`${dayBase(D2)}/stops/M`, { stopNbr: 'M' });
  await runRefresh(deps, boardOnly('2026-09-21'), null);
  assert.deepEqual(mirrorStops(mirror, D), [], 'not on the day it left');
  assert.deepEqual(mirrorStops(mirror, D2), ['M'], 'only on the day it moved to');
});

test('the UAT bench\'s own seeded orders survive the copy — production never had them', async () => {
  const { prod, mirror, deletes, deps } = fakes();
  prod.set(dayBase(D), { count: 1 });
  prod.set(`${dayBase(D)}/stops/A`, { stopNbr: 'A' });
  mirror.set(`${dayBase(D)}/stops/UT-007174397`, { stopNbr: 'UT-007174397', uatSeed: { prodStopNbr: '007174397' } });
  mirror.set(`${dayBase(D)}/stops/X-LEGACY`, { stopNbr: 'X-LEGACY', uatSeed: { prodStopNbr: 'X' } });
  mirror.set(`${dayBase(D)}/stops/STALE`, { stopNbr: 'STALE' });
  const res = await copyBoardDay(deps, T, D);
  assert.deepEqual(mirrorStops(mirror, D), ['A', 'UT-007174397', 'X-LEGACY'], 'a UT- number or the bench\'s provenance keeps the row');
  assert.deepEqual(deletes, [`${dayBase(D)}/stops/STALE`], 'only the row production dropped is deleted');
  assert.equal(res.pruned, 1);
});

test('a day production holds nothing for is left alone — "nothing there" is never read as "delete everything"', async () => {
  const { mirror, deletes, deps } = fakes();
  mirror.set(`${dayBase(D)}/stops/A`, { stopNbr: 'A' });
  await copyBoardDay(deps, T, D);
  assert.deepEqual(deletes, []);
  assert.deepEqual(mirrorStops(mirror, D), ['A']);
});

test('UAT_MIRROR_BOARD_PRUNE: on by default, an off-word turns it off, a typo leaves it ON (house shape)', () => {
  assert.equal(boardPruneEnabled({}), true);
  for (const off of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(boardPruneEnabled({ UAT_MIRROR_BOARD_PRUNE: off }), false, off);
  for (const on of ['on', '1', 'true', 'yes', 'of', 'nope', '']) assert.equal(boardPruneEnabled({ UAT_MIRROR_BOARD_PRUNE: on }), true, on);
});

test('with the switch off the copy is upsert-only again, and the endpoint hands the core no deleter', async () => {
  const { prod, mirror, deps } = fakes();
  delete deps.deleteMirror;   // what the endpoint passes when UAT_MIRROR_BOARD_PRUNE=off
  prod.set(dayBase(D), { count: 1 });
  prod.set(`${dayBase(D)}/stops/A`, { stopNbr: 'A' });
  mirror.set(`${dayBase(D)}/stops/STALE`, { stopNbr: 'STALE' });
  const res = await copyBoardDay(deps, T, D);
  assert.deepEqual(mirrorStops(mirror, D), ['A', 'STALE']);
  assert.deepEqual(res, { date: D, parent: true, stops: 1 }, 'the reply is exactly what it was before the prune existed');
  // One switch, one place: the endpoint wires the mirror's deleter only when it is on.
  const src = fs.readFileSync(path.join(HERE, '..', 'netlify', 'functions', 'lib', 'uat-mirror-endpoint.mts'), 'utf8');
  assert.match(src, /deleteMirror: boardPruneEnabled\(\) \?/);
});

// ── THE DRY RUN (review, 2026-09-27) ────────────────────────────────────────────────────────
// The prune is a delete the nightly does on its own, so ?explain=1 says how many rows it would
// remove before it removes them — through the same rule (boardRowsToPrune) the copy uses.

test('?explain=1 says how many UAT board rows the next copy would remove, and removes none of them', async () => {
  const { prod, mirror, deletes, deps } = fakes();
  prod.set(dayBase(D), { count: 1 });
  prod.set(`${dayBase(D)}/stops/A`, { stopNbr: 'A' });
  mirror.set(`${dayBase(D)}/stops/A`, { stopNbr: 'A' });
  mirror.set(`${dayBase(D)}/stops/STALE`, { stopNbr: 'STALE' });
  mirror.set(`${dayBase(D)}/stops/UT-007174397`, { stopNbr: 'UT-007174397', uatSeed: { prodStopNbr: '007174397' } });
  // a day production holds nothing for: the copy removes nothing there, so neither does the dry run
  mirror.set(`${dayBase('2026-09-22')}/stops/ORPHAN`, { stopNbr: 'ORPHAN' });
  const plan = boardOnly('2026-09-20');
  const res = await explainRefresh(deps, plan, { prune: true });
  const byDate = Object.fromEntries(res.board.map((r) => [r.date, r]));
  assert.equal(byDate[D].would_remove, 1, 'STALE only — never production\'s row, never the bench\'s');
  assert.equal(byDate['2026-09-22'].would_remove, 0);
  assert.deepEqual(deletes, [], 'a dry run deletes nothing');
  assert.equal(mirror.has(`${dayBase(D)}/stops/STALE`), true);

  // …and it is the same count the copy then acts on.
  const copy = await copyBoardDay(deps, T, D);
  assert.equal(copy.pruned, byDate[D].would_remove);

  // With the switch off the explain reads exactly as it did before the prune existed.
  const off = await explainRefresh(deps, plan, {});
  assert.equal(off.board.some((r) => 'would_remove' in r), false);
  assert.deepEqual(boardRowsToPrune([{ _id: 'A' }], [{ _id: 'A' }, { _id: 'B' }, { _id: 'UT-1' }, { _id: 'C', uatSeed: {} }]).map((r) => r._id), ['B']);
});

test('the explain endpoint asks for the dry run through the same switch the nightly reads', () => {
  const src = fs.readFileSync(path.join(HERE, '..', 'netlify', 'functions', 'uat-mirror-refresh.mts'), 'utf8');
  assert.match(src, /explainRefresh\(deps, plan, \{ prune: boardPruneEnabled\(\) \}\)/);
});
