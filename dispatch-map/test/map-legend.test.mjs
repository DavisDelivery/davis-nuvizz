// The legend must describe THIS board and nothing else.
//
// Chad, on a 760-stop map: "only want it to display any icons that are currently on the map."
// The rules that make that true are not obvious — the marker layer hides marks in four
// different ways, and every one of them is a way for the legend to list something a
// dispatcher will never find out on the satellite. Each test below names the board condition
// it protects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  drawnRestrictionKeys,
  buildLegendInventory,
  emptyLegendInventory,
  iconClusterShape,
  pinTintKind,
  presentIconKeys,
  legendIsEmpty,
  TRAILER_BLOCKER_KEYS,
  tractorPaintAllowed,
  restrictionConfidence,
  confirmedBlockerKeys,
  isTrailerBlockerKey,
} from '../src/lib/map-legend.js';
import { readFileSync } from 'node:fs';
import { loadMarkerPipeline, markerSvg, fills } from './helpers/app-markers.mjs';

// ── WHICH ICONS A STOP ACTUALLY DRAWS ────────────────────────────────────────

test('an AM/PM delivery window takes the pin from the clock, so the clock is not on the map', () => {
  // The window IS the receiving-time statement. stopMarkerIcon drops the time mark so the
  // AM/PM tag can show; a legend that still listed the clock would send somebody hunting.
  const keys = ['liftgate_required', 'hours_early_close'];
  assert.deepEqual(drawnRestrictionKeys(keys, { deliveryWindow: 'AM' }), ['liftgate_required']);
  assert.deepEqual(drawnRestrictionKeys(keys, { deliveryWindow: 'PM' }), ['liftgate_required']);
  assert.deepEqual(drawnRestrictionKeys(keys, { deliveryWindow: null }), keys);
});

test('a dispatcher marking a stop tractor-OK removes the trailer blockers from the map', () => {
  const keys = ['no_tractor_trailer', 'liftgate_required', 'no_overhead_clearance'];
  assert.deepEqual(drawnRestrictionKeys(keys, { eligibility: 'tractor' }), ['liftgate_required']);
  // box_only overrules nothing — it agrees with the blockers.
  assert.deepEqual(drawnRestrictionKeys(keys, { eligibility: 'box_only' }), keys);
});

test('the alias resolver is honoured, or straight_truck_only survives a tractor-OK', () => {
  const resolve = (k) => (k === 'straight_truck_only' ? 'box_truck_only' : k);
  assert.ok(TRAILER_BLOCKER_KEYS.has('straight_truck_only'));
  assert.deepEqual(
    drawnRestrictionKeys(['straight_truck_only'], { eligibility: 'tractor', resolve }),
    [],
  );
});

test('a stop wearing a pin instead of its icons contributes no icons at all', () => {
  // do-not-send, a numbered pin inside an open route, and the already-planned mute all
  // REPLACE the icon cluster. Those marks are not on the map while that is true.
  assert.deepEqual(drawnRestrictionKeys(['no_tractor_trailer'], { hidden: true }), []);
});

test('junk in does not crash and does not invent marks', () => {
  for (const bad of [null, undefined, 'no_tractor_trailer', 0, {}]) {
    assert.deepEqual(drawnRestrictionKeys(bad, {}), []);
  }
  assert.deepEqual(drawnRestrictionKeys([null, undefined, '', 'liftgate_required'], {}), ['liftgate_required']);
  assert.deepEqual(drawnRestrictionKeys(['x']), ['x'], 'no opts at all is the same as no suppression');
});

// ── THE CLUSTER THE MARKER ACTUALLY PAINTS ───────────────────────────────────

test('a stop with four restrictions paints two icons and a +N, so only those two are on the map', () => {
  // The whole reason this is not a naive tally: the marker collapses 4+ to "first 2 + overflow".
  // Listing restrictions three and four would put marks in the key that appear nowhere.
  const inv = buildLegendInventory([
    { icons: ['no_tractor_trailer', 'liftgate_required', 'appointment_required', 'no_overhead_clearance'], note: null },
  ]);
  assert.deepEqual(Object.keys(inv.iconCounts).sort(), ['liftgate_required', 'no_tractor_trailer']);
  assert.equal(inv.shapes.overflow, 1);
  assert.equal(inv.shapes.single, 0);
});

test('cluster shapes match how the marker lays them out', () => {
  assert.equal(iconClusterShape(1), 'single');
  assert.equal(iconClusterShape(2), 'multi');
  assert.equal(iconClusterShape(3), 'multi');
  assert.equal(iconClusterShape(4), 'overflow');
  assert.equal(iconClusterShape(0), null);
  assert.equal(iconClusterShape(-1), null);
  assert.equal(iconClusterShape('nonsense'), null);
});

test('three restrictions all draw — the overflow starts at four', () => {
  const inv = buildLegendInventory([{ icons: ['a', 'b', 'c'], note: null }]);
  assert.deepEqual(Object.keys(inv.iconCounts).sort(), ['a', 'b', 'c']);
  assert.equal(inv.shapes.multi, 1);
});

// ── COUNTING A BOARD ─────────────────────────────────────────────────────────

test('a mark on one stop counts once, not once per restriction it shares a pin with', () => {
  const inv = buildLegendInventory([
    { icons: ['liftgate_required', 'liftgate_required'], note: null },
  ]);
  assert.equal(inv.iconCounts.liftgate_required, 1);
});

test('the three no-icon pin tints follow flagColor, so purple means the same on both', () => {
  assert.equal(pinTintKind({ priority_flag: 'red' }), 'red');
  assert.equal(pinTintKind({ equipment_restrictions: ['no_53ft'] }), 'restricted');
  assert.equal(pinTintKind({ liftgate_required: true }), 'restricted');
  assert.equal(pinTintKind({ appointment_required: true }), 'restricted');
  assert.equal(pinTintKind({ equipment_restrictions: [] }), 'plain');
  assert.equal(pinTintKind(null), 'plain');
  // A flag WINS over restrictions — same precedence as flagColor().
  assert.equal(pinTintKind({ priority_flag: 'yellow', liftgate_required: true }), 'yellow');
});

test('a pin-overridden stop still counts as a stop and still carries its flag colour', () => {
  // A do-not-send stop shows no restriction icons but its red flag is absolutely on the map.
  const inv = buildLegendInventory([
    { icons: [], note: { priority_flag: 'red', liftgate_required: true }, hidden: true },
  ]);
  assert.equal(inv.stops, 1);
  assert.equal(inv.hiddenByPin, 1);
  assert.equal(inv.withIcons, 0);
  assert.equal(inv.tints.red, 1);
  assert.deepEqual(inv.iconCounts, {});
});

test('an empty board is empty, and a board of plain stops is not', () => {
  assert.ok(legendIsEmpty(buildLegendInventory([])));
  assert.ok(legendIsEmpty(emptyLegendInventory()));
  assert.ok(legendIsEmpty(null));
  assert.ok(!legendIsEmpty(buildLegendInventory([{ icons: [], note: null }])));
});

test('the tractor-delivered tally counts stops, so the lime row can say whether any are lit', () => {
  const inv = buildLegendInventory([
    { icons: [], note: null, tractorDelivered: true },
    { icons: [], note: null, tractorDelivered: false },
    { icons: [], note: null },
  ]);
  assert.equal(inv.tractorDelivered, 1);
  assert.equal(inv.stops, 3);
});

test('rows that are not stops are skipped rather than counted as blank stops', () => {
  const inv = buildLegendInventory([null, undefined, 'x', 7, { icons: ['a'], note: null }]);
  assert.equal(inv.stops, 1);
  assert.deepEqual(buildLegendInventory(null), emptyLegendInventory());
});

// ── ORDERING ─────────────────────────────────────────────────────────────────

test('present icons keep the canonical display order, so filtering never reshuffles the key', () => {
  const order = ['no_tractor_trailer', 'liftgate_required', 'appointment_required', 'closed_monday'];
  const inv = buildLegendInventory([
    { icons: ['closed_monday'], note: null },
    { icons: ['liftgate_required'], note: null },
  ]);
  assert.deepEqual(presentIconKeys(inv, order), ['liftgate_required', 'closed_monday']);
});

test('a mark the map drew but the order does not list is still shown — that is the one to explain', () => {
  const inv = buildLegendInventory([{ icons: ['something_new'], note: null }]);
  assert.deepEqual(presentIconKeys(inv, ['no_tractor_trailer']), ['something_new']);
  assert.deepEqual(presentIconKeys(emptyLegendInventory(), ['a']), []);
  assert.deepEqual(presentIconKeys(null, ['a']), []);
});

// ── THE TRACTOR-DELIVERED LIME PAINT MUST NEVER OUTRANK A CURRENT "NO" ──────
//
// Chad, from the stop panel, with "No tractor trailer" checked in Equipment
// restrictions: "need a no tractor trailer override button that will override
// the green auto paint." tractor_locations is a sticky, automatic "a tractor
// delivered here once, ever" record that never un-flags itself — a dispatcher's
// CURRENT mark has to outrank that old history, not the other way around.

test('a hand-set box-only stop is never painted the tractor-delivered lime', () => {
  assert.equal(tractorPaintAllowed('box_only', []), false);
  assert.equal(tractorPaintAllowed('box_only', ['liftgate_required']), false);
});

test('a checked "No tractor trailer" restriction is never painted the tractor-delivered lime', () => {
  // This is the exact case from the screenshot: the chip is checked, nothing else changed.
  assert.equal(tractorPaintAllowed(null, ['no_tractor_trailer']), false);
  assert.equal(tractorPaintAllowed(null, ['no_tractor_trailer', 'liftgate_required']), false, 'still blocked alongside other badges');
});

test('an unrestricted stop, or one marked tractor-OK, still gets the lime paint', () => {
  assert.equal(tractorPaintAllowed(null, []), true);
  assert.equal(tractorPaintAllowed('tractor', []), true);
  // A hand-set "tractor OK" already drops no_tractor_trailer from the DRAWN set upstream
  // (drawnRestrictionKeys), so by the time this function sees it, it is correctly absent —
  // this function must not re-derive the same suppression from raw data a second way.
  assert.equal(tractorPaintAllowed('tractor', drawnRestrictionKeys(['no_tractor_trailer'], { eligibility: 'tractor' })), true);
});

test('other restrictions alone (liftgate, appointment, a clock) do not block the lime paint', () => {
  // Only the two "do not send a 53-footer here" signals block it. A liftgate requirement
  // says nothing about tractor eligibility and must not silently steal the tint too.
  assert.equal(tractorPaintAllowed(null, ['liftgate_required']), true);
  assert.equal(tractorPaintAllowed(null, ['appointment_required', 'hours_early_close']), true);
});

test('box_only and a checked "No tractor trailer" agree — both block, together or alone', () => {
  assert.equal(tractorPaintAllowed('box_only', ['no_tractor_trailer']), false);
});

// ── ONE FUNCTION, THREE CALL SITES — the shape of the bug that was fixed ─────
//
// The bug was never "the rule is wrong" — box_only already worked, on the plain pin. It was
// three copies of a two-line ternary that only two of them remembered to write correctly.
// These read the SHIPPED App.jsx source, because a fixture proves the rule once; only the
// source proves the fix actually reached every place that paints a stop.

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const STOP_MARKER_ICON = APP.slice(
  APP.indexOf('function stopMarkerIcon('),
  APP.indexOf('\n// Live-driver truck marker size'),
);

test('tractorPaintAllowed is imported, and stopMarkerIcon computes it exactly once', () => {
  assert.match(APP.slice(0, APP.indexOf('function stopMarkerIcon(')), /tractorPaintAllowed/,
    'tractorPaintAllowed must be imported from map-legend.js');
  const hits = STOP_MARKER_ICON.match(/tractorPaintAllowed\(/g) || [];
  assert.equal(hits.length, 1, 'computed once and reused — a second call site is how this drifts again');
});

test('the numbered route pin honors the override', () => {
  assert.match(STOP_MARKER_ICON, /routeColor \|\| \(\(tractorDelivered && !noTractorOverride\) \? TRACTOR_DELIVERED_COLOR/);
});

test('the plain pin honors the override', () => {
  assert.match(STOP_MARKER_ICON, /noTractorOverride \? eligColor/);
});

test('the restriction-icon cluster honors the override — this was the actual bug', () => {
  // Before the fix this line read `tractorDelivered ? TRACTOR_DELIVERED_COLOR : ...` with
  // no override check at all, so a checked "No tractor trailer" chip rendered its own
  // restriction icon tinted lime — the auto-paint literally painting over the manual mark
  // that exists specifically to contradict it.
  // Whitespace-tolerant: this pins the RULE (the override gates the lime on this call),
  // not the line wrapping — an earlier version of this assertion broke purely because the
  // call was reformatted onto multiple lines, which is a test grading the wrong thing.
  const call = STOP_MARKER_ICON.slice(STOP_MARKER_ICON.indexOf('iconMarkerSvg('));
  assert.match(call.replace(/\s+/g, ' '),
    /iconMarkerSvg\( restrictions, \(tractorDelivered && !noTractorOverride\) \? TRACTOR_DELIVERED_COLOR/);
});

// ── CONFIRMED vs ADVISORY — three things were rendering as one flat "no" ────
//
// Chad: "unless we have manually came in and marked it not tractor trailer with the
// override ... for the uline advisory and auto find no tractor trl tags ... make the icon
// half red or yellow then the other half green." A scanner's guess and a dispatcher's
// decision are not the same claim, and the note already records which is which.

test('a dispatcher who ticked the restriction list has CONFIRMED every blocker on it', () => {
  const note = { manual_overrides: { equipment_restrictions: true }, auto_sources: { no_tractor_trailer: ['addressLine2'] } };
  // Even though the scanner ALSO found it, the human override is the stronger claim.
  assert.equal(restrictionConfidence(note, 'no_tractor_trailer'), 'confirmed');
  assert.equal(restrictionConfidence(note, 'uline_straight_truck'), 'confirmed', 'the override promotes the Uline flag too');
});

test('a scanner-found no_tractor_trailer is ADVISORY until a human confirms it', () => {
  const note = { auto_sources: { no_tractor_trailer: ['addressLine2'] } };
  assert.equal(restrictionConfidence(note, 'no_tractor_trailer'), 'advisory');
});

test('the Uline flag is ADVISORY by definition — it is another company\'s free text', () => {
  // customer-notes-writer labels this source "Uline-supplied, advisory" in its own header.
  // It must not harden just because it has no auto_sources trail on this particular doc.
  assert.equal(restrictionConfidence({}, 'uline_straight_truck'), 'advisory');
  assert.equal(restrictionConfidence(null, 'uline_straight_truck'), 'advisory');
});

test('a hand-added flag with NO scanner trail counts as CONFIRMED — unknown goes the cautious way', () => {
  // Nobody but a person could have put it there. On the mark that decides whether a truck
  // can physically make the delivery, the unknown case belongs on the cautious side.
  assert.equal(restrictionConfidence({}, 'no_tractor_trailer'), 'confirmed');
  assert.equal(restrictionConfidence({ auto_sources: {} }, 'no_tractor_trailer'), 'confirmed');
  assert.equal(restrictionConfidence({ auto_sources: { no_tractor_trailer: [] } }, 'no_tractor_trailer'), 'confirmed',
    'an empty source list is not a detection');
});

test('confirmedBlockerKeys returns only the human-backed blockers', () => {
  const note = { auto_sources: { no_tractor_trailer: ['addressLine2'] } };
  // scanner-found no_tractor_trailer → advisory; hand-set no_53 → confirmed
  assert.deepEqual(confirmedBlockerKeys(note, ['no_tractor_trailer', 'no_53', 'liftgate_required']), ['no_53']);
  assert.deepEqual(confirmedBlockerKeys(note, ['no_tractor_trailer']), [], 'advisory only → nothing confirmed');
});

// ── WHAT THE SPLIT MEANS FOR THE LIME PAINT ─────────────────────────────────

test('an ADVISORY blocker does not veto the tractor-delivered lime — it earns the split ring', () => {
  // This is the whole point: "something says no, nobody has checked" is a THIRD state, and
  // flattening it into either yes or no throws away what the map actually knows.
  const note = { auto_sources: { no_tractor_trailer: ['addressLine2'] } };
  assert.equal(tractorPaintAllowed(null, ['no_tractor_trailer'], note), true);
  assert.equal(tractorPaintAllowed(null, ['uline_straight_truck'], note), true);
});

test('a CONFIRMED blocker still vetoes the lime, exactly as before', () => {
  const note = { manual_overrides: { equipment_restrictions: true } };
  assert.equal(tractorPaintAllowed(null, ['no_tractor_trailer'], note), false);
  // and a hand-added one with no scanner trail
  assert.equal(tractorPaintAllowed(null, ['no_tractor_trailer'], {}), false);
});

test('box-only is always a human choosing from a dropdown — always vetoes', () => {
  assert.equal(tractorPaintAllowed('box_only', [], { auto_sources: {} }), false);
  assert.equal(tractorPaintAllowed('box_only', ['no_tractor_trailer'], { manual_overrides: { equipment_restrictions: true } }), false);
});

test('the two-argument call still behaves as it did — no note, no provenance, treat as confirmed', () => {
  // stopMarkerIcon passes the note, but the old signature must not silently start
  // allowing lime on a stop it used to block.
  assert.equal(tractorPaintAllowed(null, ['no_tractor_trailer']), false);
  assert.equal(tractorPaintAllowed(null, []), true);
});

test('a non-blocker restriction never makes a stop advisory or blocked', () => {
  const note = { auto_sources: { liftgate_required: ['orderInstructions'] } };
  assert.equal(tractorPaintAllowed(null, ['liftgate_required'], note), true);
  assert.deepEqual(confirmedBlockerKeys(note, ['liftgate_required']), []);
});

// ── THE BLOCKER MARK: WHOLE DISC, AND HALF OF IT IS THE CONFIDENCE ───────────
//
// Chad, a day after the split RING shipped: "I want a full half and half icon."
//
// These marks draw at 20x22 CSS px, so a 3.4-wide ring split down the middle was a pixel and
// a half of red beside a pixel and a half of green — rendered at true size over a treeline, a
// parking lot and a grey roof, a confirmed mark and an advisory one could not be told apart on
// any of them. The disc carries it now: a CONFIRMED trailer blocker fills solid in the
// restriction's own colour, an ADVISORY one fills exactly half, and nothing else changes.
//
// These run the SHIPPED pipeline rather than grepping it (see test/helpers/app-markers.mjs).
// The old guards here were regexes over App.jsx source text, which pin the shape of the code
// and not the picture it draws — they would have gone green on a refactor that rendered
// something else entirely.

const P = await loadMarkerPipeline();
const RED = '#dc2626';        // no_tractor_trailer
const AMBER = '#f59e0b';      // uline_straight_truck
const GREEN = '#16a34a';      // ELIG_TRACTOR_COLOR — "a 53' trailer fits"
const LIME = '#32cd32';       // TRACTOR_DELIVERED_COLOR — proof a 53-footer has served this dock

const blocker = (keys, opts = {}) => markerSvg(P.iconMarkerSvg(keys, opts.tint ?? null, {
  blockerKeys: new Set(opts.blockers ?? keys),
  ...(opts.advisory ? { advisoryKeys: new Set(opts.advisory) } : {}),
}));

test('A CONFIRMED BLOCKER FILLS ITS WHOLE DISC — a person said no, and it is the loudest mark', () => {
  const svg = blocker(['no_tractor_trailer']);
  assert.ok(fills(svg).includes(RED), 'the disc is filled in the restriction colour');
  assert.ok(!fills(svg).includes(GREEN), 'a confirmed no has no green in it at all');
  assert.ok(!/fill="white"\s+fill-opacity/.test(svg), 'the old white disc is gone');
});

test('AN ADVISORY BLOCKER FILLS HALF — literally half of the confirmed mark', () => {
  const svg = blocker(['no_tractor_trailer'], { advisory: ['no_tractor_trailer'] });
  const f = fills(svg);
  assert.ok(f.includes(RED), 'half the restriction colour');
  assert.ok(f.includes(GREEN), 'half the eligibility green');
  assert.ok(f.indexOf(RED) < f.indexOf(GREEN), 'the warn half is drawn first (left)');
});

test('THE WARN HALF IS THE RESTRICTION COLOUR, NEVER THE STOP TINT', () => {
  // The defect that broke the first working build of v0.76.5, re-pinned against the disc.
  // A Uline advisory on a stop a tractor HAS delivered carries the lime tint; letting the
  // tint speak painted lime beside green — two greens, no split — in precisely the case the
  // feature exists for. A dispatcher would have read it as permission.
  const svg = blocker(['uline_straight_truck'], { advisory: ['uline_straight_truck'], tint: LIME });
  const f = fills(svg);
  assert.ok(f.includes(AMBER), 'the warn half is the restriction amber');
  assert.ok(f.includes(GREEN), 'the other half is the eligibility green');
  assert.ok(!f.includes(LIME), 'the tractor-delivered tint must not reach the disc');
});

test('restrictionWarnColor ignores the tint entirely — it takes only a key', () => {
  // If it ever grows a tint parameter the defect above walks straight back in.
  assert.equal(P.restrictionWarnColor.length, 1, 'one argument: the restriction key');
  assert.equal(P.restrictionWarnColor('no_tractor_trailer'), RED);
  assert.equal(P.restrictionWarnColor('uline_straight_truck'), AMBER);
});

test('the two halves sweep OPPOSITE ways, or one covers the other', () => {
  // Same start and end point; only the sweep flag makes them different halves. Both at 0
  // draws the same wedge twice and the second colour wins the whole disc.
  const svg = blocker(['no_tractor_trailer'], { advisory: ['no_tractor_trailer'] });
  assert.match(svg, /A18 18 0 0 0 20 38 Z/, 'one half sweeps 0');
  assert.match(svg, /A18 18 0 0 1 20 38 Z/, 'the other sweeps 1');
});

test('a filled disc keeps its white rim, or it disappears into the base map', () => {
  // Checked on a dark treeline and a bright parking lot: without the rim the red half sinks
  // into a brick roof and the green half into trees.
  for (const svg of [blocker(['no_tractor_trailer']), blocker(['no_tractor_trailer'], { advisory: ['no_tractor_trailer'] })]) {
    assert.match(svg, /stroke="white"/, 'the disc is rimmed in white');
  }
});

test('THE PROHIBITION STILL READS: a dark slash over a white truck', () => {
  // White is the only glyph colour that survives on both a red half and a green half — and
  // the slash has to stop being white with it, or the mark says "trailer" without saying "no".
  const svg = blocker(['no_tractor_trailer'], { advisory: ['no_tractor_trailer'] });
  assert.match(svg, /<line [^>]*stroke="#111827"/, 'the slash is ink, not the restriction colour');
  assert.ok(svg.indexOf('<line') > svg.indexOf('fill="#ffffff"'),
    'the slash is drawn OVER the white truck — underneath, the body swallows its middle');
  // THE TRUCK IS ONE WHITE SILHOUETTE. Two candidates were rendered at true size and put in
  // front of Chad — dark wheels, or wheels left white so the shape reads as a single mark. He
  // picked the silhouette ("i like h ink over"), and at 20px the wheels are under two pixels
  // across, where dark ones read as grit on the glyph rather than as running gear.
  const glyph = svg.slice(svg.indexOf('<g transform'));
  assert.ok(!/#dc2626|#f59e0b|#16a34a/.test(glyph), 'no restriction colour survives inside the glyph');
  const inkInGlyph = (glyph.match(/#111827/g) || []).length;
  assert.equal(inkInGlyph, 1, 'the only ink on the glyph is the slash — the wheels stay white');
});

test('THE GREEN HALF GOES BRIGHT WHEN A TRACTOR HAS ACTUALLY BEEN HERE', () => {
  // On an unconfirmed blocker, "a 53-footer has delivered to this dock before" is the best
  // counter-evidence a dispatcher has — it is what turns the mark into a decision instead of
  // a shrug. Under the white disc that proof rode on the truck, painted with the tint; a white
  // truck cannot carry it, so it moves to the half that already means "a trailer fits".
  const B = new Set(['no_tractor_trailer']);
  const plain = markerSvg(P.iconMarkerSvg(['no_tractor_trailer'], null, { blockerKeys: B, advisoryKeys: B }));
  const proven = markerSvg(P.iconMarkerSvg(['no_tractor_trailer'], null, { blockerKeys: B, advisoryKeys: B, tractorProven: true }));
  assert.ok(fills(plain).includes(GREEN), 'no proof → the eligibility green');
  assert.ok(fills(proven).includes(LIME), 'proof → the tractor-delivered lime');
  assert.ok(!fills(proven).includes(GREEN), 'one green or the other, never both');
  assert.ok(fills(proven).includes(RED), 'and the warn half is untouched either way');
});

test('the proof is a BOOLEAN — a priority flag hue can never become the "a trailer fits" half', () => {
  // The tint at the call site is `tractorDelivered ? LIME : (eligColor || flagHue)`. Handing
  // THAT to the disc would paint a priority flag's purple as the half that means a trailer is
  // fine — the v0.76.5 defect wearing a new coat. Only the proof itself may speak here.
  const B = new Set(['no_tractor_trailer']);
  const flagHue = '#a855f7';
  const svg = markerSvg(P.iconMarkerSvg(['no_tractor_trailer'], flagHue, { blockerKeys: B, advisoryKeys: B }));
  assert.ok(!fills(svg).includes(flagHue), 'no tint of any kind reaches a blocker disc');
  assert.ok(fills(svg).includes(GREEN) && fills(svg).includes(RED));
  // And a truthy-but-wrong value cannot switch it on.
  const sloppy = markerSvg(P.iconMarkerSvg(['no_tractor_trailer'], null, { blockerKeys: B, advisoryKeys: B, tractorProven: 'yes' }));
  assert.ok(fills(sloppy).includes(GREEN), 'only a real boolean true counts as proof');
});

test('ONLY TRAILER BLOCKERS FILL — every other restriction is untouched', () => {
  // Liftgate and appointment have no confidence to carry. If a blanket edit ever gives them
  // a filled disc, the board goes from a handful of loud marks to a field of them.
  for (const key of ['liftgate_required', 'appointment_required']) {
    const svg = markerSvg(P.iconMarkerSvg([key], null, {}));
    assert.match(svg, /fill="white" fill-opacity="0.95"/, `${key} keeps the white disc`);
    assert.ok(!fills(svg).includes(GREEN), `${key} must not gain an eligibility half`);
  }
});

test('a blocker looks like itself inside a CLUSTER too', () => {
  // A mark that changes meaning depending on how many neighbours it has is a mark nobody
  // can learn. The liftgate beside it must still be the plain white disc.
  const svg = blocker(['no_tractor_trailer', 'liftgate_required'], {
    blockers: ['no_tractor_trailer'], advisory: ['no_tractor_trailer'],
  });
  const f = fills(svg);
  assert.ok(f.includes(RED) && f.includes(GREEN), 'the blocker slot is split');
  assert.match(svg, /fill="white" fill-opacity="0.95"/, 'the liftgate slot keeps its white disc');
});

test('an ALIASED blocker still gets the treatment', () => {
  // straight_truck_only is an alias for box_truck_only. Matched raw against
  // TRAILER_BLOCKER_KEYS it would miss, and the stop would draw as an ordinary restriction
  // with no confidence on it at all — a scanner-found "no" presented as settled fact.
  assert.ok(TRAILER_BLOCKER_KEYS.has('straight_truck_only'));
  const svg = blocker(['straight_truck_only'], { advisory: ['straight_truck_only'] });
  assert.ok(fills(svg).includes(GREEN), 'the alias draws its advisory half');
});

test('the +N overflow badge never grows a disc', () => {
  // It carries no restriction of its own, so it has nothing to be confident about.
  const svg = markerSvg(P.iconMarkerSvg(['no_tractor_trailer', 'liftgate_required', 'appointment_required', 'hours_early_close'], null, {
    blockerKeys: new Set(['no_tractor_trailer']), advisoryKeys: new Set(['no_tractor_trailer']),
  }));
  assert.match(svg, /\+2</, 'four restrictions collapse to two plus a +2 badge');
  assert.match(svg, /stroke="#6b7280"/, 'the badge keeps its plain neutral stroke');
});

test('BOTH sets are part of the icon cache key', () => {
  // The disc is pixels. Confirming a restriction changes the disc and changes nothing else
  // in the key, so without this a stop keeps its stale half-and-half until the page reloads.
  assert.match(STOP_MARKER_ICON, /\[\.\.\.blockerKeys\]\.sort\(\)\.join/,
    'blockerKeys must be folded into cacheKey');
  assert.match(STOP_MARKER_ICON, /\[\.\.\.advisoryKeys\]\.sort\(\)\.join/,
    'advisoryKeys must be folded into cacheKey');
});

test('"NO 53FT" IS A TRAILER BLOCKER — the app wrote one spelling and every rule read another', () => {
  // The dispatcher's Equipment restrictions dropdown offers { value: 'no_53ft', label: 'No
  // 53ft' } and RESTRICTION_ICONS defines the glyph under `no_53ft`, so `no_53ft` is what
  // lands on a note. This set spelled it `no_53`, and nothing translated between them — so the
  // most literal "a 53-footer cannot come here" mark a dispatcher can tick landed in a set
  // that had never heard of it. Measured before the fix: confirmedBlockerKeys [] and
  // tractorPaintAllowed TRUE, i.e. the map kept painting the stop lime — "a tractor delivered
  // here" — on a stop a person had just said could not take one.
  assert.ok(TRAILER_BLOCKER_KEYS.has('no_53ft'), 'the spelling the app actually writes');
  assert.ok(TRAILER_BLOCKER_KEYS.has('no_53'), 'and the one already in stored notes and the solver');

  const ticked = { equipment_restrictions: ['no_53ft'], manual_overrides: { equipment_restrictions: true } };
  assert.equal(tractorPaintAllowed(null, ['no_53ft'], ticked), false,
    'a hand-ticked No 53ft must suppress the tractor-delivered lime');
  assert.deepEqual(confirmedBlockerKeys(ticked, ['no_53ft']), ['no_53ft']);

  // And it draws the mark, which it never did before.
  const svg = markerSvg(P.iconMarkerSvg(['no_53ft'], null, { blockerKeys: new Set(['no_53ft']) }));
  assert.ok(fills(svg).includes('#dc2626'), 'No 53ft fills its disc like any other blocker');
});

test('the marker and the paint rule agree about an ALIASED blocker', () => {
  // v0.76.4 merged these into one function precisely so a stop could not get two answers.
  // The marker resolves aliases before asking; if these helpers do not, a badge appears on the
  // pin that the paint rule has never heard of.
  const resolve = (k) => (k === 'straight_truck_only' ? 'box_truck_only' : k);
  const ticked = { manual_overrides: { equipment_restrictions: true } };
  assert.equal(tractorPaintAllowed(null, ['straight_truck_only'], ticked, resolve), false);
  assert.deepEqual(confirmedBlockerKeys(ticked, ['straight_truck_only'], resolve), ['straight_truck_only']);
  assert.ok(isTrailerBlockerKey('straight_truck_only', resolve));
  assert.ok(!isTrailerBlockerKey('liftgate_required', resolve));
});

test('confidence is read from the key AS WRITTEN, never the resolved one', () => {
  // auto_sources is stamped by the scanner under the raw key. Resolving it for the lookup
  // would read a field that does not exist, `scannerPutItThere` would be false, and every
  // aliased ADVISORY would be promoted to confirmed — a scanner guess presented as a person's
  // decision, on the mark that decides whether a truck can physically make the delivery.
  const resolve = (k) => (k === 'straight_truck_only' ? 'box_truck_only' : k);
  const scannerFound = { auto_sources: { straight_truck_only: ['addr1'] } };
  assert.equal(restrictionConfidence(scannerFound, 'straight_truck_only'), 'advisory');
  assert.deepEqual(confirmedBlockerKeys(scannerFound, ['straight_truck_only'], resolve), [],
    'a scanner-found alias stays advisory');
});

test('EVERY legend swatch carrying a blocker says so — including the shape rows', () => {
  // Caught by a sweep, not by looking: the "Restricted stops" rows demonstrate cluster SHAPE
  // (one / two-three / four-plus) and every one of them uses no_tractor_trailer as its
  // example. They passed no blockerKeys, so they built the pre-v0.78.0 white disc with a
  // coloured ring — a mark that now appears nowhere on the board. A legend that teaches a
  // mark the map does not draw is worse than no legend: it teaches the wrong thing with
  // authority, and it is the exact failure this panel was rewritten to avoid.
  const start = APP.indexOf('function MapLegendBody(');
  assert.ok(start > 0, 'found MapLegendBody');
  // To the next top-level declaration after it — the panel is the last thing in this block.
  const rest = APP.slice(start + 1);
  const nextDecl = rest.search(/\n(?:function|const) [A-Za-z]/);
  const body = nextDecl > 0 ? rest.slice(0, nextDecl) : rest;
  const calls = body.match(/<LegendMarkerExample[\s\S]*?\/>/g) || [];
  assert.ok(calls.length >= 3, `expected the shape rows and the confidence pair, found ${calls.length}`);
  for (const call of calls) {
    // Which examples carry a blocker? Either a literal key in the call, or one of the
    // module-level example arrays the call names.
    const namesBlocker = /no_tractor_trailer|LEGEND_CONFIRMED_EXAMPLE|restrictions=\{restrictions\}/.test(call);
    if (!namesBlocker) continue;
    assert.match(call, /blockerKeys=/,
      `a legend swatch draws a trailer blocker without declaring it:\n${call}`);
  }
});

test('THE LEGEND DEMONSTRATES THE MARK THE MAP DRAWS', () => {
  // A legend that disagrees with the map is worse than none — it teaches the wrong thing with
  // authority. Both swatches are built by this same iconMarkerSvg, so the only way they can
  // drift is if the legend forgets to say "this one is a blocker".
  const APP_SRC = APP.slice(APP.indexOf('function LegendMarkerExample('));
  assert.match(APP_SRC, /blockerKeys=\{LEGEND_BLOCKER_EXAMPLE\}[\s\S]{0,400}?blockerKeys=\{LEGEND_BLOCKER_EXAMPLE\}/,
    'both the confirmed and the advisory swatch declare themselves blockers');
  assert.ok(!/Half ring/.test(APP_SRC), 'the wording must not still describe a ring');
});
