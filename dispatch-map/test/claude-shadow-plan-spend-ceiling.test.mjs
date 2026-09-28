// test/claude-shadow-plan-spend-ceiling.test.mjs — THE PLAN CONFIRM STATES THE $ CEILING IN FORCE.
//
// Audit 2026-09-27 (shadow-frontend-2): with no plan running, the dispatcher opens Router settings in
// the Backtest panel, raises "Most $ per day" from 5 to 20 and saves. Up in "Plan a day" the button
// still read "Plan with Claude (≤ $5.00)" and the confirm said "It spends at most $5.00" — but the
// server snapshots the settings at queue time, so the job was held to $20. The planning area's copy of
// the settings was read on mount and only re-read while a job ran.
//
// What happens now: the settings are read again before the confirm says what a plan may spend (and a
// plan is not queued when they cannot be read); the "Queued" line states the ceiling the server
// actually held the job to; and a Router settings save on this screen refreshes the planning area,
// on both views, so the button label moves with it.
//
// These RUN the real usePlans hook out of PlanPanel.jsx (compiled with the repo's esbuild) against a
// minimal hooks stand-in and a fake claude-shadow endpoint. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const PANEL = readFileSync(new URL('../src/shadow/PlanPanel.jsx', import.meta.url), 'utf8');
const SCREEN = readFileSync(new URL('../src/shadow/ClaudeShadowScreen.jsx', import.meta.url), 'utf8');
const BT = readFileSync(new URL('../src/shadow/BacktestPanel.jsx', import.meta.url), 'utf8');

function hooksRuntime() {
  const slots = [];
  let i = 0;
  const React = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init };
      const s = slots[k];
      return [s.v, (v) => { s.v = typeof v === 'function' ? v(s.v) : v; }];
    },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
  return { React, render: (fn) => { i = 0; return fn(); } };
}

function loadUsePlans(React, apiFetch, win) {
  const region = PANEL.slice(PANEL.indexOf('const ENDPOINT = '), PANEL.indexOf('// ── the parameters'));
  assert.ok(region.includes('function usePlans('), 'usePlans not found in PlanPanel.jsx');
  const code = transformSync(region, { loader: 'jsx' }).code;
  return new Function('React', 'apiFetch', 'window', `const { useState, useEffect, useCallback, useMemo, useRef } = React;\n${code}\nreturn usePlans;`)(React, apiFetch, win);
}

const resp = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
function fakeShadow() {
  const server = { maxUsd: 5, viewFails: false, plans: [], viewReads: 0, onViewRead: null };
  const apiFetch = async (url, init) => {
    if (url === '/.netlify/functions/claude-shadow?view=plans') {
      server.viewReads++;
      server.onViewRead?.();
      if (server.viewFails) return resp({ ok: false, error: 'Firestore read failed' }, 500);
      return resp({ ok: true, jobs: [], settings: { maxUsd: server.maxUsd }, ceiling: { usd: 25, spent24h: 0, holding: false } });
    }
    const body = JSON.parse(init?.body || '{}');
    if (url === '/.netlify/functions/claude-shadow' && body.action === 'plan') {
      server.plans.push(body);
      return resp({ ok: true, jobId: 'pl__2026-09-28__x', stops: 12, loads: 1, maxUsd: server.maxUsd, ahead: 0, waiting: null });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return { server, apiFetch };
}
const PARAMS = { date: '2026-09-28', picks: [{ kind: 'roster', route: '1 SATL' }] };
const PREVIEW = { boardAt: '2026-09-27T22:00:00Z', capacity: { short: { spots: 0 } } };

test('Router settings raised to $20 on the same screen: the Plan confirm says $20, not the $5 the panel read on opening', async () => {
  const { server, apiFetch } = fakeShadow();
  const said = [];
  const win = { confirm: (t) => { said.push(t); return true; } };
  const { React, render } = hooksRuntime();
  const usePlans = loadUsePlans(React, apiFetch, win);
  let h = render(() => usePlans());
  await h.load();                                   // the read on opening
  h = render(() => usePlans());
  assert.equal(h.view.settings.maxUsd, 5);
  server.maxUsd = 20;                               // saved in the Backtest panel's Router settings
  const busyDuringRead = [];
  server.onViewRead = () => busyDuringRead.push(render(() => usePlans()).busy);
  const id = await h.queue(PARAMS, PREVIEW);
  server.onViewRead = null;
  h = render(() => usePlans());
  assert.equal(busyDuringRead[0], true, 'the Plan button is already disabled while the settings are read, so a second press cannot open a second confirm');
  assert.equal(h.busy, false);
  assert.equal(id, 'pl__2026-09-28__x');
  assert.equal(said.length, 1);
  assert.match(said[0], /It spends at most \$20\.00 at the model/);
  assert.doesNotMatch(said[0], /\$5\.00/);
  assert.equal(h.view.settings.maxUsd, 20, 'the button label reads the same fresh settings');
  assert.match(h.msg, /at most \$20\.00/, 'the Queued line states the ceiling the server held the job to');
});

test('when the settings in force cannot be read, no plan is queued and the dispatcher is told why', async () => {
  const { server, apiFetch } = fakeShadow();
  const said = [];
  const win = { confirm: (t) => { said.push(t); return true; } };
  const { React, render } = hooksRuntime();
  const usePlans = loadUsePlans(React, apiFetch, win);
  let h = render(() => usePlans());
  await h.load();
  h = render(() => usePlans());
  server.viewFails = true;
  const id = await h.queue(PARAMS, PREVIEW);
  h = render(() => usePlans());
  assert.equal(id, null);
  assert.equal(said.length, 0, 'no confirm stating a ceiling nobody could read');
  assert.equal(server.plans.length, 0, 'nothing queued');
  assert.match(h.msg, /Not queued/);
  assert.match(h.msg, /could not be read/);
});

test('a Router settings save refreshes the planning area on the desktop and the phone view', () => {
  assert.match(SCREEN, /<BacktestPanel day=\{h\.day\} onSettingsSaved=\{h\.plan\.pl\.load\} \/>/, 'desktop');
  assert.match(SCREEN, /<BacktestPanel phone day=\{h\.day\} onSettingsSaved=\{h\.plan\.pl\.load\} \/>/, 'phone');
  assert.match(BT, /export default function BacktestPanel\(\{ phone, day, onSettingsSaved \}\)/);
  assert.match(BT, /if \(r\.ok\) onSettingsSaved\?\.\(\);/);
});
