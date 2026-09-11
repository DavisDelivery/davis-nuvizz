// test/uat-bench-screen.test.mjs — the bench screen's pure helpers, and the two rules about
// WHERE it is allowed to appear.
//
// Chad picked the checkbox list of production's day (option a) and clear-on-request. What
// these tests pin is not the pixels but the two things that would be expensive to get wrong:
// the screen must be unreachable from production, and it must exist on a PHONE as well as a
// laptop — a screen added to one navigation and not the other is a screen that does not
// exist on a phone, and this repo has shipped exactly that twice (v0.54.50, and the note in
// App.jsx's own phone menu says so).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rowSubtitle, windowLabel, matchesQuery, benchToday, BENCH_MAX } from '../src/lib/uat-bench-view.js';
import { isUatHost } from '../src/lib/mirror-site.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(HERE, '..', 'src', 'App.jsx'), 'utf8');
const BENCH = fs.readFileSync(path.join(HERE, '..', 'src', 'components', 'UatBench.jsx'), 'utf8');

const row = (over = {}) => ({
  stopNbr: '007174773', businessName: 'COSTCO LOGISTICS', addr1: '2999 Cumberland Blvd',
  city: 'ATLANTA', state: 'GA', zip: '30339', itemsSummary: '1 pallet · 98 lbs',
  scheduledFrom: '2026-09-11T08:00:00', scheduledTo: '2026-09-11T14:00:00', timeConstraint: 'STRICT',
  ...over,
});

// ── where it may appear ──────────────────────────────────────────────────────

test('THE BENCH IS MOUNTED ONLY ON A UAT HOST — and the gate is the hostname, not a variable', () => {
  // A build variable is a thing somebody has to remember, and forgetting it here would put a
  // screen that writes NuVizz orders on the production board. The URL cannot be forgotten.
  assert.match(APP, /const BENCH_ON = \(\(\) => \{ try \{ return isUatHost\(window\.location\.hostname\)/);
  // ONE answer, read by every consumer — the nav, the phone menu and the router cannot
  // disagree about whether this screen exists.
  assert.ok(APP.split('isUatHost(').length - 1 === 1, 'the host is resolved exactly once');
  for (const h of ['dd-dispatch-map-uat.netlify.app', 'uat.example.com', 'deploy-preview-904--dd-dispatch-map-uat.netlify.app']) {
    assert.equal(isUatHost(h), true, h);
  }
  for (const h of ['dd-dispatch-map.netlify.app', 'davisdelivery.com', '', null, 'evaluate.example.com']) {
    assert.equal(isUatHost(h), false, String(h));
  }
});

test('IT EXISTS ON A PHONE TOO — both navigations carry it, and both are gated', () => {
  // App.jsx's own phone menu carries the note: "v0.54.50 shipped Manifest check visible on a
  // laptop and invisible on a phone, because the desktop nav row and this chip menu are built
  // separately. Dispatch runs on a phone."
  const desktop = /\.\.\.\(BENCH_ON \? \[\{ id: 'uatbench'/;
  const phone = /\{BENCH_ON && \([\s\S]{0,400}?onSelectMenu\('uatbench'\)/;
  assert.match(APP, desktop, 'the desktop More menu carries it');
  assert.match(APP, phone, 'the phone chip menu carries it');
  // And the router refuses it off a UAT host even if a tab id were restored from storage.
  assert.match(APP, /\(tab === 'uatbench' && BENCH_ON\) \? <UatBench \/>/);
  // The restore allowlist must carry it. Matched against the KNOWN array itself rather than
  // against its neighbours: pinning "'flaghistory', 'uatbench'" broke the moment a screen was
  // added between them (v1.20.0, Address history), which says nothing about this rule.
  const known = APP.match(/const KNOWN = \[([^\]]*)\]/);
  assert.ok(known, 'the restore allowlist exists');
  assert.ok(known[1].includes("'uatbench'"), 'the tab id is known to the restore list');
});

test('THE SCREEN HAS TWO VIEWS, not one layout with patches', () => {
  // Desktop scans a table (picking 14 of 800 is a scanning job); the phone stacks cards.
  assert.match(BENCH, /hidden md:block[\s\S]{0,400}?<table/, 'a desktop table');
  assert.match(BENCH, /md:hidden/, 'and a separate phone list');
  // Phone tap targets meet the repo's 44px floor.
  assert.ok((BENCH.match(/min-h-\[44px\]/g) || []).length >= 3, 'the actions are thumb-sized');
});

test('EVERY BUTTON THAT COSTS NUVIZZ CALLS SAYS SO BEFORE IT IS PRESSED', () => {
  // A bench whose cost is invisible gets used carelessly on the one tenant where careless is
  // cheap — until somebody points it at the wrong one.
  assert.match(BENCH, /Preview —[\s\S]{0,80}?0 calls/);
  assert.match(BENCH, /Seed into UAT — \{nPicked\} call/);
  assert.match(BENCH, /Only Seed and Clear reach NuVizz, and only the UAT tenant/);
  // And the destructive one asks, naming the number and what actually happens.
  assert.match(BENCH, /window\.confirm\(`Cancel \$\{n\} seeded test order/);
  assert.match(BENCH, /unplanned first\. Production is not touched/);
});

// ── the pure helpers ─────────────────────────────────────────────────────────

test('a window with no end reads as "no window" — the honest absence, not a half-truth', () => {
  assert.equal(windowLabel(row()), '08:00–14:00 strict');
  assert.equal(windowLabel(row({ timeConstraint: 'PREFERRED' })), '08:00–14:00');
  // Half a window is not a window: an opening with no close cannot test a deadline, and the
  // seeder drops it rather than pairing it with a default. The screen must agree.
  assert.equal(windowLabel(row({ scheduledTo: null })), 'no window');
  assert.equal(windowLabel(row({ scheduledFrom: null })), 'no window');
  for (const junk of [null, undefined, {}, { scheduledFrom: 5, scheduledTo: 5 }]) {
    assert.equal(windowLabel(junk), 'no window', JSON.stringify(junk));
  }
});

test('the filter matches what a dispatcher would actually type', () => {
  assert.equal(matchesQuery(row(), 'costco'), true);
  assert.equal(matchesQuery(row(), 'ATLANTA'), true);
  assert.equal(matchesQuery(row(), '30339'), true);
  assert.equal(matchesQuery(row(), '7174773'), true, 'a partial order number');
  assert.equal(matchesQuery(row(), 'winder'), false);
  // An empty query shows everything rather than nothing.
  for (const q of ['', '   ', null, undefined]) assert.equal(matchesQuery(row(), q), true);
  for (const junk of [null, undefined, {}]) assert.equal(matchesQuery(junk, 'x'), false);
});

test('the subtitle survives a row with holes', () => {
  assert.equal(rowSubtitle(row()), '2999 Cumberland Blvd · ATLANTA, GA · 1 pallet · 98 lbs');
  assert.equal(rowSubtitle(row({ itemsSummary: '—' })), '2999 Cumberland Blvd · ATLANTA, GA');
  assert.equal(rowSubtitle({}), '');
  assert.equal(rowSubtitle(null), '');
});

test('today is the BOARD\'s day, not the browser\'s', () => {
  // A dispatcher in another timezone must not open the bench on a different day than the
  // board is showing — the whole point is picking from the day production actually has.
  assert.equal(benchToday(new Date('2026-09-11T03:30:00Z')), '2026-09-10', 'still Sep 10 in ET');
  assert.equal(benchToday(new Date('2026-09-11T05:30:00Z')), '2026-09-11');
  assert.match(benchToday(), /^\d{4}-\d{2}-\d{2}$/);
});

test('the screen names the same cap the server enforces', () => {
  // The server is the authority; a screen that offered more than the server takes would send
  // a batch that is refused whole after the user picked it.
  const src = fs.readFileSync(path.join(HERE, '..', 'netlify', 'functions', 'uat-seed.mts'), 'utf8');
  const serverCap = Number(/const MAX_SEED = (\d+)/.exec(src)[1]);
  assert.equal(BENCH_MAX, serverCap, 'the screen and the endpoint must agree on the cap');
});
