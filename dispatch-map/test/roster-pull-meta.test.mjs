// test/roster-pull-meta.test.mjs
//
// THE PULL REPORTS WHAT IT SAW, BESIDE WHAT IT KEPT.
//
// Chad, Sunday 11:37, board on Tue Sep 8, after a manual scan: "Load roster: 0 loads · cached
// just now." From outside the system that sentence has three causes that are pixel-identical:
// the vendor answered ZERO ROWS for the period we sent; the vendor answered rows and the parser
// kept NONE (no filterData column defs → [] with no throw); or the period string asked NuVizz
// for a day other than the one on screen. Nothing on the path recorded which, and two days
// were spent guessing between them. These tests pin that every pull now records the period it
// sent, the rows it got and the rows it kept — in the log line, in the stored document, and in
// ?explain=1 — so the question is answered at zero call cost from now on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainRosterRow } from '../netlify/functions/lib/roster-write.mts';

const ROW = (loads, pull) => explainRosterRow('2026-09-08', { at: '2026-09-06T15:37:00Z', loads, emptyStreak: 1, emptyAt: null, pull });

test('VENDOR SAID NONE: an empty roster whose pull carried zero rows says so in words', () => {
  const r = ROW([], { period: '+2d', httpStatus: 200, cols: 21, rows: 0, kept: 0 });
  assert.equal(r.count, 0);
  assert.match(r.pullNote, /vendor answered ZERO rows for period \+2d/);
  assert.match(r.pullNote, /21 column defs/);
});

test('PARSER KEPT NONE: rows came back and normalisation dropped every one — the opposite sentence', () => {
  const r = ROW([], { period: '+2d', httpStatus: 200, cols: 21, rows: 106, kept: 0 });
  assert.match(r.pullNote, /answered 106 row\(s\).*KEPT NONE/);
  assert.doesNotMatch(r.pullNote, /ZERO rows/);
});

test('a working pull reads as kept-of-rows, with the period beside it', () => {
  const r = ROW([{ loadId: 'a', name: 'BEN 2', loadNbr: 'DAVIS000198197', status: 'Draft', trips: 0 }], { period: '0d', httpStatus: 200, cols: 21, rows: 106, kept: 106 });
  assert.equal(r.pullNote, '106 of 106 row(s) kept for period 0d');
  assert.deepEqual(r.pull, { period: '0d', httpStatus: 200, cols: 21, rows: 106, kept: 106 });
});

test('a document written before the pull was recorded says so — never invents a number', () => {
  const r = ROW([], null);
  assert.equal(r.pull, null);
  assert.match(r.pullNote, /written before the pull was recorded/);
  assert.match(r.pullNote, /\[roster\] <date>/, 'points the reader at the log line that has it');
});

test('a malformed pull object is treated as absent, not trusted', () => {
  const r = ROW([], 'garbage');
  assert.equal(r.pull, null);
});
