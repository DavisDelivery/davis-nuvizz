// test/manifest-notes.test.mjs — the printed ticket carries the notes NuVizz lists now (v1.100.3).
// Chad, 2026-10-01, on the card's faded "Not in NuVizz's latest notes": "do this in the portal but
// on the print manifest don't put them on there at all." The screen keeps the faded line; the paper
// leaves it off, and prints the note the latest scan picked up. Every ticket — the route panel's
// Print Manifest, a Compare card's Print manifest, a single Delivery Ticket — reads its notes
// through ticketData → ticketNotes, so the REAL builders are lifted out of App.jsx and run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ticketNotes, printedNotes, mergedNotes, manifestScanNotesEnabled, MANIFEST_SCAN_NOTES_ON, stampNotesRead, manifestNewNotesEnabled, MANIFEST_NEW_NOTES_ON } from '../src/lib/stop-notes-freshness.js';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';

const ULINE = (text) => ({ text, type: 'ORD_IN', typeDesc: 'Order Instructions', addedBy: 'INTG ULINE', source: 'Order - Order Instructions', addedOn: '2026-09-28T16:50:22' });
const OLD = (stop) => {   // what ticketData printed before v1.100.3, kept here word for word
  const raw = (stop && stop.raw && stop.raw.stop) || {};
  return (Array.isArray(stop.allComments) && stop.allComments.length)
    ? stop.allComments.map((c) => ({ text: c.text, by: c.addedBy, on: c.addedOn }))
    : (raw.comments || []).map((c) => ({ text: c.commentDescription, by: c.addedByName, on: c.addedOn }));
};

// 007184027 off the stored 2026-09-30 board: ULINE cancelled the order after it was enriched.
const CANCELLED = {
  stopNbr: '007184027',
  orderInstructions: 'SPL-INSTR-TEXT: NO APPT REQUIRED; SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID; SPL-INSTR-TEXT: RESIDENTIAL DELIVERY; SPL-INSTR-TEXT: STRAIGHT TRUCK ONLY; TOTAL-AMOUNT : 59.29; CANCELLED ORDER. STOP & RETURN PER ULINE.',
  allComments: ['SPL-INSTR-TEXT: NO APPT REQUIRED', 'SPL-INSTR-TEXT: DO NOT BREAKDOWN SKID', 'SPL-INSTR-TEXT: RESIDENTIAL DELIVERY', 'SPL-INSTR-TEXT: STRAIGHT TRUCK ONLY', 'TOTAL-AMOUNT : 59.29'].map(ULINE),
};
// A card whose order instruction NuVizz has since dropped (made up — none did on 9/30 or 10/1).
const DROPPED = {
  stopNbr: '007199001',
  orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT; TOTAL-AMOUNT : 61.80',
  allComments: [ULINE('SPL-INSTR-TEXT: EMAIL FOR APPT'), ULINE('SPL-INSTR-TEXT: CALL 30 MIN AHEAD'), ULINE('TOTAL-AMOUNT : 61.80')],
};

test('a note NuVizz no longer lists is left off the paper — while the card still shows it, faded', () => {
  const paper = ticketNotes(DROPPED, { on: true });
  assert.deepEqual(paper.map((c) => c.text), ['SPL-INSTR-TEXT: EMAIL FOR APPT', 'TOTAL-AMOUNT : 61.80']);
  assert.ok(paper.every((c) => c.by === 'INTG ULINE' && c.on === '2026-09-28T16:50:22'), 'stored notes keep author and time');
  // The portal is unchanged by this: the same stop draws the dropped note faded on screen.
  assert.deepEqual(mergedNotes(DROPPED).filter((n) => n.gone).map((n) => n.text), ['SPL-INSTR-TEXT: CALL 30 MIN AHEAD']);
});

test('2026-09-30, 007184027: the ULINE cancellation the scan picked up is printed on the ticket', () => {
  const paper = ticketNotes(CANCELLED, { on: true });
  assert.deepEqual(paper[0], { text: 'CANCELLED ORDER. STOP & RETURN PER ULINE.', by: undefined, on: undefined, fromScan: true }, 'no author or time — the list sends none');
  assert.equal(paper.length, 6, 'the five stored notes stay too');
  assert.deepEqual(OLD(CANCELLED).map((c) => c.text).includes('CANCELLED ORDER. STOP & RETURN PER ULINE.'), false, 'the old paper never printed it');
});

test('switch off: every ticket prints exactly what it printed before', () => {
  const RAW_ONLY = { stopNbr: '9', orderInstructions: 'GATE CODE 4471', raw: { stop: { comments: [{ commentDescription: 'CALL FIRST', addedByName: 'CSR', addedOn: '2026-09-01T10:00:00' }] } } };
  for (const s of [CANCELLED, DROPPED, RAW_ONLY, { stopNbr: '1' }]) assert.deepEqual(ticketNotes(s, { on: false }), OLD(s), s.stopNbr);
});

test('a text cut short drops nothing from the paper — absence past the cut proves nothing', () => {
  const cut = { ...DROPPED, orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT; TOTAL-AMOU…' };
  assert.equal(ticketNotes(cut, { on: true }).filter((c) => /CALL 30 MIN AHEAD/.test(c.text)).length, 1);
});

test('no scan text, or a label ticket with only a dispatcher note: the paper is what it always was', () => {
  const label = { stopNbr: 'L1', allComments: [{ text: 'Back door', addedBy: 'Dispatcher', addedOn: '2026-10-01T12:00:00Z' }] };
  assert.deepEqual(ticketNotes(label, { on: true }), OLD(label));
  assert.deepEqual(ticketNotes({ allComments: DROPPED.allComments }, { on: true }), OLD({ allComments: DROPPED.allComments }));
});

test('NuVizz’s raw comments, when there are no stored notes, go through the same rule', () => {
  const s = { orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT', raw: { stop: { comments: [
    { commentDescription: 'SPL-INSTR-TEXT: EMAIL FOR APPT', addedByName: 'INTG ULINE', addedOn: 'x' },
    { commentDescription: 'SPL-INSTR-TEXT: LIFT GATE NEEDED', addedByName: 'INTG ULINE', addedOn: 'x' },
  ] } } };
  assert.deepEqual(ticketNotes(s, { on: true }).map((c) => c.text), ['SPL-INSTR-TEXT: EMAIL FOR APPT']);
});

test('printedNotes is what the card shows, less the faded notes', () => {
  for (const s of [CANCELLED, DROPPED, {}, null]) assert.deepEqual(printedNotes(s), mergedNotes(s).filter((n) => !n.gone));
});

test('VITE_MANIFEST_NEW_NOTES=off: the half Chad asked for, alone — removed notes still off, no scan notes printed', () => {
  const both = { ...DROPPED, orderInstructions: DROPPED.orderInstructions + '; **DELIVER BY 3:00PM**' };
  assert.deepEqual(ticketNotes(both, { on: true, addNew: false }).map((c) => c.text), ['SPL-INSTR-TEXT: EMAIL FOR APPT', 'TOTAL-AMOUNT : 61.80']);
  assert.deepEqual(ticketNotes(both, { on: true, addNew: true }).map((c) => c.text), ['**DELIVER BY 3:00PM**', 'SPL-INSTR-TEXT: EMAIL FOR APPT', 'TOTAL-AMOUNT : 61.80']);
  assert.equal(manifestNewNotesEnabled({}), true);
  for (const v of ['off', 'OFF', '0', 'false', ' no ']) assert.equal(manifestNewNotesEnabled({ VITE_MANIFEST_NEW_NOTES: v }), false, v);
  for (const v of ['offf', 'on', '1', '', 'nope']) assert.equal(manifestNewNotesEnabled({ VITE_MANIFEST_NEW_NOTES: v }), true, v);
  assert.equal(MANIFEST_NEW_NOTES_ON, true);
  const LIB = readFileSync(new URL('../src/lib/stop-notes-freshness.js', import.meta.url), 'utf8');
  assert.match(LIB, /export const MANIFEST_NEW_NOTES_ON = MANIFEST_SCAN_NOTES_ON && \(/, 'inside the paper switch, which is inside the card switch');
});

test('an AVRT order with no stored notes: its price line stays off the ticket, as it always was', () => {
  const avrt = { stopNbr: 'AVRT-0170416957', orderInstructions: '62.96' };   // off the 9/30 board
  assert.deepEqual(ticketNotes(avrt, { on: true }), []);
  assert.deepEqual(ticketNotes(avrt, { on: true }), OLD(avrt));
  // The card still shows it, plain — only the paper leaves it off.
  assert.deepEqual(mergedNotes(avrt), [{ text: '62.96', fromScan: true }]);
});

test('VITE_MANIFEST_SCAN_NOTES: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(manifestScanNotesEnabled({}), true);
  assert.equal(manifestScanNotesEnabled(undefined), true);
  for (const v of ['off', 'OFF', '0', 'false', ' no ']) assert.equal(manifestScanNotesEnabled({ VITE_MANIFEST_SCAN_NOTES: v }), false, v);
  for (const v of ['offf', 'on', '1', '', 'nope']) assert.equal(manifestScanNotesEnabled({ VITE_MANIFEST_SCAN_NOTES: v }), true, v);
  assert.equal(MANIFEST_SCAN_NOTES_ON, true, 'in Node both switches read on');
  // The card's switch puts the paper back too, so the paper never uses the scan's notes while the
  // card does not: the constant is the AND of the two.
  const LIB = readFileSync(new URL('../src/lib/stop-notes-freshness.js', import.meta.url), 'utf8');
  assert.match(LIB, /export const MANIFEST_SCAN_NOTES_ON = SCAN_NOTES_AUTO_ON && \(/);
});

// ── the REAL builders, lifted out of App.jsx ────────────────────────────────
const libs = await libExports(['route-identity.js', 'card-manifest.js', 'stop-notes-freshness.js']);
const L = liftFromApp({
  targets: ['buildManifestHtml', 'buildTicketHtml'],
  inject: { ...libs },
  exercise: (l) => { l.buildManifestHtml([DROPPED, CANCELLED], 'logo.jpg', 'TEST'); l.buildTicketHtml(DROPPED, 'logo.jpg'); },
});
const commentsOf = (html) => [...html.matchAll(/<div class="cmt-t">([^<]*)<\/div>/g)].map((m) => m[1]);

test('the printed manifest: the dropped note is not on the page, the scan’s new note is', () => {
  const html = L.buildManifestHtml([DROPPED, CANCELLED], 'logo.jpg', 'TEST');
  const all = commentsOf(html);
  assert.equal(all.some((t) => /CALL 30 MIN AHEAD/.test(t)), false, 'no faded or struck line — it is simply not printed');
  assert.ok(all.includes('CANCELLED ORDER. STOP &amp; RETURN PER ULINE.'));
  assert.doesNotMatch(html, /Not in NuVizz|line-through/);
});

test('a single Delivery Ticket follows the same rule as the manifest page', () => {
  assert.deepEqual(commentsOf(L.buildTicketHtml(DROPPED, 'logo.jpg')), ['SPL-INSTR-TEXT: EMAIL FOR APPT', 'TOTAL-AMOUNT : 61.80']);
});

test('ticketData reads its notes through ticketNotes — the one place the paper’s rule lives', () => {
  const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const body = APP.slice(APP.indexOf('\nfunction ticketData('), APP.indexOf('\nfunction ticketBody('));
  assert.match(body, /const comments = ticketNotes\(stop\);/);
  assert.doesNotMatch(body, /allComments/, 'no second, older reading of the notes left behind');
});

// ── the Refresh race (found by the v1.100.3 review sweep, reproduced before the fix) ─────────
// A CSR adds "CALL 30 MIN AHEAD" in NuVizz after the last scan read the list; the dispatcher hits
// Refresh, which reads the notes WITH it. Until the next scan the scan text still lacks it — so,
// without a stamp, the newest note read as removed: faded on the card and dropped off the ticket.
const RACE = {
  stopNbr: '007199002',
  orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT; TOTAL-AMOUNT : 61.80',
  allComments: [ULINE('SPL-INSTR-TEXT: EMAIL FOR APPT'), ULINE('SPL-INSTR-TEXT: CALL 30 MIN AHEAD'), ULINE('TOTAL-AMOUNT : 61.80')],
};

test('after a Refresh the newest note is printed, not dropped — and not faded on the card', () => {
  const refreshed = { ...RACE, notes_refreshed_at: '2026-10-01T02:20:00.000Z' };
  assert.ok(ticketNotes(refreshed, { on: true }).some((c) => c.text === 'SPL-INSTR-TEXT: CALL 30 MIN AHEAD'));
  assert.equal(mergedNotes(refreshed).some((n) => n.gone), false);
  // Without the stamp the same stop is the deletion case, exactly as before.
  assert.equal(ticketNotes(RACE, { on: true }).some((c) => /CALL 30 MIN AHEAD/.test(c.text)), false);
});

test('the card’s live Refresh is stamped the way the server stamps a saved one', () => {
  const at = '2026-10-01T02:20:00.000Z';
  assert.equal(stampNotesRead({ stopNbr: '1', allComments: RACE.allComments }, at).notes_refreshed_at, at);
  assert.equal(stampNotesRead({ stopNbr: '1', allComments: [] }, at).notes_refreshed_at, undefined, 'no notes read, no stamp');
  assert.equal(stampNotesRead({ stopNbr: '1' }, at).notes_refreshed_at, undefined);
  assert.equal(stampNotesRead({ allComments: RACE.allComments, notes_refreshed_at: 'x' }, at).notes_refreshed_at, 'x', 'a stamp the read carries wins');
  assert.equal(stampNotesRead(null, at), null);
  const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const hook = APP.slice(APP.indexOf('\nfunction useLiveStop('), APP.indexOf('\n}', APP.indexOf('\nfunction useLiveStop(')));
  assert.match(hook, /setFresh\(\(prev\) => foldFreshStop\(prev, stampNotesRead\(d, new Date\(\)\.toISOString\(\)\)\)\);/);
});

// ── the second review round ──────────────────────────────────────────────────
test('a New Order sent with no notes, then given a real one in NuVizz: the paper prints it', () => {
  const s = { stopNbr: '007199003', allComments: [], orderInstructions: 'CANCELLED ORDER. STOP & RETURN PER ULINE.' };
  assert.deepEqual(ticketNotes(s, { on: true }).map((c) => c.text), ['CANCELLED ORDER. STOP & RETURN PER ULINE.']);
  // …while a bare amount on such a stop stays off, in every spelling the 9/30 board carried.
  for (const p of ['56.06', '**166.32**', '$59.99', ' 77.22 ']) assert.deepEqual(ticketNotes({ orderInstructions: p }, { on: true }), [], p);
  // An amount WITH words is a note ("$59.99 JOSH 770-…" on RA58610778 is a contact line) and prints.
  assert.equal(ticketNotes({ orderInstructions: '$59.99 CALL JOSH' }, { on: true }).length, 1);
  // A bare whole number is not dollars and cents — a gate or door code prints.
  for (const code of ['4471', '10', '#4471']) assert.equal(ticketNotes({ orderInstructions: code }, { on: true }).length, 1, code);
  // Every AVRT price on the 9/30 board has two decimals and stays off.
  for (const p of ['56.06', '**166.32**', '62.96', '67.62', '77.22', '106.92', '59.00', '91.48', '58.21']) assert.deepEqual(ticketNotes({ orderInstructions: p }, { on: true }), [], p);
});

test('the scan’s note says where it came from on the paper; stored notes keep their author', () => {
  const html = L.buildTicketHtml(CANCELLED, 'logo.jpg');
  const boxes = [...html.matchAll(/<div class="cmt-t">([^<]*)<\/div>\s*<div class="cmt-m">(.*?)<\/div>/gs)].map((m) => [m[1], m[2]]);
  assert.equal(boxes[0][0], 'CANCELLED ORDER. STOP &amp; RETURN PER ULINE.');
  assert.match(boxes[0][1], /From NuVizz’s latest scan/);
  assert.doesNotMatch(boxes[0][1], /~By/);
  assert.ok(boxes.slice(1).every(([, m]) => /~By INTG ULINE/.test(m)));
});

test('a cut text’s leftover fragment is not a note — not on the card, not on the paper', () => {
  const s = { ...DROPPED, orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT; SPL-INSTR-TEXT: CALL 30 MIN AHEAD; TOTAL-AMOU…' };
  assert.equal(mergedNotes(s).some((n) => n.fromScan), false, JSON.stringify(mergedNotes(s)));
  assert.equal(ticketNotes(s, { on: true }).some((c) => /…/.test(c.text)), false);
  // A lone "…" left after the last "; " is nothing at all.
  assert.equal(mergedNotes({ ...DROPPED, orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT; …' }).some((n) => n.fromScan), false);
  // A long tail is still matched to its note by its start, as before.
  assert.equal(mergedNotes({ ...DROPPED, orderInstructions: 'SPL-INSTR-TEXT: EMAIL FOR APPT; SPL-INSTR-TEXT: CALL 30 MIN AH…' }).some((n) => n.fromScan || n.gone), false);
});
