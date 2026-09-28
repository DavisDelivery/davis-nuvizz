// test/scan-press-superseded.test.mjs
//
// AN OLDER SCAN PRESS STOPPED A NEWER ONE'S SPINNER (audit 2026-09-27, app-A1-7).
//
// "Scan now" keeps the button busy for SCAN_SPINNER_SEC (80s), then frees it with an honest
// "still running" sentence while it keeps polling quietly for up to SCAN_POLL_WINDOW_SEC (195s).
// Freeing it is deliberate — a dispatcher may press again. But when the FIRST press's window
// ran out it still wrote its own answer to the shared button state: its verdict sentence, the
// 60s cooldown, and — in `finally` — scanning=false. If the dispatcher had pressed again in
// between, that stopped the second press's spinner and replaced its message while the second
// press was still waiting on its own scan, so the button no longer described the scan that was
// actually running.
//
// What happens now: each press carries a token, and a press that has been superseded by a newer
// one stops polling and leaves the button alone; only the newest press speaks.
//
// This RUNS the real useManualScan out of App.jsx against a minimal hooks stand-in, a hand-driven
// clock and hand-resolved polls. No network: apiFetch and fetchJsonWithRetry are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanPressVerdict, SCAN_POLL_WINDOW_SEC, SCAN_SPINNER_SEC } from '../src/lib/scan-press-verdict.js';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnOnly(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
function constLine(name) {
  const start = APP.indexOf(`const ${name} = `);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  return APP.slice(start, APP.indexOf('\n', start));
}

function harness() {
  const slots = [];
  let i = 0;
  const state = {};
  const useState = (init) => {
    const k = i++;
    if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init };
    const s = slots[k];
    return [s.v, (v) => { s.v = typeof v === 'function' ? v(s.v) : v; }];
  };
  const useRef = (v) => { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; };
  const useCallback = (fn) => fn;
  const useRoleGate = () => ({ allowed: true, reason: null });
  let clock = 0;
  const FakeDate = { now: () => clock };
  // The 3s poll sleep resolves at once; message-clear and cooldown-reset timers never fire here.
  const fakeSetTimeout = (fn, ms) => { if (ms === 3000) Promise.resolve().then(fn); return 0; };
  const polls = [];
  const fetchJsonWithRetry = () => new Promise((resolve) => polls.push(resolve));
  const apiFetch = async () => ({ ok: true, status: 202 });
  let refreshes = 0;
  const refresh = async () => { refreshes += 1; };

  const src = [constLine('SCAN_REFUSAL_FRESH_MIN'), fnOnly('scanRefusalIsThisPress'), fnOnly('useManualScan')].join('\n');
  const useManualScan = new Function(
    'useState', 'useRef', 'useCallback', 'useRoleGate', 'apiFetch', 'fetchJsonWithRetry',
    'scanPressVerdict', 'SCAN_POLL_WINDOW_SEC', 'SCAN_SPINNER_SEC', 'setTimeout', 'Date',
    `${src}\nreturn useManualScan;`,
  )(useState, useRef, useCallback, useRoleGate, apiFetch, fetchJsonWithRetry, scanPressVerdict, SCAN_POLL_WINDOW_SEC, SCAN_SPINNER_SEC, fakeSetTimeout, FakeDate);

  const render = () => { i = 0; return useManualScan('2026-09-28', 'scan-T0', refresh); };
  return {
    render,
    polls,
    setClock: (ms) => { clock = ms; },
    view: () => { const h = render(); return { scanning: h.scanning, scanCooldown: h.scanCooldown, scanErr: h.scanErr }; },
    refreshes: () => refreshes,
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test('a dispatcher who presses Scan again after the spinner frees keeps the newer press\'s spinner until ITS scan answers', async () => {
  const h = harness();

  // Press 1 at t=0.
  const p1 = h.render().manualScan();
  await flush();
  assert.equal(h.view().scanning, true);
  assert.equal(h.polls.length, 1);

  // t=81s: the scan is still running, so press 1 frees the button with an honest sentence.
  h.setClock(81_000);
  h.polls.shift()({ lastScannedAt: 'scan-T0', scanRun: { startedAgeSec: 81, finished: false } });
  await flush();
  assert.equal(h.view().scanning, false, 'past SCAN_SPINNER_SEC the button is freed');
  assert.match(h.view().scanErr, /still running/);
  assert.equal(h.polls.length, 1, 'press 1 keeps polling quietly');

  // t=150s: the dispatcher presses again.
  h.setClock(150_000);
  const p2 = h.render().manualScan();
  await flush();
  assert.equal(h.view().scanning, true, 'press 2 spins');
  assert.equal(h.polls.length, 2, 'press 1 and press 2 each have a poll out');

  // t=196s: press 1's window runs out while press 2 has waited only 46s.
  h.setClock(196_000);
  h.polls.shift()({ lastScannedAt: 'scan-T0', scanRun: { startedAgeSec: 46, finished: false } });
  await flush();
  await p1;
  const mid = h.view();
  assert.equal(mid.scanning, true, 'press 1 ending must not stop press 2\'s spinner');
  assert.equal(mid.scanCooldown, false, 'press 1 ending must not put the button on cooldown under press 2');
  assert.equal(mid.scanErr, null, 'press 1 ending must not write its sentence over press 2');

  // t=200s: press 2's scan lands.
  h.setClock(200_000);
  h.polls.shift()({ lastScannedAt: 'scan-T1', scanRun: { startedAgeSec: 50, finished: true, outcome: 'ok' } });
  await flush();
  await p2;
  const end = h.view();
  assert.equal(end.scanning, false);
  assert.equal(end.scanCooldown, true, 'the newest press sets the cooldown when it answers');
  assert.equal(end.scanErr, null, 'landed says nothing — the board already shows it');
  assert.equal(h.polls.length, 0, 'nobody is still polling');
});

test('a single press that lands still spins, answers and cools down exactly as before', async () => {
  const h = harness();
  const p = h.render().manualScan();
  await flush();
  assert.equal(h.view().scanning, true);
  h.setClock(45_000);
  h.polls.shift()({ lastScannedAt: 'scan-T1', scanRun: { startedAgeSec: 44, finished: true, outcome: 'ok' } });
  await p;
  assert.deepEqual(h.view(), { scanning: false, scanCooldown: true, scanErr: null });
  assert.equal(h.refreshes(), 1, 'the board is re-read once the scan lands');
});
