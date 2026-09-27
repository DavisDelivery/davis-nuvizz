// test/note-save-failure-visible.test.mjs — A1-S4-1: A NOTE SAVE THAT DID NOT LAND KEEPS THE
// EDITOR OPEN, WITH THE REASON ON SCREEN.
//
// The customer-notes Save bar on both stop panels ran `onSave(D); setEditing(false);` — it did
// not wait for the write and left edit mode on the same click. The only place the panel prints
// saveError is INSIDE that save bar, which the same click had just unmounted. So a refused
// write (a role that may not write customer_notes, a Firestore rules refusal, a write error) looked
// exactly like a saved one: the dispatcher typed the receiving hours a customer gave them on
// the phone, pressed Save, watched the editor close, and the flag engine kept working off
// nothing. Both saves (the Map's handleSave and the Routing screen's saveStopNote) also
// resolved the same way whether they wrote or not, so there was no signal to wait for.
//
// Now: each save resolves `true` only once the write landed, and the Save bar closes the
// editor only on that `true`. Anything else leaves it open, the typed values still in it, and
// the reason printed in the bar. Phone and desktop are separate components — both are pinned.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commitNoteDraft } from '../src/lib/note-save.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
const fnBody = (name) => {
  const at = CODE.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} exists`);
  const next = CODE.indexOf('\nfunction ', at + 10);
  return CODE.slice(at, next > 0 ? next : undefined);
};
const draft = { receiving_hours: { mon: { open: '07:00', close: '14:00' } } };

// ── the rule ─────────────────────────────────────────────────────────────────

test('a dispatcher without write access presses Save — the save is reported as NOT landed', async () => {
  // handleSave's role refusal is `setSaveError(notesGate.reason); return;` — it resolves undefined.
  assert.equal(await commitNoteDraft(async () => undefined, draft), false);
});

test('Firestore refuses the write — the save is reported as NOT landed, and nothing throws into the click', async () => {
  assert.equal(await commitNoteDraft(async () => { throw new Error('Missing or insufficient permissions.'); }, draft), false);
  assert.equal(await commitNoteDraft(async () => false, draft), false);
});

test('a save handler that answers with something other than true is not a save', async () => {
  for (const v of [null, 1, 'ok', {}, { ok: true }]) {
    assert.equal(await commitNoteDraft(async () => v, draft), false, JSON.stringify(v));
  }
});

test('the receiving hours reached Firestore — the save is reported as landed, with the draft that was pressed', async () => {
  let wrote = null;
  assert.equal(await commitNoteDraft(async (d) => { wrote = d; return true; }, draft), true);
  assert.equal(wrote, draft);
});

// ── the two saves say whether they wrote ─────────────────────────────────────

test('the Map screen\'s note save resolves true only after its write, and not on the refusal path', () => {
  const at = CODE.indexOf('const handleSave = async (draft) => {');
  assert.ok(at > 0);
  const fn = CODE.slice(at, CODE.indexOf('\n  };\n', at));
  assert.match(fn, /await setDoc\(doc\(db, 'customer_notes', key\), payload, \{ merge: true \}\);(?:\s*\/\/[^\n]*)*\s*return true;/,
    'true comes straight after the awaited write');
  assert.equal((fn.match(/return true;/g) || []).length, 1, 'no other path claims a save');
});

test('the Routing screen\'s note save resolves true only after its write', () => {
  const at = CODE.indexOf('const saveStopNote = useCallback(async (draft) => {');
  assert.ok(at > 0);
  const fn = CODE.slice(at, CODE.indexOf('}, [notes, panelStop', at));
  const write = fn.indexOf("await setDoc(doc(db, 'customer_notes', key)");
  const yes = fn.indexOf('return true;');
  assert.ok(write > 0 && yes > write && yes < fn.indexOf('} catch (e)'), 'true is returned after the awaited write, inside the try');
  assert.equal((fn.match(/return true;/g) || []).length, 1);
});

test('the Map phone drawer passes the save result back to its Save bar', () => {
  const at = CODE.indexOf('<MobileStopDetailDrawer');
  const mount = CODE.slice(at, CODE.indexOf('/>', CODE.indexOf('saveDenied=', at)));
  assert.match(mount, /onSave=\{handleSave\}|return handleSave\(draft\)/,
    'a wrapper that awaits handleSave and returns nothing makes every save look refused');
});

// ── the two Save bars wait for it ────────────────────────────────────────────

for (const [view, name] of [['desktop stop panel', 'StopSidebar'], ['phone stop drawer', 'MobileStopDetailDrawer']]) {
  test(`${view}: a refused note save leaves the editor open with the reason, instead of closing as if saved`, () => {
    const body = fnBody(name);
    assert.doesNotMatch(body, /onSave\(D\); setEditing\(false\)/, 'the Save bar no longer leaves edit mode on the click');
    const line = body.split('\n').find((l) => /commitNoteDraft\(onSave, D\)/.test(l));
    assert.ok(line, 'the Save bar goes through commitNoteDraft');
    const waited = line.indexOf('await commitNoteDraft(onSave, D)');
    assert.ok(waited > 0, 'and waits for it');
    const close = line.indexOf('setEditing(false)');
    assert.ok(close > waited, 'the editor closes only after the save answered');
    assert.match(line, /if \(await commitNoteDraft\(onSave, D\)[^)]*\) \{[^}]*setEditing\(false\)/, 'and only when it landed');
    // Clearing the dirty flag before the write let a refused write's rollback snapshot wipe the
    // typed hours out of the still-open editor. It is cleared once the write has landed.
    assert.ok(line.indexOf('dirtyRef.current = false') > waited, 'unsaved edits stay protected while the save is in flight');
    // The reason is rendered inside the editing bar — which is still mounted now.
    assert.match(body, /\{editing && \([\s\S]{0,400}\{saveError && </, 'the save bar prints saveError');
  });
}
