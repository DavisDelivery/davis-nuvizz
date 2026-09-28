// test/pod-photo-pull-wrong-twin.test.mjs
//
// THE DEFECT (review 2026-09-03, A1-S3-7). "View delivery photos" re-pulls the order BY
// NUMBER. When two NuVizz records share that number (the Estes twin), the answer can be the
// OTHER order. The card's fold funnel (useLiveStop's onRefreshed) refuses such an answer and
// returns the refusal message — but the POD section threw that return value away, marked the
// pull as tried, and printed "No delivery photos on file for this order." That is a confident
// wrong answer: nothing was looked at for THIS order, and a dispatcher reading it stops asking
// the driver for the photo. The Refresh button beside it already showed the refusal; the POD
// pull now goes through the same rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { podPhotoPullOutcome, podPhotoFetchOffer } from '../src/lib/stop-card-sections.js';

const REFUSAL = 'NuVizz answered with the OTHER order carrying this number (id …bbbbbb), not the one on this card (…aaaaaa) — the card was NOT updated.';

test('a POD pull that answered with the other order sharing this number is shown as a refusal, not "no photos on file"', () => {
  const folded = [];
  const fold = (s) => { folded.push(s); return REFUSAL; };
  const out = podPhotoPullOutcome({ ok: true, stop: { stopId: 'b'.repeat(24), podDocs: [] } }, fold);
  assert.equal(folded.length, 1, 'the answer is still offered to the fold funnel, which owns the refusal');
  assert.equal(out.err, REFUSAL, 'the dispatcher is told why nothing changed');
  assert.equal(out.tried, false, 'the pull did NOT look at this order, so it may not count as tried');
  // And therefore the card cannot claim "none on file" off it.
  const stop = { podDocs: [{ documentName: 'BOL', extension: 'PDF' }] };
  assert.equal(podPhotoFetchOffer(stop, { tried: out.tried }).exhausted, false);
});

test('a POD pull that answered with this order counts as tried, so an empty answer reads "none on file"', () => {
  const out = podPhotoPullOutcome({ ok: true, stop: { stopId: 'a'.repeat(24), podDocs: [] } }, () => null);
  assert.deepEqual(out, { tried: true, err: null });
});

test('a POD pull NuVizz could not answer keeps its reason, and a missing reason reads "not found"', () => {
  assert.deepEqual(podPhotoPullOutcome({ ok: false, reason: 'scans_disabled' }, () => null), { tried: false, err: 'scans_disabled' });
  assert.deepEqual(podPhotoPullOutcome({ ok: true, stop: null }, () => null), { tried: false, err: 'not found' });
  assert.deepEqual(podPhotoPullOutcome(null, () => null), { tried: false, err: 'not found' });
});

test('a POD pull with no fold funnel wired (read-only card) still counts as tried', () => {
  assert.deepEqual(podPhotoPullOutcome({ ok: true, stop: { podDocs: [] } }, undefined), { tried: true, err: null });
});

test('the POD section acts on the fold funnel\'s answer instead of discarding it', () => {
  const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = APP.indexOf('function PodDocsSection(');
  assert.ok(start > 0, 'PodDocsSection not found in App.jsx');
  const body = APP.slice(start, APP.indexOf('\nfunction ', start + 1));
  assert.doesNotMatch(body, /setTried\(true\);\s*onRefreshed\?\.\(d\.stop\)/, 'the old discard-the-refusal line is gone');
  assert.match(body, /podPhotoPullOutcome\(d, onRefreshed\)/, 'the pull result goes through the shared rule');
});
