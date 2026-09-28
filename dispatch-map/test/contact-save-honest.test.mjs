// test/contact-save-honest.test.mjs — A1-S3-4: THE CUSTOMER # BLOCK NEVER SAYS "SAVED" FOR A
// NUMBER FIRESTORE DID NOT TAKE.
//
// The Customer # block on a stop card saves a contact in two places: the customer_notes doc
// (what Text, Call and the Messages list read, and what the customer's NEXT order finds) and,
// optionally, the order in NuVizz. Its submit ran `await onSaveContacts(...)` and carried on as
// if that had worked — but the note save underneath never said whether it had. A role refusal
// (`setSaveError(notesGate.reason); return;`) and a Firestore throw both resolved normally,
// so the block closed its editor (the only place saveError is printed) and then printed
// "Saved, and written onto the order in NuVizz." — or "Saved here, but NuVizz did not take
// it" — about a number that was on file nowhere. The dispatcher walks away believing Text and
// the next order will find it.
//
// Now: the block closes its editor only when the customer half LANDED, so a refusal stays on
// screen in red; and the NuVizz line states the customer half truthfully either way. The
// NuVizz write itself is untouched — same call, same conditions as before.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contactSaveLine } from '../src/lib/note-save.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
const fnBody = (name) => {
  const at = CODE.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} exists`);
  const next = CODE.indexOf('\nfunction ', at + 10);
  return CODE.slice(at, next > 0 ? next : undefined);
};

// setStopContact's answers, in the shapes the block already reads (`r?.result || r`).
const WROTE = { ok: true, result: { unchanged: false } };
const ALREADY = { ok: true, result: { unchanged: true } };
const REFUSED = { ok: false, error: 'forbidden: dispatcher role required' };

// ── the rule ─────────────────────────────────────────────────────────────────

test('Firestore refuses the customer number but NuVizz takes it — the card does not say "Saved"', () => {
  const line = contactSaveLine(false, WROTE);
  assert.doesNotMatch(line.text, /^Saved/);
  assert.match(line.text, /^Not saved here/);
  assert.match(line.text, /written onto the order in NuVizz/, 'the half that DID land is still reported');
  assert.equal(line.kind, 'warn');
});

test('Firestore refuses and NuVizz refuses too — both refusals are said, neither is dressed as a save', () => {
  const line = contactSaveLine(false, REFUSED);
  assert.doesNotMatch(line.text, /^Saved/);
  assert.match(line.text, /^Not saved here/);
  assert.match(line.text, /forbidden: dispatcher role required/);
  assert.equal(line.kind, 'warn');
});

test('Firestore refuses and the order already carried the number — not "Saved" either', () => {
  const line = contactSaveLine(false, ALREADY);
  assert.match(line.text, /^Not saved here/);
  assert.equal(line.kind, 'warn');
});

test('no "Saved" sentence is ever produced for a customer half that did not land, whatever NuVizz answered', () => {
  for (const r of [WROTE, ALREADY, REFUSED, null, undefined, {}, { ok: false }, { ok: true }]) {
    assert.doesNotMatch(contactSaveLine(false, r).text, /^Saved/, JSON.stringify(r));
  }
});

test('the customer half landed — the three sentences the block has always said are unchanged', () => {
  assert.deepEqual(contactSaveLine(true, WROTE), { kind: 'ok', text: 'Saved, and written onto the order in NuVizz.' });
  assert.deepEqual(contactSaveLine(true, ALREADY), { kind: 'ok', text: 'Saved — the order already carried this contact in NuVizz.' });
  assert.deepEqual(contactSaveLine(true, REFUSED), { kind: 'warn', text: 'Saved here, but NuVizz did not take it: forbidden: dispatcher role required' });
  assert.deepEqual(contactSaveLine(true, null), { kind: 'warn', text: 'Saved here, but NuVizz did not take it: the write failed.' });
});

// ── the wiring ───────────────────────────────────────────────────────────────

for (const [view, name] of [['desktop stop panel', 'StopSidebar'], ['phone stop drawer', 'MobileStopDetailDrawer']]) {
  test(`${view}: the Customer # save hands back whether the customer note was written`, () => {
    const body = fnBody(name);
    const at = body.indexOf('const saveContacts = onSave ? async (patch) => {');
    assert.ok(at > 0);
    const fn = body.slice(at, body.indexOf('} : null;', at));
    assert.match(fn, /return onSave\(next\);/, 'a saveContacts that awaits and returns nothing makes every save look refused');
  });
}

test('the Customer # block keeps its editor (and the red reason) open when the customer half did not land', () => {
  const body = fnBody('StopContactBlock');
  const at = body.indexOf('const submit = async () => {');
  const submit = body.slice(at, body.indexOf('\n  };\n', at));
  assert.match(submit, /const savedHere = await commitNoteDraft\(onSaveContacts, \{ name, phone \}\);/);
  assert.match(submit, /if \(savedHere\) setEditing\(false\);/, 'the editor closes only on a landed save');
  assert.doesNotMatch(submit, /await onSaveContacts\(\{ name, phone \}\);\s*setEditing\(false\);/, 'the unconditional close is gone');
  // Every sentence about the result comes from the one rule above.
  assert.match(submit, /setPush\(contactSaveLine\(savedHere, r\)\)/);
  assert.doesNotMatch(submit, /'Saved, and written onto the order in NuVizz\.'/, 'no hard-coded "Saved" left in the handler');
  // The NuVizz half is untouched: same call, same stopId pin.
  assert.match(submit, /await setStopContact\(pro, \{ name: name\.trim\(\), phone: phone\.trim\(\) \}, \{ stopId: stop\?\.stopId \|\| undefined \}\)/);
  // The reason is printed inside the editor, which is still open.
  assert.match(body, /\{saveError && <div className="text-\[11px\] text-red-600 break-words">\{saveError\}<\/div>\}/);
});
