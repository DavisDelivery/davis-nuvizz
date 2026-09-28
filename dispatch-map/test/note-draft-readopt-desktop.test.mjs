// test/note-draft-readopt-desktop.test.mjs — A1-S3-3: THE DESKTOP STOP PANEL PICKS UP A NOTE
// THAT CHANGED UNDER IT.
//
// The desktop stop panel (StopSidebar — the Map's right panel and the Routing screen's stop
// panel) copies the customer's note into a draft when it opens, and its Save writes that WHOLE
// draft back with `{ ...draft }`. It re-read the note only when `note?.id` changed. But the id
// of a customer_notes doc IS its match key: a second dispatcher saving this customer's
// receiving hours, the auto-scanner learning a restriction, a pin correction — every one of
// those is the same doc, the same id, and the panel never saw it. The next Save on this panel
// wrote the hours it opened with straight back over the ones somebody had just typed.
//
// The dirty guard stays: a dispatcher mid-edit still keeps their typing. What changes is that
// a panel with NO unsaved edits follows the stored note whenever its content moves, not only
// when a different customer's note appears.

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

// Firestore hands back a Timestamp object for last_updated; a key that choked on it, or read
// every Timestamp as the same "{}", would miss exactly the update that matters.
const ts = (seconds) => ({ seconds, nanoseconds: 0 });
const MK = 'acme_foods__100_main_st__buford__30518';
const opened = {
  id: MK, match_key: MK,
  receiving_hours: { mon: { open: '08:00', close: '14:00' } },
  last_updated: ts(1000),
};
const otherDeviceSaved = {
  ...opened,
  receiving_hours: { mon: { open: '07:00', close: '12:00' } },
  last_updated: ts(2000),
};

test('another dispatcher changes this customer\'s receiving hours while the desktop panel is open — the panel sees a different note', () => {
  assert.equal(otherDeviceSaved.id, opened.id, 'same customer_notes doc, same id — the old dependency could not tell them apart');
  assert.notEqual(noteContentKey(otherDeviceSaved), noteContentKey(opened));
});

test('a note whose content did not move reads as unchanged, whatever order Firestore listed its fields in', () => {
  const reordered = { last_updated: ts(1000), receiving_hours: { mon: { close: '14:00', open: '08:00' } }, match_key: MK, id: MK };
  assert.equal(noteContentKey(reordered), noteContentKey(opened));
  assert.equal(noteContentKey({ ...opened }), noteContentKey(opened), 'a fresh snapshot object with the same content is not an update');
});

test('only the server stamp moved (a save confirming) — still a change, and still harmless to adopt', () => {
  assert.notEqual(noteContentKey({ ...opened, last_updated: ts(1001) }), noteContentKey(opened));
});

test('no note yet — a stable key, so a customer with no doc does not re-adopt on every render', () => {
  assert.equal(noteContentKey(null), noteContentKey(undefined));
  assert.equal(noteContentKey(null), noteContentKey(null));
});

test('the desktop stop panel re-adopts the note when its CONTENT changes, and still never over unsaved edits', () => {
  const body = fnBody('StopSidebar');
  // Every effect in the panel, with its dependency array.
  const effects = [...body.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[([^\]]*)\]\);/g)]
    .map((m) => ({ body: m[1], deps: m[2] }));
  const adopt = effects.filter((e) => /if \(dirtyRef\.current\) return;/.test(e.body) && /setDraft\(note \|\| emptyNote\(stop\)\)/.test(e.body));
  assert.ok(adopt.length >= 1, 'the dirty-guarded adoption effect is still there');
  const keyVar = (body.match(/const (\w+) = noteContentKey\(note\);/) || [])[1];
  assert.ok(keyVar, 'the panel derives a content key from the stored note');
  assert.ok(adopt.some((e) => new RegExp(`\\b${keyVar}\\b`).test(e.deps)),
    'an adoption effect depends on the note CONTENT — note?.id alone never changes for a same-doc update');
  // The content effect must not close an editor the dispatcher opened: only a different note
  // (the id effect) decides editing.
  const byContent = adopt.find((e) => new RegExp(`\\b${keyVar}\\b`).test(e.deps));
  assert.doesNotMatch(byContent.body, /setEditing/, 'a background update to the same note does not slam the editor shut');
});
