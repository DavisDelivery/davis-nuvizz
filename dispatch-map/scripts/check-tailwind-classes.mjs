#!/usr/bin/env node
// scripts/check-tailwind-classes.mjs — every class we WRITE must exist in the CSS we SHIP.
//
// WHY THIS EXISTS. Chad, on a phone screenshot of the Routing map legend: "you can't see
// this[,] formatting and colors are bad." The panel was rendering as a sheet of blurred
// satellite imagery with grey text floating on it. The whole cause was four characters:
//
//     <div className="... bg-white/97 backdrop-blur border ...">
//
// Tailwind 3.4's opacity scale runs 0-100 in steps of FIVE. `97` is not on it, and an
// opacity modifier off the scale is not an error — Tailwind emits nothing at all. The class
// was in the markup, matched no rule, and the panel had no background: `backdrop-blur` was
// the only thing still doing anything, which is exactly the blurred-map look in the shot.
// Confirmed by grepping the built stylesheet: bg-white/15, /20, /25, /30, /90 and /95 are
// all there and /97 is not.
//
// THIS IS THE WORST SHAPE A UI BUG COMES IN. The build is green, the bundle is fine, the
// diff reads correctly to a human, every unit test passes, and the failure only exists on a
// screen nobody is looking at. `bg-white/97` and `bg-white/95` differ by one character and
// one of them is invisible. No test in this repo could see it, and the phone guard could
// not either: the panel occupies exactly the right pixels, it just has no paint.
//
// WHAT IT CHECKS, and why it is done this way. It does NOT re-implement Tailwind's opacity
// scale — a copy of someone else's table drifts the moment they change it, and would have
// nothing to say about the next utility that silently emits nothing. It reads the classes
// out of the SOURCE and asks the BUILT stylesheet whether each one exists. Tailwind itself
// is the authority; this only compares the two lists.
//
//   node scripts/check-tailwind-classes.mjs [distDir]     (default: dist)
//
// Exit 0 = every class the source writes is defined in the shipped CSS.
// Exit 1 = at least one class matches no rule, listed with file:line.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

// ── what we look at ──────────────────────────────────────────────────────────
//
// Only tokens whose sole special character is `/` (and the `:` of a variant prefix). That
// deliberately excludes arbitrary values — `max-w-[calc(100vw-1.5rem)]`, `w-[calc(100%/3)]`
// — because their CSS escaping is a much longer story and they are not the bug class this
// guard is for. A slash-modifier token is: an optional chain of variants, a utility, and a
// numeric modifier. It covers every colour-opacity utility (bg-, text-, border-, ring-,
// from-, divide-, shadow-, …) and the layout fractions (w-1/2, top-1/2) for free.
const SLASH_TOKEN = /^(?:[a-z][a-z0-9-]*:)*-?[a-z][a-zA-Z0-9-]*\/[0-9]+$/;

/**
 * PURE. Every class token containing a `/` that this source writes into a className,
 * with the 1-based line it sits on.
 *
 * Reads `className="…"`, `className='…'`, `className={'…'}` and `className={`…`}` —
 * including the template literals this app builds its conditional classes with. A token
 * carrying `${` is skipped: it is a runtime value, not a literal class.
 */
export function findSlashClasses(source) {
  const out = [];
  // Every quoted or backticked run inside a className/class attribute. The template-literal
  // arm is the one that matters most here: this codebase writes most of its conditional
  // styling as `${cond ? 'a' : 'b'} bg-white/95 …`.
  const attrs = /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{\s*'([^']*)'\s*\}|\{\s*"([^"]*)"\s*\})/g;
  // Line starts, computed ONCE. Slicing the source per match is O(n^2) and took six seconds
  // on App.jsx alone — a guard slow enough to be noticed is a guard somebody moves out of
  // the fast job.
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  const lineAt = (idx) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  let m;
  while ((m = attrs.exec(source))) {
    const text = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '';
    const line = lineAt(m.index);
    for (const raw of text.split(/[\s`]+/)) {
      const tok = raw.trim();
      if (!tok || tok.includes('/') === false) continue;
      if (tok.includes('${') || tok.includes('{') || tok.includes('}')) continue;
      if (!SLASH_TOKEN.test(tok)) continue;
      out.push({ cls: tok, line });
    }
  }
  return out;
}

/**
 * PURE. Does this stylesheet define a rule for `cls`?
 *
 * Tailwind escapes the characters that are not selector-legal, so `bg-white/95` ships as
 * `.bg-white\/95` and `hover:bg-black/10` as `.hover\:bg-black\/10`. Match on the escaped
 * selector followed by a character that can legally end a class name in a selector — so
 * `bg-white/9` cannot be satisfied by the presence of `bg-white/95`.
 */
export function cssDefinesClass(css, cls) {
  const escaped = cls.replace(/[:/.]/g, (c) => `\\${c}`);
  // A class name in a selector ends at whitespace, a combinator, a comma, `{`, `:` (a
  // pseudo-class), `.`, `[`, `)` or the end of the sheet.
  const re = new RegExp(`\\.${escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,{:.\\[>+~)]|$)`);
  return re.test(css);
}

/**
 * PURE. The classes written in `files` that `css` never defines.
 * `files` is [{ path, text }]; returns [{ path, line, cls }] in source order.
 */
export function findUndefinedClasses(files, css) {
  const bad = [];
  const seen = new Set();
  for (const f of files) {
    for (const { cls, line } of findSlashClasses(f.text)) {
      if (cssDefinesClass(css, cls)) continue;
      const key = `${f.path}:${line}:${cls}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bad.push({ path: f.path, line, cls });
    }
  }
  return bad;
}

// ── the thin edge ────────────────────────────────────────────────────────────

function walk(dir, hits = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, hits);
    else if (/\.(jsx?|html)$/.test(name)) hits.push(full);
  }
  return hits;
}

function main() {
  const root = resolve(new URL('..', import.meta.url).pathname);
  const dist = resolve(process.argv[2] || join(root, 'dist'));

  let cssFiles;
  try {
    cssFiles = readdirSync(join(dist, 'assets')).filter((f) => f.endsWith('.css'));
  } catch {
    console.error(`✗ no built stylesheet under ${dist}/assets — run \`npm run build\` first.`);
    process.exit(1);
  }
  if (!cssFiles.length) {
    console.error(`✗ no .css in ${dist}/assets — run \`npm run build\` first.`);
    process.exit(1);
  }
  const css = cssFiles.map((f) => readFileSync(join(dist, 'assets', f), 'utf8')).join('\n');

  const files = walk(join(root, 'src')).map((p) => ({ path: relative(root, p), text: readFileSync(p, 'utf8') }));
  const total = files.reduce((n, f) => n + findSlashClasses(f.text).length, 0);
  const bad = findUndefinedClasses(files, css);

  if (bad.length) {
    console.error(`\n✗ ${bad.length} class${bad.length === 1 ? '' : 'es'} written in source but NOT in the shipped CSS:\n`);
    for (const b of bad) console.error(`   ${b.path}:${b.line}  ${b.cls}`);
    console.error(`
   Tailwind emits nothing for a modifier off its scale — the class is simply absent, with no
   error anywhere. An opacity modifier must be a multiple of 5 (bg-white/95, not bg-white/97)
   or an arbitrary value (bg-white/[.97]).\n`);
    process.exit(1);
  }

  console.log(`✓ tailwind classes — all ${total} slash-modifier classes across ${files.length} source files are defined in the shipped CSS.`);
}

// Only run when invoked directly; importing this from a test must not exit the process.
if (process.argv[1] && process.argv[1].endsWith('check-tailwind-classes.mjs')) main();
