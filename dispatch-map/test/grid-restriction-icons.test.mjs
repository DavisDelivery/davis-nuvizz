// test/grid-restriction-icons.test.mjs — the bottom grid's Restrictions cell wears its icons
// (v1.100.1). Chad: "under restrictions can we put icons as well in there if they have any special
// icons". The REAL RestrictionsCell, lifted out of App.jsx (helpers/app-lift.mjs) and rendered with
// react-dom/server: each restriction beside the icon its map pin and Legend use, a handling flag
// beside its own mark when it has one, and the words — the sort key — read off the same list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';
import { gridRestrictionIconsEnabled } from '../src/lib/grid-icons.js';

const libs = await libExports([
  'handling-flags.js', 'time-marks.js', 'map-legend.js', 'carrier-mark.js', 'address-fix.js',
  'time-restrictions.js', 'place-mark.js', 'place-glyphs.js', 'matchKey.js',
]);
const inject = {
  ...libs, React,
  useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo,
  useRef: React.useRef, useCallback: React.useCallback, useLayoutEffect: React.useLayoutEffect,
};

const notesOf = (rows) => new Map(Object.entries(rows));
const STOP = (over = {}) => ({ stopNbr: '1', matchKey: 'acme|buford', ...over });

const L = liftFromApp({
  targets: ['RestrictionsCell', 'restrCellText'],
  inject,
  exercise: (l) => {
    const notes = notesOf({ 'acme|buford': { equipment_restrictions: ['no_tractor_trailer'], liftgate_required: true } });
    renderToStaticMarkup(React.createElement(l.RestrictionsCell, { s: STOP({ orderInstructions: 'HYDRAULIC STACKER - DO NOT DOUBLE STACK' }), notes }));
    l.restrCellText(STOP(), notes);
  },
});
const draw = (s, notes) => renderToStaticMarkup(React.createElement(L.RestrictionsCell, { s, notes }));

test('a customer restriction shows the icon its map pin uses, beside the words', () => {
  const notes = notesOf({ 'acme|buford': { equipment_restrictions: ['no_tractor_trailer'], liftgate_required: true } });
  const html = draw(STOP(), notes);
  // RestrictionIcon: one <svg role="img"> per restriction, labelled with the restriction's name.
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="No tractor trailer"/);
  assert.match(html, /<svg[^>]*role="img"[^>]*aria-label="Liftgate required"/);
  // The words stay: the codes a dispatcher already reads, in the same order as before.
  assert.match(html, /No T\/T,<\/span>/);
  assert.match(html, />Liftgate<\/span>/);
  assert.ok(html.indexOf('No tractor trailer') < html.indexOf('Liftgate required'), 'customer restrictions keep their order');
});

test('an order handling flag shows its own mark where it has one, and stays a word where it has none', () => {
  const notes = notesOf({});
  const stacker = draw(STOP({ orderInstructions: 'REDELIVER STRADDLE STACKER ON TRACTOR TRAILER' }), notes);
  assert.match(stacker, /<svg[^>]*aria-label="Hydraulic stacker"/, 'the stacker’s yellow H');
  assert.match(stacker, />STACKER<\/span>/);
  const dnds = draw(STOP({ orderInstructions: 'DO NOT DOUBLE STACK' }), notes);
  assert.doesNotMatch(dnds, /<svg/, 'DNDS has no icon anywhere in the app, so none is invented');
  assert.match(dnds, />DNDS<\/span>/);
});

test('the customer’s restrictions come first, then the order’s flags — the order the words always had', () => {
  const notes = notesOf({ 'acme|buford': { equipment_restrictions: ['no_tractor_trailer'] } });
  const s = STOP({ orderInstructions: 'DO NOT DOUBLE STACK' });
  const html = draw(s, notes);
  assert.ok(html.indexOf('No T/T') < html.indexOf('DNDS'));
  assert.equal(L.restrCellText(s, notes), 'No T/T, DNDS', 'the sort key reads the same list');
});

test('a stop with nothing special draws nothing — no empty icon, no stray comma', () => {
  assert.equal(draw(STOP(), notesOf({})), '');
  assert.equal(L.restrCellText(STOP(), notesOf({})), '');
});

test('every icon the cell draws is a word the cell says, and the other way round', () => {
  const notes = notesOf({ 'acme|buford': { equipment_restrictions: ['no_tractor_trailer', 'box_truck_only'], liftgate_required: true, appointment_required: true } });
  const s = STOP({ orderInstructions: 'STACKER / DO NOT DOUBLE STACK' });
  const html = draw(s, notes);
  const parts = [...html.matchAll(/data-restr-part="([^"]+)"/g)].map((m) => m[1]);
  const words = L.restrCellText(s, notes).split(', ');
  assert.equal(parts.length, words.length, `${parts.join('|')} vs ${words.join('|')}`);
});

test('VITE_GRID_RESTRICTION_ICONS: default on, an off-word turns it off, a typo leaves it on', () => {
  assert.equal(gridRestrictionIconsEnabled({}), true);
  assert.equal(gridRestrictionIconsEnabled(undefined), true);
  for (const v of ['off', 'OFF', '0', 'false', ' no ']) assert.equal(gridRestrictionIconsEnabled({ VITE_GRID_RESTRICTION_ICONS: v }), false, v);
  for (const v of ['offf', 'on', '1', '', 'nope']) assert.equal(gridRestrictionIconsEnabled({ VITE_GRID_RESTRICTION_ICONS: v }), true, v);
});

// ── the grid uses it, and the sort key did not move ──────────────────────────
const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
test('the Restrictions column draws the cell when the switch is on, the words when it is off, and sorts on the words', () => {
  assert.match(APP, /import \{ GRID_RESTRICTION_ICONS_ON \} from '\.\/lib\/grid-icons\.js';/);
  assert.match(APP, /\{ k: 'restr', label: 'Restrictions', w: 160,\s*get: \(s\) => \(GRID_RESTRICTION_ICONS_ON \? <RestrictionsCell s=\{s\} notes=\{notes\} \/> : restrCellText\(s, notes\)\),\s*sortVal: \(s\) => restrCellText\(s, notes\) \}/);
});
