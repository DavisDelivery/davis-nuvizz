// lib/rollback-targets.js — what the footer's rollback panel offers, and what each choice costs.
//
// Chad: "Let's put the button for this ui discretely by the version in the footer."
//
// WHY THE FOOTER IS THE RIGHT PLACE, operationally. The footer version is already the thing he
// checks to answer "is what I'm looking at the thing that just deployed" — CLAUDE.md has a whole
// section on it. So it is where his eye goes the moment he suspects a deploy broke something,
// which makes it the one spot a rollback affordance costs nothing to find on a bad morning.
//
// PURE, AND IT READS WHAT THE BUNDLE ALREADY HAS. Every version and its note are in VERSION_LOG,
// compiled into the running bundle — so the panel needs NO network call to tell him what shipped
// and what going back would cost. That is the CLAUDE.md "build the free diagnostic first" rule:
// the answer was already on the device, nobody had ever shown it to him this way.
//
// WHAT IT DELIBERATELY CANNOT DO. It offers a version, never a promise. A tab can be running a
// build older than the site (the reload banner exists for exactly that), so the list here is what
// THIS BUNDLE knows — which is why the panel labels the current row from APP_VERSION rather than
// claiming to know what production serves.
import { headlineFromEntry } from './build-update.js';
import { VERSION_DATES } from './version-dates.js';

/** PURE: ascending numeric compare, so 1.36.10 sorts above 1.36.9 rather than below it. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * PURE: the rollback menu — every version this bundle knows, newest first, with the count of
 * releases that going back to it would undo.
 *
 * SORTED HERE RATHER THAN TRUSTED. CLAUDE.md asks for VERSION_LOG newest-first and nothing
 * enforced it; by 2026-08-19 the array had drifted to 0.56.0, 0.55.9, 0.56.2, 0.56.1 and the
 * deploy watchdog reported the wrong live version twice in one afternoon (v0.56.4). A panel
 * offering "roll back to v1.31.0" while showing the wrong cost beside it would be the same bug
 * with a button attached, so the order is computed, not assumed.
 *
 * `landedAt` is the generated version -> ISO map (scripts/emit-version-dates.mjs). It is a
 * parameter rather than a bare import so the tests can drive it, and it is LAST so the existing
 * positional `rollbackTargets(log, current, 3)` calls keep working.
 *
 * `undoes` counts releases strictly NEWER than the row — which is exactly what a rollback to it
 * would remove. The current row is 0, and rows above current are 0 too: you cannot roll back to
 * something you are not yet running, and the panel refuses to offer them rather than pretending.
 */
export function rollbackTargets(versionLog, currentVersion, limit = 12, landedAt = VERSION_DATES) {
  if (!Array.isArray(versionLog)) return [];
  const rows = versionLog
    .filter((r) => Array.isArray(r) && /^\d+\.\d+\.\d+$/.test(String(r[0])))
    .map(([version, note]) => ({ version, note }));
  rows.sort((a, b) => compareVersions(b.version, a.version));

  // HOISTED OUT OF THE LOOP. It was a findIndex per row, which was invisible at 12 rows and is
  // 775 x 775 string compares now that the panel builds the whole log and windows it afterwards.
  const currentAt = rows.findIndex((x) => x.version === currentVersion);

  const out = [];
  for (const [i, r] of rows.entries()) {
    const current = r.version === currentVersion;
    // Everything above the current row is a version this bundle is NOT running. Offering to
    // "roll back" to one would be a roll FORWARD wearing the wrong word, so it is not offered.
    const ahead = compareVersions(r.version, currentVersion) > 0;
    out.push({
      version: r.version,
      headline: headlineFromEntry(r.note) || null,
      // WHEN IT LANDED — null is a real answer, not a gap to paper over. v1.40.0 has a changelog
      // row but never existed as a running APP_VERSION (one commit moved the line 1.39.0 → 1.41.0),
      // so no source can date it. The row prints no date rather than borrowing a neighbour's.
      at: landedAt?.[r.version] || null,
      undoes: ahead ? 0 : Math.max(0, i - currentAt),
      current,
      selectable: !current && !ahead,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HOW FAR BACK THE PANEL LOOKS.
//
// Chad, with the shipped panel open: "this is not enough history to roll back what if i need to
// roll back 24-48 hrs".
//
// HE IS RIGHT AND THE ROW COUNT WAS THE WRONG PRIMITIVE. Measured on the committed dates:
// twelve rows is 17.5 HOURS in this repo, so the panel could not reach either number he named.
// It is not a number that was too small — it is the wrong unit. This repo ships several versions
// a day on a busy day and none on a quiet one, so ANY fixed row count means a different amount
// of history every week, and the week it is smallest is a bad week, which is the week he opens
// this panel. He asks in hours ("roll the app back to 11:59 pm sept 14th"), so it answers in
// hours.
//
// TODAY'S NUMBERS, so the next session does not re-measure: 24h = 18 rows, 48h = 37 rows,
// 7 days = 60 rows (every version this build has a date for), All = 775.
// ---------------------------------------------------------------------------

/**
 * The ranges the panel offers. 48h is the default because the two mistakes are not symmetrical:
 * a window too SHORT costs him the feature on the morning he needs it — the exact failure he
 * just hit — and a window too LONG costs him a scroll. So it errs long.
 *
 * `All` exists so there is no ceiling at all any more, which is the actual complaint. Rows past
 * the dated range print no date (see `at` above), which is honest but hard to reason about, so it
 * is the last option rather than the default.
 */
export const ROLLBACK_RANGES = [
  { id: '24h', label: '24h', hours: 24 },
  { id: '48h', label: '48h', hours: 48 },
  { id: '7d', label: '7 days', hours: 24 * 7 },
  { id: 'all', label: 'All', hours: Infinity },
];

export const DEFAULT_ROLLBACK_RANGE = '48h';

/** PURE: the hours behind a range id, falling back to the 48h default for anything unknown. */
export function rangeHours(id) {
  const hit = ROLLBACK_RANGES.find((r) => r.id === id);
  return hit ? hit.hours : ROLLBACK_RANGES.find((r) => r.id === DEFAULT_ROLLBACK_RANGE).hours;
}

/**
 * PURE: the slice of `targets` that falls inside `hours` of `now`, newest first.
 *
 * MEASURED FROM NOW, NOT FROM THE NEWEST RELEASE. "the last 48 hours" is a statement about his
 * clock, not about the deploy cadence. That matters on a quiet Sunday: if nothing shipped for
 * three days a from-newest reading would still hand back a full window, quietly redefining the
 * words on the button.
 *
 * WHICH IS WHY `minRows` EXISTS. With the window measured from now, a quiet stretch makes it
 * genuinely empty — and a rollback panel offering nothing to roll back to is broken, not
 * truthful. The floor is the old cap: whatever the window says, the last `minRows` are always
 * offered.
 *
 * AN UNDATED ROW RIDES ITS NEIGHBOURS. Versions sort newest-first and land in that order, so a
 * row with no date that sits ABOVE the oldest in-window row is itself in-window and is kept.
 * One below it is older than the boundary and is not. That is why this takes the LAST in-window
 * index rather than filtering row by row — filtering would punch holes in the list wherever a
 * date is missing, and a gap in a rollback list reads as "that version does not exist".
 */
export function windowRows(targets, { hours = 48, minRows = 12, now = Date.now() } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  if (!Number.isFinite(hours)) return targets;                     // 'All' — no ceiling
  const cutoff = now - hours * 3600 * 1000;
  let last = -1;
  for (const [i, t] of targets.entries()) {
    const at = t?.at ? Date.parse(t.at) : NaN;
    if (Number.isFinite(at) && at >= cutoff) last = i;
  }
  return targets.slice(0, Math.max(minRows, last + 1));
}

/**
 * PURE: the one-line summary under the range chips — how many versions are on screen and how far
 * back they reach.
 *
 * It exists because the chips alone cannot answer the only question he is really asking: DOES
 * THIS LIST REACH THE MORNING THAT WORKED? A chip reading "48h" is a promise about the window;
 * `oldestAt` is the fact about the list, and when a missing date or the minRows floor makes those
 * two disagree, the fact is the one on screen.
 */
export function windowSummary(shown, { total = 0 } = {}) {
  const n = Array.isArray(shown) ? shown.length : 0;
  const dated = (Array.isArray(shown) ? shown : []).filter((t) => t?.at);
  return {
    count: n,
    total,
    oldestAt: dated.length ? dated[dated.length - 1].at : null,
    oldestVersion: n ? shown[n - 1].version : null,
    all: n > 0 && n >= total,
  };
}

/**
 * PURE: the body of the rollback request that reaches GitHub.
 *
 * Written for whoever picks it up — a person or a coding agent — to act on WITHOUT asking a
 * follow-up question: the exact command, the reason in Chad's words, and the standing warning
 * about what a rollback does not touch. An issue that needs a clarifying round trip is an issue
 * that sits unactioned while the board is still wrong.
 */
export function rollbackRequestBody({ version, undoes, reason, appVersion, buildCommit, at }) {
  return [
    `**Chad asked for a rollback from the app footer.**`,
    '',
    `> ${String(reason || '').trim() || '(no reason given)'}`,
    '',
    `| | |`,
    `| --- | --- |`,
    `| Roll back to | **v${version}** |`,
    `| Releases undone | ${undoes} |`,
    `| Requested from | v${appVersion || '?'}${buildCommit ? ` · ${buildCommit}` : ''} |`,
    `| At | ${at || new Date().toISOString()} |`,
    '',
    '### Run this',
    '',
    '```bash',
    `npm run rollback -- v${version}`,
    `npm run rollback -- v${version} --execute --because "${String(reason || 'rollback requested from the footer').replace(/"/g, "'")}"`,
    '```',
    '',
    'The first is a dry run and moves nothing — **read what it says the rollback costs before**',
    '**running the second.** If a single PR is the suspect, `--drop <pr>` is the smaller tool and',
    'keeps every other fix that shipped since.',
    '',
    '### This is CODE ONLY',
    '',
    'Firestore is untouched — the board, address overrides, dispatcher notes, receiving hours and',
    'suppression flags all stay exactly as they are. Anything already sent to NuVizz is still sent.',
    'A rollback is not an undo button on the day\'s freight.',
  ].join('\n');
}
