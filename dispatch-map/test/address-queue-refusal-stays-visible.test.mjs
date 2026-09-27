// test/address-queue-refusal-stays-visible.test.mjs
//
// A REFUSED "SAVE & CORRECT NUVIZZ" LOOKED LIKE A SUCCESS (audit 2026-09-27, app-A3-2).
//
// On the problem-address queue, one row's editor saved the board half, pushed to NuVizz, and put
// the vendor's answer in the editor's OWN state — then closed the editor (the only place that
// message rendered) and reloaded the list. The reload blanked both views to "Loading the board…",
// unmounting every row, and a mis_split or no_pin row whose board half landed was no longer a
// problem, so it came back gone. NuVizz could have said no: the row vanished all the same, which
// reads as done, while the portal and the driver's manifest kept the old address. A group run
// ended the same way — its verdicts were kept, but for rows no longer on the list to show them.
//
// What happens now: every NuVizz verdict, single-row or group, is kept in the queue's shared
// results; a row still on the list shows it on its own line; a row that left the list shows it on
// the summary bar at the top of both views; and a reload keeps the list up instead of unmounting it.
//
// These RUN the real hooks and the real summary bar out of App.jsx (JSX compiled with the repo's
// esbuild) against a minimal hooks stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}
/** One top-level function and nothing after it — fnSource runs on to the next `function`, and
 *  would carry any `const` declared in between along with it. */
function fnOnly(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  return APP.slice(start, APP.indexOf('\n}\n', start) + 2);
}
function constLine(name) {
  const start = APP.indexOf(`const ${name} = `);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  return APP.slice(start, APP.indexOf('\n', start));
}
const jsx = (src) => transformSync(src, { loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' }).code;
const has = (name) => APP.includes(`function ${name}(`);

function hooksRuntime() {
  const slots = [];
  let i = 0;
  const React = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init };
      const s = slots[k];
      return [s.v, (v) => { s.v = typeof v === 'function' ? v(s.v) : v; }];
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
/** Every string a rendered element tree would paint. */
function textOf(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

const SHARED = () => [
  constLine('oneLineAddr'), fnOnly('correctedFields'), fnOnly('worthPushing'), fnOnly('queueCostLine'), fnOnly('queueClientOpId'),
  constLine('QUEUE_WARN_KINDS'), has('queueVerdictsOffList') ? fnOnly('queueVerdictsOffList') : '',
].join('\n');

const ROW = { key: 'mis_split__007174397', signal: 'mis_split', stopNbr: '007174397', stopId: '11', status: 'PLANNED', businessName: 'ACME SUPPLY',
  matchKey: 'acme|buford', shown: { addr1: 'PMB 271', addr2: '90F GLENDA TRCE', city: 'BUFORD', state: 'GA', zip: '30518' },
  vendor: { addr1: 'PMB 271', addr2: '90F GLENDA TRCE', city: 'BUFORD', state: 'GA', zip: '30518' }, suggestion: { addr1: '90F GLENDA TRCE', addr2: 'PMB 271' } };
const REFUSED = { kind: 'refused', text: 'NuVizz rejected the address' };

test('a single-row Save & correct NuVizz hands the vendor’s answer to the queue, not just to the editor it closes', async () => {
  const rt = hooksRuntime();
  const heard = [];
  // eslint-disable-next-line no-new-func
  const useQueueRowEdit = new Function('React', 'saveQueueCorrection', 'db', 'setDoc', 'doc', 'serverTimestamp',
    `'use strict';\n${SHARED()}\n${fnSource('useQueueRowEdit')}\nreturn useQueueRowEdit;`)(
    rt.React, async () => ({ geoErr: null, pushed: REFUSED, logged: { recorded: true } }), {}, async () => {}, () => null, () => 'ts');
  let reloaded = 0;
  const e = rt.render(() => useQueueRowEdit(ROW, null, '2026-09-28', () => { reloaded += 1; }, (row, v) => heard.push([row.key, v])));
  rt.render(() => useQueueRowEdit(ROW, null, '2026-09-28', () => { reloaded += 1; }, (row, v) => heard.push([row.key, v]))).setOpen(true);
  await e.save(true);
  assert.equal(reloaded, 1);
  assert.deepEqual(heard, [[ROW.key, REFUSED]], 'the refusal is recorded where it outlives the row');
});

test('the refusal of a row that has LEFT the list is on the summary bar, in both views', () => {
  assert.ok(has('queueVerdictsOffList'), 'queueVerdictsOffList must exist in App.jsx');
  const rt = hooksRuntime();
  // eslint-disable-next-line no-new-func
  const QueueSummaryBar = new Function('React', 'QueueSignalBadge',
    `'use strict';\n${SHARED()}\n${jsx(fnSource('QueueSummaryBar'))}\nreturn QueueSummaryBar;`)(rt.React, () => null);
  const q = {
    data: { summary: {} }, allRows: [], selected: [], picked: new Set(), sweepable: [], showDismissed: false,
    push: { running: false, budget: null, fatal: null, logged: null,
      results: { [ROW.key]: { ...REFUSED, vendor: true, who: 'ACME SUPPLY · 007174397' } } },
  };
  for (const stacked of [true, false]) {
    const painted = textOf(rt.render(() => QueueSummaryBar({ q, stacked })));
    assert.match(painted, /ACME SUPPLY · 007174397/, 'names the order');
    assert.match(painted, /NuVizz rejected the address/, 'quotes what NuVizz said');
    assert.match(painted, /portal/, 'and says where to fix it');
  }
});

test('what goes on that list: only NuVizz answers worth a look, only for rows no longer on screen', () => {
  assert.ok(has('queueVerdictsOffList'), 'queueVerdictsOffList must exist in App.jsx');
  // eslint-disable-next-line no-new-func
  const queueVerdictsOffList = new Function(`'use strict';\n${SHARED()}\nreturn queueVerdictsOffList;`)();
  const results = {
    gone_refused: { kind: 'refused', text: 'no', vendor: true, who: 'A' },
    gone_unknown: { kind: 'unknown', text: 'unverified', vendor: true, who: 'B' },
    gone_fatal: { kind: 'identity', fatal: true, text: 'add your login', vendor: true, who: 'C' },
    gone_ok: { kind: 'ok', text: 'NuVizz now reads …', vendor: true, who: 'D' },
    gone_already: { kind: 'already', text: 'Already pushed', vendor: true, who: 'E' },
    gone_board_only_partial: { kind: 'partial', text: 'pin could not be moved', who: 'F' },
    listed_refused: { kind: 'refused', text: 'no', vendor: true, who: 'G' },
  };
  const out = queueVerdictsOffList(results, [{ key: 'listed_refused' }]);
  assert.deepEqual(out.map((v) => v.key).sort(), ['gone_fatal', 'gone_refused', 'gone_unknown']);
  assert.deepEqual(queueVerdictsOffList(null, null), [], 'nothing in, nothing out');
});

test('a group run’s verdicts carry the order’s name and are marked as NuVizz answers', async () => {
  const rt = hooksRuntime();
  // eslint-disable-next-line no-new-func
  const useQueuePush = new Function('React', 'saveQueueCorrection', 'callWrite',
    `'use strict';\n${SHARED()}\n${fnSource('useQueuePush')}\nreturn useQueuePush;`)(
    rt.React, async () => ({ geoErr: null, pushed: REFUSED, logged: { recorded: true } }), async () => ({}));
  const p = rt.render(() => useQueuePush('2026-09-28', () => {}));
  await p.runGroup([ROW], null, true);
  const v = rt.render(() => useQueuePush('2026-09-28', () => {})).results[ROW.key];
  assert.equal(v.kind, 'refused');
  assert.equal(v.vendor, true);
  assert.match(v.who, /ACME SUPPLY/);
});

test('both views keep the list mounted while it reloads, and both rows report into the shared results', () => {
  for (const view of ['ProblemQueueMobile', 'ProblemQueueDesktop']) {
    const src = fnSource(view);
    assert.match(src, /if \(q\.loading && !q\.data\) return/, `${view}: a reload must not unmount every row and its message`);
    assert.doesNotMatch(src, /if \(q\.loading\) return/, `${view}: no bare loading early-return left`);
  }
  for (const row of ['QueueRowMobile', 'QueueRowDesktop']) {
    assert.match(fnSource(row), /useQueueRowEdit\(row, q\.google, today, q\.reload, q\.push\.noteVerdict\)/, `${row} hands the editor the shared recorder`);
  }
});

// ── review: what the list staying up through a reload must NOT do ────────────────────────────
//
// Before this fix a reload unmounted every row, so an editor somebody was typing in CLOSED —
// a visible loss. Kept mounted, the editor stayed open while its re-seed effect (keyed on the
// row OBJECT, which every reload replaces) quietly put the typing back to the suggestion. The
// box still looked like the dispatcher's; the next Save pushed the suggestion to NuVizz.

/** Hooks that run effects only when their deps change, as React does. */
function effectsRuntime() {
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const slots = [];
  let i = 0;
  let pending = [];
  const React = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init };
      const s = slots[k];
      return [s.v, (v) => { s.v = typeof v === 'function' ? v(s.v) : v; }];
    },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useCallback(fn) { i++; return fn; },
    useMemo(fn) { i++; return fn(); },
    useEffect(fn, deps) {
      const k = i++;
      const prev = slots[k];
      if (prev && same(prev.deps, deps)) return;
      slots[k] = { deps };
      pending.push(fn);
    },
  };
  return { React, render(fn) { i = 0; pending = []; const out = fn(); for (const p of pending) p(); return out; } };
}

test('a reload caused by ANOTHER row leaves what the dispatcher is typing in an open editor alone', () => {
  const rt = effectsRuntime();
  // eslint-disable-next-line no-new-func
  const useQueueRowEdit = new Function('React', 'saveQueueCorrection', 'db', 'setDoc', 'doc', 'serverTimestamp',
    `'use strict';\n${SHARED()}\n${fnSource('useQueueRowEdit')}\nreturn useQueueRowEdit;`)(
    rt.React, async () => ({}), {}, async () => {}, () => null, () => 'ts');
  const B = { key: 'no_pin__B', signal: 'no_pin', stopNbr: 'B', stopId: '2', shown: { addr1: '10 OLD RD', addr2: '', city: 'BUFORD', state: 'GA', zip: '30518' } };
  const edit = (row) => rt.render(() => useQueueRowEdit(row, null, '2026-09-28', () => {}));
  edit(B).setOpen(true);
  edit(B).setF((p) => ({ ...p, addr1: '12 OLD RD' }));
  assert.equal(edit(B).f.addr1, '12 OLD RD');

  // Row A's save reloads the list: B comes back as a NEW object carrying the SAME row.
  const reloaded = JSON.parse(JSON.stringify(B));
  edit(reloaded);
  const e = edit(reloaded);
  assert.equal(e.open, true);
  assert.equal(e.f.addr1, '12 OLD RD', 'the open editor still holds what was typed — and that is what Save would push');

  // A row whose correction really did change underneath (another dispatcher fixed it) re-seeds.
  const changed = { ...reloaded, shown: { ...reloaded.shown, addr1: '14 OLD RD' } };
  edit(changed);
  assert.equal(edit(changed).f.addr1, '14 OLD RD');
});
