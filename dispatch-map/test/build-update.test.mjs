import test from 'node:test';
import assert from 'node:assert/strict';
import { entryScriptFromHtml, isNewBuild } from '../src/lib/build-update.js';

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
