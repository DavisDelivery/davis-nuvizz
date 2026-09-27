// 6:00-6:59a ON A WINTER WEEKDAY, BOTH FLAG SWEEPS HOLD TODAY'S BOARD — ONLY ONE MAY WRITE ITS HISTORY.
//
// The day sweep's cron is '*/5 11-23 * * 1-5' (UTC) and the evening sweep's '*/5 0-11 * * *'.
// In EST, 11:00-11:59 UTC is 6:00-6:59a, the evening sweep still judges TODAY until 6:59a, and
// both fire on the same twelve ticks. Each reads eta_flag_history/<today>, merges its own
// sweep into it and writes the WHOLE document back. When the evening sweep read before the
// day sweep wrote and wrote after it, the day sweep's `emailed: true` — the record that
// customer service was told — was replaced by the evening's stale copy, for good.
//
// On those ticks the day sweep now owns the document and the evening sweep leaves it alone.
// Texts and emails are untouched; only who writes the history changes, for that hour.
// EVENING_HISTORY_YIELDS_TO_DAY=off puts the evening write back.
//
// Real handlers over the in-memory Firestore fake, Resend intercepted; no network.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { normalizeMatchKey } from '../src/lib/matchKey.js';
import { flagHistoryPath } from '../netlify/functions/lib/flag-history.mts';
import { daySweepFiresNow, eveningHistoryYieldsEnabled } from '../netlify/functions/lib/flag-sweep-cadence.mts';

const DATE = '2026-01-06';                    // a Tuesday in January (EST)
const NOW = '2026-01-06T11:05:00Z';           // 6:05a EST — both sweeps fire on this tick
const boardPath = `nuvizz_stop_index/davis__${DATE}`;
const HIST = flagHistoryPath('davis', DATE);

const routeStop = (i) => ({
  stopNbr: `S${i}`, businessName: `CUST ${i}`, addr1: `${i} MAIN ST`, city: 'BUFORD', zip: '30518',
  loadNbr: 'TESTLOAD', routeName: 'TESTLOAD', routeSeq: i, stopType: 'DL',
  lat: 34.147791 + i * 0.08, lng: -83.960911,
  normalizedStatus: 'PLANNED', status: '10', driverName: 'TEST DRIVER', driverUserName: 'tdriver',
});
const keyOf = (s) => normalizeMatchKey(s.businessName, s.addr1, s.city, s.zip);
function seed() {
  const out = { [boardPath]: { last_scanned_at: '2026-01-06T11:00:00Z' } };
  for (let i = 1; i <= 10; i += 1) out[`${boardPath}/stops/S${i}`] = routeStop(i);
  // Stop 9 projects over three hours past an 8:45a typed close: critical, and emailed.
  out[`customer_notes/${keyOf(routeStop(9))}`] = {
    receiving_hours: { tue: { open: '07:00', close: '08:45' } },
    manual_overrides: { receiving_hours: true },
  };
  return out;
}

test('the day sweep fires on 6:05a EST weekday ticks and not otherwise', () => {
  assert.equal(daySweepFiresNow(new Date('2026-01-06T11:05:00Z'), 365, {}), true, 'Tue 6:05a EST');
  assert.equal(daySweepFiresNow(new Date('2026-01-06T10:55:00Z'), 355, {}), false, '5:55a EST is before its cron');
  assert.equal(daySweepFiresNow(new Date('2026-01-10T11:05:00Z'), 365, {}), false, 'Saturday');
  assert.equal(daySweepFiresNow(new Date('2026-01-11T11:05:00Z'), 365, {}), false, 'Sunday');
  // On the twenty-minute revert cadence the day sweep only works the first tick of each step.
  assert.equal(daySweepFiresNow(new Date('2026-01-06T11:05:00Z'), 365, { FLAG_SWEEP_EVERY_TICK: 'off' }), false);
  assert.equal(daySweepFiresNow(new Date('2026-01-06T11:00:00Z'), 360, { FLAG_SWEEP_EVERY_TICK: 'off' }), true);
});

test('EVENING_HISTORY_YIELDS_TO_DAY is house shape: default on, off-words off, a typo leaves it on', () => {
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' Off ']) assert.equal(eveningHistoryYieldsEnabled({ EVENING_HISTORY_YIELDS_TO_DAY: v }), false, v);
  for (const v of [undefined, '', 'on', 'offf', 'yes', '1']) assert.equal(eveningHistoryYieldsEnabled({ EVENING_HISTORY_YIELDS_TO_DAY: v }), true, String(v));
});

test('THE DAY SWEEP\'S CRON IS WHAT THE PREDICATE ASSUMES — if it moves, this fails and says why', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../netlify/functions/eta-flag-alert-background.mts', import.meta.url), 'utf8');
  assert.match(src, /export const config = \{ schedule: '\*\/5 11-23 \* \* 1-5' \}/,
    'daySweepFiresNow mirrors this schedule; change them together');
});

async function raceAt6_05(env = {}) {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_FROM = 'Dispatch <no-reply@example.com>';
  delete process.env.SIMPLETEXTING_API_KEY;
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const mail = [];
  mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const fake = installFirestoreFake(seed(), async (url, init) => {
    if (url.startsWith('https://api.resend.com/')) {
      mail.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: `m${mail.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  const fakeFetch = globalThis.fetch;
  let staleHistoryRead = false;
  // THE INTERLEAVE, made deterministic: the evening sweep's read of today's history happened
  // BEFORE the day sweep wrote it (there was no document yet), and its write lands after.
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = String(init.method || 'GET').toUpperCase();
    if (staleHistoryRead && method === 'GET' && url.includes(`/documents/${HIST}`)) return new Response('{}', { status: 404 });
    return fakeFetch(input, init);
  };
  try {
    const { default: day } = await import('../netlify/functions/eta-flag-alert-background.mts');
    const { default: evening } = await import('../netlify/functions/eta-flag-evening-background.mts');
    const dayBody = await (await day(new Request('https://example.test/.netlify/functions/eta-flag-alert-background'))).json();
    assert.equal(dayBody.ok, true, JSON.stringify(dayBody));
    assert.equal(mail.filter((m) => /Receiving window at risk/i.test(String(m.subject))).length, 1, 'THE FIXTURE IS THE CASE: CS was emailed');
    const afterDay = Object.values(fake.store.get(HIST)?.rows || {}).find((r) => r.stopNbr === 'S9');
    assert.equal(afterDay?.emailed, true, 'the day sweep recorded it');

    staleHistoryRead = true;
    const eveBody = await (await evening(new Request('https://example.test/.netlify/functions/eta-flag-evening-background'))).json();
    assert.equal(eveBody.ok, true, JSON.stringify(eveBody));
    assert.equal(eveBody.date, DATE, 'the evening sweep is judging today at 6:05a EST');
    return { final: Object.values(fake.store.get(HIST)?.rows || {}).find((r) => r.stopNbr === 'S9'), eveBody };
  } finally {
    globalThis.fetch = fakeFetch;
    fake.restore();
    mock.timers.reset();
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('at 6:05a on a winter weekday the evening sweep cannot erase the record that customer service was emailed', async () => {
  const { final, eveBody } = await raceAt6_05();
  assert.equal(final?.emailed, true, 'Emailed CS survives the overlap');
  assert.match(String(eveBody.historySkipped || ''), /day sweep/, 'and the evening status says why it did not write');
});

test('EVENING_HISTORY_YIELDS_TO_DAY=off puts the evening write back, race and all', async () => {
  const { final, eveBody } = await raceAt6_05({ EVENING_HISTORY_YIELDS_TO_DAY: 'off' });
  assert.equal(eveBody.historySkipped, undefined);
  assert.equal(final?.emailed, false, 'the old behaviour: the stale evening write replaced the day sweep\'s record');
});
