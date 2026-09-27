// test/address-queue-badge-follows-list.test.mjs
//
// THE "ADDRESSES TO FIX" BADGE WAS READ ONCE PER PAGE LOAD AND NEVER MOVED
// (audit 2026-09-27, app-A3-6).
//
// The Shell's badge hook ran its read once, on mount. Every queue load called
// bustProblemAddressCount(), which only nulled a module variable — nothing re-ran the Shell's
// effect or called its setter. So at 7am the badge read 9, the dispatcher fixed all nine on
// Address history, and the More menu still said 9 all day. A badge that keeps showing problems
// that are fixed is crying wolf, and gets ignored by the afternoon.
//
// The design the code's own comments describe: one read per session for the badge, and working
// the queue down moves it. The queue load already HAS the fresh count, so it now hands it to the
// badge — no second read.
//
// These RUN the real useProblemAddressCount and useAddressQueue out of App.jsx against a minimal
// hooks stand-in that does run effects, with a stubbed apiFetch that counts reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const APP = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function fnSource(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} not found in App.jsx`);
  const next = APP.indexOf('\nfunction ', start + 1);
  return APP.slice(start, next > 0 ? next : undefined);
}
const BADGE_BLOCK = (() => {
  const start = APP.indexOf('let __addrQueueBadgeCache = null;');
  const end = APP.indexOf('/** The state every queue view shares.');
  assert.ok(start > 0 && end > start, 'the badge block could not be sliced out of App.jsx');
  return APP.slice(start, end);
})();

const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
/** One component's worth of hooks: state, memoised callbacks, and effects that actually run. */
function runtime() {
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
    useCallback(fn, deps) {
      const k = i++;
      if (slots[k] && same(slots[k].deps, deps)) return slots[k].fn;
      slots[k] = { fn, deps };
      return fn;
    },
    useMemo(fn, deps) {
      const k = i++;
      if (slots[k] && same(slots[k].deps, deps)) return slots[k].v;
      slots[k] = { v: fn(), deps };
      return slots[k].v;
    },
    useEffect(fn, deps) {
      const k = i++;
      const prev = slots[k];
      if (prev && same(prev.deps, deps)) return;
      const rec = { deps, cleanup: null };
      slots[k] = rec;
      pending.push(() => { if (prev?.cleanup) prev.cleanup(); const c = fn(); rec.cleanup = typeof c === 'function' ? c : null; });
    },
  };
  return {
    React,
    render(hook) { i = 0; pending = []; const out = hook(); for (const p of pending) p(); return out; },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const reads = [];
  let answer = null;
  let current = null;
  const ReactProxy = new Proxy({}, { get: (_, k) => current.React[k] });
  const apiFetch = async (url) => { reads.push(String(url)); const j = answer(url); return { json: async () => j }; };
  // eslint-disable-next-line no-new-func
  const mod = new Function('React', 'apiFetch',
    `'use strict';\n${BADGE_BLOCK}\n${fnSource('useAddressQueue')}\nreturn { useProblemAddressCount, useAddressQueue };`)(ReactProxy, apiFetch);
  const shell = runtime();
  const screen = runtime();
  return {
    reads,
    setAnswer: (fn) => { answer = fn; },
    badge: () => { current = shell; return shell.render(() => mod.useProblemAddressCount()); },
    queue: () => { current = screen; return screen.render(() => mod.useAddressQueue(0)); },
  };
}
const summary = (s) => ({ ok: true, days: [], dates: [], summary: { mis_split: 0, no_pin: 0, corrected_not_pinned: 0, dismissed: 0, ...s } });

test('a dispatcher who works the queue from 9 down to 0 sees the badge go to 0 without reloading the page', async () => {
  const h = harness();
  h.setAnswer(() => summary({ mis_split: 4, no_pin: 3, corrected_not_pinned: 2 }));
  h.badge(); await tick();
  assert.equal(h.badge(), 9, 'the 7am read');

  // All nine fixed on Address history; the queue reloads after the last save.
  h.setAnswer(() => summary({}));
  h.queue(); await tick(); h.queue();
  assert.equal(h.badge(), 0, 'the badge follows the list it counts');
});

test('new problems the afternoon scans add light the badge the next time the queue is loaded', async () => {
  const h = harness();
  h.setAnswer(() => summary({ no_pin: 1 }));
  h.badge(); await tick();
  assert.equal(h.badge(), 1);
  h.setAnswer(() => summary({ no_pin: 1, mis_split: 3 }));
  h.queue(); await tick(); h.queue();
  assert.equal(h.badge(), 4);
});

test('it still costs ONE badge read per session — the queue load’s own answer is what moves it', async () => {
  const h = harness();
  h.setAnswer(() => summary({ no_pin: 2 }));
  h.badge(); await tick(); h.badge();
  h.setAnswer(() => summary({ no_pin: 1 }));
  h.queue(); await tick(); h.queue(); h.badge();
  assert.equal(h.reads.length, 2, 'one badge read + one queue read, never a second badge read');
});

test('waved-off rows never count, even when the queue is showing them', async () => {
  // address-queue.mts counts a waved-off row into its signal's total AND into `dismissed` when
  // ?dismissed=1 is asked for, and into `dismissed` alone otherwise. The badge never counts it.
  const h = harness();
  h.setAnswer(() => summary({ no_pin: 2 }));
  h.badge(); await tick();
  h.setAnswer(() => summary({ no_pin: 2 }));
  const q = h.queue(); await tick(); h.queue();
  assert.equal(h.badge(), 2);
  h.setAnswer((url) => (url.includes('dismissed=1') ? summary({ no_pin: 3, dismissed: 1 }) : summary({ no_pin: 2, dismissed: 1 })));
  q.setShowDismissed(true); h.queue(); await tick(); h.queue();
  assert.ok(h.reads.at(-1).includes('dismissed=1'), 'the fixture really exercised the waved-off read');
  assert.equal(h.badge(), 2, 'the waved-off row is not a thing to fix');
});

test('a failed queue read leaves the badge where it was', async () => {
  const h = harness();
  h.setAnswer(() => summary({ no_pin: 5 }));
  h.badge(); await tick();
  h.setAnswer(() => ({ ok: false, error: 'read failed' }));
  h.queue(); await tick(); h.queue();
  assert.equal(h.badge(), 5);
});

test('two reloads in flight: the answer read AFTER a wave-off wins, even when the older one lands last', async () => {
  // The list stays usable through a reload (A3-2), so a save on one row and a wave-off on the next
  // can each start one. The older read — taken before the wave-off — must not put the row back
  // on the list or the badge back up by one.
  const h = harness();
  h.setAnswer(() => summary({ no_pin: 2 }));
  h.badge(); await tick();
  h.queue(); await tick();
  const q = h.queue();
  assert.equal(h.badge(), 2);

  const gates = [];
  h.setAnswer(() => new Promise((resolve) => gates.push(resolve)));
  const older = q.reload();         // read before the wave-off: 2 to fix
  const newer = q.reload();         // read after it: 1 to fix
  assert.equal(gates.length, 2, 'both reads went out');
  gates[1](summary({ no_pin: 1, dismissed: 1 }));
  await newer;
  gates[0](summary({ no_pin: 2 }));
  await older;

  const after = h.queue();
  assert.equal(after.data.summary.no_pin, 1, 'the list is the newer read');
  assert.equal(after.loading, false);
  assert.equal(h.badge(), 1, 'and so is the badge');
});
