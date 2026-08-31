// test/manifest-rows-viewer.test.mjs
//
// CAN THE DISPATCHER TELL WHETHER HE IS LOOKING AT THE WHOLE MANIFEST?
//
// Chad: "I'm not able to view the entire manifest also I want a way to see the ones not on
// there also." The Rows viewer answered the readability half. It left the completeness half
// unanswerable, and that is the more dangerous half: a parse that reads eleven of thirteen
// pages renders "648 orders", labels itself 648, and is indistinguishable on screen from a
// parse that read all thirteen. Nothing in the list disagrees with a short list.
//
// The manifest prints its own FINAL TOTALS and readUlineManifest reconciles against them --
// it returns verified:true only for a column assignment that reproduces the printed count,
// lbs, skids and pieces (uline-manifest.mts:167-172). That is the ONE independent check that
// exists. The endpoint has been sending it since the viewer shipped and the screen ignored it.
//
// These pin the endpoint's contract and the screen's use of it. The endpoint itself is a
// Netlify handler over Firestore + blobs, so the response SHAPE is asserted from source: the
// failure being guarded is a field that is sent and never read, or read and never sent, and
// both of those are visible in the text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const API = readFileSync(new URL('../netlify/functions/manifest-history.mts', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

/** The ?rows=1 branch of the endpoint, which is the only part this screen talks to. */
const ROWS_BRANCH = API.slice(API.indexOf("url.searchParams.get('rows') === '1'"), API.indexOf('// ── one night, in full'));
/** The modal, bounded by the next top-level function. */
const MODAL = (() => {
  const i = APP.indexOf('function ManifestRowsModal(');
  return APP.slice(i, APP.indexOf('\nfunction ', i + 10));
})();

// ── THE CHECKSUM ─────────────────────────────────────────────────────────────

test('THE SCREEN SHOWS WHETHER THE PARSE RECONCILED, because a row count cannot check itself', () => {
  assert.match(ROWS_BRANCH, /verified: !!parsed\.verified/, 'the endpoint sends the checksum');
  assert.match(ROWS_BRANCH, /totals: parsed\.totals \?\? null/, 'and the printed totals behind it');
  assert.match(MODAL, /d\.verified \?/, 'and the screen branches on it rather than ignoring it');
  assert.match(MODAL, /orders accounted for/, 'a reconciled manifest says so');
  assert.match(MODAL, /could NOT be checked against/, 'and one that did not says THAT, in the honest direction');
});

test('the parser’s own complaints reach the screen', () => {
  // readUlineManifest pushes warnings for a missing FINAL TOTALS line and for duplicate PROs.
  // They were computed on every read and dropped at the endpoint, so the one place that could
  // have explained an unverified manifest said nothing.
  assert.match(ROWS_BRANCH, /warnings: Array\.isArray\(parsed\.warnings\)/, 'the endpoint returns them');
  assert.match(MODAL, /Array\.isArray\(d\.warnings\) && d\.warnings\.length/, 'and the screen renders them');
});

test('the checksum strip is mounted, not merely defined', () => {
  // A component built and never placed is the quietest way to ship nothing.
  assert.match(MODAL, /const Totals = /);
  assert.match(MODAL, /\{Controls\}\s*\n\s*\{Totals\}\s*\n\s*\{Legend\}/,
    'it sits above the highlight legend, where the count it qualifies is');
});

// ── A NIGHT WITH NO STORED PDF ───────────────────────────────────────────────

test('A NIGHT WHOSE PDF WAS NOT KEPT MUST NOT RENDER THE WORD "undefined"', () => {
  // The header interpolates `${d.orders} orders`. Both early returns omitted `orders`, so the
  // subtitle read "undefined orders · 0 not on the board" -- which reads as a broken app
  // rather than as the honest "we did not keep this night's PDF" printed underneath it.
  const earlies = ROWS_BRANCH.match(/return J\(\{ ok: true, date: one, found: true, rows: \[\][^)]*\)/g) || [];
  assert.ok(earlies.length >= 2, `both no-PDF paths are present (found ${earlies.length})`);
  for (const e of earlies) {
    assert.match(e, /orders: 0/, `this path must carry a count: ${e}`);
    assert.match(e, /offBoardCount: 0/, `and an off-board count: ${e}`);
  }
  // Belt and braces on the screen, since a stored response from before this change has neither.
  assert.match(MODAL, /d\.orders \?\? 0/, 'the header defaults rather than printing undefined');
});

// ── THE COUNT THAT DISAGREES WITHOUT ANYTHING BEING WRONG ────────────────────

test('A CAPPED NIGHT IS NOT A CONTRADICTION, and must stop being reported as one', () => {
  // archiveManifest stores at most MAX_MISSING_ROWS suspects but keeps the true count beside
  // them, so on a capped night BOTH numbers are correct and only the highlight is short. The
  // banner called one of them wrong and pointed at the short side as the truth.
  assert.match(ROWS_BRANCH, /missingTruncated: !!l\.missingTruncated/, 'the endpoint passes the flag through');
  assert.match(MODAL, /d\.missingTruncated/, 'and the screen distinguishes the two cases');
  assert.match(MODAL, /so only those are highlighted here/, 'a cap explains itself');
  assert.match(MODAL, /One of those is wrong/, 'a genuine disagreement still says so');
});

test('the truncation flag is no longer written and never read', () => {
  // It has been recorded since the cap existed and consumed by nothing outside a test, which
  // is why the screen had no way to tell the two cases apart.
  const ARCHIVE = readFileSync(new URL('../netlify/functions/lib/manifest-archive.mts', import.meta.url), 'utf8');
  assert.match(ARCHIVE, /missingTruncated: missing\.length > MAX_MISSING_ROWS/, 'still written');
  assert.match(ROWS_BRANCH, /missingTruncated/, 'and now read on the way out');
});

// ── THE BODY ON A PHONE ──────────────────────────────────────────────────────

test('the 660-row body is not pretty-printed, and carries only what the screen draws', () => {
  // Served no-store, so it is re-fetched in full on every open -- on a phone, on cellular.
  assert.ok(!/JSON\.stringify\(b, null, 1\)/.test(API), 'one space per line across ~660 rows is not free');
  assert.match(API, /JSON\.stringify\(b\)/);
  for (const f of ['via', 'whs', 'shipDate']) {
    assert.ok(!new RegExp(`\\b${f}: r\\?\\.`).test(ROWS_BRANCH), `${f} is parsed but never rendered here`);
  }
});

test('EVERY FIELD THE ROW CARD DRAWS IS STILL SENT', () => {
  // The counterpart to trimming, and the reason it is a test: `state` is rendered in both the
  // phone card and the desktop table, and dropping it would have blanked the ST column on the
  // desktop view while leaving the phone looking fine. Two views, two ways to miss it.
  // Field READS only. A bare /r\.\w+/ also catches `r.json()` in the fetch callback, where `r`
  // is a Response -- and a check that measures the wrong thing is worse than no check, because
  // it fails confidently. Anything followed by `(` is a method call, not a manifest column.
  // The lookahead must also reject a LETTER, or the engine simply backtracks: on `r.json()` it
  // gives up "json", tries "jso", sees "n" is not "(" and reports a field called `jso`. A guard
  // that can be satisfied by shortening its own match is not a guard.
  const drawn = new Set([...MODAL.matchAll(/\br\.([a-zA-Z]+)(?![a-zA-Z]|\s*\()/g)].map((m) => m[1]));
  drawn.delete('offBoard');   // computed by the endpoint, asserted separately below
  for (const f of drawn) {
    assert.match(ROWS_BRANCH, new RegExp(`\\b${f}:`), `the row card draws r.${f}, so the endpoint must send it`);
  }
  assert.ok(drawn.has('state'), 'sanity: the ST column is in the set this test protects');
  assert.match(ROWS_BRANCH, /offBoard: proKeys\(r\?\.pro\)\.some/, 'and the highlight is still computed');
});
