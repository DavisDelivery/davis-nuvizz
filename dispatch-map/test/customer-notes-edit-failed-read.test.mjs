// test/customer-notes-edit-failed-read.test.mjs — A FAILED READ WHEN EDIT IS PRESSED IS AN
// ERROR ON THE PANEL, NOT A WHITE SCREEN.
//
// Audit 2026-09-27 (app-A4-2): openEdit's catch sets the draft to null and the prepared
// message ("Could not read this customer's note: …") into editErr, but leaves the dock set, so
// CustomerNotesEditPanel still renders — and mounted <StopNotesEditor draft={null}>, whose
// first line dereferences the draft. The app has no error boundary, so under React 18 the whole
// root unmounted: a dispatcher on a weak phone signal pressing Edit lost the board as well, and
// the message the catch had prepared never showed.
//
// The REAL panel and the REAL editor out of App.jsx (helpers/app-lift.mjs), rendered with
// react-dom/server.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';

const libs = await libExports(['place-mark.js', 'place-glyphs.js', 'map-legend.js', 'time-marks.js', 'trailer-block.js', 'matchKey.js']);
const APP_SRC = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const lucideNames = /import\s*\{([^}]*)\}\s*from 'lucide-react'/.exec(APP_SRC)[1]
  .split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => x.split(/\s+as\s+/)).map(([from, to]) => [to || from, lucide[from]]);
const inject = {
  ...Object.fromEntries(lucideNames), ...libs, React,
  useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo,
  useRef: React.useRef, useCallback: React.useCallback, useLayoutEffect: React.useLayoutEffect, db: null,
};

const DOCK = { key: 'earthly_alternative__4200_wendell_dr_sw__atlanta__30336', name: 'EARTHLY ALTERNATIVE', addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336' };
const props = (over = {}) => ({
  dock: DOCK, draft: null, setDraft: () => {}, loading: false, saving: false, err: null,
  onSave: () => {}, onCancel: () => {}, canSave: true, ...over,
});

const L = liftFromApp({
  targets: ['CustomerNotesEditPanel', 'emptyNote'],
  inject,
  exercise: (l) => {
    // The open form, so every call-time reference inside the shared editor is lifted too.
    const draft = { ...l.emptyNote({ businessName: 'X', matchKey: 'k' }), do_not_send: true, contacts: [{ name: 'R', phone: '1' }] };
    renderToStaticMarkup(React.createElement(l.CustomerNotesEditPanel, props({ draft })));
    renderToStaticMarkup(React.createElement(l.CustomerNotesEditPanel, props({ loading: true })));
  },
});

const render = (over) => renderToStaticMarkup(React.createElement(L.CustomerNotesEditPanel, props(over)));

test('an offline read when Edit is pressed shows the reason on the panel instead of crashing the app', () => {
  const msg = "Could not read this customer's note: Failed to get document because the client is offline.";
  let html;
  assert.doesNotThrow(() => { html = render({ draft: null, err: msg }); });
  assert.match(html, /Failed to get document because the client is offline/);
  assert.match(html, />Cancel</, 'the rep can close the panel');
  assert.doesNotMatch(html, />Save</, 'no Save offered over a form that never loaded');
});

test('a denied read with no message still says the note could not be read', () => {
  let html;
  assert.doesNotThrow(() => { html = render({ draft: null, err: null }); });
  assert.match(html, /could not be read/i);
});

test('the loaded form is unchanged: the shared editor and Save are there', () => {
  const html = render({ draft: L.emptyNote({ businessName: 'X', matchKey: 'k' }) });
  assert.match(html, /Receiving hours/);
  assert.match(html, />Save</);
});
