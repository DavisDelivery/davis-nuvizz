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
 * `undoes` counts releases strictly NEWER than the row — which is exactly what a rollback to it
 * would remove. The current row is 0, and rows above current are 0 too: you cannot roll back to
 * something you are not yet running, and the panel refuses to offer them rather than pretending.
 */
export function rollbackTargets(versionLog, currentVersion, limit = 12) {
  if (!Array.isArray(versionLog)) return [];
  const rows = versionLog
    .filter((r) => Array.isArray(r) && /^\d+\.\d+\.\d+$/.test(String(r[0])))
    .map(([version, note]) => ({ version, note }));
  rows.sort((a, b) => compareVersions(b.version, a.version));

  const out = [];
  for (const [i, r] of rows.entries()) {
    const current = r.version === currentVersion;
    // Everything above the current row is a version this bundle is NOT running. Offering to
    // "roll back" to one would be a roll FORWARD wearing the wrong word, so it is not offered.
    const ahead = compareVersions(r.version, currentVersion) > 0;
    out.push({
      version: r.version,
      headline: headlineFromEntry(r.note) || null,
      undoes: ahead ? 0 : Math.max(0, i - rows.findIndex((x) => x.version === currentVersion)),
      current,
      selectable: !current && !ahead,
    });
    if (out.length >= limit) break;
  }
  return out;
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
