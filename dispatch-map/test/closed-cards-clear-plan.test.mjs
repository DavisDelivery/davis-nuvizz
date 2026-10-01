// test/closed-cards-clear-plan.test.mjs — once a Build's plan has been on a Compare card, closing
// the cards stops the map painting that plan.
//
// Chad, 2026-10-01: "if it puts the stops in the compare panel, and I then close out the compare
// panel, the stops should not look like they're still on that route on the map, because when I
// pull back up the compare panel, it's empty. However, it still shows the route that the system
// built on the map with the stops on it. Now, if I refresh the page, all that goes away."
//
// The map read "open cards, else the Build's plan". Since v1.19.0 a Build stages itself, so the
// moment the last card closed the map fell back to the plan: the same stops numbered, coloured
// and joined by a line, under a Compare panel that read empty. The rule is pure
// (mapRouteSource); the screen feeds the numbered pins AND the lines from it, so the two cannot
// disagree. Both halves are pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mapRouteSource, buildPlanReachedCards, houseSwitchOn } from '../src/lib/routing-select.js';

// His Build: CRUMPTON and RASHEED, staged onto their two cards by the Build itself.
const PLAN = [
  { truckId: 'CRUMPTON', order: ['C1', 'C2', 'C3'] },
  { truckId: 'RASHEED', order: ['R1', 'R2'] },
];
const CARDS = [
  { key: 'CRUMPTON', order: ['C1', 'C2', 'C3'] },
  { key: 'RASHEED', order: ['R1', 'R2'] },
];

/** What the screen does, step by step: the job's "on a card" mark and the paint it picks. */
function screen() {
  let jobId = null, planOnCardsJobId = null, cards = [], plan = [];
  const paint = (enabled = true) => {
    if (jobId && planOnCardsJobId !== jobId && buildPlanReachedCards(plan, cards)) planOnCardsJobId = jobId;
    return mapRouteSource({ openCards: cards.length, planOnCards: !!jobId && planOnCardsJobId === jobId, enabled });
  };
  return {
    build(id, routes) { jobId = id; plan = routes; return paint(); },
    stage() { cards = CARDS.map((c) => ({ ...c, order: [...c.order] })); return paint(); },
    closeAll() { cards = []; return paint(); },
    discard() { jobId = null; plan = []; return paint(); },
    paint,
  };
}

test('his case: Build → its cards → close them → the map paints NO route (what a refresh shows)', () => {
  const s = screen();
  assert.equal(s.build('job-1', PLAN), 'plan', 'before staging, the plan is the only place it is visible');
  assert.equal(s.stage(), 'cards', 'the cards are the working set');
  assert.equal(s.closeAll(), 'none', 'the Compare panel is empty, so the map shows no route');
});

test('a plan never put on a card still paints (Trucks mode, or a Build not yet staged)', () => {
  const s = screen();
  assert.equal(s.build('job-1', PLAN), 'plan');
  assert.equal(s.closeAll(), 'plan', 'closing nothing does not hide a plan nobody staged');
});

test('the way back: "Stage onto Compare cards" puts the cards up and the map paints them again', () => {
  const s = screen();
  s.build('job-1', PLAN); s.stage(); s.closeAll();
  assert.equal(s.stage(), 'cards');
});

test('a NEW Build starts fresh: its plan paints until it reaches a card', () => {
  const s = screen();
  s.build('job-1', PLAN); s.stage(); s.closeAll();
  assert.equal(s.build('job-2', PLAN), 'plan', 'job-1 having been staged says nothing about job-2');
});

test('Discard: nothing to paint either way', () => {
  const s = screen();
  s.build('job-1', PLAN); s.stage(); s.closeAll();
  assert.equal(s.discard(), 'plan', 'with no plan, "plan" paints an empty route list');
});

test('PUT IT BACK: with the switch off, closing the cards paints the Build’s plan again, as before', () => {
  const s = screen();
  s.build('job-1', PLAN); s.stage(); s.closeAll();
  assert.equal(s.paint(false), 'plan');
});

test('open cards always win, whatever the plan did', () => {
  for (const planOnCards of [true, false]) for (const enabled of [true, false]) {
    assert.equal(mapRouteSource({ openCards: 1, planOnCards, enabled }), 'cards');
  }
});

test('a plan counts as on the cards only when one of ITS stops is on a card', () => {
  assert.equal(buildPlanReachedCards(PLAN, CARDS), true);
  assert.equal(buildPlanReachedCards(PLAN, [{ key: 'OTHER', order: ['X1', 'X2'] }]), false, 'an unrelated card');
  assert.equal(buildPlanReachedCards(PLAN, [{ key: 'CRUMPTON', order: [] }]), false, 'an empty card');
  assert.equal(buildPlanReachedCards([{ order: [7] }], [{ order: ['7'] }]), true, 'numbers and strings are one id');
  for (const [r, c] of [[null, CARDS], [PLAN, null], [[], CARDS], [PLAN, []], [[{}], [{}]]]) {
    assert.equal(buildPlanReachedCards(r, c), false);
  }
});

test('the switch is house shape: on by default, an off-word turns it off, anything malformed leaves it on', () => {
  for (const v of [undefined, '', 'on', 'ture', 'yes']) assert.equal(houseSwitchOn(v), true, String(v));
  for (const v of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(houseSwitchOn(v), false, v);
});

// ── The wiring ──
const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');

test('the screen reads the rule for the numbered pins AND the lines, behind one switch', () => {
  assert.ok(/import \{[^}]*\bmapRouteSource\b[^}]*\bbuildPlanReachedCards\b[^}]*\} from '\.\/lib\/routing-select\.js';/.test(code));
  assert.ok(/const CLOSED_CARDS_CLEAR_PLAN = \(\(\) => \{\n {2}try \{ return houseSwitchOn\(import\.meta\.env\.VITE_ROUTING_CLOSED_CARDS_CLEAR_PLAN\); \} catch \{ return true; \}/.test(code));
  assert.ok(/^const NO_ROUTE_INFO = new Map\(\);$/m.test(code), 'the empty paint is not one stable Map');
  assert.ok(code.includes("const effectiveRouteInfo = mapRouteSrc === 'cards' ? wbRouteInfo : (mapRouteSrc === 'plan' ? routeInfo : NO_ROUTE_INFO);"), 'the pins do not read the rule');
  assert.ok(code.includes("const toDraw = mapRouteSrc === 'cards' ? wbRoutesColored : (mapRouteSrc === 'plan' ? routesView : []);"), 'the lines do not read the rule');
  assert.ok(/enabled: CLOSED_CARDS_CLEAR_PLAN,/.test(code));
  assert.ok(!/wbRoutesColored\.length \? wbRouteInfo : routeInfo/.test(code), 'the old fallback is still there');
  assert.ok(!/wbRoutesColored\.length \? wbRoutesColored : routesView/.test(code), 'the old line fallback is still there');
});

test('marking a plan "on the cards" writes only that mark — never the cards, the selection or the plan', () => {
  const start = code.indexOf('const [planOnCardsJobId, setPlanOnCardsJobId] = useState(null);');
  assert.ok(start > 0);
  const end = code.indexOf('const effectiveRouteInfo', start);
  const body = code.slice(start, end);
  assert.ok(/buildPlanReachedCards\(routesView, wbRoutes\)\) setPlanOnCardsJobId\(jobId\)/.test(body));
  for (const w of ['setWbRoutes', 'setSelectedIds', 'setJob', 'setRouteState', 'stagePlanOntoLoads']) assert.ok(!body.includes(w), `it calls ${w}`);
});
