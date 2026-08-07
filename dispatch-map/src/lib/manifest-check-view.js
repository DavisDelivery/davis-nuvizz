// src/lib/manifest-check-view.js
//
// Pure display rules for the Manifest check tab. Kept out of App.jsx so the
// FLAG — the thing that decides whether the nav shows a red badge — is unit
// tested. A flag that lies in either direction is worse than no flag: a false
// one trains you to ignore it, a missed one is the order that never shipped.

export const MANIFEST_CHECK_KEY = 'dd_manifest_check_last';

/**
 * What is wrong with this run, if anything. Returns a list of issues, most
 * serious first, plus the badge count the nav shows.
 *
 * Deliberately NOT flagged: board orders the manifest never mentions. The board
 * carries every shipper, not just Uline, so that count is normal and flagging it
 * would bury the real finding under hundreds of non-problems.
 */
export function manifestIssues(result) {
  if (!result || result.ok === false) return { issues: [], badge: 0, level: 'none' };
  const issues = [];

  const missing = Array.isArray(result.suspects) ? result.suspects.length : 0;
  if (missing > 0) {
    issues.push({
      kind: 'not_on_board',
      level: 'alert',
      count: missing,
      text: `${missing} order${missing === 1 ? '' : 's'} on the manifest ${missing === 1 ? 'is' : 'are'} not in the scan`,
    });
  }

  // A manifest we could not reconcile against its own FINAL TOTALS means the
  // freight numbers below may be wrong — say so rather than presenting them.
  if (result.manifest && result.manifest.verified === false) {
    issues.push({
      kind: 'unverified_manifest',
      level: 'warn',
      count: 1,
      text: 'the manifest did not reconcile against its own printed totals — treat these numbers as unconfirmed',
    });
  }

  const dupes = Array.isArray(result.duplicatePros) ? result.duplicatePros.length : 0;
  if (dupes > 0) {
    issues.push({
      kind: 'duplicate_pro',
      level: 'warn',
      count: dupes,
      text: `${dupes} PRO${dupes === 1 ? '' : 's'} printed more than once on the manifest`,
    });
  }

  const level = issues.some((i) => i.level === 'alert') ? 'alert'
    : issues.length ? 'warn' : 'ok';
  // The badge counts ORDERS needing attention, not issue kinds — "3" should mean
  // three orders to chase, never "three categories of thing went wrong".
  const badge = missing;
  return { issues, badge, level };
}

/** One line for the tab header and the stored summary. */
export function manifestHeadline(result) {
  if (!result) return 'No manifest checked yet';
  if (result.ok === false) return result.error || 'The last check failed';
  const { level } = manifestIssues(result);
  const n = Array.isArray(result.suspects) ? result.suspects.length : 0;
  if (level === 'alert') return `${n} order${n === 1 ? '' : 's'} on the manifest ${n === 1 ? 'is' : 'are'} NOT in the scan`;
  const orders = result.manifest?.orders ?? 0;
  return `All ${orders} manifest order${orders === 1 ? '' : 's'} found in the scan`;
}

/** Persisted shape — small enough for localStorage even at 660 orders. */
export function toStored(result, fileName) {
  if (!result || result.ok === false) return null;
  return {
    at: new Date().toISOString(),
    fileName: fileName || null,
    checkedAgainst: result.checkedAgainst || [],
    manifest: result.manifest || null,
    onBoard: result.onBoard ?? 0,
    boardOnly: result.boardOnly ?? 0,
    duplicatePros: result.duplicatePros || [],
    // Cap the stored suspect list: the flag only needs the count, and a
    // pathological run (an unscanned day) must not blow the storage quota.
    suspects: (result.suspects || []).slice(0, 200),
    suspectsTotal: (result.suspects || []).length,
  };
}

export function loadStored(storage) {
  try {
    const raw = (storage || window.localStorage).getItem(MANIFEST_CHECK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveStored(value, storage) {
  try {
    const s = storage || window.localStorage;
    if (value) s.setItem(MANIFEST_CHECK_KEY, JSON.stringify(value));
    else s.removeItem(MANIFEST_CHECK_KEY);
    return true;
  } catch { return false; }
}
