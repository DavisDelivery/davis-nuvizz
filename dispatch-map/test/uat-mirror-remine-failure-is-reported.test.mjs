// test/uat-mirror-remine-failure-is-reported.test.mjs
//
// THE MIRROR'S RUN LOG SAID "remined" FOR A DAY WHOSE MINERS FAILED (audit 2026-09-27,
// shiplify-lookup-uat-4 — the reporting half only).
//
// runRefresh copies a sealed day onto the UAT mirror and then runs the post-seal miners over it.
// runPostSealHooks catches every miner's failure and answers { ok:false, hooks }, but runRefresh
// never looked: it set remined = true after the call returned, so the progress document and its
// log said "remined" for a day whose PRO index and search digest were never built. That is an
// intent reported as an outcome.
//
// What happens now: the progress says what the miners DID. A failed mine records remined:false,
// names the miners that failed, and the log line says so.
//
// NOT DECIDED HERE: whether a later run should retry such a day. mirroredDayIsCurrent still
// judges it current once post_seal_at is stamped — that is a question for Chad (a miner that
// fails on every day would make every nightly run re-copy the whole window and never reach the
// board days), and this file does not answer it.
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.FIRESTORE_DATABASE;

import { planRefresh, runRefresh } from '../netlify/functions/lib/uat-mirror-refresh.mts';
import { dayPath } from '../netlify/functions/lib/history-store.mts';

const T = 'davis';
const D = '2026-09-19';

function fakes() {
  const prod = new Map();
  const base = dayPath(T, D);
  prod.set(base, { tenant: T, date: D, sealed_at: `${D}T06:00:00Z` });
  prod.set(`${base}/stops/A1`, { stopNbr: 'A1' });
  const mirror = new Map();
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
  const lines = [];
  const deps = {
    listProd: listOf(prod), getProd: getOf(prod),
    listMirror: listOf(mirror), getMirror: getOf(mirror),
    setDoc: async (p, d) => { mirror.set(p, structuredClone(d)); return true; },
    nowIso: () => '2026-09-20T06:45:00.000Z',
    log: (l) => lines.push(l),
  };
  return { deps, lines };
}
const plan = () => planRefresh({ today: '2026-09-20', from: D, to: D, board: false, static: false });

test('a mirrored day whose miners failed is not reported as re-mined — the run names the miners that failed', async () => {
  const { deps, lines } = fakes();
  deps.remine = async () => ({ ok: false, hooks: { 'pro-index': { ok: false, error: '429 RESOURCE_EXHAUSTED' }, 'stop-search': { ok: false, error: '429' }, paint: { ok: true } } });
  const p = await runRefresh(deps, plan(), null);
  const day = p.counts.history[D];
  assert.equal(day.remined, false, 'the miners did not succeed, so the day was not re-mined');
  assert.deepEqual(day.remine_failed, ['pro-index', 'stop-search'], 'and the progress says which ones failed');
  const line = p.log.find((l) => l.startsWith(`history ${D}:`));
  assert.doesNotMatch(line, /remined/, line);
  assert.match(line, /miners FAILED \(pro-index, stop-search\)/, line);
  assert.ok(lines.includes(line), 'the same line reaches the function log');
});

test('a day whose miners all succeeded still reads remined, with nothing extra on the progress', async () => {
  const { deps } = fakes();
  deps.remine = async () => ({ ok: true, hooks: { 'pro-index': { ok: true } } });
  const p = await runRefresh(deps, plan(), null);
  assert.equal(p.counts.history[D].remined, true);
  assert.equal('remine_failed' in p.counts.history[D], false);
  assert.match(p.log.find((l) => l.startsWith(`history ${D}:`)), /, remined$/);
});
