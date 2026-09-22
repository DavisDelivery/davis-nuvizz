// lib/flag-sweep-cadence.mts — HOW OFTEN THE FLAG SWEEPS LOOK, AND THE WAY BACK.
//
// Chad, 2026-09-22: "SO RUN THE FLAG SWEEPS RIGHT AFTER OUR SCANS SO THEY ARE MUCH MORE
// CURRENT NOT ONCE PER HOUR AS THE FLAG SWEEPS ARE FREE AND COST NOTHING WITH NUVIZZ."
//
// He is right on the cost and right on the consequence. The evening/overnight sweep ran
// `0 0-11 * * *` — once an hour — while the SCANNER that feeds it runs `*/5` and acts on its
// own plan (planned/unplanned every 20 minutes in the small hours, every 15 through the 5am
// rollout). So the board could change at 4:47a and nothing would look at it until 5:00a, and
// everything the 4:47 scan brought in arrived on one phone in one breath at five o'clock.
// That is the clump Chad asked about, and it is a property of the CADENCE, not of the board:
// replaying the same board at 2:00a, 4:00a, 5:00a and 6:00a produces an identical flag set.
//
// WHAT IT COSTS TO LOOK MORE OFTEN: nothing at the vendor. These sweeps read Firestore only
// — the stop index, customer_notes, the travel cache — and make ZERO NuVizz calls, which is
// the whole reason the cost rule in CLAUDE.md does not apply to them.
//
// WHY THERE IS NO "HAS THE BOARD CHANGED" GATE, deliberately. It was the obvious economy and
// it buys a new way for the alerts to go silent: a stale or unreadable change-stamp would
// stand the sweep down, and a quiet feature looks exactly like a working one. The sweep is
// idempotent by construction — createDocIfAbsent claims one message per subject per board
// day — so looking again is safe, and the only thing a wasted look costs is a few hundred
// Firestore reads. Cheap is the correct trade against silence.
//
// THE WAY BACK (CLAUDE.md, "Ship it so it can be put back"). This ALTERS behaviour that
// already worked, so it gets a named env switch rather than a revert: FLAG_SWEEP_EVERY_TICK
// =off stands the extra fires down and reproduces the old cadence — hourly on the evening
// sweep, every twenty minutes on the day sweep — with no redeploy. It covers BOTH sweeps, so
// there is no half-reverted state where one is current and the other is not.

/** House shape: default ON, an explicit off-word turns it off, anything malformed leaves it
 *  ON — a typo in an env var must never silently re-silence a safety alert. */
export function everyTickEnabled(env: any = process.env): boolean {
  const v = String(env?.FLAG_SWEEP_EVERY_TICK ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no'].includes(v);
}

/** The cron step both sweeps now fire on, in minutes. Named so the stand-down window below
 *  can never drift from it. */
export const TICK_MIN = 5;

/**
 * PURE. Should a fire landing at this ET minute do the work, or stand down?
 *
 * ON (the default) every fire works — that is the whole change.
 *
 * OFF reproduces the old cadence on the new cron by letting through only the fire that lands
 * in the first tick of each legacy step: `etMin % stepMin < TICK_MIN`. That is accurate to
 * within one five-minute tick rather than to the second, and it is accurate ENOUGH because
 * it is the REVERT path, not the primary one — a minute-exact gate would silently no-op on
 * the cron jitter this repo has already been bitten by once (see the scanner's elapsed-time
 * gate, which exists because a `minute === 0` test dropped every fire that landed at :01).
 *
 * A malformed or absent stepMin lets the fire through. Standing a sweep down is the
 * dangerous direction, so every uncertain case resolves toward looking.
 */
export function sweepDue(etMin: number, stepMin: number, env: any = process.env): boolean {
  if (everyTickEnabled(env)) return true;
  if (!Number.isFinite(etMin) || etMin < 0) return true;
  if (!Number.isFinite(stepMin) || stepMin <= TICK_MIN) return true;
  return (etMin % stepMin) < TICK_MIN;
}

/** The legacy step for each sweep, in minutes — only ever consulted on the OFF path. */
export const LEGACY_STEP_MIN = { evening: 60, day: 20 };
