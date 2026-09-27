// test/address-queue-day-select-all.test.mjs
//
// THE PER-DAY "SELECT ALL" BOX TICKED ROWS THE GROUP PUSH MUST NEVER TOUCH
// (audit 2026-09-27, app-A3-1).
//
// The box above each board day on the problem-address queue COUNTED only rows a push can be
// pinned to (queueRowPushable — a stopId, not already delivered — and not waved off): "Select all
// 1 on this day". Its click then added EVERY row of the day to the selection. The rows it pulled
// in have no checkbox of their own, so the dispatcher could not see they were picked, and
// "Correct N + NuVizz" then sent them:
//   • a row with NO stopId — the server's wrong-twin guard is disarmed without one, so the push
//     can re-address the OTHER customer's order sharing that number (the Estes-0828068215 case);
//   • a DELIVERED row — a NuVizz call spent only to be refused;
//   • with "show waved off" on, rows the dispatcher had waved off.
// The day box was the ONLY way any of those could reach the vendor.
//
// These RUN the real hook and the real box out of App.jsx — the box's JSX compiled with the same
// esbuild the build uses — against a minimal hooks stand-in, and read what the push would get.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  const body = APP.slice(start, next > 0 ? next : undefined);
  assert.ok(body.length > 100, `${name} sliced to nothing`);
  return body;
}
function constLine(name) {
  const start = APP.indexOf(`const ${name} = `);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  return APP.slice(start, APP.indexOf('\n', start));
}
const jsx = (src) => transformSync(src, { loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' }).code;

/** Just enough of React to run a hook and a leaf component: state that survives re-renders. */
function hooksRuntime() {
  const slots = [];
  let i = 0;
  const React = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init;
      return [slots[k], (v) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }];
    },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect: () => {},
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    Fragment: 'Fragment',
  };
  return { React, render: (fn) => { i = 0; return fn(); } };
}

function load(days) {
  const hook = hooksRuntime();
  const box = hooksRuntime();
  const shared = [constLine('queueRowExecuted'), constLine('queueRowPushable'), fnSource('dayPickState')].join('\n');
  // eslint-disable-next-line no-new-func
  const useProblemQueue = new Function('React', 'useAddressQueue', 'useGoogleMaps', 'useQueuePush', 'apiFetch',
    `'use strict';\n${shared}\n${fnSource('useProblemQueue')}\nreturn useProblemQueue;`)(
    hook.React,
    () => ({ data: { days }, loading: false, err: null, showDismissed: true, setShowDismissed: () => {}, reload: () => {} }),
    () => ({ google: null }),
    () => ({ running: false, results: {} }),
    async () => { throw new Error('no network in tests'); },
  );
  // eslint-disable-next-line no-new-func
  const QueueSelectAllBox = new Function('React',
    `'use strict';\n${shared}\n${jsx(fnSource('QueueSelectAllBox'))}\nreturn QueueSelectAllBox;`)(box.React);
  const dayPickState = new Function(`'use strict';\n${shared}\nreturn dayPickState;`)();
  return {
    q: () => hook.render(() => useProblemQueue(0, '2026-09-28')),
    box: (d, q) => box.render(() => QueueSelectAllBox({ d, q })),
    dayPickState,
  };
}

// One board day, the finder's rows: A is the only row a push can be pinned to.
const A = { key: 'mis_split__A', signal: 'mis_split', stopNbr: 'A', stopId: '11', status: 'PLANNED' };
const B = { key: 'mis_split__B', signal: 'mis_split', stopNbr: 'B', stopId: null, status: 'PLANNED' };
const C = { key: 'mis_split__C', signal: 'mis_split', stopNbr: 'C', stopId: '33', status: 'DELIVERED' };
const D = { key: 'mis_split__D', signal: 'mis_split', stopNbr: 'D', stopId: '44', status: 'PLANNED', dismissed: true };
const DAY = { date: '2026-09-28', stopsRead: 40, rows: [A, B, C, D] };

test('the day box reads "Select all 1" and one press selects exactly that one row', () => {
  const t = load([DAY]);
  const before = t.q();
  assert.deepEqual(t.dayPickState(DAY.rows, before.picked), { total: 1, on: 0, all: false, some: false });
  t.box(DAY, before).props.onChange();
  const after = t.q();
  assert.deepEqual(after.selected.map((r) => r.key), ['mis_split__A'], 'the push gets what the box said, and nothing else');
});

test('a row with no NuVizz stop id is never swept into a group push — the wrong-twin guard is off without one', () => {
  const t = load([DAY]);
  t.box(DAY, t.q()).props.onChange();
  const q = t.q();
  assert.ok(!q.selected.some((r) => r.key === B.key), 'B would be written by number alone');
  assert.ok(!q.picked.has(B.key), 'and it is not silently ticked behind a row with no checkbox');
});

test('delivered freight and waved-off rows are not swept either', () => {
  const t = load([DAY]);
  t.box(DAY, t.q()).props.onChange();
  const q = t.q();
  assert.ok(!q.selected.some((r) => r.key === C.key), 'a delivered stop only spends a call to be refused');
  assert.ok(!q.selected.some((r) => r.key === D.key), 'a row the dispatcher waved off stays waved off');
});

test('after the press the box reads checked, and a second press clears the day', () => {
  const t = load([DAY]);
  t.box(DAY, t.q()).props.onChange();
  assert.deepEqual(t.dayPickState(DAY.rows, t.q().picked), { total: 1, on: 1, all: true, some: false });
  t.box(DAY, t.q()).props.onChange();
  assert.deepEqual(t.q().selected, []);
});

test('SECOND GUARD: a row that is somehow picked but cannot be pinned never reaches the push', () => {
  // Whatever puts a key in `picked` — a future control, a row waved off after it was ticked — the
  // rows handed to the group buttons are only ones a push can be pinned to and nobody waved off.
  const t = load([DAY]);
  const q0 = t.q();
  for (const r of DAY.rows) q0.toggle(r.key);
  assert.deepEqual(t.q().selected.map((r) => r.key), ['mis_split__A']);
});
