// test/roster-load-numbers-guard.test.mjs
//
// THE ROSTER SCAN HAS THE LOAD NUMBERS — AND NOTHING IN THIS REPO MAY FORGET IT AGAIN.
//
// Chad, 2026-09-27: "Why is it so hard to get this through to you that the roster scan produces the
// load numbers!!!!!! I've told you this 10 times and every time you find out that it is true."
// Chad, 2026-09-28: "make sure no part of app or agent or orchestrator ever has to ask about the
// roster scan not producing load ids we get hung up on that too often and blocks progress."
//
// A paragraph did not hold (it was in code comments since 2026-09-15 and the question came back
// anyway), so this is the enforced form, the same way the version-bump and the RWB boundary are:
//   1. every document an orchestrator or agent reads first carries the rule;
//   2. the roster normaliser really does return a load NUMBER per load (the fact itself, pinned);
//   3. none of the sentences that repeated the mistake appears anywhere in the code or docs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeLoads } from '../netlify/functions/lib/nuvizz-loads.mts';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const MARK = 'THE ROSTER SCAN HAS THE LOAD NUMBERS';

const AGENT_DOCS = [
  'CLAUDE.md',                                   // every Claude session and subagent
  'ORCHESTRATION.md',                            // "every orchestrator and agent reads this first"
  'dispatch-map/HANDOFF.md',                     // the session handoff
  'dispatch-map/ORCHESTRATOR-scan-schedule.md',  // the scan brief an orchestrator is handed
  'load-scan/README.md',                         // the dock scanner's rules
  'CODE-REVIEW-FIXES.md',                        // the review worklist's standing rules
];

for (const doc of AGENT_DOCS) {
  test(`${doc} carries the rule: the roster has the load numbers, settled`, () => {
    const t = read(doc);
    assert.ok(t.includes(MARK), `${doc} must say "${MARK}"`);
    assert.match(t, /settled|SETTLED/, `${doc} must say it is settled`);
  });
}

test('CLAUDE.md says it is never asked and names the free read', () => {
  const t = read('CLAUDE.md');
  assert.match(t, /SETTLED — NEVER ASK IT AGAIN/);
  assert.match(t, /nuvizz-loads-roster\?date=…&cacheOnly=1/);
  assert.match(t, /The one thing that is never an ask: whether the roster has load numbers/, 'the carve-out sits in ASK FOR THE CALL');
});

test('THE FACT, pinned: a roster pull returns a load NUMBER and id for every load', () => {
  const grid = {
    filterData: [{ loadId: { columnName: 'Load Id' }, 'route.name': { columnName: 'Route Name' }, 'route.loadNbr': { columnName: 'Load Number' }, status: { columnName: 'Status' }, trips: { columnName: 'No Of Trips' } }],
    values: [
      ['6ab29f8f96c7f0f093e02599', 'MARCUS', 'DAVIS000204645', 'Draft', '13'],
      ['6ab29f8a5b97db56e47e857d', 'TERRANCE', 'DAVIS000204590', 'Draft', '0'],
    ],
  };
  const loads = normalizeLoads(grid);
  assert.equal(loads.length, 2);
  assert.deepEqual(loads.map((l) => [l.name, l.loadNbr, l.loadId]), [
    ['MARCUS', 'DAVIS000204645', '6ab29f8f96c7f0f093e02599'],
    ['TERRANCE', 'DAVIS000204590', '6ab29f8a5b97db56e47e857d'],
  ]);
});

// The sentences that ARE the mistake. CLAUDE.md quotes them on purpose, in its banned list; nothing
// else in the repo may say them.
const BANNED = [
  /load number (?:isn't|is not) available/i,
  /(?:don't|do not) know which load/i,
  /doesn't carry the load, so it takes a per-order read/i,
  /roster (?:has no|does not carry|doesn't carry) (?:a )?load (?:number|id)/i,
  /load number IS the route name/,
];
const SCAN_ROOTS = ['dispatch-map/netlify/functions', 'dispatch-map/src', 'load-scan/src', 'load-scan/netlify', 'ORCHESTRATION.md', 'dispatch-map/HANDOFF.md', 'dispatch-map/ORCHESTRATOR-scan-schedule.md', 'load-scan/README.md', 'CODE-REVIEW-FIXES.md', 'docs'];
const SKIP = /node_modules|\/dist\/|\.test\.mjs$/;
const TEXT = /\.(?:mts|ts|js|jsx|mjs|md)$/;
function walk(p, out) {
  let st;
  try { st = statSync(join(REPO, p)); } catch { return out; }
  if (st.isDirectory()) { for (const n of readdirSync(join(REPO, p))) walk(join(p, n), out); return out; }
  if (TEXT.test(p) && !SKIP.test(p)) out.push(p);
  return out;
}

test('no code or document outside CLAUDE.md\'s banned list says the load number is unknowable', () => {
  const files = SCAN_ROOTS.flatMap((r) => walk(r, []));
  assert.ok(files.length > 50, 'the walk found the code');
  const hits = [];
  for (const f of files) {
    const text = readFileSync(join(REPO, f), 'utf8');
    for (const re of BANNED) {
      const m = re.exec(text);
      if (m) hits.push(`${relative(REPO, join(REPO, f))}: "${m[0]}"`);
    }
  }
  assert.deepEqual(hits, [], 'banned sentence(s) found — the roster HAS the load numbers (CLAUDE.md)');
});
