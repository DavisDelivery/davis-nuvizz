// test/stop-lookup-activity-timeline.test.mjs — THE ORDER PANEL'S ACTIVITY TIMELINE IS ASKED FOR,
// PRICED, AND COUNTED.
//
// Chad, 2026-09-28, on the Stop lookup's order panel: "Where is my activity history?" — and, told
// it is a NuVizz read we do not keep: "yes i want the activity timeline button there doesn't
// automatically make the call unless someone selects it."
//
// What this pins, each named for what goes wrong without it:
//   1. NOTHING IS ASKED UNTIL A PERSON PRESSES. The fetch lives in the click handler, never in an
//      effect or the render — or opening an order would spend a call nobody chose to spend.
//   2. THE PRICE ON THE BUTTON IS WHAT THE ENDPOINT SPENDS — measured request by request off the
//      vendor fake, not asserted: 1 call with the order's NuVizz id, 2 without.
//   3. THE STOP CARD'S TIMELINE IS UNCHANGED — no refresh param is still /stop/info + events.
//   4. WHAT A PRESS COST IS COUNTED, NOT ASSUMED — a retried busy NuVizz reports 2, scans off 0.
//   5. THE HEADER CHIP ADDS IT AND NOTHING ELSE DOES — the answer's own price, which the prompted
//      banner and the order's source line quote, is left alone.
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';
import { buildOrderDetail, timelinePrice, timelineQuery, timelineFailure } from '../src/lib/stop-lookup.js';
import { ORDER_DETAIL } from '../scripts/lib/customer-view-fixture.mjs';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const FN = 'https://x.netlify.app/.netlify/functions/nuvizz-stop-events';

// ── the vendor ──────────────────────────────────────────────────────────────────────────────

/** /stop/info in the wrapper shape lookupStopByPro unwraps — carrying NuVizz's OWN id. */
const stopInfo = (stopNbr, stopId) => ({ Stop: {
  stop: {
    stopNbr, stopId, shipmentNbr: stopNbr, stopType: 'DO', status: '90',
    to: { address: { name: 'EARTHLY ALTERNATIVE THE', addr1: '1100 NORTHSIDE DR NW', city: 'ATLANTA', state: 'GA', zip: '30318' }, schedule: { timeFrom: '2026-09-18T08:00:00', timeTo: null } },
  },
  stopExecutionInfo: { stopStatus: '90', to: {} },
  load: { loadNbr: 'DAVIS000203801', driverName: 'Robert Mensah-Addai', routeName: 'ATLANTA SOUTHWEST 3' },
} });
const EVENTS = { events: [
  { eventCode: 90, eventName: 'DELIVERED', eventDTTM: '2026-09-18T13:44:12', userName: 'ROBERT', companyName: 'DAVIS DELIVERY', latitude: 33.78, longitude: -84.41 },
  { eventCode: 20, eventName: 'STOP PLANNED', eventDTTM: '2026-09-17T16:45:00', userName: 'CHAD', companyName: 'DAVIS DELIVERY' },
] };

/** NuVizz answers by route: each matching request takes the next [status, body] for that route. */
const vendor = (routes) => async (url) => {
  for (const [re, steps] of routes) {
    if (!re.test(url)) continue;
    const [status, body] = steps.length > 1 ? steps.shift() : steps[0];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`unexpected vendor request: ${url}`);
};
const INFO = /\/stop\/info\//;
const RICH = /\/event\/eventinfo\//;
const PLAIN = /\/stop\/eventinfo\//;

async function ask(qs, routes) {
  const fake = installFirestoreFake({}, vendor(routes));
  try {
    const handler = (await import('../netlify/functions/nuvizz-stop-events.mts')).default;
    const resp = await handler(new Request(`${FN}?${qs}`));
    return { sent: fake.log.other.map((x) => x.url), status: resp.status, body: await resp.json() };
  } finally { fake.restore(); }
}

const ORDER = { stopNbr: '007180002', pro: '007180002', stopId: '88412903' };

// ── 2 + 4: the endpoint spends what the button says, and says what it spent ─────────────────

test("the panel's press WITH the order's NuVizz id: ONE request, to the detailed history by that id — and the reply says 1", async () => {
  const { sent, body } = await ask(timelineQuery(ORDER), [[RICH, [[200, EVENTS]]]]);
  assert.equal(sent.length, 1, 'exactly one request went to NuVizz');
  assert.match(sent[0], /\/event\/eventinfo\/.*entityId=88412903/, 'asked by THIS record\'s id — never the twin sharing its number');
  assert.equal(body.ok, true);
  assert.equal(body.nuvizzCalls, 1, 'the count is what happened');
  assert.deepEqual(body.events.map((e) => e.name), ['DELIVERED', 'STOP PLANNED'], 'newest first, as the card shows them');
  assert.equal(timelinePrice(ORDER).calls, body.nuvizzCalls, 'and the button quoted exactly that');
});

test("the panel's press WITHOUT an id: /stop/info finds it, then the detailed history — TWO, as the button says", async () => {
  const bare = { stopNbr: '007180002', pro: '007180002', stopId: null };
  const { sent, body } = await ask(timelineQuery(bare), [[INFO, [[200, stopInfo('007180002', 'FROM-INFO-77')]]], [RICH, [[200, EVENTS]]]]);
  assert.equal(sent.length, 2);
  assert.match(sent[0], INFO);
  assert.match(sent[1], /entityId=FROM-INFO-77/, 'the id /stop/info returned is the one asked by');
  assert.equal(body.nuvizzCalls, 2);
  assert.equal(timelinePrice(bare).calls, body.nuvizzCalls, 'and the button quoted exactly that');
});

test('THE STOP CARD IS UNCHANGED: no refresh param is still /stop/info + events, the card\'s own id still wins, and the refreshed record comes back', async () => {
  const card = new URLSearchParams({ stopNbr: '007180002', stopId: '88412903' }).toString(); // exactly what StopActivityTimeline sends
  const { sent, body } = await ask(card, [[INFO, [[200, stopInfo('007180002', 'FROM-INFO-77')]]], [RICH, [[200, EVENTS]]]]);
  assert.equal(sent.length, 2);
  assert.match(sent[0], INFO, 'the refresh still runs for the card — it folds new notes back in');
  assert.match(sent[1], /entityId=88412903/, 'the id the card passed wins over the one /stop/info returned, as before');
  assert.equal(body.stop?.stopNbr, '007180002', 'the refreshed record still rides back for onRefreshed');
  assert.equal(body.nuvizzCalls, 2);
});

test('a MALFORMED refresh leaves the card\'s behaviour — only an explicit off-word skips the /stop/info', async () => {
  for (const word of ['maybe', '', '1', 'yes']) {
    const { sent } = await ask(`stopNbr=007180002&stopId=88412903&refresh=${word}`, [[INFO, [[200, stopInfo('007180002', 'X')]]], [RICH, [[200, EVENTS]]]]);
    assert.equal(sent.length, 2, `refresh=${word} keeps the refresh`);
  }
  for (const word of ['0', 'off', 'false', 'no', 'OFF']) {
    const { sent } = await ask(`stopNbr=007180002&stopId=88412903&refresh=${word}`, [[RICH, [[200, EVENTS]]]]);
    assert.equal(sent.length, 1, `refresh=${word} skips it`);
  }
});

test('the detailed history refused → the plain one by the 9-digit number: TWO requests, and the reply says two', async () => {
  const { sent, body } = await ask(timelineQuery({ ...ORDER, stopNbr: '7180002' }), [[RICH, [[404, { error: 'no' }]]], [PLAIN, [[200, EVENTS]]]]);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /\/stop\/eventinfo\/.*stopNbr=007180002/, 'padded, as NuVizz numbers are');
  assert.equal(body.ok, true);
  assert.equal(body.source, 'stop');
  assert.equal(body.nuvizzCalls, 2, 'the fallback is counted — the button quoted the usual price, the chip says what happened');
});

test('NuVizz busy once, then answering: TWO calls were spent and the reply says two', async () => {
  const { sent, body } = await ask(timelineQuery(ORDER), [[RICH, [[503, { error: 'busy' }], [200, EVENTS]]]]);
  assert.equal(sent.length, 2, 'the requester retried');
  assert.equal(body.ok, true);
  assert.equal(body.nuvizzCalls, 2);
});

test('scans switched off: NOTHING goes out, the reply says 0, and the panel says so and offers no retry', async () => {
  process.env.NUVIZZ_SCANS_ENABLED = 'false';
  try {
    const { sent, status, body } = await ask(timelineQuery(ORDER), []);
    assert.equal(sent.length, 0);
    assert.equal(status, 404);
    assert.equal(body.reason, 'scans_disabled');
    assert.equal(body.nuvizzCalls, 0);
    const f = timelineFailure(body.reason);
    assert.equal(f.retry, false, 'a second press would only be refused again');
    assert.match(f.text, /nothing was asked/);
  } finally { delete process.env.NUVIZZ_SCANS_ENABLED; }
});

// ── the pure rules ────────────────────────────────────────────────────────────────────────

test('the price: ONE NuVizz call with the order\'s id, TWO without — and a blank id is no id', () => {
  assert.deepEqual(timelinePrice({ stopId: '88412903' }), { calls: 1, text: '1 NuVizz call' });
  assert.deepEqual(timelinePrice({ stopId: null }), { calls: 2, text: '2 NuVizz calls' });
  assert.deepEqual(timelinePrice({ stopId: '   ' }), { calls: 2, text: '2 NuVizz calls' });
  assert.deepEqual(timelinePrice(null), { calls: 2, text: '2 NuVizz calls' });
});

test('the query: the stop number (or the PRO), the id when there is one, and refresh=0 always', () => {
  assert.equal(timelineQuery(ORDER), 'stopNbr=007180002&stopId=88412903&refresh=0');
  assert.equal(timelineQuery({ pro: '007180002' }), 'stopNbr=007180002&refresh=0', 'the PRO stands in for a missing stop number; no empty stopId');
  assert.equal(timelineQuery({ stopNbr: '007180002', stopId: '' }), 'stopNbr=007180002&refresh=0');
});

test('a failure is a sentence: switches say nothing was asked; an HTTP status is REPORTED, not interpreted; anything else may be retried', () => {
  assert.equal(timelineFailure('NuVizz circuit breaker open — refusing /event/eventinfo (davis)').retry, false);
  assert.match(timelineFailure('NuVizz circuit breaker open — refusing /event/eventinfo (davis)').text, /daily ceiling/);
  const h = timelineFailure('http_404');
  assert.equal(h.retry, true);
  assert.match(h.text, /HTTP 404/);
  assert.doesNotMatch(h.text, /no (such )?order|does not exist|never received/i, 'what a NuVizz 404 means is not in the code, so the panel does not say');
  const t = timelineFailure('NuVizz /event/eventinfo did not answer within 12000ms (2 attempt(s))');
  assert.equal(t.retry, true);
  assert.match(t.text, /^NuVizz could not answer: NuVizz \/event\/eventinfo did not answer/);
  assert.match(timelineFailure('').text, /no answer came back/);
});

test('the order detail carries NuVizz\'s own id for THIS record — sealed, board or prompted — and null when the record has none', () => {
  assert.equal(buildOrderDetail({ stopNbr: '007180002', stopId: 88412903 }, { date: '2026-09-18' }).stopId, '88412903');
  assert.equal(buildOrderDetail({ stopNbr: '007180002' }, { date: '2026-09-18' }).stopId, null);
  assert.equal(ORDER_DETAIL.stop.stopId, '88412903', 'and the layout guards\' fixture has the shape the endpoint now returns');
});

// ── 1 + 5: the screen ─────────────────────────────────────────────────────────────────────

const fnSource = (name) => {
  const i = APP.indexOf(`function ${name}(`);
  assert.ok(i > 0, `${name} exists`);
  const next = APP.indexOf('\nfunction ', i + 10);
  return APP.slice(i, next);
};

test('NOTHING IS ASKED UNTIL A PERSON PRESSES: the only NuVizz fetch in the section is inside the click handler', () => {
  const src = fnSource('OrderActivityTimeline');
  const fetches = [...src.matchAll(/apiFetch\(/g)];
  assert.equal(fetches.length, 1, 'one fetch in the section');
  const handler = src.slice(src.indexOf('const ask = async () => {'), src.indexOf('const fail = '));
  assert.match(handler, /apiFetch\(`\/\.netlify\/functions\/nuvizz-stop-events\?\$\{timelineQuery\(order\)\}`/, 'and it is the click handler that makes it, with the pure query');
  for (const eff of src.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)) {
    assert.doesNotMatch(eff[1], /apiFetch|ask\(/, 'no effect asks NuVizz — opening an order must not spend a call');
  }
  assert.match(src, /<button type="button" onClick=\{ask\}/, 'the button is what calls it');
});

test('what a press cost goes to the screen COUNTED — the reply\'s own nuvizzCalls — and only while the panel is still open', () => {
  const src = fnSource('OrderActivityTimeline');
  assert.match(src, /if \(!alive\.current\) return;\s*const n = Number\(j\?\.nuvizzCalls\) > 0 \? Number\(j\.nuvizzCalls\) : 0;\s*if \(n\) onSpent\?\.\(n\);/);
  assert.doesNotMatch(src, /onSpent\?\.\(\s*(1|2|price\.calls)\s*\)/, 'never the quoted price — the count');
});

test('THE HEADER CHIP ADDS IT, AND ONLY THE CHIP: the timeline writes its own field, never the answer\'s nuvizzCalls', () => {
  const cb = APP.slice(APP.indexOf('const timelineSpent = useCallback('), APP.indexOf('const renderOrderPanel = useCallback('));
  assert.match(cb, /setData\(\(cur\) => \(cur \? \{ \.\.\.cur, timelineCalls: promptedCallsOnScreen\(cur\.timelineCalls, n\) \} : cur\)\);/);
  assert.doesNotMatch(cb, /nuvizzCalls/, 'the banner and the source line quote nuvizzCalls as what the ANSWER cost');
  assert.match(APP, /<LookupCallsPill calls=\{promptedCallsOnScreen\(data\?\.nuvizzCalls, data\?\.timelineCalls\)\} \/>/);
  assert.match(APP, /<OrderDetailPanel [^>]*stacked=\{opts\.stacked \?\? isMobile\} onTimelineSpent=\{timelineSpent\}/, 'the panel is handed it');
});

test('the section sits in EVERY order panel, keyed by the order — a different order is a fresh, unasked button', () => {
  const body = fnSource('OrderDetailBody');
  assert.match(body, /<OrderActivityTimeline key=\{`\$\{d\.stopNbr \|\| d\.pro\}\|\$\{d\.stopId \|\| ''\}\|\$\{d\.date\}`\} order=\{d\} onSpent=\{onTimelineSpent\} \/>/);
  // Threaded through both shapes of the panel (phone and desktop render the same body).
  assert.match(APP, /<OrderDetailInner loading=\{loading\} err=\{err\} data=\{data\} wide=\{!stacked\} onOpenHistory=\{onOpenHistory\} onTimelineSpent=\{onTimelineSpent\} \/>/);
  assert.match(APP, /return <OrderDetailBody data=\{data\} onOpenHistory=\{onOpenHistory\} onTimelineSpent=\{onTimelineSpent\} wide=\{wide\} \/>;/);
});

const lucide = await import('lucide-react');
const lucideNames = /import\s*\{([^}]*)\}\s*from 'lucide-react'/.exec(APP)[1]
  .split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => x.split(/\s+as\s+/)).map(([from, to]) => [to || from, lucide[from]]);
const libs = await libExports(['ai-search.js', 'date-util.js', 'stop-lookup.js']);
const fetched = [];
const render = (Body, props) => renderToStaticMarkup(React.createElement(Body, props));
const { OrderDetailBody } = liftFromApp({
  targets: ['OrderDetailBody'],
  inject: {
    ...Object.fromEntries(lucideNames), ...libs, React,
    useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo,
    useRef: React.useRef, useCallback: React.useCallback,
    // A spy: rendering the panel must never reach it.
    apiFetch: async (url) => { fetched.push(url); throw new Error('the panel fetched on render'); },
  },
  exercise: (l) => { render(l.OrderDetailBody, { data: ORDER_DETAIL, onOpenHistory: null, wide: true }); },
});

test('the panel as a rep sees it: the section, its sentence, and the price on the button — 1 call with the id, 2 without; nothing fetched', () => {
  for (const wide of [true, false]) {
    const html = render(OrderDetailBody, { data: ORDER_DETAIL, onOpenHistory: null, onTimelineSpent: () => {}, wide });
    assert.match(html, /Activity timeline/);
    assert.match(html, /nothing is asked until you press/);
    assert.match(html, /Show the activity timeline — <span class="whitespace-nowrap">1 NuVizz call<\/span>/, 'the price, kept on one line');
    assert.match(html, /From the sealed nightly record — this cannot change again\./, 'the record\'s own source line is untouched');
    const noId = render(OrderDetailBody, { data: { ...ORDER_DETAIL, stop: { ...ORDER_DETAIL.stop, stopId: null } }, onOpenHistory: null, wide });
    assert.match(noId, /Show the activity timeline — <span class="whitespace-nowrap">2 NuVizz calls<\/span>/);
  }
  assert.deepEqual(fetched, [], 'rendering an order asked NuVizz nothing');
});
