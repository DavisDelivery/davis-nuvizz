// test/customer-notes-edit-dock-race.test.mjs — ONE DOCK'S NOTE CAN NEVER LAND IN ANOTHER
// DOCK'S EDITOR, AND A SAVE NEVER REPAINTS A DIFFERENT CUSTOMER'S CARD.
//
// Audit 2026-09-27 (app-A4-5). Two paths, one root cause — an async result applied without
// asking whether it is still the thing on screen:
//   1. openEdit set editDock to the dock pressed, awaited that dock's getDoc, and then wrote the
//      snapshot into the draft unconditionally. A rep who tapped Edit on the Northside dock and
//      at once on Wendell Drive could get Northside's document under "Editing this dock:
//      Wendell" if Northside's read answered second — and Save then wrote Northside's hours,
//      address override and location_override onto customer_notes/<Wendell>.
//   2. saveEdit's read-back patched whatever answer was on screen when it returned, so a rep
//      who started a new search while the save was in flight saw the old customer's note
//      painted onto the new customer's card.
//
// These run the REAL openEdit and saveEdit bodies, cut out of App.jsx, against fakes whose
// reads resolve in the order the test chooses. The same trade customer-notes-edit.test.mjs
// makes, one step further: the handler is executed, not pattern-matched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liftFromApp } from './helpers/app-lift.mjs';
import { answerHoldsDock, changedNoteFields } from '../src/lib/customer-note-edit.js';
import { notesSummary } from '../src/lib/stop-lookup.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const { emptyNote } = liftFromApp({ targets: ['emptyNote'], exercise: (l) => l.emptyNote({}) });

/** The arrow function handed to useCallback, as source: `async (dock) => { … }`. */
function handlerSource(name, endMarker) {
  const start = APP.indexOf(`const ${name} = useCallback(`) + `const ${name} = useCallback(`.length;
  const chunk = APP.slice(start, APP.indexOf(endMarker, start));
  return chunk.slice(0, chunk.lastIndexOf('}, [') + 1);
}
const OPEN_SRC = handlerSource('openEdit', 'const cancelEdit = useCallback');
const SAVE_SRC = handlerSource('saveEdit', '/** The rep picked one of several matching businesses. */');

/** Build a handler from its source with `scope` as its closure. */
function build(src, scope) {
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return (${src});`)(...names.map((n) => scope[n]));
}

const NORTHSIDE = { key: 'earthly_alternative__1175_northside_dr_nw_ste_100__atlanta__30318', name: 'EARTHLY ALTERNATIVE', addr1: '1175 NORTHSIDE DR NW STE 100', city: 'ATLANTA', state: 'GA', zip: '30318' };
const WENDELL = { key: 'earthly_alternative__4200_wendell_dr_sw__atlanta__30336', name: 'EARTHLY ALTERNATIVE', addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336' };
const STORED = {
  [NORTHSIDE.key]: { match_key: NORTHSIDE.key, dock_notes: 'Northside: front door', location_override: { lat: 33.79, lng: -84.41 }, receiving_hours: { mon: { open: '07:00', close: '11:00' } } },
  [WENDELL.key]: { match_key: WENDELL.key, dock_notes: 'Wendell: BACK dock', receiving_hours: { mon: { open: '08:00', close: '15:00' } } },
};

/** A controllable Firestore: every getDoc waits until the test releases that path. */
function slowFirestore() {
  const waiting = new Map();
  return {
    doc: (_db, coll, key) => `${coll}/${key}`,
    getDoc: (path) => new Promise((resolve) => {
      const key = path.split('/')[1];
      const data = STORED[key];
      waiting.set(key, () => resolve({ exists: () => !!data, data: () => (data ? { ...data } : undefined) }));
    }),
    release: async (key) => { waiting.get(key)(); await new Promise((r) => setImmediate(r)); },
  };
}

function editorState() {
  const st = { dock: null, draft: null, was: null, seed: null, loading: false, err: null };
  const set = (k) => (v) => { st[k] = typeof v === 'function' ? v(st[k]) : v; };
  return {
    st,
    setEditDock: set('dock'), setEditDraft: set('draft'), setEditWas: set('was'), setEditSeed: set('seed'),
    setEditLoading: set('loading'), setEditErr: set('err'), setEditSaving: () => {},
  };
}

test('tapping Edit on one dock and then another never leaves the first dock’s note under the second dock’s name', async () => {
  const fs = slowFirestore();
  const e = editorState();
  const openEdit = build(OPEN_SRC, {
    ...e, notesGate: { reason: null }, emptyNote, db: {}, doc: fs.doc, getDoc: fs.getDoc,
    reportDenied: () => {}, editReqRef: { current: 0 },
  });
  const a = openEdit(NORTHSIDE);   // the wrong dock, tapped first
  const b = openEdit(WENDELL);     // the right one, tapped at once
  await fs.release(WENDELL.key);   // Wendell's read answers first…
  await fs.release(NORTHSIDE.key); // …and Northside's answers LAST
  await Promise.all([a, b]);
  assert.equal(e.st.dock.key, WENDELL.key);
  assert.equal(e.st.draft.dock_notes, 'Wendell: BACK dock', 'the form under "Editing this dock: Wendell" holds Wendell’s note');
  assert.equal(e.st.draft.location_override, undefined, 'Northside’s pin override is not in Wendell’s form');
  assert.equal(e.st.was.match_key, WENDELL.key);
  assert.equal(e.st.seed.match_key, WENDELL.key);
  assert.equal(e.st.loading, false);
});

test('a late read failure for the first dock does not blank the second dock’s open form', async () => {
  const e = editorState();
  let failFirst;
  const getDoc = (path) => (path.endsWith(NORTHSIDE.key)
    ? new Promise((_, reject) => { failFirst = () => reject(new Error('client is offline')); })
    : Promise.resolve({ exists: () => true, data: () => ({ ...STORED[WENDELL.key] }) }));
  const openEdit = build(OPEN_SRC, {
    ...e, notesGate: { reason: null }, emptyNote, db: {}, doc: (_d, c, k) => `${c}/${k}`, getDoc,
    reportDenied: () => {}, editReqRef: { current: 0 },
  });
  const a = openEdit(NORTHSIDE);
  await openEdit(WENDELL);
  failFirst();
  await a;
  assert.equal(e.st.draft?.dock_notes, 'Wendell: BACK dock');
  assert.equal(e.st.err, null, 'no "Could not read" for a dock nobody is editing any more');
});

// ── the save's read-back ─────────────────────────────────────────────────────────────────────

function saveScope({ dock, onScreen }) {
  const e = editorState();
  const seed = { ...emptyNote({ businessName: dock.name, matchKey: dock.key, addr1: dock.addr1, city: dock.city, state: dock.state, zip: dock.zip }), ...STORED[dock.key] };
  const draft = { ...seed, dock_notes: 'Wendell: BACK dock — ring twice' };
  const written = [];
  let screen = onScreen;
  const scope = {
    ...e, editDock: dock, editDraft: draft, editWas: STORED[dock.key], editSeed: seed,
    notesGate: { reason: null }, db: {}, doc: (_d, c, k) => `${c}/${k}`,
    setDoc: async (path, payload) => { written.push({ path, payload }); },
    getDoc: async () => ({ exists: () => true, data: () => ({ ...STORED[dock.key], dock_notes: draft.dock_notes }) }),
    serverTimestamp: () => 'TS', eligibilityChanged: () => false, buildingTypeChanged: () => false,
    NOTES_UPDATED_BY: 'dispatcher', notesSummary, changedNoteFields, answerHoldsDock, reportDenied: () => {},
    NOTE_SAVE_CHANGED_ONLY_ON: true,
    setData: (fn) => { screen = fn(screen); },
  };
  return { save: build(SAVE_SRC, scope), screen: () => screen, written };
}

test('a save that returns after the rep searched a different customer does not paint the old note onto the new card', async () => {
  const other = { mode: 'customer', noteKey: 'acme__1_main_st__atlanta__30303', docks: [{ key: 'acme__1_main_st__atlanta__30303' }], view: { notes: { text: 'ACME: side door' } } };
  const { save, screen, written } = saveScope({ dock: WENDELL, onScreen: other });
  await save();
  assert.equal(written.length, 1, 'the save itself still happened');
  assert.equal(screen(), other, 'ACME’s card is untouched');
  assert.equal(screen().view.notes.text, 'ACME: side door');
});

test('a save for the customer still on screen repaints that customer’s card, as before', async () => {
  const same = { mode: 'customer', noteKey: NORTHSIDE.key, docks: [NORTHSIDE, WENDELL], view: { notes: { text: 'old' } } };
  const { save, screen } = saveScope({ dock: WENDELL, onScreen: same });
  await save();
  assert.equal(screen().noteKey, WENDELL.key);
  assert.match(screen().view.notes.text, /ring twice/);
});

test('an order’s own page repaints only when the order’s customer is the dock that was saved', async () => {
  const order = { mode: 'stop', matchKey: WENDELL.key, dossier: { identity: { matchKey: WENDELL.key }, notes: { text: 'old' } } };
  const { save, screen } = saveScope({ dock: WENDELL, onScreen: order });
  await save();
  assert.match(screen().dossier.notes.text, /ring twice/);

  const otherOrder = { mode: 'stop', matchKey: NORTHSIDE.key, dossier: { identity: { matchKey: NORTHSIDE.key }, notes: { text: 'Northside' } } };
  const r2 = saveScope({ dock: WENDELL, onScreen: otherOrder });
  await r2.save();
  assert.equal(r2.screen(), otherOrder);
});

test('answerHoldsDock: the rule behind the repaint, on the empty and the malformed', () => {
  assert.equal(answerHoldsDock(null, 'k'), false);
  assert.equal(answerHoldsDock({ view: {}, docks: [{ key: 'k' }] }, ''), false);
  assert.equal(answerHoldsDock({ view: {}, docks: 'nope' }, 'k'), false);
  assert.equal(answerHoldsDock({ view: {}, docks: [null, { key: 'k' }] }, 'k'), true);
  assert.equal(answerHoldsDock({ dossier: { identity: { matchKey: 'k' } } }, 'k'), true);
  assert.equal(answerHoldsDock({ dossier: {} }, 'k'), false);
});
