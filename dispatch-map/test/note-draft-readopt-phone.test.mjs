// test/note-draft-readopt-phone.test.mjs — A1-S4-5: THE PHONE STOP DRAWER PICKS UP A NOTE THAT
// CHANGED UNDER IT.
//
// Same bug as the desktop panel (note-draft-readopt-desktop.test.mjs), in the phone's own
// component — CLAUDE.md: mobile and desktop are two views, and a defect in both is fixed in
// both. MobileStopDetailDrawer re-read the note only when `note?.id` changed; a customer_notes
// id is the match key, so a same-customer update (another dispatcher, the scanner, a pin
// correction) never reached the draft, and Save wrote the stale draft back over it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noteContentKey } from '../src/lib/note-save.js';

const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const CODE = APP.slice(APP.indexOf('\n];\n', APP.indexOf('const VERSION_LOG = [')));
const fnBody = (name) => {
  const at = CODE.indexOf(`function ${name}(`);
  assert.ok(at > 0, `${name} exists`);
  const next = CODE.indexOf('\nfunction ', at + 10);
  return CODE.slice(at, next > 0 ? next : undefined);
};

test('a dock note saved from the office while the phone drawer is open on that customer reaches the drawer', () => {
  const MK = 'acme_foods__100_main_st__buford__30518';
  const before = { id: MK, dock_notes: '', last_updated: { seconds: 1, nanoseconds: 0 } };
  const after = { id: MK, dock_notes: 'Use rear door — front dock under repair', last_updated: { seconds: 2, nanoseconds: 0 } };
  assert.equal(after.id, before.id);
  assert.notEqual(noteContentKey(after), noteContentKey(before));
});

test('the phone drawer re-adopts the note when its CONTENT changes, and still never over unsaved edits', () => {
  const body = fnBody('MobileStopDetailDrawer');
  const effects = [...body.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]*)\]\);/g)]
    .map((m) => ({ body: m[1], deps: m[2] }));
  const adopt = effects.filter((e) => /if \(dirtyRef\.current\) return;/.test(e.body) && /setDraft\(note \|\| emptyNote\(stop\)\)/.test(e.body));
  assert.equal(adopt.length, 1, 'one dirty-guarded adoption effect');
  const keyVar = (body.match(/const (\w+) = noteContentKey\(note\);/) || [])[1];
  assert.ok(keyVar, 'the drawer derives a content key from the stored note');
  assert.match(adopt[0].deps, new RegExp(`\\b${keyVar}\\b`),
    'the adoption effect depends on the note CONTENT — note?.id alone never changes for a same-doc update');
  assert.doesNotMatch(adopt[0].body, /setEditing/, 'a background update does not close the phone editor');
});
