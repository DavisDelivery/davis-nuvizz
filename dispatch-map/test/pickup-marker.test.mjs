// test/pickup-marker.test.mjs
//
// A PICKUP MUST SAY SO, ON EVERY MARKER IT CAN DRAW.
//
// Chad, beside a screenshot of the NuVizz map where every marker is a red "P" or a cyan "D":
// "We are not id'ing pickups correctly like on the nuvizz map."
//
// He was right, and the cause is worth pinning permanently. stopMarkerIcon has set tag='PU'
// for a pickup since the mark was added, and there are TWO disc renderers: unplannedDotSvg
// named 'PU' in its tag arm, and circleMarkerSvg did not. Every pickup lands in
// circleMarkerSvg — the `!tag` guard on the unplanned branch sends a tagged stop away from
// the only renderer that knew the mark — so 'PU' arrived, matched neither 'AM' nor 'PM', and
// fell through to the plain centre dot. Meanwhile the size tier reads `tag ? 28 : 16`, so a
// pickup drew a BLANK 28px disc: the footprint this map reserves for a stop with a delivery
// window, carrying no information at all. The mark had never once rendered.
//
// Reading the source could not catch that and did not: the words 'PU' were all present, in
// two functions, and the bug was that only one of them was reachable. So these tests build
// REAL markers through the shipped pipeline and read the SVG the app hands Google Maps —
// the same standard the Estes marker tests were rewritten to in v0.97.3, for the same reason.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadStopMarkerPipeline } from './helpers/app-stop-marker.mjs';

const { stopMarkerIcon, google } = await loadStopMarkerPipeline();

const decode = (url) => decodeURIComponent(String(url).replace(/^data:image\/svg\+xml[^,]*,/, ''));
/** Every short text run the marker draws, e.g. ['4','PU'] for a route pin on a pickup. */
const letters = (icon) => [...decode(icon.url).matchAll(/>([^<>]{1,4})<\/text>/g)].map((m) => m[1].trim()).filter(Boolean);
const marksPickup = (icon) => letters(icon).includes('PU');

/** A pickup. `isPlanned` is what classifyStopStatus reads to tell SCHEDULED from UNPLANNED. */
const PU = (over = {}) => ({ stopNbr: '000111222', stopType: 'PU', lat: 34, lng: -84, isPlanned: true, status: '', ...over });
const DO_ = (over = {}) => ({ ...PU(over), stopType: 'DO' });

// Every marker a stop on this board can draw. Named for the real thing each one is.
const EVERY_BRANCH = [
  ['sitting in the unplanned pool', PU({ isPlanned: false }), null, {}],
  ['planned onto a load', PU(), null, {}],
  ['carrying an AM delivery window', PU(), { delivery_window: 'AM' }, {}],
  ['carrying an equipment restriction', PU(), { equipment_restrictions: ['no_tractor_trailer'] }, {}],
  ['sequenced inside an open route', PU(), null, { seq: 4, inRoute: true }],
  ['on a board with planned-muting on', PU(), null, { plannedMuted: true }],
  ['marked do-not-send', PU(), { do_not_send: true }, {}],
  ['selected by the dispatcher', PU(), null, { matched: true }],
  ['already collected (DELIVERED)', PU({ status: '90' }), null, {}],
];

for (const [what, stop, note, opts] of EVERY_BRANCH) {
  test(`a pickup ${what} is marked PU`, () => {
    const icon = stopMarkerIcon(google, stop, note, opts);
    assert.ok(marksPickup(icon), `drew [${letters(icon).join(',') || 'nothing'}] at ${icon.scaledSize.width}px`);
  });
}

test('THE REGRESSION: a pickup never draws a blank window-sized disc again', () => {
  // The exact shipped defect. 28px is the size reserved for an AM/PM window; a pickup wore it
  // with nothing written on it, so it read as "this stop has a time window" and then refused
  // to say which. Either it says PU, or it must not be claiming that footprint.
  for (const [what, stop, note, opts] of EVERY_BRANCH) {
    const icon = stopMarkerIcon(google, stop, note, opts);
    const blankAndBig = !marksPickup(icon) && icon.scaledSize.width >= 28;
    assert.equal(blankAndBig, false, `pickup ${what}`);
  }
});

test('a DELIVERY is not marked PU — the mark means something or it means nothing', () => {
  for (const [what, , note, opts] of EVERY_BRANCH) {
    const stop = DO_(what.includes('unplanned pool') ? { isPlanned: false } : (what.includes('collected') ? { status: '90' } : {}));
    const icon = stopMarkerIcon(google, stop, note, opts);
    assert.equal(marksPickup(icon), false, `delivery ${what} drew [${letters(icon).join(',')}]`);
  }
});

test('an AM window keeps the centre and the pickup keeps its identity — both are drawn', () => {
  // The old rule was "a delivery-window tag wins the slot", which quietly cost the stop its
  // type. A safety/timing mark should win the MIDDLE; it should not cost the stop what it IS.
  const icon = stopMarkerIcon(google, PU(), { delivery_window: 'AM' }, {});
  const t = letters(icon);
  assert.ok(t.includes('AM'), `expected the window in the centre, got [${t.join(',')}]`);
  assert.ok(t.includes('PU'), `expected the pickup badge, got [${t.join(',')}]`);
});

test('a route pin keeps its sequence number AND says PU', () => {
  const icon = stopMarkerIcon(google, PU(), null, { seq: 7, inRoute: true });
  const t = letters(icon);
  assert.ok(t.includes('7'), `expected the stop sequence, got [${t.join(',')}]`);
  assert.ok(t.includes('PU'), `expected the pickup badge, got [${t.join(',')}]`);
});

test('a pickup is never muted into the anonymous slate dot', () => {
  // Muting quiets "already planned, nothing to decide". At 14px there is no room for the mark
  // at all, so muting a pickup does not quiet it — it disguises it as an ordinary delivery.
  const muted = stopMarkerIcon(google, PU(), null, { plannedMuted: true });
  const mutedDelivery = stopMarkerIcon(google, DO_(), null, { plannedMuted: true });
  assert.ok(marksPickup(muted));
  assert.ok(muted.scaledSize.width > mutedDelivery.scaledSize.width,
    'a delivery still mutes — the carve-out is for pickups, not a way to switch muting off');
});

test('the badge does not double up: PU in the middle means no corner badge', () => {
  // Belt and braces on the drawing, because "wired but invisible" cuts both ways — a second
  // copy stacked on the first is just as much a rendering bug as none at all.
  const svg = decode(stopMarkerIcon(google, PU(), null, {}).url);
  assert.equal((svg.match(/>PU</g) || []).length, 1, svg);
});
