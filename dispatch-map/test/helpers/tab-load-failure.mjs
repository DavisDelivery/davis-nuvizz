// test/helpers/tab-load-failure.mjs
//
// RUN THE REAL FAILURE SCREEN, DO NOT GREP IT. src/components/TabLoadFailure.jsx is JSX, which
// node:test cannot import, so it is compiled here with esbuild (already a devDependency) — bundled
// with its real src/lib/load-failure.js, React left to Node's own copy — and evaluated. A test can
// then call tabLoadFailed() exactly as App.jsx's .catch does, render what React.lazy would render,
// and press its button.
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const ENTRY = fileURLToPath(new URL('../../src/components/TabLoadFailure.jsx', import.meta.url));

let MOD = null;
/** The compiled module: { tabLoadFailed }. */
export function tabLoadFailureModule() {
  if (MOD) return MOD;
  const out = buildSync({
    entryPoints: [ENTRY], bundle: true, write: false, format: 'cjs', platform: 'node',
    external: ['react'], jsx: 'transform', logLevel: 'silent',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, module, module.exports);
  if (typeof module.exports.tabLoadFailed !== 'function') throw new Error('TabLoadFailure.jsx no longer exports tabLoadFailed');
  MOD = module.exports;
  return MOD;
}

/** tabLoadFailed(tab, err) with console.error captured, not printed. */
export function failTab(tab, err) {
  const logged = [];
  const orig = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    return { mod: tabLoadFailureModule().tabLoadFailed(tab, err), logged };
  } finally {
    console.error = orig;
  }
}

/** The HTML React renders for the module a failed tab hands React.lazy. */
export function renderFailed(mod) {
  return renderToStaticMarkup(React.createElement(mod.default));
}

/** Every element in a rendered tree (the component called as React would call it). */
export function elements(node, out = []) {
  if (Array.isArray(node)) { for (const n of node) elements(n, out); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  out.push(node);
  elements(node.props.children, out);
  return out;
}
