// lib/flag-rows.mts — the one place a capped board row is unpacked.
//
// PURE. No Firestore, no email, no clock. Imported by the email selector, the overnight SMS
// selector and the flag-history recorder, none of which may depend on each other.
//
// WHY THIS EXISTS. board-flags collapses a rule+tier bucket past its cap (RED_CAP 12,
// AMBER_CAP 25, CRITICAL_CAP 40) into ONE summary row carrying stopNbr: null, so the badge
// stays a number a person will actually read. Every consumer then drops that row, because a
// row with no stop number is not a stop — which is right for the batch the cap was built for
// (a wall of un-geocodable addresses is a data-quality job, not thirty emergencies) and
// catastrophic for freight the model predicts will miss its window.
//
// Measured on the shipped engine, not argued: TWELVE red hours_risk rows email twelve people
// and THIRTEEN email NOBODY; 25 ambers yield 25 candidates and 26 yield zero. board-flags.js
// calls thirteen late stops "an ordinary bad day on a 700-stop board", so this was always
// reachable, and it fails in the flattering direction — one calm summary line is
// pixel-identical to a calm board.
//
// THAT MEASUREMENT WAS TAKEN WHEN RED EMAILED, and since 2026-09-02 it does not (flag-alert
// ALERT_MIN_TIER=critical). It is left standing because it still describes the two consumers
// that DID not change — the overnight texts, whose bar is still red, and the flag-history
// recorder, which records every tier. For the inbox the cliff simply moved to the critical
// bucket, whose cap is CRITICAL_CAP 40: forty criticals email forty people and forty-one
// email nobody. That is a far worse day than thirteen, and it is the day this module must
// hold up on — the failure is identical and the flattering direction is the same.
//
// The summary row carries its constituents' facts and this is the ONLY place that unpacks
// them. It is a module of its own because there are three consumers of the same capped list,
// and a fix applied to one of three is exactly how the inbox and the audit came to disagree
// about the same bad day: emails went out on a collapsed day while flag history recorded
// nothing, so the worst day of the week was invisible to the record it was measured from.
//
// DO NOT delete `collapsedRows` as "unused by any renderer". Nothing renders it. It is
// load-bearing for the inbox, the texts and the audit.
export function flattenForConsumers(rows: any[]): any[] {
  return (rows || []).flatMap((r: any) => (
    r?.collapsed && Array.isArray(r?.collapsedRows) && r.collapsedRows.length
      ? r.collapsedRows
      : [r]
  ));
}

/**
 * EVERYTHING THIS BOARD ACTUALLY PREDICTED, including what the panel chose not to show.
 *
 * `rows` is the panel's list: capped, and with a driverless route's hours_risk rows already
 * superseded by the single no-driver card. That is right for a screen and for an inbox, and
 * WRONG for the audit — flag history only keeps `hours_risk`, so folding the superseded rows
 * away deleted the entire record for the routes in the most trouble: no first sighting, no
 * lead time, no worst tier, no outcome. A route with no rows and a route with no problems
 * read identically in that table.
 *
 * Read this ONLY from the recording path. The alert and text selectors take `rows`, because
 * one situation is still one card and one email.
 */
export function auditRows(flags: any): any[] {
  return [...(flags?.rows || []), ...(flags?.suppressedRows || [])];
}
