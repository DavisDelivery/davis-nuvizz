// src/lib/build-autostage.js
//
// PURE: does a finished Build pop its routes onto the Compare cards by itself?
//
// Chad: "when this gets done building it should pop the routes up in the compare
// panels so i can see them."
//
// SECTION 3'S BUILD WAS THE ODD ONE OUT. The Engine's two solvers on this same
// screen have always staged the moment they returned — runEngineDraft calls
// stageEngineDraft(data), runEngineCleanup calls stageCleanupPlan(data), and the
// cards are simply THERE. Build alone stopped at a summary in the right rail and
// a "Stage onto Compare cards →" button that had to be found and pressed. Until
// it was, the routes existed only as engine-coloured lines on the map: nothing to
// reorder, no driver picker, no Save — the card IS the editable object, and the
// plan was not on one.
//
// Five conditions. Each is a live bug if it is dropped:
//
//  1. status === 'done'. A queued, running or errored job has no routes.
//  2. hasPlannedLoads. Only a LOADS-BOUND build (section 2 → "My loads") carries
//     a NuVizz identity per route. A trucks-mode build is abstract profiles with
//     no loadNbr/loadId, so there is no card for it to land on and the result
//     panel stays the deliverable. Staging one would invent loads.
//  3. routeCount > 0. routesView is EMPTY for a render or two after the job lands
//     — routeState is seeded by its own effect off the result — and staging then
//     stages nothing while spending the once-per-job token below, which would
//     leave the cards permanently unopened. Wait for the routes to exist.
//  4. A jobId we have not staged yet. Without this the effect re-fires on every
//     render, and — worse — a card the dispatcher CLOSES would spring back open,
//     with no way to get rid of it short of discarding the plan.
//  5. Not viewing. A saved load open in the result panel is a read-only record of
//     a past plan; re-staging it onto today's cards would stage yesterday's work.
//
// The manual button stays exactly where it is: staging is idempotent (an id
// already on the card is skipped), so it remains the way to put the plan back
// after closing a card on purpose.

/**
 * @param {object} a
 * @param {string|null} a.jobId         routing_jobs doc id of the build (job.id)
 * @param {string|null} a.status        job.status — 'queued' | 'running' | 'done' | 'error'
 * @param {boolean} a.hasPlannedLoads   the build was bound to picked NuVizz loads
 * @param {number} a.routeCount         routesView.length — built routes ready to stage
 * @param {boolean} a.viewing           a SAVED load is open (read-only), not a live build
 * @param {string|null} a.stagedJobId   the job id already auto-staged, if any
 * @returns {boolean} stage it now
 */
export function shouldAutoStageBuild({
  jobId = null,
  status = null,
  hasPlannedLoads = false,
  routeCount = 0,
  viewing = false,
  stagedJobId = null,
} = {}) {
  if (viewing) return false;
  if (status !== 'done') return false;
  if (!hasPlannedLoads) return false;
  if (!(Number(routeCount) > 0)) return false;
  if (!jobId) return false;                 // no id = no memory = it would re-fire forever
  return String(stagedJobId ?? '') !== String(jobId);
}
