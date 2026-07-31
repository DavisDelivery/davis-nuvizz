// test/freight-summary.test.mjs — ONE freight line on the stop card, never two.
//
// Chad, Jul 31, on the stop card's ITEMS section: "why are items listed twice — get rid of
// the second one and make the one a little bigger." The card printed the scan's itemsSummary
// ("3 pallets · 31 loose · 34 pieces · 862 Lbs") and then a breakdown of the same three
// fields underneath ("3 pallets  31 loose pcs  34 total pieces") — the same numbers twice, in
// two different phrasings.
//
// The summary is the better line (same numbers PLUS the weight), but it is computed once by
// the SCAN and never recomputed by enrichment. A stop whose freight arrived only through a
// detailed lookup can therefore carry real cartons/volume/pallets behind a '—' summary, so
// deleting the breakdown outright would have blanked the freight on exactly those stops.
// These pin the fallback that stops that happening.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// App.jsx is a React module; lift the pure helper out rather than importing the whole app.
const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const fnSrc = src.slice(src.indexOf('export function freightSummaryLine'));
const freightSummaryLine = new Function(`${fnSrc.slice(0, fnSrc.indexOf('\n}') + 2).replace('export function', 'return function')}`)();

test("Chad's stop: the scan summary is used as-is — it already carries the weight", () => {
  assert.equal(
    freightSummaryLine({ itemsSummary: '3 pallets · 31 loose · 34 pieces · 862 Lbs', cartons: 3, volume: 31, pallets: 34 }),
    '3 pallets · 31 loose · 34 pieces · 862 Lbs',
  );
});

test('an enriched stop whose scan summary is blank still shows its freight (the fallback)', () => {
  // The case that made a blind delete unsafe: enrichment filled the fields, the summary is '—'.
  assert.equal(freightSummaryLine({ itemsSummary: '—', cartons: 3, volume: 31, pallets: 34, weight: 862 }),
    '3 pallets · 31 loose · 34 pieces · 862 lbs');
  assert.equal(freightSummaryLine({ cartons: 1, volume: 0, pallets: 1 }), '1 pallet · 1 piece', 'singular, and zeros omitted');
  assert.equal(freightSummaryLine({ itemsSummary: '', volume: 2 }), '2 loose');
});

test('a stop with no freight at all yields nothing — the card shows its own dash', () => {
  assert.equal(freightSummaryLine({}), '');
  assert.equal(freightSummaryLine({ itemsSummary: '—' }), '');
  assert.equal(freightSummaryLine({ itemsSummary: '  ', cartons: 0, volume: 0, pallets: 0 }), '');
  assert.equal(freightSummaryLine(null), '');
});

test('string-typed numbers still count — the fields are not always numeric', () => {
  assert.equal(freightSummaryLine({ cartons: '3', volume: '31', pallets: '34' }), '3 pallets · 31 loose · 34 pieces');
});
