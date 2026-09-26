// Step 4 · Engine · "Fill my loads" under the BUILD RULES (Chad, 2026-09-26: "A" — the empty
// loads he ticks in 2 · Plan onto, filled from whatever is still unplanned, "fixed to follow
// the Build rules"). Each test names the real-world failure it stops:
//   • a red Box-only stop on a 53' (a refused door) — and a green one kept off it
//   • "only green on a 53'" — the JOHN-plus-two-tractors board from the same evening
//   • a liftgate customer on a truck with no gate (a redelivery)
//   • a tractor under-filled to a fleet average while freight is called "needs another truck"
//   • a half-full load handed a whole truck's worth on top
//   • a dock that shuts before the truck gets there
// and that FILL_MY_LOADS_BUILD_RULES=off puts every one of them back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildCleanupPlan, fillMyLoadsBuildRules } from '../netlify/functions/lib/routing-cleanup-core.mts';
import { liveMatchKey } from '../netlify/functions/lib/routing-draft-core.mts';
import { engineConfigDefaults } from '../netlify/functions/lib/routing-engine-config.mts';

const CFG = engineConfigDefaults({});
const D = '2026-08-27'; // a Thursday

const inputs = (notes = new Map()) => ({
  driverDaysBefore: [], referencesBefore: [],
  serviceDocByKey: new Map(), fleetServiceDoc: null, habitDocByKey: new Map(),
  notesRestrictions: new Map([...notes].map(([k, n]) => [k, n.equipment_restrictions || []])),
  noteByKey: notes, tractorCapable: new Set(), employees: [],
});
const row = (nbr, o = {}) => ({
  stopNbr: nbr, isUnplanned: o.planned ? false : true, isPlanned: !!o.planned,
  businessName: o.name || `BIZ ${nbr}`, addr1: `${nbr} Main St`, city: o.city || 'Buford', zip: '30518',
  lat: o.lat ?? 34.08 + (Number(String(nbr).replace(/\D/g, '')) % 5) * 0.02,
  lng: o.lng ?? -84.02 - (Number(String(nbr).replace(/\D/g, '')) % 3) * 0.02,
  cartons: o.skids ?? 2, volume: o.loose ?? 0, pallets: o.skids ?? 2, weight: o.weight ?? 500,
  timeConstraint: null, ...o.raw,
});
const BOX = { tractor: false, liftgate: true, lengthClassFt: 26, overheadClearance: true };
const TRL = { tractor: true, liftgate: false, lengthClassFt: 53, overheadClearance: true };
const shell = (key, o = {}) => ({
  key, name: key, loadNbr: `L-${key}`, loadId: null,
  truck_class: o.tractor ? 'tractor' : 'box_truck',
  max_skids: o.maxSkids ?? (o.tractor ? 28 : 14), max_weight_lb: o.maxLb ?? (o.tractor ? 30000 : 10000),
  liftgate: o.liftgate ?? !o.tractor,
  capabilities: o.caps ?? (o.tractor ? TRL : { ...BOX, liftgate: o.liftgate ?? true }),
  existing_stop_nbrs: o.existing ?? null,
  driver_user_name: null,
});
const plan = (rows, trucks, extra = {}) => buildCleanupPlan('davis', D, {
  cfg: CFG, inputs: extra.inputs || inputs(), liveStops: rows, meta: null, trucks,
  nowIso: '2026-08-27T01:00:00Z', ...extra,
});
const truckOf = (p, id) => p.trucks.find((t) => t.stops.some((s) => s.stopNbr === id));
const notesFor = (rows, byNbr) => new Map(Object.entries(byNbr).map(([nbr, note]) => [liveMatchKey(rows.find((r) => r.stopNbr === nbr)), note]));

test('the switch has the house shape: on by default, an explicit off-word turns it off, a typo leaves it ON', () => {
  assert.equal(fillMyLoadsBuildRules({}), true);
  for (const off of ['off', 'OFF ', '0', 'false', 'no']) assert.equal(fillMyLoadsBuildRules({ FILL_MY_LOADS_BUILD_RULES: off }), false, off);
  for (const on of ['of', 'yes', 'on', '1', 'maybe']) assert.equal(fillMyLoadsBuildRules({ FILL_MY_LOADS_BUILD_RULES: on }), true, on);
});

test('the answer SAYS which rules ran — a panel can never claim rules that did not apply', () => {
  const rows = [row('U1')];
  assert.equal(plan(rows, [shell('A')]).rules, 'build', 'default is the Build rules');
  assert.equal(plan(rows, [shell('A')], { rules: 'engine' }).rules, 'engine');
  const p = plan(rows, [shell('A')], { tractorOnlyGreen: true, windowMode: 'strict' });
  assert.deepEqual(p.rules_detail, { tractor_only_green: true, window_mode: 'strict', time_restrictions: true });
});

test('ONE RULE, TWO BUILDERS: the Build button and Fill my loads import the same equipment rule', () => {
  const build = readFileSync(new URL('../netlify/functions/routing-build-background.mts', import.meta.url), 'utf8');
  const cleanup = readFileSync(new URL('../netlify/functions/lib/routing-cleanup-core.mts', import.meta.url), 'utf8');
  for (const [name, src] of [['Build', build], ['Fill my loads', cleanup]]) {
    assert.match(src, /import \{[^}]*equipmentReqsFrom[^}]*\} from '\.\/(lib\/)?routing-equipment\.mts'/, `${name} imports the shared rule`);
    assert.doesNotMatch(src, /function equipmentReqsFrom/, `${name} keeps no private copy`);
  }
});

test('a RED Box-only stop never rides a 53′ — the engine used to let it (it read only the restriction list)', () => {
  const rows = [row('R1', { name: 'RED DOCK' }), row('U1')];
  const inp = inputs(notesFor(rows, { R1: { vehicle_eligibility: 'box_only' } }));
  const p = plan(rows, [shell('TRL', { tractor: true })], { inputs: inp });
  const l = p.left_unplanned.find((s) => s.stopNbr === 'R1');
  assert.equal(l?.reason, 'equipment');
  assert.match(l.detail, /needs straight\/box truck \(no tractor-trailer\) — none of the loads you picked can take it/);
  assert.ok(!truckOf(p, 'R1'));
  // The gap this closes, pinned so it is visible: the engine's own rule put it on the trailer.
  const old = plan(rows, [shell('TRL', { tractor: true })], { inputs: inp, rules: 'engine' });
  assert.ok(truckOf(old, 'R1'), 'engine rules (switch off) still behave as before');
});

test('a GREEN Tractor-OK mark lifts an auto-detected blocker — green wins, exactly as on the Build button', () => {
  const rows = [row('G1', { name: 'GREEN DOCK' })];
  const inp = inputs(notesFor(rows, { G1: { vehicle_eligibility: 'tractor', equipment_restrictions: ['no_tractor_trailer'] } }));
  const p = plan(rows, [shell('TRL', { tractor: true })], { inputs: inp });
  assert.equal(truckOf(p, 'G1')?.key, 'TRL', 'a dispatcher said a 53′ fits here');
  const old = plan(rows, [shell('TRL', { tractor: true })], { inputs: inp, rules: 'engine' });
  assert.equal(old.left_unplanned[0]?.reason, 'equipment', 'the engine rule kept it off');
});

test('"ONLY GREEN ON A 53′": the JOHN + two tractors board — unmarked stops hold to the box, green ones use the trailers', () => {
  // Chad, same evening: one box (JOHN) and two tractors; the trailers came back empty. Under the
  // Build rules with the toggle ON, only green rides a 53′ — so the tractors get the green
  // freight and JOHN gets the rest, up to his profile.
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => row(`G${i}`, { name: `GREEN ${i}`, skids: 3, weight: 900 })),
    ...Array.from({ length: 5 }, (_, i) => row(`N${i}`, { name: `PLAIN ${i}`, skids: 2, weight: 600 })),
  ];
  const marks = Object.fromEntries(rows.filter((r) => r.stopNbr.startsWith('G')).map((r) => [r.stopNbr, { vehicle_eligibility: 'tractor' }]));
  const inp = inputs(notesFor(rows, marks));
  const trucks = [shell('JOHN'), shell('TRL A', { tractor: true }), shell('TRL B', { tractor: true })];
  const p = plan(rows, trucks, { inputs: inp, tractorOnlyGreen: true });
  for (const r of rows.filter((x) => x.stopNbr.startsWith('N'))) {
    const t = truckOf(p, r.stopNbr);
    assert.ok(!t || t.key === 'JOHN', `${r.stopNbr} is not green and rode ${t?.key}`);
  }
  const onTrailers = p.trucks.filter((t) => t.truck_class === 'tractor').reduce((a, t) => a + t.stop_count, 0);
  assert.ok(onTrailers > 0, 'the trailers are used for the green freight — not left idle');
  for (const t of p.trucks) assert.ok(t.skid_equiv <= t.cap.skids + 1e-9, `${t.key} over its profile`);
  // Toggle OFF: plain stops may ride a trailer again.
  const free = plan(rows, trucks, { inputs: inp, tractorOnlyGreen: false });
  assert.ok(free.left_unplanned.every((l) => l.reason !== 'equipment'));
});

test('a liftgate customer marked by the note’s BOOLEAN rides only a truck with a gate — per truck, not "any truck has one"', () => {
  const rows = [row('L1', { name: 'HOUSE' })];
  const inp = inputs(notesFor(rows, { L1: { liftgate_required: true } }));
  // The truck with NO gate sorts first and sits nearer, so any rule that only asks "does
  // some picked truck have a gate?" puts the stop on the wrong one.
  const trucks = [shell('A NO GATE', { liftgate: false }), shell('Z GATE', { liftgate: true })];
  const p = plan(rows, trucks, { inputs: inp });
  assert.equal(truckOf(p, 'L1')?.key, 'Z GATE');
  const only = plan(rows, [shell('A NO GATE', { liftgate: false })], { inputs: inp });
  assert.equal(only.left_unplanned[0]?.reason, 'equipment');
  assert.match(only.left_unplanned[0].detail, /needs a liftgate/);
});

test('when the only gated truck is full, a liftgate stop is LISTED — never moved onto the truck without a gate', () => {
  const rows = [row('L1', { name: 'HOUSE', skids: 2 }), row('L2', { name: 'HOUSE TWO', skids: 2 })];
  const inp = inputs(notesFor(rows, { L1: { liftgate_required: true }, L2: { liftgate_required: true } }));
  const p = plan(rows, [shell('A NO GATE', { liftgate: false }), shell('Z GATE', { liftgate: true, maxSkids: 2 })], { inputs: inp });
  const gated = p.trucks.find((t) => t.key === 'Z GATE');
  assert.equal(gated.stop_count, 1, 'the gated truck takes what fits');
  assert.equal(p.trucks.find((t) => t.key === 'A NO GATE').stop_count, 0, 'nothing rides the truck with no gate');
  assert.equal(p.left_unplanned.length, 1);
  assert.equal(p.left_unplanned[0].reason, 'over_capacity');
});

test('THE PROFILE IS THE TRUCK: a load is filled to its profile in both directions, as the Build button does', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(`U${i}`, { skids: 3, weight: 300 }));
  const p = plan(rows, [shell('BIG BOX', { maxSkids: 30, maxLb: 30000 })]);
  assert.equal(p.trucks[0].cap.skids, 30, 'a stated 30 is 30 — no longer cut to the class 22');
  assert.equal(p.trucks[0].cap.source, 'profile');
  assert.ok(p.trucks[0].skid_equiv > 22 && p.trucks[0].skid_equiv <= 30 + 1e-9, `loaded ${p.trucks[0].skid_equiv}`);
  const small = plan(rows, [shell('SMALL', { maxSkids: 9 })]);
  assert.ok(small.trucks[0].skid_equiv <= 9 + 1e-9, 'and a smaller profile still binds');
});

test('WHAT IS ALREADY ON IT COUNTS: a half-full load gets only the room it has left', () => {
  const onBoard = Array.from({ length: 4 }, (_, i) => row(`B${i}`, { planned: true, skids: 3, weight: 400 }));   // 12 skids already on
  const pool = Array.from({ length: 8 }, (_, i) => row(`U${i}`, { skids: 2, weight: 300 }));
  const p = plan([...onBoard, ...pool], [shell('SUW 2', { existing: onBoard.map((r) => r.stopNbr) })]);
  const t = p.trucks[0];
  assert.deepEqual(t.existing, { stops: 4, skid_equiv: 12, weight_lb: 1600 });
  assert.ok(t.skid_equiv <= 2 + 1e-9, `14-skid profile with 12 on board took ${t.skid_equiv} more`);
  assert.equal(t.cap.skids, 14, 'the card still shows the whole truck');
  // The engine rule (switch off) offered the whole truck again.
  const old = plan([...onBoard, ...pool], [{ ...shell('SUW 2'), existing_stop_nbrs: onBoard.map((r) => r.stopNbr) }], { rules: 'engine' });
  assert.ok(old.trucks[0].skid_equiv > 2, 'engine rules ignored what was on it');
});

test('a load that is already FULL gets nothing and says so — its freight is not re-offered', () => {
  const onBoard = Array.from({ length: 7 }, (_, i) => row(`B${i}`, { planned: true, skids: 2, weight: 400 }));   // 14 of 14
  const pool = [row('U1'), row('U2')];
  const p = plan([...onBoard, ...pool], [shell('FULL', { existing: onBoard.map((r) => r.stopNbr) }), shell('EMPTY')]);
  assert.equal(p.trucks.find((t) => t.key === 'FULL').stop_count, 0);
  assert.equal(p.trucks.find((t) => t.key === 'EMPTY').stop_count, 2);
  assert.ok(p.notes.some((n) => /FULL is already full/.test(n)), JSON.stringify(p.notes));
});

test('THE CLOCK: a dock that shuts early at the FAR end of a run is taken first, not last — and the card says when', () => {
  // Ten stops strung out along one road north; the last one shuts at 10am. Any order that
  // just works outward from Buford arrives there around lunch.
  const rows = Array.from({ length: 10 }, (_, i) => row(`S${i}`, { name: i === 9 ? 'FAR DOCK' : `STOP ${i}`, lat: 34.14 + i * 0.03, lng: -83.99 }));
  const inp = inputs(notesFor(rows, { S9: { receiving_hours: { thu: '8AM-10AM' } } }));
  const p = plan(rows, [shell('T1', { maxSkids: 30 })], { inputs: inp });
  const f = p.trucks[0].stops.find((s) => s.stopNbr === 'S9');
  assert.equal(f.window_label, '8:00a–10:00a');
  assert.equal(f.late, false, `ETA ${f.eta_label}; order ${p.trucks[0].stops.map((s) => s.stopNbr)}`);
  assert.ok(f.eta_label, 'the ETA is on the card');
  assert.ok(!p.notes.some((n) => /shuts early|can't make/.test(n)), JSON.stringify(p.notes));
  const unclocked = p.trucks[0].stops.find((s) => s.stopNbr === 'S0');
  assert.equal(unclocked.window_label, null, 'nothing on file is not a deadline');
  assert.equal(unclocked.late, false);
});

test('a window NO load can make: ADVISORY keeps it and names it; STRICT leaves it off with the reason', () => {
  const rows = [row('U1'), row('X1', { name: 'DAWN DOCK', city: 'Dalton', lat: 34.77, lng: -84.97 })];
  const inp = inputs(notesFor(rows, { X1: { receiving_hours: { thu: '5AM-7AM' } } }));
  const adv = plan(rows, [shell('T1')], { inputs: inp, windowMode: 'advisory' });
  const x = adv.trucks[0].stops.find((s) => s.stopNbr === 'X1');
  assert.equal(x?.late, true);
  assert.ok(adv.notes.some((n) => /DAWN DOCK \(arrives .*, 5:00a–7:00a, on T1\)/.test(n)), JSON.stringify(adv.notes));
  const strict = plan(rows, [shell('T1')], { inputs: inp, windowMode: 'strict' });
  const l = strict.left_unplanned.find((s) => s.stopNbr === 'X1');
  assert.equal(l?.reason, 'time_window');
  assert.match(l.detail, /5:00a–7:00a/);
  assert.ok(truckOf(strict, 'U1'), 'the rest of the load still rides');
});

test('STRICT never leaves a stop off that another picked load can reach on time', () => {
  // T1 already carries a far run, so its clock is late before it starts the fill; T2 is empty.
  const far = Array.from({ length: 3 }, (_, i) => row(`F${i}`, { planned: true, city: 'Dalton', lat: 34.77 + i * 0.01, lng: -84.97 }));
  const w = row('W1', { name: 'EARLY CLOSER', lat: 34.10, lng: -84.01 });
  const rows = [...far, w, row('U1', { lat: 34.12, lng: -84.02 })];
  const inp = inputs(notesFor(rows, { W1: { receiving_hours: { thu: '8AM-10AM' } } }));
  const p = plan(rows, [shell('T1', { existing: far.map((r) => r.stopNbr) }), shell('T2')], { inputs: inp, windowMode: 'strict' });
  const t = truckOf(p, 'W1');
  assert.ok(t, `W1 was left off: ${JSON.stringify(p.left_unplanned)}`);
  assert.equal(t.stops.find((s) => s.stopNbr === 'W1').late, false);
});

test('CONSERVATION under the Build rules: every leftover is on a truck or listed with a reason', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => row(`U${i}`, { skids: 3 })),
    row('R1', { name: 'RED' }), row('X1', { name: 'DAWN', lat: 34.77, lng: -84.97 }), row('N1', { lat: null, lng: null }),
  ];
  const inp = inputs(notesFor(rows, { R1: { vehicle_eligibility: 'box_only' }, X1: { receiving_hours: { thu: '5AM-6AM' } } }));
  const p = plan(rows, [shell('TRL', { tractor: true, maxSkids: 12 }), shell('BOX', { maxSkids: 6 })], { inputs: inp, windowMode: 'strict', tractorOnlyGreen: true });
  const on = p.trucks.flatMap((t) => t.stops.map((s) => s.stopNbr));
  const listed = p.left_unplanned.map((s) => s.stopNbr);
  for (const r of rows) assert.ok(on.includes(r.stopNbr) || listed.includes(r.stopNbr), `${r.stopNbr} vanished`);
  assert.equal(new Set(on).size, on.length, 'no stop on two trucks');
  for (const t of p.trucks) assert.ok(t.skid_equiv <= t.cap.skids + 1e-9 && t.weight_lb <= (t.cap.weight_lb ?? Infinity) + 1e-9, `${t.key} over`);
  assert.ok(!truckOf(p, 'R1') || truckOf(p, 'R1').truck_class !== 'tractor');
  assert.ok(p.trucks.every((t) => t.truck_class !== 'tractor' || t.stop_count === 0), 'green-only with nothing green: the trailer takes nothing');
});

// ── THE SAMPLE NIGHT: one box already carrying two stops, two 53s, "only green on a 53′" on ──
// Built to Chad's shape, and the board that caught four defects in the first cut of this
// change when the real code was run on it: green freight filled the box and box-only freight
// was told "every truck you picked is full" with both trailers half empty; the fit line said
// "it all fits"; a dock nobody could reach made a reachable one late; and room a strict
// removal freed was never refilled.
function sampleNight() {
  const T = {
    Braselton: [34.109, -83.762], Hoschton: [34.096, -83.761], Jefferson: [34.117, -83.572], Commerce: [34.204, -83.457],
    Pendergrass: [34.162, -83.678], Talmo: [34.193, -83.718], Gainesville: [34.298, -83.824], Lavonia: [34.436, -83.107],
    Buford: [34.120, -84.004], Flowery: [34.225, -83.890], Dawsonville: [34.421, -84.119], Cumming: [34.207, -84.140],
  };
  let n = 100;
  const rows = [], marks = {};
  const add = (name, town, skids, lb, note, planned = false) => {
    const [la, ln] = T[town]; const k = rows.length;
    const r = {
      stopNbr: `00${7182000 + (n += 7)}`, isUnplanned: !planned, isPlanned: planned, businessName: name,
      addr1: `${100 + k} Main St`, city: town.toUpperCase(), zip: '30500',
      lat: la + ((k * 37) % 11 - 5) * 0.004, lng: ln + ((k * 53) % 11 - 5) * 0.004,
      cartons: skids, volume: 0, pallets: skids, weight: lb, timeConstraint: null,
    };
    rows.push(r); if (note) marks[r.stopNbr] = note; return r;
  };
  const G = { vehicle_eligibility: 'tractor' };
  const j1 = add('LANIER PAPER CO', 'Buford', 3, 900, null, true);
  const j2 = add('BUFORD TILE SUPPLY', 'Buford', 2, 700, null, true);
  add('BRASELTON DC NORTH', 'Braselton', 8, 3480, G); add('BRASELTON DC SOUTH', 'Braselton', 6, 2400, G);
  add('HOSCHTON COLD STORAGE', 'Hoschton', 4, 1900, G); add('TALMO MILLWORK', 'Talmo', 3, 1100, G);
  add('PENDERGRASS STEEL', 'Pendergrass', 5, 2600, G);
  add('JEFFERSON FOODS', 'Jefferson', 4, 1500, { ...G, receiving_hours: { mon: '7AM-11AM' } });
  add('LAVONIA PLASTICS', 'Lavonia', 6, 3661, G);
  add('COMMERCE PACKAGING', 'Commerce', 3, 1200, { ...G, equipment_restrictions: ['no_tractor_trailer'] });
  add('GAINESVILLE POULTRY', 'Gainesville', 5, 2200, G);
  add('OAKWOOD HARDWARE', 'Flowery', 1, 240); add('HOSCHTON PEDIATRICS', 'Hoschton', 1, 362, { receiving_hours: { mon: '8AM-12PM' } });
  add('JEFFERSON LIBRARY', 'Jefferson', 1, 333); add('COMMERCE HIGH SCHOOL', 'Commerce', 1, 112, { receiving_hours: { mon: '7AM-10AM' } });
  add('TALMO ANIMAL CLINIC', 'Talmo', 1, 190); add('CUMMING DENTAL', 'Cumming', 2, 520); add('DAWSONVILLE OUTLET', 'Dawsonville', 2, 800);
  add('ABERDEEN CHURCH', 'Hoschton', 2, 760, { vehicle_eligibility: 'box_only' });
  add('SMITH RESIDENCE', 'Buford', 1, 450, { liftgate_required: true });
  add('LAVONIA BAKERY', 'Lavonia', 1, 300, { receiving_hours: { mon: '5AM-7AM' } });
  const inp = inputs(notesFor(rows, marks));
  const trucks = [
    { ...shell('JOHN'), existing_stop_nbrs: [j1.stopNbr, j2.stopNbr] },
    shell('TRL A', { tractor: true }), shell('TRL B', { tractor: true }),
  ];
  const run = (windowMode) => buildCleanupPlan('davis', '2026-09-28', {
    cfg: CFG, inputs: inp, liveStops: rows, meta: null, trucks, nowIso: '2026-09-27T23:00:00Z',
    rules: 'build', tractorOnlyGreen: true, windowMode,
  });
  return { rows, run };
}
const byName = (p, name) => p.trucks.flatMap((t) => t.stops.map((s) => ({ ...s, truck: t.key }))).find((s) => s.businessName === name);

test('SAMPLE NIGHT · freight free to ride a trailer MAKES ROOM on the box for freight that may only ride the box', () => {
  const { run } = sampleNight();
  for (const mode of ['advisory', 'strict']) {
    const p = run(mode);
    const john = p.trucks.find((t) => t.key === 'JOHN');
    const onJohn = john.existing.skid_equiv + john.skid_equiv;
    const boxOnlyLeft = p.left_unplanned.filter((l) => l.reason === 'over_capacity');
    // 13 skids may ride only JOHN and JOHN has room for 9, so exactly 4 skids of it stay behind
    // (3 on strict, which takes the 1-skid bakery off for its clock first) — not more because
    // green freight took the box's room.
    assert.equal(onJohn, 14, `${mode}: JOHN carries ${onJohn} of 14`);
    assert.equal(boxOnlyLeft.reduce((a, l) => a + l.skids, 0), mode === 'strict' ? 3 : 4, `${mode}: ${boxOnlyLeft.map((l) => l.businessName)}`);
    const green = /BRASELTON DC|HOSCHTON COLD|TALMO MILL|PENDERGRASS|JEFFERSON FOODS|LAVONIA PLASTICS|GAINESVILLE/;
    assert.ok(!john.stops.some((s) => green.test(s.businessName)), `${mode}: green freight rides the box while box-only freight waits`);
    for (const t of p.trucks) assert.ok((t.existing?.skid_equiv || 0) + t.skid_equiv <= t.cap.skids + 1e-9, `${t.key} over its profile`);
  }
});

test('SAMPLE NIGHT · a stop left for capacity names the load it could ride and WHY the others cannot — never "every truck is full" with trailers half empty', () => {
  const p = sampleNight().run('advisory');
  const oak = p.left_unplanned.find((l) => l.businessName === 'OAKWOOD HARDWARE');
  assert.equal(oak?.reason, 'over_capacity');
  assert.equal(oak.detail, 'JOHN is the only load it may ride and it is full — it is not marked green, so “only green on a 53′” keeps it off the trailers');
  const smith = p.left_unplanned.find((l) => l.businessName === 'SMITH RESIDENCE');
  assert.match(smith.detail, /the others: needs a liftgate$/, 'the trailers are out for their equipment, not the toggle');
  assert.ok(!p.left_unplanned.some((l) => /every truck you picked is full/.test(l.detail)), 'the trailers had room — that sentence would be false');
});

test('SAMPLE NIGHT · the fit line does not say "it all fits" when the only truck some freight may ride is too small for it', () => {
  const p = sampleNight().run('advisory');
  assert.equal(p.fit.fits, false);
  assert.deepEqual(p.fit.constrained, { trucks: ['JOHN'], skid_equiv: 13, room: 9 });
  assert.ok(p.notes.some((n) => /fits in total, but not where the rules allow it: 13 skid-equivalents may ride only JOHN, which has room for 9/.test(n)));
});

test('SAMPLE NIGHT · a dock nobody can reach does not make a reachable one late (advisory)', () => {
  const p = sampleNight().run('advisory');
  const school = byName(p, 'COMMERCE HIGH SCHOOL');
  assert.equal(school.late, false, `ETA ${school.eta_label} for a 10am close`);
  const bakery = byName(p, 'LAVONIA BAKERY');
  assert.equal(bakery.late, true, 'the unreachable one is still flagged, not hidden');
});

test('SAMPLE NIGHT · STRICT: the unreachable dock comes off, and the room it frees goes to freight that was waiting for it', () => {
  const p = sampleNight().run('strict');
  assert.equal(p.left_unplanned.find((l) => l.businessName === 'LAVONIA BAKERY')?.reason, 'time_window');
  const john = p.trucks.find((t) => t.key === 'JOHN');
  assert.equal(john.existing.skid_equiv + john.skid_equiv, 14, 'JOHN is filled to his profile, not left a skid short');
  assert.ok(p.trucks.every((t) => t.stops.every((s) => !s.late)), 'strict: nothing on a truck is late');
});

test('a dock NOBODY can reach does not bid for the front of the run and make a reachable dock late', () => {
  // Due north of Buford: H (shuts 7am) is out of reach whatever the order; A sits past it and
  // shuts at 10:45 — on time only if the truck runs straight to A. Left to trade minutes, the
  // insertion runs H first (to shave its lateness) and A misses its dock.
  const rows = [
    row('H1', { name: 'DAWN DOCK', lat: 35.148, lng: -83.959 }),
    row('A1', { name: 'LATE MORNING DOCK', lat: 35.448, lng: -83.959 }),
  ];
  const inp = inputs(notesFor(rows, { H1: { receiving_hours: { thu: '5AM-7AM' } }, A1: { receiving_hours: { thu: '8AM-10:45AM' } } }));
  const p = plan(rows, [shell('T1')], { inputs: inp, windowMode: 'advisory' });
  const a = p.trucks[0].stops.find((s) => s.stopNbr === 'A1');
  const h = p.trucks[0].stops.find((s) => s.stopNbr === 'H1');
  assert.equal(a.late, false, `A arrives ${a.eta_label}; order ${p.trucks[0].stops.map((s) => `${s.stopNbr}@${s.eta_label}`)}`);
  assert.equal(h.late, true, 'the unreachable one is still flagged');
});

// ── what the independent review of the first cut caught (each one run, not argued) ──

test('REVIEW · strict takes off EVERY stop it cannot make — the removal loop runs to the end, and no note blames "advisory"', () => {
  const rows = Array.from({ length: 4 }, (_, i) => row(`X${i}`, { name: `DAWN ${i}`, city: 'Dalton', lat: 34.77 + i * 0.01, lng: -84.97 }));
  const inp = inputs(notesFor(rows, Object.fromEntries(rows.map((r) => [r.stopNbr, { receiving_hours: { thu: '5AM-6AM' } }]))));
  const p = plan(rows, [shell('T1')], { inputs: inp, windowMode: 'strict' });
  assert.equal(p.trucks[0].stop_count, 0, `still on the truck: ${p.trucks[0].stops.map((s) => `${s.stopNbr}@${s.eta_label}`)}`);
  assert.equal(p.left_unplanned.filter((l) => l.reason === 'time_window').length, 4);
  assert.ok(!p.notes.some((n) => /advisory/.test(n)), JSON.stringify(p.notes));
});

test('REVIEW · a stop already on the load that opens at 10 makes the truck WAIT there — the stop behind it is not "on time at 8:29"', () => {
  const e1 = row('E1', { planned: true, name: 'LATE OPENER', lat: 34.20, lng: -84.00 });
  const w1 = row('W1', { name: 'EARLY CLOSER', lat: 34.225, lng: -84.00 });
  const inp = inputs(notesFor([e1, w1], { E1: { receiving_hours: { thu: '10AM-4PM' } }, W1: { receiving_hours: { thu: '8AM-10AM' } } }));
  const trucks = [shell('T1', { existing: ['E1'] })];
  const adv = plan([e1, w1], trucks, { inputs: inp, windowMode: 'advisory' });
  assert.equal(adv.trucks[0].stops.find((s) => s.stopNbr === 'W1')?.late, true, 'after waiting for E1 at 10:00 it cannot make a 10:00 close');
  const str = plan([e1, w1], trucks, { inputs: inp, windowMode: 'strict' });
  assert.equal(str.left_unplanned.find((l) => l.stopNbr === 'W1')?.reason, 'time_window');
});

test('REVIEW · a carry-over order on the card that is NOT on this day\'s board still counts against the truck', () => {
  const today = Array.from({ length: 4 }, (_, i) => row(`B${i}`, { planned: true, skids: 2 }));   // 8 skids on the board
  const pool = Array.from({ length: 6 }, (_, i) => row(`U${i}`, { skids: 1 }));
  const carry = { stopNbr: 'CARRY-1', cartons: 6, volume: 0, pallets: 6, weight: 900, lat: 34.10, lng: -84.02, businessName: 'CARRYOVER CO', addr1: '1 Old Rd', city: 'Buford', zip: '30518' };
  const t = { ...shell('BOX'), existing_stop_nbrs: [...today.map((r) => r.stopNbr), 'CARRY-1'], existing_stops: [carry] };
  const p = plan([...today, ...pool], [t]);
  const box = p.trucks[0];
  assert.deepEqual(box.existing, { stops: 5, skid_equiv: 14, weight_lb: 2900 });
  assert.equal(box.full, true, '8 + 6 carry-over = 14 of 14');
  assert.equal(box.stop_count, 0, 'nothing is piled on top of a full truck');
});

test('REVIEW · a stop refused for EQUIPMENT is not also called "too big", and the board is not called empty', () => {
  const rows = [row('R1', { name: 'RED' })];
  const inp = inputs(notesFor(rows, { R1: { vehicle_eligibility: 'box_only' } }));
  const p = plan(rows, [shell('TRL', { tractor: true })], { inputs: inp });
  assert.equal(p.left_unplanned[0].reason, 'equipment');
  assert.ok(!p.notes.some((n) => /will not fit on any truck|nothing is sitting unplanned|got nothing/.test(n)), JSON.stringify(p.notes));
});

test('REVIEW · a stop that fits the EMPTY truck but not the room left is a capacity question — never "needs a bigger truck"', () => {
  const onBoard = Array.from({ length: 11 }, (_, i) => row(`B${i}`, { planned: true, skids: 2 }));   // 22 of 28
  const big = row('BIG', { name: 'EIGHT SKIDS', skids: 8, weight: 2000 });
  const p = plan([...onBoard, big], [shell('TRL', { tractor: true, existing: onBoard.map((r) => r.stopNbr) })]);
  const l = p.left_unplanned.find((x) => x.stopNbr === 'BIG');
  assert.equal(l?.reason, 'over_capacity', JSON.stringify(l));
  assert.doesNotMatch(l.detail, /bigger truck/);
});

test('REVIEW · the engine\'s learned start is the FIRST DELIVERY, not leaving the dock — it anchors the first stop', () => {
  // Twelve past days whose first delivery was 9:30. Nothing reaches a stop before then.
  const days = Array.from({ length: 12 }, (_, i) => ({
    tenant: 'davis', date: `2026-08-${String(10 + i).padStart(2, '0')}`, driver_key: 'SOMEONE', truck_class: 'box_truck',
    trips: [], day_totals: { skids: 0, loose: 0, weight: 0 }, start_time: `2026-08-${String(10 + i).padStart(2, '0')}T09:30:00`, end_time: null,
  }));
  const rows = [row('N1', { name: 'NEAR', lat: 34.16, lng: -83.96 })];
  const inp = { ...inputs(notesFor(rows, { N1: { receiving_hours: { thu: '8AM-5PM' } } })), driverDaysBefore: days };
  const p = plan(rows, [shell('T1')], { inputs: inp });
  const n = p.trucks[0].stops[0];
  assert.equal(n.eta_label, '9:30a', 'arrival at the first stop is the learned first delivery — the drive is not added again');
  assert.match(p.trucks[0].depart_label, /^9:[0-2]\da$/, `leaves ${p.trucks[0].depart_label} — a few minutes before the 9:30 first delivery`);
});
