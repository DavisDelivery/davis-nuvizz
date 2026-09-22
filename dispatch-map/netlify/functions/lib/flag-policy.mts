// lib/flag-policy.mts — the server-side switch for the early-close floor.
//
// Chad, 2026-09-22: "i want it to flag at 30 mins late for anything that closes at 11 am or
// before." The rule itself is PURE and lives in src/lib/board-flags.js (earlyCloseRed), so
// the browser's board and the sweeps' texts are judged by one piece of code and cannot drift
// apart. This file holds only the way back.
//
// WHAT THE SWITCH DOES, SAID EXACTLY, because a half-reverted state is worse than none:
// FLAG_EARLY_CLOSE=off removes the floor from THE SWEEPS — the texts and the emails — and
// the shipped bundle keeps showing the stronger tier on the board until a deploy carries the
// revert. That asymmetry is deliberate rather than an oversight. The switch exists for one
// sentence ("stop texting me about these at 2am"), and a dispatcher standing at the board
// should still SEE that a dock closing at 11:00 is predicted half an hour past its close.
// Silencing a phone is a policy decision; un-seeing a problem is not the same decision.
//
// House shape: default ON, an explicit off-word turns it off, anything malformed leaves it
// ON — a typo in an env var must never silently re-silence a safety alert.

/** `undefined` = the shipped policy (computeBoardFlags' default); `null` = rule off. */
export function earlyCloseOpt(env: any = process.env): null | undefined {
  const v = String(env?.FLAG_EARLY_CLOSE ?? '').trim().toLowerCase();
  return ['off', '0', 'false', 'no'].includes(v) ? null : undefined;
}
