// THE RESTRICTIONS COLUMN, RUN FOR REAL — not grepped.
//
// Chad, on the 2026-09-10 unplanned board (192 orders): "DO ORDERS THAT HAVE DO NOT
// DOUBLE STACK IN THE NOTES SHOW UP HERE WITH A DNDS RESTRICTION". They did not. This
// lifts the shipped cell renderer out of App.jsx and puts his actual seven rows through
// it, so the answer to that question is a string this test printed, not a claim.
//
// Lifted rather than imported for the reason app-markers.mjs gives: App.jsx is a
// 25,000-line React module node:test cannot import, and a regex over its source pins the
// shape of the code instead of the value it produces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { timeMarkForDay } from '../src/lib/time-marks.js';
import { stopHandlingFlags, HANDLING_FLAGS } from '../src/lib/handling-flags.js';

const APP_PATH = new URL('../src/App.jsx', import.meta.url);
const NEEDED = [
  'RESTRICTION_ICONS', 'UNKNOWN_RESTRICTION', 'RESTRICTION_ALIASES',
  'resolveRestrictionKey', '__ttFriendlyConflictLogged', 'getRestrictionBadgeKeys',
  'restrCellText',
];

function declarationSource(lines, name) {
  const re = new RegExp(`^(?:export\\s+)?(?:const|let|function)\\s+${name}\\b`);
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error(`restrictions-column: '${name}' is not a top-level declaration in App.jsx`);
  const opensBlock = /[{[(]\s*(?:\/\/.*)?$/.test(lines[i]) || !/;\s*(?:\/\/.*)?$/.test(lines[i]);
  if (!opensBlock) return lines[i];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^(?:\}|\};|\]|\];|\)|\);)\s*(?:\/\/.*)?$/.test(lines[j])) return lines.slice(i, j + 1).join('\n');
  }
  throw new Error(`restrictions-column: could not find the end of '${name}'`);
}

const lines = readFileSync(APP_PATH, 'utf8').split('\n');
const decls = NEEDED.map((n) => ({ n, i: lines.findIndex((l) => new RegExp(`^(?:export\\s+)?(?:const|let|function)\\s+${n}\\b`).test(l)) }))
  .sort((a, b) => a.i - b.i)                       // App.jsx's own order, so no temporal dead zone
  .map(({ n }) => declarationSource(lines, n)).join('\n\n');
// eslint-disable-next-line no-new-func
const app = new Function('timeMarkForDay', 'stopHandlingFlags', 'HANDLING_FLAGS',
  `${decls}\nreturn { restrCellText, getRestrictionBadgeKeys };`,
)(timeMarkForDay, stopHandlingFlags, HANDLING_FLAGS);

/** The seven rows exactly as the board showed them, comments verbatim. */
const BOARD = [
  { stopNbr: '007174506', businessName: 'ART & ASSOCIATES',        matchKey: 'k1', cartons: 1, comments: 'SPL-INSTR-TEXT: Do NOT Deliver Double Stacked; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID' },
  { stopNbr: '007174547', businessName: 'VERISMA',                 matchKey: 'k2', cartons: 1, comments: 'SPL-INSTR-TEXT: Do NOT Deliver Double Stacked; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID' },
  { stopNbr: '007174564', businessName: 'JAY BROKERS',             matchKey: 'k3', cartons: 1, comments: 'SPL-INSTR-TEXT: Do NOT Deliver Double Stacked; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID' },
  { stopNbr: '007174369', businessName: 'HOPE INDUSTRIAL SYSTEMS', matchKey: 'k4', cartons: 1, comments: 'SPL-INSTR-TEXT: ALL FREIGHT DELIVERIES; SPL-INSTR-TEXT: MUST DELIVER AFTER 8AM' },
  { stopNbr: '007174509', businessName: 'FINDER RELAYS INC',       matchKey: 'k5', cartons: 1, comments: 'SPL-INSTR-TEXT: Do NOT Deliver Double Stacked; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID' },
  { stopNbr: '007174442', businessName: 'SPORTOGRAPHY',            matchKey: 'k6', cartons: 1, comments: 'SPL-INSTR-TEXT: Do NOT Deliver Double Stacked; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID' },
  { stopNbr: '007174384', businessName: 'MENCOM CORPORATION',      matchKey: 'k7', cartons: 2, comments: 'SPL-INSTR-TEXT: DO NOT LAY PALLETS OF; SPL-INSTR-TEXT: BOXES ON THEIR SIDE' },
].map((r) => ({ ...r, signalSources: { orderInstructions: r.comments } }));

const NO_NOTES = new Map();

test('the five DNDS orders off the 2026-09-10 board now read DNDS in the Restrictions column', () => {
  const cells = BOARD.map((s) => [s.businessName, app.restrCellText(s, NO_NOTES)]);
  assert.deepEqual(cells, [
    ['ART & ASSOCIATES', 'DNDS'],
    ['VERISMA', 'DNDS'],
    ['JAY BROKERS', 'DNDS'],
    ['HOPE INDUSTRIAL SYSTEMS', ''],       // "MUST DELIVER AFTER 8AM" is not a stacking fact
    ['FINDER RELAYS INC', 'DNDS'],
    ['SPORTOGRAPHY', 'DNDS'],
    ['MENCOM CORPORATION', ''],            // "DO NOT LAY PALLETS OF" is a different instruction
  ]);
});

test("a customer's standing restrictions keep their place, and the order's freight fact comes after", () => {
  // The two are different KINDS of fact sharing one cell — the customer's hold every day,
  // the order's holds for this shipment. A dispatcher reads the standing ones first.
  const notes = new Map([['k1', { equipment_restrictions: ['no_tractor_trailer'], liftgate_required: true }]]);
  assert.equal(app.restrCellText(BOARD[0], notes), 'No T/T, Liftgate, DNDS');
});

test('a stop with neither kind of restriction still renders an empty cell, not "undefined"', () => {
  assert.equal(app.restrCellText({ matchKey: 'nope' }, NO_NOTES), '');
});

test('the DNDS chip is NOT reachable through the customer-note path that feeds the map pin', () => {
  // getRestrictionBadgeKeys is what the marker layer and the legend read. If a handling
  // flag ever leaks into it, the pin starts claiming the ADDRESS cannot take stacked
  // freight — which is not what the order said, and it would stick to that customer.
  const notes = new Map([['k1', { equipment_restrictions: [] }]]);
  assert.deepEqual(app.getRestrictionBadgeKeys(notes.get('k1')), []);
  assert.equal(app.restrCellText(BOARD[0], notes), 'DNDS');
});
