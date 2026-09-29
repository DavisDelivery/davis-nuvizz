// test/rollback.test.mjs — the rollback tool's rules.
//
// Every test here names the real-world event it guards. A rollback runs on the worst morning
// of the month, by someone who is not going to read the source first, so the parts that can
// be wrong quietly are the parts that get pinned: the timezone, the refusal to guess, the
// version moving forward while the code moves back, and the changelog row staying mergeable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ZONE, zoneOffsetMs, wallToUtc, wallYmd, formatWall, parseTarget, versionOf, versionFromSubject,
  nextVersion, jsQuote, setAppVersion, insertChangelogRow, rollbackRowText, parseLog, splitAt,
  vendorTouching, SELF_PRESERVE, ensureRollbackScript, parseDropList, prFromSubject, resolveByPR,
  splitConflicts, isVersionOnly, resolveVersionConflicts, dropRowText, GENERATED,
  parseTreeVersions, withTreeVersions, resolveVersion, splitAtCommit, readTreeVersions, conflictCounts,
  dropFileAction, subjectFallbackNote, sameVersionNote, titleNamesNote, LOG as TOOL_LOG, revertFailure, mergeRefusal,
  VERSION_DATES_FILE, VERSION_HISTORY_LOG, datesIn, regenerateVersionDates,
} from '../scripts/rollback.mjs';
import { renderModule, parseVersionLog } from '../scripts/emit-version-dates.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR = 3600000;

// ── THE TIMEZONE, WHICH IS THE WHOLE POINT ───────────────────────────────────

test('"11:59 pm sept 14th" is read in Chad\'s clock, not the server\'s', () => {
  // Chad asked for exactly this moment. Every commit timestamp in the repo is +0000 and
  // Eastern is four hours behind in September, so a tool reading it as UTC would roll back to
  // 7:59pm — four hours and several merges early, with nothing in the output looking wrong.
  const t = parseTarget('2026-09-14 11:59pm');
  assert.equal(t.kind, 'time');
  assert.equal(new Date(t.at).toISOString(), '2026-09-15T03:59:00.000Z');
});

test('the 24-hour and 12-hour spellings of the same moment agree', () => {
  assert.equal(parseTarget('2026-09-14 23:59').at, parseTarget('2026-09-14 11:59pm').at);
});

test('EDT is -4 in September and EST is -5 in January', () => {
  assert.equal(zoneOffsetMs(Date.UTC(2026, 8, 15, 12)), -4 * HOUR);
  assert.equal(zoneOffsetMs(Date.UTC(2026, 0, 15, 12)), -5 * HOUR);
});

test('a wall-clock reading on the spring-forward night still converges', () => {
  // The offset depends on the instant and the instant depends on the offset. A single lookup
  // is an hour out on exactly one night a year — the night nobody would think to test on.
  const ms = wallToUtc({ y: 2026, mo: 3, d: 8, h: 3, mi: 30 });
  assert.equal(formatWall(ms), '2026-03-08 03:30 EDT');
});

test('noon anchoring means "yesterday" cannot land on the wrong day', () => {
  // Stepping back 24h from midnight lands on a DST boundary and can give the same date twice.
  const now = wallToUtc({ y: 2026, mo: 11, d: 1, h: 6 });   // fall-back Sunday, Eastern
  const y = parseTarget('yesterday', now);
  assert.deepEqual(wallYmd(y.at), { y: 2026, mo: 10, d: 31 });
});

test('a bare date means the END of that day, not one minute past midnight', () => {
  // "roll back to sept 14" is a request for Sunday's last good build, not for Saturday night.
  assert.equal(formatWall(parseTarget('2026-09-14').at), '2026-09-14 23:59 EDT');
  assert.equal(formatWall(parseTarget('yesterday', wallToUtc({ y: 2026, mo: 9, d: 15, h: 9 })).at),
    '2026-09-14 23:59 EDT');
});

test('midnight is 00:xx, never 24:xx', () => {
  // Some ICU builds render midnight as hour 24 under hour12:false; unhandled, that throws the
  // offset a day out for one hour every day.
  assert.match(formatWall(wallToUtc({ y: 2026, mo: 9, d: 14, h: 0, mi: 5 })), /^2026-09-14 00:05 /);
});

// ── IT DOES NOT GUESS ────────────────────────────────────────────────────────

test('an unreadable target is an error, never a fallback to "probably today"', () => {
  // The governing rule of CLAUDE.md. A rollback aimed at a date the tool invented is worse
  // than no rollback at all, because the output looks exactly like a correct one.
  for (const bad of ['sept 14', 'last tuesday', 'the good one', '2026-13-01', '2026-09-14 25:00', '']) {
    assert.equal(parseTarget(bad).kind, 'error', `${bad} should not parse`);
  }
});

test('a version is a version and a SHA is a SHA', () => {
  assert.deepEqual(parseTarget('v1.30.2'), { kind: 'version', version: '1.30.2' });
  assert.deepEqual(parseTarget('1.30.2'), { kind: 'version', version: '1.30.2' });
  assert.deepEqual(parseTarget('6f7c9d1'), { kind: 'commit', sha: '6f7c9d1' });
  // Four characters is ambiguous in a repo this size — not a commit.
  assert.equal(parseTarget('6f7c').kind, 'error');
});

// ── PICKING THE COMMIT ───────────────────────────────────────────────────────

const LOG = [
  ['aaa1', Date.UTC(2026, 8, 16, 2, 8) / 1000, 'The panel has a name (v1.36.4) (#949)'],
  ['bbb2', Date.UTC(2026, 8, 15, 10, 31) / 1000, 'A failed route create was firing five POSTs at NuVizz, not one (v1.30.3) (#931)'],
  ['ccc3', Date.UTC(2026, 8, 15, 3, 48) / 1000, 'The row healed and the drill-down did not (v1.30.2) (#930)'],
  ['ddd4', Date.UTC(2026, 8, 14, 20, 0) / 1000, 'Something earlier (v1.30.1) (#927)'],
].map((r) => r.join('')).join('\n');

test('the target is the last commit at or before the moment asked for', () => {
  const commits = parseLog(LOG);
  const { target, undone } = splitAt(commits, parseTarget('2026-09-14 23:59').at);
  assert.equal(target.version, '1.30.2');          // 23:48 EDT — the real answer for Chad's ask
  assert.equal(undone.length, 2);
  assert.deepEqual(undone.map((c) => c.version), ['1.36.4', '1.30.3']);
});

test('a moment older than the whole window answers null rather than the oldest commit it holds', () => {
  const { target } = splitAt(parseLog(LOG), Date.UTC(2020, 0, 1));
  assert.equal(target, null);
});

test('the undone list flags what reaches NuVizz, because rolling back puts those bugs back', () => {
  // Rolling back past v1.30.3 re-introduces five POSTs per failed route create. The tool does
  // not decide that for Chad — it makes sure he reads it first.
  const { undone } = splitAt(parseLog(LOG), parseTarget('2026-09-14 23:59').at);
  assert.deepEqual(vendorTouching(undone).map((c) => c.version), ['1.30.3']);
});

test('a commit with no version in its subject is still a commit', () => {
  const [c] = parseLog('zzz91757000000Correct two stale comments');
  assert.equal(c.version, null);
  assert.equal(c.subject, 'Correct two stale comments');
});

// ── THE VERSION MOVES FORWARD WHILE THE CODE MOVES BACK ──────────────────────

test('a rollback ships under a NEW version, never the old number again', () => {
  // Two bundles claiming one version makes the footer useless for telling them apart, and
  // check-version-bump refuses a backwards APP_VERSION outright — so the rollback PR would
  // not merge. Discovering that at 6:45am is a poor time to discover it.
  assert.equal(nextVersion('1.36.4'), '1.37.0');
  assert.equal(nextVersion('1.36.10'), '1.37.0');
  assert.equal(nextVersion('nonsense'), null);
});

test('the bumped source still satisfies the two release guards', () => {
  const src = "const APP_VERSION = '1.36.4';\nconst VERSION_LOG = [\n  ['1.36.4', 'Old row.'],\n];\n";
  const out = insertChangelogRow(setAppVersion(src, '1.37.0'), '1.37.0', 'ROLLED BACK. Chad said so.');
  assert.match(out, /const APP_VERSION = '1\.37\.0'/);
  // check-version-bump.mjs locates rows with exactly this shape.
  assert.deepEqual([...out.matchAll(/\n\s*\['(\d+\.\d+\.\d+)',/g)].map((m) => m[1]), ['1.37.0', '1.36.4']);
  // check-deploy-fresh.mjs takes the HIGHEST row as the live version; the new row must be it.
  assert.ok(out.indexOf("['1.37.0'") < out.indexOf("['1.36.4'"), 'newest row goes on top');
});

test('an apostrophe in the reason cannot break the bundle', () => {
  // Chad types in prose. A row that ends the JS string early is a build failure on the one
  // morning a build failure cannot be afforded.
  const row = rollbackRowText({
    toVersion: '1.30.2', toWhen: '2026-09-14 23:48 EDT',
    because: "the routing tab's send is broken \\ it won't go", undone: [], paths: [],
  });
  const src = insertChangelogRow("const VERSION_LOG = [\n];\n", '1.37.0', row);
  // Evaluating the array is the test: if the quoting is wrong, this throws.
  const parsed = new Function(`return ${src.slice(src.indexOf('['))}`)();
  assert.match(parsed[0][1], /the routing tab's send is broken \\ it won't go/);
});

test('jsQuote escapes backslashes before quotes, and flattens newlines', () => {
  assert.equal(jsQuote("a\\b'c"), "a\\\\b\\'c");
  assert.equal(jsQuote('one\ntwo'), 'one two');
});

test('setAppVersion refuses a source it does not recognise instead of writing nonsense', () => {
  assert.equal(setAppVersion('nothing here', '1.37.0'), null);
  assert.equal(insertChangelogRow('nothing here', '1.37.0', 'x'), null);
});

// ── THE ROW SAYS THE THING THAT MATTERS ──────────────────────────────────────

test('the changelog row says what a rollback does NOT put back', () => {
  // The dangerous misreading is that a rollback undoes the day's freight. It does not: routes
  // created in NuVizz stay created, and the board in Firestore stays as it is. If the footer
  // does not say so, somebody builds a second truck on top of the first.
  const row = rollbackRowText({
    toVersion: '1.30.2', toWhen: '2026-09-14 23:48 EDT', because: 'routing tab is broken',
    undone: parseLog(LOG).slice(0, 2), paths: [],
  });
  assert.match(row, /CODE ONLY/);
  assert.match(row, /Firestore/);
  assert.match(row, /already sent to NuVizz is still sent/);
  assert.match(row, /1\.36\.4, 1\.30\.3/);          // names what it cost
  assert.match(row, /"routing tab is broken"/);     // and why it happened
  assert.ok(!/\n/.test(row), 'one line, like every other changelog row');
});

test('a scoped rollback says so rather than claiming the whole app', () => {
  const row = rollbackRowText({
    toVersion: '1.30.2', toWhen: 'x', because: 'y', undone: [],
    paths: ['dispatch-map/src/lib/routing-select.js'],
  });
  assert.match(row, /1 path\(s\): dispatch-map\/src\/lib\/routing-select\.js/);
  assert.match(row, /No released versions were undone/);
});

test('versionOf and versionFromSubject read the two places a version hides', () => {
  assert.equal(versionOf("const APP_VERSION = '1.36.4';"), '1.36.4');
  assert.equal(versionOf('no version here'), null);
  assert.equal(versionFromSubject('A thing (v1.30.2) (#930)'), '1.30.2');
  assert.equal(versionFromSubject('A thing (#930)'), null);
});

test('the zone is Eastern and stays Eastern', () => {
  // Named rather than offset-coded, so DST is the library's problem and not a constant that
  // silently goes wrong in November.
  assert.equal(ZONE, 'America/New_York');
});

// ── THE LIFEBOAT SURVIVES THE ESCAPE ─────────────────────────────────────────

test('the rollback tool preserves itself across a rollback that predates it', () => {
  // A whole-app rollback replaces the tree — and to any date before this tool existed, that
  // means deleting the tool. Chad would land on the old code with no way to list versions,
  // roll back further, or roll forward: the one command he needs, gone on the way there.
  assert.ok(SELF_PRESERVE.includes('dispatch-map/scripts/rollback.mjs'));
  assert.ok(SELF_PRESERVE.includes('dispatch-map/test/rollback.test.mjs'));
});

test('Chad\'s rules never go backwards because of a bad deploy', () => {
  // A rollback to Sep 14 would delete the panel-naming rule and the workbench freeze he wrote
  // on the 15th and 16th — silently, as part of "fixing" the very thing they were written
  // about. That is the unasked-for change this whole tool exists to answer.
  assert.ok(SELF_PRESERVE.includes('CLAUDE.md'));
});

test('the CI guards survive the rollback, including the one added after the target', () => {
  // MEASURED against the real Sep-14 tree: check-rwb-untouched.mjs was added on the 16th and is
  // the ONLY script CI invokes by path that is missing there. Rolling it back would delete the
  // Route Workbench guard Chad had just been given — and, because CI calls it by path, turn the
  // rollback PR red so the rollback could not merge at all.
  assert.ok(SELF_PRESERVE.includes('.github'));
  assert.ok(SELF_PRESERVE.includes('dispatch-map/scripts/check-*.mjs'));
});

test('the app itself is NOT on the preserve list — it is the thing being rolled back', () => {
  // A preserve list that grew to cover src/ would be a rollback that rolls nothing back.
  for (const p of ['dispatch-map/src/App.jsx', 'dispatch-map/src', 'dispatch-map/netlify']) {
    assert.ok(!SELF_PRESERVE.includes(p), `${p} must roll back`);
  }
});

test('the npm alias comes back too, so `npm run rollback` is never "missing script"', () => {
  // Restoring the FILE but not the alias makes the tool look gone on the morning the
  // difference matters.
  const old = '{\n  "scripts": {\n    "dev": "vite",\n    "build": "vite build"\n  }\n}\n';
  const fixed = ensureRollbackScript(old);
  assert.equal(JSON.parse(fixed).scripts.rollback, 'node scripts/rollback.mjs');
  assert.equal(JSON.parse(fixed).scripts.build, 'vite build', 'leaves the other scripts alone');
});

test('a package.json that already has the alias is returned untouched', () => {
  const now = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.equal(ensureRollbackScript(now), now);
  assert.equal(JSON.parse(now).scripts.rollback, 'node scripts/rollback.mjs');
});

test('a package.json with no scripts block answers null instead of being guessed at', () => {
  assert.equal(ensureRollbackScript('{"name":"x"}'), null);
});

// ── DROPPING A PR, RATHER THAN RETURNING TO A TIME ───────────────────────────
//
// Chad: "would it be possible to both roll back to a point in time when I knew everything was
// okay if I can't identify the PR that caused the problem and also roll back PRs?" Both, because
// they answer different mornings — and the difference that decides which to reach for is that
// TIME can never conflict and DROP can.

const SEP = String.fromCharCode(1);
const logOf = (rows) => rows.map((r) => r.join(SEP)).join('\n');

test('PR numbers are read in every shape a person types them', () => {
  assert.deepEqual(parseDropList('945'), [945]);
  assert.deepEqual(parseDropList('945,950'), [945, 950]);
  assert.deepEqual(parseDropList(' #945 #950 '), [945, 950]);
  assert.deepEqual(parseDropList('945,945'), [945], 'a repeat is one drop, not two');
  assert.equal(parseDropList('none of them'), null);
});

test('the PR number comes off the squashed merge subject', () => {
  assert.equal(prFromSubject('The Send to NuVizz button was behind a switch (v1.36.0) (#945)'), 945);
  assert.equal(prFromSubject('One tap says which truck a load runs (#942)'), 942);
  assert.equal(prFromSubject('A local commit with no PR'), null);
});

test('PRs are reverted NEWEST first, whatever order they were asked for', () => {
  // Undoing an older PR before a newer one that built on it maximises the conflicts rather
  // than minimising them.
  const commits = parseLog(logOf([
    ['aaa1', Date.UTC(2026, 8, 15, 21, 40) / 1000, 'Box over a sent route (v1.36.3) (#950)'],
    ['bbb2', Date.UTC(2026, 8, 15, 20, 26) / 1000, 'Send button gate (v1.36.0) (#945)'],
    ['ccc3', Date.UTC(2026, 8, 15, 13, 6) / 1000, 'One tap truck (#942)'],
  ]));
  const { found, missing } = resolveByPR(commits, [942, 950, 945]);
  assert.deepEqual(found.map((c) => c.pr), [950, 945, 942]);
  assert.deepEqual(missing, []);
});

test('a PR number that is not on main is named, not guessed at', () => {
  const commits = parseLog(logOf([['aaa1', Date.UTC(2026, 8, 15) / 1000, 'Box (#950)']]));
  const { found, missing } = resolveByPR(commits, [950, 9999]);
  assert.deepEqual(found.map((c) => c.pr), [950]);
  assert.deepEqual(missing, [9999]);
});

// ── THE TWO KINDS OF CONFLICT ────────────────────────────────────────────────
//
// Measured on the three live suspects before this was built: every one conflicts on a plain
// `git revert`, and the conflicts split into exactly two kinds. #950 is all version lines and
// comes out automatically; #945 and #942 carry real code conflicts and must not.

const VER_HUNK = [
  'const x = 1;',
  '<<<<<<< HEAD',
  "const APP_VERSION = '1.38.0';",
  '=======',
  "const APP_VERSION = '1.36.2';",
  '>>>>>>> parent of 0c164a9',
  'const y = 2;',
].join('\n');

const CODE_HUNK = [
  '<<<<<<< HEAD',
  '  if (sendControlState(route)) return null;',
  '=======',
  '  return null;',
  '>>>>>>> parent of 1fc74bd',
].join('\n');

test("a version-line conflict is mechanical and resolves to main's side", () => {
  // APP_VERSION and the changelog collide on almost every parallel merge, carry no behaviour,
  // and this tool rewrites them a few lines later anyway when it bumps the version. Leaving
  // them for Chad to hand-edit at 6:45am would be the wrong kind of caution.
  const { text, remaining } = resolveVersionConflicts(VER_HUNK);
  assert.equal(remaining, 0);
  assert.match(text, /const APP_VERSION = '1\.38\.0';/);
  assert.doesNotMatch(text, /1\.36\.2/, "the reverted PR's version is not restored");
  assert.doesNotMatch(text, /<<<<<<</, 'no markers survive');
});

test('a REAL code conflict is never resolved — it is counted and left alone', () => {
  // Picking a side here ships a behaviour change nobody reviewed, wearing a rollback's name,
  // which is the exact thing this whole feature exists to undo.
  const { text, remaining } = resolveVersionConflicts(CODE_HUNK);
  assert.equal(remaining, 1);
  assert.match(text, /<<<<<<< HEAD/);
  assert.match(text, /sendControlState/);
});

test('one line of real code in a hunk disqualifies the whole hunk', () => {
  // Erring this way on purpose: a hunk wrongly called mechanical is resolved SILENTLY.
  const mixed = ['<<<<<<< HEAD', "const APP_VERSION = '1.38.0';", 'doSomething();',
    '=======', "const APP_VERSION = '1.36.2';", '>>>>>>> x'].join('\n');
  assert.equal(resolveVersionConflicts(mixed).remaining, 1);
});

test('the changelog prose cannot fake a conflict marker', () => {
  // App.jsx rows are megabytes of prose containing quotes, brackets and the word HEAD. A regex
  // over that finds markers that are not there — so this is a parser, not a regex.
  const prose = "  ['1.20.0', 'The bar said <<<<<<< HEAD which is not a conflict at all.'],";
  const { text, remaining } = resolveVersionConflicts(prose);
  assert.equal(remaining, 0);
  assert.equal(text.trim(), prose.trim());
});

test('an unterminated conflict is treated as text, not silently eaten', () => {
  const truncated = '<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;';
  const { text } = resolveVersionConflicts(truncated);
  assert.match(text, /const a = 1;/);
  assert.match(text, /const a = 2;/);
});

test('splitConflicts finds both sides of a hunk', () => {
  const parts = splitConflicts(VER_HUNK).filter((p) => p.ours !== null);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].ours, ["const APP_VERSION = '1.38.0';"]);
  assert.deepEqual(parts[0].theirs, ["const APP_VERSION = '1.36.2';"]);
});

test('version.json is generated, so a conflict in it carries no meaning', () => {
  assert.ok(GENERATED.includes('dispatch-map/public/version.json'));
});

test('isVersionOnly accepts a changelog row and rejects code', () => {
  assert.equal(isVersionOnly({ ours: ["['1.38.0', 'A thing.'],"], theirs: [] }), true);
  assert.equal(isVersionOnly({ ours: ['return null;'], theirs: [] }), false);
  assert.equal(isVersionOnly({ ours: [], theirs: [] }), true);
});

test('a file the dropped PR ADDED and a later PR changed is a real conflict, though git writes no markers', () => {
  // modify/delete: reverting #1033 wants to delete plan-core.mts, which #1037 has since changed.
  // Git marks it conflicted and writes no <<<<<<< at all. Counted by markers alone it scored zero
  // — the dry run under-counted #1033 by its four such files — and --execute would have added the
  // file as it stood, silently keeping what the revert was meant to remove.
  const body = '// plan-core.mts as #1037 left it\nexport const x = 1;\n';
  assert.deepEqual(conflictCounts('dispatch-map/netlify/functions/lib/claude-shadow/plan-core.mts', body), { code: 1, mech: 0, markers: false });
  assert.equal(conflictCounts('dispatch-map/src/x.js', null).code, 1, 'an unreadable conflicted file is a person\'s call too');
});

test('conflictCounts still splits marker hunks into real and mechanical, and the generated file is mechanical', () => {
  assert.deepEqual(conflictCounts('dispatch-map/src/App.jsx', VER_HUNK), { code: 0, mech: 1, markers: true });
  assert.deepEqual(conflictCounts('dispatch-map/src/lib/x.js', `${VER_HUNK}\n${CODE_HUNK}`), { code: 1, mech: 1, markers: true });
  assert.deepEqual(conflictCounts('dispatch-map/public/version.json', null), { code: 0, mech: 1, markers: true });
});

test('the drop row names the PRs and still says CODE ONLY', () => {
  const row = dropRowText({
    dropped: [{ pr: 945, version: '1.36.0' }, { pr: 950, version: '1.36.3' }],
    because: 'the send button broke again', autoResolved: 3,
  });
  assert.match(row, /#945 \(v1\.36\.0\), #950 \(v1\.36\.3\)/);
  assert.match(row, /"the send button broke again"/);
  assert.match(row, /CODE ONLY/);
  assert.match(row, /every other fix that shipped since stays in/);
  assert.match(row, /3 version-line/);
  assert.ok(!/\n/.test(row), 'one line, like every other changelog row');
});

// ── THE VERSION IS WHAT THE FOOTER SHOWED, NOT WHAT THE SUBJECT SAYS ─────────
//
// Sep 26: #1027 (79c8032) merged under the subject "(v1.74.3)" while its App.jsx shipped
// '1.75.1'. v1.74.3 was already #1025 (7b5fe43). Reading versions off subjects, `rollback --
// v1.74.3` planned a rollback to #1027's tree — two hours and three releases later than the build
// Chad saw as v1.74.3 — and printed #1025's changelog headline under #1027's subject, so the wrong
// target read as right. `rollback -- v1.75.1`, the number the footer showed that evening, said no
// commit ships it. The footer reads APP_VERSION out of the tree, so the tool does too.

// The real first-parent history of that evening, newest first, with what each subject says.
const SEP26 = logOf([
  ['54b002f', Date.UTC(2026, 8, 26, 23, 23) / 1000, 'History capture: a write Firestore pushes back is retried with backoff, not dropped (v1.75.2) (#1030)'],
  ['79c8032', Date.UTC(2026, 8, 26, 23, 1) / 1000, 'Shadow map: click a route and you see that route (v1.74.3) (#1027)'],
  ['e0fb9d4', Date.UTC(2026, 8, 26, 22, 24) / 1000, 'Personal logins: each person\'s changes reach NuVizz under their own NuVizz login (v1.75.0) (#1029)'],
  ['c03dd6d', Date.UTC(2026, 8, 26, 21, 37) / 1000, 'Build Panel: the routes to build are a list (v1.74.4) (#1028)'],
  ['7b5fe43', Date.UTC(2026, 8, 26, 21, 7) / 1000, 'Roster pulls a future day as a +/-7d window read down to its day (v1.74.3) (#1025)'],
  ['ffe2efc', Date.UTC(2026, 8, 26, 20, 44) / 1000, 'RWB-CHANGE: yes i want the proposed fix (auto-detected hours on the Compare row, marked auto) (#1026)'],
]);
// …and what each TREE ships (git grep over the six trees on the real repo).
const SEP26_TREES = parseTreeVersions([
  "54b002f:dispatch-map/src/App.jsx:const APP_VERSION = '1.75.2';",
  "79c8032:dispatch-map/src/App.jsx:const APP_VERSION = '1.75.1';",
  "e0fb9d4:dispatch-map/src/App.jsx:const APP_VERSION = '1.75.0';",
  "c03dd6d:dispatch-map/src/App.jsx:const APP_VERSION = '1.74.4';",
  "7b5fe43:dispatch-map/src/App.jsx:const APP_VERSION = '1.74.3';",
  "ffe2efc:dispatch-map/src/App.jsx:const APP_VERSION = '1.74.2';",
].join('\n'));

test('#1027 merged as "(v1.74.3)" but shipped 1.75.1 — "rollback to v1.74.3" lands on #1025, the real one', () => {
  const commits = withTreeVersions(parseLog(SEP26), SEP26_TREES);
  const r = resolveVersion(commits, '1.74.3');
  assert.equal(r.target.sha, '7b5fe43', 'the build the footer called v1.74.3');
  assert.deepEqual(r.undone.map((c) => c.sha), ['54b002f', '79c8032', 'e0fb9d4', 'c03dd6d']);
});

test('v1.75.1 — the number the footer showed that evening — can be named at all', () => {
  const commits = withTreeVersions(parseLog(SEP26), SEP26_TREES);
  const r = resolveVersion(commits, '1.75.1');
  assert.equal(r.missingVersion, undefined);
  assert.equal(r.target.sha, '79c8032');
  // The disagreement is kept, so the plan and --list can say it out loud.
  assert.equal(r.target.subjectVersion, '1.74.3');
  assert.equal(r.target.versionFrom, 'tree');
});

test('a merge subject with no version still gets the version its build showed', () => {
  // #1026's subject is Chad's RWB-CHANGE sentence; the footer on that build read v1.74.2.
  const [c] = withTreeVersions(parseLog(SEP26), SEP26_TREES).filter((x) => x.sha === 'ffe2efc');
  assert.equal(c.version, '1.74.2');
  assert.equal(c.subjectVersion, null);
});

test('a tree that cannot be read falls back to the subject, and says that is where it came from', () => {
  const commits = withTreeVersions(parseLog(SEP26), new Map());
  assert.equal(commits[0].version, '1.75.2');
  assert.equal(commits[0].versionFrom, 'subject');
  const bare = withTreeVersions(parseLog(logOf([['aaa1', 1, 'Correct two stale comments']])), new Map());
  assert.equal(bare[0].version, null);
  assert.equal(bare[0].versionFrom, null, 'no version from anywhere is said as none, not guessed');
});

test('the same number in two separate stretches of history is refused, never picked', () => {
  // Subject-only history (trees unreadable) reproduces Sep 26's shape: 1.74.3 at 79c8032 AND at
  // 7b5fe43, with three other builds between. There is no one answer, so the CLI asks for a commit.
  const commits = withTreeVersions(parseLog(SEP26), new Map());
  const r = resolveVersion(commits, '1.74.3');
  assert.equal(r.target, null);
  assert.equal(r.ambiguousVersion, '1.74.3');
  assert.deepEqual(r.matches.map((c) => c.sha), ['79c8032', '7b5fe43']);
});

test('a commit that did not move APP_VERSION is the same release, and the newest of them is the target', () => {
  // A CLAUDE.md-only merge after v1.74.3 still showed v1.74.3 in the footer. Rolling back to
  // v1.74.3 means the last build that read it; the older one is named, not hidden.
  const commits = withTreeVersions(parseLog(logOf([
    ['3333333', 30, 'Next thing (v1.74.4) (#3)'],
    ['2222222', 20, 'Rules: a CLAUDE.md edit (#2)'],
    ['1111111', 10, 'The release (v1.74.3) (#1)'],
  ])), parseTreeVersions("3333333:p:const APP_VERSION = '1.74.4';\n2222222:p:const APP_VERSION = '1.74.3';\n1111111:p:const APP_VERSION = '1.74.3';"));
  const r = resolveVersion(commits, '1.74.3');
  assert.equal(r.target.sha, '2222222');
  assert.deepEqual(r.sameVersion.map((c) => c.sha), ['1111111']);
  // This window ends at 1111111, so what came before it was not read — no claim that it set the number.
  assert.equal(r.setBy, null);
  // …and a rollback to it names each lost release once, never its own number as "undone".
  const row = rollbackRowText({ toVersion: '1.74.3', toWhen: 'x', because: 'y', paths: [],
    undone: withTreeVersions(parseLog(logOf([['aaaaaaa', 3, 'x'], ['bbbbbbb', 2, 'y'], ['ccccccc', 1, 'z']])),
      parseTreeVersions("aaaaaaa:p:const APP_VERSION = '1.74.4';\nbbbbbbb:p:const APP_VERSION = '1.74.4';\nccccccc:p:const APP_VERSION = '1.74.3';")) });
  assert.match(row, /UNDONE: 1 release\(s\) — 1\.74\.4\./);
});

test('the plan never says the release commit "did not move APP_VERSION" — it names the one that did', () => {
  // A CLAUDE.md-only merge (#2) after the v1.74.3 release (#1), and v1.74.2 before it. The plan used to
  // say every older commit of the run "did not move APP_VERSION", which is false of exactly #1.
  const commits = withTreeVersions(parseLog(logOf([
    ['3333333', 40, 'Next thing (v1.74.4) (#3)'],
    ['2222222', 30, 'Rules: a CLAUDE.md edit (#2)'],
    ['1111111', 20, 'The release (v1.74.3) (#1)'],
    ['0000000', 10, 'Before (v1.74.2) (#0)'],
  ])), parseTreeVersions([
    "3333333:p:const APP_VERSION = '1.74.4';", "2222222:p:const APP_VERSION = '1.74.3';",
    "1111111:p:const APP_VERSION = '1.74.3';", "0000000:p:const APP_VERSION = '1.74.2';",
  ].join('\n')));
  const r = resolveVersion(commits, '1.74.3');
  assert.equal(r.setBy.sha, '1111111', 'the build before it showed v1.74.2, so #1 moved the number');
  const lines = sameVersionNote(r);
  assert.match(lines.join('\n'), /v1\.74\.3 is on 2 commits in a row/);
  assert.match(lines.join('\n'), /it did not move APP_VERSION itself/, 'the target, a CLAUDE.md edit, did not');
  const release = lines.find((l) => l.includes('1111111'));
  assert.match(release, /moved APP_VERSION to v1\.74\.3/);
  assert.doesNotMatch(release, /did not move/);

  // Three in a row: the middle one did not move it; the oldest did.
  const three = withTreeVersions(parseLog(logOf([
    ['ccccccc', 30, 'Docs (#12)'], ['bbbbbbb', 20, 'Rules (#11)'], ['aaaaaaa', 10, 'Release (v2.0.0) (#10)'], ['9999999', 5, 'Old (v1.9.9) (#9)'],
  ])), parseTreeVersions(["ccccccc:p:const APP_VERSION = '2.0.0';", "bbbbbbb:p:const APP_VERSION = '2.0.0';",
    "aaaaaaa:p:const APP_VERSION = '2.0.0';", "9999999:p:const APP_VERSION = '1.9.9';"].join('\n')));
  const t = sameVersionNote(resolveVersion(three, '2.0.0'));
  assert.match(t.find((l) => l.includes('bbbbbbb')), /did not move APP_VERSION/);
  assert.match(t.find((l) => l.includes('aaaaaaa')), /moved APP_VERSION to v2\.0\.0/);

  // When the window ends at the oldest one, what came before is not known — said, not guessed.
  const edge = sameVersionNote(resolveVersion(three.slice(0, 3), '2.0.0'));
  assert.match(edge.find((l) => l.includes('aaaaaaa')), /the oldest in the window read; what came before it was not read \(widen --days\)/);
  assert.doesNotMatch(edge.join('\n'), /moved APP_VERSION to/);
  assert.deepEqual(sameVersionNote(resolveVersion(commits, '1.74.4')), [], 'one commit, nothing to say');
});

test('"widen --days" is offered only when a wider window could answer — not when the build before was read and has no version', () => {
  // 9999999 IS in the window; it just carries no version (its code unreadable, its title silent). A wider
  // window reads the same build again, so telling Chad to widen it sends him round in a circle.
  const commits = withTreeVersions(parseLog(logOf([
    ['ccccccc', 30, 'Docs (#12)'], ['bbbbbbb', 20, 'Rules (#11)'], ['aaaaaaa', 10, 'Release (v2.0.0) (#10)'], ['9999999', 5, 'A merge with no version (#9)'],
  ])), parseTreeVersions(["ccccccc:p:const APP_VERSION = '2.0.0';", "bbbbbbb:p:const APP_VERSION = '2.0.0';", "aaaaaaa:p:const APP_VERSION = '2.0.0';"].join('\n')));
  const r = resolveVersion(commits, '2.0.0');
  assert.equal(r.setBy, null);
  assert.equal(r.unsetWhy, 'unversioned');
  const line = sameVersionNote(r).find((l) => l.includes('aaaaaaa'));
  assert.match(line, /the build before it has no readable version/);
  assert.doesNotMatch(line, /widen --days/);
  // …and the window's own edge still says widen, because there a wider window IS the answer.
  assert.equal(resolveVersion(commits.slice(0, 3), '2.0.0').unsetWhy, 'window');
});

test('git grep output over many trees reads one version per commit and nothing else', () => {
  const m = parseTreeVersions([
    "79c8032aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:dispatch-map/src/App.jsx:const APP_VERSION = '1.75.1';",
    "7b5fe43bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:src/App.jsx:const APP_VERSION = '1.74.3';",   // run from dispatch-map/
    'not a grep line at all',
    "79c8032aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:dispatch-map/src/App.jsx:const APP_VERSION = '9.9.9';",
    '',
  ].join('\n'));
  assert.equal(m.get('79c8032aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), '1.75.1', 'the first line for a tree wins');
  assert.equal(m.get('7b5fe43bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), '1.74.3');
  assert.equal(m.size, 2);
  assert.equal(parseTreeVersions(null).size, 0);
});

test('a commit older than the window is not answered with the window trimmed by one', () => {
  // The old lookup sliced to findIndex(...) — -1 when the commit was not in the window — and so
  // listed every commit but the oldest as "undone". Null tells the CLI to read what lies between.
  const commits = parseLog(LOG);
  assert.equal(splitAtCommit(commits, 'zzz9'), null);
  const r = splitAtCommit(commits, 'ccc3');
  assert.equal(r.target.version, '1.30.2');
  assert.deepEqual(r.undone.map((c) => c.sha), ['aaa1', 'bbb2']);
});

// ON THE REAL REPO, when its history is there. CI's unit job checks out one commit (depth 1), so
// this is skipped there and runs wherever the Sep-26 commits exist — which is where it matters:
// the machine someone runs `npm run rollback` on.
const haveSep26 = (() => {
  try { for (const s of ['79c8032', '7b5fe43']) execFileSync('git', ['cat-file', '-e', `${s}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; }
})();
test('on the real history, v1.74.3 is 7b5fe43 and v1.75.1 is 79c8032', { skip: haveSep26 ? false : 'Sep 26 history not in this checkout' }, () => {
  const out = execFileSync('git', ['log', '--first-parent', '--format=%H\u0001%ct\u0001%s', '7b5fe43~1..79c8032'], { encoding: 'utf8' });
  const commits = parseLog(out);
  const labelled = withTreeVersions(commits, readTreeVersions(commits.map((c) => c.sha)));
  assert.match(resolveVersion(labelled, '1.74.3').target.sha, /^7b5fe43/);
  assert.match(resolveVersion(labelled, '1.75.1').target.sha, /^79c8032/);
});

// ── THE SAME RULES, ON A REAL GIT REPO BUILT HERE ────────────────────────────
//
// CI's unit job checks out ONE commit (actions/checkout, depth 1), so the test above that reads the
// real Sep-26 history is skipped there — and with it, every proof that the tool reads versions out
// of the trees at all. Measured Sep 27: with the tree read switched off, or its pathspec wrong, the
// whole file stayed green at depth 1. So these build a small throwaway repo in the temp dir, shaped
// like the evenings that went wrong, and run the real CLI against it: they run at any depth, touch
// nothing outside that temp dir (origin is the throwaway repo itself), and push nowhere.

const TOOL = fileURLToPath(new URL('../scripts/rollback.mjs', import.meta.url));

/** A git that ignores this machine's own config and repo — plus whatever a test sets on purpose. */
function isolatedGitEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/.test(k)) env[k] = v;
  return {
    ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Rollback Test', GIT_AUTHOR_EMAIL: 'rollback-test@example.invalid',
    GIT_COMMITTER_NAME: 'Rollback Test', GIT_COMMITTER_EMAIL: 'rollback-test@example.invalid',
    ...extra,
  };
}

/**
 * App.jsx as the footer and the changelog see it: a version and its rows, newest first — laid out as
 * the real file is, with other code between APP_VERSION (line 188) and VERSION_LOG (line 241).
 */
const appAt = (versions) => `const APP_VERSION = '${versions[0]}';\n\n// other code\nconst WIDE = 1;\n\nconst VERSION_LOG = [\n${
  versions.map((v) => `  ['${v}', 'Release ${v}.'],`).join('\n')}\n];\n`;

/**
 * A repo whose main is `steps`, oldest first. A step is { subject, files, daysAgo? } (a null body
 * deletes the file) or a function given the git runner, for the shapes a plain commit cannot make.
 * Commits are two days old and ten minutes apart, so they sit inside the tool's 60-day window
 * whenever this runs — unless a step gives `daysAgo`, which dates that commit exactly.
 */
function throwawayRepo(steps) {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-test-'));
  const now = Math.floor(Date.now() / 1000);
  let at = now - 2 * 86400;
  const g = (args, extra = {}) => execFileSync('git', args, {
    cwd: dir, env: isolatedGitEnv(extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const commit = (subject, flags = [], daysAgo = null) => {
    at = daysAgo === null ? at + 600 : now - daysAgo * 86400;
    g(['commit', '-q', '--allow-empty', ...flags, '-m', subject], { GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` });
    return g(['rev-parse', 'HEAD']);
  };
  const write = (files) => {
    for (const [path, body] of Object.entries(files || {})) {
      const full = join(dir, path);
      if (body === null) rmSync(full, { force: true });
      else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, body); }
    }
    g(['add', '-A']);
  };
  g(['init', '-q']);
  g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const shas = [];
  for (const step of steps) {
    if (typeof step === 'function') shas.push(step({ g, write, commit }));
    else { write(step.files); shas.push(commit(step.subject, [], step.daysAgo ?? null)); }
  }
  g(['remote', 'add', 'origin', dir]);
  g(['fetch', '-q', 'origin', 'main']);
  return { dir, g, shas, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The real CLI, run in that repo. Colour codes stripped; stdout and stderr together. */
function runTool(dir, args, extra = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: dir, env: isolatedGitEnv(extra), encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, '') };
}

/** A git config that changes what `git grep` prints — each is a setting people really use. */
const HOSTILE_GREP_CONFIG = {
  GIT_CONFIG_COUNT: '4',
  GIT_CONFIG_KEY_0: 'grep.lineNumber', GIT_CONFIG_VALUE_0: 'true',
  GIT_CONFIG_KEY_1: 'grep.column', GIT_CONFIG_VALUE_1: 'true',
  GIT_CONFIG_KEY_2: 'grep.patternType', GIT_CONFIG_VALUE_2: 'fixed',
  GIT_CONFIG_KEY_3: 'color.grep', GIT_CONFIG_VALUE_3: 'always',
};

/**
 * Sep 26 in miniature. #11 is the real v2.0.1; #12 merged under the title "(v2.0.1)" while its code
 * shipped 2.0.2 (as #1027 did with v1.74.3 / 1.75.1). Then a TRUE merge of a side branch whose own
 * commit says 9.9.9 — a state main never ran, which --first-parent keeps out.
 */
function sep26Repo() {
  return throwawayRepo([
    { subject: 'Base (v2.0.0) (#10)', files: { 'dispatch-map/src/App.jsx': appAt(['2.0.0']) } },
    { subject: 'Roster fix (v2.0.1) (#11)', files: { 'dispatch-map/src/App.jsx': appAt(['2.0.1', '2.0.0']) } },
    { subject: 'Map rework (v2.0.1) (#12)', files: { 'dispatch-map/src/App.jsx': appAt(['2.0.2', '2.0.1', '2.0.0']) } },
    { subject: 'Later (v2.0.3) (#13)', files: { 'dispatch-map/src/App.jsx': appAt(['2.0.3', '2.0.2', '2.0.1', '2.0.0']) } },
    ({ g, write, commit }) => {
      g(['checkout', '-q', '-b', 'side']);
      write({ 'dispatch-map/src/App.jsx': appAt(['9.9.9']) });
      commit('Side experiment (v9.9.9)');
      g(['checkout', '-q', 'main']);
      g(['merge', '-q', '-s', 'ours', '--no-ff', '--no-commit', 'side']);
      write({ 'dispatch-map/src/App.jsx': appAt(['2.0.4', '2.0.3', '2.0.2', '2.0.1', '2.0.0']) });
      return commit('Merge side (v2.0.4) (#14)');
    },
  ]);
}

const planTargetLine = (out) => out.split('\n').find((l) => /Rolling back to/.test(l)) || '';

test('on a real repo at ANY depth: "v2.0.1" is the build whose code said 2.0.1, not the later one whose title claimed it', () => {
  const r = sep26Repo();
  try {
    const [, s11, s12] = r.shas;
    const one = runTool(r.dir, ['v2.0.1']);
    assert.equal(one.code, 0, one.out);
    assert.match(planTargetLine(one.out), new RegExp(`v2\\.0\\.1 .*${s11.slice(0, 7)}`), one.out);
    // #14, #13 and #12 undone — the side branch's own commit is not a state main was ever in.
    assert.match(one.out, /3 commit\(s\) would be undone/);

    const two = runTool(r.dir, ['v2.0.2']);
    assert.equal(two.code, 0, two.out);
    assert.match(planTargetLine(two.out), new RegExp(`v2\\.0\\.2 .*${s12.slice(0, 7)}`), two.out);
    assert.match(two.out, /its merge subject says v2\.0\.1/);

    const list = runTool(r.dir, ['--list']);
    assert.match(list.out, /v2\.0\.2 .*Map rework \(v2\.0\.1\) \(#12\)\s+\(subject says v2\.0\.1\)/);
    assert.doesNotMatch(list.out, /could not be read from their code/);

    // readTreeVersions itself, pointed at that repo.
    const trees = readTreeVersions(r.shas, { cwd: r.dir });
    assert.deepEqual(r.shas.map((s) => trees.get(s)), ['2.0.0', '2.0.1', '2.0.2', '2.0.3', '2.0.4']);
  } finally { r.done(); }
});

test('every build is read from its code however many chunks the tree read is split into', () => {
  // The read runs one `git grep` per chunk of commits. A chunk loop that re-read the first chunk, or
  // stepped one past each chunk's end, would leave builds on their merge title with the file green.
  const r = sep26Repo();
  try {
    for (const chunk of [1, 2, 3, 4, 200]) {
      const trees = readTreeVersions(r.shas, { cwd: r.dir, chunk, cache: new Map() });
      assert.deepEqual(r.shas.map((s) => trees.get(s)), ['2.0.0', '2.0.1', '2.0.2', '2.0.3', '2.0.4'], `chunk ${chunk}`);
    }
    // A chunk size that is not a positive whole number is the default, never a loop that cannot end.
    // NaN first: without the guard it reads nothing and fails here, where 0 or null would hang.
    for (const chunk of [NaN, 1.5, -1, null, 0]) {
      const trees = readTreeVersions(r.shas, { cwd: r.dir, chunk, cache: new Map() });
      assert.equal(trees.size, 5, `chunk ${chunk}`);
    }
  } finally { r.done(); }
});

/**
 * A main of `n` squash-style commits, one version each (7.0.0 … 7.0.n-1), a minute apart and all
 * inside the window. Built with one `git fast-import`, because n commits one at a time is minutes.
 */
function longRepo(n) {
  const dir = mkdtempSync(join(tmpdir(), 'rollback-test-'));
  const g = (args, input) => execFileSync('git', args, {
    cwd: dir, env: isolatedGitEnv(), encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
  g(['init', '-q']);
  g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const start = Math.floor(Date.now() / 1000) - 2 * 86400;
  const data = (s) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  let stream = '';
  for (let i = 0; i < n; i++) {
    stream += `commit refs/heads/main\nmark :${i + 1}\ncommitter Rollback Test <rollback-test@example.invalid> ${start + i * 60} +0000\n`;
    stream += data(`Release ${i} (#${3000 + i})`);
    if (i) stream += `from :${i}\n`;
    stream += `M 100644 inline dispatch-map/src/App.jsx\n${data(appAt([`7.0.${i}`]))}`;
  }
  g(['fast-import', '--quiet'], stream);
  g(['reset', '-q', '--hard', 'main']);
  g(['remote', 'add', 'origin', dir]);
  g(['fetch', '-q', 'origin', 'main']);
  const shas = g(['rev-list', '--reverse', 'main']).split('\n');
  return { dir, shas, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a window longer than one chunk (450 builds, as a full clone holds) is read from code end to end', () => {
  // 60 days of main on a full clone is several hundred commits: PRs #940 to #1041 landed in 12 days.
  const r = longRepo(450);
  try {
    assert.equal(r.shas.length, 450);
    const trees = readTreeVersions(r.shas, { cwd: r.dir, cache: new Map() });
    const wrong = r.shas.map((s, i) => [i, trees.get(s)]).filter(([i, v]) => v !== `7.0.${i}`);
    assert.deepEqual(wrong, [], 'every build labelled with the version in its own tree');
    // …and the CLI, which reads through the same loop with its own cache: nothing fell back to a title.
    const list = runTool(r.dir, ['--list', '--days', '60']);
    assert.equal(list.code, 0, list.out);
    assert.doesNotMatch(list.out, /could not be read from their code|\*\s+[0-9a-f]{7}/, list.out.slice(0, 2000));
    assert.equal((list.out.match(/^\s+\S.* v7\.0\.\d+ +[0-9a-f]{7}  Release /gm) || []).length, 450);
    const plan = runTool(r.dir, ['v7.0.5']);
    assert.equal(plan.code, 0, plan.out.slice(0, 2000));
    assert.match(planTargetLine(plan.out), new RegExp(`v7\\.0\\.5 .*${r.shas[5].slice(0, 7)}`));
    assert.match(plan.out, /444 commit\(s\) would be undone/);
  } finally { r.done(); }
});

test('a git config that reshapes `git grep` output (line numbers, columns, colour, fixed strings) does not switch the tree read off', () => {
  // Sep 27: grep.lineNumber=true alone turned `rollback -- v1.75.1` back into "No commit on main
  // ships v1.75.1" — the Sep 26 answer, word for word — with nothing on screen saying why.
  const r = sep26Repo();
  try {
    const [, s11, s12] = r.shas;
    const one = runTool(r.dir, ['v2.0.1'], HOSTILE_GREP_CONFIG);
    assert.equal(one.code, 0, one.out);
    assert.match(planTargetLine(one.out), new RegExp(s11.slice(0, 7)), one.out);
    const two = runTool(r.dir, ['v2.0.2'], HOSTILE_GREP_CONFIG);
    assert.equal(two.code, 0, two.out);
    assert.match(planTargetLine(two.out), new RegExp(s12.slice(0, 7)), two.out);
  } finally { r.done(); }
});

test('a version only a side branch ever carried is not a point main can be rolled back to', () => {
  const r = sep26Repo();
  try {
    const side = runTool(r.dir, ['v9.9.9']);
    assert.equal(side.code, 2, side.out);
    assert.match(side.out, /No commit on main ships v9\.9\.9/);
  } finally { r.done(); }
});

test('when a build\'s code cannot be read, "no commit ships it" and "it names two points" both say so', () => {
  // #22's tree has no App.jsx, so its version is its title's claim, "(v3.0.0)" — which #20's code
  // also ships, with #21 between. The refusal must say its answer rests on a title.
  const r = throwawayRepo([
    { subject: 'One (v3.0.0) (#20)', files: { 'dispatch-map/src/App.jsx': appAt(['3.0.0']) } },
    { subject: 'Two (v3.0.1) (#21)', files: { 'dispatch-map/src/App.jsx': appAt(['3.0.1', '3.0.0']) } },
    { subject: 'Three (v3.0.0) (#22)', files: { 'dispatch-map/src/App.jsx': null, 'dispatch-map/other.txt': 'x\n' } },
  ]);
  try {
    const amb = runTool(r.dir, ['v3.0.0']);
    assert.equal(amb.code, 2, amb.out);
    assert.match(amb.out, /v3\.0\.0 names more than one point on main/);
    assert.match(amb.out, /Three \(v3\.0\.0\) \(#22\)\s+\(merge title, code not read\)/);
    assert.match(amb.out, /1 of 3 build\(s\) in this window could not be read from their code/);
    const missing = runTool(r.dir, ['v3.0.9']);
    assert.equal(missing.code, 2, missing.out);
    assert.match(missing.out, /No commit on main ships v3\.0\.9/);
    assert.match(missing.out, /1 of 3 build\(s\) in this window could not be read from their code/);
    assert.match(runTool(r.dir, ['--list']).out, /! 1 of 3 build\(s\)/);
  } finally { r.done(); }
});

test('gpg "Signature made" lines from log.showSignature are not read as commits', () => {
  // Every squash merge on main is signed. With log.showSignature=true in someone's git config,
  // `git log` prints gpg's lines between the rows; read as commits they were handed to the tree
  // grep as revisions, it failed for the whole window, and `rollback -- v1.75.1` said "No commit on
  // main ships v1.75.1" again (measured Sep 27, before this fix).
  const out = [
    'gpg: Signature made Sun Sep 27 12:49:54 2026 UTC',
    'gpg:                using RSA key B5690EEEBB952194',
    'gpg: Can\'t check signature: No public key',
    ['158cbf9', '1790513394', 'Driver areas (v1.80.1) (#1038)'].join(SEP),
    'gpg: Signature made Sun Sep 27 04:00:54 2026 UTC',
    ['61a9966', '1790481654', 'Fill my loads follows the Build rules (v1.80.0) (#1032)'].join(SEP),
  ].join('\n');
  assert.deepEqual(parseLog(out).map((c) => c.sha), ['158cbf9', '61a9966']);
  assert.deepEqual(parseLog(['x', 'not a time', 'subject'].join(SEP)), [], 'a row whose time is not a number is not a commit');
});

test('subjectFallbackNote is silent when every version came from code, and counts the ones that did not', () => {
  assert.equal(subjectFallbackNote([{ versionFrom: 'tree' }, { versionFrom: 'tree' }]), null);
  assert.match(subjectFallbackNote([{ versionFrom: 'tree' }, { versionFrom: 'subject' }, { versionFrom: 'subject' }]), /^2 of 3 build\(s\) .* merge titles/);
  assert.equal(subjectFallbackNote(null), null);
});

test('a build with no version anywhere is not called a "merge title" — the note counts it apart', () => {
  // Its code could not be read AND its title names no version (a docs-only merge, say). Saying its
  // version is a merge title named a source that was never there.
  const mixed = subjectFallbackNote([{ versionFrom: 'tree' }, { versionFrom: 'subject' }, { versionFrom: null }]);
  assert.match(mixed, /^1 of 3 build\(s\) in this window could not be read from their code, so their versions are merge titles/);
  assert.match(mixed, /; 1 build\(s\) could not be read from their code and their titles name no version/);
  const onlyNone = subjectFallbackNote([{ versionFrom: 'tree' }, { versionFrom: null }]);
  assert.match(onlyNone, /^1 of 2 build\(s\) could not be read from their code and their titles name no version/);
  assert.doesNotMatch(onlyNone, /merge title/);
});

test('rolling back to a commit older than the 60-day window lists EVERY commit it would undo, not just the window\'s', () => {
  // A and B and C are months old; D and E are this week. The window holds only D and E. The old tool
  // answered a commit outside it with the window trimmed by one — "1 commit(s) would be undone" (E),
  // while --execute would restore B's tree and so also undo C, M and D. Measured on this repo, Sep 27.
  // M is a TRUE merge of a side branch whose own commit (S, "v9.9.9") main never ran: it is not a
  // state being undone, so it is neither listed nor counted — the same first-parent rule as the window.
  const app = (v) => ({ 'dispatch-map/src/App.jsx': appAt(v) });
  const r = throwawayRepo([
    { subject: 'A (v5.0.0) (#40)', daysAgo: 100, files: app(['5.0.0']) },
    { subject: 'B (v5.0.1) (#41)', daysAgo: 90, files: app(['5.0.1', '5.0.0']) },
    { subject: 'C (v5.0.2) (#42)', daysAgo: 80, files: app(['5.0.2', '5.0.1', '5.0.0']) },
    ({ g, write, commit }) => {
      g(['checkout', '-q', '-b', 'side']);
      write(app(['9.9.9']));
      commit('S side experiment (v9.9.9)', [], 75);
      g(['checkout', '-q', 'main']);
      g(['merge', '-q', '-s', 'ours', '--no-ff', '--no-commit', 'side']);
      write(app(['5.0.3', '5.0.2', '5.0.1', '5.0.0']));
      return commit('M merge side (v5.0.3) (#43)', [], 70);
    },
    { subject: 'D (v5.0.4) (#44)', daysAgo: 2, files: app(['5.0.4', '5.0.3', '5.0.2', '5.0.1', '5.0.0']) },
    { subject: 'E (v5.0.5) (#45)', daysAgo: 1, files: app(['5.0.5', '5.0.4', '5.0.3', '5.0.2', '5.0.1', '5.0.0']) },
  ]);
  try {
    const [, B] = r.shas;
    const run = runTool(r.dir, [B]);
    assert.equal(run.code, 0, run.out);
    assert.doesNotMatch(run.out, /Nothing to roll back/);
    assert.match(planTargetLine(run.out), new RegExp(`v5\\.0\\.1 .*${B.slice(0, 7)}`), run.out);
    assert.match(run.out, /4 commit\(s\) would be undone/, run.out);
    const undone = run.out.split('would be undone')[1].split('WHAT THIS DOES NOT')[0];
    // C and M are older than the window and are still named — they are the ones the window never held.
    for (const s of ['E (v5.0.5) (#45)', 'D (v5.0.4) (#44)', 'M merge side (v5.0.3) (#43)', 'C (v5.0.2) (#42)']) assert.ok(undone.includes(s), `${s} listed\n${run.out}`);
    assert.ok(!undone.includes('S side experiment'), `the side branch's own commit is not a state main was in\n${run.out}`);
    assert.ok(!undone.includes('B (v5.0.1)'), 'the target is not "undone"');
  } finally { r.done(); }
});

test('a plan aimed at a build whose code could not be read says its version is the merge title\'s claim, and --list marks it *', () => {
  // #51 deleted App.jsx, so its "(v6.0.1)" is only what its title says. That is the Sep 26 failure
  // mode — a title naming a version — and the plan is the one place that admits it for its target.
  const r = throwawayRepo([
    { subject: 'One (v6.0.0) (#50)', files: { 'dispatch-map/src/App.jsx': appAt(['6.0.0']) } },
    { subject: 'Gap (v6.0.1) (#51)', files: { 'dispatch-map/src/App.jsx': null, 'dispatch-map/other.txt': 'x\n' } },
    { subject: 'Back (v6.0.2) (#52)', files: { 'dispatch-map/src/App.jsx': appAt(['6.0.2', '6.0.1', '6.0.0']) } },
  ]);
  try {
    const [, gap] = r.shas;
    const plan = runTool(r.dir, ['v6.0.1']);
    assert.equal(plan.code, 0, plan.out);
    assert.match(planTargetLine(plan.out), new RegExp(`v6\\.0\\.1 .*${gap.slice(0, 7)}`), plan.out);
    assert.match(plan.out, /\(its tree could not be read — this version is the merge subject's claim\)/, plan.out);
    const list = runTool(r.dir, ['--list']).out;
    assert.match(list, new RegExp(`v6\\.0\\.1\\*\\s+${gap.slice(0, 7)}\\s+Gap`), list);
    assert.match(list, /v6\.0\.2 +[0-9a-f]{7}\s+Back/, 'a build read from its code carries no *');
    // …and a plan whose target WAS read from its code does not say that.
    assert.doesNotMatch(runTool(r.dir, ['v6.0.0']).out, /its tree could not be read/);
  } finally { r.done(); }
});

test('rolling back to a version that sat on a release and a later rules-only merge: the plan names the release as the one that set it', () => {
  const r = throwawayRepo([
    { subject: 'Base (v4.0.0) (#30)', files: { 'dispatch-map/src/App.jsx': appAt(['4.0.0']) } },
    { subject: 'The release (v4.0.1) (#31)', files: { 'dispatch-map/src/App.jsx': appAt(['4.0.1', '4.0.0']) } },
    { subject: 'Rules: a CLAUDE.md edit (#32)', files: { 'CLAUDE.md': '# rules\n' } },
    { subject: 'Next (v4.0.2) (#33)', files: { 'dispatch-map/src/App.jsx': appAt(['4.0.2', '4.0.1', '4.0.0']) } },
  ]);
  try {
    const [, s31, s32] = r.shas;
    const plan = runTool(r.dir, ['v4.0.1']);
    assert.equal(plan.code, 0, plan.out);
    assert.match(planTargetLine(plan.out), new RegExp(`v4\\.0\\.1 .*${s32.slice(0, 7)}`), 'the newest build that showed it');
    assert.match(plan.out, /v4\.0\.1 is on 2 commits in a row/, plan.out);
    assert.match(plan.out, new RegExp(`${s31.slice(0, 7)}  The release \\(v4\\.0\\.1\\) \\(#31\\)  — moved APP_VERSION to v4\\.0\\.1`), plan.out);
    assert.match(plan.out, /1 commit\(s\) would be undone/);
  } finally { r.done(); }
});

// ── DROP: THE SILENT KEEP, ON A REAL REPO ────────────────────────────────────
//
// #2 ADDS lib/a.mts and #3 later changes it. Dropping #2 wants to delete a file #3 changed: a
// modify/delete conflict, which git marks conflicted and writes NO markers into. Counted by markers
// it was nothing — and --execute `git add`ed the file as it stood, reported the drop as built with
// "version-line conflict(s) resolved mechanically", and kept exactly what the drop was for.

function dropRepo() {
  return throwawayRepo([
    { subject: 'Base (v1.0.0) (#1)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.0']), 'dispatch-map/lib/keep.mts': 'export const keep = 1;\n' } },
    { subject: 'Add a (v1.0.1) (#2)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.1', '1.0.0']), 'dispatch-map/lib/a.mts': 'export const a = 1;\n' } },
    { subject: 'Change a (v1.0.2) (#3)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.2', '1.0.1', '1.0.0']), 'dispatch-map/lib/a.mts': 'export const a = 2; // changed later\n' } },
    { subject: 'Add b (v1.0.3) (#4)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.3', '1.0.2', '1.0.1', '1.0.0']), 'dispatch-map/lib/b.mts': 'export const b = 1;\n' } },
  ]);
}

const leftBehind = (r) => ({
  branch: r.g(['rev-parse', '--abbrev-ref', 'HEAD']),
  drops: r.g(['branch', '--list', 'drop/*']),
  status: r.g(['status', '--porcelain']),
});

test('dropping a PR whose added file a later PR changed: the dry run calls it a real conflict', () => {
  const r = dropRepo();
  try {
    const plan = runTool(r.dir, ['--drop', '2']);
    assert.equal(plan.code, 0, plan.out);
    assert.match(plan.out, /✗ 1 real code conflict\(s\)/);
    assert.match(plan.out, /dispatch-map\/lib\/a\.mts {2}\(1\)/);
    assert.doesNotMatch(plan.out, /comes out cleanly/);
    // App.jsx conflicts here too, but only on version lines the tool settles itself. Listed under "a
    // person has to pick a side", it told Chad to hand-edit a file he never has to touch.
    const toSettle = plan.out.split('a person has to pick a side:')[1].split('\n\n')[0];
    assert.doesNotMatch(toSettle, /App\.jsx/, toSettle);
    assert.equal(toSettle.trim().split('\n').length, 1, toSettle);
  } finally { r.done(); }
});

test('…and --execute STOPS on it, leaving main checked out, no drop branch and a clean tree', () => {
  const r = dropRepo();
  try {
    const run = runTool(r.dir, ['--drop', '2', '--execute', '--no-push', '--because', 'the a module broke the board']);
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /#2 has 1 real code conflict\(s\) in dispatch-map\/lib\/a\.mts \(one side deleted this file/);
    assert.doesNotMatch(run.out, /Built drop\//);
    assert.deepEqual(leftBehind(r), { branch: 'main', drops: '', status: '' });
  } finally { r.done(); }
});

test('…including when an earlier PR in the same --execute had already come out clean', () => {
  // Newest first: #4 reverts cleanly, then #2 stops. Nothing of #4's half-done revert may stay.
  const r = dropRepo();
  try {
    const run = runTool(r.dir, ['--drop', '4,2', '--execute', '--no-push', '--because', 'both of these broke the board']);
    assert.equal(run.code, 1, run.out);
    assert.deepEqual(leftBehind(r), { branch: 'main', drops: '', status: '' });
  } finally { r.done(); }
});

test('a drop whose only conflicts are version lines is built, with those lines settled mechanically', () => {
  const r = dropRepo();
  try {
    const plan = runTool(r.dir, ['--drop', '3']);
    assert.match(plan.out, /✓ comes out cleanly \(\d+ version-line conflict\(s\), resolved mechanically\)/, plan.out);
    assert.match(plan.out, /the drop's own CI run is what says it works/, 'clean is about git, never a promise the tests pass');
    const run = runTool(r.dir, ['--drop', '3', '--execute', '--no-push', '--because', 'the change to a broke the board']);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Built drop\/pr-3-/);
    assert.equal(r.g(['show', 'HEAD~1:dispatch-map/lib/a.mts']), 'export const a = 1;', '#3 is undone');
    assert.match(r.g(['show', 'HEAD~1:dispatch-map/src/App.jsx']), /const APP_VERSION = '1\.1\.0'/);
    assert.equal(r.g(['show', 'HEAD~1:dispatch-map/lib/b.mts']), 'export const b = 1;', '#4 stays in');
  } finally { r.done(); }
});

/** merge.conflictStyle set in someone's git config — diff3 and zdiff3 are settings people really use. */
const conflictStyle = (style) => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'merge.conflictStyle', GIT_CONFIG_VALUE_0: style });

test('a git config that writes conflicts in diff3 or zdiff3 style does not turn version lines into "real" conflicts', () => {
  // Those styles add a `||||||| base` section to every conflict. Read as code, it made every App.jsx
  // version hunk a real conflict: `--drop 3` here went from "✓ comes out cleanly" to "✗ 2 real code
  // conflict(s) … dispatch-map/src/App.jsx", and --execute refused (measured Sep 27, before the fix).
  for (const style of ['diff3', 'zdiff3']) {
    const r = dropRepo();
    try {
      const plan = runTool(r.dir, ['--drop', '3'], conflictStyle(style));
      assert.equal(plan.code, 0, `${style}\n${plan.out}`);
      assert.match(plan.out, /✓ comes out cleanly \(\d+ version-line conflict\(s\), resolved mechanically\)/, `${style}\n${plan.out}`);
      assert.doesNotMatch(plan.out, /real code conflict/, `${style}\n${plan.out}`);
      // …and a real one is still real: forcing the style must not hide the modify/delete in #2.
      const two = runTool(r.dir, ['--drop', '2'], conflictStyle(style));
      assert.match(two.out, /✗ 1 real code conflict\(s\)/, `${style}\n${two.out}`);
      const run = runTool(r.dir, ['--drop', '3', '--execute', '--no-push', '--because', 'the change to a broke the board'], conflictStyle(style));
      assert.equal(run.code, 0, `${style}\n${run.out}`);
      assert.match(run.out, /Built drop\/pr-3-/, `${style}\n${run.out}`);
      assert.equal(r.g(['show', 'HEAD~1:dispatch-map/lib/a.mts']), 'export const a = 1;', `${style}: #3 is undone`);
      assert.doesNotMatch(r.g(['show', 'HEAD~1:dispatch-map/src/App.jsx']), /^[<|=>]{7}/m, `${style}: no conflict marker committed`);
    } finally { r.done(); }
  }
});

/** git rerere on — with or without autoUpdate, which also stages what it replays. */
const rerere = (autoUpdate) => ({
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'rerere.enabled', GIT_CONFIG_VALUE_0: 'true',
  GIT_CONFIG_KEY_1: 'rerere.autoUpdate', GIT_CONFIG_VALUE_1: String(autoUpdate),
});

test('a code conflict someone once settled by hand (git rerere) is still a real conflict to the drop, never replayed', () => {
  // #2 and #3 both change the same line. Someone once reverted #2 by hand, kept #3's line, and rerere
  // recorded it. With autoUpdate the probe then saw no conflict at all — "✓ comes out cleanly" — and
  // --execute would have committed that old answer (measured Sep 27, before the fix).
  for (const autoUpdate of [true, false]) {
    const env = rerere(autoUpdate);
    const r = throwawayRepo([
      { subject: 'Base (v1.0.0) (#1)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.0']), 'dispatch-map/lib/c.mts': 'export const x = 1;\n' } },
      { subject: 'Two (v1.0.1) (#2)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.1', '1.0.0']), 'dispatch-map/lib/c.mts': 'export const x = 2;\n' } },
      { subject: 'Three (v1.0.2) (#3)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.2', '1.0.1', '1.0.0']), 'dispatch-map/lib/c.mts': 'export const x = 3;\n' } },
    ]);
    try {
      try { r.g(['revert', '--no-commit', r.shas[1]], env); } catch { /* it conflicts: that is the point */ }
      writeFileSync(join(r.dir, 'dispatch-map/lib/c.mts'), 'export const x = 3; // a person kept #3\n');
      writeFileSync(join(r.dir, 'dispatch-map/src/App.jsx'), appAt(['1.0.2', '1.0.1', '1.0.0']));
      r.g(['rerere'], env);
      try { r.g(['revert', '--abort'], env); } catch { /* nothing in progress */ }
      r.g(['reset', '-q', '--hard', 'main']);
      assert.ok(readdirSync(join(r.dir, '.git', 'rr-cache')).length > 0, 'a resolution was recorded');

      const plan = runTool(r.dir, ['--drop', '2'], env);
      assert.equal(plan.code, 0, plan.out);
      assert.match(plan.out, /✗ 1 real code conflict\(s\)/, `autoUpdate=${autoUpdate}\n${plan.out}`);
      assert.match(plan.out, /dispatch-map\/lib\/c\.mts {2}\(1\)/, `autoUpdate=${autoUpdate}\n${plan.out}`);
      const run = runTool(r.dir, ['--drop', '2', '--execute', '--no-push', '--because', 'two broke the board'], env);
      assert.equal(run.code, 1, `autoUpdate=${autoUpdate}\n${run.out}`);
      // A conflict with markers, named as one — not blamed on a file one side deleted.
      assert.match(run.out, /#2 has 1 real code conflict\(s\) in dispatch-map\/lib\/c\.mts\./, `autoUpdate=${autoUpdate}\n${run.out}`);
      assert.deepEqual(leftBehind(r), { branch: 'main', drops: '', status: '' });
    } finally { r.done(); }
  }
});

test('dropFileAction: the one per-file decision the dry run and --execute share', () => {
  const md = dropFileAction('dispatch-map/lib/a.mts', 'export const a = 2; // changed later\n');
  assert.equal(md.action, 'stop', 'a conflicted file with no markers (modify/delete) is never written');
  assert.equal(md.code, 1);
  assert.equal(dropFileAction('dispatch-map/lib/a.mts', null).action, 'stop', 'nor is one that could not be read');
  assert.equal(dropFileAction('dispatch-map/src/x.js', `${VER_HUNK}\n${CODE_HUNK}`).action, 'stop');
  const ver = dropFileAction('dispatch-map/src/App.jsx', VER_HUNK);
  assert.equal(ver.action, 'write');
  assert.doesNotMatch(ver.text, /^<{7}|^={7}$|^>{7}/m, 'written without markers');
  assert.equal(dropFileAction('dispatch-map/public/version.json', null).action, 'ours');
});

// ── A VERSION NO BUILD EVER SHOWED, NAMED ONLY BY A MERGE TITLE ──────────────
//
// v1.40.0 has a changelog row, but no build's code ever said it: d412457 (#958) moved APP_VERSION
// from 1.39.0 to 1.41.0 in one commit while its title said "(v1.40.0)". Reading the code, the tool
// rightly refuses v1.40.0 — and now says which commit the number came from instead of stopping bare.

test('"rollback v1.40.0" — a number only a merge title names — points at the commit whose title names it', () => {
  const commits = withTreeVersions(parseLog(logOf([
    ['e0e0e0e', 3, 'Next (v1.41.1) (#959)'],
    ['d412457', 2, 'Roll back by PR or by time, with a discrete button in the footer (v1.40.0) (#958)'],
    ['c0c0c0c', 1, 'Before (v1.39.0) (#957)'],
  ])), parseTreeVersions(["e0e0e0e:p:const APP_VERSION = '1.41.1';", "d412457:p:const APP_VERSION = '1.41.0';",
    "c0c0c0c:p:const APP_VERSION = '1.39.0';"].join('\n')));
  assert.equal(resolveVersion(commits, '1.40.0').missingVersion, '1.40.0', 'still refused: no build showed it');
  const lines = titleNamesNote(commits, '1.40.0');
  assert.match(lines[0], /No build's code says v1\.40\.0, but this commit's merge title names it:/);
  assert.match(lines[1], /d412457 .*\(v1\.40\.0\) \(#958\)  — the footer on it read v1\.41\.0/);
  assert.match(lines[2], /npm run rollback -- d412457$/);
  assert.deepEqual(titleNamesNote(commits, '1.39.5'), [], 'a number nothing names gets nothing extra');
  assert.deepEqual(titleNamesNote(commits, '1.41.0'), [], 'a number a build DID show is not "named only by a title"');
});

test('on a real repo: the refusal for a title-only version names that commit and how to reach it', () => {
  const r = throwawayRepo([
    { subject: 'Before (v3.0.0) (#60)', files: { 'dispatch-map/src/App.jsx': appAt(['3.0.0']) } },
    { subject: 'Jump (v3.1.0) (#61)', files: { 'dispatch-map/src/App.jsx': appAt(['3.2.0', '3.1.0', '3.0.0']) } },
    { subject: 'After (v3.2.1) (#62)', files: { 'dispatch-map/src/App.jsx': appAt(['3.2.1', '3.2.0', '3.1.0', '3.0.0']) } },
  ]);
  try {
    const [, jump] = r.shas;
    const run = runTool(r.dir, ['v3.1.0']);
    assert.equal(run.code, 2, run.out);
    assert.match(run.out, /No commit on main ships v3\.1\.0/);
    assert.match(run.out, new RegExp(`${jump.slice(0, 7)} .*Jump \\(v3\\.1\\.0\\) \\(#61\\)  — the footer on it read v3\\.2\\.0`), run.out);
    assert.match(run.out, new RegExp(`npm run rollback -- ${jump.slice(0, 7)}`), run.out);
  } finally { r.done(); }
});

// ── THE FIRST LINE OF DEFENCE AGAINST SIGNATURE LINES, PINNED ON ITS OWN ─────

test('the tool\'s `git log` arguments print only commit rows under log.showSignature=true on a signed commit', () => {
  // parseLog also drops gpg lines, so removing --no-show-signature left every test green. This runs the
  // tool's own LOG against a signed commit, with a gpg that prints what real gpg printed on Sep 27.
  const r = throwawayRepo([{ subject: 'Base (v1.0.0) (#1)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.0']) } }]);
  try {
    const gpg = join(r.dir, 'fake-gpg.sh');
    writeFileSync(gpg, '#!/bin/sh\necho "gpg: Signature made Sun Sep 27 12:49:54 2026 UTC" >&2\necho "gpg: Can\'t check signature: No public key" >&2\nexit 2\n', { mode: 0o755 });
    const raw = `tree ${r.g(['rev-parse', 'HEAD^{tree}'])}\nparent ${r.g(['rev-parse', 'HEAD'])}\n`
      + 'author A <a@example.invalid> 1790000000 +0000\ncommitter A <a@example.invalid> 1790000000 +0000\n'
      + 'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nSigned (v1.0.1) (#2)\n';
    const signed = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: r.dir, env: isolatedGitEnv(), input: raw, encoding: 'utf8' }).trim();
    r.g(['update-ref', 'refs/heads/main', signed]);
    const cfg = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'log.showSignature', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: 'gpg.program', GIT_CONFIG_VALUE_1: gpg };
    const bare = r.g(['log', TOOL_LOG[TOOL_LOG.length - 1], 'main'], cfg);
    assert.match(bare, /gpg: Signature made/, 'the fixture really makes git print signature lines');
    const rows = r.g(['log', ...TOOL_LOG, 'main'], cfg).split('\n');
    assert.deepEqual(rows.filter((l) => l.split('\u0001').length !== 3), [], 'nothing but commit rows');
    assert.equal(rows.length, 2);
  } finally { r.done(); }
});

// ── A DROP GIT CANNOT DO IS NEVER "CLEAN" ────────────────────────────────────

test('a revert git refused outright, leaving nothing conflicted, is a failure — never "comes out cleanly"', () => {
  const merge = { stderr: 'error: commit 7052523 is a merge but no -m option was given.\nfatal: revert failed\n' };
  assert.equal(revertFailure(merge, []), 'commit 7052523 is a merge but no -m option was given.');
  assert.equal(revertFailure(merge, ['dispatch-map/lib/a.mts']), null, 'stopping on conflicts is the ordinary case, counted file by file');
  assert.equal(revertFailure(null, []), null, 'a revert that ran');
  assert.equal(revertFailure({ message: 'Command failed: git revert' }, []), 'Command failed: git revert');
  assert.equal(revertFailure({ stderr: '' }, null), 'git refused the revert');
});

test('the merge-commit refusal names the PR, says why, and says nothing was done', () => {
  const lines = mergeRefusal([{ pr: 14, sha: 'abcdef0123', parents: 2 }]);
  assert.match(lines[0], /^#14 is a merge commit: abcdef0 has 2 parents\.$/);
  assert.match(lines.join(' '), /git revert -m 1/);
  assert.match(lines.join(' '), /Nothing was done\./);
  assert.deepEqual(mergeRefusal([]), []);
});

test('dropping a PR that landed as a true merge commit is refused — the dry run and --execute alike, nothing built', () => {
  // The Sep 27 review measured the old tool on exactly this: "✓ comes out cleanly", then --execute built a
  // "Drop #5" commit that changed only App.jsx and a row saying the PR was dropped. sep26Repo's #14 is one.
  const r = sep26Repo();
  try {
    const merge = r.shas[4];
    const plan = runTool(r.dir, ['--drop', '14']);
    assert.equal(plan.code, 2, plan.out);
    assert.match(plan.out, new RegExp(`✗ #14 is a merge commit: ${merge.slice(0, 7)} has 2 parents\\.`), plan.out);
    assert.doesNotMatch(plan.out, /comes out cleanly/);
    const run = runTool(r.dir, ['--drop', '14', '--execute', '--no-push', '--because', 'the side experiment broke the board']);
    assert.equal(run.code, 2, run.out);
    assert.match(run.out, /#14 is a merge commit/);
    assert.doesNotMatch(run.out, /Built drop\//);
    assert.deepEqual(leftBehind(r), { branch: 'main', drops: '', status: '' });
    // …and a squashed PR in the same repo still drops as before.
    assert.match(runTool(r.dir, ['--drop', '13']).out, /#13/);
  } finally { r.done(); }
});

// ── THE GENERATED DATES FILE: REGENERATED, NEVER A SIDE PICKED ───────────────
//
// src/lib/version-dates.js is written by scripts/emit-version-dates.mjs (prebuild runs it on every deploy)
// and carries no behaviour: the footer's Roll back panel prints "· landed <date>" from it. The drop tool
// counted a conflict in it as a real code conflict — 1 of #1023's on Sep 27 and on Sep 28.

const ISO = (s) => Math.floor(Date.parse(s) / 1000);
const DATES_HEAD = renderModule({}).split('export const VERSION_DATES = {')[0];
const datesFile = (lines) => `${DATES_HEAD}export const VERSION_DATES = {\n${lines.join('\n')}\n};\n`;

test('the tool reads version-dates.js exactly as its generator writes it: the committed file round-trips byte for byte', () => {
  const file = readFileSync(new URL('../src/lib/version-dates.js', import.meta.url), 'utf8');
  const dates = datesIn(file);
  assert.ok(Object.keys(dates).length > 100, 'the real file has hundreds of dated versions');
  assert.equal(renderModule(dates), file);
});

test('a version-dates.js conflict is regenerated from BOTH sides — every dated row kept, no side taken, no history read', () => {
  // #1023's revert on Sep 28: main's side holds the rows, the reverted side none.
  const conflicted = datesFile([
    '<<<<<<< HEAD',
    "  '1.0.2': '2026-09-26T22:00:00.000Z',",
    "  '1.0.1': '2026-09-26T21:00:00.000Z',",
    '=======',
    "  '0.9.9': '2026-09-20T10:00:00.000Z',",
    '>>>>>>> parent of 4f927cf (#1023)',
    "  '1.0.0': '2026-09-26T20:00:00.000Z',",
  ]);
  const r = regenerateVersionDates(conflicted, { render: renderModule, history: () => { throw new Error('history is read only for a dispute'); } });
  assert.equal(r.stop, undefined, r.stop);
  assert.equal(r.text, renderModule({
    '1.0.2': ISO('2026-09-26T22:00:00Z'), '1.0.1': ISO('2026-09-26T21:00:00Z'),
    '1.0.0': ISO('2026-09-26T20:00:00Z'), '0.9.9': ISO('2026-09-20T10:00:00Z'),
  }), 'main\'s rows AND the reverted side\'s row: a version that landed stays landed');
  assert.doesNotMatch(r.text, /^[<=>]{7}/m);
});

test('two sides dating one version differently are settled by git history — and a dispute history cannot settle stops the drop', () => {
  // The real shape: #1023's own copy dated 1.74.0 at 19:08:21 (its branch commit, 6c86404); main's later
  // copy at 19:52:00, the time #1023 merged (4f927cf). The generator lets git history win; so does this.
  const conflicted = datesFile(['<<<<<<< HEAD', "  '1.74.0': '2026-09-26T19:52:00.000Z',", '=======',
    "  '1.74.0': '2026-09-26T19:08:21.000Z',", '>>>>>>> parent', "  '1.73.1': '2026-09-26T16:24:46.000Z',"]);
  let asked = 0;
  const history = () => { asked++; return parseVersionLog(`COMMIT\u00014f927cf\u0001${ISO('2026-09-26T19:52:00Z')}\n+const APP_VERSION = '1.74.0';`); };
  const settled = regenerateVersionDates(conflicted, { render: renderModule, history });
  assert.equal(asked, 1);
  assert.equal(settled.text, renderModule({ '1.74.0': ISO('2026-09-26T19:52:00Z'), '1.73.1': ISO('2026-09-26T16:24:46Z') }));
  const unsettled = regenerateVersionDates(conflicted, { render: renderModule, history: () => ({}) });
  assert.equal(unsettled.text, undefined);
  assert.match(unsettled.stop, /date v1\.74\.0 differently, and git history here does not say which is right/);
  assert.match(regenerateVersionDates(conflicted, { render: renderModule, history: () => null }).stop, /v1\.74\.0/, 'git could not answer at all');
});

test('a version-dates.js conflict with no generator to hand, or no markers, is a person\'s call like any other file', () => {
  const conflicted = datesFile(['<<<<<<< HEAD', "  '1.0.1': '2026-09-26T21:00:00.000Z',", '=======', '>>>>>>> parent']);
  const none = dropFileAction(VERSION_DATES_FILE, conflicted);
  assert.equal(none.action, 'stop');
  assert.match(none.why, /could not be loaded/);
  const regen = (body) => regenerateVersionDates(body, { render: renderModule, history: () => null });
  const ok = dropFileAction(VERSION_DATES_FILE, conflicted, { regenerate: regen });
  assert.equal(ok.action, 'write');
  assert.equal(ok.code, 0);
  assert.equal(ok.regenerated, true);
  // modify/delete — one side deleted the file — carries no markers: still a person's call.
  assert.equal(dropFileAction(VERSION_DATES_FILE, datesFile(["  '1.0.1': '2026-09-26T21:00:00.000Z',"]), { regenerate: regen }).action, 'stop');
  // …and every OTHER file is unchanged by this: a code hunk elsewhere still stops.
  assert.equal(dropFileAction('dispatch-map/src/lib/x.js', CODE_HUNK, { regenerate: regen }).action, 'stop');
});

/** Main where #2 changed lib/x.mts AND added its dated row to version-dates.js, and #3 added the next row
 *  above it — the shape of #1023's revert on Sep 28. The repo carries the real generator, as main does. */
function datesRepo() {
  const gen = readFileSync(new URL('../scripts/emit-version-dates.mjs', import.meta.url), 'utf8');
  const T = { '1.0.0': ISO('2026-09-26T20:00:00Z'), '1.0.1': ISO('2026-09-26T21:00:00Z'), '1.0.2': ISO('2026-09-26T22:00:00Z') };
  const dates = (vs) => renderModule(Object.fromEntries(vs.map((v) => [v, T[v]])));
  return throwawayRepo([
    { subject: 'Base (v1.0.0) (#1)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.0']), 'dispatch-map/scripts/emit-version-dates.mjs': gen,
      [VERSION_DATES_FILE]: dates(['1.0.0']), 'dispatch-map/lib/x.mts': 'export const x = 0;\n' } },
    { subject: 'Change x (v1.0.1) (#2)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.1', '1.0.0']),
      [VERSION_DATES_FILE]: dates(['1.0.1', '1.0.0']), 'dispatch-map/lib/x.mts': 'export const x = 1;\n' } },
    { subject: 'Add y (v1.0.2) (#3)', files: { 'dispatch-map/src/App.jsx': appAt(['1.0.2', '1.0.1', '1.0.0']),
      [VERSION_DATES_FILE]: dates(['1.0.2', '1.0.1', '1.0.0']), 'dispatch-map/lib/y.mts': 'export const y = 1;\n' } },
  ]);
}

test('on a real repo: a drop whose only other conflict is version-dates.js comes out clean, and --execute writes the regenerated file', () => {
  const r = datesRepo();
  try {
    const mainDates = r.g(['show', `main:${VERSION_DATES_FILE}`]);
    const plan = runTool(r.dir, ['--drop', '2']);
    assert.equal(plan.code, 0, plan.out);
    assert.match(plan.out, /✓ comes out cleanly \(\d+ version-line conflict\(s\), resolved mechanically\)/, plan.out);
    assert.match(plan.out, /version-dates\.js: regenerated from both sides by its own generator \(no side taken\)/, plan.out);
    assert.doesNotMatch(plan.out, /real code conflict/);
    const run = runTool(r.dir, ['--drop', '2', '--execute', '--no-push', '--because', 'the change to x broke the board']);
    assert.equal(run.code, 0, run.out);
    assert.match(run.out, /Built drop\/pr-2-/);
    assert.equal(r.g(['show', 'HEAD~1:dispatch-map/lib/x.mts']), 'export const x = 0;', '#2 is undone');
    // Every date main had is still there, written as the generator writes it: dropping #2 does not
    // un-land v1.0.1 from main's history, so its date stays.
    assert.equal(`${r.g(['show', `HEAD~1:${VERSION_DATES_FILE}`])}\n`, mainDates.endsWith('\n') ? mainDates : `${mainDates}\n`);
    assert.doesNotMatch(r.g(['show', `HEAD~1:${VERSION_DATES_FILE}`]), /^[<=>]{7}/m);
  } finally { r.done(); }
});

test('the history read that settles a dispute is the generator\'s own: its parseVersionLog reads every landing', () => {
  const r = datesRepo();
  try {
    const got = parseVersionLog(execFileSync('git', VERSION_HISTORY_LOG, { cwd: r.dir, env: isolatedGitEnv(), encoding: 'utf8', maxBuffer: 1 << 26 }));
    const at = (sha) => Number(r.g(['log', '-1', '--format=%ct', sha]));
    assert.deepEqual(got, { '1.0.0': at(r.shas[0]), '1.0.1': at(r.shas[1]), '1.0.2': at(r.shas[2]) });
  } finally { r.done(); }
});
