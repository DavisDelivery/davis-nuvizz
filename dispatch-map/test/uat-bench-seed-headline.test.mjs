// test/uat-bench-seed-headline.test.mjs
//
// THE BENCH'S SEED HEADLINE SAID "failed" ON A CLEAN SEED (audit 2026-09-27, client-map-ui-libs-2).
//
// The server's seed reply named `failed` twice in one object literal — the count, then the array —
// so the array won and the count never reached the wire. The screen's headline read `result.failed`
// as a count: an empty array is truthy and prints as nothing, so every clean seed read
// "Seeded 3,  failed · …", and a real failure read "Seeded 2, [object Object] failed". A refused seed
// (no board read at all) also claimed "board now holds 0".
//
// What happens now: the headline counts the refused orders from the list the server actually
// sends, says nothing about failures when there were none, and only states the board's size when
// the server read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { seedHeadline } from '../src/lib/uat-bench-view.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');
const D = '2026-09-28';
const prodRow = (nbr) => ({ stopNbr: nbr, businessName: `CUSTOMER ${nbr}`, addr1: '1 MAIN ST', city: 'NORCROSS', state: 'GA', zip: '30071', isUnplanned: true, isPlanned: false });

/** Seed through the real endpoint, NuVizz faked: `refuse` names the orders it rejects. */
async function seedReply(nbrs, refuse = new Set()) {
  const seed = {};
  for (const n of nbrs) seed[`nuvizz_stop_index/davis__${D}/stops/${n}`] = prodRow(n);
  const fake = installFirestoreFake(seed, async (url, init) => {
    if (/stop\/sync\/update/.test(url)) {
      const nbr = JSON.parse(init.body).stop.stopNbr;
      if (refuse.has(nbr)) return new Response(JSON.stringify({ status: 'FAILURE', errors: ['refused'] }), { status: 400 });
      return new Response(JSON.stringify({ status: 'SUCCESS', entityInfoList: [{ entityId: `id-${nbr}`, entityNbr: nbr }] }), { status: 200 });
    }
    throw new Error(`unexpected vendor call ${url}`);
  });
  const env = {
    FIRESTORE_DATABASE: 'uat-mirror', NUVIZZ_BASE_URL: 'https://uat.nuvizz.com/deliverit/openapi/v7',
    NUVIZZ_DAVIS_COMPANY_CODE: 'DAVISV5', NUVIZZ_DAVIS_USER: 'u', NUVIZZ_DAVIS_PASS: 'p',
    NUVIZZ_WRITE_ENABLED: 'true', MIRROR_ALLOW_OUTBOUND: 'nuvizz-write',
  };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    const handler = (await import('../netlify/functions/uat-seed.mts')).default;
    const res = await handler(new Request('https://x/.netlify/functions/uat-seed', { method: 'POST', body: JSON.stringify({ op: 'seed', date: D, stopNbrs: nbrs }) }));
    return JSON.parse(await res.text());
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fake.restore();
  }
}

test('a tester who seeds three orders cleanly is not told anything failed', async () => {
  const reply = await seedReply(['1001', '1002', '1003']);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const line = seedHeadline(reply);
  assert.doesNotMatch(line, /failed/, line);
  assert.match(line, /^Seeded 3 · \d+ UAT call\(s\) · board now holds 6$/, line);
});

test('a seed where NuVizz refuses one order says "1 failed" — never "[object Object] failed"', async () => {
  const reply = await seedReply(['1001', '1002'], new Set(['UT-1002']));
  assert.equal(reply.failed.length, 1, 'the refused order is on the wire as a list');
  const line = seedHeadline(reply);
  assert.doesNotMatch(line, /object Object/, line);
  assert.match(line, /^Seeded 1, 1 failed · /, line);
});

test('a refused seed does not claim a board size nobody read', () => {
  const line = seedHeadline({ ok: false, op: 'seed', error: 'uat-seed: NUVIZZ_WRITE_ENABLED is not true on this site' });
  assert.doesNotMatch(line, /board now holds/, line);
  assert.equal(line, 'Seeded 0 · 0 UAT call(s)');
  for (const junk of [null, undefined, {}]) assert.doesNotMatch(seedHeadline(junk), /failed|board now holds|undefined|NaN/);
});

test('the reply names `failed` once, and the screen\'s headline is the tested one', () => {
  const server = read('netlify', 'functions', 'uat-seed.mts');
  assert.doesNotMatch(server, /failed: failed\.length/, 'no shadowed count in the reply literal');
  const bench = read('src', 'components', 'UatBench.jsx');
  assert.match(bench, /op === 'seed' && seedHeadline\(result\)/);
});
