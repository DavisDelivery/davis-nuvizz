// test/helpers/uat-bench-harness.mjs
//
// RUN THE REAL UAT BENCH SCREEN (src/components/UatBench.jsx) WITHOUT A BROWSER.
//
// The component's JSX is compiled with the repo's esbuild and evaluated against a small hooks
// stand-in: useState / useRef / useMemo / useCallback keep their slots across renders, and
// useEffect runs after a render only when its dependencies changed — the React contract the
// component relies on (the catalogue load is an effect keyed on the date). Its imports are
// injected: the real pure helpers from src/lib/uat-bench-view.js (named from the component's own
// import line, never a hand-kept list), inert icons, and an `apiFetch` the test drives — every
// call is recorded and answered (or rejected) whenever, and in whatever order, the test says.
//
// What comes back is a shallow element tree: elements, not DOM. Components (the icons,
// BenchResult) are left unrendered; tests read the screen's own markup, which is where the date
// box, the order list and the buttons live.
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as view from '../../src/lib/uat-bench-view.js';

const SRC = readFileSync(new URL('../../src/components/UatBench.jsx', import.meta.url), 'utf8');

function importedNames(from) {
  const m = new RegExp(`import\\s+(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*'${from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`).exec(SRC);
  return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
}

const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));

/** A fresh mounted bench. `apiFetch` calls land in `calls`, each with answer(body)/fail(err). */
export function mountBench() {
  const slots = [];
  let i = 0;
  let pendingEffects = [];
  const React = {
    useState(init) {
      const k = i++;
      if (!(k in slots)) slots[k] = { v: typeof init === 'function' ? init() : init };
      const s = slots[k];
      return [s.v, (v) => { s.v = typeof v === 'function' ? v(s.v) : v; }];
    },
    useRef(v) { const k = i++; if (!(k in slots)) slots[k] = { current: v }; return slots[k]; },
    useMemo(fn, deps) {
      const k = i++;
      if (!(k in slots) || depsChanged(slots[k].deps, deps)) slots[k] = { v: fn(), deps };
      return slots[k].v;
    },
    useCallback(fn, deps) {
      const k = i++;
      if (!(k in slots) || depsChanged(slots[k].deps, deps)) slots[k] = { v: fn, deps };
      return slots[k].v;
    },
    useEffect(fn, deps) {
      const k = i++;
      if (!(k in slots) || depsChanged(slots[k].deps, deps)) {
        const prev = slots[k];
        slots[k] = { deps, cleanup: prev?.cleanup };
        pendingEffects.push(() => {
          if (typeof slots[k].cleanup === 'function') slots[k].cleanup();
          const c = fn();
          slots[k].cleanup = typeof c === 'function' ? c : undefined;
        });
      }
    },
    createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
    Fragment: 'Fragment',
  };

  const calls = [];
  const apiFetch = (url, init = {}) => new Promise((resolve, reject) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({
      url: String(url), method: init?.method || 'GET', body,
      answer: (json, status = 200) => resolve({ status, json: async () => json }),
      fail: (err) => reject(err),
    });
  });

  const viewNames = importedNames('../lib/uat-bench-view.js');
  const iconNames = importedNames('lucide-react');
  const reactNames = importedNames('react');
  const body = SRC
    .replace(/^import[\s\S]*?from\s+'[^']+';\s*$/gm, '')
    .replace(/^export default function UatBench/m, 'function UatBench');
  const { code } = transformSync(body, { loader: 'jsx', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' });
  const names = ['React', ...reactNames, 'apiFetch', ...iconNames, ...viewNames];
  const values = [
    React, ...reactNames.map((n) => React[n]), apiFetch,
    ...iconNames.map(() => () => null),
    ...viewNames.map((n) => { if (!(n in view)) throw new Error(`UatBench imports ${n}, which uat-bench-view.js does not export`); return view[n]; }),
  ];
  // eslint-disable-next-line no-new-func
  const { UatBench } = new Function(...names, `'use strict';\n${code}\nreturn { UatBench };`)(...values);

  let tree = null;
  const render = () => {
    i = 0;
    pendingEffects = [];
    tree = UatBench();
    const run = pendingEffects;
    pendingEffects = [];
    for (const e of run) e();
    return tree;
  };
  /** Let every settled promise's continuation run, then render what state now says. */
  const settle = async () => { for (let n = 0; n < 10; n++) await new Promise((r) => setImmediate(r)); return render(); };

  render();
  return { calls, render, settle, get tree() { return tree; } };
}

/** Every string a rendered element tree would paint. */
export function textOf(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

export function findAll(node, pred, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const c of node) findAll(c, pred, out); return out; }
  if (pred(node)) out.push(node);
  findAll(node.props?.children, pred, out);
  return out;
}

export const dateBox = (tree) => findAll(tree, (n) => n.type === 'input' && n.props['aria-label'] === 'Production board day to pick from')[0];
/** The desktop table's order rows. */
export const tableRows = (tree) => findAll(tree, (n) => n.type === 'tr' && typeof n.props.onClick === 'function');
/** The phone view's order cards (the stacked buttons carrying a row key). */
export const phoneCards = (tree) => findAll(tree, (n) => n.type === 'button' && n.props.key != null && typeof n.props.onClick === 'function');
export const button = (tree, label) => findAll(tree, (n) => n.type === 'button' && textOf(n).includes(label) && n.props.key == null)[0];
export const errorBanner = (tree) => findAll(tree, (n) => n.type === 'div' && /bg-red-50/.test(String(n.props.className || '')))[0];
