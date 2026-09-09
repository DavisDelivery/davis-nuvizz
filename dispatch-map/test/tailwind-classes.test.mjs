// test/tailwind-classes.test.mjs
//
// The guard behind scripts/check-tailwind-classes.mjs. A release guard that cannot itself be
// tested is an odd thing to trust, and this one was written for a bug that every other check
// in this repo was structurally unable to see:
//
//   Chad, on a phone screenshot of the Routing map legend: "you can't see this[,] formatting
//   and colors are bad and i've already made you aware but wasn't fixed."
//
//   The panel was `bg-white/97`. Tailwind 3.4's opacity scale is 0-100 in steps of FIVE, so
//   `97` matches nothing and Tailwind emits NO RULE — silently. The panel had no background
//   at all; `backdrop-blur` was the only thing left, which is why the shot shows blurred
//   satellite imagery where a white sheet should be. Every check was green.
//
// Each test is named for the failure it prevents.

import test from 'node:test';
import assert from 'node:assert/strict';
import { findSlashClasses, cssDefinesClass, findUndefinedClasses } from '../scripts/check-tailwind-classes.mjs';

// The real markup, before and after. Line 16615 of src/App.jsx.
const BROKEN = '<div className="w-64 max-w-[calc(100vw-1.5rem)] max-h-[58vh] overflow-y-auto bg-white/97 backdrop-blur border border-slate-200 rounded-lg shadow-lg p-3">';
const FIXED = '<div className="w-64 max-w-[calc(100vw-1.5rem)] max-h-[58vh] overflow-y-auto bg-white/95 backdrop-blur border border-slate-300 rounded-lg shadow-xl p-3">';
// What Tailwind 3.4.4 actually emitted for that build, verbatim in shape.
const CSS = `.bg-white\\/15{background-color:rgb(255 255 255/.15)}.bg-white\\/95{background-color:rgb(255 255 255/.95)}.w-1\\/2{width:50%}.top-1\\/2{top:50%}.hover\\:bg-black\\/10:hover{background-color:rgb(0 0 0/.1)}`;

test('the legend panel bug: bg-white/97 is reported as undefined, bg-white/95 is not', () => {
  const bad = findUndefinedClasses([{ path: 'src/App.jsx', text: BROKEN }], CSS);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].cls, 'bg-white/97');
  assert.equal(findUndefinedClasses([{ path: 'src/App.jsx', text: FIXED }], CSS).length, 0);
});

test('a guard that cannot fail is not a guard: it reports the FILE and LINE, not just a count', () => {
  const text = ['<a className="x" />', '<b className="y" />', BROKEN].join('\n');
  const bad = findUndefinedClasses([{ path: 'src/App.jsx', text }], CSS);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, 'src/App.jsx');
  assert.equal(bad[0].line, 3, 'the line the class is written on, so it can be fixed without hunting');
});

test('layout fractions are classes too — w-1/2 and top-1/2 must not be mistaken for opacity', () => {
  const bad = findUndefinedClasses([{ path: 'f.jsx', text: '<div className="w-1/2 top-1/2" />' }], CSS);
  assert.deepEqual(bad, [], 'both are in the sheet, so both pass');
  // And one that is NOT in the sheet is still caught, whatever kind of utility it is.
  assert.equal(findUndefinedClasses([{ path: 'f.jsx', text: '<div className="w-1/7" />' }], CSS).length, 1);
});

test('a variant prefix is escaped the way Tailwind escapes it (hover\\:bg-black\\/10)', () => {
  assert.equal(cssDefinesClass(CSS, 'hover:bg-black/10'), true);
  assert.equal(cssDefinesClass(CSS, 'hover:bg-black/15'), false);
});

test('a prefix of a real class is not a match: bg-white/9 must not be satisfied by bg-white/95', () => {
  assert.equal(cssDefinesClass(CSS, 'bg-white/9'), false, 'this is the whole point — /9, /97 and /95 differ by one character');
  assert.equal(cssDefinesClass(CSS, 'bg-white/1'), false);
  assert.equal(cssDefinesClass(CSS, 'bg-white/15'), true);
});

test('template literals are read — this app writes most of its conditional styling that way', () => {
  const text = '<div className={`flex ${on ? "a" : "b"} bg-white/97 p-2`} />';
  const found = findSlashClasses(text).map((h) => h.cls);
    assert.deepEqual(found, ['bg-white/97']);
});

test('a class assembled at runtime is not asserted on — it is a value, not a literal', () => {
  // `bg-${tone}/50` cannot be resolved from source and must not be reported as missing.
  assert.deepEqual(findSlashClasses('<div className={`bg-${tone}/50`} />'), []);
});

test('arbitrary values are deliberately out of scope, not silently mis-flagged', () => {
  // max-w-[calc(100vw-1.5rem)] sits on the very line the bug was on; flagging it would make
  // the guard cry on healthy code, which is how a guard gets switched off.
  assert.deepEqual(findSlashClasses('<div className="max-w-[calc(100vw-1.5rem)] w-[calc(100%/3)]" />'), []);
});

test('non-class slashes in the file are ignored (a URL, a date, a comment)', () => {
  const text = `
    // see https://tailwindcss.com/docs/background-color — updated 9/5
    <img src="/logo.svg" alt="" />
    <div className="p-2" />
  `;
  assert.deepEqual(findSlashClasses(text), []);
});

test('THE LIVE SOURCE carries no class the scale would drop', async () => {
  // Not a duplicate of the CI script: this pins the property with no build in the room, so a
  // PR that reintroduces an off-scale modifier fails in the fast `unit` job too.
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (d, out = []) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f, out);
      else if (/\.jsx?$/.test(n)) out.push(f);
    }
    return out;
  };
  const src = new URL('../src', import.meta.url).pathname;
  const offScale = [];
  for (const f of walk(src)) {
    for (const { cls, line } of findSlashClasses(readFileSync(f, 'utf8'))) {
      // Fractions (w-1/2) have a numerator; opacity modifiers do not. Only check the ones
      // whose utility is a colour-ish one carrying a bare numeric modifier.
      const mod = Number(cls.split('/').pop());
      const isFraction = /-\d+\/\d+$/.test(cls);
      if (isFraction) continue;
      if (!Number.isInteger(mod) || mod % 5 !== 0 || mod < 0 || mod > 100) {
        offScale.push(`${f.replace(src, 'src')}:${line} ${cls}`);
      }
    }
  }
  assert.deepEqual(offScale, [], 'opacity modifiers must be a multiple of 5, or an arbitrary value like bg-white/[.97]');
});
