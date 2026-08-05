// roster.js — who on the board the app can actually identify, and finding a
// credential among fifty of them.
//
// This restates the resolution rule from aliases.mts on the client, so keep the
// two together. A board name is identified only when EXACTLY ONE **active**
// credential claims it. Three ways that fails, and they need different fixes:
//
//   claimed by nobody          -> create a driver, or attach the name to one
//   claimed only by INACTIVE   -> reactivate, or move the name to a live driver
//   claimed by two or more     -> resolves to NEITHER; take the name off one
//
// The inactive case is the one that hid a real fault: login filters to active
// credentials before resolving, and load-manifest 403s an inactive one, so a
// name held only by a deactivated account gets NOTHING while looking claimed.
// Counting it as identified put a green tick over a driver who would be handed
// an empty truck. Two claimants is the mirror image — easy to mistake for fine.

export function partitionBoardRows(rows) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const list = Array.isArray(rows) ? rows : [];
  const active = (r) => arr(r?.claimedBy).length;
  const inactive = (r) => arr(r?.inactiveClaimedBy).length;

  return {
    identified: list.filter((r) => active(r) === 1),
    ambiguous: list.filter((r) => active(r) > 1),
    // No live claimant. Split by whether a dead one explains it, because the
    // remedy differs and "create a driver" is wrong for the inactive case.
    inactiveOnly: list.filter((r) => active(r) === 0 && inactive(r) > 0),
    unidentified: list.filter((r) => active(r) === 0 && inactive(r) === 0),
  };
}

/**
 * Board names still going spare — the ones to offer when setting a driver up.
 *
 * A person usually appears under SEVERAL spellings ("BRENT BOYD" and "BRENT"),
 * and a credential only works for the spellings it holds. The dispatcher cannot
 * know the full set from memory, so the editor offers what is actually on the
 * board rather than asking them to type it.
 *
 * "Spare" means no ACTIVE credential claims it — same rule as identification,
 * because an inactive claimant resolves to nothing and must not reserve a name.
 * Those are still offered, flagged, since a name stuck on a deactivated account
 * is exactly the one a dispatcher needs to move.
 *
 * Sorted by stop count: the spelling carrying the most freight matters most.
 */
export function availableAliases(rows, alreadyHave = []) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const up = (s) => String(s ?? '').trim().toUpperCase();
  const mine = new Set(arr(alreadyHave).map(up));

  return arr(rows)
    .filter((r) => arr(r?.claimedBy).length === 0)
    .filter((r) => up(r?.alias) && !mine.has(up(r?.alias)))
    .map((r) => ({
      alias: r.alias,
      stops: Number(r?.stops || 0),
      heldByInactive: arr(r?.inactiveClaimedBy),
    }))
    .sort((a, b) => b.stops - a.stops || a.alias.localeCompare(b.alias));
}

/** Everything that still needs a human, newest problem first. */
export function boardNeedsAttention(rows) {
  const p = partitionBoardRows(rows);
  return p.ambiguous.length + p.inactiveOnly.length + p.unidentified.length;
}

/**
 * Find a credential among ~50 by number, name, or any of its aliases.
 *
 * Matching the ALIASES matters as much as the name: the dispatcher usually
 * arrives here holding a spelling off the board, not the person's display name.
 */
export function filterCredentials(creds, query) {
  const q = String(query ?? '').trim().toUpperCase();
  const list = Array.isArray(creds) ? creds : [];
  if (!q) return list;
  return list.filter((c) => {
    const hay = [
      String(c?.driverNumber ?? ''),
      String(c?.displayName ?? ''),
      ...(Array.isArray(c?.nuvizzAliases) ? c.nuvizzAliases : []),
    ]
      .join(' ')
      .toUpperCase();
    return hay.includes(q);
  });
}
