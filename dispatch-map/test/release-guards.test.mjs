// test/release-guards.test.mjs
//
// The two guards that stand between "merged" and "Chad can actually see it".
//
// Both exist because of one morning. 2026-08-19: PRs #696 and #697 merged with APP_VERSION
// left at 0.55.0, and #697 was the last commit to reach production — so a deploy landed and
// the footer did not move. Then production stopped taking main altogether, and five more
// merges (v0.55.1 through .7) never went live while every check stayed green. Chad:
// "i've been on v0.55.0 all morning not once has it changed ... both of these need an
// exhaustively reviewed fix to keep from happening again."
//
// What these pin is mostly the QUIET direction — when each guard must NOT fire — because a
// guard that fires on normal gets switched off, and a switched-off guard protects nothing.
//
// PURE — no git, no network.
import test from 'node:test';
import assert from 'node:assert/strict';

import { shipsCode, versionOf, changelogVersions } from '../scripts/check-version-bump.mjs';
import { entryFromHtml, versionFromBundle, versionOf as liveVersionOf } from '../scripts/check-deploy-fresh.mjs';

// ── WHAT COUNTS AS A CHANGE THAT SHIPS ───────────────────────────────────────

test('code that reaches a user or a server requires a version', () => {
  for (const f of [
    'dispatch-map/src/App.jsx',
    'dispatch-map/src/lib/board-flags.js',
    'dispatch-map/netlify/functions/customer-comms-log.mts',
    'dispatch-map/netlify/functions/lib/nuvizz-list.mts',
    'dispatch-map/scripts/check-deploy-fresh.mjs',
    'load-scan/src/main.jsx',
    'dispatch-map/package.json',
    'netlify.toml',
  ]) {
    assert.equal(shipsCode([f]), true, f);
  }
});

test('THE QUIET DIRECTION: docs and tests do not demand a version', () => {
  // A guard that fires on a README edit is one somebody disables, and then it is not
  // guarding the thing it was built for.
  for (const f of [
    'CLAUDE.md',
    'README.md',
    'docs/HANDOFF.md',
    '.github/workflows/test.yml',
    'dispatch-map/test/customer-comms.test.mjs',
    'dispatch-map/test/release-guards.test.mjs',
  ]) {
    assert.equal(shipsCode([f]), false, f);
  }
  assert.equal(shipsCode([]), false, 'an empty change ships nothing');
});

test('one shipping file among docs still demands a version', () => {
  assert.equal(shipsCode(['README.md', 'dispatch-map/src/App.jsx']), true);
});

// ── READING THE VERSION AND THE CHANGELOG ────────────────────────────────────

const SRC = (v, rows) => `
const APP_VERSION = '${v}';
const CHANGELOG = [
${rows.map((r) => `  ['${r}', 'something happened'],`).join('\n')}
];`;

test('the version and its changelog rows are read out of the source', () => {
  const s = SRC('0.55.4', ['0.55.4', '0.55.3', '0.55.1']);
  assert.equal(versionOf(s), '0.55.4');
  assert.deepEqual(changelogVersions(s), ['0.55.4', '0.55.3', '0.55.1']);
});

test('THE REAL MISS: an unchanged version is detectable', () => {
  // #697 exactly: shipping code changed, APP_VERSION did not.
  const before = SRC('0.55.0', ['0.55.0']);
  const after = SRC('0.55.0', ['0.55.0']);
  assert.equal(versionOf(before), versionOf(after), 'this is the state that must fail CI');
});

test('a bump with no changelog row is half the job, and detectable', () => {
  const after = SRC('0.55.5', ['0.55.4', '0.55.3']);
  assert.equal(versionOf(after), '0.55.5');
  assert.ok(!changelogVersions(after).includes('0.55.5'),
    'the row is what Chad reads to find out what changed');
});

test('unreadable source yields null rather than a false pass', () => {
  for (const bad of ['', null, undefined, 'const APP_VERSION = 0.55.0;']) {
    assert.equal(versionOf(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(changelogVersions(''), []);
});

// ── READING WHAT THE SITE IS ACTUALLY SERVING ────────────────────────────────

test('the fingerprinted entry bundle is found whatever the attribute order', () => {
  assert.equal(entryFromHtml('<script type="module" crossorigin src="/assets/index-DOSL6JfK.js"></script>'),
    '/assets/index-DOSL6JfK.js');
  assert.equal(entryFromHtml("<script src='/assets/a.js' type='module'></script>"), '/assets/a.js');
});

test('no module script means UNKNOWN, never "stale"', () => {
  // A captive portal, an error page, or a dev server. Reporting these as a bad deploy is
  // how a watchdog earns its mute button.
  for (const html of ['', null, undefined, '<html><body>Gateway Timeout</body></html>',
                      '<script>var x=1</script>', '<script src="/legacy.js"></script>']) {
    assert.equal(entryFromHtml(html), null, JSON.stringify(String(html).slice(0, 30)));
  }
});

test('the version survives minification and is read back out of the bundle', () => {
  // What the real deployed bundle looks like: the name is gone, the changelog array's
  // newest row still leads with the version string.
  const minified = 'const q=[["0.55.4","THE ADDRESS IS LIVE…"],["0.55.3","…"]];';
  assert.equal(versionFromBundle(minified), '0.55.4');
});

test('a bundle with no version string is UNKNOWN, never "stale"', () => {
  for (const js of ['', null, undefined, 'console.log("hello")', 'const v=["not-a-version","x"]']) {
    assert.equal(versionFromBundle(js), null, JSON.stringify(String(js).slice(0, 30)));
  }
});

test('both guards read APP_VERSION the same way', () => {
  // They compare the same number from two sides — source and deployed bundle. If these two
  // readers ever disagreed the comparison would be meaningless.
  const s = SRC('0.55.7', ['0.55.7']);
  assert.equal(versionOf(s), liveVersionOf(s));
});
