// BOTH EDGES OF THE DAY, ON ONE PIN — hours_narrow_window and hours_runs_early.
//
// Two pins on the live map were each telling half the truth, and Chad named both:
//
//   BOHO GAL, 10:00a–4:00p, wearing the single inward arrow — "the better icon for a stop
//   like this that opens after 8am and closes before 5 would be arrows pointing inward
//   towards the icon on both sides not just the one."
//
//   SCOTT LITHOGRAPHING, 6:00a–3:00p, wearing the outward span — "for a customer like this
//   that opens before 8 and closes before 5 should be 2 parallel left facing arrows."
//
// THE LOGISTICS BEHIND EACH. A dock open 10–4 and a dock open 10–6 were the same pin, and
// they are not the same stop: the first has to land INSIDE a six-hour box, which constrains
// what you can put either side of it in the sequence, while the second only has to come
// after mid-morning. A dock open 6–3 and one open 6–7 were the same pin too, and the first
// has no slack at all — its whole day has been moved forward, which is a reason to go at
// dawn rather than a reason to relax.
//
// THE INVARIANT THESE TESTS EXIST FOR is at the bottom: not one stop gains or loses a mark.
// Both new kinds SPLIT a mark the map already drew. v0.65 cut 116 clock icons down to the
// ones worth looking at, and a change about which way the arrows point must not quietly buy
// that noise back — so the population is pinned, not just the two new cases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyTimeMark, timeMarkChip, TIME_MARK_KEYS,
  SHUTS_EARLY_BEFORE, TIGHT_WINDOW_MAX, EARLY_CLOSE_BEFORE,
  OPENS_LATE_FROM, OPENS_EARLY_BY, OPEN_LATE_FROM, EARLY_FINISH_BEFORE,
} from '../src/lib/time-marks.js';
import { TIER_LABEL, TIER_ORDER } from '../src/lib/time-restrictions.js';

const at = (h, m = 0) => h * 60 + m;
const typed = (open, close) => ({
  receiving_hours: { fri: { open, close } },
  manual_overrides: { receiving_hours: true },
});

// ── the two stops Chad pointed at ────────────────────────────────────────────

test('BOHO GAL, 10:00a-4:00p — pinched at both ends, so both arrows are drawn', () => {
  assert.equal(classifyTimeMark(at(10), at(16)), 'hours_narrow_window');
});

test('SCOTT LITHOGRAPHING, 6:00a-3:00p — the whole day runs early', () => {
  assert.equal(classifyTimeMark(at(6), at(15)), 'hours_runs_early');
});

// ── the half that must NOT change, which is what makes the split worth drawing ──

test('a dock with ONE binding edge keeps the single arrow', () => {
  assert.equal(classifyTimeMark(at(10), at(17)), 'hours_opens_late',
    '10a-5p binds only at the open — five is the most ordinary close on the board');
  assert.equal(classifyTimeMark(at(10), null), 'hours_opens_late',
    'and a dock that never stated a close cannot have a second arrow invented for it');
  assert.equal(classifyTimeMark(at(6), at(18)), 'hours_extra_room',
    '6a-6p is genuinely roomy at both ends — that IS the outward span');
});

// ── the fourth corner ────────────────────────────────────────────────────────

test('a dock that opens late AND is still open at six RUNS LATE', () => {
  // Chad, on v1.16.1 having seen the other three: "did you use same logic for opening late
  // and closing late, 2 parallel right facing arrows."
  assert.equal(classifyTimeMark(at(10), at(18)), 'hours_runs_late');
  assert.equal(classifyTimeMark(at(10), at(19)), 'hours_runs_late');
  assert.equal(classifyTimeMark(at(9), at(20)), 'hours_runs_late');
});

test('6:00pm is the late edge, and 5:00pm is not — one meaning of "late", not two', () => {
  // The other two-edge marks pivot on 5:00p because that is where a day stops being SHORT.
  // This one pivots on OPEN_LATE_FROM, the dial already measured for "still taking freight
  // at six", which hours_extra_room has always used for exactly this claim.
  assert.equal(classifyTimeMark(at(10), at(17, 59)), 'hours_opens_late');
  assert.equal(classifyTimeMark(at(10), at(18)), 'hours_runs_late');
});

test('the four corners of the square are four different marks', () => {
  const corner = (o, c) => classifyTimeMark(at(o), at(c));
  assert.equal(corner(10, 16), 'hours_narrow_window', 'late start, short day');
  assert.equal(corner(10, 19), 'hours_runs_late', 'late start, late finish');
  assert.equal(corner(6, 15), 'hours_runs_early', 'early start, early finish');
  assert.equal(corner(6, 19), 'hours_extra_room', 'early start, late finish');
  assert.equal(new Set([corner(10, 16), corner(10, 19), corner(6, 15), corner(6, 19)]).size, 4);
});

test('5:00pm exactly is the cliff, and it falls on the roomy side', () => {
  // Same shape as the 3:00pm cliff above it: docks state hours on the hour, so an inclusive
  // test would sweep in every dock that shuts at five — which is most of them.
  assert.equal(classifyTimeMark(at(10), at(17)), 'hours_opens_late');
  assert.equal(classifyTimeMark(at(10), at(16, 59)), 'hours_narrow_window');
  assert.equal(classifyTimeMark(at(6), at(17)), 'hours_extra_room');
  assert.equal(classifyTimeMark(at(6), at(16, 59)), 'hours_runs_early');
});

test('an open with no close on file can never reach a both-edges mark', () => {
  // A window we were given half of must not be completed by guesswork — the same rule the
  // chip's title line lives by.
  assert.equal(classifyTimeMark(at(10), null), 'hours_opens_late');
  assert.equal(classifyTimeMark(at(6), null), 'hours_extra_room');
});

test('a real deadline still outranks both of them', () => {
  assert.equal(classifyTimeMark(at(10), at(14)), 'hours_early_close', '10a-2p is a deadline');
  assert.equal(classifyTimeMark(at(6), at(14)), 'hours_early_close', 'so is 6a-2p');
  assert.equal(classifyTimeMark(at(10), at(11, 30)), 'hours_shuts_early');
});

test('an ordinary 8:00a-4:00p dock is STILL silent — the noise does not come back', () => {
  // This is the case an 8:00a open dial would have lit, and it is the commonest window on
  // the board. The mark is reachable only through the 9:00a and 6:30a dials, so a plain
  // working day says nothing here exactly as it said nothing before.
  assert.equal(classifyTimeMark(at(8), at(16)), null);
  assert.equal(classifyTimeMark(at(7), at(16)), null);
  assert.equal(classifyTimeMark(at(8, 30), at(16, 30)), null);
});

// ── the chip: an icon nobody can route against is decoration ─────────────────

test('a both-edges chip prints the WHOLE window, not one edge of it', () => {
  const narrow = timeMarkChip(typed('10:00', '16:00'), 'fri');
  assert.equal(narrow.kind, 'hours_narrow_window');
  assert.equal(narrow.text, '10:00a–4:00p');
  assert.equal(narrow.title, 'Receiving 10:00a–4:00p');

  const early = timeMarkChip(typed('6:00', '15:00'), 'fri');
  assert.equal(early.kind, 'hours_runs_early');
  assert.equal(early.text, '6:00a–3:00p');
});

// ── one vocabulary: the map, the PRO report and the icon table ───────────────

test('every mark the map can draw has a report label and an icon', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  for (const key of TIME_MARK_KEYS) {
    assert.ok(TIER_LABEL[key], `${key} has a PRO-report label`);
    assert.ok(TIER_ORDER.includes(key), `${key} is ranked in the report`);
    const i = app.indexOf(`  ${key}: {`);
    assert.ok(i > 0, `${key} has an icon definition`);
    const def = app.slice(i, i + 3000);
    assert.match(def, /glyph: '/, `${key} has a 14x14 badge glyph`);
    assert.match(def, /markerGlyph: `/, `${key} has a 22x22 marker glyph`);
  }
});

test('the new marks carry the colour of the mark they split off', () => {
  // Shape carries the new information, not hue. A dispatcher who has learned "teal = starts
  // late" and "blue = good news at one end" keeps both readings; the arrows refine them.
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const accent = (key) => app.slice(app.indexOf(`  ${key}: {`), app.indexOf(`  ${key}: {`) + 3000)
    .match(/accent: '(#[0-9A-Fa-f]{6})'/)[1];
  assert.equal(accent('hours_narrow_window'), accent('hours_opens_late'));
  assert.equal(accent('hours_runs_early'), accent('hours_extra_room'));
});

test('the marker arrows actually point the way Chad asked', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const marker = (key) => app.slice(app.indexOf(`  ${key}: {`), app.indexOf(`  ${key}: {`) + 3000)
    .match(/markerGlyph: `([\s\S]*?)`/)[1];

  // Narrow window: one arrow head on each side of the dial, both aimed at the centre. The
  // heads are the L-vertices of each path; the left head sits left of centre pointing RIGHT
  // (its tip is the largest x of the three) and the right head mirrors it.
  const narrowArrows = marker('hours_narrow_window').match(/<path[^>]*d="([^"]*)"/g) || [];
  assert.equal(narrowArrows.length, 2, 'two arrows, one per side');
  const xs = (p) => [...p.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1]));
  const [leftPath, rightPath] = narrowArrows;
  assert.ok(Math.max(...xs(leftPath)) < 11, 'the left arrow lives left of the dial centre');
  assert.ok(Math.min(...xs(rightPath)) > 11, 'the right arrow lives right of the dial centre');

  // Runs early: two arrows STACKED IN LINE — same row, different stretches of it — and both
  // pointing LEFT. Chad, on the first cut: "stack the arrows not make them parallel." They
  // used to sit one above the other at the same x, which at map size read as a bar rather
  // than as arrows; this pins the arrangement that replaced it.
  const earlyArrows = marker('hours_runs_early').match(/<path[^>]*d="([^"]*)"/g) || [];
  assert.equal(earlyArrows.length, 2, 'two arrows');
  const ys = (p) => [...p.matchAll(/[ML]-?[\d.]+ (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const [a1, a2] = earlyArrows;
  assert.deepEqual(ys(a1), ys(a2), 'both arrows sit on ONE row — stacked in line, not parallel rails');

  // …and they occupy different stretches of that row, with clear air between them. The gap is
  // load-bearing: the outline pass adds 1.5 to every stroke, so a pair closer than about 3
  // units has its halos meet and welds back into the single shape this replaced.
  const span = (p) => { const x = xs(p); return [Math.min(...x), Math.max(...x)]; };
  const [lead, trail] = [span(a1), span(a2)].sort((p, q) => p[0] - q[0]);
  const gap = trail[0] - lead[1];
  assert.ok(gap > 3, `the two arrows need air between them — gap is ${gap}`);

  // Both shafts run from a HIGH x to a LOW x: right to left.
  for (const p of [a1, a2]) {
    const shaft = xs(p).slice(0, 2);
    assert.ok(shaft[0] > shaft[1], 'the shaft is drawn right-to-left, so the head is on the left');
  }
});

test('runs_late is an exact horizontal mirror of runs_early', () => {
  // The two marks are one idea pointing opposite ways. Drawn by hand they would drift; a
  // mirror is checkable, so it is checked: reflecting every x about the 22-grid centre must
  // turn one glyph's arrows into the other's.
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const arrows = (key) => (app.slice(app.indexOf(`  ${key}: {`), app.indexOf(`  ${key}: {`) + 3000)
    .match(/markerGlyph: `([\s\S]*?)`/)[1].match(/<path[^>]*d="([^"]*)"/g) || [])
    .map((p) => p.match(/d="([^"]*)"/)[1]);
  // Compared as GEOMETRY, not as text. 22 - 14 is 8 and a glyph may spell that 8.0; a string
  // compare would fail on the formatting and send the next person hunting a bug that is not
  // there. Every coordinate is put through Number() on both sides first.
  const nums = (d) => d.replace(/-?\d+(?:\.\d+)?/g, (n) => String(Number(n)));
  const mirror = (d) => nums(d).replace(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g,
    (_m, x, y) => `${Number((22 - Number(x)).toFixed(2))} ${y}`);

  const early = arrows('hours_runs_early');
  const late = arrows('hours_runs_late');
  assert.equal(early.length, 2);
  assert.equal(late.length, 2);
  for (let i = 0; i < 2; i += 1) assert.equal(mirror(early[i]), nums(late[i]), `arrow ${i + 1} mirrors`);

  // And they point opposite ways: each shaft is drawn from its tail to its head.
  const shaftX = (d) => [...d.matchAll(/[ML](-?[\d.]+) /g)].map((m) => Number(m[1])).slice(0, 2);
  for (const d of early) assert.ok(shaftX(d)[0] > shaftX(d)[1], 'runs_early shafts run right-to-left');
  for (const d of late) assert.ok(shaftX(d)[0] < shaftX(d)[1], 'runs_late shafts run left-to-right');
});

test('a runs-late chip prints the whole window like its siblings', () => {
  const c = timeMarkChip(typed('10:00', '19:00'), 'fri');
  assert.equal(c.kind, 'hours_runs_late');
  assert.equal(c.text, '10:00a–7:00p');
});

// ── THE INVARIANT: not one pin gained, not one lost ──────────────────────────

test('the split changes NO stop from marked to unmarked, or the reverse', () => {
  // The rule exactly as it stood before v1.15.1, so the comparison is against the shipped
  // behaviour rather than against a description of it.
  const before = (o, c) => {
    if (o == null && c == null) return null;
    if (c != null && c < SHUTS_EARLY_BEFORE) return 'hours_shuts_early';
    if (o != null && c != null && c - o <= TIGHT_WINDOW_MAX) return 'hours_shuts_early';
    if (c != null && c < EARLY_CLOSE_BEFORE) return 'hours_early_close';
    if (o != null && o >= OPENS_LATE_FROM) return 'hours_opens_late';
    if (o != null && o <= OPENS_EARLY_BY) return 'hours_extra_room';
    if (c != null && c >= OPEN_LATE_FROM) return 'hours_extra_room';
    return null;
  };
  // Only these two substitutions are allowed, and only in this direction.
  const SPLIT = {
    hours_opens_late: ['hours_narrow_window', 'hours_runs_late'],
    hours_extra_room: ['hours_runs_early'],
  };

  let split = 0;
  for (let o = 0; o <= 24 * 60; o += 15) {
    for (const c of [null, ...Array.from({ length: 97 }, (_, i) => i * 15)]) {
      const was = before(o, c);
      const now = classifyTimeMark(o, c);
      assert.equal(was === null, now === null,
        `${o}/${c}: a stop changed between marked and unmarked`);
      if (was === now) continue;
      assert.ok((SPLIT[was] || []).includes(now),
        `${o}/${c}: ${was} may only become ${SPLIT[was]}, not ${now}`);
      split += 1;
    }
  }
  // A sanity floor: the sweep genuinely exercised the new branches rather than passing
  // because nothing ever reached them.
  assert.ok(split > 100, `the sweep found ${split} split cases`);
});

test('the close dial is the only new number, and it sits where Chad put it', () => {
  assert.equal(EARLY_FINISH_BEFORE, 17 * 60, '5:00pm');
  // The open half of both of his sentences is already covered, and covered more strictly.
  assert.ok(OPENS_LATE_FROM >= 8 * 60, 'the narrow mark cannot fire before his 8:00a');
  assert.ok(OPENS_EARLY_BY < 8 * 60, 'the runs-early mark cannot fire after his 8:00a');
  assert.ok(EARLY_CLOSE_BEFORE < EARLY_FINISH_BEFORE, 'a real deadline is stricter and outranks');
});
