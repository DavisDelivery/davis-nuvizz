// test/bulk-receipt-keeps-batch-ticked.test.mjs
//
// BULK ADD'S RECEIPT OPENED WITH NOTHING TICKED (audit 2026-09-27, app-A3-9).
//
// A clean Bulk add run jumps to the "Pushed to NuVizz" receipt with the batch it just created
// already ticked, "so Print labels is one tap". When the receipt's date box was on another day —
// the dispatcher had looked at yesterday's pushes, or the tab had stayed open past midnight —
// the run moved the box back to today AND ticked the batch in the same render; then an effect
// keyed on the date ran and cleared every tick. The receipt read "Print labels — tick rows
// first", and Select all would have ticked earlier pushes from today as well.
//
// These RUN the real code out of BulkOrderScreen — the date and selection state, every effect
// and helper that touches them, the end of createAll and the date box's own handlers — on a
// hooks stand-in that commits and runs effects the way React 18 does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const compStart = APP.indexOf('function BulkOrderScreen(');
const COMP = APP.slice(compStart, APP.indexOf('\nfunction ', compStart + 1));
const LINES = COMP.split('\n');

// Every one-line effect that touches the selection, and every one-line helper that moves the date.
const EFFECTS = LINES.filter((l) => /^\s*useEffect\(/.test(l) && /setPushedSel\(/.test(l));
const HELPERS = LINES.filter((l) => /^\s*const \w+ = \([^)]*\) => \{.*setPushedDate\(/.test(l));

// The end of createAll: log written, date moved to today, batch ticked, receipt opened.
const createAll = COMP.slice(COMP.indexOf('const createAll = async () => {'));
const tailFrom = createAll.indexOf('const today = etTodayStr();');
const tailTo = createAll.indexOf("setBulkView('pushed');", tailFrom);
assert.ok(tailFrom > 0 && tailTo > tailFrom, 'the end of createAll is where it was');
const TAIL = createAll.slice(tailFrom, createAll.indexOf('}', tailTo) + 1);

// The date box and its Today button on the Pushed tab, compiled out of the JSX as written.
const pushedView = COMP.slice(COMP.indexOf('<FileCheck size={14} /> Pushed to NuVizz'));
const box = /<input type="date" value=\{pushedDate\}[^>]*?onChange=\{(\(e\) => [^}]+)\}/.exec(pushedView);
const todayBtn = /\{!isToday && <button onClick=\{(\(\) => [^}]+\))\}/.exec(pushedView);
assert.ok(box && todayBtn, 'the Pushed tab\'s date box and Today button are where they were');

function mount({ date, today }) {
  const slots = [];
  const queue = [];
  let prevDeps = [];
  let i = 0;
  let pending = [];
  const React = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init;
      return [slots[k], (v) => queue.push([k, v])];
    },
    useEffect(fn, deps) {
      const k = i++;
      const before = prevDeps[k];
      if (!before || deps.some((d, j) => !Object.is(d, before[j]))) pending.push(fn);
      prevDeps[k] = deps;
    },
  };
  const src = [
    `const etTodayStr = () => ${JSON.stringify(today)};`,
    `const [pushedDate, setPushedDate] = useState(${JSON.stringify(date)});`,
    'const [pushedSel, setPushedSel] = useState(() => new Set());',
    ...EFFECTS, ...HELPERS,
    'const fetchPushedLog = () => {};',
    'const setBulkView = () => {};',
    'const isToday = pushedDate === etTodayStr();',
    `return { pushedDate, pushedSel, pickDay: ${box[1]}, today: ${todayBtn[1]},`,
    `  finishRun: (out, labelOrders) => { ${TAIL} } };`,
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const body = new Function('useState', 'useEffect', transformSync(`function Body() {\n${src}\n}`, { loader: 'jsx' }).code + '\nreturn Body;')(React.useState, React.useEffect);
  let view;
  const render = () => { i = 0; pending = []; view = body(); };
  const settle = () => {
    for (let n = 0; n < 20; n++) {
      if (!queue.length && !pending.length) return;
      const fx = pending; pending = [];
      for (const f of fx) f();
      if (!queue.length) continue;
      // One commit for everything set since the last one — React 18's automatic batching.
      for (const [k, v] of queue.splice(0)) slots[k] = typeof v === 'function' ? v(slots[k]) : v;
      render();
    }
    throw new Error('never settled');
  };
  render(); settle();
  return { view: () => view, act: (fn) => { fn(view); settle(); } };
}

const BATCH = [{ stopNbr: 'SHP29379' }, { stopNbr: 'SHP29380' }];

test('the Pushed tab was left on yesterday — a clean run still opens the receipt with its batch ticked', () => {
  const s = mount({ date: '2026-09-26', today: '2026-09-27' });
  s.act((v) => v.finishRun([{ ok: true }, { ok: true }], BATCH));
  assert.equal(s.view().pushedDate, '2026-09-27', 'the receipt is on today');
  assert.deepEqual([...s.view().pushedSel].sort(), ['SHP29379', 'SHP29380'], 'Print labels is one tap');
});

test('a clean run with the receipt already on today ticks its batch, as before', () => {
  const s = mount({ date: '2026-09-27', today: '2026-09-27' });
  s.act((v) => v.finishRun([{ ok: true }, { ok: true }], BATCH));
  assert.deepEqual([...s.view().pushedSel].sort(), ['SHP29379', 'SHP29380']);
});

test('the dispatcher picking another day in the date box still clears the ticks', () => {
  const s = mount({ date: '2026-09-27', today: '2026-09-27' });
  s.act((v) => v.finishRun([{ ok: true }, { ok: true }], BATCH));
  s.act((v) => v.pickDay({ target: { value: '2026-09-25' } }));
  assert.equal(s.view().pushedDate, '2026-09-25');
  assert.equal(s.view().pushedSel.size, 0, 'ticks from one day never ride onto another day\'s list');
});

test('Today on the receipt clears the ticks from the day it leaves', () => {
  const s = mount({ date: '2026-09-27', today: '2026-09-27' });
  s.act((v) => v.pickDay({ target: { value: '2026-09-25' } }));
  s.act((v) => v.finishRun([{ ok: true }, { ok: false }], BATCH));   // not clean: no auto-tick
  assert.equal(s.view().pushedSel.size, 0);
  s.act((v) => v.pickDay({ target: { value: '2026-09-24' } }));
  s.act((v) => v.today());
  assert.equal(s.view().pushedDate, '2026-09-27');
  assert.equal(s.view().pushedSel.size, 0);
});

test('every way the date moves also clears the ticks — no path moves it on its own', () => {
  // The effect that used to do this is gone; each caller now clears as it moves the date.
  const direct = COMP.split('\n').filter((l) => /setPushedDate\(/.test(l) && !HELPERS.includes(l));
  assert.deepEqual(direct, [], 'setPushedDate is only called by the helper that also clears the selection');
  assert.equal(HELPERS.length, 1);
  assert.match(HELPERS[0], /setPushedSel\(new Set\(\)\)/);
});
