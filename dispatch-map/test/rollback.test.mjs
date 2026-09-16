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
} from '../scripts/rollback.mjs';

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
