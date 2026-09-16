#!/usr/bin/env node
// scripts/rollback.mjs — put the app back to how it was at a moment in time.
//
// WHY THIS EXISTS.
//
// Chad, 2026-09-15, after a day of merges: "changes in the app today caused major bugs with
// the routing tab that was working perfectly before updates today[,] it introduced at least
// 10-15 bugs that i'm still working through … i want to build something where i can roll the
// app back if this were to happen again. Like i would like to roll the app back to 11:59 pm
// sept 14th when things were working perfectly."
//
// THE OPERATIONAL PROBLEM, not the git one. At 6:45am the dispatch board is the thing
// standing between drivers and the dock, and the question is never "which SHA". It is "put it
// back to Sunday night". Every second spent translating a wall-clock time into a commit is a
// second a dispatcher is looking at a broken screen — so this takes the wall clock, in CHAD'S
// timezone (America/New_York, NOT UTC — the difference is four hours and on a late-evening
// merge it picks the wrong day), and does the translating.
//
// WHAT IT DOES, and the shape is deliberate:
//
//   node scripts/rollback.mjs --list                    what shipped, when, in plain English
//   node scripts/rollback.mjs "2026-09-14 23:59"        DRY RUN — the plan, and nothing else
//   node scripts/rollback.mjs v1.30.2 --execute --because "routing tab is broken"
//
// DRY RUN IS THE DEFAULT. CLAUDE.md: "every job that acts on its own needs a way to ask what
// it is about to do, without doing it." Nothing moves until --execute, and --execute refuses
// without --because, so the git log six weeks later says why the app went backwards.
//
// IT IS A FORWARD COMMIT, NEVER A HISTORY REWRITE. The rollback is one new commit on top of
// main whose TREE is the old tree. Verified both directions against the real main tip before
// this shipped: the commit's tree is byte-identical to the target's, and `git revert` of that
// single commit restores today's tree byte-identically. That is the CLAUDE.md "ship it so it
// can be put back" rule pointed at the rollback itself — undoing a rollback is one command,
// and nobody's checkout breaks because nobody's history moved.
//
// WHAT IT CANNOT PUT BACK, and this is the part that matters operationally: CODE ONLY.
// Firestore is untouched — the board, address overrides, dispatcher notes, suppression flags
// and receiving hours all stay as they are. Anything already sent to NuVizz stays sent; a
// route created at 2pm is still created. Netlify env switches stay where they are. A rollback
// is not an undo button on the day's freight, and treating it as one is how somebody builds a
// second truck on top of the first.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// maxBuffer: App.jsx is over a megabyte and a `git show` of it dies on execFileSync's default
// 1MB pipe with ENOBUFS — the same lesson check-version-bump.mjs and check-rwb-untouched.mjs
// each learned separately.
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

export const ZONE = 'America/New_York';
export const APP = 'dispatch-map/src/App.jsx';
export const PKG = 'dispatch-map/package.json';
export const SITE = process.env.NETLIFY_SITE_NAME || 'dd-dispatch-map';

/**
 * ROLL BACK THE APP. KEEP THE RULEBOOK, THE REFEREES AND THE LIFEBOAT.
 *
 * Chad asked to roll back THE APP. These paths are not the app, and taking them with it would
 * each be a change he did not ask for — which is the exact complaint this tool exists to answer.
 * Every entry is here because rolling it back was measured against the real Sep-14 tree and
 * found to do harm, not because it seemed tidy:
 *
 *   CLAUDE.md — his rules. A rollback to Sep 14 would delete the panel-naming rule and the
 *     workbench freeze he wrote on the 15th and 16th, silently, as part of "fixing" the thing
 *     they were written about. His instructions never go backwards because of a bad deploy.
 *
 *   .github/ and the check-* guards — the referees. check-rwb-untouched.mjs was added on the
 *     16th, so a rollback DELETES the Route Workbench guard: the protection he had just been
 *     given, removed by the recovery. CI also invokes it by path, so its absence turns the
 *     rollback PR red and the rollback cannot merge at all. Measured, not assumed — it is the
 *     ONLY script CI calls by path that is missing at the Sep-14 tree, and every verify:* npm
 *     script CI needs is present there, so the verify scripts roll back with the UI they test.
 *
 *   this tool and its test — the lifeboat. A rollback to any date before this file existed
 *     deletes it, leaving Chad on the old code with no way to list versions, roll back further
 *     or roll forward: the one command he needs, gone on the way there.
 *
 * Everything else — src, the netlify functions, the verify scripts, the tests, package.json —
 * rolls back, because all of that IS the app and its tests must match the code they test.
 */
export const SELF_PRESERVE = [
  'CLAUDE.md',
  '.github',
  'dispatch-map/scripts/check-*.mjs',
  'dispatch-map/scripts/rollback.mjs',
  'dispatch-map/test/rollback.test.mjs',
];

/**
 * The changelog headline for a version, when the helpers that read it are available.
 *
 * DYNAMIC AND OPTIONAL, for the same reason as SELF_PRESERVE. These two helpers live in the
 * tree this tool replaces, and a static import of a file a rollback can delete is a tool that
 * dies the moment it succeeds. The headline is a nicety on a display line — worth reusing the
 * real readers for, never worth crashing over — so a missing module degrades to "no headline"
 * rather than taking the rollback down with it.
 */
async function headlineFor(source, version) {
  if (!version) return null;
  try {
    const [{ headlineFromEntry }, { changelogEntryFor }] = await Promise.all([
      import('../src/lib/build-update.js'),
      import('./emit-version-json.mjs'),
    ]);
    return headlineFromEntry(changelogEntryFor(source, version));
  } catch { return null; }
}

// ── TIME: CHAD'S CLOCK, NOT THE SERVER'S ─────────────────────────────────────
//
// Every commit timestamp in this repo is +0000 and every sentence Chad says about one is
// Eastern. "11:59 pm sept 14th" is 03:59 UTC on the 15th, and a tool that read it as UTC
// would roll back to 7:59pm — four hours and four merges early, silently. Nothing about the
// output would look wrong.

/** PURE: the zone's UTC offset in ms at a given instant (negative west of Greenwich). */
export function zoneOffsetMs(utcMs, timeZone = ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  // Some ICU builds render midnight as hour '24' under hour12:false. Left unhandled that
  // makes the offset come out a day wrong for exactly one hour a day.
  const hour = p.hour === '24' ? '00' : p.hour;
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * PURE: an Eastern wall-clock reading → the UTC instant it names.
 *
 * Two passes, not one. The offset depends on the instant and the instant depends on the
 * offset, so a single lookup is wrong across a DST boundary — the one night a year where
 * "roll back to 1:30am" would land an hour out. Converging twice settles it.
 */
export function wallToUtc({ y, mo, d, h = 0, mi = 0, s = 0 }, timeZone = ZONE) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = wall - zoneOffsetMs(wall, timeZone);
  ms = wall - zoneOffsetMs(ms, timeZone);
  return ms;
}

/** PURE: the Eastern calendar date at an instant, as {y, mo, d}. */
export function wallYmd(utcMs, timeZone = ZONE) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(utcMs)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day };
}

/** PURE: an instant as Chad reads it — "2026-09-14 23:48 EDT". */
export function formatWall(utcMs, timeZone = ZONE) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).filter((x) => x.type !== 'literal')
    .map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute} ${p.timeZoneName}`;
}

export const ACCEPTED_FORMS = [
  '"2026-09-14 23:59"      a date and a time, Eastern',
  '"2026-09-14 11:59pm"    the same thing in 12-hour',
  '"2026-09-14"            a bare date means the END of that day (23:59:59)',
  '"yesterday 6pm"         yesterday / today, with or without a time',
  'v1.30.2                 a version out of --list',
  '6f7c9d1                 a commit, if you already have one',
];

/**
 * PURE: what did Chad type? A time, a version, a commit — or nothing this can read.
 *
 * NO GUESSING, per the governing rule of CLAUDE.md. An input this does not recognise comes
 * back as {kind:'error'} with the accepted forms; it never falls through to "probably today".
 * A rollback aimed at a date the tool invented is the worst outcome available here.
 */
export function parseTarget(text, nowMs = Date.now()) {
  const raw = String(text ?? '').trim();
  if (!raw) return { kind: 'error', why: 'no target given' };

  const ver = /^v?(\d+\.\d+\.\d+)$/.exec(raw);
  if (ver) return { kind: 'version', version: ver[1] };

  // A bare hex word. Checked AFTER versions so "1.30.2" is never read as a SHA, and it must
  // be at least 7 characters because a 4-char abbreviation is ambiguous in a repo this size.
  if (/^[0-9a-f]{7,40}$/i.test(raw)) return { kind: 'commit', sha: raw };

  const lower = raw.toLowerCase();
  const timePart = /(?:^|\s)(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(lower);
  const readTime = () => {
    if (!timePart) return null;
    let h = +timePart[1];
    const mi = timePart[2] === undefined ? 0 : +timePart[2];
    const s = timePart[3] === undefined ? 0 : +timePart[3];
    const ap = timePart[4];
    if (ap) {
      if (h < 1 || h > 12) return 'bad';
      if (ap === 'pm' && h !== 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
    } else if (h > 23) return 'bad';
    if (mi > 59 || s > 59) return 'bad';
    return { h, mi, s };
  };

  const rel = /^(yesterday|today|now)\b/.exec(lower);
  if (rel) {
    if (rel[1] === 'now') return { kind: 'time', at: nowMs };
    const t = readTime();
    if (t === 'bad') return { kind: 'error', why: `"${raw}" has a time that is not a real clock reading` };
    const base = wallYmd(nowMs);
    const dayMs = wallToUtc({ ...base, h: 12 });          // noon, so a DST shift cannot move the date
    const shifted = wallYmd(rel[1] === 'yesterday' ? dayMs - 86400000 : dayMs);
    // No time given with a relative day means the END of it — "roll back to yesterday" is a
    // request for yesterday's last good build, not for one minute past midnight.
    return { kind: 'time', at: wallToUtc({ ...shifted, ...(t || { h: 23, mi: 59, s: 59 }) }) };
  }

  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](.*))?$/i.exec(lower);
  if (date) {
    const [, y, mo, d, rest] = date;
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) {
      return { kind: 'error', why: `"${raw}" is not a real date` };
    }
    if (rest === undefined || rest.trim() === '') {
      return { kind: 'time', at: wallToUtc({ y: +y, mo: +mo, d: +d, h: 23, mi: 59, s: 59 }) };
    }
    const t = readTime();
    if (!t || t === 'bad') return { kind: 'error', why: `"${raw}" has a time this cannot read` };
    return { kind: 'time', at: wallToUtc({ y: +y, mo: +mo, d: +d, ...t }) };
  }

  return { kind: 'error', why: `"${raw}" is not a form this understands` };
}

// ── VERSIONS AND THE CHANGELOG ───────────────────────────────────────────────

export function versionOf(source) {
  const m = /const APP_VERSION = '([^']+)'/.exec(String(source || ''));
  return m ? m[1] : null;
}

/** PURE: '…(v1.30.2) (#930)' → '1.30.2'. Null when the subject carries no version. */
export function versionFromSubject(subject) {
  const m = /\(v(\d+\.\d+\.\d+)\)/.exec(String(subject || ''));
  return m ? m[1] : null;
}

/**
 * PURE: the version a rollback ships under.
 *
 * MINOR, never a re-use of the old number. The footer is how Chad tells what he is looking
 * at, and a rollback that re-published "1.30.2" would make two different bundles claim one
 * version — which also walks APP_VERSION backwards, the exact thing check-version-bump.mjs
 * refuses. Forward with a row that says where it went back to is both honest and mergeable.
 */
export function nextVersion(current) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current || '').trim());
  if (!m) return null;
  return `${m[1]}.${+m[2] + 1}.0`;
}

/** PURE: a JS single-quoted string body. Backslashes first, or the quotes get double-escaped. */
export function jsQuote(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' ');
}

export function setAppVersion(source, version) {
  const s = String(source);
  if (!/const APP_VERSION = '[^']+'/.test(s)) return null;
  return s.replace(/const APP_VERSION = '[^']+'/, `const APP_VERSION = '${version}'`);
}

/**
 * PURE: put a row at the TOP of VERSION_LOG.
 *
 * Top, not "wherever an anchor matched" — several sessions ship in parallel and the drift
 * that habit caused is what made check-deploy-fresh read a stale live version twice in one
 * afternoon (v0.56.4). The row must also match check-version-bump's /\n\s*\['x.y.z',/ or the
 * rollback PR cannot merge, which is a poor thing to discover at 6:45am.
 */
export function insertChangelogRow(source, version, text) {
  const s = String(source);
  const anchor = 'const VERSION_LOG = [\n';
  const at = s.indexOf(anchor);
  if (at === -1) return null;
  const cut = at + anchor.length;
  return `${s.slice(0, cut)}  ['${version}', '${jsQuote(text)}'],\n${s.slice(cut)}`;
}

/**
 * PURE: put `npm run rollback` back into a package.json that predates it.
 *
 * The companion to SELF_PRESERVE. Restoring the script FILE but not its npm alias leaves
 * `npm run rollback` answering "missing script" — which reads exactly like the tool being gone,
 * on the morning when the difference matters. Returns the source unchanged when the entry is
 * already there, and null when the anchor cannot be found, so the caller can say so rather
 * than write a package.json it guessed at.
 */
export function ensureRollbackScript(source) {
  const s = String(source);
  if (/"rollback"\s*:/.test(s)) return s;
  const m = /("scripts"\s*:\s*\{\s*\n)/.exec(s);
  if (!m) return null;
  const indent = /\n(\s+)"/.exec(s.slice(m.index + m[0].length - 1))?.[1] ?? '    ';
  const at = m.index + m[0].length;
  return `${s.slice(0, at)}${indent}"rollback": "node scripts/rollback.mjs",\n${s.slice(at)}`;
}

/**
 * PURE: the changelog sentence a rollback writes about itself.
 *
 * Written for the person reading the footer on a bad morning, so it leads with the fact that
 * the app went BACKWARDS and to when — and it carries Chad's own reason, because a rollback
 * with no stated reason is indistinguishable from a mistake six weeks later.
 */
export function rollbackRowText({ toVersion, toWhen, because, undone = [], paths = [] }) {
  const scope = paths.length ? `${paths.length} path(s): ${paths.join(', ')}` : 'the whole app';
  const lost = undone.map((c) => c.version).filter(Boolean);
  const lostBit = lost.length
    ? ` UNDONE: ${lost.length} release(s) — ${lost.join(', ')}.`
    : ' No released versions were undone.';
  return `ROLLED BACK TO v${toVersion} (${toWhen}). Chad: "${because}". ${scope} now holds exactly the
    code that was on main at that moment — one forward commit whose tree IS the old tree, so nobody's
    history moved and a single \`git revert\` of it puts today's code back.${lostBit} CODE ONLY: Firestore
    (the board, address overrides, dispatcher notes, receiving hours, suppression flags) is untouched, and
    anything already sent to NuVizz is still sent. A rollback is not an undo button on the day's freight.`
    .replace(/\s+/g, ' ').trim();
}

// ── READING HISTORY ──────────────────────────────────────────────────────────

/** PURE: `git log` porcelain → rows. Kept separate from the git call so tests need no repo. */
export function parseLog(out) {
  return String(out || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [sha, epoch, ...rest] = line.split('\u0001');
    const subject = rest.join('\u0001');
    return { sha, at: Number(epoch) * 1000, subject, version: versionFromSubject(subject) };
  });
}

/**
 * PURE: the last commit at or before an instant, and everything after it.
 *
 * `commits` arrive newest-first, as `git log` gives them. Returns null for `target` when the
 * instant is older than every commit in the window — the caller says so rather than silently
 * picking the oldest one it happens to be holding.
 */
export function splitAt(commits, atMs) {
  const idx = commits.findIndex((c) => c.at <= atMs);
  if (idx === -1) return { target: null, undone: commits };
  return { target: commits[idx], undone: commits.slice(0, idx) };
}

/**
 * PURE: which undone commits reach the vendor, so they get read before anything is pressed.
 *
 * NOT a safety verdict — this cannot know which changes matter to a given morning, and saying
 * it could would be the "plausible story that fits the symptom" CLAUDE.md warns about. It is
 * a reading list: a rollback past "a failed route create was firing five POSTs at NuVizz, not
 * one" puts the five POSTs back, and that is Chad's call to make with his eyes open.
 */
export function vendorTouching(undone) {
  const re = /nuvizz|\bsend\b|\bsent\b|\bpost(s|ed|ing)?\b|route create|dispatch to/i;
  return undone.filter((c) => re.test(c.subject));
}

// ── THE CLI ──────────────────────────────────────────────────────────────────
// Everything above is pure and importable; everything below touches git, the disk or the
// network. A release tool that cannot be unit-tested is an odd thing to trust at 6:45am.

const BOLD = (s) => `\u001b[1m${s}\u001b[0m`;
const DIM = (s) => `\u001b[2m${s}\u001b[0m`;

function parseArgv(argv) {
  const out = { target: null, execute: false, list: false, days: 14, because: null, paths: [], push: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') out.execute = true;
    else if (a === '--list') out.list = true;
    else if (a === '--no-push') out.push = false;
    else if (a === '--dry-run') out.execute = false;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--because') out.because = argv[++i];
    else if (a === '--paths') out.paths.push(argv[++i]);
    else if (a.startsWith('--')) out.unknown = a;
    else if (out.target === null) out.target = a;
  }
  return out;
}

function historySince(days) {
  return parseLog(git('log', 'origin/main', `--since=${days} days ago`, '--format=%H\u0001%ct\u0001%s'));
}

async function changelogHeadline(sha, version) {
  if (!version) return null;
  try { return await headlineFor(git('show', `${sha}:${APP}`), version); } catch { return null; }
}

function showList(days) {
  const commits = historySince(days);
  console.log(BOLD(`\n  What shipped in the last ${days} days — newest first, times are ${ZONE}.\n`));
  for (const c of commits) {
    const v = c.version ? `v${c.version}` : DIM('(no version)');
    console.log(`  ${formatWall(c.at)}   ${v.padEnd(12)} ${c.sha.slice(0, 7)}  ${c.subject.slice(0, 84)}`);
  }
  console.log(BOLD('\n  To see what rolling back to one of these would do (nothing moves):\n'));
  console.log('      npm run rollback -- "2026-09-14 23:59"\n');
}

function resolveTarget(t, commits) {
  if (t.kind === 'commit') {
    const sha = git('rev-parse', t.sha);
    const known = commits.find((c) => c.sha === sha);
    return { target: known || { sha, at: Number(git('log', '-1', '--format=%ct', sha)) * 1000, subject: git('log', '-1', '--format=%s', sha), version: versionFromSubject(git('log', '-1', '--format=%s', sha)) }, undone: commits.slice(0, commits.findIndex((c) => c.sha === sha)) };
  }
  if (t.kind === 'version') {
    const idx = commits.findIndex((c) => c.version === t.version);
    if (idx === -1) return { target: null, undone: [], missingVersion: t.version };
    return { target: commits[idx], undone: commits.slice(0, idx) };
  }
  return splitAt(commits, t.at);
}

async function printPlan({ target, undone, paths, asked }) {
  const headline = await changelogHeadline(target.sha, target.version);
  console.log(BOLD('\n  ROLLBACK PLAN — nothing has moved. This is what --execute would do.\n'));
  console.log(`  You asked for   ${asked}`);
  console.log(`  Rolling back to ${BOLD(target.version ? `v${target.version}` : target.sha.slice(0, 7))}  ${formatWall(target.at)}  ${target.sha.slice(0, 7)}`);
  console.log(`                  ${target.subject.slice(0, 92)}`);
  if (headline) console.log(DIM(`                  ${headline.slice(0, 92)}`));
  console.log(`  Scope           ${paths.length ? `${paths.length} path(s): ${paths.join(', ')}` : 'the whole app'}`);
  console.log(`  Kept as-is      ${SELF_PRESERVE.join(', ')}`);
  console.log(DIM('                  your rules, the CI guards and this tool do not go backwards'));
  console.log(DIM('                  because of a bad deploy — everything else does.'));

  console.log(BOLD(`\n  ${undone.length} commit(s) would be undone — read this before you press go:\n`));
  for (const c of undone) {
    console.log(`    ${formatWall(c.at)}  ${(c.version ? `v${c.version}` : '—').padEnd(10)} ${c.subject.slice(0, 80)}`);
  }

  const vendor = vendorTouching(undone);
  if (vendor.length) {
    console.log(BOLD('\n  ⚠ These undone commits touch how freight reaches NuVizz. Rolling back'));
    console.log(BOLD('    re-introduces whatever each of them fixed:\n'));
    for (const c of vendor) console.log(`    ${c.version ? `v${c.version}` : c.sha.slice(0, 7)}  ${c.subject.slice(0, 84)}`);
  }

  console.log(BOLD('\n  WHAT THIS DOES NOT PUT BACK — code only:\n'));
  console.log('    · Firestore is untouched — the board, address overrides, dispatcher notes,');
  console.log('      receiving hours and suppression flags all stay exactly as they are now.');
  console.log('    · Anything already sent to NuVizz stays sent. A route created at 2pm is');
  console.log('      still created. This is not an undo button on the day\'s freight.');
  console.log('    · Netlify env switches stay where they are.');

  console.log(BOLD('\n  IF THE BOARD IS BROKEN RIGHT NOW and you need it back in 30 seconds:\n'));
  console.log(`    https://app.netlify.com/sites/${SITE}/deploys  →  find the deploy for`);
  console.log(`    ${target.version ? `v${target.version}` : 'that commit'} → "Publish deploy". That is instant and needs no build.`);
  console.log('    Then still run this with --execute, or the next merge ships the bad code again.');

  console.log(BOLD('\n  To actually do it:\n'));
  console.log(`      npm run rollback -- "${asked}" --execute --because "why you are rolling back"\n`);
}

function execute({ target, undone, paths, because, push }) {
  if (git('status', '--porcelain')) {
    console.error('\n  ✗ You have uncommitted changes. Commit or stash them first — this rewrites the');
    console.error('    working tree and will not risk your work to do it.\n');
    process.exit(1);
  }

  const branch = `rollback/to-${target.version || target.sha.slice(0, 7)}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  git('checkout', '-B', branch, 'origin/main');

  // THE RESTORE. read-tree for the whole app: it sets index and worktree to the target's tree
  // exactly, including DELETING files added since, which `git checkout <sha> -- .` does not —
  // a partial restore that leaves today's new files behind is a tree nobody has ever built.
  // Verified both directions against the real main tip: the resulting commit's tree is
  // byte-identical to the target's, and reverting that one commit restores today's exactly.
  if (paths.length) git('restore', `--source=${target.sha}`, '--staged', '--worktree', '--', ...paths);
  else git('read-tree', '-u', '--reset', target.sha);

  // Put the rulebook, the referees and the lifeboat back — see SELF_PRESERVE for why each one
  // is here. A path that does not exist on main yet is not an error: on the very first run this
  // tool is only on the branch, and a rollback that refused over that would be useless.
  for (const f of SELF_PRESERVE) {
    try { git('checkout', 'origin/main', '--', f); } catch { /* not on main yet */ }
  }
  const pkgFixed = ensureRollbackScript(readFileSync(PKG, 'utf8'));
  if (pkgFixed) writeFileSync(PKG, pkgFixed);
  else console.warn(`  ! could not re-add the npm alias to ${PKG} — use: node dispatch-map/scripts/rollback.mjs`);

  // The version has to move FORWARD even though the code moved back. The restore put the old
  // APP_VERSION back with everything else; leaving it there fails check-version-bump (rightly:
  // a footer reading older than the build before it is how a stale deploy hides) and would
  // make two different bundles claim one number.
  const current = versionOf(git('show', 'origin/main:' + APP));
  const shipAs = nextVersion(current);
  const src = readFileSync(APP, 'utf8');
  const row = rollbackRowText({
    toVersion: target.version || target.sha.slice(0, 7),
    toWhen: formatWall(target.at),
    because, undone, paths,
  });
  const bumped = insertChangelogRow(setAppVersion(src, shipAs), shipAs, row);
  if (!bumped) {
    console.error(`\n  ✗ Could not bump APP_VERSION in ${APP} — the anchors moved. Nothing pushed.\n`);
    process.exit(1);
  }
  writeFileSync(APP, bumped);

  git('add', '-A');
  git('commit', '-m', `Roll the app back to ${target.version ? `v${target.version}` : target.sha.slice(0, 7)} — ${formatWall(target.at)} (v${shipAs})

Chad: "${because}"

Restores ${paths.length ? paths.join(', ') : 'the whole tree'} to ${target.sha.slice(0, 7)}, undoing ${undone.length} commit(s).
This is a forward commit, not a history rewrite: \`git revert\` of it puts today's code back.

CODE ONLY — Firestore and anything already sent to NuVizz are untouched.`);

  // The workbench guard fails any PR whose App.jsx changes name the frozen surface, and a
  // whole-app rollback certainly does. The escape is "quote Chad", and --because is his
  // sentence — so it goes in a commit here rather than being discovered as a red check.
  git('commit', '--allow-empty', '-m', `RWB-CHANGE: ${because}`);

  console.log(BOLD(`\n  ✓ Built ${branch} — two commits, shipping as v${shipAs}.\n`));

  if (!push) {
    console.log(`  Not pushed (--no-push). When you are ready:\n\n      git push -u origin ${branch}\n`);
    return;
  }

  git('push', '-u', 'origin', branch);
  // Never report an intent as an outcome: ask the remote whether the branch is actually there.
  const landed = git('ls-remote', '--heads', 'origin', branch);
  if (!landed) {
    console.error('\n  ✗ The push reported success but origin does not have the branch. Nothing shipped.\n');
    process.exit(1);
  }
  console.log(`  ✓ Pushed, and origin confirms it: ${landed.split('\t')[0].slice(0, 7)}\n`);
  console.log('  Open the PR (CI must go green before it merges):\n');
  console.log(`      https://github.com/DavisDelivery/davis-nuvizz/compare/${branch}?expand=1\n`);
  console.log(DIM(`  To undo this rollback later: git revert <the rollback commit> — that is the whole job.\n`));
}

async function main(argv) {
  const opts = parseArgv(argv);
  if (opts.unknown) {
    console.error(`\n  ✗ I do not know the option ${opts.unknown}.\n`);
    process.exit(2);
  }

  // RUN FROM THE REPO ROOT, whatever directory this was invoked from. Every path in here is
  // root-relative, and the normal way to run it is `npm run rollback`, which puts cwd in
  // dispatch-map/ — so readFileSync(APP) went looking for dispatch-map/dispatch-map/src/App.jsx
  // and died with ENOENT partway through --execute, on a branch it had already created. The dry
  // run hid it completely: `git show <sha>:<path>` resolves from the root no matter where you
  // stand, so the plan printed perfectly and only the real thing broke. Found by running it.
  process.chdir(git('rev-parse', '--show-toplevel'));

  git('fetch', 'origin', 'main', '--quiet');

  if (opts.list || opts.target === null) {
    showList(opts.days);
    if (opts.target === null && !opts.list) {
      console.log('  Pick a moment from the list above and pass it in. Forms this reads:\n');
      for (const f of ACCEPTED_FORMS) console.log(`      ${f}`);
      console.log('');
    }
    return;
  }

  const t = parseTarget(opts.target);
  if (t.kind === 'error') {
    console.error(`\n  ✗ ${t.why}. I am not going to guess at what you meant — a rollback aimed at`);
    console.error('    a date I invented is worse than no rollback. Forms I read:\n');
    for (const f of ACCEPTED_FORMS) console.error(`      ${f}`);
    console.error('');
    process.exit(2);
  }

  const commits = historySince(Math.max(opts.days, 60));
  const { target, undone, missingVersion } = resolveTarget(t, commits);
  if (missingVersion) {
    console.error(`\n  ✗ No commit on main ships v${missingVersion}. Run --list to see what does.\n`);
    process.exit(2);
  }
  if (!target) {
    console.error(`\n  ✗ Nothing on main is that old within the window I looked at. Widen it with`);
    console.error('    --days, or pass a commit directly.\n');
    process.exit(2);
  }
  if (!undone.length) {
    console.log('\n  ✓ Nothing to roll back — main is already at that point.\n');
    return;
  }

  if (!opts.execute) {
    await printPlan({ target, undone, paths: opts.paths, asked: opts.target });
    return;
  }
  if (!opts.because || opts.because.trim().length < 8) {
    console.error('\n  ✗ --execute needs --because "<why>". It goes in the commit, in the changelog');
    console.error('    row and in the workbench-guard approval, so the log six weeks from now says');
    console.error('    why the app went backwards instead of looking like a mistake.\n');
    process.exit(2);
  }
  execute({ target, undone, paths: opts.paths, because: opts.because.trim(), push: opts.push });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
