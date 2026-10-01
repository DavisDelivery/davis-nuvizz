// test/scan-notes-auto.test.mjs — the stop card uses the notes the normal scans pick up, without a
// Refresh (v1.100.2). Chad, 2026-10-01, on ROBERT BOSCH (PRO 007183226): "IF there are new notes
// picked up in the normal scans not enrichment then use them i shouldn't have to refresh to get
// them you know what they are so if some are added or deleted just auto use them".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mergedNotes, scanNoteEntries, scanNotesAutoEnabled, noteTextChanged } from '../src/lib/stop-notes-freshness.js';
import { liftFromApp } from './helpers/app-lift.mjs';

// The card in Chad's screenshot, word for word as the stored 2026-10-01 board holds it (the contact's
// email swapped for a placeholder).
const ULINE = (text) => ({ text, type: 'ORD_IN', typeDesc: 'Order Instructions', addedBy: 'INTG ULINE', source: 'Order - Order Instructions', addedOn: '2026-09-28T16:50:22' });
const BOSCH = {
  stopNbr: '007183226',
  orderInstructions: 'Please have the driver to use load # 007182502 for the load # when registering with security.; SPL-INSTR-TEXT: EMAIL FOR APPT; SPL-INSTR-TEXT: RECEIVING@EXAMPLE.COM; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID; SPL-INSTR-TEXT: NTFY OF DELIVERY-APPT REQD; TOTAL-AMOUNT : 99.00',
  allComments: ['SPL-INSTR-TEXT: EMAIL FOR APPT', 'SPL-INSTR-TEXT: RECEIVING@EXAMPLE.COM', 'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID', 'SPL-INSTR-TEXT: NTFY OF DELIVERY-APPT REQD', 'TOTAL-AMOUNT : 99.00'].map(ULINE),
};

test('BOSCH: the instruction the scan picked up shows at once, first, with no Refresh', () => {
  assert.equal(noteTextChanged(BOSCH), true, 'this is the card that showed the amber banner');
  const notes = mergedNotes(BOSCH);
  assert.equal(notes[0].text, 'Please have the driver to use load # 007182502 for the load # when registering with security.');
  assert.equal(notes[0].fromScan, true);
  assert.equal(notes[0].isNew, true, 'there are stored notes for it to be newer than');
  // The stored notes stay, author and time included, and none is wrongly marked gone.
  const stored = notes.slice(1);
  assert.equal(stored.length, 5);
  assert.ok(stored.every((n) => n.addedBy === 'INTG ULINE' && !n.gone && !n.fromScan));
});

test('a note NuVizz no longer carries is shown faded, never dropped — and only an order instruction is judged', () => {
  const stop = {
    orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT',
    allComments: [ULINE('SPL-INSTR-TEXT: EMAIL FOR APPT'), ULINE('SPL-INSTR-TEXT: CALL 30 MIN AHEAD'),
      { text: 'Gate code 4471', type: 'PRE_VISIT', typeDesc: 'Pre-visit', addedBy: 'CHAD' }],
  };
  const notes = mergedNotes(stop);
  assert.deepEqual(notes.map((n) => [n.text, !!n.gone]), [
    ['SPL-INSTR-TEXT: EMAIL FOR APPT', false],
    ['SPL-INSTR-TEXT: CALL 30 MIN AHEAD', true],   // the order instruction the scan dropped
    ['Gate code 4471', false],                      // a pre-visit note the list may never carry
  ]);
});

test('a scan line cut short still names its note — truncation is not a new note and not a deletion', () => {
  const stop = {
    orderInstructions: 'SPL-INSTR-TEXT: DELIVER TO RECEIVING DOCK 4 ONLY BETWEEN 8',
    allComments: [ULINE('SPL-INSTR-TEXT: DELIVER TO RECEIVING DOCK 4 ONLY BETWEEN 8 AND 2')],
  };
  const notes = mergedNotes(stop);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].gone, undefined);
  assert.equal(notes[0].fromScan, undefined);
});

test('punctuation, case and spacing drift between the list and the stored note is the same note', () => {
  const stop = { orderInstructions: 'spl-instr-text:  ntfy of delivery-appt reqd;', allComments: [ULINE('SPL-INSTR-TEXT: NTFY OF DELIVERY-APPT REQD')] };
  const notes = mergedNotes(stop);
  assert.equal(notes.length, 1);
  assert.ok(!notes[0].gone && !notes[0].fromScan);
});

test('no scan text: the stored notes exactly as before — nothing faded, nothing added', () => {
  const notes = mergedNotes({ allComments: BOSCH.allComments });
  assert.deepEqual(notes, BOSCH.allComments.map((c) => ({ ...c })));
  assert.deepEqual(mergedNotes({}), []);
  assert.deepEqual(mergedNotes(null), []);
});

test('no stored notes yet: the scan’s notes are the notes, each its own line — and none is called new', () => {
  const notes = mergedNotes({ orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT; TOTAL-AMOUNT : 99.00' });
  assert.deepEqual(notes, [{ text: 'EMAIL FOR APPT', fromScan: true }, { text: 'TOTAL-AMOUNT : 99.00', fromScan: true }]);
});

// Real cards off the stored 2026-09-30 board (read from Firestore, zero NuVizz calls). The old banner
// needed two unseen words making up a third of the text, so a one-word note or a short line under a
// long ULINE block never tripped it — the card kept its old notes and never asked.
test('2026-09-30: “refused” and a ULINE cancellation, both under the old banner’s threshold, now show at once', () => {
  const refused = {   // 007183817
    orderInstructions: 'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID; TOTAL-AMOUNT : 59.29; refused',
    allComments: [ULINE('SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID'), ULINE('TOTAL-AMOUNT : 59.29')],
  };
  const cancelled = { // 007184027
    orderInstructions: 'SPL-INSTR-TEXT: NO APPT REQUIRED; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID; SPL-INSTR-TEXT: RESIDENTIAL DELIVERY; SPL-INSTR-TEXT: STRAIGHT TRUCK ONLY; TOTAL-AMOUNT : 59.29; CANCELLED ORDER. STOP & RETURN PER ULINE.',
    allComments: ['SPL-INSTR-TEXT: NO APPT REQUIRED', 'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID', 'SPL-INSTR-TEXT: RESIDENTIAL DELIVERY', 'SPL-INSTR-TEXT: STRAIGHT TRUCK ONLY', 'TOTAL-AMOUNT : 59.29'].map(ULINE),
  };
  for (const [stop, text] of [[refused, 'refused'], [cancelled, 'CANCELLED ORDER. STOP & RETURN PER ULINE.']]) {
    assert.equal(noteTextChanged(stop), false, 'the old banner stayed silent on this card');
    const notes = mergedNotes(stop);
    assert.deepEqual(notes[0], { text, fromScan: true, isNew: true });
    assert.equal(notes.filter((n) => n.fromScan).length, 1, 'only the new note is new');
    assert.ok(notes.every((n) => !n.gone));
  }
});

test('an AVRT order, never enriched, whose only note is its price: shown plain, never “New”', () => {
  const notes = mergedNotes({ stopNbr: 'AVRT-0170416957', orderInstructions: '62.96' });
  assert.deepEqual(notes, [{ text: '62.96', fromScan: true }]);
});

test('a note that itself holds “; ” reaches the scan in pieces — it is not gone, and its pieces are not new', () => {
  const stop = {
    orderInstructions: 'SPL-INSTR-TEXT: CALL JOE; GATE 4; TOTAL-AMOUNT : 59.29',
    allComments: [ULINE('SPL-INSTR-TEXT: CALL JOE; GATE 4'), ULINE('TOTAL-AMOUNT : 59.29')],
  };
  const notes = mergedNotes(stop);
  assert.deepEqual(notes.map((n) => [n.text, !!n.gone, !!n.fromScan]), [
    ['SPL-INSTR-TEXT: CALL JOE; GATE 4', false, false],
    ['TOTAL-AMOUNT : 59.29', false, false],
  ]);
  // Whole words only: "GATE 4" is not inside a note about GATE 42.
  const other = mergedNotes({ orderInstructions: 'GATE 42; TOTAL-AMOUNT : 59.29', allComments: [ULINE('SPL-INSTR-TEXT: GATE 4'), ULINE('TOTAL-AMOUNT : 59.29')] });
  assert.equal(other.find((n) => n.text === 'SPL-INSTR-TEXT: GATE 4').gone, true);
  assert.deepEqual(other[0], { text: 'GATE 42', fromScan: true, isNew: true });
});

test('a text cut short (the active pool’s 400-character “…”) strikes nothing through — absence past the cut proves nothing', () => {
  const stop = {
    orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT; SPL-INSTR-TEXT: RECEIVING HOURS 8A-3…',
    allComments: [ULINE('SPL-INSTR-TEXT: EMAIL FOR APPT'), ULINE('SPL-INSTR-TEXT: RECEIVING HOURS 8A-3 30P'), ULINE('SPL-INSTR-TEXT: CALL 30 MIN AHEAD')],
  };
  const notes = mergedNotes(stop);
  assert.ok(notes.every((n) => !n.gone), JSON.stringify(notes));
  // The same card uncut does mark the one NuVizz no longer carries.
  const uncut = mergedNotes({ ...stop, orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT; SPL-INSTR-TEXT: RECEIVING HOURS 8A-3 30P' });
  assert.deepEqual(uncut.filter((n) => n.gone).map((n) => n.text), ['SPL-INSTR-TEXT: CALL 30 MIN AHEAD']);
});

test('scanNoteEntries splits the list’s one line back into its notes', () => {
  assert.deepEqual(scanNoteEntries(BOSCH.orderInstructions), [
    'Please have the driver to use load # 007182502 for the load # when registering with security.',
    'EMAIL FOR APPT', 'RECEIVING@EXAMPLE.COM', 'DO NOT BREAKDOWN SKID', 'NTFY OF DELIVERY-APPT REQD', 'TOTAL-AMOUNT : 99.00',
  ]);
  assert.deepEqual(scanNoteEntries(''), []);
  assert.deepEqual(scanNoteEntries(null), []);
});

test('VITE_SCAN_NOTES_AUTO: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(scanNotesAutoEnabled({}), true);
  assert.equal(scanNotesAutoEnabled(undefined), true);
  for (const v of ['off', 'OFF', '0', 'false', ' no ']) assert.equal(scanNotesAutoEnabled({ VITE_SCAN_NOTES_AUTO: v }), false, v);
  for (const v of ['offf', 'on', '1', '', 'nope']) assert.equal(scanNotesAutoEnabled({ VITE_SCAN_NOTES_AUTO: v }), true, v);
});

// ── the card draws them, the REAL StopNotesList lifted out of App.jsx ────────
const L = liftFromApp({
  targets: ['StopNotesList'],
  inject: { React, useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo, useRef: React.useRef, useCallback: React.useCallback },
  exercise: (l) => { renderToStaticMarkup(React.createElement(l.StopNotesList, { comments: [...mergedNotes(BOSCH), { ...ULINE('X'), gone: true }, { text: '62.96', fromScan: true }] })); },
});

test('the card says which note is new from the scan and which NuVizz no longer lists', () => {
  const html = renderToStaticMarkup(React.createElement(L.StopNotesList, { comments: mergedNotes({
    orderInstructions: 'Please have the driver use load # 007182502.; SPL-INSTR-TEXT: EMAIL FOR APPT',
    allComments: [ULINE('SPL-INSTR-TEXT: EMAIL FOR APPT'), ULINE('SPL-INSTR-TEXT: CALL 30 MIN AHEAD')],
  }) }));
  assert.match(html, /data-note="scan"[^>]*>.*Please have the driver use load # 007182502\..*New — from the latest scan/s);
  assert.match(html, /data-note="stored"[^>]*>.*EMAIL FOR APPT.*Order Instructions — INTG ULINE/s);
  assert.match(html, /data-note="gone"[^>]*opacity-60[^>]*>.*line-through[^>]*>CALL 30 MIN AHEAD.*Not in NuVizz’s latest notes/s);
  // The boilerplate the card has always hidden stays hidden, whichever source carried it.
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(L.StopNotesList, { comments: mergedNotes(BOSCH) })), /BREAKDOWN SKID/);
});

test('an AVRT price-only card draws its note plain — no blue, no “New”', () => {
  const html = renderToStaticMarkup(React.createElement(L.StopNotesList, { comments: mergedNotes({ orderInstructions: '62.96' }) }));
  assert.match(html, /data-note="scan-only"[^>]*bg-slate-50[^>]*>.*62\.96.*From NuVizz’s latest scan/s);
  assert.doesNotMatch(html, /New —|bg-blue-50/);
});

// ── the panel uses the merge, and the Refresh banner steps aside ────────────
const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
test('StopLiveDetail draws the merged notes when the switch is on, and the old banner only when it is off', () => {
  assert.match(APP, /import \{ noteFreshness, mergedNotes, SCAN_NOTES_AUTO_ON \} from '\.\/lib\/stop-notes-freshness\.js';/);
  assert.match(APP, /const notes = SCAN_NOTES_AUTO_ON \? mergedNotes\(stop\) : null;/);
  assert.match(APP, /\{!SCAN_NOTES_AUTO_ON && fresh\.stale && \(/);
  assert.match(APP, /\{notes\?\.length \? \(\s*<StopNotesList comments=\{notes\} \/>\s*\) : !SCAN_NOTES_AUTO_ON && stop\.allComments\?\.length \? \(/);
});
