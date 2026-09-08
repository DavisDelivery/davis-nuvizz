// EVERY OPACITY MODIFIER MUST BE ONE TAILWIND ACTUALLY GENERATES.
//
// Chad, on the Routing map Legend photographed over satellite imagery: "hard to see this
// work on the formatting and text colors." The text was fine. The PANEL had no background
// at all: it asked for `bg-white/97`, and 97 is not on Tailwind's opacity scale, so the
// class was never generated and the rule silently did not exist. Over the road map that
// reads as a slightly flat panel; over satellite it is unreadable — dark imagery straight
// through the words.
//
// This is the nastiest shape of styling bug in the codebase: it cannot be caught by reading
// the JSX (the class name looks perfectly reasonable), it throws no error, it breaks no
// build, and it only LOOKS wrong on one map base. A guard is the only thing that finds it.
//
// Tailwind 3's opacity scale is every multiple of 5 from 0 to 100. Anything else needs the
// arbitrary-value syntax (`bg-white/[0.97]`), which is allowed here and is checked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../src/', import.meta.url));

async function sourceFiles(dir = ROOT, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = dir + e.name;
    if (e.isDirectory()) await sourceFiles(full + '/', out);
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}

// A utility that takes an opacity modifier, then `/` and a bare number.
const OPACITY = /\b((?:bg|text|border|ring|ring-offset|divide|placeholder|outline|decoration|accent|caret|fill|stroke|shadow|from|via|to)-[a-z]+(?:-\d{2,3})?)\/(\d{1,3})\b/g;

// The changelog (VERSION_LOG in App.jsx) is PROSE ABOUT code, and it has to be able to name
// the very class this guard forbids — the v0.97.5 entry explains the bg-white/97 bug by name.
// Prose is not markup, so those lines are skipped; everything else in the file is scanned.
function withoutChangelog(src, file) {
  if (!/App\.jsx$/.test(file)) return src.split('\n');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith('const VERSION_LOG = ['));
  if (start < 0) return lines;
  let end = start;
  while (end < lines.length && lines[end] !== '];') end += 1;
  // Blank the range rather than removing it, so reported line numbers stay true.
  return lines.map((l, i) => (i > start && i < end ? '' : l));
}

test('no class asks for an opacity Tailwind will not generate', async () => {
  const files = await sourceFiles();
  const bad = [];
  for (const f of files) {
    const src = await readFile(f, 'utf8');
    withoutChangelog(src, f).forEach((line, i) => {
      for (const m of line.matchAll(OPACITY)) {
        const n = Number(m[2]);
        if (n % 5 === 0 && n >= 0 && n <= 100) continue;
        bad.push(`${f.replace(ROOT, 'src/')}:${i + 1}  ${m[0]}  (use /${Math.round(n / 5) * 5} or the arbitrary form /[0.${String(n).padStart(2, '0')}])`);
      }
    });
  }
  assert.deepEqual(bad, [], `these classes are never generated, so the rule silently does not apply:\n${bad.join('\n')}`);
});

test('the changelog may NAME the forbidden class without tripping the guard', () => {
  const fake = [
    'const VERSION_LOG = [',
    "  ['0.97.5', 'the panel asked for bg-white/97 and the class was never generated'],",
    '];',
    '<div className="bg-white/97" />',
  ].join('\n');
  const scanned = withoutChangelog(fake, '/x/App.jsx');
  const hits = scanned.flatMap((l) => [...l.matchAll(OPACITY)].map((m) => m[0]));
  assert.deepEqual(hits, ['bg-white/97'], 'only the real className should be seen, not the prose');
});

test('the guard catches the exact class that hid the Legend panel', () => {
  // Mutation check: the rule this file encodes must actually reject bg-white/97.
  const hits = [...'<div className="bg-white/97 border">'.matchAll(OPACITY)];
  assert.equal(hits.length, 1);
  assert.equal(hits[0][2], '97');
  assert.notEqual(Number(hits[0][2]) % 5, 0, 'bg-white/97 must be judged ungeneratable');
});

test('the ordinary opacities the app really uses still pass', () => {
  for (const cls of ['bg-white/95', 'bg-slate-900/90', 'bg-white/15', 'text-black/50', 'bg-blue-400/10']) {
    const [, , num] = [...cls.matchAll(OPACITY)][0];
    assert.equal(Number(num) % 5, 0, `${cls} should be accepted`);
  }
});
