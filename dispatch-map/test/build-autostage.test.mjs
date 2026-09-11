// test/build-autostage.test.mjs — a finished Build opens its own Compare cards.
//
// The rule this pins is not "call stage when done". It is the four ways that
// sentence goes wrong on a dispatcher's screen: staging a trucks-mode build onto
// loads that do not exist, staging on the render before the routes are there (and
// so never staging at all), re-opening a card the dispatcher just closed, and
// re-staging a SAVED load from last Tuesday onto today's board.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoStageBuild } from '../src/lib/build-autostage.js';

const done = {
  jobId: 'job_1', status: 'done', hasPlannedLoads: true, routeCount: 2,
  viewing: false, stagedJobId: null,
};

test('a finished loads-bound build stages itself — the cards are the point', () => {
  assert.equal(shouldAutoStageBuild(done), true);
});

test('a build still running stages nothing', () => {
  for (const status of ['queued', 'running', 'error', null]) {
    assert.equal(shouldAutoStageBuild({ ...done, status }), false, `status ${status}`);
  }
});

test('TRUCKS MODE DOES NOT STAGE — an abstract profile is not a NuVizz load', () => {
  // No loadNbr/loadId to bind a card to; the result panel is the deliverable and
  // Save-as-plan is the write. Staging here would invent loads nobody picked.
  assert.equal(shouldAutoStageBuild({ ...done, hasPlannedLoads: false }), false);
});

test('IT WAITS FOR THE ROUTES — staging the empty render would spend the one shot', () => {
  // routesView is [] until routeState is seeded off the result. Staging then adds
  // nothing AND marks the job staged, so the cards would never open at all.
  assert.equal(shouldAutoStageBuild({ ...done, routeCount: 0 }), false);
});

test('ONCE PER BUILD — a card the dispatcher closes stays closed', () => {
  assert.equal(shouldAutoStageBuild({ ...done, stagedJobId: 'job_1' }), false);
  // The next build is a different job and opens its own cards.
  assert.equal(shouldAutoStageBuild({ ...done, jobId: 'job_2', stagedJobId: 'job_1' }), true);
});

test('a job with no id never auto-stages — nothing could remember that it had', () => {
  assert.equal(shouldAutoStageBuild({ ...done, jobId: null }), false);
  assert.equal(shouldAutoStageBuild({ ...done, jobId: '' }), false);
});

test('VIEWING A SAVED LOAD IS READ-ONLY — yesterday\'s plan does not stage onto today', () => {
  assert.equal(shouldAutoStageBuild({ ...done, viewing: true }), false);
});

test('called with nothing at all, it stages nothing', () => {
  assert.equal(shouldAutoStageBuild(), false);
  assert.equal(shouldAutoStageBuild({}), false);
});
