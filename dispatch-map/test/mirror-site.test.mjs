// THE BROWSER HALF OF THE MIRROR GUARD.
//
// The server refuses to touch production Firestore from a UAT-pointed deploy. The BROWSER had
// no such check — and the browser writes real things: customer notes, receiving hours, closed
// days, vehicle eligibility, truck profiles, board-date overrides. src/lib/firebase.js read
// VITE_FIRESTORE_DATABASE and called getFirestore(app, dbName) with no cross-check, so one
// missing build-time variable on the UAT site sent every write to the live board, and the app
// looked completely normal while it happened.
//
// Keyed on the HOSTNAME on purpose: every other candidate is another variable somebody has to
// remember, which is the same failure one level up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isUatHost, mirrorMisconfigured, MIRROR_MISCONFIGURED_MESSAGE } from '../src/lib/mirror-site.js';

test('the UAT hosts this app is actually served from are recognised', () => {
  for (const h of [
    'dd-dispatch-map-uat.netlify.app',
    'uat.davisdelivery.com',
    'dispatch-uat.davisdelivery.com',
    'UAT.example.com',
  ]) assert.equal(isUatHost(h), true, h);
});

test('production hosts are NOT — and neither is a word that merely contains those letters', () => {
  for (const h of [
    'dd-dispatch-map.netlify.app',
    'davisdelivery.com',
    'localhost',
    '127.0.0.1',
    '',
    undefined,
    'evaluate.example.com',      // contains "uat" inside a word
    'graduation.example.com',    // ditto
  ]) assert.equal(isUatHost(h), false, String(h));
});

test('a UAT host with NO named database is the misconfiguration — that is the whole bug', () => {
  assert.equal(mirrorMisconfigured('dd-dispatch-map-uat.netlify.app', ''), true);
  assert.equal(mirrorMisconfigured('dd-dispatch-map-uat.netlify.app', '   '), true);
  assert.equal(mirrorMisconfigured('dd-dispatch-map-uat.netlify.app', undefined), true);
});

test('a UAT host WITH a named database is correct, and silent', () => {
  assert.equal(mirrorMisconfigured('dd-dispatch-map-uat.netlify.app', 'uat-mirror'), false);
});

test('PRODUCTION IS NEVER TOUCHED, whatever it sets — this guard has one direction', () => {
  // Firing here would be the same bug with the sign flipped: the live board with saving off.
  assert.equal(mirrorMisconfigured('dd-dispatch-map.netlify.app', ''), false);
  assert.equal(mirrorMisconfigured('dd-dispatch-map.netlify.app', 'uat-mirror'), false);
  assert.equal(mirrorMisconfigured('localhost', ''), false, 'local development must keep working');
});

test('the message names what it would have broken and how to fix it', () => {
  // A guard that only says "misconfigured" gets ignored; one that names receiving hours gets acted on.
  assert.match(MIRROR_MISCONFIGURED_MESSAGE, /UAT site/);
  assert.match(MIRROR_MISCONFIGURED_MESSAGE, /PRODUCTION database/);
  assert.match(MIRROR_MISCONFIGURED_MESSAGE, /receiving hours/);
  assert.match(MIRROR_MISCONFIGURED_MESSAGE, /VITE_FIRESTORE_DATABASE/);
  assert.match(MIRROR_MISCONFIGURED_MESSAGE, /Saving is switched off/);
});

test('WIRING: firebase.js refuses the handle, and the app shows the banner', async () => {
  const { readFile } = await import('node:fs/promises');
  const fb = await readFile(new URL('../src/lib/firebase.js', import.meta.url), 'utf8');
  assert.match(fb, /export const db = \(app && !mirrorMisconfig\)/,
    'a misconfigured mirror must get NO Firestore handle — a dead control beats a silent production write');
  assert.match(fb, /export const mirrorMisconfig = mirrorMisconfigured\(/);
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /\{mirrorMisconfig && \(/, 'the operator must SEE it — every save is dead on this build');
  assert.match(app, /role="alert"/);
});
