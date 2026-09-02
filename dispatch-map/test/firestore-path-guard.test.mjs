// test/firestore-path-guard.test.mjs — every lib/firestore.mts helper builds its URL by
// concatenating a caller-supplied path, and fetch() resolves `..` in it. These pin the
// guard: traversal / query / fragment segments are refused BEFORE any network, and every
// id shape this codebase actually writes today still passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { safeSegment, assertSafePath, getDoc, deleteDoc, incrementDocFields } from '../netlify/functions/lib/firestore.mts';
import { histDocId } from '../netlify/functions/lib/history-store.mts';
import { normalizeMatchKey } from '../netlify/functions/lib/match-key.mts';
import { addrKey } from '../netlify/functions/lib/geocode.mts';
import { smsDocId } from '../netlify/functions/lib/sms-store.mts';
import { newId } from '../netlify/functions/lib/routing-store.mts';
import { pdfChunkDocPath } from '../netlify/functions/manifest-ocr-background.mts';
import { referenceRoutePath } from '../netlify/functions/lib/routing-reference.mts';
import { tractorLocPath } from '../netlify/functions/lib/tractor-flags.mts';
import { alertClaimPath } from '../netlify/functions/lib/flag-alert.mts';
import { installFirestoreFake } from './_firestore-fake.mjs';

test('path guard: a DELETE aimed at attempts/…/items/../../../nuvizz_ops/circuit is refused (the breaker re-arm)', () => {
  assert.throws(() => assertSafePath('attempts/davis__2026-09-01/items/../../../nuvizz_ops/circuit'), /dot segment/);
});

test('path guard: "?" and "#" cannot end the path early; "\\" and "/" cannot appear inside a segment', () => {
  assert.throws(() => assertSafePath('nuvizz_stop_index/davis__2026-09-01/stops/1?updateMask.fieldPaths=x'), /forbidden character/);
  assert.throws(() => assertSafePath('customer_notes/a#b'), /forbidden character/);
  assert.throws(() => safeSegment('a\\b'), /forbidden character/);
  assert.throws(() => safeSegment('a/b'), /forbidden character/);
});

test('path guard: empty path, empty segment, bare "." / "..", and their percent-encoded spellings are refused', () => {
  assert.throws(() => assertSafePath(''), /empty path/);
  assert.throws(() => assertSafePath('a//b'), /empty segment/);
  assert.throws(() => assertSafePath('a/b/'), /empty segment/);
  assert.throws(() => assertSafePath('.'), /dot segment/);
  assert.throws(() => assertSafePath('a/../b'), /dot segment/);
  assert.throws(() => assertSafePath('a/%2e%2e/b'), /dot segment/);
  assert.throws(() => assertSafePath('a/%2E/b'), /dot segment/);
  assert.throws(() => assertSafePath('a/.%2e/b'), /dot segment/);
  assert.throws(() => assertSafePath(null), /empty path/);
});

test('path guard: every real id shape written today passes', () => {
  const uuid = crypto.randomUUID();
  const real = [
    'nuvizz_stop_index/davis__2026-09-01',
    'nuvizz_stop_index/davis__2026-09-01/stops/007144864',
    'nuvizz_stop_index/davis__2026-09-01/stops/' + encodeURIComponent('AVRT-0028093763'),
    'nuvizz_stop_index/davis__2026-09-01/stops/' + encodeURIComponent('ESTES 0538243875'),
    'nuvizz_ops/scan_config', 'nuvizz_ops/circuit', 'nuvizz_ops/calls__2026-09-01', 'nuvizz_ops/scan_metrics',
    'nuvizz_ops/flag_evening_status__2026-09-01', 'nuvizz_ops/cs_notify_status__2026-09-01',
    'nuvizz_ops/customer_comms_2026-09-01/sent/' + normalizeMatchKey('Uline, Inc.', '1 Uline Dr. Suite #200', 'Braselton', '30517'),
    'nuvizz_ops/davis__op_1725000000000_abc',
    pdfChunkDocPath(uuid, 0),
    'customer_notes/' + normalizeMatchKey("Bob's Tires & Wheels (Store #4)", '12 N. Peachtree Pkwy, Unit B', 'Sugar Hill', '30518-1234'),
    'customer_notes/' + normalizeMatchKey(null, null, null, null),
    'history_days/davis__2026-06-24', 'history_days/davis__2026-06-24/captures/v3',
    'history_days/davis__2026-06-24/routes/' + histDocId('COLIN/DJ 1'),
    'history_days/davis__2026-06-24/drivers/' + histDocId('__weird__'),
    'history_days/davis__2026-06-24/stops/' + histDocId('..'),
    'history_driver_days/davis__' + histDocId('VINCENT') + '/days/2026-06-24',
    'nuvizz_enriched/davis/pros/' + encodeURIComponent('AVRT-0028093763'),
    'attempts/davis__2026-09-01/items/007137828', 'att_plan/davis__2026-09-01/stops/007137828',
    'routing_jobs/' + newId('job'), 'routing_jobs/job_' + String(Date.now()), 'routing_routes/' + newId('routeset'),
    referenceRoutePath('davis', '2026-09-01', 'SUW 2'), referenceRoutePath('davis', '2026-09-01', 'COLIN/DJ 1'),
    tractorLocPath('davis', normalizeMatchKey('Acme', '1 Main St', 'Atlanta', '30301')),
    alertClaimPath('davis', '2026-09-01', 'AVRT-0028093763', 'urgent'),
    'sms_messages/' + smsDocId('4f2a1b9c-7e11-4c0f-9a8b-1234567890ab'), 'sms_messages/' + smsDocId('a/b?c'),
    'sms_messages/in_7705551212_1725000000000_ab12c',
    'nuvizz_geocode/' + addrKey({ addr1: '1 Uline Dr', city: 'Braselton', state: 'GA', zip: '30517' }),
    'nuvizzRoster/davis', 'nuvizz_fleet_index/davis__2026-09-01/loads/DAVIS000198690',
    'truck_profiles/box-26', 'day_completion/davis__2026-09-01',
    'users/ops@example.com', 'users/+17705551212',
  ];
  for (const p of real) assert.equal(assertSafePath(p), p, p);
});

test('path guard runs BEFORE auth or network: getDoc/deleteDoc on a traversal path reject without touching fetch', async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; throw new Error('no network in this test'); };
  try {
    await assert.rejects(getDoc('attempts/x/items/../../../nuvizz_ops/circuit'), /firestore path/);
    await assert.rejects(deleteDoc('nuvizz_stop_index/davis__2026-09-01/stops/1?x=1'), /firestore path/);
    await assert.rejects(incrementDocFields('users/../nuvizz_ops/circuit', { n: 1 }), /firestore path/);
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = realFetch; }
});

test('incrementDocFields: one commit — increments as transforms, alsoSet as a masked merge, exists:true precondition', async () => {
  const fake = installFirestoreFake({});
  try {
    await incrementDocFields('users/u1', { failed_logins: 1, other: 2.7 }, { last_failed_at: '2026-09-02T12:00:00Z' });
    assert.equal(fake.log.commits.length, 1);
    const w = fake.log.commits[0].writes[0];
    assert.ok(w.update.name.endsWith('/documents/users/u1'));
    assert.deepEqual(w.updateMask, { fieldPaths: ['last_failed_at'] }, 'mask scoped to alsoSet only — never a whole-doc replace');
    assert.deepEqual(Object.keys(w.update.fields), ['last_failed_at']);
    assert.deepEqual(w.updateTransforms, [
      { fieldPath: 'failed_logins', increment: { integerValue: '1' } },
      { fieldPath: 'other', increment: { integerValue: '2' } },
    ]);
    assert.deepEqual(w.currentDocument, { exists: true }, 'a missing doc is a failure, never a fresh counter');
  } finally { fake.restore(); }
});

test('incrementDocFields: a failed precondition (doc absent) THROWS; nothing to increment is a no-op', async () => {
  const realFetch = globalThis.fetch;
  let commits = 0;
  globalThis.fetch = async (u) => {
    if (String(u).startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    commits++;
    return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'No document to update' } }), { status: 404 });
  };
  try {
    await assert.rejects(incrementDocFields('users/nobody', { failed_logins: 1 }), /incrementDocFields users\/nobody failed: 404/);
    assert.equal(commits, 1);
    await incrementDocFields('users/nobody', {}); // no keys → returns before any fetch
    assert.equal(commits, 1);
  } finally { globalThis.fetch = realFetch; }
});
