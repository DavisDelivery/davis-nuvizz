// test/driver-phone.test.mjs — the Route block's tap-to-text driver number.
//
// Chad, on a stop's ROUTE section: "this should have the route name drivers name and their
// phone number that is a hyperlink that brings up simple text with the pro number and name of
// customer pre populated."
//
// Two halves, tested where each one lives:
//   1. The endpoint that resolves a name → number. It answers 200 with phone:null for every
//      failure mode (no name, no roster, lookup threw) rather than an error status, because
//      the panel's correct response to "no number" is to show no line — never a broken card.
//   2. The wiring in App.jsx, pinned at the SOURCE (no component export to mount, same
//      approach as last-stop-removable.test.mjs): the number must be rendered through the
//      order-aware text action, not a bare tel: link, or tapping it opens an empty composer
//      and loses the PRO + customer prefill that was the whole request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import handler from '../netlify/functions/driver-phone.mts';

const call = (url) => handler(new Request(url));
const BASE = 'https://example.test/.netlify/functions/driver-phone';

test('a nameless request is refused, not guessed at', async () => {
  const body = await (await call(BASE)).json();
  assert.equal(body.ok, false);
  assert.equal(body.phone, null);
});

test('no roster configured → no number, still a clean 200', async () => {
  // FIREBASE_SA is unset under test, so isFirestoreEnabled() is false: this is the
  // degrade-quietly path the Route block relies on to simply hide the line.
  const res = await call(`${BASE}?name=${encodeURIComponent('Michael Frye')}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.phone, null);
  assert.equal(body.name, 'Michael Frye');
});

test('CORS preflight is answered', async () => {
  const res = await handler(new Request(BASE, { method: 'OPTIONS' }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');

test('the Route block texts about the ORDER, not just the number', () => {
  const block = src.match(/\{live\.driverName && driverPhone && \([\s\S]{0,700}?\n\s{14}\)\}/)?.[0];
  assert.ok(block, 'the Route block no longer renders driverPhone — if it moved, move this pin with it');
  assert.ok(
    block.includes('onTextDriver(live)'),
    'the driver number must open the composer via onTextDriver(live) so it carries the ' +
    "order's PRO + customer prefill; a plain tel:/sms: link drops it.",
  );
  assert.ok(
    block.includes('formatPhone(driverPhone)'),
    'show the number formatted — a bare 10-digit string is what the roster returns, not what ' +
    'a dispatcher reads.',
  );
});

test('a driver with no number on file renders no line at all', () => {
  assert.ok(
    /\{live\.driverName && driverPhone &&/.test(src),
    'the phone line must be gated on driverPhone being present — rendering it unconditionally ' +
    'gives a dead link (or an empty one) for every driver without a roster number.',
  );
});

test('driver-number lookups are cached, misses included', () => {
  assert.ok(
    /__driverPhoneCache\.set\(key, phone\)/.test(src),
    'every resolved lookup (including a null miss) must land in the cache — otherwise a driver ' +
    'with no roster number re-requests on every stop the dispatcher opens.',
  );
});
