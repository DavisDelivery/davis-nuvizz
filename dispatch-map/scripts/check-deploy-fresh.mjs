#!/usr/bin/env node
// Is the live site actually running what main says it should be?
//
// WHY THIS EXISTS. On 2026-08-19 main moved five times between 10:08 and 11:32 — v0.55.1,
// .3, .4, .6, .7 — and production stayed on v0.55.0 from 09:51 the whole morning. Nothing
// anywhere said so. Every merge reported success, every PR went green, the deploy previews
// built fine, and the footer Chad checks sat unchanged for hours while he was told the
// build had changed.
//
// Chad: "i've been on v0.55.0 all morning not once has it changed ... both of these need
// an exhaustively reviewed fix to keep from happening again."
//
// The in-app reload banner was NOT broken during this, and that is the point worth
// understanding: it compares the running bundle against the deployed one, both were
// v0.55.0, so it correctly stayed quiet. It can only ever report "your TAB is behind the
// SITE". Nothing was watching for "the SITE is behind MAIN", which is the failure that
// actually happened — and the one nobody can see from inside the app.
//
//   node scripts/check-deploy-fresh.mjs [url]
//
// Fetches the deployed index.html, follows it to the fingerprinted entry bundle, reads the
// APP_VERSION baked into it, and compares against main's. Exits non-zero when they differ.
//
// Fails LOUD on a mismatch and QUIET on "could not tell": an unreachable site is not
// evidence of a stale deploy, and a watchdog that cries on every network blip gets muted —
// at which point it is not watching anything.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SITE = process.argv[2] || process.env.DEPLOY_URL || 'https://dd-dispatch-map.netlify.app';
const APP = new URL('../src/App.jsx', import.meta.url);

// A merge that landed two minutes ago is SUPPOSED to be ahead of the site — the build
// takes a minute or so. Failing during that window would make this watchdog cry on every
// normal deploy, and a watchdog that cries on normal is one nobody looks at. Judge only
// once the newest commit has had time to ship.
const GRACE_MIN = Number(process.env.DEPLOY_GRACE_MINUTES || 20);

/** Minutes since the checked-out HEAD was committed, or null if git cannot say. */
export function headAgeMinutes(now = Date.now()) {
  try {
    const ts = execFileSync('git', ['log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim();
    const secs = Number(ts);
    return Number.isFinite(secs) && secs > 0 ? (now - secs * 1000) / 60000 : null;
  } catch { return null; }
}

export function versionOf(source) {
  const m = /const APP_VERSION = '([^']+)'/.exec(String(source || ''));
  return m ? m[1] : null;
}

/** The fingerprinted ES-module entry from a built index.html. */
export function entryFromHtml(html) {
  for (const tag of String(html || '').match(/<script\b[^>]*>/gi) || []) {
    if (!/type\s*=\s*["']module["']/i.test(tag)) continue;
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src?.[1]) return src[1];
  }
  return null;
}

/** APP_VERSION as the MINIFIED bundle carries it — the name is gone, the string is not. */
export function versionFromBundle(js) {
  const s = String(js || '');
  // The changelog array's newest row leads with the same version the footer prints, and it
  // survives minification as a plain string literal at the head of an array literal.
  const row = /\[\s*"(\d+\.\d+\.\d+)"\s*,/.exec(s);
  return row ? row[1] : null;
}

// The CLI. Behind a direct-execution guard so the readers above can be imported by the
// test suite without firing a network check.
async function main() {
  const expected = versionOf(readFileSync(APP, 'utf8'));
  if (!expected) {
    console.error('✗ could not read APP_VERSION out of src/App.jsx');
    process.exit(2);
  }

  const get = async (url) => {
    const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.text();
  };

  let live = null;
  try {
    const html = await get(`${SITE}/?cachebust=${Date.now()}`);
    const entry = entryFromHtml(html);
    if (!entry) throw new Error('no module script in index.html');
    live = versionFromBundle(await get(new URL(entry, SITE).href));
    if (!live) throw new Error('no version string in the deployed bundle');
  } catch (e) {
    // "Could not check" is not "the deploy is stale". Say so and pass.
    console.log(`? could not read the live version (${e.message}) — not treating that as stale`);
    process.exit(0);
  }

  if (live === expected) {
    console.log(`✓ ${SITE} is serving v${live}, which is what main says`);
    process.exit(0);
  }

  const age = headAgeMinutes();
  if (age !== null && age < GRACE_MIN) {
    console.log(`? ${SITE} is on v${live}, main is v${expected}, but main's newest commit is only `
      + `${Math.round(age)} min old — inside the ${GRACE_MIN} min deploy window, so not calling it stale yet.`);
    process.exit(0);
  }

  console.error(`✗ DEPLOY IS BEHIND MAIN — ${SITE} is serving v${live}, main is at v${expected}.`);
  console.error('');
  console.error('  Merging is not shipping. Every check on those merges was green and the site');
  console.error('  kept serving the old build anyway, which is invisible from inside the app:');
  console.error('  the reload banner compares your TAB against the SITE, so when the SITE is');
  console.error('  the stale thing it has nothing to report.');
  console.error('');
  console.error('  Check the project\'s deploy list first — if builds are running but not going');
  console.error('  live, auto-publishing is stopped; if no build was started for the newest');
  console.error('  commit, the git trigger is the problem, not the build.');
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
