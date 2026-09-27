// test/stop-lookup-prompted-call-count.test.mjs — THE PROMPTED CALL REPORTS THE CALLS IT ACTUALLY SENT.
//
// Audit 2026-09-27 (shiplify-lookup-uat-6). The prompted lookup hard-coded `nuvizzCalls = 1`.
// But lookupStopByPro goes through the shared requester, which retries a 429/5xx up to four
// more times and COUNTS every answered attempt against the daily ceiling. On a busy NuVizz one
// tap spent up to five counted calls while the reply, the header chip and the ledger all said
// one — on the one door on this screen that spends, and under a header that promises "the call
// count in the answer is what happened, not what was intended".
//
// The vendor here is the Firestore fake's `onOther`; `fake.log.other` is exactly what went out.

import crypto from 'node:crypto';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.FIREBASE_SA = JSON.stringify({
  project_id: 'testproj',
  client_email: 'sa@testproj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
});
process.env.NUVIZZ_BASE_URL = '';
delete process.env.FIRESTORE_DATABASE;
delete process.env.AUTH_REQUIRED;
process.env.NUVIZZ_DAVIS_USER = 'u';
process.env.NUVIZZ_DAVIS_PASS = 'p';
delete process.env.NUVIZZ_SCANS_ENABLED;
delete process.env.STOP_LOOKUP_PROMPTED_CALL;
delete process.env.PRO_INDEX;

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { liftFromApp } from './helpers/app-lift.mjs';
import { promptedSource } from '../src/lib/stop-lookup.js';

const FN = 'https://x.netlify.app/.netlify/functions/stop-lookup-prompted';
const today = async () => (await import('../netlify/functions/lib/firestore.mts')).etDayString();

const vendorStop = (stopNbr, day) => ({ Stop: {
  stop: {
    stopNbr, shipmentNbr: stopNbr, stopType: 'DO', status: '90',
    to: { address: { name: 'EARTHLY ALTERNATIVE THE', addr1: '239 GRANT ST SE STE 104', city: 'ATLANTA', state: 'GA', zip: '30312' }, schedule: { timeFrom: `${day}T08:00:00`, timeTo: null } },
  },
  stopExecutionInfo: { stopStatus: '90', to: {} },
  load: { loadNbr: 'DAVIS000203801', driverName: 'Theo Afunyah', routeName: 'ATL 5' },
} });

/** NuVizz answers from a script: each vendor request takes the next [status, body]. */
const scripted = (steps) => {
  let i = 0;
  return async () => {
    const [status, body] = steps[Math.min(i++, steps.length - 1)];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
};

async function ask(qs, vendor) {
  const fake = installFirestoreFake({}, vendor);
  try {
    const handler = (await import('../netlify/functions/stop-lookup-prompted.mts')).default;
    const resp = await handler(new Request(`${FN}?${qs}`));
    return { fake, body: await resp.json() };
  } finally { fake.restore(); }
}

test('NuVizz busy once, then answering: the reply says TWO calls were spent, because two went out', async () => {
  const t = await today();
  const { fake, body } = await ask('stop=7180003', scripted([[503, { error: 'busy' }], [200, vendorStop('007180003', t)]]));
  assert.equal(fake.log.other.length, 2, 'two requests genuinely went to NuVizz');
  assert.equal(body.prompted.ok, true);
  assert.equal(body.nuvizzCalls, 2, 'the count is what happened');
  assert.match(body.note, /2 NuVizz calls/);
  assert.match(body.dossier.sources[0].note, /2 calls, on request/, 'and the ledger row says the same');
});

test('NuVizz busy once, then "no such order": two calls spent, and the reply says two', async () => {
  const { fake, body } = await ask('stop=999999999', scripted([[503, { error: 'busy' }], [404, { error: 'no such stop' }]]));
  assert.equal(fake.log.other.length, 2);
  assert.equal(body.prompted.reason, 'not_found');
  assert.equal(body.nuvizzCalls, 2);
  assert.match(body.note, /2 NuVizz calls/);
});

test('an ordinary single-call answer still reports exactly one', async () => {
  const t = await today();
  const { fake, body } = await ask('stop=7180004', scripted([[200, vendorStop('007180004', t)]]));
  assert.equal(fake.log.other.length, 1);
  assert.equal(body.nuvizzCalls, 1);
  assert.equal(body.note, 'ONE NuVizz call, spent on request.');
  assert.match(body.dossier.sources[0].note, /^one call, on request/);
});

test('the ledger row names the price it was given, and one when it was given none', () => {
  assert.match(promptedSource({ day: '2026-09-10', calls: 3 }).note, /^3 calls, on request — filed under 2026-09-10/);
  assert.match(promptedSource({ day: '2026-09-10' }).note, /^one call, on request/);
  assert.match(promptedSource({ calls: 1 }).note, /^one call, on request — no delivery day/);
});

// ── the header chip, lifted out of App.jsx and rendered ─────────────────────────────────────
const { LookupCallsPill } = liftFromApp({ targets: ['LookupCallsPill'], inject: { React } });
const pill = (calls) => renderToStaticMarkup(React.createElement(LookupCallsPill, { calls }));

test('the header chip prints the number of calls the answer spent — not "0" when it was more than one', () => {
  assert.match(pill(0), /0 NuVizz calls/);
  assert.match(pill(undefined), /0 NuVizz calls/);
  assert.match(pill(1), /1 NuVizz call — on request/);
  assert.match(pill(2), /2 NuVizz calls — on request/);
  assert.match(pill(5), /5 NuVizz calls — on request/);
  assert.doesNotMatch(pill(5), /Nothing here spends a NuVizz call/);
});

test('the banner over a prompted order reads the answer\'s own count', () => {
  const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const i = APP.indexOf('d.found && data.prompted?.ok && (');
  assert.ok(i > 0, 'the banner is where it was');
  const banner = APP.slice(i, i + 700);
  assert.match(banner, /data\.nuvizzCalls/, 'the banner is handed the answer\'s count');
});

test('the order panel NuVizz opens says the same count as the chip — not "one call" after a retry', async () => {
  // The panel's footer hard-coded "Straight from NuVizz — one call" while the chip, the banner
  // and the ledger above it said two. The detail now carries the answer's own count.
  const t = await today();
  const busy = await ask('stop=7180005', scripted([[503, { error: 'busy' }], [200, vendorStop('007180005', t)]]));
  const once = await ask('stop=7180006', scripted([[200, vendorStop('007180006', t)]]));
  assert.equal(busy.body.nuvizzCalls, 2);
  assert.equal(busy.body.detail.nuvizzCalls, 2, "the detail carries the answer's count");
  assert.equal(once.body.detail.nuvizzCalls, 1);

  const lucide = await import('lucide-react');
  const { libExports } = await import('./helpers/app-lift.mjs');
  const APP_SRC = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const lucideNames = /import\s*\{([^}]*)\}\s*from 'lucide-react'/.exec(APP_SRC)[1]
    .split(',').map((x) => x.trim()).filter(Boolean)
    .map((x) => x.split(/\s+as\s+/)).map(([from, to]) => [to || from, lucide[from]]);
  const libs = await libExports(['date-util.js', 'stop-lookup.js']);
  const render = (Body, detail) => renderToStaticMarkup(React.createElement(Body, { data: detail, onOpenHistory: () => {}, wide: true }));
  const { OrderDetailBody } = liftFromApp({
    targets: ['OrderDetailBody'],
    inject: {
      ...Object.fromEntries(lucideNames), ...libs, React,
      useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo,
      useRef: React.useRef, useCallback: React.useCallback,
    },
    exercise: (l) => { render(l.OrderDetailBody, busy.body.detail); render(l.OrderDetailBody, once.body.detail); },
  });

  const two = render(OrderDetailBody, busy.body.detail);
  assert.match(two, /Straight from NuVizz — 2 calls, asked for just now\./);
  assert.doesNotMatch(two, /one call/);
  assert.match(render(OrderDetailBody, once.body.detail), /Straight from NuVizz — one call, asked for just now\./);
});
