// A BAD NIGHT'S RED STOPS ARE ALL TEXTED — THE PER-SWEEP CAP PACES THE QUEUE, IT DOES NOT CUT IT.
//
// SMS_PER_SWEEP_CAP is documented as a drain rate: "worst-first; the rest wait for the next
// pass", and since the five-minute tick "a row the cap defers is texted five minutes later".
// It was applied BEFORE the claim check, so every sweep re-selected the same top 24 rows,
// found them all claimed and sent nothing — and the stops ranked below them were never texted
// at all while the top ones stayed on the board. A second defect in the same arithmetic let
// trailer conflicts backfill into the box-truck reservation, so 9+ trailer routes beside a
// full hours list left the box-truck route with no slot, contradicting "a bad night of one
// cannot silence the other two".
//
// FLAG_SMS_CAP_SKIPS_TEXTED=off puts both back exactly as they were.
//
// Synthetic stops and 555-01xx numbers only. No network: the fake throws on anything that is
// not Firestore or the intercepted SimpleTexting endpoint.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { normalizeMatchKey } from '../src/lib/matchKey.js';
import {
  selectTextable, smsCapSkipsTextedEnabled, SMS_PER_SWEEP_CAP, TRAILER_SMS_CAP, BOX_SMS_CAP,
} from '../netlify/functions/lib/flag-sms.mts';

const hRow = (i) => ({ rule: 'hours_risk', tier: 'critical', scope: 'occurrence', stopNbr: `S${i}`, closeMin: 600, lateBy: 300 - i, etaMin: 900 - i });
const tRow = (i) => ({ rule: 'trailer_conflict', tier: 'red', scope: 'occurrence', stopNbr: `T${i}`, routeKey: `TR${String(i).padStart(2, '0')}`, routeConflicts: 1, blockers: ['no_tractor_trailer'] });
const bRow = (i) => ({ rule: 'box_truck_conflict', tier: 'red', scope: 'occurrence', stopNbr: `B${i}`, routeKey: `BOX${i}`, routeConflicts: 1, handling: ['hydraulic stacker'] });

test('thirty red stops on one night are all texted within two sweeps, worst first', () => {
  const rows = Array.from({ length: 30 }, (_, i) => hRow(i));
  const texted = new Set();
  const sweep = () => {
    const picked = selectTextable(rows, SMS_PER_SWEEP_CAP, TRAILER_SMS_CAP, BOX_SMS_CAP, { skip: (r) => texted.has(r.stopNbr), env: {} });
    for (const r of picked) texted.add(r.stopNbr);
    return picked.map((r) => r.stopNbr);
  };
  const first = sweep();
  assert.equal(first.length, SMS_PER_SWEEP_CAP, 'the cap still paces the first sweep');
  assert.deepEqual(first, rows.slice(0, SMS_PER_SWEEP_CAP).map((r) => r.stopNbr), 'worst first');
  assert.deepEqual(sweep(), ['S24', 'S25', 'S26', 'S27', 'S28', 'S29'], 'the next sweep takes the ones the cap deferred');
  assert.deepEqual(sweep(), [], 'and then there is nothing left to send');
  assert.equal(texted.size, 30);
});

test('twenty-four trailer routes beside a full hours list still leave the box-truck route its reserved slot', () => {
  const rows = [
    ...Array.from({ length: 24 }, (_, i) => tRow(i)),
    ...Array.from({ length: 15 }, (_, i) => hRow(i)),
    bRow(1),
  ];
  const picked = selectTextable(rows, SMS_PER_SWEEP_CAP, TRAILER_SMS_CAP, BOX_SMS_CAP, { env: {} });
  assert.equal(picked.length, SMS_PER_SWEEP_CAP);
  assert.equal(picked.filter((r) => r.rule === 'box_truck_conflict').length, 1, 'the box truck is not silenced');
  assert.equal(picked.filter((r) => r.rule === 'trailer_conflict').length, TRAILER_SMS_CAP);
  assert.equal(picked.filter((r) => r.rule === 'hours_risk').length, 15);
});

test('FLAG_SMS_CAP_SKIPS_TEXTED=off puts back the cap over every row and the old backfill', () => {
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' Off ']) assert.equal(smsCapSkipsTextedEnabled({ FLAG_SMS_CAP_SKIPS_TEXTED: v }), false, v);
  for (const v of [undefined, '', 'on', 'offf', 'yes', '1']) assert.equal(smsCapSkipsTextedEnabled({ FLAG_SMS_CAP_SKIPS_TEXTED: v }), true, String(v));
  const off = { FLAG_SMS_CAP_SKIPS_TEXTED: 'off' };
  const rows = Array.from({ length: 30 }, (_, i) => hRow(i));
  const all = new Set(rows.slice(0, 24).map((r) => r.stopNbr));
  assert.equal(
    selectTextable(rows, SMS_PER_SWEEP_CAP, TRAILER_SMS_CAP, BOX_SMS_CAP, { skip: (r) => all.has(r.stopNbr), env: off }).length,
    SMS_PER_SWEEP_CAP, 'off: the skip is ignored and the same top 24 come back',
  );
  const mixed = [...Array.from({ length: 24 }, (_, i) => tRow(i)), ...Array.from({ length: 15 }, (_, i) => hRow(i)), bRow(1)];
  assert.equal(
    selectTextable(mixed, SMS_PER_SWEEP_CAP, TRAILER_SMS_CAP, BOX_SMS_CAP, { env: off }).filter((r) => r.rule === 'box_truck_conflict').length,
    0, 'off: the old arithmetic, trailer backfill into the box slot',
  );
});

// ── THE REAL EVENING SWEEP ───────────────────────────────────────────────────

const DATE = '2026-09-01';                    // the board being built tonight
const NOW = '2026-09-01T01:30:00Z';           // 9:30pm EDT on Aug 31: the evening window
const boardPath = `nuvizz_stop_index/davis__${DATE}`;

// Thirty one-stop routes, each an hour's drive out against a typed 5:00a close — thirty
// critical rows on tomorrow's board.
const stop = (i) => ({
  stopNbr: `S${i}`, businessName: `CUST ${i}`, addr1: `${i} MAIN ST`, city: 'GAINESVILLE', zip: '30501',
  loadNbr: `R${i}`, routeName: `R${i}`, routeSeq: 1, stopType: 'DL',
  lat: 34.147791 + 0.5 + i * 0.01, lng: -83.960911,
  normalizedStatus: 'PLANNED', status: '10', driverName: `DRIVER ${i}`, driverUserName: `d${i}`,
});
const keyOf = (s) => normalizeMatchKey(s.businessName, s.addr1, s.city, s.zip);

test('the evening sweep texts every one of thirty critical stops by its second pass, and not one twice', async () => {
  process.env.SIMPLETEXTING_API_KEY = 'test-key';
  process.env.FLAG_SMS_TO = '6785550101';
  delete process.env.FLAG_SMS_TO_NIGHT;
  delete process.env.RESEND_API_KEY;
  const seed = { [boardPath]: { last_scanned_at: '2026-09-01T01:25:00Z' } };
  for (let i = 0; i < 30; i += 1) {
    const s = stop(i);
    seed[`${boardPath}/stops/${s.stopNbr}`] = s;
    seed[`customer_notes/${keyOf(s)}`] = {
      receiving_hours: { tue: { open: '04:00', close: '05:00' } },
      manual_overrides: { receiving_hours: true },
    };
  }
  const texts = [];
  mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const fake = installFirestoreFake(seed, async (url, init) => {
    if (url.includes('simpletexting.com')) {
      texts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: `t${texts.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  try {
    const { default: handler } = await import('../netlify/functions/eta-flag-evening-background.mts');
    const run = async () => (await handler(new Request('https://example.test/.netlify/functions/eta-flag-evening-background'))).json();
    const textedStops = () => new Set(texts.map((t) => (/CUST (\d+)/.exec(t.text) || [])[1]).filter(Boolean));

    const first = await run();
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.sent, SMS_PER_SWEEP_CAP, 'THE FIXTURE IS THE CASE: the cap bites on the first sweep');
    assert.equal(textedStops().size, SMS_PER_SWEEP_CAP);

    const second = await run();
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.sent, 6, 'the six the cap deferred go out on the next pass');
    assert.equal(second.alreadyClaimed, SMS_PER_SWEEP_CAP, 'the status doc says why the other 24 were not sent again');
    assert.equal(textedStops().size, 30, 'every critical stop on the board has been texted');

    const third = await run();
    assert.equal(third.sent, 0, 'and nothing is ever texted twice');
    assert.equal(texts.length, 30);
  } finally {
    fake.restore();
    mock.timers.reset();
    delete process.env.SIMPLETEXTING_API_KEY;
    delete process.env.FLAG_SMS_TO;
  }
});
