// test/closed-cards-clear-plan.test.mjs — a Build's stop that has been on a Compare card stops
// showing on the Build's route once the card closes.
//
// Chad, 2026-10-01: "if it puts the stops in the compare panel, and I then close out the compare
// panel, the stops should not look like they're still on that route on the map, because when I
// pull back up the compare panel, it's empty. However, it still shows the route that the system
// built on the map with the stops on it. Now, if I refresh the page, all that goes away."
//
// With no card open the map paints the Build's plan. Since v1.19.0 a Build stages itself, so the
// moment the last card closed the map fell back to the plan: the same stops numbered, coloured
// and joined by a line, under a Compare panel that read empty. Remembered PER STOP: a stop that
// never reached a card still paints (an adversarial review caught a per-Build first draft
// hiding a route the full workbench had never opened). The rules are pure; the screen feeds the
// numbered pins AND the lines from them, so the two cannot disagree. Both halves are pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { planStopsOnCards, planRouteInfo, planRoutesToPaint, houseSwitchOn } from '../src/lib/routing-select.js';

// His Build: CRUMPTON and RASHEED, staged onto their two cards by the Build itself.
const PLAN = [
  { truckId: 'CRUMPTON', color: '#c00', order: ['C1', 'C2', 'C3'] },
  { truckId: 'RASHEED', color: '#00c', order: ['R1', 'R2'] },
];
const card = (key, order) => ({ key, order: [...order] });

/** The screen, step by step: what it remembers per Build, and what the map paints. */
function screen({ enabled = true } = {}) {
  let jobId = null, mem = { jobId: null, ids: [] }, cards = [], plan = [];
  const paint = () => {
    if (enabled && jobId) {
      const already = mem.jobId === jobId ? mem.ids : [];
      const fresh = planStopsOnCards(plan, cards, already);
      if (fresh.length) mem = { jobId, ids: [...already, ...fresh] };
    }
    const hidden = new Set(jobId && mem.jobId === jobId ? mem.ids : []);
    if (cards.length) return { source: 'cards', pins: [...cards.flatMap((c) => c.order)].sort(), lines: cards.map((c) => c.order) };
    return { source: 'plan', pins: [...planRouteInfo(plan, hidden).keys()].sort(), lines: planRoutesToPaint(plan, hidden).map((r) => r.order) };
  };
  return {
    build(id, routes) { jobId = id; plan = routes; return paint(); },
    open(...cs) { cards = [...cards, ...cs]; return paint(); },
    close(key) { cards = cards.filter((c) => c.key !== key); return paint(); },
    discard() { jobId = null; plan = []; return paint(); },
  };
}

test('his case: Build → its two cards → close them both → the map paints NO route (what a refresh shows)', () => {
  const s = screen();
  assert.deepEqual(s.build('job-1', PLAN).pins, ['C1', 'C2', 'C3', 'R1', 'R2'], 'before staging, the plan is the only place it is visible');
  s.open(card('CRUMPTON', ['C1', 'C2', 'C3']), card('RASHEED', ['R1', 'R2']));
  const one = s.close('CRUMPTON');
  assert.equal(one.source, 'cards', 'RASHEED is still open and is all the map draws');
  const none = s.close('RASHEED');
  assert.deepEqual(none.pins, [], 'no numbered pin');
  assert.deepEqual(none.lines, [], 'no line');
});

test('workbench full: RASHEED never got a card, so after CRUMPTON closes RASHEED still paints with its line', () => {
  const s = screen();
  s.build('job-1', PLAN);
  s.open(card('CRUMPTON', ['C1', 'C2', 'C3']));          // RASHEED: "workbench full — couldn't open"
  const after = s.close('CRUMPTON');
  assert.deepEqual(after.pins, ['R1', 'R2']);
  assert.deepEqual(after.lines, [['R1', 'R2']]);
});

test('Trucks mode: one stop moved onto a card by hand leaves only THAT stop off the plan; the rest still paint', () => {
  const s = screen();
  s.build('job-1', PLAN);                                // Trucks mode never auto-stages
  s.open(card('TONY', ['T1', 'C3']));                    // C3 sent onto TONY from the Selected panel
  const after = s.close('TONY');
  assert.deepEqual(after.pins, ['C1', 'C2', 'R1', 'R2']);
  assert.deepEqual(after.lines, [['C1', 'C2'], ['R1', 'R2']]);
});

test('a numbered pin keeps its place on the plan’s route, the number the Result panel shows', () => {
  const info = planRouteInfo(PLAN, new Set(['C2']));
  assert.deepEqual(info.get('C1'), { color: '#c00', seq: 1 });
  assert.deepEqual(info.get('C3'), { color: '#c00', seq: 3 });
  assert.equal(info.has('C2'), false);
});

test('the way back: "Stage onto Compare cards" puts the cards up and the map paints them again', () => {
  const s = screen();
  s.build('job-1', PLAN);
  s.open(card('CRUMPTON', ['C1', 'C2', 'C3']), card('RASHEED', ['R1', 'R2']));
  s.close('CRUMPTON'); s.close('RASHEED');
  const back = s.open(card('CRUMPTON', ['C1', 'C2', 'C3']), card('RASHEED', ['R1', 'R2']));
  assert.equal(back.source, 'cards');
  assert.deepEqual(back.pins, ['C1', 'C2', 'C3', 'R1', 'R2']);
});

test('a NEW Build starts fresh: its whole plan paints until its stops reach a card', () => {
  const s = screen();
  s.build('job-1', PLAN);
  s.open(card('CRUMPTON', ['C1', 'C2', 'C3']), card('RASHEED', ['R1', 'R2']));
  s.close('CRUMPTON'); s.close('RASHEED');
  assert.deepEqual(s.build('job-2', PLAN).pins, ['C1', 'C2', 'C3', 'R1', 'R2']);
});

test('Discard: no plan, nothing to paint', () => {
  const s = screen();
  s.build('job-1', PLAN);
  assert.deepEqual(s.discard().pins, []);
});

test('PUT IT BACK: with the switch off, closing the cards paints the Build’s whole plan again, as before', () => {
  const s = screen({ enabled: false });
  s.build('job-1', PLAN);
  s.open(card('CRUMPTON', ['C1', 'C2', 'C3']), card('RASHEED', ['R1', 'R2']));
  s.close('CRUMPTON');
  const after = s.close('RASHEED');
  assert.deepEqual(after.pins, ['C1', 'C2', 'C3', 'R1', 'R2']);
  assert.deepEqual(after.lines, [['C1', 'C2', 'C3'], ['R1', 'R2']]);
});

test('planStopsOnCards: only the plan’s own stops, each once, never one already remembered', () => {
  const cards = [card('A', ['C1', 'X9']), card('B', ['C1', 'R2'])];
  assert.deepEqual(planStopsOnCards(PLAN, cards, []), ['C1', 'R2'], 'X9 is not the Build’s');
  assert.deepEqual(planStopsOnCards(PLAN, cards, ['C1']), ['R2']);
  assert.deepEqual(planStopsOnCards([{ order: [7] }], [{ order: ['7'] }]), ['7'], 'numbers and strings are one id');
  for (const [r, c] of [[null, cards], [PLAN, null], [[], cards], [PLAN, []], [[{}], [{}]]]) assert.deepEqual(planStopsOnCards(r, c, []), []);
});

test('planRoutesToPaint: nothing hidden hands back the SAME array, so the lines do not redraw for nothing', () => {
  assert.equal(planRoutesToPaint(PLAN, new Set()), PLAN);
  assert.equal(planRoutesToPaint(PLAN, null), PLAN);
  assert.deepEqual(planRoutesToPaint(PLAN, new Set(['R1', 'R2'])).map((r) => r.truckId), ['CRUMPTON'], 'a route with no stops left draws no line');
  assert.deepEqual(planRoutesToPaint(null, new Set(['x'])), []);
});

test('the switch is house shape: on by default, an off-word turns it off, anything malformed leaves it on', () => {
  for (const v of [undefined, '', 'on', 'ture', 'yes']) assert.equal(houseSwitchOn(v), true, String(v));
  for (const v of ['off', '0', 'false', 'no', ' OFF ']) assert.equal(houseSwitchOn(v), false, v);
});

// ── The wiring ──
const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');

test('the numbered pins AND the lines read the same per-stop rule, behind one switch', () => {
  assert.ok(/import \{[^}]*\bplanStopsOnCards\b[^}]*\bplanRouteInfo\b[^}]*\bplanRoutesToPaint\b[^}]*\} from '\.\/lib\/routing-select\.js';/.test(code));
  assert.ok(/const CLOSED_CARDS_CLEAR_PLAN = \(\(\) => \{\n {2}try \{ return houseSwitchOn\(import\.meta\.env\.VITE_ROUTING_CLOSED_CARDS_CLEAR_PLAN\); \} catch \{ return true; \}/.test(code));
  assert.ok(code.includes('const routeInfo = useMemo(() => planRouteInfo(routesView, planHidden), [routesView, planHidden]);'), 'the pins do not read the rule');
  assert.ok(code.includes('const planPaintRoutes = useMemo(() => planRoutesToPaint(routesView, planHidden), [routesView, planHidden]);'));
  assert.ok(code.includes('const toDraw = wbRoutesColored.length ? wbRoutesColored : planPaintRoutes;'), 'the lines do not read the rule');
  assert.ok(code.includes('const effectiveRouteInfo = wbRoutesColored.length ? wbRouteInfo : routeInfo;'), 'open cards no longer win');
  assert.ok(/if \(!CLOSED_CARDS_CLEAR_PLAN \|\| viewing \|\| !job\?\.id \|\| job\?\.status !== 'done'\) return;/.test(code), 'the switch does not stop anything being remembered');
});

test('remembering a stop writes only that memory — never the cards, the selection or the plan', () => {
  const start = code.indexOf('const [planOnCards, setPlanOnCards] = useState(');
  assert.ok(start > 0);
  const body = code.slice(start, code.indexOf('const planHidden = useMemo(', start));
  assert.ok(/planStopsOnCards\(routesView, wbRoutes, already\)/.test(body));
  for (const w of ['setWbRoutes', 'setSelectedIds', 'setJob', 'setRouteState', 'stagePlanOntoLoads']) assert.ok(!body.includes(w), `it calls ${w}`);
});
