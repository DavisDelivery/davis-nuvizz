// test/flag-tier-ratchet.test.mjs
//
// A FLAG DOES NOT GET QUIETER BECAUSE THE MODEL GOT LESS SURE.
//
// Chad, on RAICOM LLC at stop 10 of KOSTNER — the route card still predicting 12:33p against
// a 12:00p close, the flags panel now reading "0 red · 5 advisory": "you took the Raicom flag
// away but eta on route still shows 12:30, that doesn't work for me. The flag should remain
// unless our updated eta is showing we will get there in time."
//
// It had not been taken away — it had been DEMOTED. Red at 45 minutes late, amber at 33,
// because severity is the overrun measured against the model's own error band and the band
// six hops down a chain is 40 minutes. Nothing about the stop improved. The board just got
// calmer while the freight sat in exactly the same trouble.
//
// So severity ratchets: promote freely, never demote, and the only thing that clears a row
// is the estimate coming back inside the window — at which point there is no row at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBoardFlags, worstOfTiers, tierFloorLookup } from '../src/lib/board-flags.js';

const DEPOT = { lat: 34.147791, lng: -83.960911 };
const DATE = '2026-08-20', DAYKEY = 'thu';
const OPTS = { depot: DEPOT, departMin: 8 * 60 };

// A long route so the target stop is far enough down the chain to sit in the wide band.
const mkStop = (n, over = {}) => ({
  stopNbr: `70${String(n).padStart(3, '0')}`, stopType: 'DO',
  loadNbr: 'KOSTNER', routeName: 'KOSTNER', routeSeq: n,
  businessName: `CUST ${n}`, matchKey: `cust${n}|k`, driverName: 'Anthony Kostner',
  normalizedStatus: 'SCHEDULED', status: '20', isPlanned: true,
  lat: 34.147791 + n * 0.045, lng: -83.960911, ...over,
});
const RAICOM = 'RAICOM-10';

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const STOPS = 10;
const deck = () => {
  const rows = Array.from({ length: STOPS }, (_, i) => mkStop(i + 1));
  rows[STOPS - 1] = mkStop(STOPS, { stopNbr: RAICOM, businessName: 'RAICOM LLC', matchKey: 'raicom|k' });
  return rows;
};
const judge = (rows, closeMin, floor) => computeBoardFlags({
  stops: rows,
  notes: new Map([['raicom|k', { receiving_hours: { [DAYKEY]: { open: '07:00', close: hhmm(closeMin) } } }]]),
  servedDate: DATE, dayKey: DAYKEY,
  opts: { ...OPTS, ...(floor ? { tierFloorByStop: floor } : {}) },
}).rows.filter((r) => r.rule === 'hours_risk' && r.stopNbr === RAICOM);

// What the walk actually predicts for the last stop, read once so the fixtures below can be
// written as "half an hour past the close" rather than as a guessed clock time that quietly
// stops being late the day the travel model is recalibrated.
const RAICOM_ETA = (() => {
  // 7:30a, just after the 7:00a open — a 10-stop route leaving at 8:00a cannot be there,
  // so a row is guaranteed. (A close BEFORE the open reads as an overnight dock and the
  // parser correctly refuses it, which is why the probe is not simply 00:01.)
  const probe = judge(deck(), 7 * 60 + 30, null);
  if (!probe.length) throw new Error('fixture never produced a row');
  return probe[0].etaMin;
})();
const LATE_BY = 33;                        // the real RAICOM overrun, inside the error band
function board({ closeMin = RAICOM_ETA - LATE_BY, floor = null } = {}) {
  return judge(deck(), closeMin, floor);
}

test('THE RAICOM CASE: a row that was red today does not slide back to advisory', () => {
  const onItsOwn = board();
  assert.equal(onItsOwn.length, 1, 'the stop is predicted past its close either way');
  assert.equal(onItsOwn[0].tier, 'amber', 'the model alone calls a modest overrun advisory');

  const held = board({ floor: { [RAICOM]: 'red' } });
  assert.equal(held.length, 1);
  assert.equal(held[0].tier, 'red', 'having been red today, it stays red');
  assert.equal(held[0].computedTier, 'amber', 'what the model said on its own is still reported');
  assert.equal(held[0].tierHeld, true);
  assert.match(held[0].detail, /Flagged earlier today — stays red while the estimate is past the close/);
});

test('THE ONLY EXIT: an estimate back inside the window clears it, floor or no floor', () => {
  // Chad's own condition — "unless our updated eta is showing we will get there in time."
  // A late close the truck comfortably makes produces NO ROW, so a red floor has nothing
  // to hold up. This is what stops the ratchet becoming a flag that can never be cleared.
  const cleared = board({ closeMin: RAICOM_ETA + 60, floor: { [RAICOM]: 'critical' } });
  assert.equal(cleared.length, 0, 'on time is on time — the flag is gone, not held');
});

test('the ratchet promotes but never demotes', () => {
  // A floor BELOW what this sweep computed must not drag a worsening row down.
  const worse = board({ closeMin: 7 * 60 + 30, floor: { [RAICOM]: 'amber' } });
  assert.equal(worse.length, 1);
  assert.ok(['red', 'critical'].includes(worse[0].tier), 'a badly late stop is not capped at amber');
  assert.equal(worse[0].tierHeld, false, 'nothing was held — the model was already worse');
});

test('a floor for a DIFFERENT stop cannot colour this one', () => {
  const rows = board({ floor: { 'SOMEONE-ELSE': 'critical' } });
  assert.equal(rows[0].tier, 'amber');
  assert.equal(rows[0].tierHeld, false);
});

test('the floor never invents a flag — it only holds one the walk produced', () => {
  // No receiving hours on file at all: no row exists, so a critical floor has nothing to
  // attach to. A ratchet that could resurrect a row would be a flag nobody can ever clear.
  const out = computeBoardFlags({
    stops: Array.from({ length: 10 }, (_, i) => mkStop(i + 1)),
    notes: new Map(), servedDate: DATE, dayKey: DAYKEY,
    opts: { ...OPTS, tierFloorByStop: { '70010': 'critical', [RAICOM]: 'critical' } },
  }).rows.filter((r) => r.rule === 'hours_risk');
  assert.equal(out.length, 0);
});

test('a finished stop stays finished — the floor cannot re-flag delivered freight', () => {
  const rows = Array.from({ length: 10 }, (_, i) => mkStop(i + 1));
  rows[9] = mkStop(10, {
    stopNbr: RAICOM, businessName: 'RAICOM LLC', matchKey: 'raicom|k',
    normalizedStatus: 'DELIVERED', deliveredDTTM: `${DATE}T12:33:00`,
  });
  const notes = new Map([['raicom|k', { receiving_hours: { [DAYKEY]: { open: '07:00', close: '12:00' } } }]]);
  const out = computeBoardFlags({
    stops: rows, notes, servedDate: DATE, dayKey: DAYKEY,
    opts: { ...OPTS, tierFloorByStop: { [RAICOM]: 'critical' } },
  }).rows.filter((r) => r.rule === 'hours_risk' && r.stopNbr === RAICOM);
  assert.equal(out.length, 0, 'it has already been delivered — there is no deadline left to miss');
});

// ── the lookup itself ────────────────────────────────────────────────────────

test('tierFloorLookup takes an object, a Map or a function, and refuses junk', () => {
  assert.equal(tierFloorLookup({ A: 'red' })('A'), 'red');
  assert.equal(tierFloorLookup(new Map([['A', 'critical']]))('A'), 'critical');
  assert.equal(tierFloorLookup((k) => (k === 'A' ? 'amber' : null))('A'), 'amber');
  assert.equal(tierFloorLookup({ A: 'RED' })('A'), 'red', 'case-insensitive');
  assert.equal(tierFloorLookup({ A: 'purple' })('A'), null, 'an unknown tier is no floor');
  assert.equal(tierFloorLookup({ A: null })('A'), null);
  assert.equal(tierFloorLookup(null)('A'), null);
  assert.equal(tierFloorLookup(undefined)('A'), null);
  assert.equal(tierFloorLookup('nonsense')('A'), null);
});

test('worstOfTiers is a max over the ladder, not a last-write', () => {
  assert.equal(worstOfTiers('amber', 'red'), 'red');
  assert.equal(worstOfTiers('red', 'amber'), 'red');
  assert.equal(worstOfTiers('red', 'critical'), 'critical');
  assert.equal(worstOfTiers('critical', 'red'), 'critical');
  assert.equal(worstOfTiers('amber', null), 'amber');
  assert.equal(worstOfTiers('amber', 'bogus'), 'amber');
});
