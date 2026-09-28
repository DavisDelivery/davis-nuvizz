// A BOX TRUCK CARRYING STACKERS AT TWO DOCKS IS TEXTED ONCE FOR THE LOAD, NOT ONCE PER DOCK.
//
// smsClaimPath's box branch says a box-truck conflict claims the ROUTE — one message per load
// per board day — so that "fix one of three stacker stops and the next sweep texts about the
// second" cannot happen. The only caller passed the STOP number instead (the route was used
// only for trailer_conflict), so the claim became route_<stopNbr>__box: board-flags emits one
// R4b row per dock, selectTextable keeps the first per route, and when that dock was moved off
// the box the next sweep picked the next dock's row, found a fresh claim key and texted the
// whole list again about the same load.
//
// FLAG_SMS_BOX_CLAIM_BY_ROUTE=off puts the old per-stop key back.
//
// Synthetic stops and 555-01xx numbers only. No network: the fake throws on anything that is
// not Firestore or the intercepted SimpleTexting endpoint.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { computeBoardFlags } from '../src/lib/board-flags.js';
import {
  selectTextable, smsClaimPath, smsClaimSubject, boxClaimByRouteEnabled,
} from '../netlify/functions/lib/flag-sms.mts';

const DATE = '2026-09-01';                    // the board being built tonight
const NOW = '2026-09-01T01:30:00Z';           // 9:30pm EDT on Aug 31: the evening window
const boardPath = `nuvizz_stop_index/davis__${DATE}`;
const DEPOT = { lat: 34.147791, lng: -83.960911 };

const stackerStop = (stopNbr, businessName, addr1, over = {}) => ({
  stopNbr, primaryPro: stopNbr, pro: stopNbr, businessName, addr1, city: 'DALLAS', zip: '30132',
  lat: 34.10, lng: -84.00, normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  loadNbr: 'MICHAEL FRYE', routeName: 'MICHAEL FRYE', driverName: 'Michael Frye', stopType: 'DO',
  orderInstructions: 'ORDER CONTAINS HYDRAULIC STACKER', ...over,
});
const dockA = stackerStop('007180089', 'WEST RIDGE CHURCH', '1 RIDGE RD', { routeSeq: 3, matchKey: 'a' });
const dockB = stackerStop('007180200', 'ACME SUPPLY', '9 MILL ST', { routeSeq: 7, matchKey: 'b' });

const boxRow = (stops) => selectTextable(computeBoardFlags({
  stops, notes: new Map(), rosterRows: [], servedDate: DATE, dayKey: 'tue',
  opts: { depot: DEPOT, departMin: 8 * 60, travel: { legs: {}, routeClasses: { 'MICHAEL FRYE': 'box', 'TRACTOR 9': 'tractor' } } },
}).rows).find((r) => r.rule === 'box_truck_conflict');

test('moving one stacker dock off a box truck does not earn the same load a second claim', () => {
  const first = boxRow([dockA, dockB]);
  const second = boxRow([{ ...dockA, loadNbr: 'TRACTOR 9', routeName: 'TRACTOR 9' }, dockB]);
  assert.ok(first && second, 'both boards carry a box-truck row for MICHAEL FRYE');
  assert.notEqual(first.stopNbr, second.stopNbr, 'THE FIXTURE IS THE CASE: the kept row moved to the other dock');
  const key = (r, env) => smsClaimPath('davis', DATE, smsClaimSubject(r, env), r.rule);
  assert.equal(key(first, {}), key(second, {}), 'one claim for the load, whichever dock carries the row');
  assert.match(key(first, {}), /route_MICHAEL_FRYE__box$/);
});

test('FLAG_SMS_BOX_CLAIM_BY_ROUTE=off puts the per-stop claim back, and a typo leaves the route claim on', () => {
  const row = boxRow([dockA, dockB]);
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' Off ']) {
    assert.equal(boxClaimByRouteEnabled({ FLAG_SMS_BOX_CLAIM_BY_ROUTE: v }), false, v);
    assert.equal(smsClaimSubject(row, { FLAG_SMS_BOX_CLAIM_BY_ROUTE: v }), String(row.stopNbr));
  }
  for (const v of [undefined, '', 'on', 'offf', 'yes', '1']) {
    assert.equal(boxClaimByRouteEnabled({ FLAG_SMS_BOX_CLAIM_BY_ROUTE: v }), true, String(v));
  }
  // The other rules are untouched by the switch.
  const hours = { rule: 'hours_risk', stopNbr: 'S1', routeKey: 'R1' };
  const trailer = { rule: 'trailer_conflict', stopNbr: 'S2', routeKey: 'T1' };
  for (const env of [{}, { FLAG_SMS_BOX_CLAIM_BY_ROUTE: 'off' }]) {
    assert.equal(smsClaimSubject(hours, env), 'S1');
    assert.equal(smsClaimSubject(trailer, env), 'T1');
  }
});

test('the evening sweep texts a box truck with stackers at two docks once, even after one dock is moved to a tractor', async () => {
  process.env.SIMPLETEXTING_API_KEY = 'test-key';
  process.env.FLAG_SMS_TO = '6785550101';
  delete process.env.FLAG_SMS_TO_NIGHT;
  delete process.env.RESEND_API_KEY;          // the stacker email is another test's business
  const texts = [];
  const seed = {
    [boardPath]: { last_scanned_at: '2026-09-01T01:25:00Z' },
    [`${boardPath}/stops/${dockA.stopNbr}`]: dockA,
    [`${boardPath}/stops/${dockB.stopNbr}`]: dockB,
    [`nuvizzFleet/davis__${DATE}/loads/MF`]: { loadNbr: 'MICHAEL FRYE', routeName: 'MICHAEL FRYE', vehicleType: '26ft Box Truck' },
    [`nuvizzFleet/davis__${DATE}/loads/T9`]: { loadNbr: 'TRACTOR 9', routeName: 'TRACTOR 9', vehicleType: '53ft Trailer' },
  };
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

    const first = await run();
    assert.equal(first.ok, true, JSON.stringify(first));
    const boxTexts1 = texts.filter((t) => /runs a box truck/.test(t.text));
    assert.equal(boxTexts1.length, 1, 'the first sweep texts the load');
    const boxEntry = first.texted.find((t) => t.rule === 'box_truck_conflict');
    assert.equal(boxEntry.routeName, 'MICHAEL FRYE', 'the status doc names the load it texted about');

    // The router moves dock A's order onto a tractor.
    fake.store.set(`${boardPath}/stops/${dockA.stopNbr}`, { ...dockA, loadNbr: 'TRACTOR 9', routeName: 'TRACTOR 9' });
    const second = await run();
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(boxRow([{ ...dockA, loadNbr: 'TRACTOR 9', routeName: 'TRACTOR 9' }, dockB])?.stopNbr, dockB.stopNbr,
      'dock B is still on the box truck and still flagged');
    const boxTexts2 = texts.filter((t) => /runs a box truck/.test(t.text));
    assert.equal(boxTexts2.length, 1, `one box-truck text for the load all night, got: ${boxTexts2.map((t) => t.text).join(' | ')}`);
    assert.equal(second.alreadyClaimed, 1);
  } finally {
    fake.restore();
    mock.timers.reset();
    delete process.env.SIMPLETEXTING_API_KEY;
    delete process.env.FLAG_SMS_TO;
  }
});
