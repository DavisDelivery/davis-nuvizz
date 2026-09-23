// test/helpers/app-lift.mjs
//
// LIFT ANY TOP-LEVEL DECLARATION OUT OF App.jsx AND RUN IT — the general form of
// app-stop-marker.mjs, for the Shiplify trial's tests (the legend inventory, the per-tab switch
// stores, the Building type picker).
//
// Same discipline as its siblings: dependencies are found by ITERATING ON THE ReferenceError the
// evaluated body throws, never from a hand-kept list (a curated list is a second place to forget
// something, and forgetting silently tests less than it claims); declarations are re-sorted into
// App.jsx's own order so a const lifted after its reader is not a temporal-dead-zone error; and
// it is LOUD when a symbol is neither declared in App.jsx nor injected.
//
// JSX is compiled with esbuild (already a devDependency) to React.createElement calls, so a
// component can be rendered with react-dom/server. React itself is injected by the caller.
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const APP_URL = new URL('../../src/App.jsx', import.meta.url);
const DECL = (name) => new RegExp(`^(?:export\\s+)?(?:const|let|function|class)\\s+${name}\\b`);

let LINES = null;
function lines() {
  if (!LINES) LINES = readFileSync(APP_URL, 'utf8').split('\n');
  return LINES;
}
function declLine(name) { return lines().findIndex((l) => DECL(name).test(l)); }
function declSource(name) {
  const L = lines();
  const i = declLine(name);
  if (i < 0) return null;
  const opensBlock = /[{[(]\s*(?:\/\/.*)?$/.test(L[i]) || !/;\s*(?:\/\/.*)?$/.test(L[i]);
  if (!opensBlock) return L[i];
  for (let j = i + 1; j < L.length; j++) {
    if (/^(?:\}|\};|\]|\];|\)|\);)\s*(?:\/\/.*)?$/.test(L[j])) return L.slice(i, j + 1).join('\n');
  }
  return null;
}

/**
 * liftFromApp({ targets, inject, exercise })
 *   targets   names to return, e.g. ['useLegendInventory']
 *   inject    { name: value } for everything App.jsx IMPORTS (real modules, never stubs)
 *   exercise  (lifted) => void — call every branch the tests will call, so call-time references
 *             resolve too (construction alone only finds what the top-level body touches)
 * → { [target]: value }
 */
export function liftFromApp({ targets, inject = {}, exercise = () => {} }) {
  const need = [...targets];
  // Only names that can be function parameters (a module's `default` export cannot).
  const RESERVED = new Set(['default', 'class', 'function', 'delete', 'new', 'return', 'switch', 'case', 'var', 'let', 'const', 'import', 'export', 'in', 'do', 'if', 'for', 'while']);
  const names = Object.keys(inject).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n) && !RESERVED.has(n));
  for (let round = 0; round < 800; round++) {
    const raw = [...need].sort((a, b) => declLine(a) - declLine(b)).map(declSource).filter(Boolean).join('\n\n');
    const { code } = transformSync(raw, { loader: 'jsx', jsx: 'transform', jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment' });
    try {
      // eslint-disable-next-line no-new-func
      const build = new Function(...names, `${code}\nreturn { ${targets.join(', ')} };`);
      const lifted = build(...names.map((n) => inject[n]));
      exercise(lifted);
      return lifted;
    } catch (err) {
      const miss = /(\w+) is not defined/.exec(err.message);
      if (!miss) throw new Error(`app-lift: evaluating the lifted code failed — ${err.message}`);
      const sym = miss[1];
      if (need.includes(sym)) throw new Error(`app-lift: '${sym}' is already lifted but still unresolved`);
      if (declLine(sym) < 0) throw new Error(`app-lift: '${sym}' is neither a top-level declaration in App.jsx nor injected`);
      need.push(sym);
    }
  }
  throw new Error('app-lift: gave up resolving dependencies');
}

/** Every export of the given src/lib modules, merged — what App.jsx imports from them. */
export async function libExports(files) {
  const out = {};
  for (const f of files) Object.assign(out, await import(new URL(`../../src/lib/${f}`, import.meta.url)));
  return out;
}
