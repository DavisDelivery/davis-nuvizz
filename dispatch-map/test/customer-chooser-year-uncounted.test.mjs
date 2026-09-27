// test/customer-chooser-year-uncounted.test.mjs — IN YEAR MODE THE CHOOSER DOES NOT CLAIM "NOTHING".
//
// Audit 2026-09-27 (app-A4-9). A rep on the chooser for "earthly" presses "All of 2026". The
// year branch answers the chooser from the rollup and never counts stops for it — but it wrote a
// placeholder `stops: 0` onto every match, and the chooser printed "nothing in this window"
// under "The counts are for the window below." Both businesses read as never delivered to, and
// that is a sentence a rep repeats to a caller.
//
// Now the year's matches say they are NOT counted (stops: null), and the chooser prints no
// count — and no "counts are for the window" line — for a match nobody counted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';
import { installFirestoreFake } from './_firestore-fake.mjs';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';

const URL_BASE = 'https://x.netlify.app/.netlify/functions/stop-lookup';
const call = async (qs) => {
  const handler = (await import('../netlify/functions/stop-lookup.mts')).default;
  return (await handler(new Request(`${URL_BASE}?${qs}`))).json();
};

const APP_SRC = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const lucideNames = /import\s*\{([^}]*)\}\s*from 'lucide-react'/.exec(APP_SRC)[1]
  .split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => x.split(/\s+as\s+/)).map(([from, to]) => [to || from, lucide[from]]);
const libs = await libExports(['date-util.js']);
const { CustomerChooser } = liftFromApp({
  targets: ['CustomerChooser'],
  inject: { ...Object.fromEntries(lucideNames), ...libs, React },
  exercise: (l) => {
    renderToStaticMarkup(React.createElement(l.CustomerChooser, { matches: [{ name: 'A', nameKey: 'a', stops: 1, today: 0, lastDate: '2026-09-12' }], query: 'a', onPick: () => {} }));
  },
});
const chooser = (matches) => renderToStaticMarkup(React.createElement(CustomerChooser, { matches, query: 'earthly', onPick: () => {} }));

const seedTwoBusinesses = {
  'history_customers/k1': { name: 'EARTHLY ALTERNATIVE', name_lower: 'earthly alternative', name_tokens: ['earthly', 'alternative'], matchKey: 'k1', last_date: '2026-09-12', pros: [] },
  'history_customers/k2': { name: 'EARTHLY GOODS', name_lower: 'earthly goods', name_tokens: ['earthly', 'goods'], matchKey: 'k2', last_date: '2026-09-20', pros: [] },
};

test('pressing "All of 2026" on a two-business chooser does not report either business as "nothing in this window"', async () => {
  const fake = installFirestoreFake(seedTwoBusinesses);
  let body;
  try { body = await call('name=earthly&year=2026'); } finally { fake.restore(); }
  assert.equal(body.mode, 'customer-choose');
  assert.equal(body.matches.length, 2);
  for (const m of body.matches) {
    assert.equal(m.stops, null, `${m.name}: the year never counted it, so it must not say 0`);
    assert.equal(m.today, null);
  }
  const html = chooser(body.matches);
  assert.doesNotMatch(html, /nothing in this window/, 'an uncounted business is never described as empty');
  assert.doesNotMatch(html, /The counts are for the window below/, 'and no count is claimed');
  assert.match(html, /EARTHLY ALTERNATIVE/);
  assert.match(html, /EARTHLY GOODS/);
  assert.match(html, /last /, 'the last delivery still shows');
});

test('the WINDOW chooser still prints its counts, and a counted zero still reads "nothing in this window"', () => {
  const html = chooser([
    { name: 'EARTHLY ALTERNATIVE', nameKey: 'a', stops: 3, today: 1, lastDate: '2026-09-26' },
    { name: 'EARTHLY GOODS', nameKey: 'g', stops: 0, today: 0, lastDate: '2026-08-02' },
  ]);
  assert.match(html, /The counts are for the window below/);
  assert.match(html, /3 stops in this window · last /);
  assert.match(html, /nothing in this window · last /);
});
