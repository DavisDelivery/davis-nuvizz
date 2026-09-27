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
// TWO WAYS BACK, because Chad asked for both and they answer different mornings:
//
//   node scripts/rollback.mjs --list                    what shipped, when, in plain English
//
//   TIME — "everything was fine Sunday night." He CANNOT name the culprit.
//   node scripts/rollback.mjs "2026-09-14 23:59"        DRY RUN — the plan, and nothing else
//   node scripts/rollback.mjs v1.30.2 --execute --because "routing tab is broken"
//
//   DROP — "it was #945." He CAN name it. Keeps every other fix that shipped since.
//   node scripts/rollback.mjs --drop 945                DRY RUN — and whether it comes out clean
//   node scripts/rollback.mjs --drop 945,950 --execute --because "send button broke again"
//
// Chad: "would it be possible to both roll back to a point in time when I knew everything was
// okay if I can't identify the PR that caused the problem and also roll back PRs?" Yes, and the
// difference that decides which to reach for is this: TIME replaces the whole tree, so it can
// NEVER conflict and always works — but it throws away every good fix that shipped since. DROP
// keeps them, but it CAN conflict, because later PRs may have edited the same lines. The drop
// dry run says which, per PR, by actually trying the revert in a throwaway worktree rather than
// predicting from file lists. Measured on the three live suspects the day this shipped: #950
// comes out clean, #945 and #942 carry real code conflicts a person has to settle.
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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * PURE: '…(v1.30.2) (#930)' → '1.30.2'. Null when the subject carries no version.
 *
 * THE FALLBACK, NOT THE SOURCE. A merge subject is typed by a person (or copied by GitHub from a
 * branch's first commit) and can say one version while the tree ships another: #1027 (79c8032)
 * merged as "(v1.74.3)" while its App.jsx said '1.75.1' — v1.74.3 was already #1025 (7b5fe43).
 * The tree is what the footer showed, so the tree decides; see withTreeVersions.
 */
export function versionFromSubject(subject) {
  const m = /\(v(\d+\.\d+\.\d+)\)/.exec(String(subject || ''));
  return m ? m[1] : null;
}

/**
 * PURE: `git grep` over many trees at once → Map(sha → the APP_VERSION that tree ships).
 *
 * `git grep … -e '^const APP_VERSION = ' <sha> <sha> … -- dispatch-map/src/App.jsx` prints one
 * `<sha>:<path>:<line>` per tree that has the line, in ONE process — measured at 0.4 s for 97
 * commits, where a `git show` of the 1.5 MB file per commit costs about as much for every 20.
 * A tree with no App.jsx (or no APP_VERSION line) is simply absent from the map, and the caller
 * falls back to the subject for that commit rather than inventing a number.
 *
 * That shape is only what git prints when nobody's git config says otherwise — see TREE_GREP.
 */
export function parseTreeVersions(out) {
  const map = new Map();
  for (const line of String(out || '').split('\n')) {
    // The path between the two colons is whatever git prints for the ONE file the pathspec names
    // (relative to wherever it ran), so it is not compared — only the line's shape is.
    const m = /^([0-9a-f]{7,40}):[^:\n]*:const APP_VERSION = '([^']+)'/.exec(line);
    if (!m || map.has(m[1])) continue;
    map.set(m[1], m[2]);
  }
  return map;
}

/**
 * PURE: label each commit with the version its TREE ships — the number the footer showed on
 * that build — and keep the subject's claim beside it so a disagreement can be said out loud.
 *
 * `versionFrom` says where the label came from: 'tree', or 'subject' when the tree could not be
 * read (a commit older than App.jsx, a git that could not answer). Null when neither says.
 */
export function withTreeVersions(commits, treeVersions) {
  return (commits || []).map((c) => {
    const tree = treeVersions?.get?.(c.sha) ?? null;
    const subjectVersion = versionFromSubject(c.subject);
    return {
      ...c,
      version: tree ?? subjectVersion,
      subjectVersion,
      versionFrom: tree ? 'tree' : (subjectVersion ? 'subject' : null),
    };
  });
}

/**
 * PURE: when some builds' versions came from merge subjects rather than their code, the sentence
 * that says so — null when every one was read from its tree.
 *
 * A "no commit ships vX" or "vX names two points" answer is only as good as the labels it was
 * worked out from. If trees could not be read, the labels are merge subjects, and a merge subject
 * can name the wrong version (#1027 did). Saying "no commit ships v1.75.1" without saying that is
 * the Sep 26 answer again, stated with the same confidence.
 *
 * Two kinds of unread build, said apart: one whose version is its merge TITLE's claim ('subject'),
 * and one with no version at all (its code was not read and its title names none). Calling the
 * second kind "merge titles" named a source that was never there.
 */
export function subjectFallbackNote(commits) {
  const all = commits || [];
  const titled = all.filter((c) => c.versionFrom === 'subject').length;
  const none = all.filter((c) => c.versionFrom !== 'tree' && c.versionFrom !== 'subject').length;
  if (!titled && !none) return null;
  const parts = [];
  if (titled) {
    parts.push(`${titled} of ${all.length} build(s) in this window could not be read from their code, so their `
      + 'versions are merge titles — and a merge title can name the wrong version (#1027 did)');
  }
  if (none) {
    parts.push(`${none}${titled ? '' : ` of ${all.length}`} build(s) could not be read from their code and their `
      + 'titles name no version, so no version is known for them');
  }
  return `${parts.join('; ')}.`;
}

/**
 * PURE: "roll back to v1.74.3" → the commit to roll back to, and everything after it.
 *
 * The NEWEST commit that shows the version: a commit that did not move APP_VERSION (a CLAUDE.md
 * edit, say) still showed the version before it, and the newest of those is the last build that
 * read that number in the footer. The older ones are returned as `sameVersion` so the plan can
 * name them rather than hide them.
 *
 * `setBy` is the one of them that MOVED APP_VERSION to this number — the oldest of the stretch,
 * when the build before it (still inside the window) showed a different number. Otherwise it is
 * null rather than a guess, and `unsetWhy` says which of two reasons: 'window' — the window ends at
 * that oldest commit, so what came before it was not read (a wider --days reads it); 'unversioned'
 * — the build before it WAS read and carries no version, so no window would settle it.
 *
 * NEVER A GUESS BETWEEN TWO POINTS. If the version appears in two separate stretches of history
 * (the same number claimed twice, with something else between), there is no one answer, so this
 * returns `ambiguousVersion` with every match and the CLI asks for a commit instead.
 */
export function resolveVersion(commits, version) {
  const hits = [];
  (commits || []).forEach((c, i) => { if (c.version === version) hits.push(i); });
  if (!hits.length) return { target: null, undone: [], missingVersion: version };
  const oneStretch = hits.every((v, k) => k === 0 || v === hits[k - 1] + 1);
  if (!oneStretch) return { target: null, undone: [], ambiguousVersion: version, matches: hits.map((i) => commits[i]) };
  const oldest = hits[hits.length - 1];
  const before = commits[oldest + 1];
  const setBy = before && before.version && before.version !== version ? commits[oldest] : null;
  const unsetWhy = setBy ? null : (before ? 'unversioned' : 'window');
  return { target: commits[hits[0]], undone: commits.slice(0, hits[0]), sameVersion: hits.slice(1).map((i) => commits[i]), setBy, unsetWhy };
}

/**
 * PURE: what the plan says when the version asked for sat on more than one commit in a row.
 *
 * Only the oldest of such a run MOVED APP_VERSION to the number; every newer one — the target
 * included — changed something else and kept it. The plan used to say all the older ones "did not
 * move APP_VERSION", which is false of exactly the one that did, so each commit is named with
 * what it did. Empty when the version sat on one commit only.
 *
 * "Widen --days" only when widening could answer it: when the build before the run was read and
 * carries no version, a wider window reads the same build again, so the plan says that instead.
 */
export function sameVersionNote({ target, sameVersion = [], setBy = null, unsetWhy = null } = {}) {
  if (!target || !sameVersion?.length) return [];
  const v = `v${target.version}`;
  const lines = [
    `${v} is on ${sameVersion.length + 1} commits in a row. This takes the newest, the last build that`,
    `showed ${v}; it did not move APP_VERSION itself. To go to an older one, pass its commit:`,
  ];
  sameVersion.forEach((c, k) => {
    const oldest = k === sameVersion.length - 1;
    const what = !oldest ? 'did not move APP_VERSION'
      : setBy && setBy.sha === c.sha ? `moved APP_VERSION to ${v}`
        : unsetWhy === 'unversioned' ? 'the oldest of the run; the build before it has no readable version, so which one set it is not known'
          : 'the oldest in the window read; what came before it was not read (widen --days)';
    lines.push(`  ${c.sha.slice(0, 7)}  ${c.subject.slice(0, 60)}  — ${what}`);
  });
  return lines;
}

/**
 * PURE: "No commit on main ships vX" — and the commits whose merge TITLE names vX while their code
 * shipped something else, so the refusal points somewhere instead of stopping bare.
 *
 * v1.40.0 is the real case: it has a changelog row, but no build's code ever said it. d412457 moved
 * APP_VERSION from 1.39.0 to 1.41.0 in one commit while its title said "(v1.40.0)". The old tool
 * resolved "v1.40.0" to d412457 by that title; reading the code, it rightly refuses — and this says
 * which commit the number came from and how to reach it. Empty when no title names it.
 */
export function titleNamesNote(commits, version) {
  const named = (commits || []).filter((c) => c.versionFrom === 'tree' && c.subjectVersion === version && c.version !== version);
  if (!named.length) return [];
  return [
    `No build's code says v${version}, but ${named.length === 1 ? 'this commit\'s merge title names it' : 'these commits\' merge titles name it'}:`,
    // The WHOLE subject: its tail is the "(vX.Y.Z) (#N)" this line exists to show.
    ...named.map((c) => `  ${c.sha.slice(0, 7)}  ${formatWall(c.at)}  ${c.subject}  — the footer on it read v${c.version}`),
    `To roll back to ${named.length === 1 ? 'it' : 'one of them'}, pass the commit:  npm run rollback -- ${named[0].sha.slice(0, 7)}`,
  ];
}

/**
 * PURE: a commit Chad already has → the target and everything after it, WHEN it is in the
 * window. Null when it is not, so the caller reads exactly what lies between it and main
 * instead of trimming the window's oldest commit off a list that is not the answer.
 */
export function splitAtCommit(commits, sha) {
  const idx = (commits || []).findIndex((c) => c.sha === sha);
  if (idx === -1) return null;
  return { target: commits[idx], undone: commits.slice(0, idx) };
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
  // Each version once, and never the one being rolled back TO. Versions are read from each
  // commit's tree, so a commit that did not move APP_VERSION carries its parent's number — listing
  // it twice, or listing the target's own number as "undone", would misstate what was lost.
  const lost = [...new Set(undone.map((c) => c.version).filter(Boolean))].filter((v) => v !== toVersion);
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

// ── DROPPING ONE PR, RATHER THAN RETURNING TO A TIME ─────────────────────────
//
// TWO DIFFERENT OPERATIONS, and Chad asked for both because he needs both:
//
//   TIME   "everything was fine Sunday night" — he CANNOT name the culprit. Replaces the
//          whole tree. Blunt, but it can never conflict, so it always works.
//   DROP   "it was #945" — he CAN name it. Reverts that one PR and keeps the other sixteen.
//          Surgical, and it CAN conflict, because later PRs may have edited the same lines.
//
// That difference is the whole reason both exist. A tool with only TIME throws away thirteen
// good fixes to undo one bad one; a tool with only DROP is useless on the morning he cannot
// tell which PR did it. They are alternatives, never combined — "go back to Sunday" already
// drops everything after Sunday.
//
// WHAT THIS WILL AND WILL NOT RESOLVE FOR HIM. Measured on the three live suspects rather
// than guessed at: every one of them conflicts on a plain `git revert`, and the conflicts
// split into exactly two kinds.
//
//   MECHANICAL — APP_VERSION, the VERSION_LOG rows, and the two generated files: public/version.json
//     and src/lib/version-dates.js. These collide on almost every parallel merge (CLAUDE.md has a
//     whole entry about it) and carry no behaviour. This tool rewrites APP_VERSION and the log a few
//     lines later anyway when it bumps the version; the build (prebuild) rewrites version.json from
//     them, and version-dates.js is regenerated here from both sides (regenerateVersionDates).
//     Resolving them automatically is not a judgement call; leaving them for Chad to hand-edit at
//     6:45am would be.
//   CODE — anything else. NOT the tool\'s to resolve. A revert that guesses which side of a
//     real code conflict to keep is a silent behaviour change wearing a rollback\'s name,
//     which is the exact failure this whole feature exists to undo. It stops and says where.
//
// On the measured three that leaves #950 fully automatic (0 code conflicts), #942 with 1 and
// #945 with 2 — so the dry run tells him which of those is a one-command fix before he picks.

/** PURE: "945", "945,950", "#945 #950" → [945, 950]. Null when it reads as nothing. */
export function parseDropList(text) {
  const nums = String(text ?? '').match(/\d+/g);
  if (!nums) return null;
  return [...new Set(nums.map(Number))].filter((n) => n > 0);
}

/** PURE: '…(#945)' → 945. The PR number GitHub stamps onto a squashed merge subject. */
export function prFromSubject(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(String(subject || '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * PURE: PR numbers → the commits that carry them, newest first, plus the ones not found.
 *
 * Newest first because that is the order they must be reverted in: undoing an older PR before
 * a newer one that built on it maximises the conflicts rather than minimising them.
 */
export function resolveByPR(commits, numbers) {
  const byPR = new Map();
  for (const c of commits) {
    const n = prFromSubject(c.subject);
    if (n !== null && !byPR.has(n)) byPR.set(n, { ...c, pr: n });
  }
  const found = numbers.map((n) => byPR.get(n)).filter(Boolean);
  const missing = numbers.filter((n) => !byPR.has(n));
  // commits arrive newest-first from git log, so index order IS recency order
  found.sort((a, b) => b.at - a.at);
  return { found, missing };
}

/**
 * A file the BUILD rewrites whole from App.jsx (npm run build → prebuild → emit-version-json.mjs), so
 * a conflict in it carries no meaning: main's copy is kept, and the drop's own deploy writes the new one.
 */
export const GENERATED = ['dispatch-map/public/version.json'];

/**
 * THE OTHER GENERATED FILE, settled by regenerating it rather than by taking either side.
 *
 * src/lib/version-dates.js is written by scripts/emit-version-dates.mjs, which prebuild also runs on
 * every deploy. It carries no behaviour: its one reader, lib/rollback-targets.js, prints "· landed
 * <date>" beside each row of the footer's Roll back panel, and the request that panel files names the
 * version, never the date. It is NOT rebuilt from the tree alone, though: the generator MERGES the
 * committed copy with `git log -L` on APP_VERSION's line and never removes a row, because a version
 * that landed on main stays landed. Dropping a PR does not un-land its version, so no row is removed
 * here either.
 *
 * Measured Sep 28 on the nine Sep 26 PRs: only #1023's revert conflicts in it — main's side holds 42 rows,
 * the reverted side none — and the tool counted that as a real code conflict a person had to settle.
 */
export const VERSION_DATES_FILE = 'dispatch-map/src/lib/version-dates.js';

/** The history read emit-version-dates.mjs fromGit() makes, argument for argument (the \u0001 separators
 *  are what its parseVersionLog reads), so a dispute is settled by the answer the generator would give. */
export const VERSION_HISTORY_LOG = ['log', '-L', `/^const APP_VERSION = /,+1:${APP}`, '--format=COMMIT\u0001%H\u0001%ct'];

/** PURE: `'1.74.0': '2026-09-26T19:52:00.000Z'` rows → { version: epoch seconds }. The generator's own
 *  reader of its format (existing() in emit-version-dates.mjs), kept here because that one is private. */
export function datesIn(text) {
  const out = {};
  for (const m of String(text ?? '').matchAll(/'(\d+\.\d+\.\d+)':\s*'([^']+)'/g)) {
    const t = Date.parse(m[2]);
    if (Number.isFinite(t)) out[m[1]] = Math.floor(t / 1000);
  }
  return out;
}

/**
 * PURE: a conflicted version-dates.js, regenerated — never by picking a side.
 *
 * Every dated row on EITHER side is kept (the generator's own rule: merge, never truncate), and the file
 * is written by the generator's renderModule, so it is byte for byte what the generator would write for
 * those rows. The two sides CAN give one version two dates: a copy built on a PR branch dates a version
 * by the branch commit, and a later copy built on history that holds the merge re-dates it by the merge
 * (#1023's own copy said 1.74.0 landed at 19:08:21, its branch commit 6c86404; #1029's copy moved it to
 * 19:52:00, when 4f927cf merged). Then git history settles it, exactly as the generator does — `history()` is
 * parseVersionLog over `git log -L`, only asked for when there is a dispute — and a dispute history
 * cannot settle is a person's call, never a coin toss.
 *
 * Returns { text } or { stop: why }.
 */
export function regenerateVersionDates(body, { render, history } = {}) {
  if (typeof render !== 'function') return { stop: 'its generator (scripts/emit-version-dates.mjs) could not be loaded' };
  const merged = {};
  const disputed = new Set();
  const take = (text) => {
    for (const [v, t] of Object.entries(datesIn(text))) {
      if (v in merged && merged[v] !== t) disputed.add(v);
      else if (!(v in merged)) merged[v] = t;
    }
  };
  for (const h of splitConflicts(body)) {
    take(h.plain);
    if (h.ours !== null) { take(h.ours.join('\n')); take(h.theirs.join('\n')); }
  }
  if (!Object.keys(merged).length) return { stop: 'no dated version could be read from either side' };
  if (disputed.size) {
    const known = typeof history === 'function' ? history() : null;
    const unsettled = [...disputed].filter((v) => !Number.isFinite(known?.[v]));
    if (unsettled.length) {
      return { stop: `its two sides date ${unsettled.map((v) => `v${v}`).join(', ')} differently, and git history here does not say which is right` };
    }
    for (const v of disputed) merged[v] = known[v];
  }
  return { text: render(merged) };
}

/**
 * The revert the dry run's probe and --execute both run, with two settings STATED rather than
 * inherited. The same class as TREE_GREP and --no-show-signature: a config setting must not decide
 * what this tool reads. Command-line flags beat config, including GIT_CONFIG_COUNT in the environment.
 *
 *   merge.conflictStyle=merge — diff3 or zdiff3, settings people really use, add a `||||||| base`
 *     section to every conflict. splitConflicts read it as code, so every App.jsx version hunk became
 *     a "real" conflict: on a test repo `--drop 3` went from "✓ comes out cleanly" to "✗ 2 real code
 *     conflict(s) … App.jsx", and --execute refused (measured Sep 27).
 *   rerere.enabled=false — rerere replays a conflict someone once settled by hand, and it is on by
 *     default once .git/rr-cache exists. With rerere.autoUpdate it also stages the file, so git reports
 *     no conflict at all: a real code conflict read "✓ comes out cleanly" and --execute would have
 *     committed that old answer unreviewed (measured Sep 27). Without autoUpdate the file is left
 *     conflicted with no markers, and the stop blamed a deleted file that was not deleted.
 */
export const REVERT_NO_COMMIT = ['-c', 'merge.conflictStyle=merge', '-c', 'rerere.enabled=false', 'revert', '--no-commit'];

/**
 * PURE: split a conflicted file into plain text and conflict blocks.
 *
 * Deliberately a parser rather than a regex: App.jsx changelog rows are megabytes of prose
 * containing quotes, brackets and the word "HEAD", and a regex over that finds markers that
 * are not there. Same lesson check-effect-deps.mjs learned.
 */
export function splitConflicts(text) {
  const out = [];
  let plain = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^<{7}( |$)/.test(lines[i])) { plain.push(lines[i]); continue; }
    const ours = []; const theirs = [];
    let side = ours; let closed = false;
    for (i++; i < lines.length; i++) {
      if (/^={7}$/.test(lines[i])) { side = theirs; continue; }
      if (/^>{7}( |$)/.test(lines[i])) { closed = true; break; }
      side.push(lines[i]);
    }
    if (!closed) { plain.push(...ours, ...theirs); break; }   // truncated: treat as text
    out.push({ plain: plain.join('\n'), ours, theirs });
    plain = [];
  }
  out.push({ plain: plain.join('\n'), ours: null, theirs: null });
  return out;
}

/**
 * PURE: does this conflict contain ONLY version bookkeeping?
 *
 * A hunk qualifies when every non-blank line on both sides is either the APP_VERSION
 * assignment or a VERSION_LOG row. Anything else — one line of real code anywhere in the
 * hunk — disqualifies the whole hunk. Erring that way is deliberate: a hunk wrongly called
 * mechanical is resolved silently and ships a behaviour change nobody reviewed.
 */
export function isVersionOnly(hunk) {
  const lines = [...(hunk.ours || []), ...(hunk.theirs || [])].map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;
  return lines.every((l) => (
    /^const APP_VERSION = '[^\']*';?$/.test(l)
    || /^\['\d+\.\d+\.\d+',/.test(l)
    || l === '];' || l === '];,' || /^\],?$/.test(l)
  ));
}

/**
 * PURE: resolve the mechanical conflicts, keep the rest.
 *
 * Version-only hunks take OURS — the branch side, which is main\'s current version and log.
 * That is right because the revert is not trying to move the version at all; the caller bumps
 * it forward a few lines later. Code hunks are left exactly as git wrote them, markers and
 * all, and counted, so the caller can stop and show them rather than commit a file with
 * conflict markers in it.
 */
export function resolveVersionConflicts(text) {
  const parts = splitConflicts(text);
  let remaining = 0;
  let out = '';
  for (const p of parts) {
    out += p.plain;
    if (p.ours === null) continue;
    if (isVersionOnly(p)) {
      out += (p.ours.length ? '\n' + p.ours.join('\n') : '');
    } else {
      remaining++;
      out += `\n<<<<<<< HEAD\n${p.ours.join('\n')}\n=======\n${p.theirs.join('\n')}\n>>>>>>>`;
    }
    out += '\n';
  }
  return { text: out, remaining };
}

/**
 * PURE: how many real and how many mechanical conflicts ONE conflicted file holds.
 *
 * A FILE GIT MARKED CONFLICTED BUT WITH NO MARKERS IN IT IS A REAL CONFLICT. That is what a
 * modify/delete looks like: the PR being dropped ADDED a file that a later PR then changed (or
 * the other way round), so git cannot tell whether to delete it and writes no <<<<<<< at all.
 * Counting only markers scored those files as zero — measured on #1033, whose four files later
 * changed by #1037 (plan-core.mts, plan-jobs.mts, plan.mts, PlanPanel.jsx) were counted as
 * nothing — and --execute would then have `git add`ed the file as it stood, silently keeping what
 * the revert was meant to remove. An unreadable file is the same answer: a person has to look.
 */
export function conflictCounts(path, body) {
  if (GENERATED.includes(path)) return { code: 0, mech: 1, markers: true };
  if (body === null || body === undefined) return { code: 1, mech: 0, markers: false };
  let code = 0; let mech = 0;
  for (const h of splitConflicts(body)) {
    if (h.ours === null) continue;
    if (isVersionOnly(h)) mech++; else code++;
  }
  if (!code && !mech) return { code: 1, mech: 0, markers: false };
  return { code, mech, markers: true };
}

/**
 * PURE: what a drop does with ONE conflicted file — the single decision the dry run's probe and
 * --execute both make, so the plan and the real thing cannot disagree about a file.
 *
 *   'ours'  the generated version.json: main's copy is kept (the drop's deploy rebuilds it anyway).
 *   'write' only version-line hunks: `text` is the file with them resolved to main's side — or
 *           version-dates.js regenerated from both sides by `regenerate` (regenerateVersionDates).
 *   'stop'  anything a person has to decide — a code hunk, a file one side deleted and the other
 *           changed (no markers at all), a file that could not be read, or a version-dates.js that
 *           could not be regenerated (`why` says why). Never written.
 *
 * `code` and `mech` are the counts the plan prints.
 */
export function dropFileAction(path, body, { regenerate } = {}) {
  const counted = conflictCounts(path, body);
  if (GENERATED.includes(path)) return { action: 'ours', ...counted };
  if (path === VERSION_DATES_FILE && counted.markers) {
    const r = typeof regenerate === 'function' ? regenerate(body) : { stop: 'its generator (scripts/emit-version-dates.mjs) could not be loaded' };
    if (typeof r?.text === 'string') return { action: 'write', text: r.text, code: 0, mech: counted.code + counted.mech, markers: true, regenerated: true };
    return { action: 'stop', code: Math.max(1, counted.code), mech: 0, markers: true, why: r?.stop || 'it could not be regenerated' };
  }
  if (counted.code) return { action: 'stop', ...counted };
  const { text, remaining } = resolveVersionConflicts(body);
  // conflictCounts and resolveVersionConflicts share isVersionOnly, so this cannot fire — but a file
  // is never written with markers left in it on the strength of "cannot".
  if (remaining) return { action: 'stop', ...counted, code: remaining };
  return { action: 'write', text, ...counted };
}

/**
 * PURE: did git's revert of one PR run at all? A revert that exits with an error and leaves NO file
 * conflicted did nothing — git refused it outright — and must never read "comes out cleanly". The
 * Sep 27 review measured it on a throwaway repo: a true merge commit, reverted without -m, fails that
 * way; the probe swallowed the error as "conflicts are expected", found nothing conflicted, printed ✓,
 * and --execute built a "Drop #5" commit that reverted nothing. Returns git's reason, or null when the
 * revert ran (cleanly, or stopping on conflicts — the ordinary case).
 */
export function revertFailure(error, conflicted) {
  if (!error) return null;
  if ((conflicted || []).length) return null;
  const text = String(typeof error === 'object' ? (error.stderr || error.message || '') : error).trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const said = lines.find((l) => /^error:/i.test(l)) || lines.find((l) => /^fatal:/i.test(l)) || lines[0];
  return (said || 'git refused the revert').replace(/^(error|fatal):\s*/i, '');
}

/**
 * PURE: the refusal for PRs that landed as a true merge commit (more than one parent).
 *
 * Every PR auto-merge lands is squashed into ONE ordinary commit, so a merge commit got onto main some
 * other way. Reverting one means choosing which parent was main (`git revert -m 1`), and picking that
 * is a person's call — the same reason a real code conflict stops the run. Empty when there are none.
 */
export function mergeRefusal(merges) {
  if (!merges?.length) return [];
  const one = merges.length === 1;
  return [
    `${merges.map((m) => `#${m.pr}`).join(', ')} ${one ? 'is a merge commit' : 'are merge commits'}: ${
      merges.map((m) => `${m.sha.slice(0, 7)} has ${m.parents} parents`).join('; ')}.`,
    'Every PR auto-merge lands is squashed into one ordinary commit, so this was merged another way.',
    'Reverting a merge means choosing which parent was main (git revert -m 1), and that is a person\'s',
    'call, not this tool\'s. Nothing was done. Revert it by hand on a branch of your own, or roll back',
    'to a time instead, which cannot conflict:',
  ];
}

/**
 * PURE: the changelog sentence a PR-drop writes about itself.
 *
 * Names the PRs by number, because that is how Chad refers to them and how he will look one
 * up again. Carries the same CODE ONLY warning as a time rollback, for the same reason.
 */
export function dropRowText({ dropped = [], because, autoResolved = 0 }) {
  const names = dropped.map((c) => `#${c.pr}${c.version ? ` (v${c.version})` : ''}`).join(', ');
  return `DROPPED ${dropped.length} PR(S): ${names}. Chad: "${because}". Everything else on main is
    untouched — this reverts only those commits, rather than returning the tree to a moment in time,
    so every other fix that shipped since stays in.${autoResolved ? ` ${autoResolved} version-line
    conflict(s) were resolved mechanically (APP_VERSION and the changelog collide on almost every
    parallel merge and carry no behaviour); any real code conflict stops the run instead.` : ''}
    Each drop is a forward commit, so \`git revert\` of it puts the PR back. CODE ONLY: Firestore and
    anything already sent to NuVizz are untouched.`.replace(/\s+/g, ' ').trim();
}

// ── READING HISTORY ──────────────────────────────────────────────────────────

/**
 * PURE: `git log` porcelain → rows. Kept separate from the git call so tests need no repo.
 *
 * ONLY ROWS OF THE FORMAT ARE COMMITS. Every commit GitHub squash-merges onto main is signed, and a
 * git config with log.showSignature=true makes `git log` print gpg's "Signature made …" lines on
 * stdout between them (measured Sep 27). Read as commits, those lines were handed to the tree grep
 * as revisions, the grep failed for the whole window, and every version fell back to its merge
 * subject — the Sep 26 bug again, from a setting. The CLI also passes --no-show-signature; this is
 * the second line, for whatever else a config can put on stdout.
 */
export function parseLog(out) {
  return String(out || '').split('\n').map((l) => l.trim()).filter(Boolean).filter((line) => {
    const f = line.split('\u0001');
    return f.length >= 3 && f[0] !== '' && Number.isFinite(Number(f[1])) && f[1] !== '';
  }).map((line) => {
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
  const out = { target: null, execute: false, list: false, days: 14, because: null, paths: [], push: true, drop: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') out.execute = true;
    else if (a === '--list') out.list = true;
    else if (a === '--no-push') out.push = false;
    else if (a === '--dry-run') out.execute = false;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--because') out.because = argv[++i];
    else if (a === '--paths') out.paths.push(argv[++i]);
    else if (a === '--drop') out.drop = `${out.drop ?? ''} ${argv[++i] ?? ''}`;
    else if (a.startsWith('--')) out.unknown = a;
    else if (out.target === null) out.target = a;
  }
  return out;
}

const LOG_FORMAT = '--format=%H\u0001%ct\u0001%s';
// --no-show-signature: see parseLog. A config setting must not decide what this tool reads. Exported
// so a test can run it against a signed commit under log.showSignature=true.
export const LOG = ['--no-show-signature', LOG_FORMAT];

/**
 * The version each commit's tree ships, read ONCE per commit per run. A commit's tree never
 * changes, so the cache cannot go stale; it saves the second read when the plan, the list and
 * the drop probe ask about the same commits.
 */
const treeVersionCache = new Map();

/**
 * The `git grep` that reads each tree's APP_VERSION, with every output and pattern setting stated
 * rather than inherited. Measured Sep 27: `grep.lineNumber=true` — a common setting — makes git print
 * `sha:path:NN:const …`, which parseTreeVersions does not read, and `grep.patternType=fixed` makes the
 * `^` a literal so nothing matches. Either one silently put every version back on its merge subject,
 * and the tool answered "No commit on main ships v1.75.1" again. Command-line flags beat config.
 */
export const TREE_GREP = ['grep', '--no-line-number', '--no-column', '--no-color', '--basic-regexp', '-e', '^const APP_VERSION = '];

/**
 * `chunk` is how many commits one `git grep` reads (200 is well under any command-line limit; a full
 * clone's 60 days is several chunks). It is an option only so a test can make a five-commit repo take
 * five chunks; anything but a positive whole number is the default, never a loop that cannot end.
 * `cache` is the per-run cache unless a test hands in its own.
 */
export function readTreeVersions(shas, { cwd, chunk = 200, cache } = {}) {
  const size = Number.isInteger(chunk) && chunk > 0 ? chunk : 200;
  const store = cache instanceof Map ? cache : treeVersionCache;
  const todo = [...new Set(shas)].filter((s) => !store.has(s));
  const run = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // From the repo root whatever the cwd, so the pathspec means the same file from anywhere.
  let top = null;
  try { top = run('rev-parse', '--show-toplevel'); } catch { /* not a repo: every commit falls back */ }
  for (let i = 0; i < todo.length; i += size) {
    const part = todo.slice(i, i + size);
    let out = '';
    // Exit 1 is "no tree had the line" — an answer, not a failure. Anything else (a git that
    // cannot answer) leaves these commits on their subject's version, which the list marks.
    try { out = top ? run('-C', top, ...TREE_GREP, ...part, '--', APP) : ''; } catch { out = ''; }
    const found = parseTreeVersions(out);
    for (const s of part) store.set(s, found.get(s) ?? null);
  }
  const map = new Map();
  for (const s of shas) { const v = store.get(s); if (v) map.set(s, v); }
  return map;
}

/** Commits read off git, labelled by what their trees ship. */
function labelled(logOut) {
  const commits = parseLog(logOut);
  return withTreeVersions(commits, readTreeVersions(commits.map((c) => c.sha)));
}

// FIRST-PARENT: the states main was actually in. On a squash-merge history that is every commit
// anyway; on a true merge it keeps the side branch's own commits out, since main never ran them.
function historySince(days) {
  return labelled(git('log', 'origin/main', '--first-parent', `--since=${days} days ago`, ...LOG));
}

async function changelogHeadline(sha, version) {
  if (!version) return null;
  try { return await headlineFor(git('show', `${sha}:${APP}`), version); } catch { return null; }
}

function showList(days) {
  const commits = historySince(days);
  console.log(BOLD(`\n  What shipped in the last ${days} days — newest first, times are ${ZONE}.\n`));
  console.log(DIM('  The version is the one the footer showed on that build (APP_VERSION in its own tree).'));
  console.log(DIM('  * = its tree could not be read, so the version is the merge subject\'s claim.\n'));
  const unreadNote = subjectFallbackNote(commits);
  if (unreadNote) console.log(BOLD(`  ! ${unreadNote}\n`));
  for (const c of commits) {
    const v = c.version ? `v${c.version}${c.versionFrom === 'subject' ? '*' : ''}` : '(no version)';
    const differs = c.versionFrom === 'tree' && c.subjectVersion && c.subjectVersion !== c.version
      ? DIM(`  (subject says v${c.subjectVersion})`) : '';
    console.log(`  ${formatWall(c.at)}   ${v.padEnd(12)} ${c.sha.slice(0, 7)}  ${c.subject.slice(0, 84)}${differs}`);
  }
  console.log(BOLD('\n  To see what rolling back to one of these would do (nothing moves):\n'));
  console.log('      npm run rollback -- "2026-09-14 23:59"\n');
}

function resolveTarget(t, commits) {
  if (t.kind === 'commit') {
    const sha = git('rev-parse', t.sha);
    const inWindow = splitAtCommit(commits, sha);
    if (inWindow) return inWindow;
    // Older than the window (or not on main's first-parent line): read exactly what lies between
    // it and main, rather than trimming the window's oldest commit off a list that is not it.
    const [target] = labelled(git('log', '-1', ...LOG, sha));
    return { target, undone: labelled(git('log', '--first-parent', `${sha}..origin/main`, ...LOG)) };
  }
  if (t.kind === 'version') return resolveVersion(commits, t.version);
  return splitAt(commits, t.at);
}

async function printPlan({ target, undone, paths, asked, sameVersion = [], setBy = null, unsetWhy = null }) {
  const headline = await changelogHeadline(target.sha, target.version);
  console.log(BOLD('\n  ROLLBACK PLAN — nothing has moved. This is what --execute would do.\n'));
  console.log(`  You asked for   ${asked}`);
  console.log(`  Rolling back to ${BOLD(target.version ? `v${target.version}` : target.sha.slice(0, 7))}  ${formatWall(target.at)}  ${target.sha.slice(0, 7)}`);
  console.log(`                  ${target.subject.slice(0, 92)}`);
  if (headline) console.log(DIM(`                  ${headline.slice(0, 92)}`));
  if (target.versionFrom === 'tree' && target.subjectVersion && target.subjectVersion !== target.version) {
    console.log(DIM(`                  its merge subject says v${target.subjectVersion}; the footer on this build read`));
    console.log(DIM(`                  v${target.version} (APP_VERSION in its tree), and that is what this goes by.`));
  }
  if (target.versionFrom === 'subject') {
    console.log(DIM('                  (its tree could not be read — this version is the merge subject\'s claim)'));
  }
  for (const line of sameVersionNote({ target, sameVersion, setBy, unsetWhy })) console.log(DIM(`                  ${line}`));
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
  git('checkout', '-q', '-B', branch, 'origin/main');

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

/**
 * How the tree at `repoDir` regenerates src/lib/version-dates.js: ITS OWN generator (the one its
 * prebuild runs), so what the drop writes is what that tree's build would write — and, only when the
 * two sides of the conflict date one version differently, its git history read the way
 * emit-version-dates.mjs fromGit() reads it. `git log -L` over App.jsx took 7 s on a 110-commit clone,
 * so it is never run when both sides agree, which is every case measured on Sep 28.
 *
 * Undefined when the tree carries no generator (a rollback to before it existed): the conflict is
 * then a person's to settle, like any file this tool cannot vouch for.
 */
async function versionDatesRegenerator(repoDir) {
  let gen = null;
  try { gen = await import(pathToFileURL(join(repoDir, 'dispatch-map', 'scripts', 'emit-version-dates.mjs')).href); } catch { gen = null; }
  if (typeof gen?.renderModule !== 'function' || typeof gen?.parseVersionLog !== 'function') return undefined;
  const history = () => {
    try {
      return gen.parseVersionLog(execFileSync('git', ['-C', repoDir, ...VERSION_HISTORY_LOG],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch { return null; }
  };
  return (body) => regenerateVersionDates(body, { render: gen.renderModule, history });
}

/**
 * Would this PR come out cleanly? Measured by actually trying it, in a throwaway worktree.
 *
 * NOT predicted from the file lists. Two PRs can touch one file and not collide, or collide in
 * a file neither obviously shares — the only honest answer is the one git gives. A detached
 * worktree in a temp dir means the probe cannot touch Chad's checkout even if it goes wrong,
 * which matters because this runs while he is looking at a broken board.
 */
async function probeRevert(shas) {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-probe-'));
  try {
    git('worktree', 'add', '--detach', '--quiet', dir, 'origin/main');
    // stderr: 'pipe', not inherited. A conflicting revert is the EXPECTED result here — it is
    // what the probe exists to find out — and letting git print "error: could not revert" to the
    // console makes a successful diagnostic read like a crash, right above the plan that says it
    // came out fine. Chad would reasonably stop at the word "error".
    const wt = (...a) => execFileSync('git', ['-C', dir, ...a],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    // The generator main's own tree carries, so a regenerated version-dates.js is what main's build writes.
    const regenerate = await versionDatesRegenerator(dir);
    const report = [];
    for (const c of shas) {
      let conflicted = [];
      let error = null;
      // A conflicting revert throws, and that is the ordinary case — but so does a revert git refused
      // outright, which leaves nothing conflicted. revertFailure tells the two apart.
      try { wt(...REVERT_NO_COMMIT, c.sha); } catch (e) { error = e; }
      try {
        conflicted = wt('diff', '--name-only', '--diff-filter=U').trim().split('\n').filter(Boolean);
      } catch { /* nothing unmerged */ }
      const failed = revertFailure(error, conflicted);
      let code = 0; let mech = 0;
      const realFiles = [];
      const regenerated = [];
      for (const f of conflicted) {
        let body = null;
        try { body = readFileSync(join(dir, f), 'utf8'); } catch { /* unreadable: counted as real */ }
        const n = dropFileAction(f, body, { regenerate });
        code += n.code; mech += n.mech;
        if (n.code) realFiles.push({ file: f, code: n.code, why: n.why });
        if (n.regenerated) regenerated.push(f);
      }
      report.push({ ...c, conflicted, realFiles, regenerated, code, mech, failed });
      try { wt('revert', '--abort'); } catch { /* nothing in progress */ }
      try { wt('reset', '--hard', 'origin/main'); wt('clean', '-qfd'); } catch { /* best effort */ }
    }
    return report;
  } finally {
    try { git('worktree', 'remove', '--force', dir); } catch { rmSync(dir, { recursive: true, force: true }); }
  }
}

async function printDropPlan({ picked, asked }) {
  const probe = await probeRevert(picked);
  console.log(BOLD('\n  DROP PLAN — nothing has moved. This is what --execute would do.\n'));
  console.log(`  You asked to drop  ${asked}`);
  console.log(`  Reverting ${picked.length} PR(s), newest first. Everything else on main stays in.\n`);

  let blocked = 0;
  for (const c of probe) {
    const headline = await changelogHeadline(c.sha, c.version);
    console.log(`  ${BOLD(`#${c.pr}`)}${c.version ? `  v${c.version}` : ''}  ${formatWall(c.at)}  ${c.sha.slice(0, 7)}`);
    console.log(`      ${c.subject.slice(0, 88)}`);
    if (headline) console.log(DIM(`      ${headline.slice(0, 88)}`));
    if (c.failed) {
      // Git refused the revert and left nothing conflicted: nothing was reverted, so nothing "comes out".
      blocked++;
      console.log(`      ${BOLD('✗ git could not revert it')} — ${c.failed}`);
    } else if (!c.code) {
      console.log(`      ${BOLD('✓ comes out cleanly')}${c.mech ? DIM(` (${c.mech} version-line conflict(s), resolved mechanically)`) : ''}`);
    } else {
      blocked++;
      console.log(`      ${BOLD(`✗ ${c.code} real code conflict(s)`)} — a person has to pick a side:`);
      // Only the files a person has to settle, each with its count. A file whose only conflicts are
      // version lines (App.jsx, on nearly every drop) is settled by the tool, and listing it under
      // "a person has to pick a side" told Chad to hand-edit something he never has to touch.
      for (const r of c.realFiles) console.log(`          ${r.file}  (${r.code})${r.why ? `  — ${r.why}` : ''}`);
    }
    for (const f of c.regenerated || []) {
      console.log(DIM(`      ${f.split('/').pop()}: regenerated from both sides by its own generator (no side taken)`));
    }
    console.log('');
  }
  // "Clean" is a statement about git, not about the app. Measured Sep 27: #1022 drops with no
  // conflict at all, and two tests a LATER PR added (#1023) then fail, because they expect what #1022
  // did. Saying ✓ without this line would read as "safe to ship", which the probe cannot know.
  if (probe.some((c) => !c.code && !c.failed)) {
    console.log(DIM('  "Comes out cleanly" means git found nothing to settle. A later PR\'s tests can still'));
    console.log(DIM('  expect what a dropped PR did, so the drop\'s own CI run is what says it works.\n'));
  }

  console.log(BOLD('  WHAT THIS DOES NOT PUT BACK — code only:\n'));
  console.log('    · Firestore is untouched, and anything already sent to NuVizz stays sent.');
  console.log('    · Only these PRs are reverted. Every other fix on main stays in — that is the');
  console.log('      whole difference between this and rolling back to a time.\n');

  if (blocked) {
    console.log(BOLD(`  ${blocked} of ${picked.length} cannot be done automatically.`));
    console.log('  --execute will revert what it can and STOP at the first real conflict rather');
    console.log('  than guess which side to keep. Guessing there ships a behaviour change nobody');
    console.log('  reviewed, wearing a rollback\'s name.\n');
  }
  console.log(BOLD('  To actually do it:\n'));
  console.log(`      npm run rollback -- --drop ${picked.map((c) => c.pr).join(',')} --execute --because "why"\n`);
  console.log(DIM('  Cannot name the PR? Roll back to a time instead — that never conflicts:'));
  console.log(DIM('      npm run rollback -- "2026-09-14 11:59pm"\n'));
}

async function executeDrop({ picked, because, push }) {
  if (git('status', '--porcelain')) {
    console.error('\n  ✗ You have uncommitted changes. Commit or stash them first.\n');
    process.exit(1);
  }
  // Where Chad was standing, so a refusal can put him back exactly there. `git checkout -` is
  // not enough: it lands on a detached HEAD when the previous ref was one, and handing someone
  // a detached HEAD while their board is broken is a second problem they did not ask for.
  const wasOn = (() => { try { return git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { return 'main'; } })();
  const branch = `drop/pr-${picked.map((c) => c.pr).join('-')}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  git('checkout', '-q', '-B', branch, 'origin/main');

  // Leave NOTHING behind, on every stop. A half-reverted branch and a dirty tree on the morning the
  // board is broken is worse than no attempt: the next command someone runs picks it up. The branch
  // goes too — a pile of dead drop/* branches is its own confusion. The reset is safe: the drop branch
  // was cut from origin/main a moment ago on a tree checked clean above, so it throws away only what
  // this run staged — which `revert --abort` alone does not, after a PR that reverted with no conflict.
  const abandon = () => {
    try { git('revert', '--abort'); } catch { /* nothing in progress */ }
    try { git('reset', '-q', '--hard'); } catch { /* best effort */ }
    git('checkout', '-q', wasOn === 'HEAD' ? 'main' : wasOn);
    try { git('branch', '-D', branch); } catch { /* never created */ }
    process.exit(1);
  };
  // The generator this tree carries (the drop branch is origin/main's tree), for version-dates.js.
  const regenerate = await versionDatesRegenerator(process.cwd());

  let autoResolved = 0;
  for (const c of picked) {
    let error = null;
    try { execFileSync('git', [...REVERT_NO_COMMIT, c.sha], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { error = e; }
    let conflicted = [];
    try { conflicted = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean); } catch {}
    const failed = revertFailure(error, conflicted);
    if (failed) {
      // Git refused the revert outright. Building on past it would commit a "Drop #N" that reverts
      // nothing, with a changelog row saying the PR was dropped — an intent reported as an outcome.
      console.error(`\n  ✗ git could not revert #${c.pr} (${c.sha.slice(0, 7)}): ${failed}`);
      console.error('\n    Nothing of it was reverted, so no drop is built. Nothing was pushed and nothing is');
      console.error('    left behind. Settle it by hand on a branch of your own, or roll back to a time instead:\n');
      console.error('        npm run rollback -- "2026-09-14 11:59pm"\n');
      abandon();
    }
    for (const f of conflicted) {
      let body = null;
      try { body = readFileSync(f, 'utf8'); } catch { /* unreadable: a real conflict, below */ }
      const decided = dropFileAction(f, body, { regenerate });
      if (decided.action === 'ours') { git('checkout', '--ours', '--', f); git('add', '--', f); autoResolved++; continue; }
      if (decided.action !== 'write') {
        // STOP. Never guess which side of a real code conflict to keep — and a file one side
        // deleted while the other changed it is a real conflict with no markers in it at all.
        console.error(`\n  ✗ #${c.pr} has ${decided.code} real code conflict(s) in ${f}${decided.why ? ` (${decided.why})` : decided.markers ? '' : ' (one side deleted this file and the other changed it, or it could not be read)'}.`);
        console.error('\n    This is not mine to resolve — picking a side would ship a behaviour change');
        console.error('    nobody reviewed, which is the thing a rollback exists to undo. Nothing was');
        console.error(`    pushed and nothing is left behind. Either settle it by hand (git revert ${c.sha.slice(0, 7)}`);
        console.error('    on a branch of your own), or roll back to a time instead, which cannot conflict:\n');
        console.error('        npm run rollback -- "2026-09-14 11:59pm"\n');
        abandon();
      }
      writeFileSync(f, decided.text);
      git('add', '--', f);
      autoResolved++;
    }
  }

  const shipAs = nextVersion(versionOf(git('show', `origin/main:${APP}`)));
  const row = dropRowText({ dropped: picked, because, autoResolved });
  const bumped = insertChangelogRow(setAppVersion(readFileSync(APP, 'utf8'), shipAs), shipAs, row);
  if (!bumped) {
    console.error(`\n  ✗ Could not bump APP_VERSION in ${APP}. Nothing pushed.\n`);
    process.exit(1);
  }
  writeFileSync(APP, bumped);
  git('add', '-A');
  git('commit', '-m', `Drop ${picked.map((c) => `#${c.pr}`).join(', ')} (v${shipAs})

Chad: "${because}"

Reverts ${picked.length} PR(s) and nothing else — every other fix on main stays in.
Each is a forward commit, so \`git revert\` puts the PR back.

CODE ONLY — Firestore and anything already sent to NuVizz are untouched.`);
  git('commit', '--allow-empty', '-m', `RWB-CHANGE: ${because}`);

  console.log(BOLD(`\n  ✓ Built ${branch} — shipping as v${shipAs}.`));
  if (autoResolved) console.log(DIM(`    ${autoResolved} version-line conflict(s) resolved mechanically.\n`));
  if (!push) { console.log(`  Not pushed (--no-push):\n\n      git push -u origin ${branch}\n`); return; }
  git('push', '-u', 'origin', branch);
  const landed = git('ls-remote', '--heads', 'origin', branch);
  if (!landed) {
    console.error('\n  ✗ The push reported success but origin does not have the branch.\n');
    process.exit(1);
  }
  console.log(`  ✓ Pushed, and origin confirms it: ${landed.split('\t')[0].slice(0, 7)}\n`);
  console.log(`      https://github.com/DavisDelivery/davis-nuvizz/compare/${branch}?expand=1\n`);
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

  if (opts.drop !== null) {
    if (opts.target !== null) {
      console.error('\n  ✗ --drop and a time are alternatives, not a combination. Rolling back to a');
      console.error('    time already drops everything after it. Pick one.\n');
      process.exit(2);
    }
    const nums = parseDropList(opts.drop);
    if (!nums?.length) {
      console.error('\n  ✗ --drop needs PR numbers, e.g. --drop 945  or  --drop 945,950\n');
      process.exit(2);
    }
    const commits = historySince(Math.max(opts.days, 60));
    const { found, missing } = resolveByPR(commits, nums);
    if (missing.length) {
      console.error(`\n  ✗ No commit on main carries ${missing.map((n) => `#${n}`).join(', ')}.`);
      console.error('    Run --list to see what is there. I am not going to guess at which you meant.\n');
      process.exit(2);
    }
    // A PR that landed as a true merge commit is refused before anything is probed or built — the dry
    // run and --execute alike. `rev-list --parents` prints the commit and then each parent.
    const merges = found.map((c) => ({ pr: c.pr, sha: c.sha, parents: git('rev-list', '--parents', '-n', '1', c.sha).split(/\s+/).length - 1 }))
      .filter((m) => m.parents > 1);
    if (merges.length) {
      const [first, ...rest] = mergeRefusal(merges);
      console.error(`\n  ✗ ${first}`);
      for (const l of rest) console.error(`    ${l}`);
      console.error('\n        npm run rollback -- "2026-09-14 11:59pm"\n');
      process.exit(2);
    }
    if (!opts.execute) { await printDropPlan({ picked: found, asked: nums.map((n) => `#${n}`).join(', ') }); return; }
    if (!opts.because || opts.because.trim().length < 8) {
      console.error('\n  ✗ --execute needs --because "<why>".\n');
      process.exit(2);
    }
    await executeDrop({ picked: found, because: opts.because.trim(), push: opts.push });
    return;
  }

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
  const { target, undone, missingVersion, ambiguousVersion, matches, sameVersion, setBy, unsetWhy } = resolveTarget(t, commits);
  const unreadNote = subjectFallbackNote(commits);
  if (missingVersion) {
    console.error(`\n  ✗ No commit on main ships v${missingVersion}. Run --list to see what does.`);
    // …and when a merge TITLE names it (v1.40.0: d412457's title, whose code shipped v1.41.0), say
    // which commit, so the refusal leads somewhere instead of stopping bare.
    for (const l of titleNamesNote(commits, missingVersion)) console.error(`    ${l}`);
    if (unreadNote) console.error(`    ${unreadNote}\n    So this answer may be wrong: pass the commit you mean instead.`);
    console.error('');
    process.exit(2);
  }
  if (ambiguousVersion) {
    console.error(`\n  ✗ v${ambiguousVersion} names more than one point on main, with other builds between them:\n`);
    for (const c of matches) console.error(`      ${c.sha.slice(0, 7)}  ${formatWall(c.at)}  ${c.subject.slice(0, 80)}${c.versionFrom === 'tree' ? '' : '  (merge title, code not read)'}`);
    if (unreadNote) console.error(`\n    ${unreadNote}`);
    console.error('\n    I am not going to pick one for you. Pass the commit you mean instead.\n');
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
    await printPlan({ target, undone, paths: opts.paths, asked: opts.target, sameVersion, setBy, unsetWhy });
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
