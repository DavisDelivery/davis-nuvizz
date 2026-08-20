import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  entryScriptFromHtml, isNewBuild, headlineFromEntry, isNewerVersion, HEADLINE_MAX,
} from '../src/lib/build-update.js';
import { changelogEntryFor } from '../scripts/emit-version-json.mjs';

// Chad, 7/27: "No where to put notes on this order on desktop why do you keep wasting my
// time". The note composer shipped 07-24 in v0.52.0 and the live site was serving it; his
// tab had been open since 07-23 and was still running v0.50.77. These guard the check that
// now catches exactly that.

// ── entryScriptFromHtml ──────────────────────────────────────────────────────

test('entryScriptFromHtml: pulls the Vite entry bundle out of a real index.html', () => {
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="/assets/index-abc123.css">
    <script type="module" crossorigin src="/assets/index-DwYEshK0.js"></script>
    </head><body><div id="root"></div></body></html>`;
  assert.equal(entryScriptFromHtml(html), '/assets/index-DwYEshK0.js');
});

test('entryScriptFromHtml: src before type still matches (attribute order varies)', () => {
  const html = `<script src="/assets/index-XYZ.js" type="module"></script>`;
  assert.equal(entryScriptFromHtml(html), '/assets/index-XYZ.js');
});

test('entryScriptFromHtml: skips non-module scripts and inline analytics', () => {
  const html = `<script>window.dataLayer=[];</script>
    <script src="/legacy-polyfill.js"></script>
    <script type="module" src="/assets/index-REAL.js"></script>`;
  assert.equal(entryScriptFromHtml(html), '/assets/index-REAL.js');
});

test('entryScriptFromHtml: no module script → null, never a guess', () => {
  assert.equal(entryScriptFromHtml('<html><body>Offline</body></html>'), null);
  assert.equal(entryScriptFromHtml('<script type="module">import "/x.js"</script>'), null);
  for (const v of ['', null, undefined, 42, {}]) assert.equal(entryScriptFromHtml(v), null);
});

// ── isNewBuild ───────────────────────────────────────────────────────────────

test('isNewBuild: a different fingerprint is a new build', () => {
  assert.equal(isNewBuild('/assets/index-OLD123.js', '/assets/index-NEW456.js'), true);
});

test('isNewBuild: the same fingerprint is not', () => {
  assert.equal(isNewBuild('/assets/index-SAME.js', '/assets/index-SAME.js'), false);
});

test('isNewBuild: origin differences alone never count as an update', () => {
  // The running script reports an absolute URL; index.html carries a relative path. Same
  // build. Nagging a dispatcher to reload mid-plan over this would be its own bug.
  assert.equal(isNewBuild('https://dd-dispatch-map.netlify.app/assets/index-A.js', '/assets/index-A.js'), false);
  assert.equal(isNewBuild('https://deploy-preview-542--dd-dispatch-map.netlify.app/assets/index-A.js', '/assets/index-A.js'), false);
});

test('isNewBuild: query strings and hashes are ignored', () => {
  assert.equal(isNewBuild('/assets/index-A.js?t=1', '/assets/index-A.js'), false);
  assert.equal(isNewBuild('/assets/index-A.js#x', '/assets/index-A.js?v=2'), false);
});

test('isNewBuild: unknown on either side is never an update', () => {
  // A failed fetch, an offline captive portal, or the dev server (no hashed entry) must
  // stay silent rather than show a Reload prompt that would accomplish nothing.
  assert.equal(isNewBuild(null, '/assets/index-A.js'), false);
  assert.equal(isNewBuild('/assets/index-A.js', null), false);
  assert.equal(isNewBuild(null, null), false);
  assert.equal(isNewBuild('', ''), false);
});

test('isNewBuild: the real 7/23 → 7/27 case reports an update', () => {
  assert.equal(isNewBuild('/assets/index-152a8c9OLD.js', '/assets/index-DwYEshK0.js'), true);
});

// ── WHAT changed, not just THAT something changed ────────────────────────────
//
// Chad, on the blue bar: "Can we start including a simple set of details of what changed in
// the new version." The bar compares bundle fingerprints and is content-blind by design, so
// the detail rides in on /version.json — the deployed version plus the first sentence of its
// changelog row, emitted at build time.

test('headlineFromEntry: takes the opening sentence, which is where the summary already is', () => {
  assert.equal(
    headlineFromEntry('THE TOP CARD WAS SWALLOWING THE ADVISORY COUNT. Chad, with the panel open: "put the advisory flag numbers on the top card as well."'),
    'THE TOP CARD WAS SWALLOWING THE ADVISORY COUNT.',
  );
});

test('headlineFromEntry: a version number mid-sentence does not cut it short', () => {
  // "v0.54.2." is full of full stops and none of them end the sentence.
  const out = headlineFromEntry('The guard added in v0.54.2. was never wired to CI. A second sentence.');
  assert.equal(out, 'The guard added in v0.54.2. was never wired to CI.');
});

test('headlineFromEntry: a single-sentence entry with no terminator still yields a headline', () => {
  assert.equal(headlineFromEntry('Appointment windows are advisory (flag, do not spill)'),
    'Appointment windows are advisory (flag, do not spill)');
});

test('headlineFromEntry: a runaway opening sentence is trimmed on a word boundary', () => {
  const long = `${'word '.repeat(80)}end. Next.`;
  const out = headlineFromEntry(long);
  assert.ok(out.length <= HEADLINE_MAX, `got ${out.length}`);
  assert.ok(out.endsWith('…'), 'trimmed, and visibly so');
  assert.ok(!/\s…$/.test(out), 'no dangling space before the ellipsis');
});

test('headlineFromEntry: nothing usable reads as null, so the bar falls back to plain', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) assert.equal(headlineFromEntry(bad), null);
});

test('isNewerVersion: only a genuinely higher version captions the bar', () => {
  assert.equal(isNewerVersion('0.66.1', '0.66.2'), true);
  assert.equal(isNewerVersion('0.66.1', '0.67.0'), true);
  assert.equal(isNewerVersion('0.66.1', '1.0.0'), true);
  // A rollback, a stale CDN edge or a preview alias must NOT caption the bar with a version
  // older than the one this tab is already running.
  assert.equal(isNewerVersion('0.66.2', '0.66.1'), false);
  assert.equal(isNewerVersion('0.66.1', '0.66.1'), false, 'same version is not news');
  assert.equal(isNewerVersion('0.9.0', '0.10.0'), true, 'numeric, not lexicographic');
});

test('isNewerVersion: anything unparseable answers false rather than guessing', () => {
  for (const [a, b] of [['0.66.1', 'next'], ['', '0.66.2'], ['0.66', '0.67'], ['0.66.1', '0.66.x'],
    [null, '1.0.0'], ['1.0.0', undefined], ['0.66.1', '0.66.-1']]) {
    assert.equal(isNewerVersion(a, b), false, `${a} → ${b}`);
  }
});

// ── the emitter reads the real App.jsx ───────────────────────────────────────

test('changelogEntryFor: pulls the row for a version out of a source that is full of quotes', () => {
  const src = `const APP_VERSION = '0.66.2';
const CHANGELOG = [
  ['0.66.2', 'RATCHET. Chad: "that doesn\\'t work for me". Done.'],
  ['0.66.1', 'EARLIER THING. Another sentence.'],
];`;
  assert.equal(changelogEntryFor(src, '0.66.2'), 'RATCHET. Chad: "that doesn\'t work for me". Done.');
  assert.equal(changelogEntryFor(src, '0.66.1'), 'EARLIER THING. Another sentence.');
  assert.equal(changelogEntryFor(src, '9.9.9'), null, 'a version with no row yields nothing');
});

test('THE REAL FILE: the shipped App.jsx yields a headline for its own APP_VERSION', () => {
  // The emitter runs at build time and a silent failure would ship a bar with no detail —
  // exactly the thing Chad asked to fix — so this pins it against the actual source.
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const version = src.match(/const APP_VERSION = '([^']+)'/)?.[1];
  assert.ok(version, 'APP_VERSION is readable');
  const entry = changelogEntryFor(src, version);
  assert.ok(entry, `a changelog row exists for ${version}`);
  const headline = headlineFromEntry(entry);
  assert.ok(headline && headline.length > 10, 'and it produces a real headline');
  assert.ok(headline.length <= HEADLINE_MAX);
});
