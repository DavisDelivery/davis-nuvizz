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
