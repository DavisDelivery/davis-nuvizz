// test/manual-scan-background.test.mjs — the "Scan now" button's background endpoint.
//
// Chad, Jul 31: "Scan refused (HTTP 504)". The v0.54.19 fallback ran the WHOLE scan inside a
// synchronous Netlify function; the scheduled writer's own header has said since M5.2 that the
// scan is >22s and 502s past the 26s request cap. Light board → the button worked; real
// morning → gateway timeout. These pin the three properties that make the replacement safe,
// each of which failing would recreate a bug this repo has already shipped:
//   1. NO cron schedule — a schedule makes the function SCHEDULED and not HTTP-invocable
//      (the Jul 29 404/405 breakage);
//   2. the filename's '-background' suffix — that suffix IS the 202 + 15-minute budget; lose
//      it and the scan is back inside the 26s window (the Jul 31 504);
//   3. ?date=/?days= are DISCARDED, manual=1 forced — a date flips runRefreshStops into the
//      ~3,000-NuVizz-call number-probe path (the CLAUDE.md hard rule).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NUVIZZ_BASE_URL ??= '';
import * as fn from '../netlify/functions/nuvizz-manual-scan-background.mts';

test('no cron schedule — a schedule would make it un-invocable over HTTP (the Jul 29 breakage)', () => {
  assert.equal(fn.config?.schedule, undefined, 'adding config.schedule here re-breaks the Scan now button');
});

test('the inner scan URL is manual list-discovery ONLY — date/days can never ride through', () => {
  const base = 'https://x.netlify.app/.netlify/functions/nuvizz-manual-scan-background';
  assert.equal(fn.manualScanUrl(base), base + '?manual=1');
  // The trap: a caller (or a copied curl) passing ?date= must NOT reach the ~3,000-call
  // number-probe path. Everything but manual=1 is discarded, not forwarded.
  const probed = fn.manualScanUrl(base + '?date=2026-07-31&days=3&manual=0&extra=x');
  assert.equal(probed, base + '?manual=1');
  assert.ok(!/date=|days=/.test(probed), 'the number-probe params are structurally unreachable');
});

test("the '-background' suffix is present — it IS the 15-minute budget", () => {
  // Netlify keys background execution off the function NAME. A rename that drops the suffix
  // silently puts the scan back inside the 26s synchronous window.
  const url = new URL(import.meta.resolve('../netlify/functions/nuvizz-manual-scan-background.mts'));
  assert.ok(url.pathname.endsWith('-background.mts'));
});
