// lib/scan-press-verdict.js
//
// WHAT THE DISPATCHER IS TOLD AFTER PRESSING "Scan now" — the whole decision, in one pure
// function, because every wrong version of this sentence has cost somebody a stale board.
//
// THE EVENT (2026-09-10, 8:01pm). Chad: "Manual Refresh button is not working. Timed out and
// said it wouldn't update." The run ledger showed a manual run that started at 20:01, recorded
// zero NuVizz calls, wrote no board and was still open seven minutes later — a vendor request
// with no deadline had hung the whole scan. The button waited its ~60 seconds and then said
// "Scan running — the board will refresh automatically". It was not running, and the board
// never refreshed.
//
// THE OTHER HALF OF THE SAME BUG is that the sentence was ALSO wrong when everything worked:
// full scans measured 41.4s / 49.2s median / 72.3s max over one day's ledger, and the button
// gave up at ~60s — so roughly one press in seven reported a working scan as a failure.
//
// FOUR OUTCOMES, and they are not interchangeable to the person holding the phone:
//   landed   — the board moved. Say nothing; the screen already shows it.
//   refused  — the gate turned this press away (viewer role, kill switch). The SERVER's
//              sentence is used verbatim: it was written for this reader and re-wording it here
//              would give one failure two vocabularies.
//   running  — a scan is genuinely in flight and younger than the stall threshold. Honest
//              reassurance, with the age in it so "still running" is checkable rather than
//              soothing.
//   stalled  — a run started and has not finished long past the time a scan takes, or no run
//              was recorded at all. This is the one that used to masquerade as `running`, and
//              it is the one a dispatcher must act on: nothing has been written, so the board
//              on screen is as old as its own timestamp says.
//
// Ages arrive from the SERVER as durations (startedAgeSec), never as timestamps: the board is
// read on phones whose clocks are minutes out, and comparing their `Date.now()` against a
// server stamp is how a press comes to be blamed for somebody else's refusal.

/** A run in flight longer than this is not "running" to a dispatcher — it is not coming.
 *  Measured full scans are 41-72s; three minutes is comfortably past the slowest one. */
export const SCAN_STALL_AFTER_SEC = 180;

/** How long the press keeps watching before it must give a final answer. */
export const SCAN_POLL_WINDOW_SEC = 195;

/** How long the button itself stays busy. Past the slowest scan measured in the run ledger
 *  (72.3s), holding the spinner tells a dispatcher less than releasing it with an honest
 *  sentence does — the poll carries on either way. */
export const SCAN_SPINNER_SEC = 80;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const ago = (sec) => (sec == null ? 'a moment' : sec < 90 ? plural(sec, 'second', 'seconds') : plural(Math.round(sec / 60), 'minute', 'minutes'));

/**
 * PURE.
 * @param {object} o
 * @param {boolean} o.updated        the polled board's last_scanned_at moved since the press
 * @param {object|null} o.refusal    lastScanRefusal, already matched to THIS press by the caller
 * @param {object|null} o.run        scanRun from the board feed (server-computed ages)
 * @param {number} o.waitedSec       how long this press has been waiting (a browser DURATION)
 * @returns {{kind: 'landed'|'refused'|'running'|'stalled', message: string|null, done: boolean}}
 *          `done` = stop polling now; the answer will not improve by waiting.
 */
export function scanPressVerdict({ updated, refusal = null, run = null, waitedSec = 0 } = {}) {
  if (updated) return { kind: 'landed', message: null, done: true };

  if (refusal) {
    return {
      kind: 'refused',
      message: `Scan did not run. ${refusal.message || `Refused (${refusal.reason || 'no reason given'}).`}`,
      done: true,
    };
  }

  // Did a run start at or after this press? Both sides are durations, so no clock is compared
  // with another clock. The slack absorbs the round trip and the poll interval.
  const age = run && Number.isFinite(Number(run.startedAgeSec)) ? Number(run.startedAgeSec) : null;
  const mine = age != null && age <= waitedSec + 20;

  if (mine && run.finished) {
    // It ran and finished, and the board still did not move. That is a real answer, not a wait.
    const failed = run.outcome && run.outcome !== 'ok';
    return {
      kind: failed ? 'stalled' : 'landed',
      message: failed
        ? `Scan finished with an error${run.error ? `: ${String(run.error).slice(0, 140)}` : ''}. The board still shows its last good data — try again, or check Diagnostics.`
        : null,
      done: true,
    };
  }

  if (mine && age < SCAN_STALL_AFTER_SEC) {
    return {
      kind: 'running',
      message: `Scan is still running (started ${ago(age)} ago) — the board refreshes itself the moment it lands.`,
      done: false,
    };
  }

  if (mine) {
    return {
      kind: 'stalled',
      message: `Scan started ${ago(age)} ago and has not finished — nothing has been written, so the board is still showing its last scan. The scheduled scan will try again shortly; press again if you need it sooner.`,
      done: true,
    };
  }

  // No run of ours anywhere. Either the press never reached the scanner, or the ledger is
  // unreadable. Both mean the same thing to a dispatcher: do not trust this board as fresh.
  return {
    kind: 'stalled',
    message: 'No scan was recorded for this press — nothing has been written, so the board is still showing its last scan. Press again; if it keeps happening, check Diagnostics.',
    done: waitedSec >= SCAN_POLL_WINDOW_SEC,
  };
}
