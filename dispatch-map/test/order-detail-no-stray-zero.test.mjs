// test/order-detail-no-stray-zero.test.mjs — AN ORDINARY ORDER'S PANEL SHOWS NO STRAY "0".
//
// Audit 2026-09-27 (app-A4-7). Two guards in the order panel read
//   {(d.instructions || d.comments.length) && …}   {(d.contact || note?.contacts?.length) && …}
// For an ordinary delivered order — no instructions, no driver comments, no contact on the
// order, and a customer note with no contacts — each evaluates to the NUMBER 0, and React
// prints a number. The rep saw "00" sitting among the detail sections.
//
// Rendered for real: OrderDetailBody lifted out of App.jsx, fed by the same buildOrderDetail
// and notesSummary the endpoint uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';
import { buildOrderDetail, notesSummary } from '../src/lib/stop-lookup.js';

const APP_SRC = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const lucideNames = /import\s*\{([^}]*)\}\s*from 'lucide-react'/.exec(APP_SRC)[1]
  .split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => x.split(/\s+as\s+/)).map(([from, to]) => [to || from, lucide[from]]);
const libs = await libExports(['date-util.js', 'stop-lookup.js']);

const plainOrder = buildOrderDetail(
  { stopNbr: '0170416694', pro: '0170416694', businessName: 'ACME SUPPLY', normalizedStatus: 'DELIVERED', deliveredDTTM: '2026-09-20T10:15' },
  { date: '2026-09-20', today: '2026-09-27', source: 'sealed' },
);
const noteWithNoContacts = notesSummary({ notes: 'Dock in back', contacts: [] });

const { OrderDetailBody } = liftFromApp({
  targets: ['OrderDetailBody'],
  inject: {
    ...Object.fromEntries(lucideNames), ...libs, React,
    useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo,
    useRef: React.useRef, useCallback: React.useCallback,
  },
  exercise: (l) => {
    renderToStaticMarkup(React.createElement(l.OrderDetailBody, { data: { stop: plainOrder, note: noteWithNoContacts }, onOpenHistory: () => {}, wide: true }));
  },
});

/** Every text node that is nothing but digits — the shape a leaked `0 && …` takes. */
const bareNumbers = (html) => [...html.matchAll(/>\s*(\d+)\s*</g)].map((m) => m[1]);

test('an ordinary delivered order with no instructions, comments or contact shows no stray "0" — wide (desktop) and stacked (phone)', () => {
  assert.equal(plainOrder.instructions, null);
  assert.equal(plainOrder.comments.length, 0);
  assert.equal(plainOrder.contact, null);
  assert.deepEqual(noteWithNoContacts.contacts, []);
  for (const wide of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(OrderDetailBody, { data: { stop: plainOrder, note: noteWithNoContacts }, onOpenHistory: () => {}, wide }));
    assert.deepEqual(bareNumbers(html), [], `no bare number may render (wide=${wide})`);
    assert.doesNotMatch(html, /Instructions and notes on the order/, 'the empty section stays hidden');
    assert.doesNotMatch(html, /Who to call/, 'the empty section stays hidden');
  }
});

test('the sections still appear when there IS something in them', () => {
  const withBoth = buildOrderDetail(
    { stopNbr: '1', businessName: 'ACME', normalizedStatus: 'DELIVERED', orderInstructions: 'Call 30 min ahead', contact: { name: 'Dana', phone: '4045550100' } },
    { date: '2026-09-20', today: '2026-09-27' },
  );
  const html = renderToStaticMarkup(React.createElement(OrderDetailBody, { data: { stop: withBoth, note: noteWithNoContacts }, onOpenHistory: () => {}, wide: true }));
  assert.match(html, /Instructions and notes on the order/);
  assert.match(html, /Call 30 min ahead/);
  assert.match(html, /Who to call/);
  assert.match(html, /4045550100/);
});
