// THE SHIPLIFY PINS AND THE PLACE MARKS, BUILT THROUGH stopMarkerIcon AND READ BACK.
//
// Every assertion here builds the marker the app would hand Google Maps and reads the SVG — the
// hollow lime ring, the dock dot, the forklift and the place glyph in each of its forms. No
// source greps: a regex over App.jsx pins the words, not the picture (see helpers/app-markers.mjs).
// Synthetic stops only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStopMarkerIcon, markerSvg } from './helpers/app-markers.mjs';

const icon = await loadStopMarkerIcon();
const LIME = '#32CD32';
const INK = '#1f2937';

let seq = 0;
// A plain stop at an ordinary street address (no address-off token), unique number each time so
// a test never reads another test's stop.
const stop = (o = {}) => ({
  stopNbr: String(7000000 + (++seq)), stopType: 'DO', lat: 34.1, lng: -84.0,
  addr1: '100 Sample Pkwy', zip: '30000', matchKey: `test_${seq}`, isPlanned: false, status: '', ...o,
});
const scheduled = (o = {}) => stop({ isPlanned: true, ...o });
const DOCK = { dock_access: 'yes', forklift: '', location_types: ['Distribution Center'], tariff_items: [] };
const FORKLIFT = { dock_access: 'no', forklift: 'yes', location_types: ['Commercial'], tariff_items: [] };
const NEITHER = { dock_access: 'no', forklift: 'no', location_types: ['Commercial'], tariff_items: [] };
const on = (rec, o = {}) => ({ shiplifyOn: true, shiplifyRec: rec, tractorSeen: false, tractorKnown: true, ...o });

const svgOf = (s, note = null, opts = {}) => markerSvg(icon(s, note, opts));
const hollowLime = (svg) => /<circle cx="14" cy="14" r="12\.5" fill="#ffffff" stroke="#32CD32" stroke-width="3"\/>/.test(svg);
const limeCentreDot = (svg) => /<circle cx="14" cy="14" r="4\.5" fill="#32CD32"\/>/.test(svg);
const dockRestingDot = (svg) => /<circle cx="12" cy="12" r="11" fill="#32CD32"/.test(svg) && /<circle cx="12" cy="12" r="8" fill="#ffffff"\/>/.test(svg);
const glyphGroup = (svg, kind, form) => {
  const m = new RegExp(`<g data-glyph="${kind}" data-form="${form}"[^>]*>([\\s\\S]*?)</g>(?:</g>)?`).exec(svg);
  return m ? m[0] : null;
};
const isDockPin = (s, note, opts) => {
  const svg = svgOf(s, note, opts);
  return dockRestingDot(svg) || (hollowLime(svg) && limeCentreDot(svg));
};
const isForkliftPin = (s, note, opts) => {
  const svg = svgOf(s, note, opts);
  return hollowLime(svg) && !!(glyphGroup(svg, 'forklift', 'center') || glyphGroup(svg, 'forklift', 'badge'));
};
const anyShiplifyPin = (svg) => hollowLime(svg) || dockRestingDot(svg) || /data-glyph="forklift"/.test(svg);

// ── the two pins ──────────────────────────────────────────────────────────────

test('Shiplify dock yes draws the dock pin: a lime ring round a white core at rest, a hollow lime ring with the lime dot when scheduled', () => {
  const rest = icon(stop(), null, on(DOCK));
  assert.ok(dockRestingDot(markerSvg(rest)), 'unplanned: lime ring, white core');
  assert.equal(rest.scaledSize.width, 16, 'the dock pin keeps the resting dot size');
  const sch = svgOf(scheduled(), null, on(DOCK));
  assert.ok(hollowLime(sch) && limeCentreDot(sch), 'scheduled: hollow lime ring, 3px, with the lime centre dot');
});

test('dock no with forklift yes draws the forklift pin; dock no with no forklift draws neither', () => {
  assert.ok(isForkliftPin(stop(), null, on(FORKLIFT)));
  assert.ok(isForkliftPin(scheduled(), null, on(FORKLIFT)));
  for (const s of [stop(), scheduled()]) {
    const svg = svgOf(s, null, on(NEITHER));
    assert.ok(!anyShiplifyPin(svg), 'no dock and no forklift is not a pin');
  }
});

test('the forklift pin: 22px, leaves the resting dot, and the forklift is #1f2937 in the middle', () => {
  const ic = icon(stop(), null, on(FORKLIFT));
  assert.equal(ic.scaledSize.width, 22);
  const svg = markerSvg(ic);
  assert.ok(!/r="11"/.test(svg), 'not the 16px resting dot');
  const g = glyphGroup(svg, 'forklift', 'center');
  assert.ok(g, 'forklift in the middle');
  assert.match(g, new RegExp(`fill="${INK}"`), 'dark forklift — lime on white is too faint for a detailed shape');
  assert.match(g, /fill="#ffffff"/, 'hub cut-outs in the body colour');
});

test('when PU, AM/PM or a house owns the middle of a forklift pin, the forklift moves to the bottom-left badge, in lime', () => {
  const pu = svgOf(stop({ stopType: 'PU' }), null, on(FORKLIFT));
  assert.match(pu, />PU<\/text>/, 'PU keeps the middle');
  assert.match(pu, new RegExp(`fill="${INK}"[^>]*>PU<`), 'the PU on a hollow lime pin is #1f2937');
  const badge = glyphGroup(pu, 'forklift', 'badge');
  assert.ok(badge && /data-corner="bl"/.test(badge), 'bottom left');
  assert.match(badge, /<circle cx="6\.5" cy="21\.5" r="6\.5" fill="#0f172a" stroke="#ffffff" stroke-width="1\.4"\/>/);
  assert.match(badge, new RegExp(`fill="${LIME}"`), 'the forklift on its badge is lime');
  assert.match(badge, /translate\(6\.5 21\.5\) scale\(0\.44\) translate\(-14\.3 -14\)/);

  const am = svgOf(stop(), { delivery_window: 'AM' }, on(FORKLIFT));
  assert.match(am, new RegExp(`fill="${INK}"[^>]*>AM<`), 'AM in #1f2937');
  assert.ok(glyphGroup(am, 'forklift', 'badge'));
});

test('residential plus forklift: the dark house in the middle and the forklift badge', () => {
  const svg = svgOf(stop(), null, on({ ...FORKLIFT, tariff_items: ['RES'] }));
  const house = glyphGroup(svg, 'residential', 'center');
  assert.ok(house, 'house in the middle');
  assert.match(house, new RegExp(`fill="${INK}"`));
  assert.ok(glyphGroup(svg, 'forklift', 'badge'), 'forklift badge');
  assert.ok(hollowLime(svg));
});

test('every suppression, one at a time, for both pins', () => {
  const cases = {
    'lime by key': [stop(), null, { tractorDelivered: true, tractorSeen: true }],
    'lime by street + ZIP under another name': [stop(), null, { tractorSeen: true }],
    'Vehicle: Tractor-trailer OK': [stop(), { vehicle_eligibility: 'tractor' }, {}],
    'Vehicle: Box truck only': [stop(), { vehicle_eligibility: 'box_only' }, {}],
    'confirmed no-trailer blocker': [stop(), { equipment_restrictions: ['no_tractor_trailer'], manual_overrides: { equipment_restrictions: true } }, {}],
    school: [stop(), { building_type: 'school' }, {}],
    church: [stop(), { building_type: 'church' }, {}],
    government: [stop(), { building_type: 'government' }, {}],
    'priority flag': [stop(), { priority_flag: 'red' }, {}],
    '? flag': [scheduled(), { priority_flag: 'question' }, {}],
    selection: [stop(), null, { matched: true }],
    'search hit': [stop(), null, { searchMatched: true }],
    'open route card': [scheduled(), null, { inRoute: true, seq: 3 }],
    'planned-muted': [scheduled(), null, { plannedMuted: true }],
    Estes: [stop({ stopNbr: 'ESTES-0000000001' }), null, {}],
    'live: delivered': [scheduled({ status: '90' }), null, {}],
    'live: out for delivery': [scheduled({ status: '40' }), null, {}],
    'restriction cluster': [stop(), { liftgate_required: true }, {}],
    'address looks off': [stop({ addr1: 'SUITE 200', addr2: '5 Fake St' }), null, {}],
    'do not send': [stop(), { do_not_send: true }, {}],
    'switch off': [stop(), null, { shiplifyOn: false }],
    'tractor record not loaded': [stop(), null, { tractorKnown: false }],
  };
  for (const rec of [DOCK, FORKLIFT]) {
    // Sanity: the same stop WITHOUT the suppression does draw the pin.
    assert.ok(anyShiplifyPin(svgOf(stop(), null, on(rec))), 'baseline draws');
    for (const [why, [s, note, extra]] of Object.entries(cases)) {
      const svg = svgOf(s, note, on(rec, extra));
      assert.ok(!hollowLime(svg) && !dockRestingDot(svg) && !glyphGroup(svg, 'forklift', 'center') && !glyphGroup(svg, 'forklift', 'badge'),
        `${rec === DOCK ? 'dock' : 'forklift'} pin must not draw: ${why}`);
    }
  }
});

test('once a tractor delivers, the lime paint takes over and the pin fills in', () => {
  const svg = svgOf(stop(), null, on(DOCK, { tractorDelivered: true, tractorSeen: true }));
  assert.match(svg, /<circle cx="12" cy="12" r="8" fill="#32CD32"\/>/, 'the filled lime dot');
});

// ── the place marks ───────────────────────────────────────────────────────────

const KINDS = ['residential', 'school', 'church', 'government'];

test('each place mark, centre form: the glyph replaces the white dot, in the readable colour, cut-outs in the body colour', () => {
  for (const k of KINDS) {
    const svg = svgOf(scheduled(), { building_type: k });
    const g = glyphGroup(svg, k, 'center');
    assert.ok(g, `${k} in the middle`);
    assert.match(g, /fill="#ffffff"/, `${k}: white on the blue scheduled disc`);
    assert.ok(!/<circle cx="14" cy="14" r="4\.5" fill="white"\/>/.test(svg), 'the white centre dot is gone');
  }
});

test('each place mark, badge form: on a route pin and on the do-not-send ✕, bottom right', () => {
  for (const k of KINDS) {
    const route = svgOf(scheduled(), { building_type: k }, { inRoute: true, seq: 4 });
    assert.match(route, />4<\/text>/, 'the sequence number keeps the middle');
    const b = glyphGroup(route, k, 'badge');
    assert.ok(b && /data-corner="br"/.test(b), `${k} badge bottom right`);
    assert.match(b, /<circle cx="21\.5" cy="21\.5" r="6\.5" fill="#0f172a" stroke="#ffffff" stroke-width="1\.4"\/>/);
    assert.match(b, /translate\(21\.5 21\.5\) scale\(0\.44\) translate\(-14 -14\)/);
    const dns = svgOf(stop(), { building_type: k, do_not_send: true });
    assert.ok(glyphGroup(dns, k, 'badge'), `${k} rides the DNS ✕`);
  }
});

test('each place mark, muted form: the planned-muted ring carries the glyph in slate', () => {
  for (const k of KINDS) {
    const ic = icon(scheduled(), { building_type: k }, { plannedMuted: true });
    assert.equal(ic.scaledSize.width, 14, 'still the quiet 14px ring');
    const g = glyphGroup(markerSvg(ic), k, 'muted');
    assert.ok(g, `${k} muted`);
    assert.match(g, /fill="#64748b"/);
    assert.match(g, /translate\(14 14\) scale\(0\.8\) translate\(-14 -14\)/);
  }
});

test('each place mark, restriction-cluster form: a badge at the bottom right of the last disc', () => {
  for (const k of KINDS) {
    const one = svgOf(stop(), { building_type: k, liftgate_required: true });
    const g = glyphGroup(one, k, 'cluster');
    assert.ok(g, `${k} on a one-icon cluster`);
    assert.match(g, /r="8\.5" fill="#0f172a" stroke="#ffffff" stroke-width="2"/);
    assert.match(g, /scale\(0\.7\)/);
    const two = svgOf(stop(), { building_type: k, liftgate_required: true, appointment_required: true });
    assert.ok(glyphGroup(two, k, 'cluster'), `${k} on a two-icon cluster`);
  }
});

test('a place mark takes the 22px tag size, and an unplanned one leaves the 16px dot', () => {
  assert.equal(icon(scheduled(), { building_type: 'church' }).scaledSize.width, 22);
  const un = icon(stop(), { building_type: 'church' });
  assert.equal(un.scaledSize.width, 22);
  assert.ok(!/r="11"/.test(markerSvg(un)), 'not the resting dot');
});

test('PU keeps the middle; the place mark becomes the badge', () => {
  const svg = svgOf(scheduled({ stopType: 'PU' }), { building_type: 'school' });
  assert.match(svg, />PU<\/text>/);
  assert.ok(glyphGroup(svg, 'school', 'badge'));
});

test('an Estes disc carries the mark too — white on the black disc, inside the yellow ring', () => {
  const svg = svgOf(stop({ stopNbr: 'ESTES-0000000002' }), { building_type: 'government' });
  assert.match(svg, /stroke="#facc15"/);
  const g = glyphGroup(svg, 'government', 'center');
  assert.ok(g && /fill="#ffffff"/.test(g));
});

test('a dispatcher-set type beats Shiplify; "None" hides Shiplify\'s; dispatcher types show with the switch off', () => {
  const church = { ...NEITHER, location_types: ['Place of Worship'] };
  assert.ok(glyphGroup(svgOf(scheduled(), { building_type: 'school' }, on(church)), 'school', 'center'));
  const none = svgOf(scheduled(), { building_type: 'none' }, on(church));
  assert.ok(!/data-glyph=/.test(none), 'None: no mark at all');
  const off = svgOf(scheduled(), { building_type: 'government' }, { shiplifyOn: false, shiplifyRec: church });
  assert.ok(glyphGroup(off, 'government', 'center'), 'a dispatcher type needs no switch');
  const offShiplify = svgOf(scheduled(), null, { shiplifyOn: false, shiplifyRec: church });
  assert.ok(!/data-glyph=/.test(offShiplify), 'Shiplify\'s type needs the switch');
});

test('Shiplify\'s multi-type rows: school, then church, then government, then residential', () => {
  const both = { ...NEITHER, location_types: ['Place of Worship', 'School'], tariff_items: ['RES'] };
  assert.ok(glyphGroup(svgOf(scheduled(), null, on(both)), 'school', 'center'));
  const gov = { ...NEITHER, location_types: ['Courthouse'], tariff_items: ['RES'] };
  assert.ok(glyphGroup(svgOf(scheduled(), null, on(gov)), 'government', 'center'));
});

test('a school, church or government stop draws no restriction icon — the place mark is the signal', () => {
  const svg = svgOf(scheduled(), { building_type: 'school' });
  assert.ok(!/<svg[^>]*width="40"/.test(svg), 'no restriction cluster');
  const ic = icon(scheduled(), { building_type: 'school' });
  assert.equal(ic.scaledSize.width, ic.scaledSize.height, 'a disc, not an icon cluster');
});

// ── the icon cache ────────────────────────────────────────────────────────────

test('two stops that differ ONLY by place mark, dock pin or forklift pin get different icons', () => {
  const base = { stopNbr: '7999001', stopType: 'DO', lat: 34, lng: -84, addr1: '1 Fake St', zip: '30000', isPlanned: false, status: '' };
  const plain = icon({ ...base, matchKey: 'a' }, null, on(null));
  const dock = icon({ ...base, matchKey: 'b' }, null, on(DOCK));
  const fork = icon({ ...base, matchKey: 'c' }, null, on(FORKLIFT));
  const school = icon({ ...base, matchKey: 'd' }, { building_type: 'school' }, on(null));
  const church = icon({ ...base, matchKey: 'e' }, { building_type: 'church' }, on(null));
  const urls = [plain, dock, fork, school, church].map((i) => i.url);
  assert.equal(new Set(urls).size, 5, 'five different pictures');
  // And in the other order, so a missing key field cannot hide behind render order.
  const school2 = icon({ ...base, matchKey: 'f' }, { building_type: 'school' }, on(null));
  const plain2 = icon({ ...base, matchKey: 'g' }, null, on(null));
  assert.notEqual(school2.url, plain2.url);
});

test('with no Shiplify data and no Building type, every pin is byte-identical to before', () => {
  // The trial is additive: absent the data, the map draws exactly what it drew.
  const s = scheduled();
  assert.equal(icon(s, null, {}).url, icon(s, null, on(null)).url);
});

test('muted AS DRAWN: a planned pickup on Routing is a full pin, so it can carry the Shiplify pin', () => {
  // stopMarkerIcon never mutes a pickup, so "not planned-muted" must mean the ring actually drawn.
  const svg = svgOf(scheduled({ stopType: 'PU' }), null, on(DOCK, { plannedMuted: true }));
  assert.ok(hollowLime(svg), 'the planned pickup keeps its hollow lime dock pin');
  const muted = svgOf(scheduled(), null, on(DOCK, { plannedMuted: true }));
  assert.ok(!hollowLime(muted) && !dockRestingDot(muted), 'a planned delivery is muted and draws no pin');
});
