// lib/plan-overlay.js
//
// The PURE decision behind the confirmed-save plan overlay (App.jsx applyPlanOverlay).
// One overlay entry + one fetched board row → what to do with that entry.
//
// Why the overlay exists: the instant a Save is CONFIRMED against NuVizz, the plan is recorded
// locally per stop and painted over every board read on this device, so scan/cache lag can
// never make a save the dispatcher just watched confirm LOOK unbuilt.
//
// Why it needs a way out that isn't agreement: a planned entry only "agrees" with a row that is
// planned on the same load, so a row that comes back UNPLANNED reads as lag — the exact thing
// the overlay paints over. Plan a stop, then unplan it in the portal, and the device repaints
// it onto the load until the TTL lapses, through any number of scans. That is how KAI WONG
// (007…1372) stayed on Trevor's SUW 5 in Compare while NuVizz held it unplanned. The overlay
// is localStorage-only, so the contradiction is invisible to every other dispatcher, and a
// build run off that board plans against a stop the load does not hold.
//
// The release is `overtaken`: a scan that ran AFTER the save has seen the world after the save,
// so its answer is a verdict rather than lag. That is not blind trust in a raw feed — the
// server adjudicates first (60-minute board-write grace, then a /stop/info demotion verify that
// refuses to unplan a planned row on the saved-search list's word alone).

// AGREEMENT is the real release; the TTL is a runaway cap. 12h because the overnight scanner
// pause (e.g. "orders paused until 10 AM") must not outlast it — a stop the server-side patch
// happened to miss would otherwise revert to unplanned with no scan to take over.
export const PLAN_OVERLAY_TTL_MS = 12 * 60 * 60 * 1000;

// A scan that merely OVERLAPPED the save can stamp a completion time just after it while having
// READ NuVizz just before. That scan is lag, not verdict, so it must not release the entry —
// hence a margin rather than a bare timestamp comparison.
export const PLAN_OVERLAY_SCAN_MARGIN_MS = 5 * 60 * 1000;

/**
 * @param entry  {at, isPlanned, loadNbr?} — the confirmed save, as recorded locally.
 * @param row    the fetched board row for the same stopNbr.
 * @param opts   now (ms), scannedAt (feed last_scanned_at, ISO or null), ttlMs, marginMs.
 * @returns 'expired' | 'agree' | 'overtaken' | 'paint'
 *   expired/agree/overtaken → drop the entry and use the row as fetched.
 *   paint                   → the row is stale; paint the confirmed plan over it.
 */
export function planOverlayAction(entry, row, opts = {}) {
  const {
    now = Date.now(), scannedAt = null,
    ttlMs = PLAN_OVERLAY_TTL_MS, marginMs = PLAN_OVERLAY_SCAN_MARGIN_MS,
  } = opts;
  const savedAt = Number(entry?.at);
  if (!entry || !Number.isFinite(savedAt) || !(now - savedAt < ttlMs)) return 'expired';

  const agrees = entry.isPlanned
    // A planned entry agrees only with a row planned on the SAME load — a cross-load move must
    // keep painting until the board shows the destination, not merely "planned somewhere".
    ? (!!row?.isPlanned && String(row?.loadNbr || row?.routeName || '') === String(entry.loadNbr))
    : !!row?.isUnplanned;
  if (agrees) return 'agree';

  const scanAt = scannedAt ? Date.parse(scannedAt) : NaN;
  if (Number.isFinite(scanAt) && scanAt - savedAt > marginMs) return 'overtaken';
  return 'paint';
}
