// test/claude-shadow-router-settings-touched-only.test.mjs — ROUTER SETTINGS SAVES ONLY WHAT WAS CHANGED.
//
// Audit 2026-09-27 (shadow-frontend-3): A opens Router settings while the per-day cap is $5. Chad lowers
// it to $1 from another device and A's summary line refreshes to "≤$1.00/day". A changes only the cost
// per mile and saves. The save sent every field as the form held it when it opened — maxUsd "5" among
// them — so the spend cap went back up to $5 with nobody choosing it, and a weight limit someone had
// just pinned or cleared was put back the way it was. The server patches exactly the fields it is
// sent, so the form must send only the ones this person changed — the rule the capacity editor on the
// same screen already keeps ("ONLY BOXES YOU TOUCHED are sent").
//
// These RUN the real RouterSettings form out of BacktestPanel.jsx (JSX compiled with the repo's
// esbuild) against a minimal hooks stand-in. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const BT = readFileSync(new URL('../src/shadow/BacktestPanel.jsx', import.meta.url), 'utf8');

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
const textOf = (n) => (n == null || n === false || n === true ? '' : typeof n === 'string' || typeof n === 'number' ? String(n)
  : Array.isArray(n) ? n.map(textOf).join('') : textOf(n.props?.children));
function findAll(n, pred, out = []) {
  if (n == null || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const c of n) findAll(c, pred, out); return out; }
  if (pred(n)) out.push(n);
  findAll(n.props?.children, pred, out);
  return out;
}
const byText = (tree, type, re) => {
  const hit = findAll(tree, (n) => n.type === type && re.test(textOf(n)));
  assert.ok(hit.length, `no <${type}> reading ${re}`);
  return hit[0];
};
const fieldIn = (tree, labelRe) => findAll(byText(tree, 'label', labelRe), (n) => n.type === 'input' || n.type === 'select')[0];

function loadRouterSettings(React) {
  const start = BT.indexOf('function RouterSettings(');
  assert.ok(start > 0, 'RouterSettings not found in BacktestPanel.jsx');
  const src = BT.slice(start, BT.indexOf('\n}\n', start) + 2);
  const code = transformSync(src, { loader: 'jsx', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' }).code;
  const icon = () => null;
  const usd = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—');
  const int = (v) => (typeof v === 'number' ? String(Math.round(v)) : '—');
  // Anything the form imports from a sibling module is handed in by name from the real module.
  return import('../src/shadow/router-settings-core.js').catch(() => ({})).then((core) => new Function(
    'React', 'Settings2', 'ChevronDown', 'ChevronRight', 'usd', 'int', 'core',
    `const { useState } = React; const { routerChange } = core;\n${code}\nreturn RouterSettings;`,
  )(React, icon, icon, icon, usd, int, core));
}

const view = (s, pinned = { lbsBox: false, lbsTractor: true }) => ({
  settings: { capRule: 'tighter', effort: 'high', maxRounds: 8, costPerMile: null, costPerDriveHour: 38.5, lbsBox: 12000, lbsTractor: 30000, ...s },
  pinned, efforts: ['high', 'medium'], bounds: { maxRounds: [2, 20], maxUsd: [0.5, 50] }, defaults: { lbsBox: 12000, lbsTractor: 40000 },
  ceiling: { usd: 25, spent24h: 0 },
});

/** `edits`: one change per render, as a person's keystrokes arrive. */
async function openEditSave(before, after, ...edits) {
  const { React, render } = hooksRuntime();
  const RouterSettings = await loadRouterSettings(React);
  const sent = [];
  const onSave = async (change) => { sent.push(change); return { ok: true }; };
  let tree = render(() => RouterSettings({ v: before, onSave }));
  byText(tree, 'button', /Router settings/).props.onClick();            // A opens the form
  tree = render(() => RouterSettings({ v: after, onSave }));            // someone else's save lands; the poll hands back new settings
  for (const edit of edits) { edit(tree); tree = render(() => RouterSettings({ v: after, onSave })); }
  await byText(tree, 'button', /^Save$/).props.onClick();
  tree = render(() => RouterSettings({ v: after, onSave }));
  return { sent, tree };
}

test('another person lowered the $/day cap while the form was open: changing only the cost per mile does not put the old cap back', async () => {
  const { sent } = await openEditSave(view({ maxUsd: 5 }), view({ maxUsd: 1 }), (tree) => {
    fieldIn(tree, /Cost per road mile/).props.onChange({ target: { value: '2.25' } });
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { costPerMile: '2.25' }, 'only the field A changed goes to the server');
});

test('a weight limit nobody touched is neither re-pinned nor cleared by a save of something else', async () => {
  // Tractor limit pinned at 30,000 when A opened; box limit on its default (blank in the form).
  const { sent } = await openEditSave(view({ maxUsd: 5 }), view({ maxUsd: 5, lbsTractor: 40000 }, { lbsBox: true, lbsTractor: false }), (tree) => {
    fieldIn(tree, /Model effort/).props.onChange({ target: { value: 'medium' } });
  });
  assert.deepEqual(sent[0], { effort: 'medium' });
});

test('a field cleared to blank still goes to the server as blank (back to the default or to no rate)', async () => {
  const { sent } = await openEditSave(view({ maxUsd: 5 }), view({ maxUsd: 5 }),
    (tree) => fieldIn(tree, /Tractor weight limit/).props.onChange({ target: { value: '' } }),
    (tree) => fieldIn(tree, /Cost per drive hour/).props.onChange({ target: { value: ' ' } }));
  assert.deepEqual(sent[0], { lbsTractor: null, costPerDriveHour: null });
});

test('a save with nothing changed sends nothing and says so', async () => {
  const { sent, tree } = await openEditSave(view({ maxUsd: 5 }), view({ maxUsd: 1 }));
  assert.equal(sent.length, 0, 'no request: an untouched form must not overwrite anything');
  assert.match(textOf(tree), /Nothing was changed, so nothing was saved/);
});
