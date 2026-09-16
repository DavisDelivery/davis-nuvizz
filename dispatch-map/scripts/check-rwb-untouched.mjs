#!/usr/bin/env node
// Fail a PR that edits the ROUTE WORKBENCH while claiming to work on the BUILD PANEL.
//
// WHY THIS EXISTS, and it is the third time the same shape has cost Chad a morning.
//
// Chad, 2026-09-16: "Tons of changes were made to RWB today that i didn't ask for … you made
// changes to the map and rwb when you were only supposed to be working in this panel. I want
// you to name this panel so going forward when i ask you to work on it you work on it and
// nothing else as you introduced major bugs to route work bench."
//
// CLAUDE.md has said the workbench is frozen since the evening before. It said it in prose,
// and prose is only as strong as the attention of whoever is reading it at 1am — which is
// exactly the argument check-version-bump.mjs was written on, after the version rule was
// skipped twice on the morning it was added. A rule a tired agent can skip is not a rule.
// This makes it a test.
//
//   node scripts/check-rwb-untouched.mjs <baseRef>
//
// It reads the diff against the merge base. If a changed line in App.jsx names anything on
// the WORKBENCH SURFACE below, the PR fails — UNLESS a commit on the branch carries the
// approval token, which is the mechanical form of "Chad names the change, in that request":
//
//   RWB-CHANGE: <what he actually asked for, in his words>
//
// The token has to be typed by a person who has his sentence in front of them. That is the
// whole mechanism: it cannot be satisfied by good intentions, only by quoting him.
//
// DELIBERATELY NARROW, for the same reason the version guard is: a guard that fires on work
// it should not care about gets switched off, and then it protects nothing. It looks at ONE
// file (App.jsx — the workbench and the map live there) and only at identifiers that are the
// workbench's own. Editing the Build Panel, lib/routing-select.js, lib/stop-equipment.js or
// anything under netlify/ is invisible to it.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// maxBuffer: App.jsx is over a megabyte and execFileSync defaults to a 1MB pipe, so a bare
// `git diff` on it dies with ENOBUFS and the guard fails every PR for a reason that has
// nothing to do with the workbench. Same lesson as check-version-bump.mjs.
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const APP = 'dispatch-map/src/App.jsx';
export const APPROVAL_TOKEN = 'RWB-CHANGE:';

/**
 * THE WORKBENCH SURFACE — every identifier checked against the shipped App.jsx before it was
 * listed, because a guard naming a symbol that no longer exists is decoration that reads as
 * protection. Grouped by the sentence in CLAUDE.md each one belongs to.
 */
export const RWB_SURFACE = {
  'staging a stop onto a card, and releasing it': [
    'stagePlanOntoLoads', 'wbStagedRef', 'wbRemoveStop', 'wbRemoveAllStops', 'seedStagedCard',
  ],
  'what Send / Save writes and stamps': [
    'onPanelSave', 'markSaved', 'syncBoardAfterSave', 'sendControlState',
  ],
  'what the map paints for a planned, staged or sent stop': [
    'effectiveRouteInfo', 'drawnStops', 'plannedMuted', 'polylinesRef', 'dayRoutePolylinesRef',
    'stopMarkerIcon', 'routePaintSource',
  ],
  'what box / lasso / ninja select picks up and skips': [
    'addEnclosed', 'handleSelectPoint', 'toggleStopGroup', 'ninjaMode',
  ],
  'what a card counts, says and does when it closes': [
    'RoutingWorkbenchCard', 'guardedClose', 'guardedCloseAll', 'closeWbRoute', 'closeAllWb',
  ],
  'the Routes rail and the controls beside it': [
    'RoutingRoutesPanel', 'NewRouteButton',
  ],
};
export const SURFACE_OF = new Map(
  Object.entries(RWB_SURFACE).flatMap(([why, names]) => names.map((n) => [n, why])),
);

/** PURE: the workbench identifiers a set of changed lines names, with the line and the why. */
export function surfaceHits(changedLines) {
  const out = [];
  for (const { n, text } of changedLines) {
    for (const [name, why] of SURFACE_OF) {
      if (new RegExp(`\\b${name}\\b`).test(text)) out.push({ name, why, n, text: text.trim().slice(0, 110) });
    }
  }
  return out;
}

/**
 * PURE: the ADDED and REMOVED lines of a unified diff, with their new-file line numbers.
 *
 * Context lines are skipped on purpose. A hunk that merely sits NEAR the workbench is not a
 * workbench change, and counting context would make every edit within twenty lines of a
 * marker effect fail — which is the over-firing that gets a guard disabled.
 */
export function changedLinesOf(diff) {
  const out = [];
  let n = 0;
  for (const line of String(diff || '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { n = Number(h[1]); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) { out.push({ n, text: line.slice(1) }); n++; continue; }
    if (line.startsWith('-')) { out.push({ n, text: line.slice(1) }); continue; }
    if (line.startsWith(' ')) { n++; }
  }
  // THREE SHAPES NAME THE WORKBENCH WITHOUT MOVING IT, and every one of them would make this
  // guard cry on work it should not care about — which is how a guard gets switched off.
  // Found by running the matcher over real history: it fired on my own v1.34.0, whose only
  // hit was the shared `import { … } from './lib/routing-select.js'` line, extended to add a
  // helper for the Box|Tractor toggle. Behaviour unchanged; the guard would have blocked it.
  //   • a changelog row, which quotes whatever the release was about
  //   • the import line, where every routing-select symbol shares one statement
  //   • a comment; a rule being explained is not a rule being changed, and the code line
  //     that DOES change carries its own hit.
  return out.filter((l) => {
    const t = l.text.trim();
    if (/^\['\d+\.\d+\.\d+', /.test(t)) return false;
    if (/^(import|export)\b.*\bfrom\s+['"]/.test(t)) return false;
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
    return true;
  });
}

/** PURE: has someone quoted Chad's ask into a commit message on this branch? */
export function approvedIn(messages) {
  for (const m of String(messages || '').split('\n')) {
    const i = m.indexOf(APPROVAL_TOKEN);
    if (i >= 0 && m.slice(i + APPROVAL_TOKEN.length).trim().length >= 8) return m.trim();
  }
  return null;
}

function main(baseRef) {
  if (!baseRef) { console.error('usage: check-rwb-untouched.mjs <baseRef>'); process.exit(2); }
  const files = git('diff', '--name-only', `${baseRef}...HEAD`).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!files.includes(APP)) { console.log('✓ App.jsx untouched — the Route Workbench cannot have moved'); return; }

  const hits = surfaceHits(changedLinesOf(git('diff', '-U0', `${baseRef}...HEAD`, '--', APP)));
  if (!hits.length) { console.log('✓ App.jsx changed, but no Route Workbench surface was touched'); return; }

  const approval = approvedIn(git('log', '--format=%B', `${baseRef}..HEAD`));
  const byName = new Map();
  for (const h of hits) { if (!byName.has(h.name)) byName.set(h.name, h); }
  const lines = [...byName.values()].map((h) => `    ${APP}:${h.n}  ${h.name}  — ${h.why}\n        ${h.text}`);

  if (approval) {
    console.log(`✓ Route Workbench change, approved in a commit message:\n    ${approval}\n\n  Touched:\n${lines.join('\n')}`);
    return;
  }
  console.error(`
✗ THIS PR EDITS THE ROUTE WORKBENCH.

  The Routing screen has two halves and only one of them is yours by default:

    THE BUILD PANEL   steps 1-4 on the left (desktop) / the Setup tab (phone), the Build
                      button, and the rules and server path behind it. Work here freely.
    THE ROUTE WORKBENCH   the Compare cards, Send/Save, the map's paint, the selection
                      tools, the Routes rail. FROZEN — see CLAUDE.md.

  ${byName.size} workbench identifier(s) appear on lines this PR changed:

${lines.join('\n')}

  If Chad asked for this, quote him in a commit message on the branch:

      ${APPROVAL_TOKEN} <his words>

  e.g.  git commit --allow-empty -m "${APPROVAL_TOKEN} my create route button is gone"

  If he did not, take the change out and put it in the PR as a proposal instead.
`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);
