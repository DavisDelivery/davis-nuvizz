// test/stop-lookup-card-promise-rules.test.mjs — THE STOP LOOKUP CARD SHOWS WHAT A REP MAY NOT
// PROMISE: closed days, an appointment rule, a do-not-send, the dock instruction.
//
// Audit 2026-09-27 (app-A4-1): StopNotesCard and the order panel's "Before you promise
// anything" block draw only what notesSummary returns, and notesSummary never read
// `closed_days`, `appointment_required`, `appointment_notes`, `do_not_send` or `dns_drivers`.
// A customer closed Fridays, appointment-only and DNS read "Nothing on file for this customer
// yet" — and still read that right after a rep saved a dock instruction from this screen,
// because the save repaints the card through the same notesSummary.
//
// These run the REAL components out of App.jsx (helpers/app-lift.mjs) through
// react-dom/server, fed by the REAL notesSummary over a document shaped by the REAL emptyNote.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';
import { liftFromApp, libExports } from './helpers/app-lift.mjs';
import { notesSummary } from '../src/lib/stop-lookup.js';

const libs = await libExports(['ai-search.js', 'date-util.js', 'stop-lookup.js']);
const APP_SRC = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const lucideNames = /import\s*\{([^}]*)\}\s*from 'lucide-react'/.exec(APP_SRC)[1]
  .split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => x.split(/\s+as\s+/)).map(([from, to]) => [to || from, lucide[from]]);
const inject = {
  ...Object.fromEntries(lucideNames), ...libs, React,
  useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo,
  useRef: React.useRef, useCallback: React.useCallback, db: null,
};

const DOCKS = [{ key: 'k1', addr1: '4200 WENDELL DR SW', city: 'ATLANTA' }, { key: 'k2', addr1: '1175 NORTHSIDE DR NW', city: 'ATLANTA' }];
const orderStop = () => ({
  outcome: 'delivered', timeline: [], date: '2026-09-18', name: 'EARTHLY ALTERNATIVE', address: { addr1: '4200 WENDELL DR SW', city: 'ATLANTA' },
  pros: ['007100077'], lines: [], refs: [], pod: [], comments: [], instructions: null, contact: null, source: 'sealed',
});

const L = liftFromApp({
  targets: ['StopNotesCard', 'OrderDetailBody', 'emptyNote'],
  inject,
  exercise: (l) => {
    const n = notesSummary({ dock_notes: 'x', receiving_hours: { mon: { open: '08:00', close: '14:00' } }, contacts: [{ name: 'R', phone: '1' }], last_updated: '2026-09-27T14:00:00Z', updated_by: 'd', customer_nbr: '9' });
    renderToStaticMarkup(React.createElement(l.StopNotesCard, { notes: n, locations: [], docks: DOCKS, noteKey: 'k1', onEdit: () => {} }));
    renderToStaticMarkup(React.createElement(l.StopNotesCard, { notes: n, locations: [{ key: 'a', address: { addr1: '1 A', city: 'X' } }], docks: [DOCKS[0]], noteKey: 'k1', onEdit: () => {} }));
    renderToStaticMarkup(React.createElement(l.OrderDetailBody, { data: { stop: orderStop(), note: n }, onOpenHistory: () => {}, wide: false }));
    l.emptyNote({});
  },
});

/** A customer_notes document exactly as the shared editor saves it. */
const saved = (over = {}) => ({
  ...L.emptyNote({ businessName: 'EARTHLY ALTERNATIVE', addr1: '4200 WENDELL DR SW', city: 'ATLANTA', state: 'GA', zip: '30336', matchKey: 'k1' }),
  ...over,
});
const card = (doc) => renderToStaticMarkup(React.createElement(L.StopNotesCard, {
  notes: notesSummary(doc), locations: [], docks: DOCKS, noteKey: 'k1', onEdit: () => {},
}));
const orderPanel = (doc) => renderToStaticMarkup(React.createElement(L.OrderDetailBody, {
  data: { stop: orderStop(), note: notesSummary(doc) }, onOpenHistory: () => {}, wide: false,
}));
const NOTHING = /Nothing on file for this customer yet/;

test('a customer closed on Fridays does not read "Nothing on file" and the card says Closed Fri', () => {
  const html = card(saved({ closed_days: ['fri'] }));
  assert.doesNotMatch(html, NOTHING);
  assert.match(html, /Closed Fri/);
});

test('a closed Friday is not quoted back as Friday receiving hours', () => {
  // toggleClosed in the editor marks the day closed without clearing the day's times, so a
  // closed Friday can still carry 08:00–16:00. The Map prints "Closed" for it; this card must
  // not print "Fri 8:00 AM–4:00 PM" beside it and invite a Friday promise.
  const html = card(saved({
    closed_days: ['fri'],
    receiving_hours: { ...saved().receiving_hours, mon: { open: '08:00', close: '16:00' }, fri: { open: '08:00', close: '16:00' } },
  }));
  assert.match(html, /Mon 8:00 AM/);
  assert.doesNotMatch(html, /Fri 8:00 AM/);
  assert.match(html, /Closed Fri/);
});

test('an appointment-only customer shows the appointment rule and its instruction', () => {
  const html = card(saved({ appointment_required: true, appointment_notes: 'Call Maria 24h ahead' }));
  assert.doesNotMatch(html, NOTHING);
  assert.match(html, /Appointment required/);
  assert.match(html, /Call Maria 24h ahead/);
});

test('a do-not-send customer shows DNS, with the barred drivers named', () => {
  const html = card(saved({ do_not_send: true, dns_drivers: ['FRANK OKINE'] }));
  assert.doesNotMatch(html, NOTHING);
  assert.match(html, /Do not send/);
  assert.match(html, /FRANK OKINE/);
});

test('a dock instruction saved from this screen is on the card that the save repaints', () => {
  // saveEdit repaints the card from notesSummary(fresh.data()); this is that document.
  const html = card(saved({ dock_notes: 'Use the BACK dock', last_updated: '2026-09-27T14:00:00Z', updated_by: 'dispatch' }));
  assert.doesNotMatch(html, NOTHING);
  assert.match(html, /Use the BACK dock/);
});

test('the order panel warns "Before you promise anything" for closed days, appointment and DNS', () => {
  const html = orderPanel(saved({
    closed_days: ['fri'], appointment_required: true, do_not_send: true, vehicle_eligibility: 'box_only', dock_notes: 'Use the BACK dock',
  }));
  assert.match(html, /Before you promise anything/);
  for (const re of [/Closed Fri/, /Appointment required/, /Do not send/, /box truck only/, /Use the BACK dock/]) assert.match(html, re);
});

test('a customer with genuinely nothing written still reads "Nothing on file"', () => {
  assert.match(card(saved()), NOTHING);
});
