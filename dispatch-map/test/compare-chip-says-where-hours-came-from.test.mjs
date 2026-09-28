// EACH COMPARE CHIP SAYS WHERE ITS HOURS REALLY CAME FROM — AND THE SWITCH PUTS ALL OF IT BACK.
//
// v1.74.2 (Chad's approved RWB-CHANGE for TITAN ELECTRIC) put auto-detected receiving hours on
// the Compare row behind VITE_COMPARE_AUTO_HOURS. The Sep 26 audit found two things wrong:
//   1. every chip whose hours nobody typed said "read from the order text" — including hours
//      read from the address line and hours with no recorded source, which the stop card on the
//      same row calls "Read from the address line Davis curates" and "Source not recorded";
//   2. two label edits sat OUTSIDE the switch, live with it on or off: every chip's icon
//      tooltip / screen-reader label became the window instead of the kind of window, and the
//      hours-on-file icon lost "— typed by a dispatcher".
// Chad, 2026-09-28, picked "Yes — fix #1026 labels": "Both label edits go behind
// VITE_COMPARE_AUTO_HOURS, and each chip says where its hours really came from."
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { timeMarkChip, chipHoursSource, HOURS_ON_FILE_KEY } from '../src/lib/time-marks.js';
import { hoursProvenance } from '../src/lib/hours-provenance.js';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';

const ON = { autoHours: true };
const OFF = { autoHours: false };
const day = (open, close) => ({ fri: { open, close } });

// THE FOUR PLACES STORED HOURS COME FROM, as the writers record them: the stop card's editor
// latches manual_overrides (App.jsx note editor); the scanner stamps auto_sources/auto_matches
// with one of its two SignalSources (customer-notes-writer.ts, signal-scanner.ts); anything
// older carries no trail.
const PROV = {
  typed: { manual_overrides: { receiving_hours: true } },
  orderText: {
    auto_sources: { receiving_hours: ['orderInstructions'] },
    auto_matches: { receiving_hours: [{ source: 'orderInstructions', text: 'RH 7AM-3 30PM', pattern: 'hours_range' }] },
  },
  addressLine: {
    auto_sources: { receiving_hours: ['addressLine2'] },
    auto_matches: { receiving_hours: [{ source: 'addressLine2', text: 'REC HRS 7-3:30', pattern: 'hours_range' }] },
  },
  unrecorded: {},
};
const note = (prov, open, close) => ({ ...PROV[prov], receiving_hours: day(open, close) });
const WORDS = {
  typed: 'set by a dispatcher',
  orderText: 'read from the order text',
  addressLine: 'read from the address line',
  unrecorded: 'source not recorded',
};

// ── the words, one source at a time ──────────────────────────────────────────

test('TITAN ELECTRIC (Uline order text): the chip still says it was read from the order text', () => {
  const chip = timeMarkChip(note('orderText', '07:00', '15:30'), 'fri', ON);
  assert.equal(chip.text, '7:00a–3:30p');
  assert.equal(chip.auto, true);
  assert.equal(chip.title, 'Receiving 7:00a–3:30p — read from the order text');
});

test('hours read off the address line Davis keeps say so — never "order text"', () => {
  const ordinary = timeMarkChip(note('addressLine', '07:00', '15:30'), 'fri', ON);
  assert.equal(ordinary.kind, HOURS_ON_FILE_KEY);
  assert.equal(ordinary.title, 'Receiving 7:00a–3:30p — read from the address line');
  const early = timeMarkChip(note('addressLine', '07:00', '14:00'), 'fri', ON);
  assert.equal(early.kind, 'hours_early_close');
  assert.equal(early.title, 'Receiving 7:00a–2:00p — read from the address line');
  for (const c of [ordinary, early]) {
    assert.equal(c.auto, true, 'still hours nobody typed, so the row still says · auto');
    assert.doesNotMatch(c.title, /order text/);
  }
});

test('hours with no trail at all say "source not recorded" — never "order text"', () => {
  const ordinary = timeMarkChip(note('unrecorded', '07:00', '15:30'), 'fri', ON);
  assert.equal(ordinary.title, 'Receiving 7:00a–3:30p — source not recorded');
  const shuts = timeMarkChip(note('unrecorded', '06:00', '11:00'), 'fri', ON);
  assert.equal(shuts.title, 'Receiving 6:00a–11:00a — source not recorded');
  // A legacy M2.x range string carries no trail either, and is read by the same rule.
  const legacy = timeMarkChip({ receiving_hours: { fri: '6AM-2PM' } }, 'fri', ON);
  assert.equal(legacy.title, 'Receiving 6:00a–2:00p — source not recorded');
});

test('AMERICAS VALUE CHANNEL and INTUITIVE SURGICAL (typed): with the switch on, every typed chip says "set by a dispatcher"', () => {
  const avc = timeMarkChip(note('typed', '11:00', '16:00'), 'fri', ON);
  assert.equal(avc.kind, 'hours_narrow_window');
  assert.equal(avc.title, 'Receiving 11:00a–4:00p — set by a dispatcher');
  assert.equal(avc.auto, undefined, 'typed hours never wear · auto');
  const intuitive = timeMarkChip(note('typed', '08:00', '15:30'), 'fri', ON);
  assert.equal(intuitive.title, 'Receiving 8:00a–3:30p — set by a dispatcher');
  // A latched doc that ALSO carries a scanner trail (stamped before v1.81.3 stopped that) is still
  // the dispatcher's: the latch is what the stop card and the flag engine both read first.
  const lockedWithTrail = { ...PROV.orderText, ...PROV.typed, receiving_hours: day('07:00', '14:00') };
  assert.equal(timeMarkChip(lockedWithTrail, 'fri', ON).title, 'Receiving 7:00a–2:00p — set by a dispatcher');
});

test('a scanner trail that names no source it knows says "auto-detected" and names none', () => {
  const odd = { auto_sources: { receiving_hours: ['somewhereElse'] }, receiving_hours: day('07:00', '15:30') };
  assert.equal(timeMarkChip(odd, 'fri', ON).title, 'Receiving 7:00a–3:30p — auto-detected');
});

// ── one rule: the chip and the stop card cannot disagree ──────────────────────

test('the chip names the same source the stop card does, including the awkward trails', () => {
  // The stop card (StopNotesSection → hoursProvenance) is one tap away on the same row. These
  // are the shapes where reading the fields directly would part company with it.
  const cases = [
    [note('typed', '08:00', '15:30'), 'dispatcher', 'set by a dispatcher'],
    [note('orderText', '08:00', '15:30'), 'auto', 'read from the order text'],
    [note('addressLine', '08:00', '15:30'), 'auto', 'read from the address line'],
    [note('unrecorded', '08:00', '15:30'), 'unrecorded', 'source not recorded'],
    // auto_matches only, no auto_sources: the card reads the match's source.
    [{ auto_matches: { receiving_hours: [{ source: 'addressLine2', text: 'RH 8-3:30' }] }, receiving_hours: day('08:00', '15:30') }, 'auto', 'read from the address line'],
    // an EMPTY auto_sources array: the card calls it unrecorded, whatever auto_matches holds.
    [{ auto_sources: { receiving_hours: [] }, auto_matches: { receiving_hours: [{ source: 'orderInstructions', text: 'x' }] }, receiving_hours: day('08:00', '15:30') }, 'unrecorded', 'source not recorded'],
  ];
  for (const [n, cardKind, words] of cases) {
    assert.equal(hoursProvenance(n).kind, cardKind, JSON.stringify(n));
    assert.equal(chipHoursSource(n), words, JSON.stringify(n));
    assert.equal(timeMarkChip(n, 'fri', ON).title, `Receiving 8:00a–3:30p — ${words}`);
  }
});

// ── the sweep: every window shape, every source ──────────────────────────────

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const SHAPES = (() => {
  const t = []; for (let m = 5 * 60; m <= 20 * 60; m += 30) t.push(m);
  const out = [];
  for (const o of t) for (const c of t) if (c > o) out.push([hm(o), hm(c)]);
  for (const o of t) out.push([hm(o), '']);
  for (const c of t) out.push(['', hm(c)]);
  return out;
})();

test('NO chip says "read from the order text" unless the scanner read it from order instructions', () => {
  let chips = 0;
  for (const prov of Object.keys(PROV)) {
    for (const [o, c] of SHAPES) {
      const chip = timeMarkChip(note(prov, o, c), 'fri', ON);
      if (!chip) continue;
      chips++;
      assert.ok(chip.title.endsWith(` — ${WORDS[prov]}`), `${prov} ${o}-${c}: "${chip.title}"`);
      if (/order text/.test(chip.title)) assert.equal(prov, 'orderText', `${prov} ${o}-${c}: "${chip.title}"`);
    }
  }
  assert.ok(chips > 1500, `the sweep must actually reach chips (got ${chips})`);
});

test('VITE_COMPARE_AUTO_HOURS=off: every chip is exactly the chip the row had before v1.74.2', () => {
  // Before v1.74.2 the row was typed-only for ordinary windows; a classified window titled
  // itself "Receiving <window>" and nothing more, whoever set it; an ordinary typed window said
  // "— set by a dispatcher"; and no chip carried `auto`. That is the whole rule, restated here
  // so the off switch is held to it on every shape and every source.
  for (const prov of Object.keys(PROV)) {
    for (const [o, c] of SHAPES) {
      const n = note(prov, o, c);
      for (const off of [OFF, undefined, {}]) {
        const chip = timeMarkChip(n, 'fri', off);
        const on = timeMarkChip(n, 'fri', ON);
        if (!chip) {
          assert.ok(!on || (prov !== 'typed' && on.kind === HOURS_ON_FILE_KEY),
            `${prov} ${o}-${c}: only an untyped ordinary window may be switch-on-only`);
          continue;
        }
        assert.equal('auto' in chip, false, `${prov} ${o}-${c}: no marker with the switch off`);
        assert.equal(chip.text, on.text, 'the switch never changes the time the row prints');
        if (chip.kind === HOURS_ON_FILE_KEY) {
          assert.equal(prov, 'typed', `${prov} ${o}-${c}: off, an ordinary window shows only when typed`);
          assert.equal(chip.title, `Receiving ${chip.text} — set by a dispatcher`);
        } else {
          assert.doesNotMatch(chip.title, / — /, `${prov} ${o}-${c}: "${chip.title}" must not name a source when off`);
          assert.equal(on.title, `${chip.title} — ${WORDS[prov]}`, 'on adds the source and nothing else');
        }
      }
    }
  }
});

// ── the two label edits, rendered from the REAL components in App.jsx ─────────

const libs = await libExports(['place-mark.js', 'place-glyphs.js', 'map-legend.js', 'time-marks.js', 'trailer-block.js', 'matchKey.js']);
const lift = (switchOn) => liftFromApp({
  targets: ['TimeMarkChip', 'RestrictionIcon'],
  // COMPARE_AUTO_HOURS_ON is App.jsx's read of VITE_COMPARE_AUTO_HOURS; handing it in is how a
  // build with the flag on or off is reproduced without a bundler.
  inject: { ...libs, React, COMPARE_AUTO_HOURS_ON: switchOn },
  exercise: (l) => {
    renderToStaticMarkup(React.createElement(l.TimeMarkChip, { mark: timeMarkChip(note('typed', '08:00', '15:30'), 'fri', switchOn ? ON : OFF), isMobile: true }));
  },
});
const OFF_APP = lift(false);
const ON_APP = lift(true);
const row = (L, mark, isMobile = false) => renderToStaticMarkup(React.createElement(L.TimeMarkChip, { mark, isMobile }));
const icon = (html) => {
  const aria = /aria-label="([^"]*)"/.exec(html)?.[1];
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  assert.equal(aria, title, 'the tooltip and the screen-reader label say the same thing');
  return aria;
};
const expandedIcon = (L, kind) => icon(renderToStaticMarkup(React.createElement(L.RestrictionIcon, { kind, size: 12 })));

test('VITE_COMPARE_AUTO_HOURS=off: AMERICAS VALUE CHANNEL\'s chip icon names its kind of window again, as before v1.74.2', () => {
  for (const isMobile of [false, true]) {
    const html = row(OFF_APP, timeMarkChip(note('typed', '11:00', '16:00'), 'fri', OFF), isMobile);
    assert.equal(icon(html), 'Narrow window — it has to land mid-day');
    assert.match(html, /<\/svg>11:00a–4:00p<\/span>$/, 'the row prints the window and nothing after it');
  }
});

test('VITE_COMPARE_AUTO_HOURS=off: INTUITIVE SURGICAL\'s hours-on-file icon says "typed by a dispatcher" again, on the row and in the expanded line', () => {
  const mark = timeMarkChip(note('typed', '08:00', '15:30'), 'fri', OFF);
  assert.equal(icon(row(OFF_APP, mark)), 'Receiving hours on file — typed by a dispatcher');
  assert.equal(expandedIcon(OFF_APP, mark.kind), 'Receiving hours on file — typed by a dispatcher');
});

test('VITE_COMPARE_AUTO_HOURS=off: an untyped early-close chip reads "closes 2:00p" with no · auto and no source', () => {
  const html = row(OFF_APP, timeMarkChip(note('unrecorded', '07:00', '14:00'), 'fri', OFF), true);
  assert.equal(icon(html), 'Early close — before the afternoon runs out');
  assert.doesNotMatch(html, /auto|order text|source/);
  assert.match(html, /title="Receiving 7:00a–2:00p"/);
});

test('switch on: the chip icon reads the chip\'s own words — the window and where it came from', () => {
  assert.equal(icon(row(ON_APP, timeMarkChip(note('orderText', '07:00', '15:30'), 'fri', ON))),
    'Receiving 7:00a–3:30p — read from the order text');
  assert.equal(icon(row(ON_APP, timeMarkChip(note('addressLine', '07:00', '14:00'), 'fri', ON), true)),
    'Receiving 7:00a–2:00p — read from the address line');
  const avc = row(ON_APP, timeMarkChip(note('typed', '11:00', '16:00'), 'fri', ON));
  assert.equal(icon(avc), 'Receiving 11:00a–4:00p — set by a dispatcher');
  assert.doesNotMatch(avc, /· auto/);
  // The row still says · auto for hours nobody typed (the marker's scope is v1.74.2's, unchanged);
  // the words that name the source live in the title and the expanded line.
  assert.match(row(ON_APP, timeMarkChip(note('unrecorded', '07:00', '15:30'), 'fri', ON)), /7:00a–3:30p<span class="font-normal text-slate-400"> · auto<\/span>/);
});

test('switch on: the expanded line\'s hours-on-file icon does not claim "typed" — an auto window wears it too', () => {
  assert.equal(expandedIcon(ON_APP, HOURS_ON_FILE_KEY), 'Receiving hours on file');
});

test('the map pins and the Legend still build the icon table without knowing the Compare switch', async () => {
  // The hours-on-file label reads the switch when it is DRAWN. Building the table must not read
  // it: the pin and legend pipelines lift RESTRICTION_ICONS as plain data, with no build-time
  // switches in scope, and never draw this key.
  const { loadMarkerPipeline } = await import('./helpers/app-markers.mjs');
  const { RESTRICTION_ICONS } = await loadMarkerPipeline();
  assert.equal(RESTRICTION_ICONS.hours_narrow_window.label, 'Narrow window — it has to land mid-day');
  assert.equal(RESTRICTION_ICONS.hours_on_file.short, 'Hours on file');
});
