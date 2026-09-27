// test/order-detail-failed-read.test.mjs — A FAILED ORDER READ IS NOT "WE HOLD NO RECORD".
//
// Audit 2026-09-27 (app-A4-6). A rep opens an order row on a customer's day while Firestore
// is answering 503. The endpoint used to swallow the failure into {stop:null, complete:true},
// and the panel, which only ever looked at `!data.stop`, said "We hold no record of … this is
// worth reporting rather than retrying" — a failed read told to a customer as a missing order.
//
// Two halves, both pinned: the endpoint must say the read failed (complete:false + the reason),
// and the panel must print THAT, and keep "We hold no record" for a read that really answered.

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

// ── the panel, lifted out of App.jsx and rendered for real ──────────────────────────────────
const APP_SRC = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const lucideNames = /import\s*\{([^}]*)\}\s*from 'lucide-react'/.exec(APP_SRC)[1]
  .split(',').map((x) => x.trim()).filter(Boolean)
  .map((x) => x.split(/\s+as\s+/)).map(([from, to]) => [to || from, lucide[from]]);
const libs = await libExports(['date-util.js', 'stop-lookup.js']);
const { OrderDetailInner } = liftFromApp({
  targets: ['OrderDetailInner'],
  inject: {
    ...Object.fromEntries(lucideNames), ...libs, React,
    useState: React.useState, useEffect: React.useEffect, useMemo: React.useMemo,
    useRef: React.useRef, useCallback: React.useCallback,
  },
  exercise: (l) => {
    renderToStaticMarkup(React.createElement(l.OrderDetailInner, { data: { stop: null, stopNbr: '1', date: '2026-09-15', complete: true } }));
    renderToStaticMarkup(React.createElement(l.OrderDetailInner, { data: { stop: null, stopNbr: '1', date: '2026-09-15', complete: false, error: 'x' } }));
  },
});
const panel = (data) => renderToStaticMarkup(React.createElement(OrderDetailInner, { data, onOpenHistory: () => {} }));

test('an order opened during a Firestore 503 comes back as a FAILED read, with the reason', async () => {
  const fake = installFirestoreFake({});
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input?.url ?? input);
    if (u.includes('firestore.googleapis.com') && (init.method || 'GET') === 'GET') return new Response('{"error":{"code":503}}', { status: 503 });
    return inner(input, init);
  };
  try {
    const body = await call('detail=007174397&date=2026-09-15');
    assert.equal(body.ok, true);
    assert.equal(body.stop, null);
    assert.equal(body.complete, false, 'a read that failed must not report complete');
    assert.match(body.error, /503/, 'and the reason rides on the answer');
  } finally { globalThis.fetch = inner; fake.restore(); }
});

test('the panel tells the rep a failed read is a failed read — try again — and never "we hold no record"', () => {
  const html = panel({ ok: true, mode: 'detail', stopNbr: '007174397', date: '2026-09-15', stop: null, complete: false, error: 'getDoc … failed: 503' });
  assert.doesNotMatch(html, /We hold no record/, 'a failed read must not read as a missing order');
  assert.doesNotMatch(html, /rather than retrying/, 'and must not tell the rep not to retry');
  assert.match(html, /could not read/i);
  assert.match(html, /503/, 'the reason is on screen');
  assert.match(html, /again/i, 'and the rep is told to try again');
});

test('an order that genuinely is not there (every read answered) still says "we hold no record"', () => {
  const html = panel({ ok: true, mode: 'detail', stopNbr: '007174397', date: '2026-09-15', stop: null, complete: true, error: null });
  assert.match(html, /We hold no record of 007174397/);
});
