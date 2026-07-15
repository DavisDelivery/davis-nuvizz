// test/history-store-getstop.test.mjs
//
// Unit tests for the single-archived-stop reader that powers "tap a historical PRO
// to see the FULL delivery" (lib/history-store.mts): the PURE doc-id candidate logic
// (stopDocIdCandidates) and the raw-then-padded-then-null fallback loop (getStop),
// with getDoc injected so no Firestore is touched. Run with: npm test.

import test from 'node:test';
import assert from 'node:assert/strict';

import { stopDocIdCandidates, getStop } from '../netlify/functions/lib/history-store.mts';

test('stopDocIdCandidates: an already-9-digit PRO yields exactly one id (no dup pad)', () => {
  assert.deepEqual(stopDocIdCandidates('007146672'), ['007146672']);
});

test('stopDocIdCandidates: a short numeric PRO yields raw first, then zero-padded-to-9', () => {
  assert.deepEqual(stopDocIdCandidates('7146672'), ['7146672', '007146672']);
});

test('stopDocIdCandidates: a non-numeric id is never zero-padded', () => {
  assert.deepEqual(stopDocIdCandidates('RA54112548'), ['RA54112548']);
});

test('stopDocIdCandidates: empty / whitespace / nullish → no candidates', () => {
  assert.deepEqual(stopDocIdCandidates(''), []);
  assert.deepEqual(stopDocIdCandidates('   '), []);
  assert.deepEqual(stopDocIdCandidates(undefined), []);
});

test('stopDocIdCandidates: trims surrounding whitespace before keying', () => {
  assert.deepEqual(stopDocIdCandidates('  007146672  '), ['007146672']);
});

test('getStop: returns the doc at the RAW id without a second read when the first hits', async () => {
  const calls = [];
  const io = { getDoc: async (p) => { calls.push(p); return { stopNbr: '007146672', driverName: 'ANDERSON FRIMPONG' }; } };
  const doc = await getStop('davis', '2026-07-14', '007146672', io);
  assert.equal(doc.driverName, 'ANDERSON FRIMPONG');
  assert.deepEqual(calls, ['history_days/davis__2026-07-14/stops/007146672']);
});

test('getStop: falls back to the zero-padded id when the raw id misses', async () => {
  const calls = [];
  const io = {
    getDoc: async (p) => {
      calls.push(p);
      return p.endsWith('/007146672') ? { stopNbr: '007146672', ok: true } : null;
    },
  };
  const doc = await getStop('davis', '2026-07-14', '7146672', io);
  assert.equal(doc.ok, true);
  assert.deepEqual(calls, [
    'history_days/davis__2026-07-14/stops/7146672',
    'history_days/davis__2026-07-14/stops/007146672',
  ]);
});

test('getStop: returns null (never throws) when every candidate misses', async () => {
  let reads = 0;
  const io = { getDoc: async () => { reads++; return null; } };
  const doc = await getStop('davis', '2026-07-14', '7146672', io);
  assert.equal(doc, null);
  assert.equal(reads, 2); // tried raw then padded, both null
});

test('getStop: an empty stop number reads nothing and returns null', async () => {
  let reads = 0;
  const io = { getDoc: async () => { reads++; return null; } };
  const doc = await getStop('davis', '2026-07-14', '', io);
  assert.equal(doc, null);
  assert.equal(reads, 0); // no candidates → no Firestore reads
});
