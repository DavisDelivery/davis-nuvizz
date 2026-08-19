#!/usr/bin/env node
// Fail a PR that changes the app but leaves APP_VERSION alone.
//
// WHY THIS EXISTS. CLAUDE.md has said since this morning that "APP_VERSION MUST be bumped
// in every change that gets merged", with a changelog row in the same edit. It is written
// down and it is still not happening: on 2026-08-19, PRs #696 and #697 both merged with
// APP_VERSION left at 0.55.0. #697 was the LAST commit to reach production that day, so
// Chad got a deploy notification and watched the footer version stay exactly where it was
// — the precise failure the rule exists to prevent, caused by the rule being advice.
//
// Chad: "i told you to put in the claude.md that every merge should carry a new version
// and that still is not occurring."
//
// A rule a tired agent can skip is not a rule. This turns it into a test.
//
//   node scripts/check-version-bump.mjs <baseRef>
//
// Compares APP_VERSION and the changelog array in dispatch-map/src/App.jsx against the
// merge base. Exits non-zero with a plain explanation when the bump or the row is missing.
//
// DELIBERATELY NARROW — it only fires when the PR actually touched shipping code. A
// docs-only or test-only branch has nothing to announce and is not made to invent a
// version, because a guard that cries on changes it should not care about gets switched
// off, and then it is protecting nothing.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// maxBuffer: App.jsx is over a megabyte, and execFileSync defaults to a 1MB pipe — so
// `git show HEAD:…App.jsx` dies with ENOBUFS and the guard fails every PR for a reason
// that has nothing to do with versions. Found by running it against real history.
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const APP = 'dispatch-map/src/App.jsx';

/** Files this PR touches, relative to the repo root. */
function changedFiles(baseRef) {
  return git('diff', '--name-only', `${baseRef}...HEAD`).split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Does this change ship anything a user could see or a server could run? */
export function shipsCode(files) {
  return files.some((f) => (
    /^dispatch-map\/(src|netlify|scripts)\//.test(f)
    || /^load-scan\/(src|netlify)\//.test(f)
    || /^dispatch-map\/(package|package-lock)\.json$/.test(f)
    || /^netlify\.toml$/.test(f)
  ) && !/\.test\.mjs$/.test(f));
}

export function versionOf(source) {
  const m = /const APP_VERSION = '([^']+)'/.exec(String(source || ''));
  return m ? m[1] : null;
}

/** Every version string that heads a changelog row, so a bump without a row is caught. */
export function changelogVersions(source) {
  return [...String(source || '').matchAll(/\n\s*\['(\d+\.\d+\.\d+)',/g)].map((m) => m[1]);
}

// The CLI. Behind a direct-execution guard so the helpers above can be imported by the
// test suite — a release guard that cannot itself be tested is an odd thing to trust.
function main() {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: check-version-bump.mjs <baseRef>');
    process.exit(2);
  }

  const files = changedFiles(base);
  if (!files.includes(APP) && !shipsCode(files)) {
    console.log('✓ no shipping code changed — no version bump required');
    process.exit(0);
  }

  const before = (() => { try { return git('show', `${base}:${APP}`); } catch { return ''; } })();
  const after = git('show', `HEAD:${APP}`);

  const wasV = versionOf(before);
  const nowV = versionOf(after);

  if (!nowV) {
    console.error('✗ APP_VERSION not found in ' + APP);
    process.exit(1);
  }

  if (wasV && wasV === nowV) {
    console.error(`✗ APP_VERSION is still ${nowV}.`);
    console.error('');
    console.error('  This change ships code, so it produces a deploy — and a deploy whose');
    console.error('  version did not move is indistinguishable from no deploy at all. That is');
    console.error('  exactly what happened on 2026-08-19 (#696, #697): the build changed, the');
    console.error('  footer did not, and there was no way to tell a stale cached page from a');
    console.error('  fresh one.');
    console.error('');
    console.error('  Bump APP_VERSION in ' + APP + ' (patch for ordinary work, minor for a new');
    console.error('  capability) and add a changelog row in the same edit, newest first.');
    console.error('  Check origin/main FIRST — parallel branches collide on the same number.');
    process.exit(1);
  }

  // A bump with no changelog row is half the job: the row is what Chad reads to find out
  // what actually changed.
  if (!changelogVersions(after).includes(nowV)) {
    console.error(`✗ APP_VERSION is ${nowV} but no changelog row starts with '${nowV}'.`);
    console.error('  Add the row directly below APP_VERSION, newest first — a bump with no row');
    console.error('  tells Chad the version moved and nothing about why.');
    process.exit(1);
  }

  console.log(`✓ APP_VERSION ${wasV || '(new)'} → ${nowV}, with a changelog row`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
