// test/routing-autostage-wiring.test.mjs — the finished build must stay CONNECTED to the cards.
//
// lib/build-autostage.js is a pure rule with exactly one caller. Its unit tests pass whether
// or not App.jsx ever calls it, and a rule that ships inert is the failure this repo has
// already had (v1.17.2). These pin the connection and the inputs the decision depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const src = await readFile(fileURLToPath(new URL('../src/App.jsx', import.meta.url)), 'utf8');
const code = src.split('\n').filter((l) => !/^ {2}\['\d+\.\d+\.\d+', /.test(l)).join('\n');

test('a finished loads-bound build stages itself onto the Compare cards', () => {
  assert.ok(/import \{ shouldAutoStageBuild \} from '\.\/lib\/build-autostage\.js';/.test(code), 'the rule module is not imported');
  const eff = /if \(!shouldAutoStageBuild\(\{([\s\S]*?)\}\)\) return;([\s\S]*?)\n  \}, \[/.exec(code);
  assert.ok(eff, 'nothing calls shouldAutoStageBuild — the rule would ship inert');
  for (const [what, re] of [
    ['the job id', /jobId: job\?\.id/],
    ['the job status', /status: job\?\.status/],
    ['loads-bound or not', /hasPlannedLoads: !!plannedLoadsBound/],
    ['how many routes are ready', /routeCount: routesView\.length/],
    ['whether a saved load is open', /viewing,/],
    ['what was already staged', /stagedJobId: autoStagedJobRef\.current/],
  ]) assert.ok(re.test(eff[1]), `the auto-stage decision no longer reads ${what}`);
  assert.ok(/autoStagedJobRef\.current = String\(job\.id\)/.test(eff[2]), 'the job is not remembered — a card closed on purpose would spring back open');
  assert.ok(/stagePlanOntoLoads\(\);/.test(eff[2]), 'the decision is made and then nothing stages');
});

test('the manual "Stage onto Compare cards" button survives — it puts a closed card back', () => {
  assert.ok(/onStagePlan=\{stagePlanOntoLoads\}/.test(code), 'the result panel lost its stage button');
  assert.ok(/onClick=\{onStagePlan\}/.test(code), 'the stage button no longer calls anything');
});
