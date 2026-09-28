// src/lib/uat-mode-bar.js — WHAT THE UAT MODE BAR SAYS, AS A PURE FUNCTION.
//
// Chad, 2026-09-28: "maybe we have a planning mode in the uat where it makes the days orders all
// unplanned so you have a live version essentially of uat and then have a planning mode where
// everything on any given day is in unplanned."
//
// The bar is the only thing on the UAT site that tells you WHICH board you are looking at, and
// the two boards differ in exactly the way that matters to a dispatcher: in one, a stop reads
// planned because production planned it; in the other, nothing is planned. A screen that is
// ambiguous about that is worse than no switch at all, so the words live here, where a test can
// read them, and the component only draws them.
//
// Three states, never two: LIVE, PLANNING, and UNKNOWN (the switch could not be read). Unknown is
// said as unknown — the bar never shows a mode nobody observed.

/**
 * PURE. The bar's content for a server state.
 *
 * @param {{ ok?: boolean, available?: boolean, planning?: boolean, set_at?: string|null, set_by?: string|null, error?: string } | null} state
 * @returns {{ mode: 'live'|'planning'|'unknown'|'off', title: string, detail: string, action: string|null, next: boolean|null }}
 */
export function uatModeView(state) {
  if (!state) {
    return { mode: 'unknown', title: 'UAT', detail: 'Reading which board this is…', action: null, next: null };
  }
  if (state.available === false) {
    return {
      mode: 'off', title: 'UAT · LIVE',
      detail: 'A copy of production. Planning mode is switched off on this site (UAT_PLANNING_MODE=off).',
      action: null, next: null,
    };
  }
  if (state.ok === false || typeof state.planning !== 'boolean') {
    return {
      mode: 'unknown', title: 'UAT · MODE UNKNOWN',
      detail: `The Live / Planning switch could not be read${state.error ? ` (${state.error})` : ''}. The board shows what is stored.`,
      action: null, next: null,
    };
  }
  const by = state.set_by ? ` by ${state.set_by}` : '';
  if (state.planning) {
    return {
      mode: 'planning', title: 'UAT · PLANNING MODE',
      detail: `Every day's orders show unplanned and every load empty — plan from scratch. Production is not touched.${by ? ` Switched on${by}.` : ''}`,
      action: 'Back to live', next: false,
    };
  }
  return {
    mode: 'live', title: 'UAT · LIVE',
    detail: 'A copy of production, picked up every 10 minutes.',
    action: 'Planning mode', next: true,
  };
}
